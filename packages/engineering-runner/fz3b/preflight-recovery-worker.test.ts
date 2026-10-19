import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, unlink, link, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Fz3bPreflightRecoveryWorker } from './preflight-recovery-worker.js';
import { ProductionFz3bAdapter } from './worker.js';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS as pins } from './preflight-refusal-proof.js';
import { fz3bPreflightAnchor, fz3bPreflightDigest as digest, fz3bPreflightSourceProjection, FZ3B_PREFLIGHT_ACK_DOMAIN, FZ3B_PREFLIGHT_CLOSURE_DOMAIN, FZ3B_PREFLIGHT_RECOVERY_CASE as recoveryCase } from './preflight-recovery.js';
import { fz3bOriginalInspectionContext, fz3bReconciliationOwnerBinding } from './reconciliation.js';
import { fixedFz3bPayload } from './payload.js';
import type { Fz3bArtifact, Fz3bOperation, Fz3bRunView, Fz3bPreflightRefusalRecoveryContext as Context,
  Fz3bPreflightRefusalRecoveryAck as Ack, Fz3bPreflightRefusalRecoveryProof as Proof, Fz3bPreflightRefusalRecoveryFinalization as Finalization,
  Fz3bPreflightRefusalRecoveryAcknowledgment as Acknowledgment, Fz3bPreflightRefusalRecoveryClosure as Closure } from './types.js';

const resources = path.resolve('engineering/fz3b/product/resources');
const encode = (v: unknown, newline = false) => Buffer.from(JSON.stringify(v, null, 2) + (newline ? '\n' : ''));
const failure = 'Error: FZ3B receipt is not terminal and quiescent';

/** Synthetic host-sealed history using public operation identifiers and fixed resource bytes, never a private ledger. */
async function fixture() {
  const base = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/worker-fixtures'); await mkdir(base, { recursive: true });
  const dataDir = await mkdtemp(path.join(base, 'case-')), root = path.join(dataDir, 'fz3b-worker'); await mkdir(root);
  const semanticFixture = JSON.parse(await readFile(path.join(resources, 'fixture/host-fixture.json'), 'utf8'));
  const owner = { runId: '07427a29-0eae-44c7-ac35-34d6650eebee', sessionId: '9309dc73-fb48-4d29-9226-c5496ca2640d',
    taskId: '9309dc73-fb48-4d29-9226-c5496ca2640d', model: 'gpt-6.1-sol', generation: 1792223279715745,
    threadId: '01a148d5-03a5-7911-ab77-08888c07e2a2', turnId: '01a148d5-0884-7d03-9e9d-de97bd68a3b8' };
  const build: Fz3bOperation = { id: 'f5ac2cc5-2dbe-49f1-8145-34873c48c368', requestKey: 'fz3b-7ff9e036050785693c3e10ca3ee8f1c7af3fe66e017014979463909c39936f09', nonce: '538b861dce966cb516d2e50ce63fb9e453b69d2740a4b99cea802956ce8aa765', kind: 'build', status: 'succeeded', dispatchPhase: 'may-have-started', createdAt: '2026-10-17T07:48:08.268Z', updatedAt: '2026-10-17T07:48:08.385Z', processExited: true, remoteQuiescent: true, evidenceSha256: 'e95ce95945e6aa1fd0eadc2e2232a54fa961c6f35a8d590f5dead924a70a92f0' };
  const inspect: Fz3bOperation = { id: 'c6a3e027-abd8-40f7-b64e-d1b8e1a4620b', requestKey: 'fz3b-ef051ca6640a7af7815e4383af2d972b448021d603e0712a6157d18d5bb96de7', nonce: '4d67dddacca4e468e6870c9df3c75601e11b6c9cbf10ec477b4181d5a0ac3d49', kind: 'inspect', status: 'unknown', dispatchPhase: 'may-have-started', createdAt: '2026-10-17T07:48:10.779Z', updatedAt: '2026-10-17T07:48:12.466Z', processExited: true, remoteQuiescent: false, evidenceSha256: '85e658c19cebd39040ed2352948aaadb1b5612443a0b879456bb6744079d2a72', detail: failure };
  const artifactBody = { kind: 'fixed-ps-fixture-package' as const, buildId: build.id, profileSha256: pins.profile, sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
    fixtureManifestSha256: FZ3B_PROFILE.semanticManifestSha256, queriesSha256: FZ3B_PROFILE.queriesSha256, imageSha256: FZ3B_PROFILE.imageSha256, buildEvidenceSha256: build.evidenceSha256!,
    packageSha256: 'ec1d60ae621e74d341fd393c9e5cc846b0e7b2075f4b4bfcd47cbcbaaa6a6f94', packageManifestSha256: 'cb177831310e29ef6f60117a093a4292fdd5e7887e72696bc1da379f86c1deb8', newPlBuilt: false as const, deployed: false as const };
  const artifact: Fz3bArtifact = { id: fz3bDigest(JSON.stringify(artifactBody)), ...artifactBody };
  const source: Fz3bRunView = { ...owner, schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: pins.profile, status: 'needs_attention', phase: 'needs_attention', active: false, hardwareBusy: true, stopRequested: true, nativeApproval: 'not_requested', createdAt: '2026-10-17T07:48:03.313Z', updatedAt: '2026-10-17T07:48:12.473Z',
    calls: [
      { callId: 'call_status', tool: 'fz3b_status', receivedAt: '2026-10-17T07:48:06.024Z', completedAt: '2026-10-17T07:48:06.024Z', status: 'succeeded', result: { runId: owner.runId, callId: 'call_status', tool: 'fz3b_status', ok: true, result: 'status', phase: 'ready' } },
      { callId: 'call_build', tool: 'fz3b_build', receivedAt: '2026-10-17T07:48:07.206Z', completedAt: '2026-10-17T07:48:08.385Z', status: 'succeeded', operationId: build.id, result: { runId: owner.runId, callId: 'call_build', tool: 'fz3b_build', ok: true, result: 'succeeded', phase: 'ready', operation: structuredClone(build), artifact: structuredClone(artifact) } },
      { callId: 'call_inspect', tool: 'fz3b_inspect', receivedAt: '2026-10-17T07:48:09.739Z', completedAt: '2026-10-17T07:48:12.466Z', status: 'unknown', operationId: inspect.id, error: failure, result: { runId: owner.runId, callId: 'call_inspect', tool: 'fz3b_inspect', ok: false, result: 'unknown', phase: 'needs_attention', operation: structuredClone(inspect), message: failure } } ],
    operations: [build, inspect], currentTool: 'fz3b_inspect', artifact, failure };
  const projected = fz3bPreflightSourceProjection(source, semanticFixture);
  const context: Context = { schemaVersion: 1, reason: 'boot-preflight-refused-before-device-v1', id: randomUUID(), nonce: 'a'.repeat(64), createdAt: '2026-10-17T08:00:00.000Z', expiresAt: '2026-10-17T08:05:00.000Z', original: fz3bOriginalInspectionContext(source, inspect, semanticFixture), ownerBindingSha256: digest(fz3bReconciliationOwnerBinding(source)), originalOperationSha256: digest(inspect), originalEvidenceSha256: inspect.evidenceSha256!, sourceRecordSha256: 'b'.repeat(64), sourceProjectionSha256: digest(projected.projection), sourceRun: source, projection: projected.projection, maintenanceExitSha256: null, anchor: fz3bPreflightAnchor(projected.projection) };
  const stdout = fz3bCanonicalJson({ schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile, status: 'failed', remoteQuiescent: false, remoteOutcomeUnknown: false, detail: 'ValueError:boot-changed' }) + '\n';
  const transport = { processExited: true, exitCode: 0, timedOut: false, spawned: true, stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: fz3bDigest(stdout), stderr: '' };
  const header = { schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile, action: 'inspect' };
  const payload = fixedFz3bPayload({ manifestSha256: pins.manifest, fixture: semanticFixture, files: new Map([['remote/remote.py', await readFile(path.join(resources, 'remote/remote.py'))], ['remote/wire.py', await readFile(path.join(resources, 'remote/wire.py'))]]) }, { schemaVersion: 1, action: 'inspect', operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile });
  const directory = path.join(root, inspect.id); await mkdir(directory);
  const files = { 'evidence.json': encode({ ...header, transport, remoteStdout: stdout, remote: JSON.parse(stdout), resourceManifestSha256: pins.manifest, authenticatedTransport: 'pinned-ssh', helloAuthenticated: false }, true), 'intent.json': encode({ ...header, resourceManifestSha256: pins.manifest, payloadSha256: fz3bDigest(payload), dispatchPhase: 'may-have-started' }), 'transport.json': encode({ ...header, resourceManifestSha256: pins.manifest, observedAt: '2026-10-17T07:48:12.457Z', transport }), 'process-exit.json': encode({ schemaVersion: 1, observedClose: true, exitCode: 0, at: '2026-10-17T07:48:12.457Z', outputSha256: fz3bDigest(stdout) }) };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(directory, name), bytes, { flag: 'wx' });
  const lease = Buffer.from(JSON.stringify({ schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, taskId: source.taskId, profileSha256: pins.profile })); await writeFile(path.join(root, 'active.lock'), lease, { flag: 'wx' });
  let children = 0, now = Date.parse(context.createdAt), releases = 0;
  const worker = () => { const value = new Fz3bPreflightRecoveryWorker({ root, resourceRoot: resources, children: () => children, released: () => { releases++; } }); (value as any).now = () => now; return value; };
  const key = Buffer.from('Synthetic backend-only HMAC key, not production authentication');
  const sign = (proof: Proof, finalization: Finalization): Ack => { const body = { schemaVersion: 1 as const, method: 'fz3b-preflight-refusal-post-save-ack-v1' as const, purpose: 'exact-local-inspect-release-only' as const, id: context.id, contextSha256: digest(context), proofSha256: digest(proof), finalizationSha256: digest(finalization), checkpointSha256: 'c'.repeat(64), checkpointUpdatedAt: new Date(now).toISOString(), issuedAt: new Date(now).toISOString() }; return { ...body, mac: createHmac('sha256', key).update(FZ3B_PREFLIGHT_ACK_DOMAIN).update(fz3bCanonicalJson(body)).digest('hex') }; };
  const verify = (ack: Ack) => { const { mac, ...body } = ack; assert.equal(mac, createHmac('sha256', key).update(FZ3B_PREFLIGHT_ACK_DOMAIN).update(fz3bCanonicalJson(body)).digest('hex')); assert.equal(ack.contextSha256, digest(context)); };
  const certify = (proof: Proof, finalization: Finalization, ack: Ack, acknowledgment: Acknowledgment): Closure => {
    const body = { schemaVersion: 1 as const, method: 'fz3b-preflight-refusal-worker-closed-v1' as const, purpose: 'actual-local-barrier-close-only' as const, id: context.id, contextSha256: digest(context), proofSha256: digest(proof), finalizationSha256: digest(finalization), ackSha256: digest(ack), acknowledgmentSha256: digest(acknowledgment), checkpointSha256: ack.checkpointSha256, issuedAt: new Date(now).toISOString() };
    return { ...body, mac: createHmac('sha256', key).update(FZ3B_PREFLIGHT_CLOSURE_DOMAIN).update(fz3bCanonicalJson(body)).digest('hex') };
  };
  const verifyClosure = (ack: Ack, acknowledgment: Acknowledgment, closure: Closure) => {
    verify(ack); const { mac, ...body } = closure; assert.equal(mac, createHmac('sha256', key).update(FZ3B_PREFLIGHT_CLOSURE_DOMAIN).update(fz3bCanonicalJson(body)).digest('hex'));
    assert.equal(closure.ackSha256, digest(ack)); assert.equal(closure.acknowledgmentSha256, digest(acknowledgment)); assert.equal(closure.checkpointSha256, ack.checkpointSha256);
  };
  return { root, dataDir, context, directory, files, lease, worker, sign, verify, certify, verifyClosure, setChildren: (v: number) => { children = v; }, setNow: (v: number) => { now = v; }, releases: () => releases };
}

async function withMaintenance() {
  const f = await fixture();
  const adapter = new ProductionFz3bAdapter({ dataDir: f.dataDir, resourceRoot: resources });
  const processState = await adapter.localProcessState([f.context.original]);
  const raw = await readFile(path.join(f.directory, 'local-close-proof.json'));
  assert.equal(fz3bDigest(raw), recoveryCase.maintenanceLocalCloseProofSha256);
  assert.equal(processState.operations[0].evidenceSha256, recoveryCase.maintenanceLocalCloseProofSha256);
  const source = f.context.sourceRun;
  const body = { schemaVersion: 1 as const, runId: source.runId, sessionId: source.sessionId, taskId: source.taskId,
    profileSha256: source.profileSha256, createdAt: '2026-10-17T07:49:00.000Z', unknownPreserved: true as const,
    localProcessesClosed: true as const, operationSnapshotSha256: digest(source.operations), processState };
  source.maintenanceExit = { ...body, sealSha256: digest(body) }; source.updatedAt = body.createdAt;
  const projection = fz3bPreflightSourceProjection(source, f.context.original.fixture);
  f.context.projection = projection.projection; f.context.sourceProjectionSha256 = digest(projection.projection);
  f.context.maintenanceExitSha256 = projection.maintenanceExitSha256; f.context.anchor = fz3bPreflightAnchor(projection.projection);
  return { ...f, adapter, maintenanceRaw: raw };
}

test('local recovery preserves exact history, requires final backend ACK, and restart only authenticates without replay', async () => {
  const f = await fixture(), w = f.worker(), before = fz3bCanonicalJson(f.context);
  const proof = await w.prepare(f.context); assert.equal(proof.classification.releaseAuthority, 'none'); assert.deepEqual(await readFile(path.join(f.root, 'active.lock')), f.lease);
  const input = await w.readInput(f.context, proof); assert.deepEqual(input.files.evidence, f.files['evidence.json']);
  await assert.rejects(w.assertNoRecoveryBarrier());
  const finalized = await w.finalize(f.context, proof); assert.equal(finalized.barrierRetained, true); await assert.rejects(lstat(path.join(f.root, 'active.lock')));
  await assert.rejects(f.worker().assertNoRecoveryBarrier()); assert.equal(f.releases(), 0);
  const ack = f.sign(proof, finalized); const a = await w.acknowledge(f.context, proof, finalized, ack, f.verify); assert.equal(a.localBarrierRemoved, true); assert.equal(f.releases(), 0);
  await assert.rejects(w.assertNoRecoveryBarrier()); const closure = f.certify(proof, finalized, ack, a);
  await w.certify(f.context, proof, finalized, ack, a, closure, f.verifyClosure); assert.equal(f.releases(), 1);
  await w.assertNoRecoveryBarrier(); const restarted = f.worker(); await assert.rejects(restarted.assertNoRecoveryBarrier(), /AUTHENTICATION_REQUIRED/);
  assert.deepEqual(await restarted.readCompletion(f.context, proof, finalized, f.verify, f.verifyClosure), { ack, acknowledgment: a, closure }); await restarted.assertNoRecoveryBarrier();
  assert.equal(fz3bCanonicalJson(f.context), before); assert.equal(f.context.sourceRun.operations[1].status, 'unknown'); assert.equal(f.context.sourceRun.hardwareBusy, true);
});

for (const stage of ['prepared-evidence.json', 'prepared.json', 'unlink-intent.json', 'finalization-evidence.json', 'finalization.json', 'ack.json', 'acknowledgment-evidence.json', 'acknowledgment.json']) test(`visible-but-failed ${stage} save remains held across new worker`, async () => {
  const f = await fixture(), w = f.worker(); const original = (w as any).persist;
  (w as any).persist = async (file: string, value: unknown) => { await original(file, value); if (path.basename(file) === stage) throw new Error('injected post-write failure'); };
  let proof: Proof | undefined, finalization: Finalization | undefined;
  await assert.rejects(async () => { proof = await w.prepare(f.context); finalization = await w.finalize(f.context, proof); await w.acknowledge(f.context, proof, finalization, f.sign(proof, finalization), f.verify); }, /injected/);
  assert.equal(f.releases(), 0); await assert.rejects(f.worker().assertNoRecoveryBarrier());
  assert.ok(await lstat(path.join(f.root, 'preflight-refusal-recovery.lock')));
});

for (const bad of ['missing-lease', 'foreign-lease', 'multi-link', 'symlink', 'oversize', 'duplicate-json', 'changed-evidence', 'children', 'expiry', 'extra-context']) test(`prepare rejects ${bad} without changing original lease`, async () => {
  const f = await fixture(), w = f.worker(), file = path.join(f.directory, 'intent.json');
  if (bad === 'missing-lease') await unlink(path.join(f.root, 'active.lock'));
  if (bad === 'foreign-lease') await writeFile(path.join(f.root, 'active.lock'), '{}');
  if (bad === 'multi-link') await link(file, path.join(f.directory, 'hardlink'));
  if (bad === 'symlink') { await unlink(file); await symlink(f.directory, file, 'junction'); }
  if (bad === 'oversize') await writeFile(file, Buffer.alloc(131073));
  if (bad === 'duplicate-json') await writeFile(file, '{"schemaVersion":1,"schemaVersion":1}');
  if (bad === 'changed-evidence') await writeFile(path.join(f.directory, 'evidence.json'), '{}');
  if (bad === 'children') f.setChildren(1);
  if (bad === 'expiry') f.setNow(Date.parse(f.context.expiresAt));
  if (bad === 'extra-context') (f.context as any).releaseAllowed = true;
  const prior = await readFile(path.join(f.root, 'active.lock')).catch(() => null); await assert.rejects(w.prepare(f.context));
  assert.deepEqual(await readFile(path.join(f.root, 'active.lock')).catch(() => null), prior); assert.equal(f.releases(), 0);
});

test('missing old lease after intent is not successful finalization, and no retry is automatic', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context);
  (w as any).removeLease = async (file: string) => { await unlink(file); throw Object.assign(new Error('unlink outcome unavailable'), { code: 'ENOENT' }); };
  await assert.rejects(w.finalize(f.context, proof), /unavailable/); await assert.rejects(w.finalize(f.context, proof));
  await assert.rejects(lstat(path.join(f.root, 'preflight-refusal-recoveries', f.context.id, 'finalization.json')));
  await assert.rejects(f.worker().assertNoRecoveryBarrier());
});

for (const bad of ['bad-mac', 'foreign-checkpoint', 'children', 'expired', 'changed-finalization', 'missing-barrier']) test(`completion rejects ${bad} and does not release`, async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), ack = f.sign(proof, finalization);
  if (bad === 'bad-mac') ack.mac = 'f'.repeat(64);
  if (bad === 'foreign-checkpoint') ack.checkpointSha256 = 'e'.repeat(64);
  if (bad === 'children') f.setChildren(1);
  if (bad === 'expired') f.setNow(Date.parse(f.context.expiresAt));
  if (bad === 'changed-finalization') await writeFile(path.join(f.root, 'preflight-refusal-recoveries', f.context.id, 'finalization.json'), '{}');
  if (bad === 'missing-barrier') await unlink(path.join(f.root, 'preflight-refusal-recovery.lock'));
  await assert.rejects(w.acknowledge(f.context, proof, finalization, ack, f.verify)); assert.equal(f.releases(), 0); await assert.rejects(f.worker().assertNoRecoveryBarrier());
});

test('ordinary adapter and legacy recovery reject persistent barrier before any key or transport callback', async () => {
  const f = await fixture(), w = f.worker(); await w.prepare(f.context);
  const adapter = new ProductionFz3bAdapter({ dataDir: f.dataDir, resourceRoot: resources }); let callbacks = 0;
  (adapter as any).projectKey = async () => { callbacks++; throw new Error('must not read key'); };
  (adapter as any).transport = async () => { callbacks++; throw new Error('must not dispatch'); };
  for (const run of [() => adapter.build(f.context.original), () => adapter.inspect(f.context.original), () => adapter.semantic(f.context.original),
    () => adapter.prepareInspectReconciliation({} as any), () => adapter.finalizeInspectReconciliation({} as any, {} as any)]) await assert.rejects(run());
  assert.equal(callbacks, 0);
  const local = await adapter.localProcessState([f.context.original]); assert.equal(local.closed, true); assert.equal(local.liveChildren, 0);
  assert.deepEqual(await readFile(path.join(f.root, 'active.lock')), f.lease); await assert.rejects(w.assertNoRecoveryBarrier());
  (adapter as any).children.add({}); assert.equal((await adapter.localProcessState([f.context.original])).closed, false); assert.equal(callbacks, 0);
});

test('expiry reached during unlink-intent persistence rejects before old lease unlink', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), persist = (w as any).persist;
  (w as any).persist = async (file: string, value: unknown) => { await persist(file, value); if (path.basename(file) === 'unlink-intent.json') f.setNow(Date.parse(f.context.expiresAt)); };
  await assert.rejects(w.finalize(f.context, proof), /EXPIRY/); assert.deepEqual(await readFile(path.join(f.root, 'active.lock')), f.lease);
  await assert.rejects(f.worker().assertNoRecoveryBarrier());
});

test('expiry reached during completion persistence retains barrier despite visible completion markers', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), persist = (w as any).persist;
  (w as any).persist = async (file: string, value: unknown) => { await persist(file, value); if (path.basename(file) === 'acknowledgment.json') f.setNow(Date.parse(f.context.expiresAt)); };
  await assert.rejects(w.acknowledge(f.context, proof, finalization, f.sign(proof, finalization), f.verify), /EXPIRY/);
  assert.equal(f.releases(), 0); await assert.rejects(f.worker().assertNoRecoveryBarrier());
});

test('original evidence changed during unlink-intent persistence is refused before lease removal', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), persist = (w as any).persist;
  (w as any).persist = async (file: string, value: unknown) => { await persist(file, value); if (path.basename(file) === 'unlink-intent.json') await writeFile(path.join(f.directory, 'evidence.json'), '{}'); };
  await assert.rejects(w.finalize(f.context, proof)); assert.deepEqual(await readFile(path.join(f.root, 'active.lock')), f.lease);
  await assert.rejects(f.worker().assertNoRecoveryBarrier());
});

test('completion markers cannot conceal original evidence edits during the last save', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), persist = (w as any).persist;
  (w as any).persist = async (file: string, value: unknown) => { await persist(file, value); if (path.basename(file) === 'acknowledgment.json') await writeFile(path.join(f.directory, 'transport.json'), '{}'); };
  await assert.rejects(w.acknowledge(f.context, proof, finalization, f.sign(proof, finalization), f.verify));
  assert.equal(f.releases(), 0); await assert.rejects(f.worker().assertNoRecoveryBarrier());
});

test('barrier unlink visible then sync and restoration fail: no successful receipt, no closure signer, and new instance remains held', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), ack = f.sign(proof, finalization);
  let closureSignCalls = 0;
  (w as any).removeBarrier = async (file: string) => {
    await unlink(file);
    throw new AggregateError([new Error('injected post-unlink sync failed'), new Error('injected guard restoration failed')], 'ambiguous barrier close');
  };
  await assert.rejects(async () => {
    const a = await w.acknowledge(f.context, proof, finalization, ack, f.verify);
    closureSignCalls++; await w.certify(f.context, proof, finalization, ack, a, f.certify(proof, finalization, ack, a), f.verifyClosure);
  }, /ambiguous barrier close/);
  assert.equal(closureSignCalls, 0); assert.equal(f.releases(), 0); await assert.rejects(lstat(path.join(f.root, 'preflight-refusal-recovery.lock')));
  const restarted = f.worker(); await assert.rejects(restarted.assertNoRecoveryBarrier()); await assert.rejects(restarted.readCompletion(f.context, proof, finalization, f.verify, f.verifyClosure));
  const adapter = new ProductionFz3bAdapter({ dataDir: f.dataDir, resourceRoot: resources }); await assert.rejects(adapter.build(f.context.original));
});

test('a forged closure cannot convert an ambiguous barrier removal into completion', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), ack = f.sign(proof, finalization);
  (w as any).removeBarrier = async (file: string) => { await unlink(file); throw new Error('close not acknowledged'); };
  await assert.rejects(w.acknowledge(f.context, proof, finalization, ack, f.verify));
  const directory = path.join(f.root, 'preflight-refusal-recoveries', f.context.id), a = JSON.parse(await readFile(path.join(directory, 'acknowledgment.json'), 'utf8'));
  const forged = f.certify(proof, finalization, ack, a); forged.mac = '0'.repeat(64);
  await writeFile(path.join(directory, 'closure.json'), encode(forged), { flag: 'wx' });
  await assert.rejects(f.worker().readCompletion(f.context, proof, finalization, f.verify, f.verifyClosure)); assert.equal(f.releases(), 0);
});

test('closure publish failure is current held; a visible authenticated cert only attests the previously successful worker close', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), ack = f.sign(proof, finalization);
  const a = await w.acknowledge(f.context, proof, finalization, ack, f.verify), closure = f.certify(proof, finalization, ack, a), persist = (w as any).persist;
  (w as any).persist = async (file: string, value: unknown) => { await persist(file, value); if (path.basename(file) === 'closure.json') throw new Error('certificate publish readback unavailable'); };
  await assert.rejects(w.certify(f.context, proof, finalization, ack, a, closure, f.verifyClosure)); assert.equal(f.releases(), 0); await assert.rejects(w.assertNoRecoveryBarrier());
  const restarted = f.worker(); assert.deepEqual(await restarted.readCompletion(f.context, proof, finalization, f.verify, f.verifyClosure), { ack, acknowledgment: a, closure });
  assert.equal(f.releases(), 1);
  assert.equal(f.context.sourceRun.operations[1].status, 'unknown'); assert.equal(f.context.sourceRun.hardwareBusy, true);
});

test('read-only completion cannot clear local activity while another actual lease exists', async () => {
  const f = await fixture(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), ack = f.sign(proof, finalization);
  const a = await w.acknowledge(f.context, proof, finalization, ack, f.verify); await w.certify(f.context, proof, finalization, ack, a, f.certify(proof, finalization, ack, a), f.verifyClosure);
  await writeFile(path.join(f.root, 'active.lock'), 'unrelated active operation', { flag: 'wx' });
  await assert.rejects(w.readCompletion(f.context, proof, finalization, f.verify, f.verifyClosure)); assert.equal(f.releases(), 1);
  assert.equal(await readFile(path.join(f.root, 'active.lock'), 'utf8'), 'unrelated active operation');
});

test('actual legacy localProcessState producer supplies the distinct maintenance proof while new proof remains raw observed-close bound', async () => {
  const f = await withMaintenance(), w = f.worker(), before = fz3bCanonicalJson(f.context.sourceRun);
  const proof = await w.prepare(f.context);
  assert.equal(proof.processState.operations[0].evidenceSha256, recoveryCase.actualCloseSha256);
  assert.equal(f.context.sourceRun.maintenanceExit!.processState.operations[0].evidenceSha256, recoveryCase.maintenanceLocalCloseProofSha256);
  const finalization = await w.finalize(f.context, proof), ack = f.sign(proof, finalization);
  const a = await w.acknowledge(f.context, proof, finalization, ack, f.verify), closure = f.certify(proof, finalization, ack, a);
  await w.certify(f.context, proof, finalization, ack, a, closure, f.verifyClosure);
  await f.worker().readCompletion(f.context, proof, finalization, f.verify, f.verifyClosure);
  assert.deepEqual(await readFile(path.join(f.directory, 'local-close-proof.json')), f.maintenanceRaw);
  assert.equal(fz3bCanonicalJson(f.context.sourceRun), before);
});

for (const bad of ['missing', 'extra-key', 'owner', 'rehashed-arbitrary', 'raw-close-in-seal', 'multi-link', 'junction', 'oversize']) test(`maintenance local-close independent domain rejects ${bad} without lease changes`, async () => {
  const f = await withMaintenance(), file = path.join(f.directory, 'local-close-proof.json');
  if (bad === 'missing') await unlink(file);
  if (bad === 'extra-key' || bad === 'owner') { const body = JSON.parse(f.maintenanceRaw.toString()); if (bad === 'extra-key') body.releaseAllowed = true; else body.taskId = 'foreign-task'; await writeFile(file, encode(body)); }
  if (bad === 'rehashed-arbitrary') {
    await writeFile(file, '{}'); const seal = f.context.sourceRun.maintenanceExit!;
    seal.processState.operations[0].evidenceSha256 = fz3bDigest('{}'); const { sealSha256: _old, ...body } = seal; seal.sealSha256 = digest(body);
  }
  if (bad === 'raw-close-in-seal') { const seal = f.context.sourceRun.maintenanceExit!; seal.processState.operations[0].evidenceSha256 = recoveryCase.actualCloseSha256; const { sealSha256: _old, ...body } = seal; seal.sealSha256 = digest(body); }
  if (bad === 'multi-link') await link(file, path.join(f.directory, 'local-close-hardlink'));
  if (bad === 'junction') { await unlink(file); await symlink(f.directory, file, 'junction'); }
  if (bad === 'oversize') await writeFile(file, Buffer.alloc(16385));
  await assert.rejects(f.worker().prepare(f.context)); assert.deepEqual(await readFile(path.join(f.root, 'active.lock')), f.lease);
});

for (const stage of ['unlink-intent.json', 'acknowledgment.json']) test(`maintenance bytes changed during ${stage} persistence are rechecked before the next unlink`, async () => {
  const f = await withMaintenance(), w = f.worker(), proof = await w.prepare(f.context), persist = (w as any).persist;
  (w as any).persist = async (file: string, value: unknown) => { await persist(file, value); if (path.basename(file) === stage) await writeFile(path.join(f.directory, 'local-close-proof.json'), '{}'); };
  await assert.rejects(async () => { const finalization = await w.finalize(f.context, proof); await w.acknowledge(f.context, proof, finalization, f.sign(proof, finalization), f.verify); });
  if (stage === 'unlink-intent.json') assert.deepEqual(await readFile(path.join(f.root, 'active.lock')), f.lease);
  await assert.rejects(f.worker().assertNoRecoveryBarrier()); assert.equal(f.releases(), 0);
});

test('maintenance proof changed after completed recovery prevents read-only restart admission', async () => {
  const f = await withMaintenance(), w = f.worker(), proof = await w.prepare(f.context), finalization = await w.finalize(f.context, proof), ack = f.sign(proof, finalization);
  const a = await w.acknowledge(f.context, proof, finalization, ack, f.verify), closure = f.certify(proof, finalization, ack, a);
  await w.certify(f.context, proof, finalization, ack, a, closure, f.verifyClosure);
  await writeFile(path.join(f.directory, 'local-close-proof.json'), '{}');
  await assert.rejects(f.worker().readCompletion(f.context, proof, finalization, f.verify, f.verifyClosure));
});
