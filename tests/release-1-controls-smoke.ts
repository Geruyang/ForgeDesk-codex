import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot, Approval, Session } from '../packages/shared/contracts';
import { ROOT, SHA, closed, readStable, sha, writeNew } from './helpers/release-1-files';
import { verifyRelease } from './helpers/release-1-binding';
import { assertHistorical, assertNoWork, launchEnvironment, readHostAdmission, readPersistedQuiet } from './helpers/release-1-policy';
import { inside, plainPath } from './helpers/embedded-installed';
import { prepareSnapshotInstalledLifecycle, type SnapshotInstalledLifecycle } from './helpers/snapshot-installed-lifecycle';
import { assertSnapshotNodeVersion } from './helpers/snapshot-smoke-scope';
import { assertStopObservationTiming, assertWaitCommand, stopObservationDeadline } from './helpers/second-user-controls';
import { assertAcceptanceUnchanged, assertMissingGitResult, assertMissingNodeResult, missingToolsAppEnvironment } from './helpers/second-user-missing-tools';
import { assertControlsStopReceipt, installControlsStopObserver, readControlsStopObserver, restoreControlsStopObserver } from './helpers/controls-stop-observer';
import { armControlsBoundary, installControlsBoundary, readControlsBoundary } from './helpers/release-1-controls-observer';
import { CONTROLS_OUTPUT, ControlsGate, assertControlsSnapshot, assertFreshRefusal, assertOwnedWaitProcess, assertRefusalComplete,
  assertReleaseDiagnostics, assertRestartSessions, controlsClosure, controlsRuntimeClosure, verifyControlsHarness, sanitizeControlsFailure, type ControlsCheckpoint, type WaitProcess, type ControlPhase } from './helpers/release-1-controls';

const installed = path.join(ROOT, 'install/ForgeDesk.exe'), dataDir = path.join(ROOT, '.runtime/app');
const execute = promisify(execFile), ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
interface Plan {
  schemaVersion: 1; scope: 'release-1-controls-plan-v1'; version: '1.0.0'; id: string; candidateSha256: string;
  installedInventoryPath: string; installedInventorySha256: string; hostPath: string; hostSha256: string; harnessPath: string; harnessSha256: string;
}
function assertPlan(value: any): asserts value is Plan {
  closed(value, ['schemaVersion', 'scope', 'version', 'id', 'candidateSha256', 'installedInventoryPath', 'installedInventorySha256', 'hostPath', 'hostSha256', 'harnessPath', 'harnessSha256']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.scope, 'release-1-controls-plan-v1'); assert.equal(value.version, '1.0.0'); assert.match(value.id, /^release-1-controls-\d{13}-[a-f0-9]{6}$/);
  for (const p of [value.candidateSha256, value.installedInventorySha256, value.hostSha256, value.harnessSha256]) assert.match(p, SHA);
}
async function verifyPlan(plan: Plan) {
  assertPlan(plan); const harness = await verifyControlsHarness(plan.harnessPath, plan.harnessSha256, plan.candidateSha256);
  const release = await verifyRelease(plan.candidateSha256, plan.installedInventoryPath, plan.installedInventorySha256);
  const host = await readHostAdmission(plan.hostPath, plan.hostSha256); assert.equal(release.electronVersion, '44.7.2');
  return { harness, release, host };
}
async function prepare(args: string[]) {
  assert.equal(args.length, 5, 'prepare requires candidateSHA installedInventoryPath installedInventorySHA hostDescriptorPath hostDescriptorSHA');
  const [candidateSha256, installedInventoryPath, installedInventorySha256, hostPath, hostSha256] = args;
  await verifyRelease(candidateSha256, installedInventoryPath, installedInventorySha256); await readHostAdmission(hostPath, hostSha256); await readPersistedQuiet();
  const id = `release-1-controls-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const directory = path.join(ROOT, CONTROLS_OUTPUT, 'manifests'); await plainPath(directory); await mkdir(directory, { recursive: true });
  const nodePath = 'C:/Program Files/nodejs/node.exe', node = await readStable(nodePath, 256 * 1024 * 1024);
  const harnessPath = path.join(directory, id + '.json');
  const harnessSha256 = await writeNew(harnessPath, { schemaVersion: 1, scope: 'release-1-controls-harness-v2', version: '1.0.0', candidateSha256,
    sources: await controlsClosure(), ...await controlsRuntimeClosure(), node: { path: nodePath, bytes: node.length, sha256: sha(node) } });
  const plan: Plan = { schemaVersion: 1, scope: 'release-1-controls-plan-v1', version: '1.0.0', id, candidateSha256,
    installedInventoryPath, installedInventorySha256, hostPath, hostSha256, harnessPath, harnessSha256 };
  const output = path.join(ROOT, CONTROLS_OUTPUT, 'runs', id); await plainPath(output); await mkdir(output, { recursive: true });
  const planPath = path.join(output, 'plan.json'), planSha256 = await writeNew(planPath, plan);
  console.log(JSON.stringify({ planPath, planSha256, harnessPath, harnessSha256, noApplicationStarted: true, noAutomaticNextPhase: true }, null, 2));
}
async function nativeWaitSample(marker: string, identities?: WaitProcess[], mainPid?: number): Promise<{ processes: WaitProcess[]; ancestry: WaitProcess[]; sampledAt: string }> {
  assert.match(marker, /^qa-controls-wait-snapshot-\d+$/);
  const selector = identities
    ? `$ids=@(${identities.map(p => { assert.ok(Number.isInteger(p.id) && p.id > 0); return p.id; }).join(',')});$selected=@($all | Where-Object {$_.ProcessId -in $ids})`
    : `$roots=@($all | Where-Object {$_.ProcessId -ne $PID -and $_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -like '*${marker}*'});$ids=New-Object 'System.Collections.Generic.HashSet[int]';foreach($p in $roots){$null=$ids.Add([int]$p.ProcessId)};do{$changed=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId)-and $ids.Add([int]$p.ProcessId)){$changed=$true}}}while($changed);$selected=@($all | Where-Object {$ids.Contains([int]$_.ProcessId)})`;
  assert.ok(mainPid === undefined || (Number.isInteger(mainPid) && mainPid > 0));
  const ancestry = mainPid === undefined ? '$ancestors=@()' : `$ancestors=@();if($roots.Count -eq 1){$current=$roots[0];$seen=New-Object 'System.Collections.Generic.HashSet[int]';$null=$seen.Add([int]$current.ProcessId);for($index=0;$index -lt 32;$index++){$parent=@($all|Where-Object {$_.ProcessId -eq $current.ParentProcessId});if($parent.Count -ne 1 -or -not $seen.Add([int]$parent[0].ProcessId)){break};$current=$parent[0];$ancestors+=,$current;if($current.ProcessId -eq ${mainPid}){break}}}`;
  const command = `$ErrorActionPreference='Stop';$all=@(Get-CimInstance Win32_Process);${selector};${ancestry};function Project($item,$isRoot){$owner=Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid;@{id=[int]$item.ProcessId;parentId=[int]$item.ParentProcessId;name=$item.Name;execPath=$item.ExecutablePath;created=([datetime]$item.CreationDate).ToUniversalTime().ToString('o');sid=$owner.Sid;sessionId=[int]$item.SessionId;ownerQueryStatus=[int]$owner.ReturnValue;root=$isRoot;commandLine=$item.CommandLine}};$result=@{sampledAt=[datetime]::UtcNow.ToString('o');processes=@($selected|ForEach-Object {Project $_ ($_.Name -in @('powershell.exe','pwsh.exe') -and $_.CommandLine -like '*${marker}*')});ancestry=@($ancestors|ForEach-Object {Project $_ $false})};ConvertTo-Json -InputObject $result -Depth 5 -Compress`;
  const { stdout } = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim()) as { processes: WaitProcess[]; ancestry: WaitProcess[]; sampledAt: string };
  if (identities) result.processes = result.processes.filter(p => identities.some(old => old.id === p.id && Date.parse(old.created) === Date.parse(p.created))); return result;
}
async function nativeWaits(marker: string, identities?: WaitProcess[]) { return (await nativeWaitSample(marker, identities)).processes; }
async function run(args: string[]) {
  assert.equal(process.platform, 'win32');
  assert.equal(args.length, 2, 'run requires absolutePlanPath externallyReviewedPlanSHA'); const [planPath, planSha] = args; assert.match(planSha, SHA);
  assert.ok(path.isAbsolute(planPath) && inside(path.join(ROOT, CONTROLS_OUTPUT, 'runs'), planPath));
  const raw = await readStable(planPath); assert.equal(sha(raw), planSha); const plan = JSON.parse(raw.toString()) as Plan; assertPlan(plan);
  const output = path.join(ROOT, CONTROLS_OUTPUT, 'runs', plan.id); assert.equal(planPath, path.join(output, 'plan.json'));
  await plainPath(path.join(output, 'held.json')); await assert.rejects(readFile(path.join(output, 'held.json')), (error: any) => error.code === 'ENOENT');
  const admission = await verifyPlan(plan); await readPersistedQuiet();
  assert.equal(path.resolve(process.execPath).toLowerCase(), path.resolve(admission.harness.node.path).toLowerCase()); assertSnapshotNodeVersion(process.versions.node);
  const gate = new ControlsGate(planSha), workspace = path.join(output, 'workspace'), missingWorkspace = path.join(output, 'missing-workspace');
  const emptyPath = path.join(output, 'empty-path'), verifier = path.join(output, 'refusal-verifier.mjs'), missingVerifier = path.join(output, 'missing-verifier.mjs');
  const source = 'export function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }\n';
  const verifierSource = 'throw new Error("QA refusal verifier must never execute");\n';
  await mkdir(workspace); await mkdir(missingWorkspace); await mkdir(emptyPath);
  await writeFile(path.join(workspace, 'numbers.mjs'), source, { flag: 'wx' }); await writeFile(path.join(missingWorkspace, 'numbers.mjs'), source, { flag: 'wx' });
  await writeFile(verifier, verifierSource, { flag: 'wx' }); await writeFile(missingVerifier, verifierSource, { flag: 'wx' });
  let lifecycle: SnapshotInstalledLifecycle | undefined, app: ElectronApplication | undefined, page: Page | undefined;
  let currentTask: string | undefined, projectId: string | undefined, stopId: string | undefined, refusalId: string | undefined, missingTask: string | undefined;
  let approval: Approval | undefined, expected: Session[] = [], firstMain: any, marker = `qa-controls-wait-snapshot-${Date.now()}`;
  const requestKey = `${plan.id}-mcp-refusal`, owned: string[] = [], errors: string[] = []; let observerSession: string | undefined;
  let failed = false, checkpoint: ControlsCheckpoint = 'none';
  const parentPath = process.env.PATH;
  const live = () => assert.equal(failed, false, 'CONTROLS_HELD_NO_NEXT_ACTION');
  async function effect<T>(action: () => Promise<T>) { live(); const result = await action(); live(); return result; }
  async function invoke<T = any>(method: string, args: unknown[], more: { expectedRejection?: boolean; projectRoot?: string } = {}): Promise<T> {
    await effect(() => app!.evaluate(armControlsBoundary, [{ method, args, ...more }]));
    return effect(() => page!.evaluate(({ method, args }) => (window.forgeDesk as any)[method](...args), { method, args }));
  }
  async function boundary() {
    const value = await effect(() => app!.evaluate(readControlsBoundary)); assert.equal(value.forbiddenCount, 0); assert.equal(value.nativePromptCount, 0); assert.equal(value.remainingArms, 0);
    assert.ok(value.calls.every((c: any) => c.argumentsValid && (c.phase === 'fulfilled' || (c.phase === 'rejected' && c.expectedRejection)))); return value;
  }
  async function snapshot() { assert.ok(page); const state: AppSnapshot = await effect(() => page!.evaluate(() => window.forgeDesk.snapshot()));
    checkpoint = 'snapshot-contract'; assertControlsSnapshot(state, dataDir, installed);
    assertHistorical(state, admission.host, undefined, id => { checkpoint = id; }); checkpoint = 'no-work'; assertNoWork(state, currentTask, Boolean(currentTask)); return state; }
  function own(state: AppSnapshot, id: string) { const session = state.sessions.find(s => s.id === id); assert.ok(session); return session; }
  async function waitFor(test: (state: AppSnapshot) => boolean, timeout = 120000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const state = await snapshot(); if (test(state)) return state; await pause(250); }
    throw new Error('Control observation timed out; action was not retried');
  }
  async function launch(missing = false) {
    live(); await effect(() => readPersistedQuiet()); lifecycle ??= await prepareSnapshotInstalledLifecycle(ROOT, installed); await lifecycle.beforeLaunch(); live();
    const { _electron: electron } = await import('playwright');
    app = await electron.launch({ executablePath: installed, args: [], cwd: missing ? emptyPath : ROOT, timeout: 30000,
      env: missing ? missingToolsAppEnvironment(launchEnvironment(process.env, dataDir), emptyPath, dataDir) : launchEnvironment(process.env, dataDir) });
    const launch = await lifecycle.attach(app); if (failed) { lifecycle.protectOnFailure(); live(); }
    await effect(() => app!.evaluate(installControlsBoundary, admission.release.electronVersion));
    page = await app.firstWindow(); page.on('pageerror', () => errors.push('CONTROLS_RENDERER_PAGE_ERROR'));
    await page.locator('.app-header').waitFor(); await page.setViewportSize({ width: 1380, height: 900 });
    if (missing) assert.equal(await app.evaluate(() => process.env.PATH), emptyPath);
    return launch;
  }
  async function newSession(title: string) {
    assert.ok(page && projectId); const value = await invoke<Session>('createSession', [projectId, title]);
    owned.push(value.id); await effect(() => page!.getByRole('button', { name: new RegExp(title) }).click()); return value;
  }
  async function close() { assert.ok(lifecycle && app); await boundary(); const result = await effect(() => lifecycle!.closeNormally()); app = undefined; page = undefined; return result; }
  async function phaseAction(phase: ControlPhase): Promise<any> {
    await effect(() => verifyPlan(plan));
    if (phase === 'launch') { const value = await launch(); firstMain = value.nativeMain; return { launch: value }; }
    if (phase === 'connect') {
      const before = await snapshot(); assertNoWork(before); assert.equal(before.engine.state, 'ready', 'Explicit connection requires a naturally ready idle engine');
      await invoke('connect', []); const after = await snapshot(); assertNoWork(after); assert.equal(after.engine.state, 'ready'); assert.equal(after.account.loggedIn, true);
      assert.ok(after.models.some(m => m.id === 'gpt-6.1-sol')); return { explicitlyRootArmed: true, originalConnectCalls: 1, automaticConnectOrRetry: false };
    }
    if (phase === 'ready') {
      const state = await waitFor(s => ['ready', 'failed'].includes(s.engine.state));
      assert.equal(state.engine.state, 'ready'); assert.equal(state.account.loggedIn, true); assert.ok(state.models.some(m => m.id === 'gpt-6.1-sol'));
      await app!.evaluate(({ dialog }, folder) => { const original = dialog.showOpenDialog; dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [folder] }; }; }, workspace);
      const project = await invoke('importProject', [], { projectRoot: workspace }); assert.ok(project); projectId = project.id;
      return { readinessObservedInThisPhase: true, autoConnectOrRetry: false, model: 'gpt-6.1-sol', hardwareEnabled: false, filePickerCoverage: 'Controlled exact QA path selector; not native file-picker acceptance' };
    }
    if (phase === 'stop') {
      assertNoWork(await snapshot()); const stopped = await newSession(`QA stop ${plan.id}`); stopId = stopped.id; currentTask = stopped.taskId;
      const prompt = `This is a harmless stop test. Use the built-in shell exactly ONCE to execute exactly: Write-Output '${marker}'; Start-Sleep -Seconds 45. Do not read or change any files, do not read product/authentication directories, do not request extra permissions, and do not retry after interruption. Begin this command now.`;
      await effect(() => app!.evaluate(armControlsBoundary, [{ method: 'send', args: [stopId, prompt, 'gpt-6.1-sol'] }, { method: 'interrupt', args: [stopId] }]));
      await effect(() => app!.evaluate(installControlsStopObserver, { sessionId: stopId! })); observerSession = stopId;
      await effect(() => page!.evaluate(({ id, prompt }) => window.forgeDesk.send(id, prompt, 'gpt-6.1-sol'), { id: stopId!, prompt }));
      const running = await waitFor(s => s.approvals.length > 0 || own(s, stopId!).messages.some(m => m.role === 'tool' && m.text.includes(marker) && ['running', 'inProgress'].includes(m.status ?? '')) || ['completed', 'failed', 'interrupted', 'needs_attention'].includes(own(s, stopId!).status), 90000);
      assert.equal(running.approvals.length, 0); assert.equal(own(running, stopId).status, 'running');
      const currentMain = lifecycle!.evidence.launches.at(-1)!.nativeMain!;
      const sample = await effect(() => nativeWaitSample(marker, undefined, currentMain.id)), before = sample.processes, identity = lifecycle!.evidence.initialDesktopIdentity!;
      const proof = { main: currentMain, ancestry: sample.ancestry, installed, sampledAt: sample.sampledAt };
      const native = assertOwnedWaitProcess(before, marker, identity.sid, identity.sessionId, proof); assertWaitCommand(native.commandLine!, marker);
      assert.ok(Date.now() - Date.parse(native.created) < 30000); const clickedAt = new Date().toISOString(), deadline = stopObservationDeadline(native.created);
      assertStopObservationTiming(native.created, clickedAt, clickedAt);
      await effect(() => page!.getByRole('button', { name: '停止当前回合', exact: true }).click({ timeout: Math.max(1, deadline - Date.now()) }));
      let observedAt: string;
      while (true) {
        const survivors = await effect(() => nativeWaits(marker, before)), after = await effect(() => nativeWaits(marker)); observedAt = new Date().toISOString(); assertStopObservationTiming(native.created, clickedAt, observedAt);
        if (!survivors.length && !after.length) break; await pause(100);
      }
      let receipt = await app!.evaluate(readControlsStopObserver, { sessionId: stopId }); const until = Date.now() + 60000;
      while (receipt.calls.some(c => c.phase === 'started') && Date.now() < until) { await pause(100); receipt = await app!.evaluate(readControlsStopObserver, { sessionId: stopId }); }
      assertControlsStopReceipt(receipt); await waitFor(s => own(s, stopId!).status === 'interrupted' && !own(s, stopId!).turnId && s.engine.state === 'ready', 60000);
      const finalStop = own(await snapshot(), stopId), toolItems = finalStop.messages.filter(m => m.role === 'tool');
      assert.equal(toolItems.length, 1, 'Only the one harmless QA waiting tool item is accepted'); assert.ok(toolItems[0].text.includes(marker));
      const restoration = await effect(() => app!.evaluate(restoreControlsStopObserver, { sessionId: stopId! })); observerSession = undefined; currentTask = undefined;
      return { prompt, before, ownershipProof: proof, clickedAt, nativeAbsenceObservedAt: observedAt, receipt, restoration, toolItemCount: toolItems.length, manuallyKilled: false };
    }
    if (phase === 'mcp-request') {
      assertNoWork(await snapshot()); const refused = await newSession(`QA refusal ${plan.id}`); refusalId = refused.id; currentTask = refused.taskId;
      await invoke('setAcceptance', [refused.taskId, [{ id: 'qa-controls-verifier', title: 'QA refusal only', kind: 'automated', command: { executable: admission.harness.node.path, args: [verifier], timeoutMs: 10000 }, verifierFiles: [verifier] }]]);
      const prompt = `This is a single MCP refusal test. Do not change any file, do not read product/authentication directories, do not execute shell commands. Make exactly ONE engineering.test call with taskId=${refused.taskId}, verifierId=qa-controls-verifier and requestKey=${requestKey}. Wait for the client decision. The client will decline; report refusal and end without retry, alternate tools, or permission requests.`;
      await invoke('send', [refusalId, prompt, 'gpt-6.1-sol']);
      const pending = await waitFor(s => s.approvals.length > 0 || ['completed', 'failed', 'interrupted', 'needs_attention'].includes(own(s, refusalId!).status));
      approval = assertFreshRefusal(pending, refusalId, requestKey).approval; return { prompt, approval };
    }
    if (phase === 'reload') {
      assert.ok(approval && refusalId); assertFreshRefusal(await snapshot(), refusalId, requestKey, approval);
      await effect(() => page!.reload()); await page!.locator('.app-header').waitFor(); const fresh = assertFreshRefusal(await snapshot(), refusalId, requestKey, approval);
      assert.equal(await page!.locator('.approval').count(), 1); return { approval: fresh.approval, preservedAfterRendererReload: true };
    }
    if (phase === 'refuse') {
      assert.ok(approval && refusalId); assertFreshRefusal(await snapshot(), refusalId, requestKey, approval);
      const card = page!.locator('.approval'); assert.equal(await card.count(), 1);
      await effect(() => app!.evaluate(armControlsBoundary, [{ method: 'approve', args: [approval!.generation, approval!.id, 'decline'] }]));
      await effect(() => card.getByRole('button', { name: '拒绝', exact: true }).click());
      const final = await waitFor(s => ['completed', 'failed', 'interrupted', 'needs_attention'].includes(own(s, refusalId!).status));
      const item = assertRefusalComplete(final, refusalId, requestKey); assert.equal(await readFile(path.join(workspace, 'numbers.mjs'), 'utf8'), source);
      assert.equal(await readFile(verifier, 'utf8'), verifierSource); currentTask = undefined; return { actualRefusedToolItem: item, runnerOperations: 0, sourceUnchanged: true };
    }
    if (phase === 'diagnostics') {
      assertNoWork(await snapshot()); const logMarker = `qa-diagnostic-${plan.id}`, synthetic = `synthetic-only-${plan.id}`;
      await app!.evaluate(({ dialog }, filename) => { const original = dialog.showOpenDialog; dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [filename] }; }; }, path.join(workspace, `${logMarker}-password=${synthetic}`));
      await assert.rejects(invoke('importProject', [], { expectedRejection: true })); live();
      await app!.evaluate(({ dialog }) => { const original = dialog.showSaveDialog; dialog.showSaveDialog = async () => { dialog.showSaveDialog = original; return { canceled: true, filePath: '' }; }; });
      assert.equal(await invoke('exportDiagnostics', []), null);
      const filename = path.join(output, 'diagnostics.json'); await plainPath(filename);
      await app!.evaluate(({ dialog }, filename) => { const original = dialog.showSaveDialog; dialog.showSaveDialog = async () => { dialog.showSaveDialog = original; return { canceled: false, filePath: filename }; }; }, filename);
      assert.equal(await invoke('exportDiagnostics', []), filename);
      const bytes = await readStable(filename); const value = JSON.parse(bytes.toString()); assertReleaseDiagnostics(value, logMarker, synthetic);
      return { diagnosticSha256: sha(bytes), exactSyntheticLogRedacted: true, cancelledReturnedNull: true, authenticationRead: false };
    }
    if (phase === 'close-a') { const before = await snapshot(); assertNoWork(before); expected = owned.map(id => own(before, id)); return { close: await close(), savedSessions: expected.map(s => s.id) }; }
    if (phase === 'restart') { const value = await launch(); assert.ok(value.nativeMain); assert.ok(value.nativeMain.id !== firstMain.id || value.nativeMain.created !== firstMain.created); return { launch: value }; }
    if (phase === 'restart-verify') { const state = await snapshot(); assertNoWork(state); assertRestartSessions(state, expected); assert.deepEqual(await nativeWaits(marker), []); return { exactSessionsPreserved: true, noRunnerReplay: true, noWaitProcess: true }; }
    if (phase === 'close-b') { assertNoWork(await snapshot()); return { close: await close() }; }
    if (phase === 'missing-launch') { assert.deepEqual(await readdir(emptyPath), []); return { launch: await launch(true), childPathOnly: true, modelTurnInvoked: false }; }
    if (phase === 'missing-tools') {
      assertNoWork(await snapshot());
      await app!.evaluate(({ dialog }, folder) => { const original = dialog.showOpenDialog; dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [folder] }; }; }, missingWorkspace);
      const project = await invoke('importProject', [], { projectRoot: missingWorkspace }); assert.ok(project);
      const session = await invoke<Session>('createSession', [project.id, 'QA missing tools']); missingTask = session.taskId;
      const git = await page!.evaluate(async id => { try { await window.forgeDesk.diff(id); return { rejected: false, error: '' }; } catch (e) { return { rejected: true, error: e instanceof Error ? e.message : String(e) }; } }, project.id); assertMissingGitResult(git);
      await invoke('setAcceptance', [missingTask, [{ id: 'missing-tools-baseline', title: 'QA baseline retained', kind: 'manual' }]]);
      const before = (await snapshot()).tasks.find(t => t.id === missingTask)!;
      let node: { rejected: boolean; error: string };
      try { await invoke('setAcceptance', [missingTask, [{ id: 'missing-node', title: 'QA missing Node', kind: 'automated', command: { executable: 'node', args: [missingVerifier] }, verifierFiles: [missingVerifier] }]], { expectedRejection: true }); node = { rejected: false, error: '' }; }
      catch (error) { live(); node = { rejected: true, error: error instanceof Error ? error.message : String(error) }; }
      assertMissingNodeResult(node);
      const final = await snapshot(), after = final.tasks.find(t => t.id === missingTask)!; assertAcceptanceUnchanged(before as any, after as any); assert.equal(after.operations.length, 0); assert.equal(after.evidence.length, 0);
      const ownSession = own(final, session.id); assert.ok(!ownSession.threadId && !ownSession.turnId); assert.equal(ownSession.messages.length, 0);
      assert.equal(await readFile(path.join(missingWorkspace, 'numbers.mjs'), 'utf8'), source); assert.equal(await readFile(missingVerifier, 'utf8'), verifierSource);
      assert.deepEqual(await readdir(missingWorkspace), ['numbers.mjs']); assert.deepEqual(await readdir(emptyPath), []); assert.equal(process.env.PATH, parentPath);
      return { git, node, acceptanceUnchanged: true, verifierExecuted: false, modelTurnInvoked: false, parentPathUnchanged: true, limitation: 'Child-process PATH injection only; not evidence tools are uninstalled or absolute executables unavailable' };
    }
    assert.equal(phase, 'missing-close'); assertNoWork(await snapshot()); assert.deepEqual(errors, []); return { close: await close(), pageErrors: errors };
  }
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity }); let finished!: () => void;
  const completion = new Promise<void>(resolve => { finished = resolve; }); let held: Promise<void> | undefined, keepAlive: ReturnType<typeof setInterval> | undefined;
  const hold = (error: unknown): Promise<void> => {
    if (held) return held;
    failed = true; gate.fail(); process.exitCode = 1; const protection = lifecycle?.protectOnFailure();
    if (protection?.safeHarnessExit === false) keepAlive ??= setInterval(() => {}, 60000);
    held = (async () => {
      try {
        await writeNew(path.join(output, 'held.json'), { schemaVersion: 1, scope: 'release-1-controls-held-v1', id: plan.id, planSha256: planSha, candidateSha256: plan.candidateSha256,
          next: gate.next ?? null, predecessorSha256: gate.predecessor, failure: sanitizeControlsFailure(error, checkpoint), observerSession: observerSession ?? null,
          lifecycle: lifecycle?.evidence ?? null, protection: protection ?? null, automaticInterruptOrDecisionAttempted: false, finishedAt: new Date().toISOString() });
      } catch { console.error('CONTROLS_HELD_EVIDENCE_UNAVAILABLE'); }
      console.error('CONTROLS_HELD: original pending work is preserved; no automatic cancel, decision, retry or close.'); finished();
    })(); return held;
  };
  const abort = () => { void hold(new Error('CONTROLS_ROOT_INPUT_OR_SIGNAL')); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort); process.stdout.on('error', abort); process.stderr.on('error', abort);
  input.on('line', line => {
    let phase: ControlPhase; try { phase = gate.arm(line); } catch (error) { void hold(error); return; }
    const prior = gate.predecessor, startedAt = new Date().toISOString();
    void (async () => {
      await effect(() => writeNew(path.join(output, `${phase}.pending.json`), { schemaVersion: 1, scope: 'release-1-controls-pending-v1', id: plan.id, planSha256: planSha, candidateSha256: plan.candidateSha256, phase, predecessorSha256: prior, startedAt }));
      const facts = await phaseAction(phase); live(); assert.deepEqual(errors, []); const ipc = app ? await boundary() : null;
      await effect(() => verifyPlan(plan));
      const pin = await effect(() => writeNew(path.join(output, `${phase}.json`), { schemaVersion: 1, scope: 'release-1-controls-phase-v1', version: '1.0.0', id: plan.id,
        planSha256: planSha, candidateSha256: plan.candidateSha256, phase, predecessorSha256: prior, result: 'passed', startedAt, finishedAt: new Date().toISOString(), facts, ipc, noAutomaticNextPhase: true }));
      gate.complete(phase, pin); console.log(JSON.stringify({ phase, recordSha256: pin, next: gate.next ?? null, completed: gate.done, noAutomaticNextPhase: true }));
      if (gate.done) { input.close(); finished(); }
    })().catch(error => hold(error));
  });
  input.on('close', () => { if (!gate.done) abort(); });
  console.log(JSON.stringify({ next: gate.next, predecessorSha256: gate.predecessor, optionalConnectBeforeReady: 'At most one separately root-armed connect phase; no automatic attempt', noAutomaticNextPhase: true })); await completion;
  if (!failed) { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); process.stdout.removeListener('error', abort); process.stderr.removeListener('error', abort); }
  input.close();
}
export async function main(argv = process.argv.slice(2), bootstrapVerified = false) {
  for (const [key, value] of Object.entries(process.env)) if (value && (/^FORGEDESK_/i.test(key) || /^(?:CODEX_HOME|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|__COMPAT_LAYER)$/i.test(key))) assert.fail(`Remove ambient ${key}`);
  const [mode, ...args] = argv; if (mode === 'prepare') await prepare(args); else {
    assert.equal(mode, 'run'); assert.equal(bootstrapVerified, true, 'Native run requires the independently pinned builtin bootstrap before tsx or bare-package execution'); await run(args);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
