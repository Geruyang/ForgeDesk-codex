import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { HardwareAgentBinding, HardwareAgentToolContext, HardwareAgentToolName } from '../../shared/hardware-agent.js';
import { durableJson } from './files.js';
import { HardwareAgentController, type HardwareAgentControllerOptions } from './model-controller.js';
import { GESTURESCREEN_PROFILE as PROFILE, GESTURESCREEN_PROFILE_SHA256 as PROFILE_HASH } from './profile.js';
import type { EmbeddedBuild, EmbeddedOperation, EmbeddedStatus } from './types.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sequence: HardwareAgentToolName[] = ['embedded_build', 'embedded_inspect', 'embedded_request_flash', 'embedded_verify', 'embedded_export'];
const hash = (character: string) => character.repeat(64);

async function fixture() {
  const base = path.resolve('output/hardware/2026-10-16/hardware-model-controller-fixtures');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-'));
  let now = Date.parse('2026-10-15T00:00:00Z');
  let id = 0;
  const calls: string[] = [];
  const binding: HardwareAgentBinding = { runId: 'run1', sessionId: 'session1', taskId: 'task1', model: 'offline-fixture',
    generation: 3, threadId: 'thread1', instruction: 'Fixed target offline test' };
  const state: EmbeddedStatus = { taskId: 'task1', configured: true, hardwareAvailable: true,
    profileId: PROFILE.id, profileSha256: PROFILE_HASH, operations: [], limitation: 'Offline fixture' };
  const artifact: EmbeddedBuild = { id: 'artifact1', buildId: hash('1'), hexSha256: hash('2'), axfSha256: hash('3'),
    sourceSha256: hash('4'), profileSha256: PROFILE_HASH, hexPath: path.join(root, 'never-open.hex'), axfPath: path.join(root, 'never-open.axf'),
    createdAt: new Date(now).toISOString(), sourceRoot: root, projectSourceBefore: hash('4'), projectSourceAfter: hash('4'),
    snapshotSourceBefore: hash('5'), snapshotSourceAfter: hash('5'), files: [], toolHashes: {}, templateSha256: hash('6'),
    logPath: path.join(root, 'never-open.log'), logSha256: hash('7'), processExit: 0 };
  function operation(kind: EmbeddedOperation['kind'], requestKey: string, status: EmbeddedOperation['status'] = 'succeeded') {
    const op: EmbeddedOperation = { id: `op${++id}`, kind, requestKey, argsDigest: hash('a'), nonce: hash('b'), status,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), processExited: status === 'succeeded',
      ...(kind !== 'inspect' ? { artifactId: artifact.id } : {}) };
    if (kind === 'inspect') op.receipt = JSON.stringify({ backup: { sha256: hash('c'), bytes: 1048576, doubleReadMatch: true } });
    state.operations.push(op); return op;
  }
  const snapshot = () => structuredClone(state);
  const options: HardwareAgentControllerOptions = { dataDir: path.join(root, 'state'), exportDirectory: path.join(root, 'exports'),
    embedded: {
      async status() { return snapshot(); },
      async build(_task, key) { calls.push('build'); operation('build', key); state.artifact = structuredClone(artifact); return snapshot(); },
      async inspect(_task, key) { calls.push('inspect'); operation('inspect', key); state.grant = undefined; return snapshot(); },
      async verify(_task, key) { calls.push('verify'); operation('verify', key); return snapshot(); },
      async export(_task, destination) { calls.push('export'); return { path: destination, sha256: hash('d') }; },
    },
    async requestFlash(_task, key, signal) {
      calls.push('native'); assert.equal(signal.aborted, false);
      const op = operation('flash', key);
      state.grant = { id: 'grant1', taskId: 'task1', artifactId: artifact.id, buildId: artifact.buildId,
        hexSha256: artifact.hexSha256, axfSha256: artifact.axfSha256, sourceSha256: artifact.sourceSha256,
        profileId: PROFILE.id, profileSha256: PROFILE_HASH, backupSha256: hash('c'),
        identity: { probeSerial: PROFILE.probeSerial, uid: PROFILE.uid, chipId: PROFILE.chipId, flashKiB: PROFILE.flashKiB, cdcSerial: PROFILE.cdcSerial },
        scope: 'flash-and-verify-once', approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString(), consumedBy: op.id };
      calls.push('flash'); return snapshot();
    },
    checkRuntime: async () => {}, assertOwner: () => {}, now: () => now,
  };
  const controller = new HardwareAgentController(options);
  const context = (callId = `call${++id}`, overrides: Partial<HardwareAgentToolContext> = {}): HardwareAgentToolContext =>
    ({ runId: binding.runId, sessionId: binding.sessionId, taskId: binding.taskId, generation: binding.generation,
      threadId: binding.threadId, turnId: 'turn1', callId, ...overrides });
  const run = (tool: HardwareAgentToolName, callId?: string) => controller.executeTool(context(callId), tool, {});
  const through = async (count: number) => { for (const tool of sequence.slice(0, count)) assert.equal((await run(tool)).ok, true, tool); };
  return { root, state, artifact, binding, controller, options, calls, operation, snapshot, context, run, through,
    advance: (milliseconds: number) => { now += milliseconds; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('host-bound six-tool workflow records native approval and operation correlation without model paths', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding);
    const status = await f.run('embedded_status', 'status1'); assert.equal(status.result, 'status');
    await f.through(5);
    const view = (await f.controller.status('run1'))!;
    assert.equal(view.status, 'completed'); assert.equal(view.active, false); assert.equal(view.hardwareBusy, false);
    assert.equal(view.nativeApproval, 'approved'); assert.equal(view.turnId, 'turn1');
    assert.equal(view.model, 'offline-fixture'); assert.equal(view.calls.length, 6);
    assert.deepEqual(f.calls, ['build', 'inspect', 'native', 'flash', 'verify', 'export']);
    assert.equal(view.calls.filter(call => call.operationId).length, 4);
    assert.ok(view.calls.filter(call => call.requestKey).every(call => call.requestKey!.startsWith('agent-')));
    assert.deepEqual(view.export, { path: path.join(f.options.exportDirectory, 'run1'), sha256: hash('d') });
    assert.equal(JSON.stringify(view.artifact).includes('never-open'), false);
    const disk = JSON.parse(await readFile(path.join(f.options.dataDir, 'hardware-agent', 'run1.json'), 'utf8'));
    assert.equal(disk.payload.calls.length, 6); assert.match(disk.mac, /^[a-f0-9]{64}$/);
  } finally { await f.cleanup(); }
});

test('same call and repeated phase return the same receipt without invoking another operation', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding);
    const first = await f.run('embedded_build', 'build1');
    assert.deepEqual(await f.run('embedded_build', 'build1'), first);
    const repeated = await f.run('embedded_build', 'build2');
    assert.equal(repeated.operation!.id, first.operation!.id); assert.equal(repeated.callId, 'build2');
    assert.deepEqual(f.calls, ['build']);
    const view = (await f.controller.status('run1'))!;
    assert.equal(view.calls.length, 2); assert.equal(view.calls[1].status, 'replayed');
    assert.equal(view.calls[1].replayedFromCallId, 'build1');
  } finally { await f.cleanup(); }
});

test('concurrent duplicate call waits for one operation and does not create another intent', async () => {
  const f = await fixture();
  try {
    await f.controller.start({ ...f.binding, turnId: 'turn1' });
    const entered = deferred(); const finish = deferred(); const original = f.options.embedded.build;
    f.options.embedded.build = async (...args) => { entered.resolve(); await finish.promise; return original(...args); };
    const first = f.run('embedded_build', 'build1'); await entered.promise;
    const second = f.run('embedded_build', 'build1'); finish.resolve();
    assert.deepEqual(await first, await second); assert.deepEqual(f.calls, ['build']);
    assert.equal((await f.controller.status('run1'))!.calls.length, 1);
  } finally { await f.cleanup(); }
});

test('reusing a call ID for another tool closes planning without executing that tool', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.run('embedded_build', 'call1');
    await assert.rejects(f.run('embedded_inspect', 'call1'), /reused/);
    assert.equal((await f.controller.status('run1'))!.status, 'needs_attention'); assert.deepEqual(f.calls, ['build']);
  } finally { await f.cleanup(); }
});

for (const [label, args] of Object.entries({ path: { path: 'C:/arbitrary.hex' }, uid: { uid: 'other' }, approval: { approved: true },
  command: { command: 'anything' }, array: [], null: null, string: '{}', prototype: new Date(), symbol: { [Symbol('hidden')]: true } })) {
  test(`tool rejects ${label} arguments before invoking trusted host`, async () => {
    const f = await fixture();
    try {
      await f.controller.start(f.binding);
      await assert.rejects(f.controller.executeTool(f.context(), 'embedded_build', args), /empty argument/);
      assert.deepEqual(f.calls, []); assert.equal((await f.controller.status('run1'))!.status, 'needs_attention');
      assert.equal((await f.run('embedded_build')).ok, false); assert.deepEqual(f.calls, []);
    } finally { await f.cleanup(); }
  });
}

for (const [field, value] of Object.entries({ runId: 'missing', sessionId: 'other', taskId: 'task2', generation: 4, threadId: 'thread2', turnId: 'turn2' })) {
  test(`host binding rejects changed ${field}`, async () => {
    const f = await fixture();
    try {
      await f.controller.start(f.binding); await f.controller.bindTurn('run1', { generation: 3, threadId: 'thread1', turnId: 'turn1' });
      await assert.rejects(f.controller.executeTool(f.context('call1', { [field]: value }), 'embedded_build', {}), /context mismatch|Unknown hardware/);
      assert.deepEqual(f.calls, []);
    } finally { await f.cleanup(); }
  });
}

test('turn binding is single-assignment and cannot be switched', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding);
    await f.controller.bindTurn('run1', { generation: 3, threadId: 'thread1', turnId: 'turn1' });
    await f.controller.bindTurn('run1', { generation: 3, threadId: 'thread1', turnId: 'turn1' });
    await assert.rejects(f.controller.bindTurn('run1', { generation: 3, threadId: 'thread1', turnId: 'turn2' }), /binding mismatch/);
    await assert.rejects(f.controller.bindTurn('run1', { generation: 4, threadId: 'thread1', turnId: 'turn1' }), /binding mismatch/);
  } finally { await f.cleanup(); }
});

test('concurrent starts reserve the only owner before awaiting host checks', async () => {
  const f = await fixture();
  try {
    await f.controller.recover();
    const entered = deferred(); const gate = deferred();
    f.options.checkRuntime = async () => { entered.resolve(); await gate.promise; };
    const first = f.controller.start(f.binding); await entered.promise;
    await assert.rejects(f.controller.start({ ...f.binding, runId: 'run2' }), /active or held/);
    gate.resolve(); await first;
    await assert.rejects(f.controller.start({ ...f.binding, runId: 'run3' }), /active or held/);
  } finally { await f.cleanup(); }
});

test('out-of-order action ends planning and only status remains usable', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding);
    assert.equal((await f.run('embedded_request_flash')).ok, false);
    assert.equal((await f.run('embedded_build')).ok, false); assert.deepEqual(f.calls, []);
    assert.equal((await f.run('embedded_status')).result, 'status');
    assert.equal((await f.controller.status('run1'))!.status, 'needs_attention');
  } finally { await f.cleanup(); }
});

test('approval expiry prevents verification without dispatching verify', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(3); f.advance(300001);
    const result = await f.run('embedded_verify'); assert.equal(result.ok, false); assert.match(result.message!, /expired/);
    assert.equal(f.calls.includes('verify'), false); assert.equal((await f.controller.status('run1'))!.nativeApproval, 'expired');
    assert.equal((await f.run('embedded_export')).ok, false);
  } finally { await f.cleanup(); }
});

for (const mutation of ['artifact', 'grant', 'identity', 'backup', 'axf', 'flashOperation'] as const) {
  test(`verify refuses a changed ${mutation} approval chain`, async () => {
    const f = await fixture();
    try {
      await f.controller.start(f.binding); await f.through(3);
      if (mutation === 'artifact') f.state.artifact!.hexSha256 = hash('f');
      if (mutation === 'grant') f.state.grant!.id = 'other-grant';
      if (mutation === 'identity') f.state.grant!.identity.uid = 'other-board';
      if (mutation === 'backup') f.state.grant!.backupSha256 = hash('e');
      if (mutation === 'axf') f.state.grant!.axfSha256 = hash('e');
      if (mutation === 'flashOperation') f.state.operations.find(op => op.kind === 'flash')!.artifactId = 'other-artifact';
      assert.equal((await f.run('embedded_verify')).ok, false); assert.equal(f.calls.includes('verify'), false);
    } finally { await f.cleanup(); }
  });
}

for (const change of ['expiry', 'grant'] as const) {
  test(`verification completion rechecks ${change} instead of upgrading a stale approval chain`, async () => {
    const f = await fixture();
    try {
      await f.controller.start(f.binding); await f.through(3);
      const original = f.options.embedded.verify;
      f.options.embedded.verify = async (...args) => {
        await original(...args);
        if (change === 'expiry') f.advance(300001); else f.state.grant!.id = 'replaced-during-verify';
        return f.snapshot();
      };
      const result = await f.run('embedded_verify');
      assert.equal(result.ok, false); assert.equal((await f.controller.status('run1'))!.status, 'needs_attention');
      assert.equal((await f.run('embedded_export')).ok, false); assert.equal(f.calls.includes('export'), false);
    } finally { await f.cleanup(); }
  });
}

test('native decline is audited as failure with no flash and no subsequent actions', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(2);
    f.options.requestFlash = async () => { f.calls.push('declined'); return f.snapshot(); };
    const result = await f.run('embedded_request_flash'); assert.equal(result.ok, false); assert.equal(result.result, 'failed');
    assert.equal((await f.controller.status('run1'))!.nativeApproval, 'cancelled');
    assert.equal((await f.run('embedded_verify')).ok, false); assert.equal(f.calls.includes('flash'), false);
  } finally { await f.cleanup(); }
});

test('unknown flash preserves held state and same key is never dispatched again', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(2);
    f.options.requestFlash = async (_task, key) => {
      f.calls.push('unknown-flash'); const op = f.operation('flash', key, 'unknown');
      op.processExited = true; op.detail = 'Target result is unknown even though worker exited'; return f.snapshot();
    };
    const result = await f.run('embedded_request_flash', 'flash1');
    assert.equal(result.result, 'unknown'); assert.equal(result.operation!.status, 'unknown');
    assert.equal((await f.controller.status('run1'))!.hardwareBusy, true);
    await f.run('embedded_request_flash', 'flash1'); await f.run('embedded_request_flash', 'flash2'); await f.run('embedded_verify');
    assert.equal(f.calls.filter(call => call === 'unknown-flash').length, 1);
    assert.equal(f.calls.includes('verify'), false);
    await assert.rejects(f.controller.start({ ...f.binding, runId: 'run2' }), /active or held/);
  } finally { await f.cleanup(); }
});

test('stop aborts a pending native dialog but retains owner until callback settles', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(2);
    const entered = deferred(); const cancelled = deferred(); const finish = deferred();
    f.options.requestFlash = async (_task, _key, signal) => {
      entered.resolve(); signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      await finish.promise; throw new Error('Native dialog cancelled before approval');
    };
    const pending = f.run('embedded_request_flash'); await entered.promise;
    const stopped = await f.controller.stop('run1'); await cancelled.promise;
    assert.equal(stopped.active, false); assert.equal(stopped.hardwareBusy, true);
    await assert.rejects(f.controller.start({ ...f.binding, runId: 'run2' }), /active or held/);
    finish.resolve(); assert.equal((await pending).result, 'stopped');
    const settled = (await f.controller.status('run1'))!;
    assert.equal(settled.hardwareBusy, false); assert.equal(settled.nativeApproval, 'cancelled');
    assert.equal(f.calls.includes('flash'), false);
  } finally { await f.cleanup(); }
});

test('stop after approved hardware dispatch never aborts worker and waits for exact result', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(2);
    const entered = deferred(); const finish = deferred(); const original = f.options.requestFlash;
    let signal!: AbortSignal;
    f.options.requestFlash = async (task, key, passedSignal) => {
      signal = passedSignal; await original(task, key, signal);
      const flash = f.state.operations.at(-1)!; flash.status = 'running'; flash.processExited = false; entered.resolve();
      await finish.promise; flash.status = 'succeeded'; flash.processExited = true; return f.snapshot();
    };
    const pending = f.run('embedded_request_flash'); await entered.promise;
    const stopped = await f.controller.stop('run1');
    assert.equal(signal.aborted, false); assert.equal(stopped.nativeApproval, 'approved'); assert.equal(stopped.hardwareBusy, true);
    finish.resolve(); assert.equal((await pending).ok, true);
    const view = (await f.controller.status('run1'))!;
    assert.equal(view.status, 'stopped'); assert.equal(view.hardwareBusy, false);
    assert.equal((await f.run('embedded_verify')).ok, false); assert.equal(f.calls.includes('verify'), false);
  } finally { await f.cleanup(); }
});

for (const point of ['intent', 'owner', 'runtime', 'status'] as const) {
  for (const tool of ['embedded_build', 'embedded_inspect', 'embedded_verify', 'embedded_export'] as const) {
    if (point === 'status' && tool === 'embedded_build') continue;
    test(`stop during ${tool} ${point} await prevents dispatch`, async () => {
      const f = await fixture();
      try {
        await f.controller.start({ ...f.binding, turnId: 'turn1' });
        await f.through(sequence.indexOf(tool));
        const entered = deferred(); const release = deferred();
        let first = true;
        async function gate() { if (first) { first = false; entered.resolve(); await release.promise; } }
        if (point === 'intent') {
          const internals = f.controller as unknown as { persist: typeof durableJson };
          internals.persist = async (...args) => { await gate(); return durableJson(...args); };
        }
        if (point === 'owner') f.options.assertOwner = gate;
        if (point === 'runtime') f.options.checkRuntime = gate;
        if (point === 'status') f.options.embedded.status = async () => { await gate(); return f.snapshot(); };
        const before = f.calls.length;
        const pending = f.run(tool); await entered.promise;
        const stopping = f.controller.stop('run1');
        release.resolve(); await stopping; const result = await pending;
        assert.equal(result.ok, false); assert.equal(f.calls.length, before);
        assert.equal((await f.controller.status('run1'))!.hardwareBusy, false);
      } finally { await f.cleanup(); }
    });
  }
}

test('pre-dispatch intent persistence failure prevents native callback and all later writes', async () => {
  const f = await fixture();
  try {
    await f.controller.start({ ...f.binding, turnId: 'turn1' }); await f.through(2);
    const internals = f.controller as unknown as { persist: typeof durableJson };
    internals.persist = async () => { throw new Error('injected durable intent failure'); };
    assert.equal((await f.run('embedded_request_flash')).ok, false);
    assert.equal(f.calls.includes('native'), false); assert.equal((await f.controller.status('run1'))!.status, 'needs_attention');
    await assert.rejects(f.run('embedded_verify'), /durable intent failure/); assert.equal(f.calls.includes('verify'), false);
  } finally { await f.cleanup(); }
});

test('post-dispatch persistence failure never upgrades the run or repeats a completed side effect', async () => {
  const f = await fixture();
  try {
    await f.controller.start({ ...f.binding, turnId: 'turn1' });
    const build = f.options.embedded.build;
    f.options.embedded.build = async (...args) => {
      const state = await build(...args);
      (f.controller as unknown as { persist: typeof durableJson }).persist = async () => { throw new Error('terminal write failed'); };
      return state;
    };
    const result = await f.run('embedded_build', 'build1'); assert.equal(result.ok, false);
    assert.equal((await f.controller.status('run1'))!.status, 'needs_attention');
    await f.run('embedded_build', 'build1'); assert.deepEqual(f.calls, ['build']);
    const reopened = new HardwareAgentController(f.options); await reopened.recover();
    assert.equal((await reopened.status('run1'))!.status, 'needs_attention');
    assert.equal((await reopened.executeTool(f.context('build2'), 'embedded_build', {})).ok, false); assert.deepEqual(f.calls, ['build']);
  } finally { await f.cleanup(); }
});

test('settlement persistence failure cannot return a successful tool result', async () => {
  const f = await fixture();
  try {
    await f.controller.start({ ...f.binding, turnId: 'turn1' });
    const original = f.options.embedded.build;
    f.options.embedded.build = async (...args) => {
      const value = await original(...args); let writes = 0;
      (f.controller as unknown as { persist: typeof durableJson }).persist = async (...writeArgs) => {
        if (++writes === 2) throw new Error('settlement write failed');
        return durableJson(...writeArgs);
      };
      return value;
    };
    const result = await f.run('embedded_build');
    assert.equal(result.ok, false); assert.equal(result.result, 'unknown'); assert.match(result.message!, /settlement/);
    assert.equal((await f.controller.status('run1'))!.status, 'needs_attention'); assert.deepEqual(f.calls, ['build']);
  } finally { await f.cleanup(); }
});

test('restart closes unfinished planning and never resumes or replays saved calls', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(1);
    const reopened = new HardwareAgentController(f.options); await reopened.recover();
    const view = (await reopened.status('run1'))!;
    assert.equal(view.status, 'needs_attention'); assert.equal(view.active, false); assert.match(view.failure!, /restarted/);
    assert.equal((await reopened.executeTool(f.context('newbuild'), 'embedded_build', {})).ok, false);
    assert.deepEqual(f.calls, ['build']);
    await assert.rejects(reopened.start(f.binding), /already exists/);
  } finally { await f.cleanup(); }
});

test('tampered durable run fails integrity before any side effect', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding);
    const file = path.join(f.options.dataDir, 'hardware-agent', 'run1.json');
    const envelope = JSON.parse(await readFile(file, 'utf8')); envelope.payload.step = 2;
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(new HardwareAgentController(f.options).recover(), /integrity/); assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

for (const gate of ['runtime', 'owner'] as const) {
  test(`${gate} denial before dispatch ends planning without invoking host action`, async () => {
    const f = await fixture();
    try {
      await f.controller.start(f.binding);
      if (gate === 'runtime') f.options.checkRuntime = async () => { throw new Error('runtime rejected'); };
      else f.options.assertOwner = async () => { throw new Error('owner rejected'); };
      assert.equal((await f.run('embedded_build')).ok, false); assert.deepEqual(f.calls, []);
      assert.equal((await f.controller.status('run1'))!.status, 'needs_attention');
    } finally { await f.cleanup(); }
  });
}

test('premature turn end stops planning without silently creating a second turn', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(1);
    const view = await f.controller.turnEnded('run1'); assert.equal(view.status, 'needs_attention');
    assert.equal((await f.run('embedded_inspect')).ok, false); assert.deepEqual(f.calls, ['build']);
  } finally { await f.cleanup(); }
});

test('quiescence distinguishes a settled unknown lock from planning and checkpoint never upgrades it', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(2);
    f.options.requestFlash = async (_task, key) => { f.calls.push('unknown-flash'); f.operation('flash', key, 'unknown'); return f.snapshot(); };
    await f.run('embedded_request_flash');
    const quiet = await f.controller.quiescence('run1');
    assert.equal(quiet.quiescent, true); assert.equal(quiet.active, false); assert.equal(quiet.stopRequested, true);
    assert.equal(quiet.inflight, false); assert.equal(quiet.nativePending, false); assert.equal(quiet.persistencePending, false);
    assert.equal((await f.controller.status('run1'))!.hardwareBusy, true);
    await assert.rejects(f.controller.checkpointRecovery('run1'), /STILL_HELD/);
    f.state.operations.at(-1)!.processExited = true; f.state.operations.at(-1)!.recoveredAt = new Date().toISOString();
    const recovered = await f.controller.checkpointRecovery('run1');
    assert.equal(recovered.status, 'needs_attention'); assert.equal(recovered.hardwareBusy, false);
    assert.equal(f.state.operations.at(-1)!.status, 'unknown');
    const disk = JSON.parse(await readFile(path.join(f.options.dataDir, 'hardware-agent/run1.json'), 'utf8'));
    assert.equal(disk.payload.status, 'needs_attention'); assert.equal(disk.payload.hardwareBusy, false);
    assert.equal((await f.run('embedded_verify')).ok, false); assert.equal(f.calls.includes('verify'), false);
  } finally { await f.cleanup(); }
});

test('failed controller recovery checkpoint does not resume planning or claim success', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.controller.turnEnded('run1');
    (f.controller as unknown as { persist: typeof durableJson }).persist = async () => { throw new Error('Injected checkpoint storage failure'); };
    await assert.rejects(f.controller.checkpointRecovery('run1'), /checkpoint storage failure/);
    const view = (await f.controller.status('run1'))!;
    assert.equal(view.status, 'needs_attention'); assert.equal(view.active, false); assert.equal(view.stopRequested, true);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test('final settlement remains explicitly nonquiescent and bars another start even after hardwareBusy clears', async () => {
  const f = await fixture();
  try {
    await f.controller.start(f.binding); await f.through(4);
    const entered = deferred(); const release = deferred();
    const internals = f.controller as unknown as { persist: typeof durableJson };
    internals.persist = async (file, value, ...args) => {
      const record = (value as { payload: { status: string; hardwareBusy: boolean } }).payload;
      if (record.status === 'completed' && record.hardwareBusy === false) { entered.resolve(); await release.promise; }
      return durableJson(file, value, ...args);
    };
    const pending = f.run('embedded_export'); await entered.promise;
    const quiet = await f.controller.quiescence('run1');
    assert.equal(quiet.quiescent, false); assert.equal(quiet.inflight, true); assert.equal(quiet.persistencePending, true);
    await assert.rejects(f.controller.start({ ...f.binding, runId: 'run2' }), /active or held/);
    release.resolve(); await pending;
    assert.equal((await f.controller.quiescence('run1')).quiescent, true);
  } finally { await f.cleanup(); }
});
