import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { EmbeddedStatus } from '../packages/engineering-runner/embedded/types';
import { redact } from '../packages/engineering-runner/redaction';
import { deriveEmbeddedInstalledScope, assertNoEmbeddedReplay, fileSha256, inside, plainPath, samePath } from './helpers/embedded-installed';
import { assertEmbeddedExportResume } from './helpers/embedded-resume';
import { verifyEmbeddedExport } from './helpers/embedded-export';
import { primarySid, readDesktopIdentity } from './helpers/snapshot-smoke-scope';
import { assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, nativeMainProcessQuery, type ElectronMainIdentity, type InstalledMainProcess } from './helpers/second-user-controls';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';

assert.equal(process.platform, 'win32');
assert.equal(process.argv.length, 6, 'Use --resume-export-only <absolute-original-plan> <absolute-failed-evidence> <reviewed-failed-file-sha256>');
assert.equal(process.argv[2], '--resume-export-only');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [planFile, failedFile, reviewedHash] = process.argv.slice(3); assert.match(reviewedHash, /^[a-f0-9]{64}$/i);
assert.ok(path.isAbsolute(planFile) && inside(path.join(root, 'output/hardware'), planFile)); await plainPath(planFile);
const scope = deriveEmbeddedInstalledScope(root, JSON.parse(await readFile(planFile, 'utf8')), process.env);
assert.ok(path.isAbsolute(failedFile)); assert.equal(samePath(failedFile, path.join(scope.output, 'evidence.json')), true, 'Only the original run evidence can be continued'); await plainPath(failedFile);
const failedStat = await lstat(failedFile); assert.ok(failedStat.isFile() && failedStat.nlink === 1, 'Original public evidence must be a regular unlinked file');
const rawFailure = await readFile(failedFile); const failedHash = createHash('sha256').update(rawFailure).digest('hex'); assert.equal(failedHash, reviewedHash.toLowerCase());
const original = JSON.parse(rawFailure.toString('utf8')); const planHash = await fileSha256(planFile);
const candidate = assertEmbeddedExportResume(original, scope, planHash);
// Only public export files and this run's own embedded artifacts are inspected; no authentication/engine files.
const previousExports = (await readdir(scope.output, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith(`ForgeDesk-T2-${original.taskId}-`));
assert.equal(previousExports.length, 1, 'The original UI export must already exist, proving this is the diagnosed lookup failure');
const originalExport = await verifyEmbeddedExport(path.join(scope.output, previousExports[0].name), candidate.state);
for (const [relative, expected] of Object.entries(scope.plan.resourceHashes)) { const filename = path.join(path.dirname(scope.plan.installedExe), relative); await plainPath(filename); assert.equal(await fileSha256(filename), expected.toLowerCase()); }
assert.equal(await fileSha256(scope.plan.installedExe), scope.plan.executableSha256); assert.equal(await fileSha256(scope.plan.installerPath), scope.plan.installerSha256);
assert.equal(await fileSha256(path.join(root, 'packages/engineering-runner/device/real-stm32.ts')), original.receiptParserSha256, 'Do not silently change the receipt parser used by the proven hardware phase');
for (const [filename, expected] of [[candidate.artifact.hexPath, candidate.artifact.hexSha256], [candidate.artifact.axfPath, candidate.artifact.axfSha256], [candidate.artifact.logPath, candidate.artifact.logSha256]]) {
  assert.ok(inside(scope.dataDir, filename)); await plainPath(filename); assert.equal(await fileSha256(filename), expected);
}
const identity = await readDesktopIdentity(); assert.equal(identity.sid, primarySid); assert.equal(identity.sid, original.desktop.sid); assert.equal(identity.elevated, false);
assert.equal(identity.interactive, true); assert.ok(identity.explorerOwners.some(item => item.sid === identity.sid && item.sessionId === identity.sessionId));
assert.equal(identity.applications.filter(item => samePath(item.executable, scope.plan.installedExe)).length, 0, 'Original application must be normally closed before continuation');
const runId = `t2-${Date.now()}-resume`; const output = path.join(root, 'output/t2', runId); await plainPath(output);
try { await lstat(output); assert.fail('A continuation output directory must never be reused'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true }); const failedCopy = path.join(output, 'failed-attempt.json'); await writeFile(failedCopy, rawFailure, { flag: 'wx' }); assert.equal(await fileSha256(failedCopy), failedHash);
const report: Record<string, any> = { ...original, runId, originalRunId: original.runId, startedAt: new Date().toISOString(), result: 'running', completedAt: undefined,
  priorFailures: structuredClone(original.failures), failures: [], pageErrors: [], launches: [], closes: [], steps: [], controls: { ...original.controls },
  continuation: { scope: 'Export/restart/dedup/tamper-preflight/leave/normal-close only; no build, inspect or new flash request', originalPlanPath: planFile, originalPlanSha256: planHash,
    originalRuntime: scope.runtime, originalEvidencePath: failedFile, failedAttemptCopy: failedCopy, failedAttemptSha256: failedHash, originalScriptSha256: original.testScriptSha256, originalHelperSha256: original.helperSha256, originalExport },
  controlProvenance: Object.fromEntries(Object.entries(original.controls).filter(([, value]) => value === 'passed').map(([key]) => [key, { runId: original.runId, evidenceSha256: failedHash }])) };
delete report.failureHardware; delete report.latestObservation;
report.testScriptSha256 = await fileSha256(fileURLToPath(import.meta.url)); report.helperSha256 = await fileSha256(path.join(root, 'tests/helpers/embedded-resume.ts')); report.exportHelperSha256 = await fileSha256(path.join(root, 'tests/helpers/embedded-export.ts'));
const execute = promisify(execFile); const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let app: ElectronApplication | undefined; let page: Page | undefined; let launcher: ChildProcess | undefined; let main: ElectronMainIdentity | undefined; let native: InstalledMainProcess | undefined; let exitListeners: readonly Function[] = [];
function sanitize(value: unknown): unknown { if (typeof value === 'string') return redact(value); if (Array.isArray(value)) return value.map(sanitize); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /password|credential|access.?token|refresh.?token|api.?key|binding.?key/i.test(key) ? '[REDACTED]' : sanitize(item)])); return value; }
async function evidence() { await writeFile(path.join(output, 'evidence.json'), JSON.stringify(sanitize(report), null, 2)); }
async function hardware(): Promise<EmbeddedStatus> { return page!.evaluate(id => window.forgeDesk.hardwareSnapshot(id), original.taskId); }
async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
async function nativeProcess(pid: number): Promise<InstalledMainProcess | null> { const { stdout } = await execute('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { windowsHide: true, shell: false, timeout: 15000 }); return JSON.parse(stdout.trim()); }
async function noApplication() { const state = await readDesktopIdentity(); assert.equal(state.applications.filter(item => samePath(item.executable, scope.plan.installedExe)).length, 0); }
async function idleUI() { await page!.locator('.embedded-scroll[aria-busy="false"][data-pending-intent=""]').waitFor({ state: 'visible', timeout: 30000 }); }
async function capture(name: string) { await page!.evaluate(() => { const label = document.querySelector('.sidebar-footer strong'); if (label) label.textContent = 'T2 continuation: no-auth home'; }); await page!.screenshot({ path: path.join(output, `${name}.png`) }); }
async function launch() {
  await noApplication(); const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string')); environment.FORGEDESK_DATA_DIR = scope.dataDir; delete environment.ELECTRON_RUN_AS_NODE;
  const { _electron: electron } = await import('playwright'); exitListeners = capturePlaywrightExitListeners();
  app = await electron.launch({ executablePath: scope.plan.installedExe, args: [], cwd: root, env: environment, timeout: 30000 }); launcher = app.process();
  main = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: process.type, platform: process.platform })); assertElectronMainIdentity(main, scope.plan.installedExe);
  const observed = await nativeProcess(main.pid); assertInstalledMainProcess(observed, main, scope.plan.installedExe, identity.sid, identity.sessionId); native = observed;
  report.launches.push({ launcherPid: launcher.pid, launcherPidScope: 'Playwright shell launcher, not Electron main', electronMain: main, nativeMain: native }); await evidence();
  page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message))); await page.locator('.app-header').waitFor();
  const state = await snapshot(); assert.equal(state.version, scope.plan.version); assert.equal(state.dataDir, scope.dataDir); assert.equal(state.engine.home, path.join(scope.dataDir, 'engine'));
  assert.equal(state.hardware.modeActive, true); assert.equal(state.hardware.enabled, false); assert.equal(state.hardware.userDriven, true); assert.equal(state.engine.state, 'stopped'); assert.equal(state.account.loggedIn, false);
  const session = state.sessions.find(item => item.id === original.sessionId); assert.ok(session); assert.equal(session.taskId, original.taskId);
  const project = state.projects.find(item => item.id === session.projectId); assert.ok(project); assert.equal(samePath(project.root, scope.plan.projectRoot), true);
  await page.getByTitle(project.root, { exact: true }).and(page.getByRole('button')).click();
  const index = state.sessions.filter(item => item.projectId === project.id).findIndex(item => item.id === session.id); assert.ok(index >= 0); await page.locator('.session-button').nth(index).click();
  await page.getByRole('tab', { name: '实机流程', exact: true }).click(); await page.locator(`.embedded-scroll[data-task-id="${original.taskId}"]`).waitFor({ state: 'visible' }); await idleUI(); assertNoEmbeddedReplay(candidate.state, await hardware());
}
async function closeApp() {
  if (!app) return; const current = app; const child = launcher; const before = native; const actual = main; assert.ok(child && before && actual);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assertNoEmbeddedReplay(candidate.state, await hardware());
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const request = observeNormalCloseRequest(current.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); }), 5000); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Continuation native close unconfirmed; no force kill attempted')), 30000); })]);
    const record: Record<string, any> = { electronMain: actual, launcherExitCode: result.code, launcherSignal: result.signal, exitCodeScope: 'playwright-launcher', normalClose: false }; report.closes.push(record); await evidence(); assert.equal(result.code, 0); assert.equal(result.signal, null);
    record.nativeAfter = await nativeProcess(actual.pid); assertElectronMainExited(before, record.nativeAfter); await noApplication(); record.installedGuiAbsent = true; record.absenceScope = 'Installed GUI executable only, not a full-machine host inventory';
    const acknowledged = await request; record.nativeCloseObservation = acknowledged.state; assert.notEqual(acknowledged.state, 'timed-out'); assert.equal((await observeNormalCloseRequest(current.close(), 5000)).state, 'acknowledged');
    record.normalClose = true; app = undefined; page = undefined; launcher = undefined; main = undefined; native = undefined; await evidence();
  } finally { if (timer) clearTimeout(timer); }
}
await evidence();
try {
  await launch(); report.restoredBeforeContinuation = await hardware(); assertNoEmbeddedReplay(candidate.state, report.restoredBeforeContinuation);
  await app!.evaluate(({ dialog }, approvedPath) => { const holder = globalThis as any; if (holder.__t2ResumeChooser) throw new Error('Chooser hook already exists'); holder.__t2ResumeChooser = { original: dialog.showOpenDialog, calls: 0 }; dialog.showOpenDialog = (async () => { if (++holder.__t2ResumeChooser.calls !== 1) throw new Error('Unexpected chooser'); return { canceled: false, filePaths: [approvedPath] }; }) as typeof dialog.showOpenDialog; }, output);
  let destination = '';
  try { await page!.getByRole('button', { name: '导出证据', exact: true }).click(); const notice = page!.getByRole('status').filter({ hasText: '证据已导出：' }); await notice.waitFor({ timeout: 30000 }); await idleUI(); const text = await notice.innerText(); destination = text.slice(text.indexOf('：') + 1).trim(); }
  finally { const calls = await app!.evaluate(({ dialog }) => { const holder = globalThis as any; const saved = holder.__t2ResumeChooser; if (!saved) throw new Error('Chooser state missing'); dialog.showOpenDialog = saved.original; delete holder.__t2ResumeChooser; return saved.calls; }); assert.equal(calls, 1); }
  assert.ok(inside(output, destination)); report.export = await verifyEmbeddedExport(destination, candidate.state); report.controls.export = 'passed'; report.controlProvenance.export = { runId, phase: 'continuation UI export' }; await evidence();
  await closeApp(); await launch(); const restored = await hardware();
  const repeated = await page!.evaluate(({ id, key }) => window.forgeDesk.hardwareFlash(id, key), { id: original.taskId, key: candidate.flash.requestKey }); assertNoEmbeddedReplay(restored, repeated);
  report.restart = { restored, repeated, scope: 'Existing completed flash key only; no new flash request or human authorization' }; report.controls.restartDedup = 'passed'; report.controlProvenance.restartDedup = { runId, phase: 'continuation restart and terminal-key dedup' }; await evidence();
  if (scope.plan.artifactTamperPreflight) {
    const originalHex = await readFile(candidate.artifact.hexPath); await writeFile(candidate.artifact.hexPath, Buffer.concat([originalHex, Buffer.from('\n; continuation preflight mutation\n')])); let rejection = '';
    try { await page!.evaluate(({ id, key }) => window.forgeDesk.hardwareVerify(id, key), { id: original.taskId, key: `${runId}-tamper-verify` }); } catch (error) { rejection = String(error); } finally { await writeFile(candidate.artifact.hexPath, originalHex); }
    report.tamper = { rejection: redact(rejection), restoredSha256: await fileSha256(candidate.artifact.hexPath), scope: 'Owned HEX mutation, verify preflight only; no device request allowed' }; await evidence();
    assert.match(rejection, /artifact.*(?:hash|SHA)|hash mismatch|产物/i); assert.equal(report.tamper.restoredSha256, candidate.artifact.hexSha256); assertNoEmbeddedReplay(candidate.state, await hardware()); report.controls.tamper = 'passed'; report.controlProvenance.tamper = { runId, phase: 'continuation non-device preflight' };
  }
  for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) { await page!.setViewportSize(size); await pause(150); assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await capture(`resumed-delivery-${size.width}x${size.height}`); }
  await page!.getByRole('button', { name: '返回软件模式', exact: true }).click(); const deadline = Date.now() + 60000;
  while ((await snapshot()).hardware.modeActive) { if (Date.now() > deadline) throw new Error('Leave-mode did not finish'); await pause(250); }
  await idleUI(); assert.equal((await hardware()).grant, undefined); report.leftMode = true; assert.equal(report.pageErrors.length, 0); await closeApp();
  assert.equal(await fileSha256(failedFile), failedHash, 'Original failed evidence must remain unchanged'); assert.equal(await fileSha256(failedCopy), failedHash);
  assert.equal(await fileSha256(planFile), planHash, 'Original reviewed plan must remain unchanged');
  report.result = 'passed'; report.completedAt = new Date().toISOString(); report.steps.push('Merged acceptance preserves the original export-assertion failure verbatim and uses its proven hardware controls plus this non-programming continuation.'); await evidence();
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(String(error))); try { if (page) await capture('continuation-failure'); } catch { /* Original failure retained. */ } await evidence();
  try { await closeApp(); } catch (failure) { report.needsHumanClose = true; report.cleanupError = redact(String(failure)); await evidence(); }
  if (app && launcher && launcher.exitCode === null) { try { report.playwrightNoKill = detachNewPlaywrightExitHandler(exitListeners); await evidence(); process.exit(1); } catch (failure) { report.detachError = redact(String(failure)); await evidence(); console.error('Close/recover the application manually; no force kill will be issued.'); await new Promise(resolve => launcher!.once('close', resolve)); } }
  process.exitCode = 1;
}
