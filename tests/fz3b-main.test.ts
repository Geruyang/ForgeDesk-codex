import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Fz3bAgentMain, type Fz3bAgentMainOptions, type Fz3bEnginePort } from '../apps/desktop/main/fz3b-agent';
import { requestNativeFz3bSemantic } from '../apps/desktop/main/fz3b-approval';
import { requestNativeFz3bInspectReconciliation, requestNativeFz3bMaintenanceExit, requestNativeFz3bPreflightRefusalRecovery } from '../apps/desktop/main/fz3b-recovery-approval';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bProfileSha256 } from '../packages/engineering-runner/fz3b/profile';
import type { Fz3bBinding, Fz3bGrantPreview, Fz3bInspectReconciliationContext, Fz3bMaintenanceExitSeal, Fz3bPreflightRefusalRecoveryContext, Fz3bRunView, Fz3bSemanticFixture } from '../packages/engineering-runner/fz3b/types';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from '../packages/engineering-runner/fz3b/preflight-recovery';
import type { EngineEvent, EngineState } from '../packages/engine-adapter';
import type { RestrictedFz3bAdapterOptions } from '../packages/engine-adapter/restricted-fz3b';
import type { Session } from '../packages/shared/contracts';
import { restrictedSessionProfile } from '../apps/desktop/main/restricted-session';

const fixture: Fz3bSemanticFixture = { id: 'fz3b-pillow-scene-v1', manifestSha256: FZ3B_PROFILE.semanticManifestSha256, queriesSha256: FZ3B_PROFILE.queriesSha256,
  imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256,
  width: 914, height: 512, queryCount: 4, embeddingDimensions: 512, expectedLabel: 'pillow',
  queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: { ...FZ3B_PROFILE.encoderIdentity } };
function runView(binding: Fz3bBinding): Fz3bRunView {
  return { ...binding, schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: fz3bProfileSha256(fixture),
    status: 'active', phase: 'ready', active: true, hardwareBusy: false, stopRequested: false,
    nativeApproval: 'not_requested', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), calls: [], operations: [] };
}
class Backend {
  run?: Fz3bRunView;
  tools = 0; ended = 0; recoveries = 0; inflight = false;
  reconciles = 0; seals = 0; preflightReconciles = 0; preflightAvailable = false;
  async start(binding: Fz3bBinding) { this.run = runView(binding); return structuredClone(this.run); }
  async bindTurn(id: string, context: { generation: number; threadId: string; turnId: string }) { assert.equal(this.run!.runId, id); this.run!.turnId = context.turnId; }
  async executeTool() { ++this.tools; return { runId: this.run!.runId, callId: 'call-1', tool: 'fz3b_status', ok: true, result: 'status', phase: 'ready' } as const; }
  async status() { return this.run ? structuredClone(this.run) : undefined; }
  async list() { return this.run ? [structuredClone(this.run)] : []; }
  async stop() { this.run!.active = false; this.run!.stopRequested = true; if (!this.run!.hardwareBusy) this.run!.status = 'stopped'; return structuredClone(this.run!); }
  async turnEnded() { ++this.ended; this.run!.active = false; return structuredClone(this.run!); }
  async quiescence(id: string) { return { runId: id, taskId: this.run!.taskId, sessionId: this.run!.sessionId,
    active: this.run!.active, stopRequested: this.run!.stopRequested, starting: false, inflight: this.inflight,
    nativePending: false, persistencePending: false, hardwareBusy: this.run!.hardwareBusy,
    quiescent: !this.run!.active && !this.run!.hardwareBusy && !this.inflight }; }
  async recover() { ++this.recoveries; }
  async export() { return { path: 'fixed-local-export', sha256: 'c'.repeat(64) }; }
  async recoveryActions() { return { ...(this.preflightAvailable ? { reconcilePreflightRefusedInspect: true } : {}), reconcileInspect: this.run?.operations.some(op => op.kind === 'inspect' && op.status === 'unknown') === true, maintenanceExit: this.run?.hardwareBusy === true,
    exportEvidence: !this.inflight && this.run?.active === false && this.run.operations.every(op => !['prepared', 'running'].includes(op.status) && (op.dispatchPhase === 'not-started' || op.processExited === true)) }; }
  async reconcileInspect() { if (this.run!.hardwareBusy) ++this.reconciles; this.run!.hardwareBusy = false; this.run!.status = 'needs_attention'; return structuredClone(this.run!); }
  async reconcilePreflightRefusedInspect() {
    if (this.run!.hardwareBusy) { if (!this.preflightAvailable) throw new Error('No local preflight proof candidate'); ++this.preflightReconciles; }
    // Trusted-backend presentation stub only; independent consumer tests build the signed chain.
    this.run!.preflightRefusalRecoveries ??= [{ status: 'released' } as NonNullable<Fz3bRunView['preflightRefusalRecoveries']>[number]];
    this.run!.hardwareBusy = false; this.run!.status = 'needs_attention'; return structuredClone(this.run!);
  }
  async prepareMaintenanceExit(): Promise<Fz3bMaintenanceExitSeal> {
    ++this.seals; const run = this.run!;
    return { schemaVersion: 1, runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, profileSha256: run.profileSha256,
      createdAt: new Date().toISOString(), unknownPreserved: true, localProcessesClosed: true, operationSnapshotSha256: 'b'.repeat(64),
      processState: { closed: true, liveChildren: 0, operations: [] }, sealSha256: 'c'.repeat(64) };
  }
}
class Engine implements Fz3bEnginePort {
  state: EngineState = 'stopped'; connectionGeneration = 42; stops = 0; starts = 0; failStop = false;
  sequence = 0; deferredSend?: Promise<void>; earlyTerminal?: () => void;
  constructor(readonly callbacks: Pick<RestrictedFz3bAdapterOptions, 'onEvent' | 'onToolCall'>) {}
  async start() { ++this.starts; this.state = 'ready'; }
  async stop() { ++this.stops; if (this.failStop) { this.state = 'failed'; throw new Error('Exit not observed'); } this.state = 'stopped'; }
  async account() { return { account: { type: 'chatgpt', email: 'offline@example.invalid' } }; }
  async startThread() { return 'thread-1'; }
  async send() {
    this.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    this.earlyTerminal?.();
    await this.deferredSend;
  }
  policySnapshot() { return { profile: 'restricted-fz3b', tools: ['fz3b_status'] }; }
  emit(method: string, params: unknown, generation = this.connectionGeneration) { this.callbacks.onEvent({ method, params, generation, sequence: ++this.sequence }); }
}
function setup() {
  const backend = new Backend(), held = new Set<string>(), engines: Engine[] = [], sessions = new Map<string, Session>();
  const session: Session = { id: 'task-1', taskId: 'task-1', projectId: 'project-1', title: 'FZ3B fixture', status: 'draft', messages: [] };
  sessions.set(session.id, session);
  let released = 0, globalOwnerError = false, accountError = false, runtimeError = false;
  const options: Fz3bAgentMainOptions = {
    backend: backend as unknown as Fz3bAgentMainOptions['backend'],
    createEngine: callbacks => { const engine = new Engine(callbacks); engines.push(engine); return engine; },
    getSession: id => { const s = sessions.get(id); if (!s) throw new Error('Unknown session'); return s; },
    assertCanStart: () => { if (held.size) throw new Error('Other profile is held'); },
    assertBeforeClaim: () => { if (held.size) throw new Error('Other profile is held'); },
    enterControlledMode: async () => {}, assertGlobalOwner: () => { if (globalOwnerError) throw new Error('Global owner changed'); },
    assertGlobalRecoveryOwner: () => { if (globalOwnerError) throw new Error('Global recovery owner changed'); },
    checkRuntime: async () => { if (runtimeError) throw new Error('Runtime unavailable'); },
    readAccount: async engine => { if (accountError) throw new Error('Account unavailable'); return engine.account(); },
    setAccount: () => {}, hold: id => { held.add(id); }, release: id => { ++released; held.delete(id); },
    save: () => {}, publish: () => {}, log: () => {}, redact: value => value,
    onEvent: (event: EngineEvent) => { if (event.method === 'turn/started') session.turnId = (event.params as { turn: { id: string } }).turn.id; },
  };
  const main = new Fz3bAgentMain(options);
  return { main, backend, held, engines, session, sessions, options, get released() { return released; },
    set globalOwnerError(value: boolean) { globalOwnerError = value; }, set accountError(value: boolean) { accountError = value; },
    set runtimeError(value: boolean) { runtimeError = value; } };
}
async function settled(predicate: () => boolean) { const end = Date.now() + 2000; while (!predicate() && Date.now() < end) await delay(1); assert.ok(predicate()); }

test('FZ3B main binds a fresh task and requires exact generation thread turn on callbacks', async () => {
  const s = setup(); const run = await s.main.start('task-1', 'Run the fixed semantic fixture', 'gpt-6.1-sol');
  const engine = s.engines[0], context = { generation: 42, threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1' };
  for (const change of [{ generation: 41 }, { threadId: 'foreign' }, { turnId: 'foreign' }]) await assert.rejects(engine.callbacks.onToolCall({ ...context, ...change }, 'fz3b_status', {}), /MISMATCH/);
  assert.equal(s.backend.tools, 0);
  await engine.callbacks.onToolCall(context, 'fz3b_status', {});
  assert.equal(s.backend.tools, 1); assert.equal(run.taskId, s.session.taskId); assert.equal(s.main.held, true);
  await s.main.stop(run.runId); assert.equal(s.main.held, false); assert.equal(s.released, 1);
});
test('FZ3B invalid model, nonfresh session and preparation failure cannot launch an engine', async () => {
  const s = setup();
  await assert.rejects(s.main.start('task-1', 'test', 'arbitrary-model'), /NOT_PINNED/);
  s.session.messages.push({ id: 'old', role: 'user', text: 'old', timestamp: '' });
  await assert.rejects(s.main.start('task-1', 'test', 'gpt-6.1-sol'), /FRESH_SESSION/);
  s.session.messages = []; s.runtimeError = true;
  await assert.rejects(s.main.start('task-1', 'test', 'gpt-6.1-sol'), /Runtime unavailable/);
  assert.equal(s.engines.length, 0); assert.equal(s.main.held, false); assert.equal(s.held.size, 0);
});
test('FZ3B admission rechecks a software contender and session mutations after the asynchronous ledger read', async () => {
  for (const contender of ['global', 'session']) {
    const s = setup(); let entered = false, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    s.backend.list = async () => { entered = true; await gate; return []; };
    const start = s.main.start('task-1', 'test', 'gpt-6.1-sol');
    await settled(() => entered);
    if (contender === 'global') s.held.add('software-task');
    else s.session.messages.push({ id: 'new-software-message', role: 'user', text: 'raced', timestamp: '' });
    release(); await assert.rejects(start, /Other profile|FRESH_SESSION/);
    assert.equal(s.engines.length, 0); assert.equal(s.main.held, false); assert.equal(s.released, 0);
  }
});
test('FZ3B global owner revocation rejects the callback before backend execution', async () => {
  const s = setup(); const run = await s.main.start('task-1', 'test', 'gpt-6.1-sol'); s.globalOwnerError = true;
  await assert.rejects(s.engines[0].callbacks.onToolCall({ generation: 42, threadId: 'thread-1', turnId: 'turn-1', callId: 'call' }, 'fz3b_semantic', {}), /Global owner/);
  assert.equal(s.backend.tools, 0); await s.main.stop(run.runId);
});
test('FZ3B unknown remote state retains the global lock even after local engine stop and recovery', async () => {
  const s = setup(); const run = await s.main.start('task-1', 'test', 'gpt-6.1-sol');
  s.backend.run!.hardwareBusy = true;
  s.backend.run!.operations.push({ id: 'op', nonce: 'nonce', kind: 'semantic', requestKey: 'req', status: 'unknown', dispatchPhase: 'may-have-started', createdAt: '', updatedAt: '' });
  await s.main.stop(run.runId);
  assert.equal(s.engines[0].state, 'stopped'); assert.equal(s.main.held, true); assert.equal(s.released, 0);
  await assert.rejects(s.main.recover('task-1'), /UNKNOWN_HELD/);
  assert.equal(s.main.held, true); assert.equal(s.released, 0); assert.equal(s.backend.tools, 0);
});
test('FZ3B unconfirmed local engine exit remains held until an explicit stop retry confirms exit', async () => {
  const s = setup(); const run = await s.main.start('task-1', 'test', 'gpt-6.1-sol'); s.engines[0].failStop = true;
  await assert.rejects(s.main.stop(run.runId), /Exit not observed/);
  assert.equal(s.main.held, true); assert.equal(s.released, 0);
  s.engines[0].failStop = false; await s.main.stop(run.runId);
  assert.equal(s.main.held, false); assert.equal(s.released, 1); assert.equal(s.engines[0].starts, 1);
});
test('FZ3B startup failure with unresolved engine preserves a recoverable task hold without a fake run', async () => {
  const s = setup(); s.accountError = true;
  const create = s.options.createEngine;
  s.options.createEngine = callbacks => { const engine = create(callbacks) as Engine; engine.failStop = true; return engine; };
  await assert.rejects(s.main.start('task-1', 'test', 'gpt-6.1-sol'), /Account unavailable/);
  assert.equal(s.main.held, true); assert.equal(s.main.activeRunId, undefined); assert.equal(s.released, 0);
  assert.equal((await s.main.snapshot()).recoveryTaskId, 'task-1');
  s.engines[0].failStop = false; assert.equal(await s.main.recover('task-1'), null);
  assert.equal(s.main.held, false); assert.equal(s.released, 1); assert.equal(s.engines[0].starts, 1);
  assert.equal((await s.main.snapshot()).recoveryTaskId, undefined);
});
test('FZ3B early turn terminal during a deferred send is finalized after startup settles', async () => {
  const s = setup(); let unblock!: () => void;
  const gate = new Promise<void>(done => { unblock = done; }); const create = s.options.createEngine;
  s.options.createEngine = callbacks => { const engine = create(callbacks) as Engine; engine.deferredSend = gate;
    engine.earlyTerminal = () => { s.backend.run!.active = false; s.backend.run!.status = 'completed'; s.backend.run!.phase = 'completed'; engine.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } }); }; return engine; };
  const start = s.main.start('task-1', 'test', 'gpt-6.1-sol');
  await settled(() => !!s.session.turnId); assert.equal(s.main.held, true); assert.equal(s.released, 0);
  unblock(); await start; await settled(() => !s.main.held);
  assert.equal(s.released, 1); assert.equal(s.engines[0].state, 'stopped'); assert.equal(s.session.status, 'completed'); assert.equal(s.session.turnId, undefined);
});
test('FZ3B foreign terminal events do not finalize the current task', async () => {
  const s = setup(); const run = await s.main.start('task-1', 'test', 'gpt-6.1-sol');
  s.engines[0].emit('turn/completed', { threadId: 'foreign', turn: { id: 'turn-1' } });
  s.engines[0].emit('turn/completed', { threadId: 'thread-1', turn: { id: 'foreign' } });
  s.engines[0].emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } }, 41);
  await delay(1); assert.equal(s.backend.ended, 0); assert.equal(s.main.held, true); await s.main.stop(run.runId);
});
test('FZ3B recovered remote unknown is held without engine launch or replay; snapshot/export stay local', async () => {
  const s = setup(); s.backend.run = runView({ runId: 'old-run', taskId: 'task-1', sessionId: 'task-1', model: 'gpt-6.1-sol', generation: 1, threadId: 'old' });
  s.backend.run.active = false; s.backend.run.hardwareBusy = true; s.backend.run.stopRequested = true;
  s.session.threadId = 'old'; s.session.model = 'gpt-6.1-sol'; s.session.engineProfile = 'fz3b';
  await s.main.recoverStartup(); assert.equal(s.main.held, true); assert.equal(s.held.has('task-1'), true);
  assert.equal((await s.main.snapshot()).recoveryTaskId, undefined);
  await s.main.taskSnapshot('task-1'); assert.equal(await s.main.export('task-1'), 'fixed-local-export');
  assert.equal(s.engines.length, 0); assert.equal(s.backend.tools, 0);
  await assert.rejects(s.main.assertIdle(), /HELD/); await assert.rejects(s.main.recover('task-1'), /UNKNOWN_HELD/);
});
test('an unrelated failed engine without a held startup task cannot expose or use no-run recovery', async () => {
  const s = setup(); const engine = new Engine({ onEvent: () => {}, onToolCall: async () => ({}) });
  engine.state = 'failed'; Reflect.set(s.main, 'engine', engine);
  assert.equal((await s.main.snapshot()).recoveryTaskId, undefined);
  await assert.rejects(s.main.recover('task-1'), /OWNER_REQUIRED/);
  assert.equal(engine.stops, 0);
});

async function unknownRun(kind: 'inspect' | 'semantic' = 'inspect') {
  const s = setup(); const run = await s.main.start('task-1', 'fixed task', 'gpt-6.1-sol');
  s.backend.run!.hardwareBusy = true;
  s.backend.run!.operations.push({ id: 'old-op', nonce: 'nonce', kind, requestKey: 'req', status: 'unknown', dispatchPhase: 'may-have-started', processExited: true, createdAt: '', updatedAt: '' });
  await s.main.stop(run.runId);
  return { ...s, runId: run.runId };
}

test('host-only reconciliation can release only fresh-proven inspect occupancy without rewriting unknown or replaying the run', async () => {
  const s = await unknownRun();
  const before = structuredClone(s.backend.run!.operations);
  const actions = (await s.main.snapshot()).recoveryActions;
  assert.deepEqual(actions, { runId: s.runId, taskId: 'task-1', sessionId: 'task-1', reconcileInspect: true, maintenanceExit: true, exportEvidence: true });
  const result = await s.main.reconcileInspect(s.runId);
  assert.equal(result.status, 'needs_attention'); assert.equal(result.stopRequested, true); assert.equal(result.active, false);
  assert.deepEqual(result.operations, before); assert.equal(s.main.held, false); assert.equal(s.held.size, 0);
  assert.equal(s.backend.reconciles, 1); assert.equal(s.backend.tools, 0); assert.equal(s.engines[0].starts, 1);
  assert.equal(s.session.status, 'needs_attention'); assert.equal(s.session.historyIncomplete, true);
  await assert.rejects(s.main.start('task-1', 'resume old run', 'gpt-6.1-sol'), /FRESH_SESSION/);
});

test('reconciliation rejects foreign owner local inflight unconfirmed engine and changed global owner before the backend', async () => {
  const s = await unknownRun();
  await assert.rejects(s.main.reconcileInspect('foreign'), /OWNER_MISMATCH/);
  s.backend.inflight = true; await assert.rejects(s.main.reconcileInspect(s.runId), /NOT_IDLE/); s.backend.inflight = false;
  s.engines[0].failStop = true; await assert.rejects(s.main.reconcileInspect(s.runId), /Exit not observed/); s.engines[0].failStop = false;
  await s.engines[0].stop(); s.options.assertGlobalRecoveryOwner = () => { throw new Error('Global owner changed'); };
  await assert.rejects(s.main.reconcileInspect(s.runId), /Global owner changed/);
  assert.equal(s.backend.reconciles, 0); assert.equal(s.main.held, true); assert.equal(s.held.size, 1);
});

test('main save failure keeps the hold until explicit local backend-release finalization without replay or unknown rewriting', async () => {
  const s = await unknownRun(); const before = structuredClone(s.backend.run!.operations);
  let failSave = true;
  s.options.save = () => { if (failSave) throw new Error('Main save failed'); };
  await assert.rejects(s.main.reconcileInspect(s.runId), /Main save failed/);
  assert.equal(s.main.held, true); assert.equal(s.held.has('task-1'), true); assert.equal(s.backend.reconciles, 1);
  failSave = false;
  await s.main.reconcileInspect(s.runId);
  assert.equal(s.main.held, false); assert.equal(s.held.size, 0); assert.equal(s.backend.reconciles, 1);
  assert.deepEqual(s.backend.run!.operations, before); assert.equal(s.backend.tools, 0); assert.equal(s.engines[0].starts, 1);
});

test('preflight local recovery has a distinct capability and releases only after exact-owner backend settlement and main save', async () => {
  const s = await unknownRun(); s.backend.preflightAvailable = true;
  const before = structuredClone(s.backend.run!.operations);
  assert.equal((await s.main.snapshot()).recoveryActions?.reconcilePreflightRefusedInspect, true);
  const result = await s.main.reconcilePreflightRefusedInspect(s.runId);
  assert.deepEqual(result.operations, before); assert.equal(result.operations[0].status, 'unknown');
  assert.equal(result.status, 'needs_attention'); assert.equal(result.stopRequested, true); assert.equal(result.grant, undefined);
  assert.equal(s.main.held, false); assert.equal(s.held.size, 0); assert.equal(s.backend.preflightReconciles, 1);
  assert.equal(s.backend.reconciles, 0); assert.equal(s.backend.tools, 0); assert.equal(s.engines[0].starts, 1);
  assert.equal(s.session.historyIncomplete, true); assert.equal(s.session.turnId, undefined);
});

test('preflight local recovery rejects foreign inflight engine and owner failures, without legacy SSH fallback', async () => {
  const s = await unknownRun(); s.backend.preflightAvailable = true;
  await assert.rejects(s.main.reconcilePreflightRefusedInspect('foreign'), /OWNER_MISMATCH/);
  s.backend.inflight = true; await assert.rejects(s.main.reconcilePreflightRefusedInspect(s.runId), /NOT_IDLE/); s.backend.inflight = false;
  s.engines[0].failStop = true; await assert.rejects(s.main.reconcilePreflightRefusedInspect(s.runId), /Exit not observed/); s.engines[0].failStop = false;
  await s.engines[0].stop(); s.options.assertGlobalRecoveryOwner = () => { throw new Error('Global recovery owner changed'); };
  await assert.rejects(s.main.reconcilePreflightRefusedInspect(s.runId), /Global recovery owner changed/);
  assert.equal(s.backend.preflightReconciles, 0); assert.equal(s.backend.reconciles, 0); assert.equal(s.main.held, true);
});

test('post-release main save failure retains ownership until explicit same-proof local completion', async () => {
  const s = await unknownRun(); s.backend.preflightAvailable = true; const before = structuredClone(s.backend.run!.operations);
  let failSave = true; s.options.save = () => { if (failSave) throw new Error('Main local recovery save failed'); };
  await assert.rejects(s.main.reconcilePreflightRefusedInspect(s.runId), /Main local recovery save failed/);
  assert.equal(s.main.held, true); assert.equal(s.held.has('task-1'), true); assert.equal(s.backend.preflightReconciles, 1);
  assert.equal((await s.main.snapshot()).recoveryActions?.finishPreflightRefusal, true);
  await assert.rejects(s.main.stop(s.runId), /HOST_FINISH_REQUIRED/);
  await assert.rejects(s.main.recover(s.session.taskId), /HOST_FINISH_REQUIRED/);
  await assert.rejects(s.main.reconcileInspect(s.runId), /HOST_FINISH_REQUIRED/);
  failSave = false; await s.main.reconcilePreflightRefusedInspect(s.runId);
  assert.equal(s.main.held, false); assert.equal(s.backend.preflightReconciles, 1); assert.deepEqual(s.backend.run!.operations, before);
  assert.equal(s.backend.tools, 0); assert.equal(s.backend.reconciles, 0);
});

test('restart reclaims preflight completion after both invisible and visible-then-throw main saves until explicit local finish', async () => {
  for (const visible of [false, true]) {
    const s = await unknownRun(); s.backend.preflightAvailable = true;
    const before = structuredClone(s.backend.run!.operations);
    let durableSession = structuredClone(s.session);
    s.options.save = () => { if (visible) durableSession = structuredClone(s.session); throw new Error('Main save replacement failed'); };
    await assert.rejects(s.main.reconcilePreflightRefusedInspect(s.runId), /replacement failed/);
    assert.equal(s.backend.run!.hardwareBusy, false); assert.equal(s.main.held, true);
    const held = new Set<string>(); let released = 0, saved = 0;
    const restartOptions: Fz3bAgentMainOptions = { ...s.options,
      getSession: () => durableSession,
      createEngine: () => { throw new Error('Restart must not launch an engine'); },
      hold: id => { held.add(id); }, release: id => { held.delete(id); released++; },
      save: () => { saved++; durableSession = structuredClone(durableSession); },
    };
    const restarted = new Fz3bAgentMain(restartOptions); await restarted.recoverStartup();
    assert.equal(restarted.held, true); assert.equal(restarted.activeRunId, s.runId); assert.equal(held.has(s.session.taskId), true);
    assert.equal(saved, 0); assert.equal(released, 0);
    const actions = (await restarted.snapshot()).recoveryActions!;
    assert.equal(actions.finishPreflightRefusal, true); assert.equal(actions.reconcilePreflightRefusedInspect, true);
    assert.equal(actions.reconcileInspect, false); assert.equal(actions.maintenanceExit, false);
    await assert.rejects(restarted.assertIdle(), /HELD/);
    await assert.rejects(restarted.stop(s.runId), /HOST_FINISH_REQUIRED/);
    await assert.rejects(restarted.recover(s.session.taskId), /HOST_FINISH_REQUIRED/);
    await assert.rejects(restarted.reconcileInspect(s.runId), /HOST_FINISH_REQUIRED/);
    await Reflect.get(restarted, 'finish').call(restarted, s.runId);
    assert.equal(restarted.held, true); assert.equal(released, 0); assert.equal(saved, 0);
    await restarted.reconcilePreflightRefusedInspect(s.runId);
    assert.equal(restarted.held, false); assert.equal(released, 1); assert.equal(saved, 1);
    assert.equal(s.backend.preflightReconciles, 1); assert.equal(s.backend.reconciles, 0); assert.equal(s.backend.tools, 0);
    assert.deepEqual(s.backend.run!.operations, before);
    const nextRestart = new Fz3bAgentMain(restartOptions); await nextRestart.recoverStartup();
    assert.equal(nextRestart.held, true); assert.equal(released, 1);
    await nextRestart.reconcilePreflightRefusedInspect(s.runId);
    assert.equal(nextRestart.held, false); assert.equal(s.backend.preflightReconciles, 1);
  }
});

test('maintenance preparation proves local closure but preserves unknown hardware occupancy and task ownership', async () => {
  const s = await unknownRun('semantic'), before = structuredClone(s.backend.run);
  const seal = await s.main.prepareMaintenanceExit(s.runId);
  assert.equal(seal.unknownPreserved, true); assert.equal(seal.localProcessesClosed, true);
  assert.deepEqual(s.backend.run, before); assert.equal(s.main.held, true); assert.equal(s.held.has('task-1'), true);
  assert.equal(s.backend.reconciles, 0); assert.equal(s.backend.tools, 0); assert.equal(s.engines[0].starts, 1);
  await assert.rejects(s.main.assertIdle(), /HELD/);
  s.backend.prepareMaintenanceExit = async () => ({ ...seal, processState: { closed: false, liveChildren: 1, operations: [] } });
  await assert.rejects(s.main.prepareMaintenanceExit(s.runId), /UNCONFIRMED/);
  assert.equal(s.main.held, true); assert.equal(s.held.size, 1);
});

function reconciliationContext(): Fz3bInspectReconciliationContext {
  return { schemaVersion: 1, id: 'reconciliation', nonce: 'reconciliation-nonce', createdAt: new Date().toISOString(),
    original: { runId: 'run', sessionId: 'session', taskId: 'task', operationId: 'old-inspect', requestKey: 'request', nonce: 'old-nonce', profileSha256: fz3bProfileSha256(fixture), fixture },
    originalOperationSha256: 'a'.repeat(64), originalEvidenceSha256: 'b'.repeat(64), ownerBindingSha256: 'c'.repeat(64) };
}

test('host-only native recovery confirmations default cancel and require explicit checkbox plus repeated owner checks', async () => {
  const context = reconciliationContext(); let owners = 0;
  for (const answer of [{ response: 0, checkboxChecked: true }, { response: 1, checkboxChecked: false }]) {
    assert.equal(await requestNativeFz3bInspectReconciliation(context, new AbortController().signal, { assertOwner: () => {}, show: async () => answer }), false);
  }
  assert.equal(await requestNativeFz3bInspectReconciliation(context, new AbortController().signal, { assertOwner: () => { ++owners; }, show: async options => {
    assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.checkboxChecked, false);
    assert.match(options.detail, /原 unknown 记录保留/); assert.match(options.detail, /不继续原模型/);
    return { response: 1, checkboxChecked: true };
  } }), true);
  assert.equal(owners, 2);
  const s = await unknownRun('semantic'), seal = await s.main.prepareMaintenanceExit(s.runId);
  assert.equal(await requestNativeFz3bMaintenanceExit(seal, s.backend.run!, { assertOwner: () => {}, show: async options => {
    assert.equal(options.defaultId, 0); assert.equal(options.checkboxChecked, false); assert.match(options.detail, /不证明远端安全/); assert.match(options.detail, /下次启动仍/);
    return { response: 1, checkboxChecked: true };
  } }), true);
  await assert.rejects(requestNativeFz3bMaintenanceExit({ ...seal, localProcessesClosed: false } as unknown as Fz3bMaintenanceExitSeal, s.backend.run!, { assertOwner: () => {}, show: async () => { throw new Error('Must not show'); } }), /PREVIEW_INVALID/);
  let count = 0;
  await assert.rejects(requestNativeFz3bMaintenanceExit(seal, s.backend.run!, { assertOwner: () => { if (++count === 2) throw new Error('Owner changed'); }, show: async () => ({ response: 1, checkboxChecked: true }) }), /Owner changed/);
});

test('desktop native consumers distinguish the production maintenance aggregate from raw close and original operation evidence', async () => {
  const s = await unknownRun(), pins = FZ3B_PREFLIGHT_RECOVERY_CASE;
  const operation = s.backend.run!.operations[0];
  operation.id = pins.operationId; operation.nonce = pins.nonce; operation.evidenceSha256 = pins.evidenceSha256;
  const seal = await s.main.prepareMaintenanceExit(s.runId);
  seal.processState.operations = [{ operationId: operation.id, nonce: operation.nonce!, closeConfirmed: true, evidenceSha256: pins.maintenanceLocalCloseProofSha256 }];
  assert.equal(new Set([pins.evidenceSha256, pins.actualCloseSha256, pins.maintenanceLocalCloseProofSha256]).size, 3);
  const before = structuredClone(s.backend.run!.operations);
  assert.equal(await requestNativeFz3bMaintenanceExit(seal, s.backend.run!, {
    assertOwner: binding => { assert.equal(binding.runId, s.runId); },
    show: async options => { assert.equal(options.checkboxChecked, false); return { response: 1, checkboxChecked: true }; },
  }), true);
  const sourceRun = { ...structuredClone(s.backend.run!), maintenanceExit: structuredClone(seal) }, created = Date.now();
  // Presentation fixture only: backend tests establish HMAC/source/proof admission.
  const context: Fz3bPreflightRefusalRecoveryContext = { schemaVersion: 1, reason: 'boot-preflight-refused-before-device-v1', id: 'desktop-production-metadata', nonce: 'a'.repeat(64),
    createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString(),
    original: { runId: sourceRun.runId, taskId: sourceRun.taskId, sessionId: sourceRun.sessionId, operationId: operation.id, nonce: operation.nonce!,
      requestKey: operation.requestKey, profileSha256: sourceRun.profileSha256, fixture },
    originalOperationSha256: 'b'.repeat(64), originalEvidenceSha256: pins.evidenceSha256, ownerBindingSha256: 'c'.repeat(64),
    sourceRecordSha256: 'd'.repeat(64), sourceProjectionSha256: 'e'.repeat(64), maintenanceExitSha256: seal.sealSha256,
    sourceRun, projection: structuredClone(s.backend.run!), anchor: { owner: { runId: sourceRun.runId, taskId: sourceRun.taskId, sessionId: sourceRun.sessionId,
      model: sourceRun.model, generation: sourceRun.generation, threadId: sourceRun.threadId, turnId: sourceRun.turnId! }, operationId: operation.id,
      runSha256: 'e'.repeat(64), operationSha256: 'b'.repeat(64), evidenceSha256: pins.evidenceSha256, intentSha256: pins.intentSha256,
      transportSha256: pins.transportSha256, actualCloseSha256: pins.actualCloseSha256 } };
  for (const checked of [false, true]) {
    let owners = 0;
    assert.equal(await requestNativeFz3bPreflightRefusalRecovery(structuredClone(context), new AbortController().signal, {
      assertOwner: () => { owners++; }, show: async options => {
        assert.equal(options.checkboxChecked, false); assert.match(options.detail, new RegExp(pins.evidenceSha256));
        assert.match(options.detail, /不连接 SSH/); return { response: 1, checkboxChecked: checked };
      },
    }), checked);
    assert.equal(owners, checked ? 2 : 1);
  }
  const changed = structuredClone(context);
  await assert.rejects(requestNativeFz3bPreflightRefusalRecovery(changed, new AbortController().signal, {
    assertOwner: () => {}, show: async () => {
      changed.sourceRun.maintenanceExit!.processState.operations[0].evidenceSha256 = pins.actualCloseSha256;
      return { response: 1, checkboxChecked: true };
    },
  }), /PREVIEW_CHANGED/);
  let checks = 0;
  await assert.rejects(requestNativeFz3bPreflightRefusalRecovery(structuredClone(context), new AbortController().signal, {
    assertOwner: () => { if (++checks === 2) throw new Error('Metadata owner changed'); },
    show: async () => ({ response: 1, checkboxChecked: true }),
  }), /Metadata owner changed/);
  assert.deepEqual(s.backend.run!.operations, before); assert.equal(s.main.held, true); assert.equal(s.backend.preflightReconciles, 0);
});

function grant(): Fz3bGrantPreview {
  const now = Date.now(); return { id: 'grant', runId: 'run', sessionId: 'session', taskId: 'task', artifactId: 'c'.repeat(64),
    profileSha256: fz3bProfileSha256(fixture), identity: { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId,
      appRoot: FZ3B_PROFILE.appRoot, platform: 'A0005', contractId: FZ3B_PROFILE.encoderIdentity.contractId,
      deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256, existingPlSha256: FZ3B_PROFILE.existingPlSha256, transport: 'pinned-ssh', helloAuthenticated: false },
    fixture, scope: 'existing-candidate008-real-text-single-image-once', actions: FZ3B_PROFILE.actions,
    planSha256: 'd'.repeat(64), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
}
test('native FZ3B approval has default cancel, explicit checkbox/effects, and owner/runtime rechecks', async () => {
  let owners = 0, runtime = 0;
  const approved = await requestNativeFz3bSemantic(grant(), new AbortController().signal, {
    assertOwner: () => { ++owners; }, checkRuntime: async () => { ++runtime; }, show: async options => {
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.checkboxChecked, false);
      assert.match(options.detail!, /不是只读操作/); assert.match(options.detail!, /旧查询无法/); assert.match(options.detail!, /不授权新位流/);
      return { response: 1, checkboxChecked: true };
    },
  });
  assert.equal(approved, true); assert.equal(owners, 2); assert.equal(runtime, 2);
});
test('native cancel unchecked abort expiry and changed owner cannot authorize semantic dispatch', async () => {
  for (const answer of [{ response: 0, checkboxChecked: true }, { response: 1, checkboxChecked: false }]) {
    assert.equal(await requestNativeFz3bSemantic(grant(), new AbortController().signal, { assertOwner: () => {}, checkRuntime: async () => {}, show: async () => answer }), false);
  }
  const abort = new AbortController(); abort.abort(); let shown = false;
  assert.equal(await requestNativeFz3bSemantic(grant(), abort.signal, { assertOwner: () => {}, checkRuntime: async () => {}, show: async () => { shown = true; return { response: 1, checkboxChecked: true }; } }), false);
  assert.equal(shown, false);
  const preview = grant(); let clock = Date.now();
  assert.equal(await requestNativeFz3bSemantic(preview, new AbortController().signal, { now: () => clock, assertOwner: () => {}, checkRuntime: async () => {}, show: async () => { clock = Date.parse(preview.expiresAt); return { response: 1, checkboxChecked: true }; } }), false);
  let owners = 0;
  await assert.rejects(requestNativeFz3bSemantic(grant(), new AbortController().signal, { assertOwner: () => { if (++owners === 2) throw new Error('Owner changed'); }, checkRuntime: async () => {}, show: async () => ({ response: 1, checkboxChecked: true }) }), /Owner changed/);
});
test('native tampered scope actions identity and fixture cannot even open the confirmation', async () => {
  for (const change of [{ scope: 'write-anywhere' }, { actions: ['arbitrary SSH'] }, { planSha256: 'invalid' }, { artifactId: 'invalid' }]) {
    let shown = false;
    await assert.rejects(requestNativeFz3bSemantic({ ...grant(), ...change } as Fz3bGrantPreview, new AbortController().signal, { assertOwner: () => {}, checkRuntime: async () => {}, show: async () => { shown = true; return { response: 1, checkboxChecked: true }; } }));
    assert.equal(shown, false);
  }
});
test('restricted history migration uses exact run or thread references without guessing ordinary sessions', () => {
  const session: Session = { id: 'session', taskId: 'task', projectId: 'p', title: 'old', status: 'completed', messages: [], threadId: 'old-restricted-thread' };
  assert.equal(restrictedSessionProfile(session, [], []), undefined);
  assert.equal(restrictedSessionProfile(session, [{ sessionId: 'session', taskId: 'task' }], []), 'stm32');
  assert.equal(restrictedSessionProfile(session, [], [{ sessionId: 'session', taskId: 'task' }]), 'fz3b');
  assert.equal(restrictedSessionProfile(session, [], [{ sessionId: 'other', taskId: 'other', threadId: session.threadId }]), 'fz3b');
  assert.equal(restrictedSessionProfile(session, [{ sessionId: 'different', taskId: 'task' }], []), undefined);
  assert.throws(() => restrictedSessionProfile({ ...session, engineProfile: 'fz3b' }, [{ sessionId: 'session', taskId: 'task' }], []), /CONFLICT/);
});
