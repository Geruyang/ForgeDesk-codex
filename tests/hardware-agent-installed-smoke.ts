import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { HardwareAgentRunView } from '../packages/shared/hardware-agent';
import type { EmbeddedStatus } from '../packages/engineering-runner/embedded/types';
import { parseFixedWorkerReceipt } from '../packages/engineering-runner/device/real-stm32';
import { redact } from '../packages/engineering-runner/redaction';
import { readDesktopIdentity, primarySid } from './helpers/snapshot-smoke-scope';
import { assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, connectControlsStartup, nativeMainProcessQuery,
  type ElectronMainIdentity, type InstalledMainProcess } from './helpers/second-user-controls';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { fileSha256, inside, plainPath, samePath } from './helpers/embedded-installed';
import { verifyEmbeddedExport } from './helpers/embedded-export';
import { assertHardwareAgentCompletion, assertHardwareAgentNoReplay, assertHardwareAgentPolicy, deriveHardwareAgentInstalledScope,
  hardwareAgentExportDestination, HARDWARE_AGENT_INSTRUCTION, sanitizeHardwareAgentEvidence } from './helpers/hardware-agent-installed';

// This entry is authored only. The coordinating operator alone authorizes execution and real native UI actions.
assert.deepEqual(process.argv.slice(2, 3), ['--execute-real-model-hardware']);
assert.equal(process.argv.length, 4, 'Use --execute-real-model-hardware <absolute-reviewed-plan.json>');
assert.equal(process.platform, 'win32');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), planFile = process.argv[3];
assert.ok(path.isAbsolute(planFile) && inside(path.join(root, 'output/hardware/hardware-agent-plans'), planFile));
await plainPath(planFile); assert.equal((await lstat(planFile)).isFile(), true);
const scope = deriveHardwareAgentInstalledScope(root, JSON.parse(await readFile(planFile, 'utf8')), process.env), { plan } = scope;
const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', execute = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let app: ElectronApplication | undefined, page: Page | undefined, launcher: ChildProcess | undefined;
let main: ElectronMainIdentity | undefined, native: InstalledMainProcess | undefined, exitListeners: readonly Function[] = [];
let taskId: string | undefined, sessionId: string | undefined, controllerId: string | undefined;
type Snapshot = AppSnapshot & { hardwareAgent?: NonNullable<AppSnapshot['hardwareAgent']> & { policy?: unknown } };
const delegated = process.env.FORGEDESK_HARDWARE_AGENT_NATIVE_OPERATOR === 'delegated-ui';
const report: Record<string, any> = { schemaVersion: 1, runId: plan.runId, scope: plan.scope, realModel: true, secondUser: false,
  model: plan.model, runtimeCommit: plan.runtimeCommit, startedAt: new Date().toISOString(), dataDir: scope.dataDir, projectRoot: plan.projectRoot,
  controls: Object.fromEntries(['publicLogin', 'policy', 'modelCalls', 'build', 'inspect', 'nativeAuthorization', 'flash', 'verify', 'export', 'restartNoReplay', 'normalClose'].map(name => [name, 'pending'])),
  nativeConfirmation: { automatedResponse: delegated, synthesizedDialogResponse: false,
    mechanism: delegated ? 'Original native confirmation operated visibly by coordinator under explicit user delegation' : 'Original native confirmation requires the human operator' },
  limitation: 'Fixed trusted target with restricted model tool orchestration; not malicious same-SID isolation or physical fault injection',
  policyProvenance: 'Public verified effective adapter policy; provider inventory isolation is additionally covered by separately labelled offline loopback tests, not a live traffic capture',
  launches: [], closes: [], failures: [], pageErrors: [], startupObservations: [], observations: [], uiSubmitCount: 0 };

async function evidence() { await writeFile(path.join(scope.output, 'evidence.json'), JSON.stringify(sanitizeHardwareAgentEvidence(report), null, 2)); }
async function snapshot(): Promise<Snapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
async function hardware(): Promise<EmbeddedStatus> { assert.ok(taskId); return page!.evaluate(id => window.forgeDesk.hardwareSnapshot(id), taskId); }
async function processIdentity(pid: number): Promise<InstalledMainProcess | null> {
  const { stdout } = await execute(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { windowsHide: true, shell: false, timeout: 15000 });
  return JSON.parse(stdout.trim());
}
async function noInstalledApplication() {
  const identity = await readDesktopIdentity();
  assert.equal(identity.sid, primarySid, 'Second-user testing is paused; this entry accepts only the actual primary SID');
  assert.equal(identity.elevated, false); assert.equal(identity.interactive, true);
  assert.ok(identity.explorerOwners.some(owner => owner.sid === identity.sid && owner.sessionId === identity.sessionId));
  assert.equal(identity.applications.filter(item => samePath(item.executable, plan.installedExe)).length, 0, 'Close the installed application normally before this entry');
  return identity;
}
async function capture(label: string) {
  await page!.evaluate(() => { const node = document.querySelector('.sidebar-footer strong'); if (node) node.textContent = 'Official account (redacted)'; });
  for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) {
    await page!.setViewportSize(size); await pause(150);
    assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page!.screenshot({ path: path.join(scope.output, `${label}-${size.width}x${size.height}.png`) });
  }
  await page!.setViewportSize({ width: 1380, height: 900 });
}
function owned(state: Snapshot) { return state.hardwareAgent?.runs.find(run => run.taskId === taskId && (!controllerId || run.runId === controllerId)); }
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeout: number): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await pause(500); }
  throw new Error(`${label} timed out; no model task or hardware action was replayed`);
}
async function launch() {
  await noInstalledApplication(); exitListeners = capturePlaywrightExitListeners();
  const { _electron } = await import('playwright');
  const env = Object.fromEntries(Object.entries({ ...process.env, FORGEDESK_DATA_DIR: scope.dataDir }).filter((item): item is [string, string] => typeof item[1] === 'string'));
  app = await _electron.launch({ executablePath: plan.installedExe, args: [], env, timeout: 60000 }); launcher = app.process();
  main = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: process.type, platform: process.platform }));
  assertElectronMainIdentity(main, plan.installedExe);
  const identity = await readDesktopIdentity(), observed = await processIdentity(main.pid);
  assertInstalledMainProcess(observed, main, plan.installedExe, primarySid, identity.sessionId); native = observed;
  report.launches.push({ launcherPid: launcher.pid, launcherPidScope: 'Playwright shell launcher, not Electron main', electronMain: main, nativeMain: observed });
  page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 30000 });
  const state = await snapshot(); assert.equal(state.version, plan.version); assert.ok(samePath(state.dataDir, scope.dataDir));
  await evidence();
}
async function closeApp() {
  assert.ok(app && launcher && main && native);
  const state = await snapshot();
  assert.equal(state.hardwareAgent?.activeRunId, undefined);
  assert.equal(state.hardwareAgent?.runs.some(run => run.active || run.hardwareBusy), false, 'Never close while a hardware-agent run is active or held');
  if (taskId) assert.equal((await hardware()).operations.some(op => ['prepared', 'running'].includes(op.status) || (op.status === 'unknown' && !op.recoveredAt)), false);
  const current = app, child = launcher, expected = native;
  assert.equal(child.exitCode, null, 'An already exited launcher is not this normal close');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const request = observeNormalCloseRequest(current.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); }), 5000);
  const exit = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native close unconfirmed; no force termination attempted')), 30000); })]).finally(() => { if (timer) clearTimeout(timer); });
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  const after = await processIdentity(expected.id); assertElectronMainExited(expected, after); await noInstalledApplication();
  report.closes.push({ electronMain: main, launcherExitCode: exit.code, launcherSignal: exit.signal, exitCodeScope: 'playwright-launcher',
    nativeAfter: after, installedGuiAbsent: true, normalClose: true, nativeCloseObservation: await request,
    absenceScope: 'Installed ForgeDesk.exe GUI processes only; not a full-machine process inventory' });
  await current.close(); app = undefined; page = undefined; launcher = undefined; main = undefined; native = undefined; await evidence();
}

for (const file of [scope.output, scope.dataDir, plan.projectRoot, plan.installedExe, plan.installerPath]) await plainPath(file);
const identity = await noInstalledApplication();
await mkdir(path.dirname(scope.output), { recursive: true });
await mkdir(scope.output);
assert.equal((await lstat(scope.output)).isDirectory(), true);
assert.equal(await fileSha256(plan.installedExe), plan.executableSha256); assert.equal(await fileSha256(plan.installerPath), plan.installerSha256);
for (const [relative, hash] of Object.entries(plan.resourceHashes)) { const file = path.join(path.dirname(plan.installedExe), relative); await plainPath(file); assert.equal(await fileSha256(file), hash, relative); }
report.desktop = { sid: identity.sid, sessionId: identity.sessionId, elevated: identity.elevated,
  explorerMatched: identity.explorerOwners.some(owner => owner.sid === identity.sid && owner.sessionId === identity.sessionId) };
report.release = { version: plan.version, executableSha256: plan.executableSha256, installerSha256: plan.installerSha256, resourceHashes: plan.resourceHashes, suppliedRuntimeCommit: plan.runtimeCommit };
report.planSha256 = await fileSha256(planFile); report.testScriptSha256 = await fileSha256(fileURLToPath(import.meta.url));
report.helperSha256 = await fileSha256(path.join(root, 'tests/helpers/hardware-agent-installed.ts'));
report.receiptParserSha256 = await fileSha256(path.join(root, 'packages/engineering-runner/device/real-stm32.ts')); await evidence();

try {
  await launch();
  const beforeStartup = await snapshot();
  report.initialGate = { hardwareMode: beforeStartup.hardware.modeActive, activeRunId: beforeStartup.hardwareAgent?.activeRunId,
    heldRuns: beforeStartup.hardwareAgent?.runs.filter(run => run.active || run.hardwareBusy).length ?? 0 };
  await evidence();
  assert.equal(beforeStartup.hardware.modeActive, false, 'Leave prior hardware mode normally before starting a new model acceptance run');
  assert.equal(beforeStartup.hardwareAgent?.activeRunId, undefined);
  assert.equal(report.initialGate.heldRuns, 0);
  await waitFor(snapshot, state => state.engine.state === 'ready', 'initial ordinary engine ready', 60000);
  const initial = await connectControlsStartup({ snapshot, connect: () => page!.evaluate(() => window.forgeDesk.connect()), wait: pause,
    observe: async value => { report.startupObservations.push(value); await evidence(); } });
  assert.equal(initial.account.loggedIn, true, 'Official login is required; this entry never logs in or reads credentials');
  assert.equal(initial.hardwareAgent?.activeRunId, undefined); assert.equal(initial.hardwareAgent?.runs.some(run => run.active || run.hardwareBusy), false);
  report.publicAccount = { loggedIn: true }; report.controls.publicLogin = 'passed'; await evidence();
  await app!.evaluate(({ dialog }, filename) => { const target = globalThis as typeof globalThis & { __hardwareAgentChooser?: typeof dialog.showOpenDialog }; target.__hardwareAgentChooser = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, plan.projectRoot);
  let project;
  try { project = await page!.evaluate(() => window.forgeDesk.importProject()); }
  finally { await app!.evaluate(({ dialog }) => { const target = globalThis as typeof globalThis & { __hardwareAgentChooser?: typeof dialog.showOpenDialog }; if (target.__hardwareAgentChooser) { dialog.showOpenDialog = target.__hardwareAgentChooser; delete target.__hardwareAgentChooser; } }); }
  assert.ok(project && samePath(project.root, plan.projectRoot));
  const title = `Hardware agent ${plan.runId}`;
  const session = await page!.evaluate(({ id, title }) => window.forgeDesk.createSession(id, title), { id: project.id, title });
  taskId = session.taskId; sessionId = session.id; report.taskId = taskId; report.sessionId = sessionId;
  assert.equal(session.threadId, undefined); assert.equal(session.messages.length, 0); assert.equal((await hardware()).operations.length, 0);
  await page!.getByRole('button').and(page!.getByTitle(plan.projectRoot, { exact: true })).click();
  await page!.locator('.session-button').filter({ has: page!.getByText(title, { exact: true }) }).click();
  await page!.getByRole('tab', { name: '实机流程', exact: true }).click();
  // Host profile preparation does not execute a build or device worker.
  await page!.getByRole('button', { name: '配置工程', exact: true }).click();
  const prepared = await waitFor(hardware, state => state.configured, 'trusted host profile preparation', 120000);
  const preparedApp = await snapshot();
  assert.equal(prepared.operations.length, 0); assert.equal(preparedApp.engine.state, 'stopped'); assert.equal(preparedApp.hardware.modeActive, true);
  report.hostPreparation = { scope: 'Operator fixed-profile preparation only; no build or device command', taskId, profileId: prepared.profileId,
    profileSha256: prepared.profileSha256, operationCount: prepared.operations.length, ordinaryEngineState: preparedApp.engine.state };
  await evidence();
  const section = page!.getByRole('region', { name: '模型实机任务', exact: true });
  await page!.locator(`.embedded-scroll[data-task-id="${taskId}"][data-pending-intent=""][aria-busy="false"]`).waitFor({ state: 'visible', timeout: 30000 });
  await section.getByLabel('模型实机任务指令', { exact: true }).fill(HARDWARE_AGENT_INSTRUCTION);
  assert.equal(await section.getByLabel('实机任务模型', { exact: true }).inputValue(), plan.model);
  await capture('before-model-start');
  await section.getByRole('button', { name: '启动模型实机任务', exact: true }).click(); report.uiSubmitCount++; await evidence();
  const submittedAt = Date.now();
  let lastObservation = 0;
  const completed = await waitFor(async () => {
    const state = await snapshot(), run = owned(state);
    if (!run && state.sessions.find(item => item.id === sessionId)?.status === 'needs_attention') throw new Error(`Restricted startup failed before model dispatch: ${state.diagnostics.slice(-3).join(' | ')}`);
    if (!run && Date.now() - submittedAt > 180000) throw new Error('Restricted startup did not establish a run within 180 seconds');
    if (state.hardwareAgent?.policy && !report.policy) { report.policy = assertHardwareAgentPolicy(state.hardwareAgent.policy, plan.resourceHashes['resources/codex/codex.exe']); report.controls.policy = 'passed'; }
    if (run) {
      controllerId ??= run.runId; report.run = run;
      if (['needs_attention', 'stopped'].includes(run.status)) { await evidence(); throw new Error(`Model workflow did not complete: ${run.status}; ${run.failure ?? ''}`); }
      if (Date.now() - lastObservation >= 1000) { report.observations.push({ at: new Date().toISOString(), runId: run.runId, phase: run.phase, nativeApproval: run.nativeApproval, hardwareBusy: run.hardwareBusy, calls: run.calls.map(call => ({ callId: call.callId, tool: call.tool, status: call.status, operationId: call.operationId })) }); lastObservation = Date.now(); await evidence(); }
    }
    return state;
  }, state => { const run = owned(state), session = state.sessions.find(item => item.id === sessionId); return run?.status === 'completed' && !state.hardwareAgent?.activeRunId && state.hardwareAgent?.engineState === 'stopped' && session?.status === 'completed' && !session.turnId; }, 'real model hardware workflow and terminal turn', 900000);
  assert.equal(report.uiSubmitCount, 1); assert.ok(report.policy, 'The live verified policy must have been observed before the restricted engine stopped');
  const run = owned(completed)!; const hw = await hardware(); const checked = assertHardwareAgentCompletion(run, hw, plan.expectedProfile);
  report.run = run; report.hardware = hw; report.model = run.model;
  report.callAssociations = run.calls.map(call => ({ runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, generation: run.generation,
    threadId: run.threadId, turnId: run.turnId, callId: call.callId, tool: call.tool, requestKey: call.requestKey, operationId: call.operationId, receivedAt: call.receivedAt, completedAt: call.completedAt }));
  for (const name of ['modelCalls', 'build', 'inspect', 'nativeAuthorization', 'flash']) report.controls[name] = 'passed';
  const flash = parseFixedWorkerReceipt(`${checked.flash.receipt}\n`, 'flash', checked.flash.id, checked.artifact.buildId);
  const verify = parseFixedWorkerReceipt(`${checked.verify.receipt}\n`, 'verify', checked.verify.id, checked.artifact.buildId);
  assert.equal(flash.artifactSha256, checked.artifact.hexSha256); assert.equal(flash.readbackMismatchBytes, 0);
  assert.equal(verify.verify?.expectedBuildId, checked.artifact.buildId); assert.equal(verify.verify.expectedUid96, plan.expectedProfile.uid);
  for (const challenge of verify.verify.challenges) assert.ok(Date.parse(challenge.receivedAtUtc) >= Date.parse(checked.verify.createdAt) && Date.parse(challenge.receivedAtUtc) <= Date.parse(checked.verify.updatedAt));
  report.protocolBoundary = 'Actual model dynamic calls are linked to authoritative operations; raw FDR1 frames are independently re-parsed by the source-hashed pure parser. No physical fault injection.';
  report.controls.verify = 'passed';
  const exportDestination = hardwareAgentExportDestination(scope.dataDir, run);
  report.export = await verifyEmbeddedExport(exportDestination, hw);
  assert.ok(samePath(report.export.path, run.export!.path)); assert.equal(report.export.sha256, run.export!.sha256); report.controls.export = 'passed';
  await capture('model-completed'); await evidence(); await closeApp();
  await launch(); const after = await snapshot(); const restored = after.hardwareAgent?.runs.find(item => item.runId === run.runId); assert.ok(restored);
  const restoredHardware = await hardware(); assertHardwareAgentNoReplay(run, restored, hw, restoredHardware);
  assert.equal(after.hardwareAgent?.activeRunId, undefined); assert.equal(after.hardwareAgent?.engineState, 'stopped');
  report.restart = { before: run, after: restored, hardwareBefore: hw, hardwareAfter: restoredHardware }; report.controls.restartNoReplay = 'passed';
  await capture('restored-model-history'); await closeApp(); report.controls.normalClose = 'passed';
  assert.equal(report.pageErrors.length, 0); report.result = 'passed'; report.completedAt = new Date().toISOString(); await evidence();
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(String(error)));
  try { if (page) { const state = await snapshot(); report.failureRun = owned(state); report.failureHardwareAgent = { activeRunId: state.hardwareAgent?.activeRunId, engineState: state.hardwareAgent?.engineState }; if (taskId) report.failureHardware = await hardware(); } } catch (observationError) { report.observationError = redact(String(observationError)); }
  try { if (app) await closeApp(); } catch (closeError) { report.needsHumanClose = true; report.cleanupError = redact(String(closeError)); }
  try { await evidence(); } catch (writeError) { console.error(`Could not persist failure evidence: ${redact(String(writeError))}`); }
  if (app && launcher && launcher.exitCode === null) {
    try { report.playwrightNoKill = detachNewPlaywrightExitHandler(exitListeners); report.needsHumanClose = true; try { await evidence(); } catch {} process.exit(1); }
    catch (detachError) {
      report.noKillDetachError = redact(String(detachError)); report.needsHumanClose = true; try { await evidence(); } catch {}
      console.error('Keep the product window intact; coordinating operator must close it safely.');
      await new Promise<void>(resolve => launcher!.once('close', () => resolve()));
    }
  }
  process.exitCode = 1;
}
