import assert from 'node:assert/strict';
import test from 'node:test';
import { EmbeddedService } from '../packages/engineering-runner/embedded';
import { GESTURESCREEN_PROFILE, GESTURESCREEN_PROFILE_SHA256 } from '../packages/engineering-runner/embedded/profile';
import type { EmbeddedOptions, EmbeddedStatus } from '../packages/engineering-runner/embedded/types';
import { desktopHarness, setupSession, until } from './helpers/desktop-harness';

// Actual main IPC and controller code; model transport, runtime verification and device execution are explicit offline fixtures.
class OfflineAgentEmbedded extends EmbeddedService {
  calls: string[] = [];
  value: EmbeddedStatus = { configured: false, taskId: '', profileId: GESTURESCREEN_PROFILE.id, profileSha256: GESTURESCREEN_PROFILE_SHA256,
    hardwareAvailable: true, limitation: 'Offline fixture; no model or hardware', operations: [] };
  constructor(options: EmbeddedOptions) { super(options); }
  override async recover() {}
  override async assertIdle() { this.calls.push('idle'); }
  override async revokeGrants() { this.calls.push('revoke'); this.value.grant = undefined; }
  override async configure(taskId: string, projectRoot: string) { this.calls.push('configure'); this.value.configured = true; this.value.projectRoot = projectRoot; return this.status(taskId); }
  override async status(taskId: string) { this.value.taskId = taskId; return structuredClone(this.value); }
  override async build(): Promise<EmbeddedStatus> { this.calls.push('build'); throw new Error('Offline test does not execute a compiler'); }
  override async inspect(): Promise<EmbeddedStatus> { this.calls.push('inspect'); throw new Error('Offline test does not access hardware'); }
  override async close() {}
}

async function fixture() {
  let embedded!: OfflineAgentEmbedded;
  const h = await desktopHarness({ allowRestrictedEngine: true, verifyHardwareRuntime: async () => {}, embeddedFactory: options => embedded = new OfflineAgentEmbedded(options) });
  const session = await setupSession(h);
  const cleanup = async () => {
    const active = (await h.snapshot()).hardwareAgent?.activeRunId;
    if (active) {
      try { await h.invoke('hardwareAgentStop', active); }
      catch (error) { if ((await h.snapshot()).hardwareAgent?.activeRunId) throw error; }
    }
    await h.cleanup();
  };
  return { h, session, embedded, cleanup };
}

test('offline real-main start establishes the trusted owner before controller admission and sends once on restricted transport', async () => {
  const f = await fixture();
  try {
    const normalSends = f.h.engine.sendCalls;
    const run = await f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction; never real hardware', 'gpt-6.1-sol');
    assert.equal(run.taskId, f.session.taskId); assert.equal(run.sessionId, f.session.id); assert.equal(run.model, 'gpt-6.1-sol');
    assert.equal(run.threadId, 'hardware-thread-1'); assert.equal(run.active, true);
    assert.equal(f.h.engine.state, 'stopped'); assert.equal(f.h.engine.sendCalls, normalSends);
    assert.equal(f.h.restrictedEngine!.startCalls, 1); assert.equal(f.h.restrictedEngine!.sendCalls, 1);
    assert.deepEqual(f.embedded.calls.filter(x => x === 'configure'), ['configure']);
    assert.equal((await f.h.snapshot()).hardware.modeActive, true); assert.deepEqual(f.embedded.value.operations, []);
  } finally { await f.cleanup(); }
});

test('offline real-main rejects wrong model and nonfresh software sessions without starting restricted transport', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'other-model'), /MODEL_NOT_PINNED/);
    assert.equal(f.embedded.calls.includes('configure'), false);
    await f.h.invoke('send', f.session.id, 'Offline ordinary engine turn');
    await assert.rejects(f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol'), /空白会话|历史/);
    assert.equal(f.embedded.calls.includes('configure'), false); assert.deepEqual(f.embedded.value.operations, []);
  } finally { await f.cleanup(); }
});

test('offline real-main gates all ordinary and manual execution paths while restricted planning owns the task', async () => {
  const f = await fixture();
  try {
    await f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol');
    const starts = f.h.engine.startCalls, sends = f.h.engine.sendCalls;
    for (const [name, args] of [
      ['connect', []], ['send', [f.session.id, 'must not execute']], ['steer', [f.session.id, 'must not execute']],
      ['interrupt', [f.session.id]], ['approve', [1, 'forged', 'accept']], ['setAcceptance', [f.session.taskId, []]],
      ['runAcceptance', [f.session.taskId, 'anything', 'key']], ['runSnapshotBuild', [f.session.taskId, 'key']],
      ['hardwareBuild', [f.session.taskId, 'key']], ['hardwareInspect', [f.session.taskId, 'key']],
      ['hardwareFlash', [f.session.taskId, 'key']], ['hardwareVerify', [f.session.taskId, 'key']], ['hardwareLeaveMode', []],
    ] as Array<[string, unknown[]]>) await assert.rejects(f.h.invoke(name, ...args), /HARDWARE_AGENT_ACTIVE/);
    assert.equal(f.h.engine.startCalls, starts); assert.equal(f.h.engine.sendCalls, sends);
    assert.equal(f.embedded.calls.includes('build'), false); assert.equal(f.embedded.calls.includes('inspect'), false);
    assert.equal((await f.h.snapshot()).hardwareAgent?.runs.length, 1);
  } finally { await f.cleanup(); }
});

test('offline real-main passes actual dynamic call identity to the controller', async () => {
  const f = await fixture();
  try {
    const run = await f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol');
    const result = await f.h.restrictedEngine!.toolCall('embedded_status');
    assert.equal(result.ok, true); assert.equal(result.runId, run.runId); assert.equal(result.callId, 'fixture-embedded_status');
    const view = (await f.h.snapshot()).hardwareAgent!.runs[0];
    assert.equal(view.turnId, 'hardware-turn-1'); assert.equal(view.calls[0].callId, result.callId);
    assert.equal(f.embedded.calls.includes('build'), false); assert.deepEqual(f.embedded.value.operations, []);
  } finally { await f.cleanup(); }
});

test('offline real-main rejects each stale context on a fresh controlled session without device execution', async () => {
  for (const context of [{ generation: 99 }, { threadId: 'foreign' }, { turnId: 'old-turn' }]) {
    const f = await fixture();
    try {
      await f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol');
      await f.h.restrictedEngine!.toolCall('embedded_status');
      await assert.rejects(f.h.restrictedEngine!.toolCall('embedded_status', {}, context), /binding mismatch|context mismatch/);
      assert.equal(f.embedded.calls.includes('build'), false); assert.deepEqual(f.embedded.value.operations, []);
    } finally { await f.cleanup(); }
  }
});

test('offline real-main refuses executable, path, authorization and unknown tool arguments before dispatch', async () => {
  for (const [tool, args] of [['embedded_build', { confirmed: true }], ['embedded_build', { executable: 'powershell.exe' }],
    ['embedded_build', { path: '..\\outside' }], ['embedded_build', []], ['shell', {}]] as Array<[string, unknown]>) {
    const f = await fixture();
    try {
      await f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol');
      await assert.rejects(f.h.restrictedEngine!.toolCall(tool, args), /empty argument|outside the fixed hardware-agent allowlist/);
      assert.equal(f.embedded.calls.includes('build'), false); assert.deepEqual(f.embedded.value.operations, []);
    } finally { await f.cleanup(); }
  }
});

test('offline real-main keeps admission gated until the ordinary engine stop is actually acknowledged', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    f.h.engine.stopBehavior = () => new Promise<void>(resolve => { release = resolve; });
    const starting = f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol');
    await until(() => f.h.engine.state === 'stopping');
    await assert.rejects(f.h.invoke('hardwareAgentStart', f.session.taskId, 'second', 'gpt-6.1-sol'), /HARDWARE_AGENT_ACTIVE/);
    await assert.rejects(f.h.invoke('send', f.session.id, 'must not execute'), /HARDWARE_AGENT_ACTIVE/);
    assert.equal(f.embedded.calls.includes('configure'), false);
    release(); await starting;
    assert.equal(f.h.restrictedEngine!.startCalls, 1); assert.equal(f.h.restrictedEngine!.sendCalls, 1);
  } finally { release?.(); await f.cleanup(); }
});

test('offline real-main ignores terminal events from a stale generation, thread or turn', async () => {
  const f = await fixture();
  try {
    const run = await f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol');
    const engine = f.h.restrictedEngine!;
    await engine.toolCall('embedded_status');
    const turnId = (await f.h.snapshot()).sessions.find(item => item.id === f.session.id)!.turnId!;
    for (const [generation, threadId, eventTurnId] of [[99, run.threadId, turnId], [run.generation, 'foreign-thread', turnId],
      [run.generation, run.threadId, 'foreign-turn']] as Array<[number, string, string]>) {
      engine.options.onEvent({ generation, sequence: 100, method: 'turn/completed', params: { threadId, turn: { id: eventTurnId, status: 'completed' } } });
      assert.equal((await f.h.snapshot()).hardwareAgent?.activeRunId, run.runId);
      assert.equal(engine.stopCalls, 0);
    }
    assert.equal((await f.h.snapshot()).sessions.find(item => item.id === f.session.id)?.status, 'running');
  } finally { await f.cleanup(); }
});

test('offline real-main deduplicates terminal finalization and keeps the gate until captured engine stop completes', async () => {
  const f = await fixture(); let release!: () => void;
  try {
    const run = await f.h.invoke('hardwareAgentStart', f.session.taskId, 'Offline instruction', 'gpt-6.1-sol');
    const engine = f.h.restrictedEngine!;
    await engine.toolCall('embedded_status');
    const turnId = (await f.h.snapshot()).sessions.find(item => item.id === f.session.id)!.turnId!;
    engine.stopBehavior = () => new Promise<void>(resolve => { release = resolve; });
    engine.emit('turn/completed', { threadId: run.threadId, turn: { id: turnId, status: 'completed' } });
    await until(() => engine.state === 'stopping');
    engine.emit('turn/completed', { threadId: run.threadId, turn: { id: turnId, status: 'completed' } });
    assert.equal((await f.h.snapshot()).hardwareAgent?.activeRunId, run.runId); assert.equal(engine.stopCalls, 1);
    await assert.rejects(f.h.invoke('send', f.session.id, 'must not execute'), /HARDWARE_AGENT_ACTIVE/);
    release(); await until(() => engine.state === 'stopped');
    engine.stopBehavior = async () => {};
    const completed = await f.h.snapshot();
    assert.equal(completed.hardwareAgent?.activeRunId, undefined);
    assert.equal(completed.hardwareAgent?.runs[0].status, 'needs_attention', 'A terminal model without the workflow is not a hardware success');
    assert.equal(completed.sessions.find(item => item.id === f.session.id)?.status, 'needs_attention');
    engine.emit('turn/completed', { threadId: run.threadId, turn: { id: turnId, status: 'completed' } });
    assert.equal(engine.stopCalls, 1);
  } finally { release?.(); if (f.h.restrictedEngine) f.h.restrictedEngine.stopBehavior = async () => {}; await f.cleanup(); }
});
