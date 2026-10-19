import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot, DesktopAPI } from '../packages/shared/contracts';
import type { EmbeddedStatus } from '../packages/engineering-runner/embedded/types';
import { redact } from '../packages/engineering-runner/redaction';
import { parseFixedWorkerReceipt } from '../packages/engineering-runner/device/real-stm32';
import { readDesktopIdentity, primarySid } from './helpers/snapshot-smoke-scope';
import { assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, nativeMainProcessQuery, type ElectronMainIdentity, type InstalledMainProcess } from './helpers/second-user-controls';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { assertEmbeddedCloseWarning, installEmbeddedCloseObserver, readEmbeddedCloseObserver, restoreEmbeddedCloseObserver } from './helpers/embedded-close-observer';
import { verifyEmbeddedExport } from './helpers/embedded-export';
import { assertEmbeddedBuild, assertFlashGrant, assertNoEmbeddedReplay, deriveEmbeddedInstalledScope, fileSha256, inside, plainPath, samePath, successfulOperation } from './helpers/embedded-installed';

// Authoring this entry does not authorize execution. The coordinating operator owns all hardware actions.
assert.deepEqual(process.argv.slice(2, 3), ['--execute-user-driven'], 'Not run automatically: root must supply --execute-user-driven and a reviewed plan file');
assert.equal(process.argv.length, 4, 'Use --execute-user-driven <absolute-reviewed-plan.json>');
assert.equal(process.platform, 'win32', 'Installed T2 requires the real Windows desktop');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planFile = process.argv[3];
assert.ok(path.isAbsolute(planFile) && inside(path.join(root, 'output/hardware'), planFile), 'Reviewed plan must be under this repository output/hardware');
await plainPath(planFile); assert.equal((await lstat(planFile)).isFile(), true);
const scope = deriveEmbeddedInstalledScope(root, JSON.parse(await readFile(planFile, 'utf8')), process.env);
const { plan } = scope;
type T2API = DesktopAPI & {
  hardwareSnapshot(taskId: string): Promise<EmbeddedStatus>;
  hardwareConfigure(taskId: string): Promise<EmbeddedStatus>;
  hardwareBuild(taskId: string, key: string): Promise<EmbeddedStatus>;
  hardwareInspect(taskId: string, key: string): Promise<EmbeddedStatus>;
  hardwareFlash(taskId: string, key: string): Promise<EmbeddedStatus>;
  hardwareVerify(taskId: string, key: string): Promise<EmbeddedStatus>;
  hardwareExport(taskId: string): Promise<string | null>;
  hardwareLeaveMode(): Promise<void>;
};
type T2Snapshot = AppSnapshot & { hardware: AppSnapshot['hardware'] & { userDriven: boolean; modeActive: boolean } };
const execute = promisify(execFile);
const windowsPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let app: ElectronApplication | undefined; let page: Page | undefined; let launcher: ChildProcess | undefined;
let nativeMain: InstalledMainProcess | undefined; let electronMain: ElectronMainIdentity | undefined;
let exitListeners: readonly Function[] = []; let taskId: string | undefined;
let closeObserverInstalled = false;
const delegatedNativeUI = process.env.FORGEDESK_T2_NATIVE_OPERATOR === 'delegated-ui';
const report: Record<string, any> = { schemaVersion: 1, runId: plan.runId, scope: plan.scope, realModel: false, secondUser: false,
  startedAt: new Date().toISOString(), runtimeCommit: plan.runtimeCommit, dataDir: scope.dataDir, projectRoot: plan.projectRoot,
  controls: { build: 'pending', inspect: 'pending', flash: 'pending', verify: 'pending', export: 'pending', restartDedup: 'pending', modeGate: 'pending', concurrentTask: 'pending', duringFlashClose: 'pending', tamper: 'not-requested' },
  nativeConfirmation: { automatedResponse: delegatedNativeUI, synthesizedDialogResponse: false,
    mechanism: delegatedNativeUI ? 'Original native Electron confirmation; coordinating agent operates visible UI under explicit user delegation' : 'Original native Electron confirmation; human response required' },
  limitation: 'User-driven application gates only; not OS account isolation, autonomous-agent safety, or physical fault recovery',
  progressSampling: { requiredForPass: false, source: 'Optional read-only hardwareSnapshot telemetry; never a success criterion', sampleLimit: 200 }, progressSamples: [],
  steps: [], failures: [], pageErrors: [] };
function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /(?:password|credential|authorization|access.?token|refresh.?token|api.?key|binding.?key)/i.test(key) ? '[REDACTED]' : sanitize(item)]));
  return value;
}
async function evidence() { await writeFile(path.join(scope.output, 'evidence.json'), JSON.stringify(sanitize(report), null, 2)); }
async function snapshot(): Promise<T2Snapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()) as Promise<T2Snapshot>; }
async function hardware(): Promise<EmbeddedStatus> { assert.ok(taskId); return page!.evaluate(id => (window.forgeDesk as T2API).hardwareSnapshot(id), taskId); }
async function mainProcess(pid: number): Promise<InstalledMainProcess | null> {
  const { stdout } = await execute(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { windowsHide: true, shell: false, timeout: 15000 });
  return JSON.parse(stdout.trim());
}
async function assertNoInstalledApplication() {
  const identity = await readDesktopIdentity();
  assert.equal(identity.applications.filter(item => samePath(item.executable, plan.installedExe)).length, 0, 'Close the installed application normally before this test');
}
async function capture(name: string) {
  await page!.evaluate(() => { const label = document.querySelector('.sidebar-footer strong'); if (label) label.textContent = 'T2 no-auth home'; });
  await page!.screenshot({ path: path.join(scope.output, `${name}.png`) });
}
async function viewports(name: string) {
  for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) {
    await page!.setViewportSize(size); await pause(150);
    assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Unexpected horizontal viewport overflow');
    await capture(`${name}-${size.width}x${size.height}`);
  }
  await page!.setViewportSize({ width: 1380, height: 900 });
}
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 240000): Promise<T> {
  const deadline = Date.now() + timeout; let checkpoint = 0;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= checkpoint) { report.latestObservation = { label, ...(taskId ? { hardware: await hardware() } : {}) }; await evidence(); checkpoint = Date.now() + 5000; }
    await pause(250);
  }
  throw new Error(`${label} observation timed out; no action was replayed or terminated`);
}
async function idleUI() {
  if (taskId) await page!.locator(`.embedded-scroll[data-task-id="${taskId}"]`).waitFor({ state: 'visible', timeout: 30000 });
  await page!.locator('.embedded-scroll[aria-busy="false"][data-pending-intent=""]').waitFor({ state: 'visible', timeout: 30000 });
  assert.equal(await page!.locator('.embedded-scroll[aria-busy="true"]').count(), 0);
}
async function uiOperation(kind: 'build' | 'inspect' | 'flash' | 'verify', button: string, timeout = 240000, during?: (state: EmbeddedStatus) => Promise<void>) {
  const before = await hardware();
  await page!.getByRole('button', { name: button, exact: true }).click();
  const clickedAt = Date.now();
  const next = await waitFor(async () => {
    const state = await hardware();
    for (const operation of state.operations) if (operation.kind === kind && operation.progress) {
      const sampleKey = `${operation.id}:${operation.progress.sequence}:${operation.progress.updatedAt}`;
      if (!report.progressSamples.some((sample: { sampleKey: string }) => sample.sampleKey === sampleKey)) {
        if (report.progressSamples.length < report.progressSampling.sampleLimit) report.progressSamples.push({ sampleKey, observedAt: new Date().toISOString(), operationId: operation.id, status: operation.status, progress: operation.progress });
        else report.progressSampling.droppedSamples = (report.progressSampling.droppedSamples ?? 0) + 1;
      }
    }
    const failure = await page!.locator('.embedded-scroll .notice.error').allTextContents();
    if (failure.length) throw new Error(`${kind} UI action rejected: ${failure.join('; ')}`);
    if (during) await during(state);
    const pending = await page!.locator('.embedded-scroll').getAttribute('data-pending-intent');
    if (state.operations.length === before.operations.length && pending === '' && Date.now() - clickedAt > 5000) throw new Error(`${kind} returned without an operation; native cancellation is not a successful hardware action`);
    return state;
  }, state => state.operations.length > before.operations.length && !state.operations.some(item => ['prepared', 'running'].includes(item.status)), kind, timeout);
  report.latestHardware = next; await evidence();
  assert.equal(next.operations.length, before.operations.length + 1, `${kind} must create exactly one operation`);
  const added = next.operations.find(item => !before.operations.some(old => old.id === item.id)); assert.ok(added); assert.equal(added.kind, kind);
  successfulOperation(next, kind, added.requestKey); await idleUI(); return next;
}
async function withOpenChooser(filename: string, action: () => Promise<void>) {
  await app!.evaluate(({ dialog }, approvedPath) => {
    const holder = globalThis as unknown as { __t2Chooser?: { original: typeof dialog.showOpenDialog; calls: number } };
    if (holder.__t2Chooser) throw new Error('A file chooser override already exists');
    holder.__t2Chooser = { original: dialog.showOpenDialog, calls: 0 };
    dialog.showOpenDialog = (async () => { holder.__t2Chooser!.calls++; if (holder.__t2Chooser!.calls !== 1) throw new Error('Unexpected extra file chooser'); return { canceled: false, filePaths: [approvedPath] }; }) as typeof dialog.showOpenDialog;
  }, filename);
  try { await action(); }
  finally {
    const calls = await app!.evaluate(({ dialog }) => { const holder = globalThis as unknown as { __t2Chooser?: { original: typeof dialog.showOpenDialog; calls: number } }; const old = holder.__t2Chooser; if (!old) throw new Error('Chooser state missing'); dialog.showOpenDialog = old.original; delete holder.__t2Chooser; return old.calls; });
    report.chooserActions ??= []; report.chooserActions.push({ path: filename, calls, override: 'showOpenDialog only; restored' }); await evidence(); assert.equal(calls, 1);
  }
}
async function launch(expectMode: boolean) {
  await assertNoInstalledApplication();
  const environment = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string'));
  environment.FORGEDESK_DATA_DIR = scope.dataDir; delete environment.ELECTRON_RUN_AS_NODE;
  const { _electron: electron } = await import('playwright'); exitListeners = capturePlaywrightExitListeners();
  app = await electron.launch({ executablePath: plan.installedExe, args: [], cwd: root, env: environment, timeout: 30000 }); launcher = app.process();
  electronMain = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: process.type, platform: process.platform }));
  const launchRecord: Record<string, unknown> = { launcherPid: launcher.pid, launcherPidScope: 'Playwright shell launcher, not Electron main', electronMain };
  report.launches ??= []; report.launches.push(launchRecord); await evidence(); assertElectronMainIdentity(electronMain, plan.installedExe);
  const identity = await readDesktopIdentity(); const observed = await mainProcess(electronMain.pid); launchRecord.nativeMain = observed; await evidence();
  assertInstalledMainProcess(observed, electronMain, plan.installedExe, identity.sid, identity.sessionId); nativeMain = observed;
  page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message))); await page.locator('.app-header').waitFor();
  const state = await waitFor(snapshot, value => expectMode ? value.hardware.modeActive === true : ['ready', 'failed', 'stopped'].includes(value.engine.state), 'installed startup', 60000);
  assert.equal(state.version, plan.version); assert.equal(state.dataDir, scope.dataDir); assert.equal(state.engine.home, path.join(scope.dataDir, 'engine'));
  assert.equal(state.account.loggedIn, false, 'Independent T2 home must not borrow an existing account'); assert.equal(state.hardware.enabled, false);
  assert.equal(state.hardware.userDriven, true); assert.equal(state.hardware.modeActive, expectMode);
  report.initialStates ??= []; report.initialStates.push({ version: state.version, publicLoggedIn: state.account.loggedIn, hardware: state.hardware, engineState: state.engine.state }); await evidence();
  return state;
}
async function closeApp() {
  if (!app) return;
  const current = app; const child = launcher; const main = electronMain; const native = nativeMain; assert.ok(child && main && native);
  if (taskId) assert.equal((await hardware()).operations.some(item => ['prepared', 'running'].includes(item.status) || (item.status === 'unknown' && item.processExited !== true)), false, 'Never close or kill an unresolved hardware operation');
  assert.equal(child.exitCode, null, 'A previously exited launcher is not this normal close'); assert.equal(child.signalCode, null);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const closeRequest = observeNormalCloseRequest(current.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); }), 5000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native close is unconfirmed; no force termination attempted')), 30000); })]);
    const record: Record<string, any> = { electronMain: main, launcherExitCode: result.code, launcherSignal: result.signal, exitCodeScope: 'playwright-launcher', normalClose: false };
    report.closes ??= []; report.closes.push(record); await evidence(); assert.equal(result.code, 0); assert.equal(result.signal, null);
    record.nativeAfter = await mainProcess(main.pid); assertElectronMainExited(native, record.nativeAfter); await assertNoInstalledApplication(); record.installedGuiAbsent = true;
    record.absenceScope = 'Installed ForgeDesk.exe GUI processes only; not a full-machine Codex/host inventory';
    const request = await closeRequest; record.nativeCloseObservation = request.state === 'rejected' ? { state: request.state, message: redact(String(request.error)) } : request;
    assert.notEqual(request.state, 'timed-out');
    const disposed = await observeNormalCloseRequest(current.close(), 5000); assert.equal(disposed.state, 'acknowledged');
    record.normalClose = true; await evidence(); app = undefined; page = undefined; launcher = undefined; electronMain = undefined; nativeMain = undefined;
  } finally { if (timer) clearTimeout(timer); }
}

// No directories, application or hardware is touched until the complete plan and release pins pass.
for (const filename of [scope.runtime, scope.output, plan.projectRoot, plan.installedExe, plan.installerPath, plan.keilExecutable]) await plainPath(filename);
for (const filename of [scope.runtime, scope.output]) { try { await lstat(filename); assert.fail(`A T2 run must be fresh; retain existing run ${filename}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
assert.equal((await lstat(plan.projectRoot)).isDirectory(), true);
assert.equal(await fileSha256(plan.installedExe), plan.executableSha256); assert.equal(await fileSha256(plan.installerPath), plan.installerSha256);
for (const [relative, expected] of Object.entries(plan.resourceHashes)) { const filename = path.join(path.dirname(plan.installedExe), relative); await plainPath(filename); assert.equal(await fileSha256(filename), expected.toLowerCase(), `Installed resource mismatch: ${relative}`); }
const desktop = await readDesktopIdentity(); assert.equal(desktop.sid, primarySid, 'Only the coordinating primary desktop executes this T2 plan');
assert.equal(desktop.elevated, false); assert.equal(desktop.interactive, true); assert.ok(desktop.explorerOwners.some(item => item.sid === desktop.sid && item.sessionId === desktop.sessionId));
await assertNoInstalledApplication(); await mkdir(scope.runtime, { recursive: true }); await mkdir(scope.output, { recursive: true });
report.desktop = { sid: desktop.sid, sessionId: desktop.sessionId, elevated: desktop.elevated, explorerMatched: true };
report.release = { version: plan.version, executableSha256: plan.executableSha256, installerSha256: plan.installerSha256, resourceHashes: plan.resourceHashes, suppliedRuntimeCommit: plan.runtimeCommit };
report.planSha256 = await fileSha256(planFile); report.testScriptSha256 = await fileSha256(fileURLToPath(import.meta.url)); report.helperSha256 = await fileSha256(path.join(root, 'tests/helpers/embedded-installed.ts')); await evidence();
report.receiptParserSha256 = await fileSha256(path.join(root, 'packages/engineering-runner/device/real-stm32.ts'));
report.closeWarningObserverSha256 = await fileSha256(path.join(root, 'tests/helpers/embedded-close-observer.ts'));
report.exportHelperSha256 = await fileSha256(path.join(root, 'tests/helpers/embedded-export.ts'));
try {
  await launch(false);
  await withOpenChooser(plan.projectRoot, async () => { await page!.getByRole('button', { name: '导入项目', exact: true }).first().click(); await waitFor(snapshot, state => state.projects.some(item => samePath(item.root, plan.projectRoot)), 'project import', 30000); });
  const project = (await snapshot()).projects.find(item => samePath(item.root, plan.projectRoot)); assert.ok(project);
  await page!.getByTitle(plan.projectRoot, { exact: true }).and(page!.getByRole('button')).click();
  await page!.locator('.sidebar').getByRole('button', { name: '新建任务', exact: true }).click();
  const created = await waitFor(snapshot, state => state.sessions.some(item => item.projectId === project.id), 'task creation', 30000);
  const session = created.sessions.find(item => item.projectId === project.id); assert.ok(session); taskId = session.taskId; report.taskId = taskId; report.sessionId = session.id;
  const otherSession = await page!.evaluate(id => window.forgeDesk.createSession(id, 'T2 concurrent request must be blocked'), project.id);
  report.otherTaskId = otherSession.taskId;
  await page!.getByRole('tab', { name: '实机流程', exact: true }).click(); await idleUI();
  await page!.getByRole('button', { name: '配置工程', exact: true }).click(); await waitFor(hardware, state => state.configured, 'configuration', 30000); await idleUI();
  const configured = await hardware(); assert.equal(configured.profileSha256, plan.expectedProfile.sha256); assert.equal(configured.projectRoot && samePath(configured.projectRoot, plan.projectRoot), true);
  const beforeBlocked = await snapshot(); assert.equal(beforeBlocked.hardware.modeActive, true); assert.ok(!['ready', 'starting'].includes(beforeBlocked.engine.state));
  for (const method of ['connect', 'send'] as const) {
    let error = ''; try { await page!.evaluate(({ method, sessionId }) => method === 'connect' ? window.forgeDesk.connect() : window.forgeDesk.send(sessionId, 'T2 gate must reject before any turn'), { method, sessionId: session.id }); } catch (failure) { error = String(failure); }
    report.modeRejections ??= []; report.modeRejections.push({ method, error: redact(error) }); assert.match(error, /受控|controlled|hardware mode/i);
  }
  const blocked = await snapshot(); assert.deepEqual(blocked.sessions, beforeBlocked.sessions); assert.equal(blocked.engine.state, beforeBlocked.engine.state); assert.equal(blocked.approvals.length, 0);
  report.controls.modeGate = 'passed'; report.steps.push('Real installed configure entered persistent mode; send/connect rejected without public session mutation. Exact engine-call-zero is covered separately by main-source tests.'); await viewports('configured'); await evidence();
  const built = await uiOperation('build', '固件构建'); const artifact = assertEmbeddedBuild(built, plan.expectedProfile);
  assert.ok(inside(scope.dataDir, artifact.hexPath) && inside(scope.dataDir, artifact.axfPath));
  assert.equal(await fileSha256(artifact.hexPath), artifact.hexSha256); assert.equal(await fileSha256(artifact.axfPath), artifact.axfSha256); assert.equal(await fileSha256(artifact.logPath), artifact.logSha256);
  assert.ok(inside(scope.dataDir, artifact.sourceRoot));
  for (const file of artifact.files) { const filename = path.join(artifact.sourceRoot, file.path); assert.ok(inside(artifact.sourceRoot, filename)); await plainPath(filename); assert.equal(await fileSha256(filename), file.sha256); assert.equal((await lstat(filename)).size, file.bytes); }
  report.build = built; report.controls.build = 'passed'; await evidence();
  let concurrencyObserved = false;
  const inspected = await uiOperation('inspect', '设备检查', 240000, async state => {
    if (concurrencyObserved || !state.operations.some(operation => operation.kind === 'inspect' && operation.status === 'running')) return;
    const before = await page!.evaluate(id => (window.forgeDesk as T2API).hardwareSnapshot(id), otherSession.taskId); assert.equal(before.operations.length, 0);
    let rejection = ''; const attemptedAt = new Date().toISOString();
    try { await page!.evaluate(({ id, key }) => (window.forgeDesk as T2API).hardwareInspect(id, key), { id: otherSession.taskId, key: `${plan.runId}-concurrent-inspect` }); }
    catch (error) { rejection = String(error); }
    const after = await page!.evaluate(id => (window.forgeDesk as T2API).hardwareSnapshot(id), otherSession.taskId);
    report.concurrentInspect = { attemptedAt, activeOperation: state.operations.find(operation => operation.kind === 'inspect' && operation.status === 'running'), otherTaskBefore: before, rejection: redact(rejection), otherTaskAfter: after }; await evidence();
    assert.match(rejection, /另一个任务仍在运行/); assert.equal(after.operations.length, 0); assert.deepEqual(after, before); concurrencyObserved = true;
  });
  assert.equal(concurrencyObserved, true, 'Inspect must be observed running before claiming the cross-task gate'); report.controls.concurrentTask = 'passed';
  const inspect = successfulOperation(inspected, 'inspect'); assert.ok(inspect.receipt);
  const inspectReceipt = JSON.parse(inspect.receipt); assert.equal(inspectReceipt.action, 'inspect'); assert.equal(inspectReceipt.operationId, inspect.id); assert.equal(inspectReceipt.status, 'succeeded');
  parseFixedWorkerReceipt(`${inspect.receipt}\n`, 'inspect', inspect.id);
  assert.deepEqual(inspectReceipt.target, { chipId: plan.expectedProfile.chipId, flashSizeKiB: plan.expectedProfile.flashKiB, uid96: plan.expectedProfile.uid });
  assert.equal(inspectReceipt.backup?.bytes, 1048576); assert.equal(inspectReceipt.backup?.doubleReadMatch, true); assert.ok(inside(scope.dataDir, inspectReceipt.backup.path));
  assert.equal(await fileSha256(inspectReceipt.backup.path), inspectReceipt.backup.sha256); report.inspect = inspected; report.controls.inspect = 'passed'; await capture('before-human-confirmation'); await evidence();
  report.closeWarningObserver = await app!.evaluate(installEmbeddedCloseObserver, { runId: plan.runId }); closeObserverInstalled = true; await evidence();
  console.log('T2 NATIVE ACTION REQUIRED: human or explicitly delegated coordinating operator must read the original confirmation and approve only this reviewed flash. The harness never answers this dialog.');
  let duringFlashCloseObserved = false;
  const flashed = await uiOperation('flash', '授权并烧录', 600000, async state => {
    if (duringFlashCloseObserved) return;
    const operation = state.operations.find(item => item.kind === 'flash' && item.status === 'running'); if (!operation) return;
    assert.match(taskId!, /^[a-zA-Z0-9_-]+$/); assert.match(operation.id, /^[a-f0-9-]{36}$/i);
    const phasePath = path.join(scope.dataDir, 'embedded', taskId!, 'operations', operation.id, 'phase.json'); await plainPath(phasePath);
    let phase: Record<string, unknown>; try { phase = JSON.parse(await readFile(phasePath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    assert.equal(phase.operationId, operation.id); assert.equal(phase.stage, 'erase_or_program_started'); assert.equal(phase.dangerous, true);
    const fresh = await hardware(); if (!fresh.operations.some(item => item.id === operation.id && item.status === 'running')) return;
    const observation: Record<string, any> = { phasePath, phase, activeOperation: operation, phaseObservedAt: new Date().toISOString(), closeAttempts: 1 };
    report.duringFlashClose = observation; observation.closeRequestedAt = new Date().toISOString();
    const closeRequest = observeNormalCloseRequest(app!.evaluate(({ BrowserWindow }) => { const windows = BrowserWindow.getAllWindows(); if (windows.length !== 1) throw new Error('Expected exactly one target product window'); windows[0].close(); }), 5000);
    console.log('T2 NATIVE ACTION REQUIRED: read the real during-flash close warning and click its normal acknowledgement; the harness will not answer.');
    await waitFor(() => app!.evaluate(readEmbeddedCloseObserver, { runId: plan.runId }), receipt => receipt.calls.length > 0, 'original native close warning', 15000);
    observation.windowWhileWarning = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, destroyed: window.isDestroyed() })));
    assert.equal(observation.windowWhileWarning.length, 1); assert.equal(observation.windowWhileWarning[0].destroyed, false); await evidence();
    const receipt = await waitFor(() => app!.evaluate(readEmbeddedCloseObserver, { runId: plan.runId }), value => value.calls.length > 0 && value.calls.every(call => call.phase !== 'started'), 'human close-warning acknowledgement', 600000);
    observation.warning = receipt; await evidence(); assertEmbeddedCloseWarning(receipt);
    const closeAcknowledgement = await closeRequest; observation.closeRequest = closeAcknowledgement.state === 'rejected' ? { state: closeAcknowledgement.state, message: redact(String(closeAcknowledgement.error)) } : closeAcknowledgement;
    assert.equal(closeAcknowledgement.state, 'acknowledged');
    observation.nativeAfterWarning = await mainProcess(electronMain!.pid); assert.ok(observation.nativeAfterWarning); assert.equal(observation.nativeAfterWarning.created, nativeMain!.created);
    assert.equal(launcher!.exitCode, null); assert.equal(launcher!.signalCode, null); duringFlashCloseObserved = true; await evidence();
  });
  assert.equal(duringFlashCloseObserved, true, 'Must observe running flash plus erase/program phase and the real native close gate');
  report.closeWarningObserverRestored = await app!.evaluate(restoreEmbeddedCloseObserver, { runId: plan.runId }); closeObserverInstalled = false;
  report.controls.duringFlashClose = 'passed'; report.duringFlashClose.scope = 'Graceful close requested during a running flash after erase/program marker; not crash, forced termination, disconnect or power-loss recovery';
  const flash = successfulOperation(flashed, 'flash'); assertFlashGrant(flashed, plan.expectedProfile, flash);
  assert.ok(flash.receipt); const flashReceipt = JSON.parse(flash.receipt); assert.equal(flashReceipt.operationId, flash.id); assert.equal(flashReceipt.action, 'flash'); assert.equal(flashReceipt.status, 'succeeded');
  parseFixedWorkerReceipt(`${flash.receipt}\n`, 'flash', flash.id, artifact.buildId);
  assert.equal(flashReceipt.artifactSha256, artifact.hexSha256); assert.equal(flashReceipt.backupSha256, inspectReceipt.backup.sha256); assert.ok(flashReceipt.preflashDifferentBytes > 0);
  assert.equal(flashReceipt.preflashReadSha256, inspectReceipt.backup.sha256);
  assert.equal(flashed.grant?.backupSha256, inspectReceipt.backup.sha256);
  assert.equal(flashReceipt.readbackMismatchBytes, 0); assert.ok(flashReceipt.definedBytes > 0); assert.equal(flashReceipt.readbackDefinedBytes, flashReceipt.definedBytes); assert.equal(flashReceipt.stage, 'reset_and_exited');
  report.flash = flashed; report.controls.flash = 'passed'; await viewports('authorized-flash'); await evidence();
  const verified = await uiOperation('verify', '实机验证'); const verify = successfulOperation(verified, 'verify'); assert.ok(verify.receipt);
  const verifyReceipt = JSON.parse(verify.receipt); assert.equal(verifyReceipt.action, 'verify'); assert.equal(verifyReceipt.operationId, verify.id); assert.equal(verifyReceipt.status, 'succeeded'); assert.equal(verifyReceipt.stage, 'cdc_verified');
  parseFixedWorkerReceipt(`${verify.receipt}\n`, 'verify', verify.id, artifact.buildId);
  assert.equal(verifyReceipt.verify?.expectedBuildId, artifact.buildId); assert.equal(verifyReceipt.verify.expectedUid96, plan.expectedProfile.uid);
  const challenges = verifyReceipt.verify.challenges; assert.equal(challenges.length, 2); assert.notEqual(challenges[0].nonceHex, challenges[1].nonceHex);
  for (const challenge of challenges) assert.ok(Date.parse(challenge.receivedAtUtc) >= Date.parse(verify.createdAt) && Date.parse(challenge.receivedAtUtc) <= Date.parse(verify.updatedAt), 'Live CDC sample must belong to this operation time window');
  const first = challenges[0].decoded; const second = challenges[1].decoded;
  assert.equal(first.flags & 31, 31); assert.equal(second.flags & 31, 31); assert.ok(second.cameraFrames > first.cameraFrames);
  for (const key of ['cameraErrors', 'cameraTimeouts', 'displayErrors']) assert.equal(second[key], first[key]);
  for (const value of [first, second]) { assert.equal(value.sysclkHz, 168000000); assert.equal(value.pll48Hz, 48000000); }
  report.verify = verified; report.controls.verify = 'passed'; report.protocolBoundary = 'Worker emits two nonce128/raw FDR1 challenge receipts; harness re-parses CRC/UID/buildID and decoded fields using the source-hashed pure parser. Worker request/write behavior is separately covered by parser and USB simulation tests, not physical fault injection.'; await viewports('verified'); await evidence();
  await withOpenChooser(scope.output, async () => { await page!.getByRole('button', { name: '导出证据', exact: true }).click(); await page!.getByRole('status').filter({ hasText: '证据已导出：' }).waitFor({ timeout: 30000 }); await idleUI(); });
  const notice = await page!.getByRole('status').filter({ hasText: '证据已导出：' }).innerText(); const exportFile = notice.slice(notice.indexOf('：') + 1).trim();
  assert.ok(inside(scope.output, exportFile)); report.export = await verifyEmbeddedExport(exportFile, verified); report.controls.export = 'passed'; await evidence();
  await closeApp(); await launch(true); assert.ok(taskId); await page!.getByRole('tab', { name: '实机流程', exact: true }).click(); await idleUI();
  const restored = await hardware(); assertNoEmbeddedReplay(verified, restored); const repeated = await page!.evaluate(({ id, key }) => (window.forgeDesk as T2API).hardwareFlash(id, key), { id: taskId, key: flash.requestKey });
  assertNoEmbeddedReplay(restored, repeated); report.restart = { before: verified, restored, repeated, method: 'Same completed flash request key via public Desktop API; no new native confirmation expected' }; report.controls.restartDedup = 'passed'; await evidence();
  if (plan.artifactTamperPreflight) {
    const original = await readFile(artifact.hexPath); const altered = Buffer.concat([original, Buffer.from('\n; QA artifact tamper preflight only\n')]);
    await writeFile(artifact.hexPath, altered); let rejection = '';
    try { await page!.evaluate(({ id, key }) => (window.forgeDesk as T2API).hardwareVerify(id, key), { id: taskId, key: `${plan.runId}-tamper-verify` }); }
    catch (error) { rejection = String(error); }
    finally { await writeFile(artifact.hexPath, original); }
    report.tamper = { path: artifact.hexPath, rejection: redact(rejection), restoredSha256: await fileSha256(artifact.hexPath), mutation: 'Owned copied HEX only; verify preflight, never flash' }; await evidence();
    assert.match(rejection, /artifact.*(?:hash|SHA)|hash mismatch|产物/i); assert.equal(report.tamper.restoredSha256, artifact.hexSha256);
    assertNoEmbeddedReplay(restored, await hardware()); report.controls.tamper = 'passed';
  }
  await viewports('restored-delivery');
  await page!.getByRole('button', { name: '返回软件模式', exact: true }).click(); await waitFor(snapshot, state => state.hardware.modeActive === false, 'leave controlled mode', 60000); await idleUI();
  assert.equal((await hardware()).grant, undefined, 'Leaving mode must revoke all native grants'); report.leftMode = true;
  assert.equal(report.pageErrors.length, 0); report.result = 'passed'; report.completedAt = new Date().toISOString(); await evidence(); await closeApp();
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(String(error)));
  let preserveHumanDialog = false;
  try { if (page && taskId) report.failureHardware = await hardware(); } catch (failure) { report.observationError = redact(String(failure)); }
  try { if (page) await capture('failure'); } catch { /* Preserve the original failure if renderer capture is unavailable. */ }
  if (app && closeObserverInstalled) {
    try { report.failureCloseWarning = await app.evaluate(readEmbeddedCloseObserver, { runId: plan.runId }); preserveHumanDialog = report.failureCloseWarning.calls.some((call: { phase: string }) => call.phase === 'started'); report.closeWarningObserverRestored = await app.evaluate(restoreEmbeddedCloseObserver, { runId: plan.runId }); closeObserverInstalled = false; }
    catch (failure) { preserveHumanDialog = true; report.closeWarningObservationError = redact(String(failure)); }
  }
  try { if (page && await page.locator('.embedded-scroll').getAttribute('data-pending-intent') === 'flash') preserveHumanDialog = true; } catch { /* An unavailable renderer cannot authorize automatic cleanup. */ }
  if (preserveHumanDialog) { report.needsHumanClose = true; report.preservedPendingNativeOrFlashIntent = true; }
  await evidence();
  try { if (app && !preserveHumanDialog) await closeApp(); } catch (failure) { report.needsHumanClose = true; report.cleanupError = redact(String(failure)); await evidence(); }
  if (app && launcher && launcher.exitCode === null) {
    try { report.playwrightNoKill = detachNewPlaywrightExitHandler(exitListeners); await evidence(); process.exit(1); }
    catch (failure) { report.detachError = redact(String(failure)); await evidence(); console.error('No-kill detach unconfirmed: close/recover the application manually. This harness will not force termination.'); await new Promise(resolve => launcher!.once('close', resolve)); }
  }
  process.exitCode = 1;
}
