import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Fz3bBackend, type Fz3bBackendOptions } from '../packages/engineering-runner/fz3b/backend';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bDigest, fz3bProfileSha256 } from '../packages/engineering-runner/fz3b/profile';
import { loadFz3bFixture } from '../packages/engineering-runner/fz3b/resources';
import { ProductionFz3bAdapter } from '../packages/engineering-runner/fz3b/worker';
import type { Fz3bAdapterContext, Fz3bBinding, Fz3bIdentity, Fz3bReceiptBase, Fz3bSemanticFixture,
  Fz3bSemanticReceipt, Fz3bSemanticResult, Fz3bToolName } from '../packages/engineering-runner/fz3b/types';

// Entirely synthetic adapter/native callbacks in isolated project-local homes; never installed acceptance.
const fixtureRoot = path.resolve('output/qa/2026-10-17-fz3b-recovery/interruption-fixtures');
const resourceRoot = path.resolve('engineering/fz3b/product/resources');
const sha = (value: string | Buffer) => fz3bDigest(value);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function home() { await mkdir(fixtureRoot, { recursive: true }); return mkdtemp(path.join(fixtureRoot, 'offline-')); }
function identity(): Fz3bIdentity {
  return { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot,
    platform: 'A0005', contractId: FZ3B_PROFILE.encoderIdentity.contractId, deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
    existingPlSha256: FZ3B_PROFILE.existingPlSha256, transport: 'pinned-ssh', helloAuthenticated: false };
}
function semantic(context: Fz3bAdapterContext): Fz3bSemanticResult {
  return { jobId: `fd-semantic-${context.operationId.replaceAll('-', '')}`, frameId: 0, queryRevision: 1, completedFrames: 1,
    fixtureManifestSha256: context.fixture.manifestSha256, queriesSha256: context.fixture.queriesSha256, imageSha256: context.fixture.imageSha256,
    encoderIdentity: structuredClone(context.fixture.encoderIdentity), ranking: context.fixture.queryIds.map((id, index) => ({ id, label: id, score: .8 - .2 * index })),
    bestId: 'pillow', semanticInput: 'real-text-encoder', synthetic: false, classificationUnknown: false,
    threshold: .2, thresholdHit: true, expectedLabel: 'pillow', expectedLabelMatched: true, inferenceStopped: true, newPlLoaded: false };
}
async function backendFixture() {
  const directory = await home(), fixture = await loadFz3bFixture(resourceRoot);
  const binding: Fz3bBinding = { runId: 'offline-run', taskId: 'offline-task', sessionId: 'offline-session', model: 'gpt-6.1-sol', generation: 17, threadId: 'offline-thread' };
  const calls: string[] = [], contexts = new Map<string, Fz3bAdapterContext>(); let sequence = 0;
  const packageBytes = Buffer.from('synthetic fixture package, no deployment'), packageManifest = Buffer.from('{"synthetic":true}');
  const bytes = (context: Fz3bAdapterContext) => Buffer.from(JSON.stringify({ operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256 }));
  const base = (context: Fz3bAdapterContext): Fz3bReceiptBase => {
    contexts.set(context.operationId, structuredClone(context));
    return { schemaVersion: 1, operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256,
      status: 'succeeded', processExited: true, remoteQuiescent: true, remoteOutcomeUnknown: false, evidenceSha256: sha(bytes(context)) };
  };
  const reply = (context: Fz3bAdapterContext): Fz3bSemanticReceipt => ({ ...base(context), kind: 'semantic', identity: identity(), grantId: context.grant!.id, semantic: semantic(context) });
  const options: Fz3bBackendOptions = { dataDir: directory, fixture, checkRuntime: async () => {}, assertOwner: () => {}, assertRecoveryOwner: () => {},
    requestSemantic: async () => { calls.push('synthetic-native'); return true; },
    adapter: {
      async build(context) { calls.push('build'); return { ...base(context), kind: 'build', sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
        fixtureManifestSha256: fixture.manifestSha256, queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256,
        packageSha256: sha(packageBytes), packageManifestSha256: sha(packageManifest), newPlBuilt: false, deployed: false }; },
      async inspect(context) { calls.push('inspect'); return { ...base(context), kind: 'inspect', identity: identity(), readOnly: true }; },
      async semantic(context) { calls.push('semantic'); return reply(context); },
      async readPublicEvidence(id, expected) {
        const context = contexts.get(id)!; const evidence = bytes(context); assert.equal(sha(evidence), expected);
        return [{ name: 'evidence.json', bytes: evidence, sha256: expected }, ...(context.artifact ? [] : [
          { name: 'ps-acceptance.tar' as const, bytes: packageBytes, sha256: sha(packageBytes) },
          { name: 'package-manifest.json' as const, bytes: packageManifest, sha256: sha(packageManifest) }])];
      },
    } };
  const backend = new Fz3bBackend(options);
  const context = (callId = `offline-call-${++sequence}`) => ({ ...binding, turnId: 'offline-turn', callId });
  const run = (name: Fz3bToolName, callId?: string) => backend.executeTool(context(callId), name, {});
  const ready = async () => { await backend.start(binding); for (const name of ['fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic'] as const) assert.equal((await run(name)).ok, true); };
  return { directory, fixture, binding, calls, options, backend, context, run, ready, base, reply };
}

for (const outcome of ['success', 'known-failure', 'throw', 'not-exited'] as const) {
  test(`deferred semantic Stop preserves consumption and ownership until ${outcome} settles`, async () => {
    const f = await backendFixture(), entered = deferred<Fz3bAdapterContext>(), finished = deferred<Fz3bSemanticReceipt>();
    f.options.adapter.semantic = async context => { f.calls.push('semantic'); entered.resolve(structuredClone(context)); return finished.promise; };
    await f.ready(); const pending = f.run('fz3b_semantic', 'semantic-once'), context = await entered.promise;
    const duplicate = f.run('fz3b_semantic', 'semantic-once');
    const stopped = await f.backend.stop(f.binding.runId);
    assert.equal(stopped.grant!.consumedBy, context.operationId); assert.equal(stopped.hardwareBusy, true);
    assert.equal((await f.backend.quiescence(f.binding.runId)).quiescent, false);
    await assert.rejects(f.backend.recover(), /live action/);
    if (outcome === 'throw') finished.reject(new Error('Synthetic transport visibility loss'));
    else {
      const receipt = f.reply(context);
      if (outcome === 'known-failure') { receipt.status = 'failed'; delete receipt.semantic; receipt.detail = 'Synthetic confirmed terminal failure'; }
      if (outcome === 'not-exited') receipt.processExited = false;
      finished.resolve(receipt);
    }
    const result = await pending; assert.deepEqual(await duplicate, result);
    const view = (await f.backend.status(f.binding.runId))!;
    assert.equal(f.calls.filter(item => item === 'semantic').length, 1); assert.equal(view.grant!.consumedBy, context.operationId);
    assert.equal(view.active, false); assert.equal(view.stopRequested, true); assert.notEqual(view.status, 'completed');
    const unknown = outcome === 'throw' || outcome === 'not-exited';
    assert.equal(view.operations.at(-1)!.status, unknown ? 'unknown' : outcome === 'success' ? 'succeeded' : 'failed');
    assert.equal(view.hardwareBusy, unknown); assert.equal((await f.backend.quiescence(f.binding.runId)).quiescent, !unknown);
    assert.equal((await f.run('fz3b_semantic', 'late-new-call')).ok, false);
    assert.equal(f.calls.filter(item => item === 'semantic').length, 1);
  });
}

test('late affirmative synthetic native result after Stop never becomes approval or dispatch', async () => {
  const f = await backendFixture(), opened = deferred<AbortSignal>(), decision = deferred<boolean>();
  f.options.requestSemantic = async (_grant, signal) => { opened.resolve(signal); return decision.promise; };
  await f.backend.start(f.binding); await f.run('fz3b_build'); await f.run('fz3b_inspect');
  const pending = f.run('fz3b_request_semantic'); const signal = await opened.promise;
  await f.backend.stop(f.binding.runId); assert.equal(signal.aborted, true);
  assert.equal((await f.backend.quiescence(f.binding.runId)).quiescent, false);
  decision.resolve(true); assert.equal((await pending).ok, false);
  const view = (await f.backend.status(f.binding.runId))!;
  assert.equal(view.nativeApproval, 'cancelled'); assert.equal(view.grant?.approvedAt, undefined); assert.equal(view.grant?.consumedBy, undefined);
  assert.equal((await f.run('fz3b_semantic')).ok, false); assert.equal(f.calls.includes('semantic'), false);
});

test('settled semantic unknown survives restart, local maintenance, export and repeated calls without rewriting original facts', async () => {
  const f = await backendFixture();
  f.options.adapter.semantic = async context => { f.calls.push('semantic'); return { ...f.reply(context), status: 'unknown', remoteOutcomeUnknown: true, remoteQuiescent: false }; };
  await f.ready(); assert.equal((await f.run('fz3b_semantic', 'original-unknown')).result, 'unknown');
  const original = (await f.backend.status(f.binding.runId))!, operation = original.operations.at(-1)!;
  await f.backend.stop(f.binding.runId); const restarted = new Fz3bBackend(f.options); await restarted.recover();
  const before = (await restarted.status(f.binding.runId))!;
  assert.deepEqual(before.operations, original.operations); assert.deepEqual(before.grant, original.grant);
  assert.equal(before.hardwareBusy, true); assert.equal((await restarted.executeTool(f.context('original-unknown'), 'fz3b_semantic', {})).result, 'unknown');
  await assert.rejects(restarted.start({ ...f.binding, runId: 'another-run' }), /held/);
  await assert.rejects(restarted.reconcileInspect(f.binding.runId), /unavailable|inspect-only/);
  f.options.adapter.localProcessState = async contexts => ({ closed: true, liveChildren: 0,
    operations: contexts.map(context => ({ operationId: context.operationId, nonce: context.nonce, closeConfirmed: true, evidenceSha256: sha('synthetic-close') })) });
  const seal = await restarted.prepareMaintenanceExit(f.binding.runId);
  assert.equal(seal.unknownPreserved, true); assert.equal(seal.localProcessesClosed, true);
  const exported = await restarted.export(f.binding.runId), manifest = JSON.parse(await readFile(path.join(exported.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.exportKind, 'local-snapshot'); assert.deepEqual(manifest.run.operations.at(-1), operation);
  const after = (await restarted.status(f.binding.runId))!;
  assert.deepEqual(after.operations, original.operations); assert.deepEqual(after.grant, original.grant); assert.equal(after.hardwareBusy, true);
  await assert.rejects(restarted.start({ ...f.binding, runId: 'after-maintenance' }), /held/);
  assert.equal(f.calls.filter(item => item === 'semantic').length, 1);
});

test('actual fixture ledger write failure after semantic dispatch cannot release a consumed grant', async () => {
  const f = await backendFixture(); await f.ready();
  const ledger = path.join(f.directory, 'fz3b-agent', `${f.binding.runId}.json`);
  assert.ok(path.relative(fixtureRoot, ledger) && !path.relative(fixtureRoot, ledger).startsWith('..'));
  f.options.adapter.semantic = async context => {
    f.calls.push('semantic'); await rename(ledger, `${ledger}.retained`); await mkdir(ledger); return f.reply(context);
  };
  assert.equal((await f.run('fz3b_semantic')).result, 'unknown');
  const view = (await f.backend.status(f.binding.runId))!;
  assert.equal(view.operations.at(-1)!.status, 'unknown'); assert.equal(view.grant!.consumedBy, view.operations.at(-1)!.id);
  assert.equal(view.hardwareBusy, true); assert.equal((await f.backend.quiescence(f.binding.runId)).quiescent, false);
  await assert.rejects(f.backend.start({ ...f.binding, runId: 'forbidden-retry' }), /held/);
  assert.equal(f.calls.filter(item => item === 'semantic').length, 1);
});

for (const fault of ['exit255', 'timeout', 'truncated', 'wrong-nonce'] as const) {
  test(`production-worker offline semantic ${fault} retains lock and never opens a second transport`, async () => {
    const directory = await home(), fixture = await loadFz3bFixture(resourceRoot);
    const adapter = new ProductionFz3bAdapter({ resourceRoot, dataDir: directory });
    type Transport = { processExited: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; spawned: boolean };
    const internals = adapter as unknown as { projectKey(): Promise<string>; transport(): Promise<Transport> };
    let transports = 0;
    internals.projectKey = async () => path.join(directory, 'offline-placeholder-never-opened');
    const context = (): Fz3bAdapterContext => ({ runId: 'offline-run', taskId: 'offline-task', sessionId: 'offline-session',
      operationId: randomUUID(), requestKey: randomUUID(), nonce: sha(randomUUID()), profileSha256: fz3bProfileSha256(fixture), fixture });
    const builtContext = context(), built = await adapter.build(builtContext); assert.equal(built.status, 'succeeded');
    const ctx = context(); ctx.identity = identity(); ctx.artifact = { id: sha('offline-artifact'), kind: 'fixed-ps-fixture-package', buildId: builtContext.operationId,
      profileSha256: ctx.profileSha256, sourceManifestSha256: built.sourceManifestSha256, fixtureManifestSha256: fixture.manifestSha256,
      queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256, buildEvidenceSha256: built.evidenceSha256,
      packageSha256: built.packageSha256!, packageManifestSha256: built.packageManifestSha256!, newPlBuilt: false, deployed: false };
    const created = Date.now(), grant = { id: randomUUID(), runId: ctx.runId, taskId: ctx.taskId, sessionId: ctx.sessionId, artifactId: ctx.artifact.id,
      profileSha256: ctx.profileSha256, identity: ctx.identity, fixture, scope: 'existing-candidate008-real-text-single-image-once' as const,
      actions: FZ3B_PROFILE.actions, createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString() };
    ctx.grant = { ...grant, planSha256: sha(JSON.stringify(grant)), approvedAt: grant.createdAt, consumedBy: ctx.operationId };
    internals.transport = async () => {
      transports++;
      const remote = { schemaVersion: 1, operationId: ctx.operationId, nonce: fault === 'wrong-nonce' ? sha('wrong') : ctx.nonce,
        profileSha256: ctx.profileSha256, status: 'succeeded', remoteQuiescent: true, remoteOutcomeUnknown: false,
        semantic: semantic(ctx), identity: { ...identity(), mainPid: 1234, loadedPlAttested: false }, grantId: ctx.grant!.id };
      return { processExited: fault !== 'timeout', exitCode: fault === 'exit255' ? 255 : fault === 'timeout' ? null : 0,
        stdout: fault === 'exit255' || fault === 'timeout' ? '' : fault === 'truncated' ? '{' : JSON.stringify(remote) + '\n',
        stderr: 'offline transport fixture, never spawned a real process', timedOut: fault === 'timeout', spawned: true };
    };
    const result = await adapter.semantic(ctx); assert.equal(result.status, 'unknown'); assert.equal(result.remoteQuiescent, false);
    assert.equal(result.remoteOutcomeUnknown, true); assert.equal(result.processExited, fault !== 'timeout');
    const lockFile = path.join(directory, 'fz3b-worker/active.lock'), beforeLock = await readFile(lockFile);
    const files = await adapter.readPublicEvidence(ctx.operationId, result.evidenceSha256);
    assert.equal(files.length, 1); assert.equal(sha(files[0].bytes), result.evidenceSha256);
    const body = JSON.parse(files[0].bytes.toString()); assert.equal(body.operationId, ctx.operationId); assert.equal(body.nonce, ctx.nonce);
    const replacement = new ProductionFz3bAdapter({ resourceRoot, dataDir: directory });
    const replacementInternals = replacement as unknown as typeof internals;
    replacementInternals.projectKey = internals.projectKey;
    replacementInternals.transport = async () => { transports++; throw new Error('Unreachable transport after durable hold'); };
    await adapter.semantic(ctx); await replacement.semantic(ctx); await replacement.inspect(context()); await replacement.build(context());
    assert.equal(transports, 1); assert.deepEqual(await readFile(lockFile), beforeLock);
    assert.deepEqual((await adapter.readPublicEvidence(ctx.operationId, result.evidenceSha256))[0].bytes, files[0].bytes);
  });
}
