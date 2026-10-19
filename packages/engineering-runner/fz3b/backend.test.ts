import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Fz3bBackend, type Fz3bBackendOptions } from './backend.js';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bProfileSha256, fz3bCanonicalJson } from './profile.js';
import { fz3bReleasedInspectReconciliation } from './reconciliation.js';
import type { Fz3bAdapterContext, Fz3bBinding, Fz3bBuildReceipt, Fz3bIdentity, Fz3bInspectReceipt,
  Fz3bReceiptBase, Fz3bSemanticFixture, Fz3bSemanticReceipt, Fz3bToolContext, Fz3bToolName,
  Fz3bInspectReconciliationContext, Fz3bInspectReconciliationProof, Fz3bInspectReconciliationFinalization } from './types.js';

const hash = (letter: string) => letter.repeat(64);
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const canonicalSha = (value: unknown) => sha(Buffer.from(fz3bCanonicalJson(value)));
const actions: Fz3bToolName[] = ['fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic', 'fz3b_semantic', 'fz3b_export'];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture() {
  const base = path.resolve('output/hardware/2026-10-16-next/product/backend-fixtures');
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-'));
  const input: Fz3bSemanticFixture = { id: 'fz3b-pillow-scene-v1', manifestSha256: FZ3B_PROFILE.semanticManifestSha256, queriesSha256: FZ3B_PROFILE.queriesSha256,
    imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256,
    width: 914, height: 512, queryCount: 4, embeddingDimensions: 512, expectedLabel: 'pillow',
    queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: structuredClone(FZ3B_PROFILE.encoderIdentity) };
  const identity: Fz3bIdentity = { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId,
    appRoot: FZ3B_PROFILE.appRoot, platform: 'A0005', contractId: FZ3B_PROFILE.encoderIdentity.contractId,
    deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256, existingPlSha256: FZ3B_PROFILE.existingPlSha256,
    transport: 'pinned-ssh', helloAuthenticated: false };
  let now = Date.parse('2026-10-16T00:00:00Z'), count = 0;
  const calls: string[] = [], contexts: Fz3bAdapterContext[] = [];
  const knownContexts = new Map<string, Fz3bAdapterContext>();
  const packageBytes = Buffer.from('Offline fake package bytes, not a production archive');
  const packageManifest = Buffer.from('{"offline":"fake-package-manifest"}\n');
  const publicBytes = (context: Fz3bAdapterContext) => Buffer.from(JSON.stringify({ operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256 }) + '\n');
  const binding: Fz3bBinding = { runId: 'run1', sessionId: 'session1', taskId: 'task1', model: 'gpt-6.1-sol', generation: 17, threadId: 'thread1' };
  const common = (context: Fz3bAdapterContext): Fz3bReceiptBase => {
    knownContexts.set(context.operationId, structuredClone(context));
    return { schemaVersion: 1, operationId: context.operationId, nonce: context.nonce,
      profileSha256: context.profileSha256, status: 'succeeded', processExited: true, remoteQuiescent: true, remoteOutcomeUnknown: false, evidenceSha256: sha(publicBytes(context)) };
  };
  const build = (context: Fz3bAdapterContext): Fz3bBuildReceipt => ({ ...common(context), kind: 'build', sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
    fixtureManifestSha256: input.manifestSha256, queriesSha256: input.queriesSha256, imageSha256: input.imageSha256,
    newPlBuilt: false, deployed: false, packageSha256: sha(packageBytes), packageManifestSha256: sha(packageManifest) });
  const inspect = (context: Fz3bAdapterContext): Fz3bInspectReceipt => ({ ...common(context), kind: 'inspect', readOnly: true, identity: structuredClone(identity) });
  const semantic = (context: Fz3bAdapterContext): Fz3bSemanticReceipt => ({ ...common(context), kind: 'semantic', identity: structuredClone(identity), grantId: context.grant?.id,
    semantic: { jobId: `fd-semantic-${context.operationId.replaceAll('-', '')}`, frameId: 0, queryRevision: 1, completedFrames: 1, fixtureManifestSha256: input.manifestSha256,
      queriesSha256: input.queriesSha256, imageSha256: input.imageSha256, encoderIdentity: structuredClone(input.encoderIdentity),
      ranking: input.queryIds.map((id, index) => ({ id, label: id, score: 0.8 - index * 0.2 })), bestId: 'pillow', semanticInput: 'real-text-encoder',
      synthetic: false, classificationUnknown: false, threshold: 0.2, thresholdHit: true, expectedLabel: 'pillow', expectedLabelMatched: true, inferenceStopped: true, newPlLoaded: false } });
  const options: Fz3bBackendOptions = { dataDir: directory, fixture: input,
    adapter: {
      async build(context) { calls.push('build'); contexts.push(structuredClone(context)); return build(context); },
      async inspect(context) { calls.push('inspect'); contexts.push(structuredClone(context)); return inspect(context); },
      async semantic(context) { calls.push('semantic'); contexts.push(structuredClone(context)); return semantic(context); },
      async readPublicEvidence(operationId, evidenceSha256) {
        const context = knownContexts.get(operationId)!; const bytes = publicBytes(context);
        assert.equal(sha(bytes), evidenceSha256);
        return [{ name: 'evidence.json', bytes, sha256: evidenceSha256 }, ...(context.artifact ? [] : [
          { name: 'ps-acceptance.tar' as const, bytes: packageBytes, sha256: sha(packageBytes) },
          { name: 'package-manifest.json' as const, bytes: packageManifest, sha256: sha(packageManifest) },
        ])];
      },
    },
    async requestSemantic(preview, signal) { calls.push('native'); assert.equal(signal.aborted, false); assert.equal(preview.artifactId.length, 64); return true; },
    checkRuntime: async () => {}, assertOwner: () => {}, now: () => now };
  const backend = new Fz3bBackend(options);
  const context = (callId = `call${++count}`, overrides: Partial<Fz3bToolContext> = {}): Fz3bToolContext => ({ ...binding, turnId: 'turn1', callId, ...overrides });
  const run = (name: Fz3bToolName, callId?: string) => backend.executeTool(context(callId), name, {});
  const through = async (amount: number) => { for (const name of actions.slice(0, amount)) assert.equal((await run(name)).ok, true, name); };
  const cleanup = async () => {
    const relative = path.relative(base, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  };
  return { base, directory, input, identity, binding, calls, contexts, options, backend, context, run, through,
    common, build, inspect, semantic, advance: (amount: number) => { now += amount; }, cleanup };
}

test('six fixed model tools record typed package, native-grant, semantic and checked export receipts', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding);
    assert.equal((await f.run('fz3b_status')).result, 'status');
    assert.deepEqual(f.calls, []);
    await f.through(5);
    const view = (await f.backend.status('run1'))!;
    assert.equal(view.status, 'completed');
    assert.equal(view.hardwareBusy, false);
    assert.equal(view.artifact?.kind, 'fixed-ps-fixture-package');
    assert.equal(view.artifact?.newPlBuilt, false);
    assert.equal(view.artifact?.deployed, false);
    assert.equal(view.semantic?.synthetic, false);
    assert.equal(view.semantic?.semanticInput, 'real-text-encoder');
    assert.equal(view.nativeApproval, 'approved');
    assert.equal(view.grant?.consumedBy, view.operations[2].id);
    assert.match(view.grant!.actions.join(' '), /cannot be restored/);
    assert.match(view.grant!.actions.join(' '), /loader/);
    assert.deepEqual(f.calls, ['build', 'inspect', 'native', 'semantic']);
    assert.equal((await f.backend.quiescence('run1')).quiescent, true);
    const exported = JSON.parse(await readFile(path.join(view.export!.path, 'manifest.json'), 'utf8'));
    assert.equal(exported.run.runId, view.runId);
    assert.equal(Object.keys(exported.receipts).length, 3);
    assert.equal(exported.files.length, 5);
    for (const file of exported.files) assert.equal(sha(await readFile(path.join(view.export!.path, file.path))), file.sha256);
    assert.equal(JSON.stringify(exported).includes('binding.key'), false);
    assert.equal((await new Fz3bBackend(f.options).status('run1'))?.status, 'completed');
  } finally { await f.cleanup(); }
});

test('grant creation samples the incrementing host clock once for an exact five-minute lifetime', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding);
    await f.through(2);
    const clockStart = Date.parse('2026-10-16T00:00:00Z');
    let reads = 0;
    f.options.now = () => clockStart + reads++;
    // Isolate the real grant method from unrelated lifecycle clock reads.
    const grants = f.backend as unknown as { record(id: string): unknown; grant(record: unknown): { createdAt: string; expiresAt: string } };
    const record = grants.record(f.binding.runId);
    for (let index = 0; index < 2; index++) {
      const before = reads;
      const grant = grants.grant(record);
      assert.equal(reads - before, 1, 'One host-clock observation must define both timestamps');
      assert.equal(Date.parse(grant.createdAt), clockStart + index);
      assert.equal(Date.parse(grant.expiresAt) - Date.parse(grant.createdAt), 300000);
    }
    assert.deepEqual(f.calls, ['build', 'inspect']);
  } finally { await f.cleanup(); }
});

test('fixed profile rejects changed input image, synthetic labels, encoder and arbitrary fixture fields', async () => {
  const f = await fixture();
  try {
    for (const changed of [{ imageSha256: hash('f') }, { manifestSha256: hash('f') }, { queriesSha256: hash('f') }, { queryIds: ['anything'] }, { encoderIdentity: { ...f.input.encoderIdentity, weightSha256: hash('f') } }, { command: 'ssh anything' }]) {
      assert.throws(() => new Fz3bBackend({ ...f.options, fixture: { ...f.input, ...changed } as Fz3bSemanticFixture }), /FIXTURE/);
    }
    assert.equal(fz3bProfileSha256(f.input).length, 64);
    const reordered = JSON.parse(JSON.stringify(f.input, Object.keys(f.input).sort())) as Fz3bSemanticFixture;
    const canonical = JSON.parse(JSON.stringify(f.input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort()) : value));
    assert.equal(fz3bProfileSha256(canonical), fz3bProfileSha256(f.input));
    assert.ok(reordered);
  } finally { await f.cleanup(); }
});

test('wrong model, owner, session, task, generation, thread and turn cannot dispatch', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.backend.start({ ...f.binding, model: 'other' }), /binding/);
    await f.backend.start(f.binding);
    await f.backend.bindTurn('run1', { generation: 17, threadId: 'thread1', turnId: 'turn1' });
    for (const changed of [{ sessionId: 'foreign' }, { taskId: 'foreign' }, { generation: 18 }, { threadId: 'foreign' }, { turnId: 'foreign' }]) {
      await assert.rejects(f.backend.executeTool(f.context(undefined, changed), 'fz3b_build', {}), /context/);
    }
    assert.deepEqual(f.calls, []);
    f.options.assertOwner = () => { throw new Error('foreign owner'); };
    assert.equal((await f.run('fz3b_build')).result, 'failed');
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test('model SSH, path, authorized flag and unknown tool fail before dispatch', async () => {
  for (const args of [{ command: 'ssh' }, { host: 'elsewhere' }, { path: '/etc' }, { approved: true }, [], null]) {
    const f = await fixture();
    try { await f.backend.start(f.binding); await assert.rejects(f.backend.executeTool(f.context(), 'fz3b_build', args), /empty/); assert.deepEqual(f.calls, []); }
    finally { await f.cleanup(); }
  }
  const f = await fixture();
  try { await f.backend.start(f.binding); await assert.rejects(f.backend.executeTool(f.context(), 'shell' as Fz3bToolName, {}), /allowlist/); }
  finally { await f.cleanup(); }
});

test('out-of-order semantic cannot authorize or dispatch any remote action', async () => {
  const f = await fixture();
  try { await f.backend.start(f.binding); assert.equal((await f.run('fz3b_semantic')).ok, false); assert.deepEqual(f.calls, []); }
  finally { await f.cleanup(); }
});

test('same-call and new-call duplicates are cached without a second package build', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding);
    const a = await f.run('fz3b_build', 'build-call');
    assert.deepEqual(await f.run('fz3b_build', 'build-call'), a);
    const replay = await f.run('fz3b_build', 'new-call');
    assert.equal(replay.artifact?.id, a.artifact?.id);
    assert.deepEqual(f.calls, ['build']);
    assert.equal((await f.backend.status('run1'))?.calls.at(-1)?.status, 'replayed');
    await assert.rejects(f.run('fz3b_inspect', 'build-call'), /reused/);
    assert.deepEqual(f.calls, ['build']);
  } finally { await f.cleanup(); }
});

test('in-flight duplicate waits for one worker, and stop never kills or releases it early', async () => {
  const f = await fixture();
  const started = deferred<Fz3bAdapterContext>(), finished = deferred<Fz3bBuildReceipt>();
  f.options.adapter.build = async context => { f.calls.push('build'); started.resolve(structuredClone(context)); return finished.promise; };
  try {
    await f.backend.start(f.binding);
    const pending = f.run('fz3b_build', 'same-call'); const context = await started.promise;
    const duplicate = f.run('fz3b_build', 'same-call');
    const stopped = await f.backend.stop('run1');
    assert.equal(stopped.hardwareBusy, true);
    assert.equal((await f.backend.quiescence('run1')).quiescent, false);
    finished.resolve(f.build(context));
    assert.deepEqual(await duplicate, await pending);
    assert.deepEqual(f.calls, ['build']);
    assert.equal((await f.backend.quiescence('run1')).quiescent, true);
    assert.equal((await f.backend.status('run1'))?.status, 'stopped');
  } finally { await f.cleanup(); }
});

test('cancelled and expired native confirmations cannot execute semantic', async () => {
  for (const mode of ['refused', 'expired']) {
    const f = await fixture();
    try {
      f.options.requestSemantic = async () => { if (mode === 'expired') f.advance(300001); return mode !== 'refused'; };
      await f.backend.start(f.binding); await f.through(2);
      assert.equal((await f.run('fz3b_request_semantic')).ok, false);
      assert.equal((await f.run('fz3b_semantic')).ok, false);
      assert.deepEqual(f.calls, ['build', 'inspect']);
      assert.equal((await f.backend.status('run1'))?.nativeApproval, mode === 'expired' ? 'expired' : 'cancelled');
    } finally { await f.cleanup(); }
  }
});

test('stop and turn-ended abort a native dialog and cannot dispatch semantic afterward', async () => {
  for (const stop of ['stop', 'turnEnded'] as const) {
    const f = await fixture(), opened = deferred<AbortSignal>();
    f.options.requestSemantic = (_preview, signal) => { opened.resolve(signal); return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })); };
    try {
      await f.backend.start(f.binding); await f.through(2);
      const approval = f.run('fz3b_request_semantic'); const signal = await opened.promise;
      await f.backend[stop]('run1'); assert.equal(signal.aborted, true);
      assert.equal((await approval).ok, false);
      assert.equal((await f.run('fz3b_semantic')).ok, false);
      assert.deepEqual(f.calls, ['build', 'inspect']);
      assert.equal((await f.backend.quiescence('run1')).quiescent, true);
    } finally { await f.cleanup(); }
  }
});

test('expiry after confirmation but before semantic blocks one-use grant consumption', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(3); f.advance(300001);
    assert.equal((await f.run('fz3b_semantic')).ok, false);
    assert.deepEqual(f.calls, ['build', 'inspect', 'native']);
    assert.equal((await f.backend.status('run1'))?.grant?.consumedBy, undefined);
  } finally { await f.cleanup(); }
});

test('native callback gets a detached preview and cannot mutate the plan or image', async () => {
  const f = await fixture();
  try {
    f.options.requestSemantic = async preview => { preview.fixture.imageSha256 = hash('f'); preview.identity.bootId = 'wrong'; return true; };
    await f.backend.start(f.binding); await f.through(4);
    assert.equal((await f.backend.status('run1'))?.grant?.fixture.imageSha256, FZ3B_PROFILE.imageSha256);
    assert.equal(f.contexts.at(-1)?.grant?.identity.bootId, FZ3B_PROFILE.bootId);
  } finally { await f.cleanup(); }
});

test('worker throw or SSH-close-only unknown remains held through stop, restart and recover', async () => {
  for (const mode of ['throw', 'unknown', 'not-quiescent', 'not-exited']) {
    const f = await fixture();
    try {
      await f.backend.start(f.binding); await f.through(3);
      f.options.adapter.semantic = async context => {
        f.calls.push('semantic');
        if (mode === 'throw') throw new Error('SSH connection lost');
        const receipt = f.semantic(context);
        if (mode === 'unknown') { receipt.status = 'unknown'; receipt.remoteOutcomeUnknown = true; }
        if (mode === 'not-quiescent') receipt.remoteQuiescent = false;
        if (mode === 'not-exited') receipt.processExited = false;
        return receipt;
      };
      const result = await f.run('fz3b_semantic', 'unknown-call');
      assert.equal(result.result, 'unknown');
      assert.equal((await f.backend.stop('run1')).hardwareBusy, true);
      assert.equal((await f.backend.quiescence('run1')).quiescent, false);
      const restarted = new Fz3bBackend(f.options); await restarted.recover();
      assert.equal((await restarted.status('run1'))?.hardwareBusy, true);
      await assert.rejects(restarted.start({ ...f.binding, runId: 'run2', taskId: 'task2', threadId: 'thread2' }), /held/);
      assert.equal((await restarted.executeTool(f.context('unknown-call'), 'fz3b_semantic', {})).result, 'unknown');
      assert.equal(f.calls.filter(kind => kind === 'semantic').length, 1);
    } finally { await f.cleanup(); }
  }
});

test('terminal failed worker receipts need no invented identity/semantic/package success fields', async () => {
  const f = await fixture();
  try {
    f.options.adapter.build = async context => ({ ...f.build(context), status: 'failed', packageSha256: undefined, packageManifestSha256: undefined, detail: 'preflight rejected before any remote action' });
    await f.backend.start(f.binding);
    assert.equal((await f.run('fz3b_build')).result, 'failed');
    assert.equal((await f.backend.quiescence('run1')).quiescent, true);
  } finally { await f.cleanup(); }
});

test('foreign operation, nonce, profile and identity receipts cannot pass or release ownership', async () => {
  for (const mode of ['operation', 'nonce', 'profile', 'boot', 'host', 'pl', 'manifest']) {
    const f = await fixture();
    try {
      await f.backend.start(f.binding); await f.through(1);
      f.options.adapter.inspect = async context => {
        const receipt = f.inspect(context);
        if (mode === 'operation') receipt.operationId = 'foreign';
        if (mode === 'nonce') receipt.nonce = hash('f');
        if (mode === 'profile') receipt.profileSha256 = hash('f');
        if (mode === 'boot') receipt.identity!.bootId = 'foreign';
        if (mode === 'host') receipt.identity!.hostKeySha256 = hash('f');
        if (mode === 'pl') receipt.identity!.existingPlSha256 = hash('f');
        if (mode === 'manifest') receipt.identity!.deployedManifestSha256 = hash('f');
        return receipt;
      };
      assert.equal((await f.run('fz3b_inspect')).result, 'unknown');
      assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
    } finally { await f.cleanup(); }
  }
});

test('synthetic, wrong fixture, bad counts, NaN and replayed grants cannot pass semantic', async () => {
  for (const mode of ['synthetic', 'query', 'image', 'frames', 'frame-id', 'job-id', 'nan', 'grant', 'identity', 'not-stopped', 'pl-loaded', 'labels']) {
    const f = await fixture();
    try {
      await f.backend.start(f.binding); await f.through(3);
      f.options.adapter.semantic = async context => {
        const receipt = f.semantic(context), semantic = receipt.semantic!;
        if (mode === 'synthetic') Object.assign(semantic, { synthetic: true });
        if (mode === 'query') semantic.queriesSha256 = hash('f');
        if (mode === 'image') semantic.imageSha256 = hash('f');
        if (mode === 'frames') Object.assign(semantic, { completedFrames: 2 });
        if (mode === 'frame-id') semantic.frameId = 99;
        if (mode === 'job-id') semantic.jobId = 'previous-operation-result';
        if (mode === 'nan') semantic.ranking[0].score = NaN;
        if (mode === 'grant') receipt.grantId = 'foreign';
        if (mode === 'identity') receipt.identity!.bootId = 'foreign';
        if (mode === 'not-stopped') Object.assign(semantic, { inferenceStopped: false });
        if (mode === 'pl-loaded') Object.assign(semantic, { newPlLoaded: true });
        if (mode === 'labels') semantic.ranking[0].id = 'bottle';
        return receipt;
      };
      assert.equal((await f.run('fz3b_semantic')).result, 'unknown', mode);
      assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
    } finally { await f.cleanup(); }
  }
});

test('classification unknown stays a valid compute receipt, not semantic accuracy success', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(3);
    f.options.adapter.semantic = async context => {
      const receipt = f.semantic(context); receipt.semantic!.classificationUnknown = true; receipt.semantic!.thresholdHit = false;
      receipt.semantic!.ranking.forEach((item, index) => { item.score = 0.1 - index * 0.1; });
      return receipt;
    };
    const result = await f.run('fz3b_semantic');
    assert.equal(result.result, 'succeeded');
    assert.equal(result.semantic?.classificationUnknown, true);
    assert.equal(result.semantic?.expectedLabelMatched, true);
    assert.equal(result.semantic?.thresholdHit, false);
  } finally { await f.cleanup(); }
});

test('runtime change after native confirmation blocks semantic before worker dispatch', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(3);
    f.options.checkRuntime = async () => { throw new Error('resource hash changed'); };
    assert.equal((await f.run('fz3b_semantic')).result, 'failed');
    assert.deepEqual(f.calls, ['build', 'inspect', 'native']);
  } finally { await f.cleanup(); }
});

test('tampered persisted envelope fails closed without replay or worker calls', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(1);
    const file = path.join(f.directory, 'fz3b-agent/run1.json');
    const envelope = JSON.parse(await readFile(file, 'utf8')); envelope.payload.profileId = 'arbitrary';
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(new Fz3bBackend(f.options).list(), /integrity/);
    assert.deepEqual(f.calls, ['build']);
  } finally { await f.cleanup(); }
});

test('persisted may-have-started operation becomes unknown on restart and is never replayed', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding);
    const file = path.join(f.directory, 'fz3b-agent/run1.json');
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.payload.operations = [{ id: 'operation-old', requestKey: 'key', nonce: hash('f'), kind: 'semantic', status: 'running', dispatchPhase: 'may-have-started', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' }];
    const key = await readFile(path.join(f.directory, 'fz3b-agent/binding.key'));
    envelope.mac = createHmac('sha256', key).update(JSON.stringify(envelope.payload)).digest('hex');
    await writeFile(file, JSON.stringify(envelope));
    const restarted = new Fz3bBackend(f.options);
    const view = (await restarted.status('run1'))!;
    assert.equal(view.operations[0].status, 'unknown');
    assert.equal(view.hardwareBusy, true);
    assert.equal(view.active, false);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test('public snapshots are detached and cannot change native artifact/input bindings', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(3);
    const view = (await f.backend.status('run1'))!;
    view.grant!.fixture.imageSha256 = hash('f'); view.artifact!.id = hash('f'); view.identity!.bootId = 'foreign';
    await f.through(4);
    assert.equal((await f.backend.status('run1'))?.semantic?.imageSha256, FZ3B_PROFILE.imageSha256);
  } finally { await f.cleanup(); }
});

test('unsorted scores, wrong labels and false strict-top1 claims cannot pass', async () => {
  for (const mode of ['unsorted', 'label', 'tie-claimed-pass', 'threshold-changed']) {
    const f = await fixture();
    try {
      await f.backend.start(f.binding); await f.through(3);
      f.options.adapter.semantic = async context => {
        const receipt = f.semantic(context), semantic = receipt.semantic!;
        if (mode === 'unsorted') semantic.ranking[1].score = 0.9;
        if (mode === 'label') semantic.ranking[0].label = 'fake';
        if (mode === 'tie-claimed-pass') semantic.ranking[1].score = semantic.ranking[0].score;
        if (mode === 'threshold-changed') Object.assign(semantic, { threshold: 0.01 });
        return receipt;
      };
      assert.equal((await f.run('fz3b_semantic')).result, 'unknown', mode);
    } finally { await f.cleanup(); }
  }
});

test('a real tie can remain a successful computation but cannot pass the predeclared rank rule', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(3);
    f.options.adapter.semantic = async context => {
      const receipt = f.semantic(context);
      receipt.semantic!.ranking[1].score = receipt.semantic!.ranking[0].score;
      receipt.semantic!.expectedLabelMatched = false;
      return receipt;
    };
    const result = await f.run('fz3b_semantic');
    assert.equal(result.result, 'succeeded'); assert.equal(result.semantic?.expectedLabelMatched, false);
  } finally { await f.cleanup(); }
});

test('unexpected worker fields are not relayed or exported to the model', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding);
    f.options.adapter.build = async context => Object.assign(f.build(context), { credentials: 'never relay this' });
    const result = await f.run('fz3b_build');
    assert.equal(result.result, 'unknown');
    assert.equal(JSON.stringify(result).includes('never relay'), false);
    const exported = await f.backend.export('run1');
    const raw = await readFile(path.join(exported.path, 'manifest.json'), 'utf8');
    assert.equal(raw.includes('never relay'), false);
    assert.equal(JSON.parse(raw).exportKind, 'local-snapshot');
    assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('grant expiry during final durable dispatch preparation blocks the worker', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(3);
    f.options.onChange = () => {
      const active = (f.backend as unknown as { records: Map<string, { grant?: { consumedBy?: string } }> }).records.get('run1');
      if (active?.grant?.consumedBy) f.advance(300001);
    };
    assert.equal((await f.run('fz3b_semantic')).result, 'failed');
    assert.deepEqual(f.calls, ['build', 'inspect', 'native']);
  } finally { await f.cleanup(); }
});

test('a nonfinite sample after native approval or the final durable save cannot authorize dispatch', async () => {
  for (const phase of ['approval', 'dispatch']) for (const invalid of [NaN, Infinity, -Infinity]) {
    const f = await fixture();
    try {
      await f.backend.start(f.binding); await f.through(phase === 'approval' ? 2 : 3);
      const current = f.options.now!(); let invalidateNext = false, injected = 0, armed = false;
      f.options.now = () => { if (invalidateNext) { invalidateNext = false; injected++; return invalid; } return current; };
      if (phase === 'approval') {
        const request = f.options.requestSemantic;
        f.options.requestSemantic = async (...args) => { const result = await request(...args); invalidateNext = true; return result; };
      } else {
        f.options.onChange = () => {
          const record = (f.backend as unknown as { records: Map<string, { grant?: { consumedBy?: string }; operations: { status: string }[] }> }).records.get('run1');
          if (!armed && record?.grant?.consumedBy && record.operations.at(-1)?.status === 'running') { armed = true; invalidateNext = true; }
        };
      }
      const result = await f.run(phase === 'approval' ? 'fz3b_request_semantic' : 'fz3b_semantic');
      assert.equal(injected, 1, `${phase}/${invalid}`); assert.equal(result.ok, false, `${phase}/${invalid}`);
      assert.deepEqual(f.calls, ['build', 'inspect', 'native']);
    } finally { await f.cleanup(); }
  }
});

test('persistence failure after dispatch cannot release ownership or permit replay', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding);
    f.options.adapter.build = async context => {
      const runFile = path.join(f.directory, 'fz3b-agent/run1.json');
      await rm(runFile); await mkdir(runFile);
      return f.build(context);
    };
    assert.equal((await f.run('fz3b_build')).result, 'unknown');
    assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
    assert.equal((await f.backend.quiescence('run1')).quiescent, false);
    await assert.rejects(f.backend.start({ ...f.binding, runId: 'run2' }), /held/);
  } finally { await f.cleanup(); }
});

test('export verifies exact public bytes, fixed names, package inventory and hashes', async () => {
  for (const mode of ['bytes', 'name', 'package-missing', 'hash']) {
    const f = await fixture();
    try {
      await f.backend.start(f.binding); await f.through(4);
      const read = f.options.adapter.readPublicEvidence;
      f.options.adapter.readPublicEvidence = async (operationId, evidenceHash) => {
        const files = await read(operationId, evidenceHash);
        if (mode === 'bytes') files[0].bytes = Buffer.from('changed');
        if (mode === 'name') Object.assign(files[0], { name: '../private-key' });
        if (mode === 'package-missing') return files.filter(file => file.name === 'evidence.json');
        if (mode === 'hash') files[0].sha256 = hash('f');
        return files;
      };
      const result = await f.run('fz3b_export');
      assert.equal(result.ok, false, mode);
      assert.equal((await f.backend.status('run1'))?.status, 'needs_attention');
      assert.equal(result.export, undefined);
    } finally { await f.cleanup(); }
  }
});

async function recoveryFixture() {
  const f = await fixture();
  f.options.assertRecoveryOwner = async binding => { assert.equal(binding.runId, f.binding.runId); f.calls.push('recovery-owner'); };
  f.options.requestInspectReconciliation = async (_context, signal) => { assert.equal(signal.aborted, false); f.calls.push('recovery-native'); return true; };
  const proofBytes = (context: Fz3bInspectReconciliationContext) => Buffer.from(fz3bCanonicalJson({ context, offline: 'fake readonly proof, not a board receipt' }));
  const finalizationBytes = (context: Fz3bInspectReconciliationContext, value: Fz3bInspectReconciliationProof) => Buffer.from(fz3bCanonicalJson({ contextSha256: canonicalSha(context), proofSha256: canonicalSha(value), offline: 'fake exact-lock finalization' }));
  const proof = (context: Fz3bInspectReconciliationContext): Fz3bInspectReconciliationProof => ({
    schemaVersion: 1, id: context.id, nonce: context.nonce, contextSha256: canonicalSha(context),
    originalEvidenceSha256: context.originalEvidenceSha256, originalIntentSha256: hash('a'), originalCloseSha256: hash('b'),
    originalResourceManifestSha256: '951b6ec48562e56b67b158c237b2f0317e3cd9f965db981e78d2a003c2675dfa',
    localOriginalCloseConfirmed: true, identity: structuredClone(f.identity), observedAt: context.createdAt, evidenceSha256: sha(proofBytes(context)),
    transport: { spawned: true, closeConfirmed: true, exitCode: 0, timedOut: false },
    remote: { readOnly: true, metadataStable: true, deviceOwners: [], controlConnections: 0, inspectorPids: [], unfinishedJournalEntries: 0,
      scanCount: 2, procScanComplete: true, journalScanComplete: true, originalInspectorAbsent: true },
  });
  const finalization = (context: Fz3bInspectReconciliationContext, value: Fz3bInspectReconciliationProof): Fz3bInspectReconciliationFinalization => ({
    schemaVersion: 1, id: context.id, contextSha256: canonicalSha(context), proofSha256: canonicalSha(value),
    lockReleased: true, localProcessesClosed: true, evidenceSha256: sha(finalizationBytes(context, value)),
  });
  f.options.adapter.prepareInspectReconciliation = async context => { f.calls.push('proof-prepare'); return proof(context); };
  f.options.adapter.finalizeInspectReconciliation = async (context, value) => {
    f.calls.push('proof-finalize');
    const persisted = JSON.parse(await readFile(path.join(f.directory, 'fz3b-agent/run1.json'), 'utf8')).payload;
    assert.equal(persisted.reconciliations.at(-1).status, 'prepared');
    assert.deepEqual(persisted.reconciliations.at(-1).proof, value);
    return finalization(context, value);
  };
  f.options.adapter.localProcessState = async contexts => ({ closed: true, liveChildren: 0,
    operations: contexts.map(context => ({ operationId: context.operationId, nonce: context.nonce, closeConfirmed: true, evidenceSha256: hash('e') })) });
  f.options.adapter.readInspectReconciliationEvidence = async (context, value, finalized) => [
    { name: 'proof-evidence.json', bytes: proofBytes(context), sha256: value.evidenceSha256 },
    ...(finalized ? [{ name: 'finalization-evidence.json' as const, bytes: finalizationBytes(context, value), sha256: finalized.evidenceSha256 }] : []),
  ];
  f.options.adapter.inspect = async context => ({ ...f.inspect(context), status: 'unknown', remoteQuiescent: false, remoteOutcomeUnknown: true });
  await f.backend.start(f.binding); await f.through(1);
  assert.equal((await f.run('fz3b_inspect')).result, 'unknown');
  return { ...f, proof, finalization };
}

test('inspect-only reconciliation releases occupancy without rewriting unknown history or resuming its run', async () => {
  const f = await recoveryFixture();
  try {
    const before = (await f.backend.status('run1'))!;
    const original = JSON.parse(await readFile(path.join(f.directory, 'fz3b-agent/run1.json'), 'utf8')).payload;
    assert.deepEqual(await f.backend.recoveryActions('run1'), { reconcileInspect: true, reconcilePreflightRefusedInspect: false, maintenanceExit: true, exportEvidence: true });
    const result = await f.backend.reconcileInspect('run1');
    assert.equal(result.hardwareBusy, false); assert.equal(result.status, 'needs_attention'); assert.equal(result.active, false);
    assert.equal(result.reconciliations?.[0].status, 'released');
    assert.deepEqual(result.operations, before.operations); assert.deepEqual(result.calls, before.calls);
    const persisted = JSON.parse(await readFile(path.join(f.directory, 'fz3b-agent/run1.json'), 'utf8')).payload;
    assert.deepEqual(persisted.receipts, original.receipts); assert.deepEqual(persisted.results, original.results);
    assert.equal((await f.backend.quiescence('run1')).quiescent, true);
    const restarted = new Fz3bBackend(f.options); await restarted.recover();
    assert.equal((await restarted.status('run1'))?.hardwareBusy, false);
    assert.equal((await restarted.status('run1'))?.operations.at(-1)?.status, 'unknown');
    const prepareCount = f.calls.filter(call => call === 'proof-prepare').length, finalizeCount = f.calls.filter(call => call === 'proof-finalize').length;
    const finished = await restarted.reconcileInspect('run1');
    assert.equal(finished.hardwareBusy, false); assert.equal(finished.reconciliations?.length, 1);
    assert.equal(f.calls.filter(call => call === 'proof-prepare').length, prepareCount); assert.equal(f.calls.filter(call => call === 'proof-finalize').length, finalizeCount);
    assert.ok(fz3bReleasedInspectReconciliation(finished, finished.operations.at(-1)!, f.input));
    const denied = await restarted.executeTool(f.context('old-semantic'), 'fz3b_semantic', {});
    assert.equal(denied.ok, false); assert.equal(f.calls.includes('semantic'), false);
    assert.deepEqual((await restarted.status('run1'))?.calls, JSON.parse(JSON.stringify(before.calls)));
    await restarted.start({ ...f.binding, runId: 'run2' });
  } finally { await f.cleanup(); }
});

test('reconciliation native refusal never obtains a new remote proof and leaves the hold', async () => {
  const f = await recoveryFixture();
  try {
    f.options.requestInspectReconciliation = async () => false;
    await assert.rejects(f.backend.reconcileInspect('run1'), /natively confirmed/);
    assert.equal(f.calls.includes('proof-prepare'), false); assert.equal(f.calls.includes('proof-finalize'), false);
    assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('reconciliation rejects incomplete, foreign, stale and non-readonly proof without finalizing', async () => {
  const mutations: ((proof: Fz3bInspectReconciliationProof) => void)[] = [
    value => { value.nonce = hash('e'); }, value => { value.contextSha256 = hash('e'); },
    value => { value.originalEvidenceSha256 = hash('e'); }, value => { value.originalResourceManifestSha256 = hash('e'); },
    value => { value.identity.bootId = 'foreign'; }, value => { value.remote.deviceOwners = [77]; },
    value => { value.remote.inspectorPids = [88]; }, value => { value.remote.scanCount = 1; },
    value => { Object.assign(value.remote, { procScanComplete: false }); }, value => { Object.assign(value.remote, { journalScanComplete: false }); },
    value => { Object.assign(value.remote, { unfinishedJournalEntries: 1 }); }, value => { Object.assign(value.remote, { originalInspectorAbsent: false }); },
    value => { Object.assign(value.transport, { closeConfirmed: false }); }, value => { Object.assign(value.transport, { exitCode: 255 }); },
    value => { Object.assign(value, { localOriginalCloseConfirmed: false }); }, value => { Object.assign(value, { arbitrary: 'not accepted' }); },
    value => { value.observedAt = '2026-10-15T00:00:00Z'; },
  ];
  for (const mutate of mutations) {
    const f = await recoveryFixture();
    try {
      f.options.adapter.prepareInspectReconciliation = async context => { const value = f.proof(context); mutate(value); return value; };
      await assert.rejects(f.backend.reconcileInspect('run1'));
      assert.equal(f.calls.includes('proof-finalize'), false); assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
      assert.equal((await new Fz3bBackend(f.options).status('run1'))?.hardwareBusy, true);
    } finally { await f.cleanup(); }
  }
});

test('interrupted exact-lock finalization leaves prepared proof and explicit retry does not repeat readonly probe', async () => {
  const f = await recoveryFixture();
  try {
    f.options.adapter.finalizeInspectReconciliation = async () => { f.calls.push('lost-finalize-ack'); throw new Error('lost finalization acknowledgement'); };
    await assert.rejects(f.backend.reconcileInspect('run1'), /lost finalization/);
    const held = (await f.backend.status('run1'))!;
    assert.equal(held.reconciliations?.at(-1)?.status, 'prepared'); assert.equal(held.hardwareBusy, true);
    const id = held.reconciliations![0].context.id;
    const restarted = new Fz3bBackend(f.options); await restarted.recover();
    assert.equal(f.calls.filter(call => call === 'proof-prepare').length, 1);
    f.options.adapter.finalizeInspectReconciliation = async (context, proof) => { assert.equal(context.id, id); return f.finalization(context, proof); };
    assert.equal((await restarted.reconcileInspect('run1')).hardwareBusy, false);
    assert.equal(f.calls.filter(call => call === 'proof-prepare').length, 1);
  } finally { await f.cleanup(); }
});

test('expired prepared proof needs a new explicit fresh proof instead of using stale absence', async () => {
  const f = await recoveryFixture();
  try {
    f.options.adapter.finalizeInspectReconciliation = async () => { throw new Error('interrupted'); };
    await assert.rejects(f.backend.reconcileInspect('run1'));
    f.advance(120001);
    f.options.adapter.finalizeInspectReconciliation = async (context, proof) => f.finalization(context, proof);
    const result = await new Fz3bBackend(f.options).reconcileInspect('run1');
    assert.equal(result.reconciliations?.length, 2); assert.equal(result.reconciliations?.[0].status, 'prepared');
    assert.equal(result.reconciliations?.[1].status, 'released'); assert.equal(f.calls.filter(call => call === 'proof-prepare').length, 2);
  } finally { await f.cleanup(); }
});

test('invalid exact-lock finalization cannot release the inspect hold', async () => {
  for (const field of ['proofSha256', 'contextSha256', 'id', 'lockReleased', 'localProcessesClosed', 'evidenceSha256']) {
    const f = await recoveryFixture();
    try {
      f.options.adapter.finalizeInspectReconciliation = async (context, proof) => Object.assign(f.finalization(context, proof), { [field]: 'wrong' });
      await assert.rejects(f.backend.reconcileInspect('run1'), /finalization/);
      assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
      assert.equal((await new Fz3bBackend(f.options).status('run1'))?.hardwareBusy, true);
    } finally { await f.cleanup(); }
  }
});

test('prepared-proof persistence failure prevents exact-lock finalization', async () => {
  const f = await recoveryFixture();
  try {
    f.options.onChange = () => {
      const records = (f.backend as unknown as { records: Map<string, { reconciliations?: { status: string }[] }> }).records;
      if (records.get('run1')?.reconciliations?.at(-1)?.status === 'prepared') throw new Error('simulated durable acknowledgement failure');
    };
    await assert.rejects(f.backend.reconcileInspect('run1'));
    assert.equal(f.calls.includes('proof-finalize'), false); assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('final released-seal persistence failure holds current process and preserves prepared restart state', async () => {
  const f = await recoveryFixture();
  try {
    f.options.onChange = () => {
      const records = (f.backend as unknown as { records: Map<string, { reconciliations?: { status: string }[] }> }).records;
      if (records.get('run1')?.reconciliations?.at(-1)?.status === 'released') throw new Error('simulated final seal failure');
    };
    await assert.rejects(f.backend.reconcileInspect('run1'));
    assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
    f.options.onChange = undefined;
    assert.equal((await new Fz3bBackend(f.options).status('run1'))?.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('maintenance seal confirms only local close and never clears remote unknown or permits another run', async () => {
  const f = await recoveryFixture();
  try {
    const before = (await f.backend.status('run1'))!;
    const seal = await f.backend.prepareMaintenanceExit('run1');
    const { sealSha256, ...payload } = seal; assert.equal(sealSha256, canonicalSha(payload));
    assert.equal(seal.unknownPreserved, true); assert.equal(seal.localProcessesClosed, true);
    const after = (await f.backend.status('run1'))!;
    assert.deepEqual(after.calls, before.calls); assert.deepEqual(after.operations, before.operations); assert.equal(after.hardwareBusy, true);
    assert.equal((await f.backend.quiescence('run1')).quiescent, false);
    const restarted = new Fz3bBackend(f.options); await restarted.recover();
    assert.equal((await restarted.status('run1'))?.hardwareBusy, true);
    await assert.rejects(restarted.start({ ...f.binding, runId: 'run2' }), /held/);
    assert.equal(f.calls.includes('proof-prepare'), false);
  } finally { await f.cleanup(); }
});

test('maintenance rejects missing, foreign, exit-without-close and still-running local child evidence', async () => {
  for (const mode of ['running', 'exit-only', 'missing', 'foreign', 'bad-hash']) {
    const f = await recoveryFixture();
    try {
      const original = f.options.adapter.localProcessState!;
      f.options.adapter.localProcessState = async contexts => {
        const value = await original(contexts);
        if (mode === 'running') value.liveChildren = 1;
        if (mode === 'exit-only') value.operations[0].closeConfirmed = false;
        if (mode === 'missing') value.operations = [];
        if (mode === 'foreign') value.operations[0].nonce = hash('f');
        if (mode === 'bad-hash') value.operations[0].evidenceSha256 = 'invalid';
        return value;
      };
      await assert.rejects(f.backend.prepareMaintenanceExit('run1'), /actual local transport close/);
      assert.equal((await f.backend.status('run1'))?.maintenanceExit, undefined);
    } finally { await f.cleanup(); }
  }
});

test('live reconciliation dialog excludes other recovery, export and maintenance and stop cancels it', async () => {
  const f = await recoveryFixture(); const native = deferred<boolean>();
  try {
    f.options.requestInspectReconciliation = async (_context, signal) => {
      signal.addEventListener('abort', () => native.resolve(false)); return native.promise;
    };
    const pending = f.backend.reconcileInspect('run1');
    while (!(await f.backend.status('run1'))?.reconciliations?.length) await new Promise(resolve => setTimeout(resolve, 1));
    assert.deepEqual(await f.backend.recoveryActions('run1'), { reconcileInspect: false, reconcilePreflightRefusedInspect: false, maintenanceExit: false, exportEvidence: false });
    await assert.rejects(f.backend.reconcileInspect('run1'), /busy/);
    await assert.rejects(f.backend.prepareMaintenanceExit('run1'), /busy/);
    await assert.rejects(f.backend.export('run1'), /settle/);
    await f.backend.stop('run1'); await assert.rejects(pending, /confirmed/);
    assert.equal(f.calls.includes('proof-prepare'), false);
  } finally { native.resolve(false); await f.cleanup(); }
});

test('semantic unknown can only produce a local maintenance seal, never inspect reconciliation', async () => {
  const f = await fixture();
  try {
    await f.backend.start(f.binding); await f.through(3);
    f.options.adapter.semantic = async context => ({ ...f.semantic(context), status: 'unknown', remoteQuiescent: false, remoteOutcomeUnknown: true });
    assert.equal((await f.run('fz3b_semantic')).result, 'unknown');
    f.options.assertRecoveryOwner = () => {};
    f.options.requestInspectReconciliation = async () => true;
    f.options.adapter.prepareInspectReconciliation = async () => { throw new Error('must never be called'); };
    f.options.adapter.finalizeInspectReconciliation = async () => { throw new Error('must never be called'); };
    f.options.adapter.localProcessState = async contexts => ({ closed: true, liveChildren: 0,
      operations: contexts.map(context => ({ operationId: context.operationId, nonce: context.nonce, closeConfirmed: true, evidenceSha256: hash('e') })) });
    assert.deepEqual(await f.backend.recoveryActions('run1'), { reconcileInspect: false, reconcilePreflightRefusedInspect: false, maintenanceExit: true, exportEvidence: true });
    await assert.rejects(f.backend.reconcileInspect('run1'), /inspect-only/);
    await f.backend.prepareMaintenanceExit('run1');
    assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
    assert.equal((await new Fz3bBackend(f.options).status('run1'))?.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('reconciliation export includes exact original evidence and new fixed proof/finalization bytes', async () => {
  const f = await recoveryFixture();
  try {
    await f.backend.reconcileInspect('run1');
    const exported = await f.backend.export('run1');
    const raw = await readFile(path.join(exported.path, 'manifest.json'));
    assert.equal(sha(raw), exported.sha256);
    const manifest = JSON.parse(raw.toString('utf8'));
    assert.equal(manifest.files.length, 6);
    assert.equal(manifest.run.operations.at(-1).status, 'unknown');
    assert.equal(manifest.run.reconciliations[0].status, 'released');
    assert.equal(manifest.files.filter((file: { path: string }) => file.path.startsWith('reconciliations/')).length, 2);
    for (const file of manifest.files) assert.equal(sha(await readFile(path.join(exported.path, file.path))), file.sha256);
    const original = f.options.adapter.readInspectReconciliationEvidence!;
    f.options.adapter.readInspectReconciliationEvidence = async (...args) => {
      const files = await original(...args); files[0].bytes = Buffer.from('changed'); return files;
    };
    await assert.rejects(f.backend.export('run1'), /bytes changed/);
  } finally { await f.cleanup(); }
});

test('restart after preparing intent alone never auto-probes or finalizes and HMAC tampering stays closed', async () => {
  const f = await recoveryFixture();
  try {
    f.options.requestInspectReconciliation = async () => false;
    await assert.rejects(f.backend.reconcileInspect('run1'));
    const restarted = new Fz3bBackend(f.options); await restarted.recover();
    assert.equal(f.calls.includes('proof-prepare'), false); assert.equal(f.calls.includes('proof-finalize'), false);
    const file = path.join(f.directory, 'fz3b-agent/run1.json');
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.payload.reconciliations[0].status = 'released';
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(new Fz3bBackend(f.options).recover(), /integrity/);
  } finally { await f.cleanup(); }
});

test('shared released-inspect predicate rejects changed proof/owner/profile and semantic unknown', async () => {
  const f = await recoveryFixture();
  try {
    const result = await f.backend.reconcileInspect('run1');
    const mutations = [
      (value: typeof result) => { value.reconciliations![0].proof!.remote.procScanComplete = false as true; },
      (value: typeof result) => { value.reconciliations![0].finalization!.proofSha256 = hash('f'); },
      (value: typeof result) => { value.sessionId = 'foreign-session'; },
      (value: typeof result) => { value.generation += 1; },
      (value: typeof result) => { value.profileSha256 = hash('f'); },
      (value: typeof result) => { value.operations.at(-1)!.nonce = hash('f'); },
      (value: typeof result) => { value.operations.at(-1)!.kind = 'semantic'; },
      (value: typeof result) => { value.calls.push({ callId: 'foreign-semantic', tool: 'fz3b_semantic', status: 'unknown', receivedAt: value.createdAt }); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(result); mutate(changed);
      assert.equal(fz3bReleasedInspectReconciliation(changed, changed.operations.at(-1)!, f.input), undefined);
    }
    f.options.assertRecoveryOwner = () => { throw new Error('foreign recovery owner'); };
    await assert.rejects(f.backend.reconcileInspect('run1'), /foreign recovery owner/);
    assert.equal(f.calls.filter(call => call === 'proof-prepare').length, 1);
    const file = path.join(f.directory, 'fz3b-agent/run1.json');
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.payload.reconciliations[0].proof.remote.procScanComplete = false;
    await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(new Fz3bBackend(f.options).reconcileInspect('run1'), /integrity/);
  } finally { await f.cleanup(); }
});

test('proof expiring during exact-lock finalization remains prepared and held, not released', async () => {
  const f = await recoveryFixture();
  try {
    f.options.adapter.finalizeInspectReconciliation = async (context, proof) => { f.advance(120001); return f.finalization(context, proof); };
    await assert.rejects(f.backend.reconcileInspect('run1'), /stale/);
    const view = (await f.backend.status('run1'))!;
    assert.equal(view.reconciliations?.at(-1)?.status, 'prepared'); assert.equal(view.hardwareBusy, true);
    assert.equal((await new Fz3bBackend(f.options).status('run1'))?.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('pure local export is tracked until copy settles and excludes recovery and maintenance', async () => {
  const f = await recoveryFixture(); const entered = deferred<void>(), release = deferred<void>();
  try {
    const original = f.options.adapter.readPublicEvidence;
    f.options.adapter.readPublicEvidence = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const pending = f.backend.export('run1'); await entered.promise;
    assert.equal((await f.backend.quiescence('run1')).inflight, true);
    assert.deepEqual(await f.backend.recoveryActions('run1'), { reconcileInspect: false, reconcilePreflightRefusedInspect: false, maintenanceExit: false, exportEvidence: false });
    await assert.rejects(f.backend.prepareMaintenanceExit('run1'), /busy/);
    await assert.rejects(f.backend.reconcileInspect('run1'), /busy/);
    await assert.rejects(f.backend.export('run1'), /settle/);
    await assert.rejects(f.backend.recover(), /live action/);
    release.resolve(); await pending;
    assert.equal((await f.backend.quiescence('run1')).inflight, false);
    assert.equal((await f.backend.status('run1'))?.hardwareBusy, true);
    assert.equal((await f.backend.status('run1'))?.operations.at(-1)?.status, 'unknown');
  } finally { release.resolve(); await f.cleanup(); }
});
