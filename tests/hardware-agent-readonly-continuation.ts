import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import { redact } from '../packages/engineering-runner/redaction';
import { readDesktopIdentity, primarySid } from './helpers/snapshot-smoke-scope';
import { assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, nativeMainProcessQuery,
  type ElectronMainIdentity, type InstalledMainProcess } from './helpers/second-user-controls';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { fileSha256, plainPath, samePath } from './helpers/embedded-installed';
import { deriveHardwareAgentInstalledScope, sanitizeHardwareAgentEvidence } from './helpers/hardware-agent-installed';
import { assertReadonlyFailureBoundary, assertReadonlyObservation, verifyReadonlySourceArtifacts,
  MODEL_CONTROL_NAMES, READONLY_SOURCE_RUN, READONLY_SOURCE_SHA256 } from './helpers/hardware-agent-readonly';

// No model or device action API is reachable from this entry. Only the coordinator may execute it.
assert.deepEqual(process.argv.slice(2, 3), ['--verify-completed-run-read-only']);
assert.equal(process.argv.length, 4); assert.equal(process.platform, 'win32');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planFile = process.argv[3];
assert.ok(path.isAbsolute(planFile) && samePath(planFile, path.join(root, 'output/hardware/hardware-agent-plans', `${READONLY_SOURCE_RUN}.json`)));
await plainPath(planFile);
const planText = await readFile(planFile), scope = deriveHardwareAgentInstalledScope(root, JSON.parse(planText.toString('utf8')), process.env), { plan } = scope;
const sourceFile = path.join(scope.output, 'evidence.json'); await plainPath(sourceFile);
const sourceStat = await lstat(sourceFile); assert.ok(sourceStat.isFile() && sourceStat.nlink === 1 && sourceStat.size < 16 * 1024 * 1024);
const sourceBytes = await readFile(sourceFile); assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), READONLY_SOURCE_SHA256);
const parsedSource: unknown = JSON.parse(sourceBytes.toString('utf8')); assertReadonlyFailureBoundary(parsedSource, plan);
const source = parsedSource;
assert.equal(createHash('sha256').update(planText).digest('hex'), source.planSha256);
const execute = promisify(execFile), windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
let app: ElectronApplication | undefined, page: Page | undefined, launcher: ChildProcess | undefined;
let main: ElectronMainIdentity | undefined, native: InstalledMainProcess | undefined, exitListeners: readonly Function[] = [];
const continuationId = `readonly-continuation-${Date.now()}`, output = path.join(scope.output, continuationId);
const report: Record<string, any> = {
  schemaVersion: 1, runId: source.runId, continuationId, scope: source.scope, realModel: true, secondUser: false,
  executionMode: 'read-only-continuation', model: source.model, runtimeCommit: source.runtimeCommit, startedAt: new Date().toISOString(),
  sourceExecutionEvidence: { path: path.relative(root, sourceFile).replaceAll('\\', '/'), sha256: READONLY_SOURCE_SHA256, result: 'failed', originalFailures: source.failures },
  priorFailures: source.failures, originalControls: source.controls,
  controls: Object.fromEntries(MODEL_CONTROL_NAMES.map(name => [name, 'pending'])),
  readOnlyCheck: { modelTurnsSubmitted: 0, hardwareActionsSubmitted: 0, connectedExplicitly: false, roundTrips: [] },
  limitation: 'Original model/device execution is revalidated, not repeated. This continuation only observes installed GUI persistence and normal close. An expired native grant cannot authorize another action.',
  nativeConfirmationSource: 'Original execution only; this continuation does not request or decide a native authorization dialog',
  launches: [], closes: [], failures: [], pageErrors: [],
};
async function evidence() {
  assert.equal(await fileSha256(sourceFile), READONLY_SOURCE_SHA256, 'The original failed evidence must remain byte-identical');
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(sanitizeHardwareAgentEvidence(report), null, 2));
}
async function noInstalledApplication() {
  const identity = await readDesktopIdentity();
  assert.equal(identity.sid, primarySid); assert.equal(identity.elevated, false); assert.equal(identity.interactive, true);
  assert.ok(identity.explorerOwners.some(owner => owner.sid === identity.sid && owner.sessionId === identity.sessionId));
  assert.equal(identity.applications.filter(item => samePath(item.executable, plan.installedExe)).length, 0, 'Close the installed GUI normally before read-only continuation');
  return identity;
}
async function nativeProcess(pid: number): Promise<InstalledMainProcess | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now(), startedAt = new Date(started).toISOString();
    let result: InstalledMainProcess | null;
    try {
      const { stdout } = await execute(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { windowsHide: true, shell: false, timeout: 45000 });
      result = JSON.parse(stdout.trim());
    } catch (error) {
      const failure = error as Error & { code?: string | number | null; killed?: boolean; signal?: string };
      const timedOut = failure.code === 'ETIMEDOUT' || (failure.killed === true && failure.code === null && failure.signal === 'SIGTERM');
      (report.nativeProcessQueries ??= []).push({ pid, attempt, startedAt, elapsedMs: Date.now() - started, outcome: 'failed', timedOut,
        code: failure.code ?? null, error: redact(String(error)).slice(0, 4000) });
      await evidence(); if (!timedOut || attempt === 2) throw error; continue;
    }
    (report.nativeProcessQueries ??= []).push({ pid, attempt, startedAt, elapsedMs: Date.now() - started, outcome: 'read' });
    await evidence(); return result;
  }
  throw new Error('Native process read exhausted without an outcome');
}
async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
async function hardware() { return page!.evaluate(taskId => window.forgeDesk.hardwareSnapshot(taskId), source.run.taskId); }
async function capture(round: number) {
  const account = page!.locator('.sidebar-footer strong');
  for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) {
    await page!.setViewportSize(size);
    assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page!.screenshot({ path: path.join(output, `readonly-${round}-${size.width}x${size.height}.png`), mask: [account] });
  }
}
async function launch() {
  await noInstalledApplication(); exitListeners = capturePlaywrightExitListeners();
  const { _electron } = await import('playwright');
  const env = Object.fromEntries(Object.entries({ ...process.env, FORGEDESK_DATA_DIR: scope.dataDir }).filter((item): item is [string, string] => typeof item[1] === 'string'));
  app = await _electron.launch({ executablePath: plan.installedExe, args: [], env, timeout: 60000 }); launcher = app.process();
  main = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: process.type, platform: process.platform }));
  assertElectronMainIdentity(main, plan.installedExe);
  const identity = await readDesktopIdentity(); native = await nativeProcess(main.pid) ?? undefined;
  assertInstalledMainProcess(native ?? null, main, plan.installedExe, primarySid, identity.sessionId);
  report.launches.push({ launcherPid: launcher.pid, launcherPidScope: 'Playwright shell launcher, not Electron main', electronMain: main, nativeMain: native });
  page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button').and(page.getByTitle(plan.projectRoot, { exact: true })).click();
  await page.locator('.session-button').filter({ has: page.getByText(`Hardware agent ${source.runId}`, { exact: true }) }).click();
  await page.getByRole('tab', { name: '实机流程', exact: true }).click();
  await page.locator(`.embedded-scroll[data-task-id="${source.run.taskId}"]`).waitFor({ state: 'visible', timeout: 30000 });
  await evidence();
}
async function closeApp() {
  assert.ok(app && launcher && main && native);
  const state = await snapshot(), hw = await hardware();
  assert.equal(state.hardwareAgent?.activeRunId, undefined); assert.equal(state.hardwareAgent?.engineState, 'stopped');
  assert.equal(state.engine.state, 'stopped'); assert.equal(state.hardwareAgent?.runs.some(run => run.active || run.hardwareBusy || run.nativeApproval === 'pending'), false);
  assert.equal(state.sessions.some(session => session.turnId || session.engineUncertain || ['running', 'stopping'].includes(session.status)), false);
  assert.equal(state.tasks.some(task => task.status === 'running' || task.operations.some(operation => ['prepared', 'running', 'stopping'].includes(operation.status))), false);
  assert.equal(hw.operations.some(operation => ['prepared', 'running'].includes(operation.status) || (operation.status === 'unknown' && !operation.recoveredAt)), false);
  const current = app, child = launcher, expected = native;
  assert.equal(child.exitCode, null);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeRequest = observeNormalCloseRequest(current.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); }), 5000);
  const exit = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native close was not confirmed; no forced termination attempted')), 30000); })]).finally(() => { if (timer) clearTimeout(timer); });
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  const after = await nativeProcess(expected.id); assertElectronMainExited(expected, after); await noInstalledApplication();
  report.closes.push({ electronMain: main, launcherExitCode: exit.code, launcherSignal: exit.signal, exitCodeScope: 'playwright-launcher', nativeAfter: after,
    installedGuiAbsent: true, normalClose: true, nativeCloseObservation: await closeRequest, absenceScope: 'Installed ForgeDesk.exe GUI processes only; no claim of a full-machine process inventory' });
  await observeNormalCloseRequest(current.close(), 5000);
  app = undefined; page = undefined; launcher = undefined; main = undefined; native = undefined; await evidence();
}

await noInstalledApplication();
const proof = await verifyReadonlySourceArtifacts(root, plan, source);
await plainPath(output); await mkdir(output);
for (const key of ['publicAccount', 'desktop', 'release', 'policy', 'nativeConfirmation', 'run', 'hardware', 'callAssociations', 'model', 'taskId', 'sessionId', 'dataDir', 'projectRoot', 'hostPreparation', 'policyProvenance', 'protocolBoundary'] as const) report[key] = source[key];
report.sourceProof = proof; report.export = proof.export;
for (const name of MODEL_CONTROL_NAMES.slice(0, 9)) report.controls[name] = 'passed';
report.planSha256 = source.planSha256; report.testScriptSha256 = await fileSha256(fileURLToPath(import.meta.url));
report.helperSha256 = await fileSha256(path.join(root, 'tests/helpers/hardware-agent-readonly.ts'));
report.receiptParserSha256 = source.receiptParserSha256;
await evidence();
try {
  for (let round = 1; round <= 2; round++) {
    await launch();
    const state = await snapshot(), hw = await hardware(), observedAt = new Date().toISOString();
    assert.ok(samePath(state.dataDir, scope.dataDir));
    const checked = assertReadonlyObservation(source, state, hw, observedAt);
    await capture(round); const launchIndex = report.launches.length - 1;
    await closeApp();
    report.readOnlyCheck.roundTrips.push({ ...checked, launchIndex, closeIndex: report.closes.length - 1, normalClose: true }); await evidence();
  }
  const last = report.readOnlyCheck.roundTrips[1];
  report.restart = { before: source.run, after: last.run, hardwareBefore: source.hardware, hardwareAfter: last.hardware };
  report.controls.restartNoReplay = 'passed'; report.controls.normalClose = 'passed';
  assert.equal(report.pageErrors.length, 0); report.completedAt = new Date().toISOString(); report.result = 'passed'; await evidence();
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(String(error)));
  try { if (page) { report.failureSnapshot = { hardwareAgent: (await snapshot()).hardwareAgent }; report.failureHardware = await hardware(); } } catch (failure) { report.observationError = redact(String(failure)); }
  try { if (app) await closeApp(); } catch (failure) { report.needsHumanClose = true; report.cleanupError = redact(String(failure)); }
  try { await evidence(); } catch (failure) { console.error(redact(String(failure))); }
  if (app && launcher && launcher.exitCode === null) {
    try { report.playwrightNoKill = detachNewPlaywrightExitHandler(exitListeners); report.needsHumanClose = true; await evidence(); process.exit(1); }
    catch (failure) {
      report.noKillDetachError = redact(String(failure)); report.needsHumanClose = true; try { await evidence(); } catch {}
      console.error('Application retained without forced termination; the coordinating operator must close it safely.');
      await new Promise<void>(resolve => launcher!.once('close', () => resolve()));
    }
  }
  process.exitCode = 1;
}
