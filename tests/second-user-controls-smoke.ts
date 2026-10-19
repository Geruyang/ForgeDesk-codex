import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot, Session } from '../packages/shared/contracts';
import { prepareSnapshotScope, assertSecondUserAppClosed, primarySid, readDesktopIdentity, installerSha256 } from './helpers/snapshot-smoke-scope';
import { assertControlsIdentity, assertDiagnosticsExport, assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, assertMcpDenialApproval, assertProcessProbe, assertStopObservationTiming, assertWaitCommand, connectControlsStartup, nativeMainProcessQuery, refusedMcpItem, secondUserSid, stopObservationDeadline, type ElectronMainIdentity, type InstalledMainProcess } from './helpers/second-user-controls';
import { redact } from '../packages/engineering-runner/redaction';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { assertControlsStopReceipt, installControlsStopObserver, readControlsStopObserver, restoreControlsStopObserver } from './helpers/controls-stop-observer';

for (const [key, value] of Object.entries(process.env)) if (key.startsWith('FORGEDESK_SNAPSHOT_') && value) assert.fail(`Use a clean second-user PowerShell; remove ambient ${key}`);
assert.equal(process.argv.length, 2, 'This entry accepts no identity, path or mode arguments');
process.env.FORGEDESK_SNAPSHOT_SECOND_USER = '1'; process.env.FORGEDESK_SNAPSHOT_REAL_MODEL = '1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `snapshot-${Date.now()}`;
assertControlsIdentity(await readDesktopIdentity());
const scope = await prepareSnapshotScope(root, process.env, runId);
assert.equal(scope.identity!.sid, secondUserSid, 'Controls acceptance is scoped to the actual authorized ForgeDeskTest SID 1006');
const { _electron: electron } = await import('playwright');
const execute = promisify(execFile);
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const output = path.join(scope.output, 'controls');
const verifier = path.join(scope.runtime, 'controls-verifier.mjs');
const source = path.join(scope.workspace, 'numbers.mjs');
const original = 'export function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }\n';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: Record<string, any> = { schemaVersion: 1, runId, scope: 'Installed second-user controls', realModel: true,
  secondUser: true, desktopIdentity: scope.identity, dependencies: scope.dependencies, dataDir: scope.dataDir, workspace: scope.workspace,
  installedRelease: { version: '0.2.1', expectedInstallerSha256: installerSha256, tenInstalledResourceHashesVerifiedBy: 'prepareSnapshotScope before application launch' },
  startedAt: new Date().toISOString(), controls: { stop: 'pending', mcpRefusal: 'pending', pendingApprovalReload: 'pending', diagnosticExport: 'pending', restart: 'pending' },
  pageErrors: [], failures: [], steps: [], sourceCommit: null, sourceDirty: null, sourceMetadataObservation: 'Not observed: no shared repository Git query under the secondary SID' };
let app: ElectronApplication | undefined; let page: Page | undefined;
let launcher: ChildProcess | undefined; let electronMain: ElectronMainIdentity | undefined; let nativeMain: InstalledMainProcess | undefined;
let launchExitBaseline: readonly Function[] = [];
let stopObserverSessionId: string | undefined;
const ownedSessions: string[] = [];

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:token|secret|password|credential|authorization|api.?key)/i.test(key) ? '[redacted]' : sanitize(item)]));
  return value;
}
async function evidence() { await writeFile(path.join(output, 'evidence.json'), JSON.stringify(sanitize(report), null, 2)); }
async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
function session(state: AppSnapshot, id: string) { const value = state.sessions.find(item => item.id === id); assert.ok(value); return value; }
async function capture(name: string) {
  await page!.evaluate(() => { const label = document.querySelector('.sidebar-footer strong'); if (label) label.textContent = 'QA account state'; });
  await page!.screenshot({ path: path.join(output, `${name}.png`) });
}
async function waitFor(predicate: (state: AppSnapshot) => boolean, ms = 120000) {
  const deadline = Date.now() + ms; let checkpoint = 0;
  while (Date.now() < deadline) {
    const state = await snapshot(); if (predicate(state)) return state;
    if (Date.now() >= checkpoint) { report.latestSessions = state.sessions.filter(item => ownedSessions.includes(item.id)); await evidence(); checkpoint = Date.now() + 10000; }
    await pause(250);
  }
  throw new Error('Real second-user control observation timed out; no completion is fabricated');
}
async function mainProcess(pid: number): Promise<InstalledMainProcess | null> {
  const { stdout } = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { windowsHide: true, shell: false, timeout: 15000 });
  return JSON.parse(stdout.trim()) as InstalledMainProcess | null;
}
async function waitForStopReceipt(sessionId: string, requireFulfilled = true) {
  const deadline = Date.now() + 60000; let previous = ''; let checkpoint = 0;
  while (Date.now() < deadline) {
    const receipt = await app!.evaluate(readControlsStopObserver, { sessionId }); report.stopInterruptReceipt = receipt;
    const current = JSON.stringify(receipt);
    if (current !== previous || Date.now() >= checkpoint) { await evidence(); previous = current; checkpoint = Date.now() + 10000; }
    if (requireFulfilled && receipt.calls.length > 1) assertControlsStopReceipt(receipt);
    if (receipt.calls.length && receipt.calls.every(call => call.phase !== 'started')) { if (requireFulfilled) assertControlsStopReceipt(receipt); return receipt; }
    await pause(250);
  }
  throw new Error('Original UI interrupt did not settle within 60 seconds; it was not replayed');
}
async function launch() {
  await assertSecondUserAppClosed(scope);
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  environment.FORGEDESK_DATA_DIR = scope.dataDir; delete environment.ELECTRON_RUN_AS_NODE;
  launchExitBaseline = capturePlaywrightExitListeners();
  app = await electron.launch({ executablePath: scope.installed!, args: [], cwd: root, env: environment, timeout: 30000 });
  launcher = app.process();
  const launchRecord: Record<string, any> = { observedAt: new Date().toISOString(), launcherPid: launcher.pid, launcherPidScope: 'Playwright launcher; may be cmd.exe on Windows' };
  report.launches ??= []; report.launches.push(launchRecord); await evidence();
  electronMain = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: process.type, platform: process.platform }));
  launchRecord.electronMain = electronMain; await evidence();
  assertElectronMainIdentity(electronMain, scope.installed!);
  const observed = await mainProcess(electronMain.pid); launchRecord.nativeMain = observed; await evidence();
  assertInstalledMainProcess(observed, electronMain, scope.installed!, secondUserSid, scope.identity!.sessionId); nativeMain = observed;
  page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.locator('.app-header').waitFor(); await page.setViewportSize({ width: 1380, height: 900 });
  await waitFor(state => ['ready', 'failed'].includes(state.engine.state));
  launchRecord.startupConnection = [];
  const state = await connectControlsStartup({ snapshot, connect: () => page!.evaluate(() => window.forgeDesk.connect()), wait: pause,
    observe: async observation => { launchRecord.startupConnection.push({ ...observation, observedAt: new Date().toISOString() }); await evidence(); } });
  assert.equal(state.version, '0.2.1'); assert.equal(state.engine.state, 'ready'); assert.equal(state.account.loggedIn, true);
  assert.equal(state.dataDir, scope.dataDir); assert.equal(state.engine.home, path.join(scope.dataDir, 'engine'));
  assert.equal(state.engine.executable, path.join(path.dirname(scope.installed!), 'resources/codex/codex.exe'));
  return state;
}
async function closeApp() {
  if (!app) return;
  const current = app; const child = launcher; const main = electronMain; const native = nativeMain;
  assert.ok(child && main && native, 'Normal close requires the saved launcher and actual installed main identities');
  assert.equal(child.exitCode, null, 'A child that exited before this close request is not normal-close evidence');
  assert.equal(child.signalCode, null, 'A previously signalled child is not normal-close evidence');
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Keep the inspector result even if no native-exit record can be created.
    const requestRecord: Record<string, unknown> = { launcherPid: child.pid, electronMain: main };
    report.closeRequestObservations ??= []; report.closeRequestObservations.push(requestRecord);
    const closeRequest = observeNormalCloseRequest(current.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); }), 5000).then(observation => {
      requestRecord.observation = observation.state === 'rejected' ? { state: observation.state, message: redact(String(observation.error)) } : observation;
      return observation;
    });
    const result = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native window close did not produce a confirmed launcher exit within 30 seconds; no force-close was attempted')), 30000); })]);
    const closeRecord: Record<string, any> = { launcherPid: child.pid, launcherExitCode: result.code, launcherSignal: result.signal, exitCodeScope: 'playwright-launcher', electronMain: main, nativeMainBefore: native, nativeWindowClose: true, normalClose: false };
    report.nativeCloses ??= []; report.nativeCloses.push(closeRecord); await evidence();
    assert.equal(result.code, 0, 'Normal close requires the saved Playwright launcher to exit with code 0'); assert.equal(result.signal, null, 'A killed launcher is not normal close');
    const after = await mainProcess(main.pid); closeRecord.nativeMainAfter = after; await evidence();
    assertElectronMainExited(native, after); closeRecord.nativeElectronIdentityAbsent = true;
    await assertSecondUserAppClosed(scope); closeRecord.nativeInstalledProcessesAbsent = true;
    closeRecord.nativeAbsenceScope = 'Installed ForgeDesk.exe application processes; Codex and process-host are not independently sampled by this check';
    const rememberObservation = (field: 'closeRequest' | 'playwrightCloseObservation', observation: Awaited<ReturnType<typeof observeNormalCloseRequest>>) => {
      closeRecord[field] = observation.state === 'rejected' ? { state: observation.state, message: redact(String(observation.error)) } : observation;
      if (observation.state === 'timed-out') throw new Error(`${field} exceeded ${observation.timeoutMs} milliseconds; acknowledgement is unconfirmed and no force-close was attempted`);
      if (field === 'playwrightCloseObservation' && observation.state === 'rejected') throw observation.error;
    };
    rememberObservation('closeRequest', await closeRequest);
    rememberObservation('playwrightCloseObservation', await observeNormalCloseRequest(current.close(), 5000));
    closeRecord.playwrightCloseAfterNativeExit = true; closeRecord.normalClose = true;
    app = undefined; page = undefined; launcher = undefined; electronMain = undefined; nativeMain = undefined;
  }
  finally { if (timer) clearTimeout(timer); }
}
async function newSession(projectId: string, title: string) {
  const value = await page!.evaluate(({ projectId, title }) => window.forgeDesk.createSession(projectId, title), { projectId, title }); ownedSessions.push(value.id);
  await pause(150); await page!.getByRole('button', { name: new RegExp(title) }).click(); return value;
}
interface ProcessRecord { id: number; parentId: number; name: string; created: string; commandLine?: string; root?: boolean }
async function waitingProcesses(marker: string): Promise<ProcessRecord[]> {
  assert.match(marker, /^qa-controls-wait-snapshot-\d+$/);
  const command = `$ErrorActionPreference='Stop'
$all=@(Get-CimInstance Win32_Process)
$roots=@($all | Where-Object { $_.ProcessId -ne $PID -and $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -like '*${marker}*' })
$ids=New-Object 'System.Collections.Generic.HashSet[int]'
foreach($item in $roots){$null=$ids.Add([int]$item.ProcessId)}
do{$changed=$false;foreach($item in $all){if($ids.Contains([int]$item.ParentProcessId)-and $ids.Add([int]$item.ProcessId)){$changed=$true}}}while($changed)
$result=@($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | ForEach-Object {@{id=[int]$_.ProcessId;parentId=[int]$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToUniversalTime().ToString('o');root=([int]$_.ProcessId -in @($roots.ProcessId));commandLine=$(if([int]$_.ProcessId -in @($roots.ProcessId)){$_.CommandLine}else{$null})}})
ConvertTo-Json -InputObject $result -Depth 4 -Compress`;
  const { stdout } = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, shell: false, timeout: 15000 });
  return JSON.parse(stdout.trim()) as ProcessRecord[];
}
async function remainingIdentities(before: ProcessRecord[]): Promise<ProcessRecord[]> {
  const ids = before.map(item => item.id); assert.ok(ids.length > 0 && ids.every(id => Number.isInteger(id) && id > 0));
  const command = `$ids=@(${ids.join(',')});$items=@(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -in $ids} | ForEach-Object {@{id=[int]$_.ProcessId;parentId=[int]$_.ParentProcessId;name=$_.Name;created=$_.CreationDate.ToUniversalTime().ToString('o')}});ConvertTo-Json -InputObject $items -Depth 4 -Compress`;
  const { stdout } = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, shell: false, timeout: 15000 });
  const now = JSON.parse(stdout.trim()) as ProcessRecord[];
  return now.filter(item => before.some(old => item.id === old.id && Date.parse(item.created) === Date.parse(old.created)));
}

await mkdir(output, { recursive: true });
try {
  await mkdir(scope.workspace, { recursive: true }); await writeFile(source, original);
  await writeFile(verifier, 'console.log("QA controls verifier: this should never execute after refusal");\n');
  report.testScriptSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  report.waitCommandGuardSha256 = hash(await readFile(path.join(root, 'tests/helpers/second-user-controls.ts')));
  report.stopObserverSha256 = hash(await readFile(path.join(root, 'tests/helpers/controls-stop-observer.ts')));
  report.normalCloseObservationSha256 = hash(await readFile(path.join(root, 'tests/helpers/normal-close-observation.ts')));
  const initial = await launch(); const model = initial.models[0]?.id; assert.ok(model);
  assert.equal(initial.hardware.enabled, false, 'Hardware must remain disabled throughout this software-only acceptance');
  report.initial = { version: initial.version, publicLoggedIn: initial.account.loggedIn, engine: initial.engine, hardwareEnabled: initial.hardware.enabled }; report.chosenModel = model;
  console.log(JSON.stringify({ runId, sid: scope.identity!.sid, version: initial.version, publicLoggedIn: true, model }));
  await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, scope.workspace);
  const project = await page!.evaluate(() => window.forgeDesk.importProject()); assert.ok(project);
  await pause(150); await page!.getByTitle(scope.workspace, { exact: true }).and(page!.getByRole('button')).click();

  const stopped = await newSession(project.id, `QA stop ${runId}`); const marker = `qa-controls-wait-${runId}`;
  report.stopObserverInstallation = await app!.evaluate(installControlsStopObserver, { sessionId: stopped.id }); stopObserverSessionId = stopped.id;
  assert.equal((await app!.evaluate(readControlsStopObserver, { sessionId: stopped.id })).calls.length, 0); await evidence();
  const waitPrompt = `This is a harmless stop test. Use the built-in shell exactly ONCE to execute exactly: Write-Output '${marker}'; Start-Sleep -Seconds 45. Do not read or change any files, do not read product/authentication directories, do not request extra permissions, and do not retry after interruption. Begin this command now.`;
  report.waitPrompt = waitPrompt;
  await page!.evaluate(({ id, prompt, model }) => window.forgeDesk.send(id, prompt, model), { id: stopped.id, prompt: waitPrompt, model });
  const running = await waitFor(state => state.approvals.length > 0 || session(state, stopped.id).messages.some(message => message.role === 'tool' && message.text.includes(marker) && ['running', 'inProgress'].includes(message.status ?? '')) || ['completed', 'failed', 'interrupted', 'needs_attention'].includes(session(state, stopped.id).status), 90000);
  assert.equal(running.approvals.length, 0, 'Unexpected wait-command approval: no permission will be granted');
  assert.equal(session(running, stopped.id).status, 'running', 'A real running turn is required for stop acceptance');
  let before = await waitingProcesses(marker); assert.equal(before.filter(item => item.root).length, 1, 'Exactly one native QA waiting PowerShell process must be observed');
  for (const item of before.filter(item => item.root)) assertWaitCommand(item.commandLine!, marker);
  const processProbeStarted = Date.now();
  let processProbeFailure: unknown;
  try { await execute(ps, ['-NoProfile', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(root, 'scripts/second-user-acceptance.ps1'), '-Stage', 'ProcessProbe', '-PrimarySid', primarySid], { windowsHide: true, shell: false, timeout: 20000 }); }
  catch (error) { processProbeFailure = error; report.processProbeInvocationFailure = redact(String(error)); }
  const probePath = path.join(root, 'output/second-user', secondUserSid, 'evidence/process-probe.json');
  const processProbeText = await readFile(probePath, 'utf8');
  await writeFile(path.join(output, 'process-probe.json'), processProbeText);
  const processProbe = JSON.parse(processProbeText.replace(/^\uFEFF/, ''));
  report.processProbe = processProbe; report.processProbeRuntimeIdentity = { launcherPid: launcher!.pid, electronMain, nativeMain };
  await evidence();
  if (processProbeFailure) throw processProbeFailure;
  assertProcessProbe(processProbe, scope.installed!, electronMain!, nativeMain!, secondUserSid, scope.identity!.sessionId);
  assert.ok(Date.parse(processProbe.utc) >= processProbeStarted - 1000, 'ProcessProbe must be this control run, not older metadata');
  before = await waitingProcesses(marker); assert.equal(before.filter(item => item.root).length, 1);
  for (const item of before.filter(item => item.root)) { assertWaitCommand(item.commandLine!, marker); assert.ok(Date.now() - Date.parse(item.created) < 30000, 'The QA waiting command must have time remaining; natural completion is not stop acceptance'); }
  const rootProcess = before.find(item => item.root)!; const nativeDeadline = stopObservationDeadline(rootProcess.created);
  report.stop = { before, via: 'renderer-stop-button', buttonClickCompleted: false, nativeObservationDeadline: new Date(nativeDeadline).toISOString() }; await capture('before-stop'); await evidence();
  const clickedAt = new Date().toISOString(); assertStopObservationTiming(rootProcess.created, clickedAt, clickedAt); report.stop.clickedAt = clickedAt;
  const clickTimeout = nativeDeadline - Date.now(); assert.ok(clickTimeout > 0);
  await page!.getByRole('button', { name: '停止当前回合', exact: true }).click({ timeout: clickTimeout });
  report.stop.buttonClickCompleted = true; report.stop.clickReturnedAt = new Date().toISOString(); assertStopObservationTiming(rootProcess.created, clickedAt, report.stop.clickReturnedAt);
  while (true) {
    assertStopObservationTiming(rootProcess.created, clickedAt, new Date().toISOString());
    const survivors = await remainingIdentities(before); const after = await waitingProcesses(marker); const observedAt = new Date().toISOString();
    report.stop.lastNativeObservation = { observedAt, remainingSameProcessIdentities: survivors, after };
    assertStopObservationTiming(rootProcess.created, clickedAt, observedAt);
    if (!survivors.length && !after.length) { report.stop.nativeAbsenceObservedAt = observedAt; report.stop.remainingSameProcessIdentities = survivors; report.stop.after = after; await evidence(); break; }
    await evidence(); await pause(Math.min(250, Math.max(0, nativeDeadline - Date.now())));
  }
  report.stop.interruptReceipt = await waitForStopReceipt(stopped.id);
  const interrupted = await waitFor(state => session(state, stopped.id).status === 'interrupted' && state.engine.state === 'ready' && !session(state, stopped.id).turnId, 60000);
  report.stop.finalSession = session(interrupted, stopped.id); report.stop.manuallyKilled = false;
  report.stopObserverRestoration = await app!.evaluate(restoreControlsStopObserver, { sessionId: stopped.id }); stopObserverSessionId = undefined;
  report.controls.stop = 'passed'; await capture('after-stop'); console.log('SECOND_USER_REAL_STOP_PASSED');

  const denied = await newSession(project.id, `QA MCP refusal ${runId}`); const requestKey = `${runId}-mcp-refusal`;
  await page!.evaluate(({ id, executable, verifier }) => window.forgeDesk.setAcceptance(id, [{ id: 'qa-controls-verifier', title: 'QA refusal only', kind: 'automated', command: { executable, args: [verifier], timeoutMs: 10000 }, verifierFiles: [verifier] }]), { id: denied.taskId, executable: scope.dependencies!.nodeExecutable, verifier });
  const refusalPrompt = `This is a single MCP refusal test. Do not change any file, do not read product/authentication directories, do not execute shell commands. Make exactly ONE engineering.test call with taskId=${denied.taskId}, verifierId=qa-controls-verifier and requestKey=${requestKey}. Wait for the client decision. The client will decline; report refusal and end without retry, alternate tools, or permission requests.`;
  report.refusalPrompt = refusalPrompt;
  await page!.evaluate(({ id, prompt, model }) => window.forgeDesk.send(id, prompt, model), { id: denied.id, prompt: refusalPrompt, model });
  const pending = await waitFor(state => state.approvals.length > 0 || ['completed', 'failed', 'interrupted', 'needs_attention'].includes(session(state, denied.id).status));
  assert.equal(pending.approvals.length, 1); const approval = pending.approvals[0]; assertMcpDenialApproval(approval, session(pending, denied.id), requestKey);
  assert.equal(pending.tasks.find(item => item.id === denied.taskId)!.operations.length, 0); await capture('mcp-pending-before-reload');
  await page!.reload(); await page!.locator('.app-header').waitFor();
  const reloaded = await snapshot(); assert.equal(reloaded.approvals.length, 1); assert.equal(reloaded.approvals[0].generation, approval.generation); assert.equal(reloaded.approvals[0].id, approval.id);
  assertMcpDenialApproval(reloaded.approvals[0], session(reloaded, denied.id), requestKey); assert.equal(reloaded.tasks.find(item => item.id === denied.taskId)!.operations.length, 0);
  const card = page!.locator('.approval'); await card.waitFor({ state: 'visible' }); assert.equal(await card.count(), 1);
  report.controls.pendingApprovalReload = 'passed'; await capture('mcp-pending-after-reload');
  await card.getByRole('button', { name: '拒绝', exact: true }).click();
  const refused = await waitFor(state => ['completed', 'failed', 'interrupted', 'needs_attention'].includes(session(state, denied.id).status));
  assert.equal(session(refused, denied.id).status, 'completed'); assert.equal(refused.approvals.length, 0);
  assert.equal(refused.tasks.find(item => item.id === denied.taskId)!.operations.length, 0); assert.equal(await readFile(source, 'utf8'), original);
  report.mcpRefusal = { generation: approval.generation, id: approval.id, decision: 'decline', via: 'renderer-button', taskId: denied.taskId, requestKey,
    reloadPreserved: true, runnerOperations: 0, sourceUnchanged: true, finalSession: session(refused, denied.id), actualRefusedToolItem: refusedMcpItem(session(refused, denied.id), requestKey), journalRead: false, shellCancellationClaimed: false };
  report.controls.mcpRefusal = 'passed'; await capture('mcp-refused'); console.log('SECOND_USER_REAL_MCP_REFUSAL_PASSED');

  const logMarker = `qa-diagnostic-${runId}`; const syntheticSecret = `synthetic-only-${runId}`;
  const missing = path.join(scope.workspace, `${logMarker}-password=${syntheticSecret}`);
  await app!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, missing);
  await assert.rejects(page!.evaluate(() => window.forgeDesk.importProject()));
  await app!.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
  assert.equal(await page!.evaluate(() => window.forgeDesk.exportDiagnostics()), null);
  const diagnosticsPath = path.join(output, 'diagnostics.json');
  await app!.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, diagnosticsPath);
  assert.equal(await page!.evaluate(() => window.forgeDesk.exportDiagnostics()), diagnosticsPath);
  const diagnosticsText = await readFile(diagnosticsPath, 'utf8'); const diagnostics = JSON.parse(diagnosticsText);
  assertDiagnosticsExport(diagnostics, logMarker, syntheticSecret);
  report.diagnosticExport = { path: diagnosticsPath, sha256: hash(diagnosticsText), allowedFields: Object.keys(diagnostics), syntheticLogMarker: logMarker,
    originalSyntheticValueAbsent: true, exactSyntheticLogHasRedaction: true, cancelledSaveReturnedNull: true, authenticationRead: false };
  report.controls.diagnosticExport = 'passed';

  const beforeRestart = await snapshot(); const expected = ownedSessions.map(id => ({ id, status: session(beforeRestart, id).status, messageIds: session(beforeRestart, id).messages.map(item => item.id) }));
  const oldMain = { ...electronMain! }; const oldNativeMain = { ...nativeMain! }; const oldLauncherPid = launcher!.pid;
  await closeApp(); await launch(); const restored = await snapshot();
  assert.ok(electronMain!.pid !== oldMain.pid || Date.parse(nativeMain!.created) !== Date.parse(oldNativeMain.created), 'Restart must replace the actual Electron main process identity, not merely its Windows launcher');
  for (const item of expected) { assert.equal(session(restored, item.id).status, item.status); assert.deepEqual(session(restored, item.id).messages.map(message => message.id), item.messageIds); assert.equal(restored.tasks.find(task => task.id === session(restored, item.id).taskId)!.operations.length, 0); }
  assert.equal(restored.approvals.length, 0); assert.deepEqual(await waitingProcesses(marker), []);
  report.restart = { oldMain, newMain: electronMain, oldNativeMain, newNativeMain: nativeMain, oldLauncherPid, newLauncherPid: launcher!.pid, sessions: expected, noRunnerReplay: true, noPendingApproval: true, qaWaitProcessAbsent: true };
  report.controls.restart = 'passed';
  for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) { await page!.setViewportSize(size); await pause(150); assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true); await capture(`completed-${size.width}x${size.height}`); }
  assert.deepEqual(report.pageErrors, []); assert.ok(Object.values(report.controls).every(value => value === 'passed'));
  report.result = 'passed'; report.steps.push('Second SID real native wait stopped, exact MCP refusal after reload, public diagnostics redaction and whole-application persistence verified; no shell accept/cancel or hardware claim');
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(error instanceof Error ? error.stack ?? error.message : String(error))); process.exitCode = 1;
  if (page) try { const state = await snapshot(); report.latestSessions = state.sessions.filter(item => ownedSessions.includes(item.id)); report.pendingApprovals = state.approvals; await capture('failure'); } catch {}
  await evidence();
} finally {
  if (app) try {
    if (report.result === 'failed' && page) {
      const state = await snapshot();
      for (const id of ownedSessions) {
        const own = session(state, id);
        for (const operation of state.tasks.find(task => task.id === own.taskId)?.operations ?? []) if (['prepared', 'running', 'stopping'].includes(operation.status)) await page.evaluate(({ taskId, operationId }) => window.forgeDesk.cancelOperation(taskId, operationId), { taskId: own.taskId, operationId: operation.id });
        if (own.turnId && ['running', 'stopping'].includes(own.status)) {
          const receipt = stopObserverSessionId === id ? await app.evaluate(readControlsStopObserver, { sessionId: id }) : undefined;
          if (receipt?.calls.length) { report.cleanupStopReplaySkipped = { sessionId: id, reason: 'Original Stop already invoked; preserve its real completion or error', receipt }; }
          else await page.evaluate(id => window.forgeDesk.interrupt(id), id);
        }
      }
      await waitFor(state => ownedSessions.every(id => !['running', 'stopping'].includes(session(state, id).status)), 60000);
    }
    if (stopObserverSessionId) {
      const receipt = await app.evaluate(readControlsStopObserver, { sessionId: stopObserverSessionId }); report.stopInterruptReceipt = receipt;
      if (receipt.calls.some(call => call.phase === 'started')) await waitForStopReceipt(stopObserverSessionId, false);
      report.stopObserverRestoration = await app.evaluate(restoreControlsStopObserver, { sessionId: stopObserverSessionId }); stopObserverSessionId = undefined;
    }
    await closeApp(); report.cleanup = { normalClose: true, forcedProcessKill: false };
  } catch (error) {
    report.result = 'failed'; report.failures.push(redact(String(error))); process.exitCode = 1;
    const child = launcher;
    let nativeMainAbsent = false;
    try { await assertSecondUserAppClosed(scope); nativeMainAbsent = true; } catch (inspectionError) { report.failures.push(redact(String(inspectionError))); }
    if ((child && child.exitCode === null && child.signalCode === null) || !nativeMainAbsent) {
      try { report.cleanup = { normalClose: false, forcedProcessKill: false, needsHumanClose: true, exitHookProtection: detachNewPlaywrightExitHandler(launchExitBaseline) }; }
      catch (protectionError) { report.failures.push(redact(String(protectionError))); report.cleanup = { normalClose: false, needsHumanClose: true, safeHarnessExitVerified: false }; }
    } else report.cleanup = { normalClose: false, needsHumanClose: false, launcherExitCode: child?.exitCode, launcherSignal: child?.signalCode, exitCodeScope: 'playwright-launcher', nativeInstalledProcessesAbsent: nativeMainAbsent };
  }
  report.finishedAt = new Date().toISOString(); await evidence();
  console.log(JSON.stringify({ result: report.result, sid: scope.identity!.sid, controls: report.controls, failures: report.failures, cleanup: report.cleanup, evidence: path.join(output, 'evidence.json') }, null, 2));
  if (report.cleanup?.needsHumanClose && report.cleanup.exitHookProtection?.sourceVerified) process.exit(1);
}
