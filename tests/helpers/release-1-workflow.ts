import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, unlink, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import type { ElectronApplication, Page } from 'playwright';
import type { EngineeringTask } from '../../packages/engineering-runner';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import { prepareSnapshotInstalledLifecycle, type SnapshotInstalledLifecycle } from './snapshot-installed-lifecycle';
import { launchEnvironment as fz3bHostFinalLaunchEnvironment } from './release-1-policy';
import { inside, samePath, plainPath } from './embedded-installed';
import { ROOT, NODE, GIT, MODEL, assertHistorical, assertNoWork, assertApproval, assertModelBuilds, assertClose, readPersistedQuiet, readStable, sha, type Plan, type Phase } from './release-1-policy';
import { BUGGY, assertProfile, filesIn, workspacePins, verifySnapshot, verifyPassed, verifyExport } from './release-1-snapshot-checks';
import { installObserver, readObserver, armObserver, registerApproval, type Scope } from './release-1-observer';

export const STAGES = ['idle', 'phase-precheck', 'phase-postcheck', 'phase-receipt', 'launch', 'restart', 'restart-leave', 'restart-ready', 'ready', 'leave-mode', 'fixture', 'setup-project-picker', 'setup-create-session', 'setup-node-picker', 'setup-profile-wait', 'setup-renderer-quiet', 'model-send', 'model-build-wait', 'verify-snapshots', 'export-picker', 'export-verify', 'dedup', 'fresh-build', 'source-drift', 'artifact-drift', 'refresh', 'normal-close', 'unknown'] as const;
export type Stage = typeof STAGES[number];
export type FailureReason = 'WAIT_TIMEOUT' | 'ORIGINAL_IPC_PENDING' | 'PLAYWRIGHT_ACTION_TIMEOUT' | 'PRODUCT_REJECTED' | 'ASSERTION' | 'ROOT_INPUT_OR_SIGNAL' | 'OTHER';
export const CHECKPOINTS = ['none', 'launch-initial-state', 'launch-persisted-quiet', 'launch-lifecycle-prepare', 'launch-lifecycle-before', 'launch-playwright-import', 'launch-application', 'launch-native-attach', 'launch-first-window', 'launch-sidebar', 'launch-observer-install', 'launch-native-creation', 'launch-prior-creation', 'restart-prior-creation', 'history-primary-identity', 'history-primary-immutable', 'history-primary-owner', 'history-primary-release', 'history-extra-inspect', 'history-hardware', 'history-no-work', 'host-observer-read', 'host-observer-purpose', 'host-observer-receipt', 'host-mode-type', 'host-controlled-engine-stopped'] as const;
export type Checkpoint = typeof CHECKPOINTS[number];
export function sanitizeFailure(error: unknown, stage: unknown, checkpoint: unknown = 'none'): { stage: Stage; reason: FailureReason; checkpoint: Checkpoint } {
  let reason: FailureReason = 'OTHER';
  try {
    if (error instanceof Error) {
      if (error.message === 'SOFTWARE_ORIGINAL_WAIT_TIMEOUT') reason = 'WAIT_TIMEOUT';
      else if (error.message === 'SOFTWARE_ORIGINAL_IPC_PENDING') reason = 'ORIGINAL_IPC_PENDING';
      else if (error.message === 'SOFTWARE_PRODUCT_IPC_REJECTED') reason = 'PRODUCT_REJECTED';
      else if (error.message === 'SOFTWARE_ROOT_INPUT_OR_SIGNAL') reason = 'ROOT_INPUT_OR_SIGNAL';
      else if (error.name === 'TimeoutError') reason = 'PLAYWRIGHT_ACTION_TIMEOUT';
      else if ((error as NodeJS.ErrnoException).code === 'ERR_ASSERTION') reason = 'ASSERTION';
    }
  } catch { reason = 'OTHER'; }
  return { stage: STAGES.includes(stage as Stage) ? stage as Stage : 'unknown', reason, checkpoint: CHECKPOINTS.includes(checkpoint as Checkpoint) ? checkpoint as Checkpoint : 'none' };
}
export function assertObserver(v: any, counts?: Record<string, number>) {
  assert.equal(v.forbiddenCount, 0); assert.equal(v.unexpectedNativePrompt, false);
  for (const c of v.calls) { assert.equal(c.argumentsValid, true); assert.equal(c.phase, 'fulfilled'); assert.equal(c.resultValid, true); assert.equal(c.error, undefined); assert.ok(c.finishedAt >= c.startedAt); }
  if (counts) { assert.equal(v.calls.length, Object.values(counts).reduce((a, b) => a + b, 0)); for (const [method, count] of Object.entries(counts)) assert.equal(v.calls.filter((c: any) => c.method === method).length, count); }
  for (const p of v.pickers) { assert.equal(p.cancelled, false); assert.equal(p.qualified, true); }
}
async function gitCommand(args: string[], env: NodeJS.ProcessEnv) {
  const started = performance.now(), child = spawn(GIT, args, { env, windowsHide: true, shell: false, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('SOFTWARE_GIT_CLOSE_PENDING_NO_KILL')), Math.max(0, 15000 - (performance.now() - started)));
    child.once('error', () => { clearTimeout(timer); reject(Error('SOFTWARE_GIT_START_FAILED')); });
    child.once('close', (code, signal) => { clearTimeout(timer); if (performance.now() - started >= 15000 || code !== 0 || signal !== null) reject(Error('SOFTWARE_GIT_CLOSE_NOT_ACCEPTED')); else resolve(); });
  });
}
export class SoftwareFlow {
  private stopped = false;
  private launching = false;
  stage: Stage = 'idle';
  private checkpoint: Checkpoint = 'none';
  private latestObserver?: ReturnType<typeof readObserver>;
  private observerSampledAt?: number;
  app?: ElectronApplication; page?: Page; lifecycle?: SnapshotInstalledLifecycle;
  before?: Fz3bRunView; taskId?: string; projectId?: string; firstCreation?: string; operationIds?: string[]; retryKey?: string;
  readonly workspace: string; readonly exports: string; readonly sentinel: string;
  constructor(readonly plan: Plan, readonly directory: string) { this.workspace = path.join(directory, 'fixture/workspace'); this.exports = path.join(directory, 'exports'); this.sentinel = `qa-input-not-exported-${plan.acceptanceId}`; }
  assertLive() { assert.equal(this.stopped, false, 'SOFTWARE_FLOW_HELD'); }
  stop() { this.stopped = true; }
  failure(error: unknown) {
    const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const boolean = (value: unknown) => typeof value === 'boolean' ? value : null;
    return { ...sanitizeFailure(error, this.stage, this.checkpoint), pickerObservationAt: time(this.observerSampledAt), pickers: (this.latestObserver?.pickers ?? []).slice(0, 16).map((p: any) => ({ purpose: ['setup', 'export'].includes(p.purpose) ? p.purpose : 'unexpected', phase: ['started', 'fulfilled', 'rejected'].includes(p.phase) ? p.phase : 'unknown', startedAt: time(p.startedAt), finishedAt: time(p.finishedAt), cancelled: boolean(p.cancelled), qualified: boolean(p.qualified) })) };
  }
  async observe() { const value = await this.app!.evaluate(readObserver); this.latestObserver = value; this.observerSampledAt = Date.now(); return value; }
  async effect<T>(action: () => Promise<T>): Promise<T> { this.assertLive(); const value = await action(); this.assertLive(); return value; }
  snapshot() { this.assertLive(); assert.ok(this.page); return this.effect(() => this.page!.evaluate(() => window.forgeDesk.snapshot())); }
  async historical(allowCurrent = false) { const state = await this.snapshot(); const run = assertHistorical(state, this.plan.host, this.before, id => { this.checkpoint = id; }); this.checkpoint = 'history-no-work'; assertNoWork(state, this.taskId, allowCurrent); return { state, run }; }
  async rendererSnapshotQuiet() { await this.effect(() => this.page!.waitForFunction(() => { const button = document.querySelector('.snapshot-section .snapshot-command'); return button instanceof HTMLButtonElement && !button.disabled && document.querySelectorAll('.approvals .approval').length === 0; }, undefined, { timeout: 30000 })); }
  async quiet() { const v = await this.historical(); const observation = await this.observe(); assertObserver(observation); if (this.taskId) await this.rendererSnapshotQuiet(); return { state: v.state, public: { version: v.state.version, history: this.plan.host.history, engines: { ordinary: v.state.engine.state, hardware: v.state.hardwareAgent!.engineState, fz3b: v.state.fz3bAgent!.engineState }, approvalCount: v.state.approvals.length, sessionCount: v.state.sessions.length, softwareOperationCount: v.state.tasks.reduce((sum, t) => sum + t.operations.length, 0), controlledModeActive: v.state.hardware.modeActive, ipc: observation, rendererSnapshotQuiet: this.taskId ? true : null } }; }
  async hostQuietReadonly() {
    const v = await this.historical(); this.checkpoint = 'host-observer-read'; const observation = await this.observe();
    this.checkpoint = 'host-observer-purpose'; assert.equal(observation.purpose, 'readonly'); this.checkpoint = 'host-observer-receipt'; assertObserver(observation, {});
    this.checkpoint = 'host-mode-type'; assert.equal(typeof v.state.hardware.modeActive, 'boolean');
    if (v.state.hardware.modeActive) { this.checkpoint = 'host-controlled-engine-stopped'; assert.equal(v.state.engine.state, 'stopped'); }
    return { state: v.state, public: { scope: 'release-1-restart-host-quiet-observation-v1', version: v.state.version, history: this.plan.host.history, engines: { ordinary: v.state.engine.state, hardware: v.state.hardwareAgent!.engineState, fz3b: v.state.fz3bAgent!.engineState }, approvalCount: v.state.approvals.length, sessionCount: v.state.sessions.length, softwareOperationCount: v.state.tasks.reduce((sum, t) => sum + t.operations.length, 0), controlledModeActive: v.state.hardware.modeActive, ipc: observation, softwareReadyClaimed: false } };
  }
  assertRestartTask(state: Awaited<ReturnType<SoftwareFlow['snapshot']>>) { const task = this.task(state); assert.notEqual(task.status, 'passed'); assert.equal(task.acceptance[0].status, 'stale'); assert.equal(task.evidence.at(-1)?.snapshot?.verificationResult, 'passed'); assert.deepEqual(task.operations.map(o => o.id), this.operationIds); }
  async restartObservation() { const value = await this.hostQuietReadonly(); this.assertRestartTask(value.state); return value; }
  task(state: Awaited<ReturnType<SoftwareFlow['snapshot']>>) { const t = state.tasks.find(t => t.id === this.taskId); assert.ok(t); return t as unknown as EngineeringTask; }
  scope(purpose: Scope['purpose'], more: Partial<Scope> = {}): Scope { return { purpose, workspace: this.workspace, node: NODE, exports: this.exports, taskId: this.taskId, projectId: this.projectId, ...more }; }
  async arm(purpose: Scope['purpose'], more: Partial<Scope> = {}) { this.assertLive(); assert.ok(this.app); const old = await this.observe(); assertObserver(old); await this.effect(() => this.app!.evaluate(armObserver, this.scope(purpose, more))); }
  async receipt(counts: Record<string, number>) { const v = await this.observe(); assertObserver(v, counts); return v; }
  async wait(predicate: (s: Awaited<ReturnType<SoftwareFlow['snapshot']>>) => boolean, allowCurrent = false, modelApprovals?: any[]) {
    const started = performance.now(), known = new Set<string>();
    while (performance.now() - started < 300000) {
      const { state } = await this.historical(allowCurrent), observation = await this.observe(); assert.equal(observation.forbiddenCount, 0); assert.equal(observation.unexpectedNativePrompt, false);
      if (observation.calls.some((c: any) => c.phase === 'rejected')) throw Error('SOFTWARE_PRODUCT_IPC_REJECTED');
      assert.ok(observation.calls.every((c: any) => c.argumentsValid && c.phase !== 'rejected'));
      if (state.approvals.length) {
        assert.ok(modelApprovals); const a = assertApproval(state, this.task(state)), key = `${a.generation}:${typeof a.id}:${a.id}`;
        if (!known.has(key)) { assert.ok(modelApprovals.length < 2); known.add(key); modelApprovals.push(a); await this.effect(() => this.app!.evaluate(registerApproval, a)); console.log(`ROOT_MATCHED_BUILD_APPROVAL_READY task=${a.taskId} requestKey=${a.requestKey}: manually inspect and click only the real renderer Allow Once card. No native answer is supplied.`); }
      }
      if (predicate(state) && observation.calls.every((c: any) => c.phase === 'fulfilled')) return state; await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error('SOFTWARE_ORIGINAL_WAIT_TIMEOUT');
  }
  async original<T>(action: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.assertLive();
    try { return await this.effect(() => Promise.race([action(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('SOFTWARE_ORIGINAL_IPC_PENDING')), 300000); })])); }
    finally { if (timer) clearTimeout(timer); }
  }
  async launch(restart: boolean) {
    this.stage = restart ? 'restart' : 'launch';
    this.checkpoint = 'launch-initial-state'; this.assertLive(); assert.equal(this.app, undefined);
    this.checkpoint = 'launch-persisted-quiet'; await readPersistedQuiet();
    this.checkpoint = 'launch-lifecycle-prepare'; this.lifecycle = await prepareSnapshotInstalledLifecycle(ROOT, path.join(ROOT, 'install/ForgeDesk.exe'));
    this.checkpoint = 'launch-lifecycle-before'; await this.lifecycle.beforeLaunch();
    this.checkpoint = 'launch-playwright-import'; const { _electron } = await import('playwright'); this.assertLive(); this.launching = true;
    let identity: Awaited<ReturnType<SnapshotInstalledLifecycle['attach']>>;
    try {
      this.checkpoint = 'launch-application'; this.app = await _electron.launch({ executablePath: path.join(ROOT, 'install/ForgeDesk.exe'), args: [], cwd: ROOT, env: fz3bHostFinalLaunchEnvironment(process.env, path.join(ROOT, '.runtime/app')), timeout: 60000 });
      // Even a late launch must cache its actual identity before no-kill protection.
      this.checkpoint = 'launch-native-attach'; identity = await this.lifecycle.attach(this.app);
    } finally { this.launching = false; if (this.stopped) this.lifecycle.protectOnFailure(); }
    this.checkpoint = 'launch-first-window'; this.assertLive(); this.page = await this.app.firstWindow();
    this.checkpoint = 'launch-sidebar'; await this.page.locator('.sidebar').waitFor({ state: 'visible', timeout: 30000 });
    this.checkpoint = 'launch-observer-install'; await this.effect(() => this.app!.evaluate(installObserver, this.plan.release.electronVersion));
    this.checkpoint = 'launch-native-creation'; assert.ok(identity.nativeMain?.created);
    this.checkpoint = 'launch-prior-creation'; assert.notEqual(identity.nativeMain.created, this.plan.host.lastNativeCreation);
    if (restart) { this.checkpoint = 'restart-prior-creation'; assert.notEqual(identity.nativeMain.created, this.firstCreation); } else this.firstCreation = identity.nativeMain.created;
    const initial = await this.historical(); if (!this.before) this.before = initial.run;
    const observation = restart ? await this.restartObservation() : await this.hostQuietReadonly();
    return { launch: identity, history: this.plan.host.history, controlledModeActive: observation.state.hardware.modeActive, observation: observation.public, coverage: 'After native attach/window/sidebar and before first snapshot; no pre-hook absence claim.' };
  }
  async ready(stage: 'ready' | 'restart-ready' = 'ready') {
    this.stage = stage;
    const { state } = await this.historical(); assert.equal(state.hardware.modeActive, false);
    const ready = await this.wait(s => ['ready', 'failed'].includes(s.engine.state)); assert.equal(ready.engine.state, 'ready', 'No auto connect/reconnect is allowed to normalize a failed/stopped engine'); assert.equal(ready.account.loggedIn, true); assert.ok(ready.models.some(m => m.id === MODEL));
    assert.ok(samePath(ready.engine.home, path.join(ROOT, '.runtime/app/engine'))); assert.ok(samePath(ready.engine.executable, path.join(ROOT, 'install/resources/codex/codex.exe'))); return this.quiet();
  }
  async leave() {
    this.stage = 'leave-mode';
    const before = await this.quiet(); assert.equal(before.state.hardware.modeActive, true); await this.arm('leave');
    await this.original(() => this.page!.evaluate(() => window.forgeDesk.fz3bLeaveMode())); const ipc = await this.receipt({ fz3bLeaveMode: 1 }); await this.arm('readonly'); const after = await this.ready(); return { before: before.public, ipc, after: after.public, explicitRootArmedMutation: true, grantRevocationAndConnectNotReadonly: true };
  }
  async restartLeave() {
    this.stage = 'restart-leave'; const before = await this.hostQuietReadonly(); assert.equal(before.state.hardware.modeActive, true); await this.arm('leave');
    await this.original(() => this.page!.evaluate(() => window.forgeDesk.fz3bLeaveMode())); const ipc = await this.receipt({ fz3bLeaveMode: 1 }); await this.arm('readonly'); const after = await this.hostQuietReadonly(); assert.equal(after.state.hardware.modeActive, false);
    return { before: before.public, ipc, after: after.public, explicitRootArmedMutation: true, grantRevocationAndConnectNotReadonly: true, readinessDeferredToRootArmedRestartReady: true };
  }
  async restartReady() { const value = await this.ready('restart-ready'); this.assertRestartTask(value.state); return value.public; }
  async fixture() {
    this.stage = 'fixture';
    await plainPath(this.directory); for (const directory of [path.join(this.directory, 'fixture'), this.workspace, path.join(this.workspace, '.cache'), path.join(this.workspace, 'empty'), path.join(this.workspace, 'empty/nested'), this.exports]) await this.effect(() => mkdir(directory));
    for (const [name, bytes] of [['numbers.mjs', BUGGY], ['.gitignore', 'ignored.bin\n.cache/\n'], ['ignored.bin', Buffer.from([0, 255, 1, 0])], ['.cache/necessary-input.txt', 'required ignored input\n'], ['package-lock.json', '{"lockfileVersion":3}\n'], ['local-settings.secret', this.sentinel]] as const) await this.effect(() => writeFile(path.join(this.workspace, name), bytes, { flag: 'wx' }));
    const env = { ...fz3bHostFinalLaunchEnvironment(process.env, path.join(ROOT, '.runtime/app')), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0' };
    for (const args of [['init', this.workspace], ['-C', this.workspace, 'add', 'numbers.mjs', '.gitignore'], ['-C', this.workspace, '-c', 'user.name=ForgeDesk QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'Release 1 snapshot defective baseline']]) await this.effect(() => gitCommand(args, env));
  }
  async snapshotRun() {
    await this.ready(); assert.equal(this.taskId, undefined); await this.fixture(); await this.arm('setup');
    this.stage = 'setup-project-picker';
    console.log(`ROOT_PROJECT_PICKER: choose only ${this.workspace}`);
    const project = await this.original(() => this.page!.evaluate(() => window.forgeDesk.importProject())); assert.ok(project && samePath(project.root, this.workspace)); this.projectId = project.id;
    await this.effect(() => this.page!.getByTitle(this.workspace, { exact: true }).and(this.page!.getByRole('button')).click());
    this.stage = 'setup-create-session'; const session = await this.original(() => this.page!.evaluate(id => window.forgeDesk.createSession(id, 'Release 1 software snapshot acceptance'), this.projectId!)); assert.ok(session && session.id === session.taskId); this.taskId = session.taskId;
    await this.effect(() => this.page!.getByRole('button', { name: /Release 1 software snapshot acceptance/ }).click()); await this.effect(() => this.page!.getByRole('tab', { name: '工程交付', exact: true }).click());
    console.log(`ROOT_NODE_PICKER: after Enable Snapshot opens its real picker, select only ${NODE}. Any real sandbox/setup consent must be inspected by root, never synthesized.`);
    this.stage = 'setup-node-picker';
    await this.effect(() => this.page!.getByRole('button', { name: '启用快照模板', exact: true }).click());
    this.stage = 'setup-profile-wait';
    const enabledState = await this.wait(s => !!this.task(s).snapshotProfile), enabled = this.task(enabledState); const profile = assertProfile(enabled); assert.equal((await this.snapshot()).approvals.length, 0);
    this.stage = 'setup-renderer-quiet';
    await this.rendererSnapshotQuiet();
    const setupIpc = await this.receipt({ importProject: 1, createSession: 1, enableSnapshot: 1 }); assert.equal(setupIpc.pickers.length, 2);
    const pins = await workspacePins(this.workspace);
    const prompt = `Fix average(values) in numbers.mjs: empty arrays return 0; preserve positive and signed means. Modify only numbers.mjs. Do not read product/authentication files, change any template/profile/acceptance, or access protected snapshots. Use exactly two engineering.build calls with taskId=${this.taskId}, profileRevision=${profile.revision}: first check the unchanged original defect with a unique requestKey, then repair numbers.mjs and call again with a NEW requestKey. Do not retry or add tools, use engineering.test, alter verifier data, or substitute manual success. The fixed template checks empty/nonempty/signed from separate B snapshots. End after the real result.`;
    await this.arm('model', { prompt, model: MODEL }); const approvalActions: any[] = []; this.stage = 'model-send';
    await this.original(() => this.page!.evaluate(v => window.forgeDesk.send(v.id, v.prompt, v.model), { id: this.taskId!, prompt, model: MODEL }));
    this.stage = 'model-build-wait';
    const terminal = await this.wait(s => ['completed', 'failed', 'interrupted', 'needs_attention'].includes(s.sessions.find(v => v.taskId === this.taskId)?.status ?? ''), true, approvalActions);
    const modelSession = terminal.sessions.find(s => s.taskId === this.taskId)!; assert.equal(modelSession.status, 'completed'); assert.notEqual(modelSession.engineUncertain, true); assertNoWork(terminal); await this.rendererSnapshotQuiet(); const passed = this.task(terminal); assertModelBuilds(passed, approvalActions, modelSession.messages);
    const modelIpc = await this.receipt({ send: 1, approve: 2 }); assert.equal(modelIpc.approvals.length, 2); assert.ok(modelIpc.approvals.every((a: { consumed: boolean }) => a.consumed));
    this.stage = 'verify-snapshots'; const after = await workspacePins(this.workspace); assert.deepEqual(after.map(p => p.path), pins.map(p => p.path)); for (const p of pins.filter(p => p.path !== 'numbers.mjs')) assert.equal(after.find(v => v.path === p.path)?.sha256, p.sha256); assert.notEqual((await readStable(path.join(this.workspace, 'numbers.mjs'))).toString(), BUGGY);
    const original = await verifySnapshot(passed.operations[0], passed.id, this.workspace, profile), checked = await verifyPassed(passed, this.workspace);
    assert.equal((await readStable(path.join(passed.operations[0].snapshot!.inputRoot, 'numbers.mjs'))).toString(), BUGGY);
    assert.ok((await readStable(path.join(passed.operations[1].snapshot!.inputRoot, 'numbers.mjs'))).equals(await readStable(path.join(this.workspace, 'numbers.mjs')))); assert.notEqual(passed.operations[0].snapshot!.inputRoot, passed.operations[1].snapshot!.inputRoot);
    await this.arm('export'); console.log(`ROOT_EXPORT_PICKER: select only ${this.exports}`);
    this.stage = 'export-picker'; const exported = await this.original(() => this.page!.evaluate(id => window.forgeDesk.exportTask(id), this.taskId!)); assert.ok(exported); const exportIpc = await this.receipt({ exportTask: 1 }); assert.equal(exportIpc.pickers.length, 1); this.stage = 'export-verify'; const exportedReceipt = await verifyExport(exported, this.exports, passed, this.sentinel);
    await this.arm('readonly'); await this.quiet(); this.operationIds = passed.operations.map(o => o.id); this.retryKey = passed.operations.at(-1)!.requestKey;
    return { taskId: this.taskId, projectId: this.projectId, setupIpc, modelIpc, approvalActions, model: MODEL, original, checked, export: exportedReceipt, sourceChangedOnly: 'numbers.mjs', operationIds: this.operationIds, history: this.plan.host.history };
  }
  async newBuild() {
    this.stage = 'fresh-build';
    await this.quiet(); const before = this.task(await this.snapshot()), key = randomUUID(); await this.arm('build');
    await this.original(() => this.page!.evaluate(v => window.forgeDesk.runSnapshotBuild(v.id, v.key), { id: this.taskId!, key })); await this.wait(s => !this.task(s).operations.some(o => ['prepared', 'running', 'stopping'].includes(o.status)) && this.task(s).status !== 'running'); const built = this.task(await this.snapshot()); assert.equal(built.operations.length, before.operations.length + 1); assert.equal(built.operations.at(-1)!.requestKey, key); const ipc = await this.receipt({ runSnapshotBuild: 1 }); const checked = await verifyPassed(built, this.workspace); await this.arm('readonly'); return { task: built, ipc, checked };
  }
  async refresh() { this.stage = 'refresh'; await this.arm('refresh'); await this.original(() => this.page!.evaluate(id => window.forgeDesk.refreshEvidence(id), this.taskId!)); const ipc = await this.receipt({ refreshEvidence: 1 }); await this.arm('readonly'); const t = this.task(await this.snapshot()); assert.notEqual(t.status, 'passed'); assert.equal(t.acceptance[0].status, 'stale'); assert.equal(t.evidence.at(-1)?.snapshot?.verificationResult, 'passed'); return { ipc, status: t.status, acceptanceStatus: t.acceptance[0].status, historicalVerification: 'passed' }; }
  async dedupStale() {
    await this.ready(); assert.ok(this.taskId && this.retryKey && this.operationIds);
    this.stage = 'dedup';
    const probes = path.join(ROOT, '.runtime/app/engineering/isolation-probes'); await plainPath(probes); const beforeProbes = (await readdir(probes)).sort(); assert.ok(beforeProbes.length <= 256); await this.arm('dedup', { requestKey: this.retryKey });
    await this.original(() => this.page!.evaluate(v => window.forgeDesk.runSnapshotBuild(v.id, v.key), { id: this.taskId!, key: this.retryKey! })); const dedupIpc = await this.receipt({ runSnapshotBuild: 1 }); assert.deepEqual(this.task(await this.snapshot()).operations.map(o => o.id), this.operationIds); assert.deepEqual((await readdir(probes)).sort(), beforeProbes); await this.arm('readonly');
    const restartBuild = await this.newBuild(); this.stage = 'source-drift'; const changed = path.join(this.workspace, 'external-input.bin'), changedBytes = Buffer.from([9, 8, 7]); await this.effect(() => writeFile(changed, changedBytes, { flag: 'wx' })); const workspaceStale = await this.refresh(); assert.ok((await readStable(changed)).equals(changedBytes)); await this.effect(() => unlink(changed));
    const clean = await this.newBuild(); this.stage = 'artifact-drift'; const artifact = clean.task.evidence.at(-1)!.artifacts[0].path; assert.ok(inside(clean.task.operations.at(-1)!.snapshot!.outputRoot, artifact)); const changedArtifact = Buffer.concat([await readStable(artifact), Buffer.from('\n// QA deliberate artifact drift\n')]); await this.effect(() => writeFile(artifact, changedArtifact)); const artifactStale = await this.refresh();
    const final = await this.newBuild(); assert.ok((await readStable(artifact)).equals(changedArtifact)); await this.quiet(); return { dedupIpc, durableRetryDidNotProbeOrExecute: true, restartBuild: restartBuild.checked, workspaceStale, artifactStale, final: final.checked, operationIds: final.task.operations.map(o => o.id), priorTamperedArtifactPreserved: true, history: this.plan.host.history };
  }
  async run(phase: Phase) {
    this.assertLive();
    if (phase === 'launch') return this.launch(false); if (phase === 'leave-mode') return this.leave(); if (phase === 'software-ready') return (await this.ready()).public; if (phase === 'snapshot') return this.snapshotRun(); if (phase === 'restart') return this.launch(true); if (phase === 'restart-leave') return this.restartLeave(); if (phase === 'restart-ready') return this.restartReady(); if (phase === 'dedup-stale') return this.dedupStale();
    this.stage = 'normal-close'; assert.ok(this.lifecycle && this.app); const quiet = await this.quiet(); assert.equal(quiet.state.hardware.modeActive, false); const close = await this.effect(() => this.lifecycle!.closeNormally()); assertClose(close); this.app = undefined; this.page = undefined; return { close, history: this.plan.host.history, noFailureCleanup: true };
  }
  protect() { if (this.launching) return { status: 'launch-pending-protection-deferred', safeHarnessExit: false, needsHumanClose: true }; const p = this.lifecycle?.protectOnFailure(); return p ? { status: p.status, safeHarnessExit: p.safeHarnessExit, needsHumanClose: p.needsHumanClose, removedCount: p.removedCount, sourceVerified: p.sourceVerified } : { status: 'not-launched' }; }
}
