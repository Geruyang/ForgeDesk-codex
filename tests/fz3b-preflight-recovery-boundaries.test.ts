import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Fz3bAgentMain, type Fz3bAgentMainOptions } from '../apps/desktop/main/fz3b-agent';
import { requestNativeFz3bPreflightRefusalRecovery } from '../apps/desktop/main/fz3b-recovery-approval';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest, fz3bProfileSha256 } from '../packages/engineering-runner/fz3b/profile';
import { fixedFz3bPayload } from '../packages/engineering-runner/fz3b/payload';
import { verifyFz3bPreflightRefusal, type Fz3bPreflightRefusalInput } from '../packages/engineering-runner/fz3b/preflight-refusal-proof';
import { FZ3B_PREFLIGHT_RECOVERY_CASE, fz3bPreflightAnchor, fz3bPreflightDigest,
  assertFz3bMaintenanceLocalCloseProof, assertFz3bPreflightRecoveryProof,
  fz3bPreflightRecordProjection, fz3bPreflightSourceProjection } from '../packages/engineering-runner/fz3b/preflight-recovery';
import { Fz3bBackend, type Fz3bBackendOptions } from '../packages/engineering-runner/fz3b/backend';
import { Fz3bPreflightRecoveryWorker } from '../packages/engineering-runner/fz3b/preflight-recovery-worker';
import { ProductionFz3bAdapter } from '../packages/engineering-runner/fz3b/worker';
import type { Fz3bArtifact, Fz3bLocalProcessState, Fz3bOperation, Fz3bPreflightRefusalRecoveryContext, Fz3bRunView, Fz3bSemanticFixture } from '../packages/engineering-runner/fz3b/types';
import type { Session } from '../packages/shared/contracts';

const fixture = JSON.parse(readFileSync(new URL('../engineering/fz3b/product/resources/fixture/host-fixture.json', import.meta.url), 'utf8')) as Fz3bSemanticFixture;
const created = Date.parse('2026-10-17T12:00:00.000Z');
const approved = { response: 1, checkboxChecked: true };

// Presentation-only native fixture; not a classified run, HMAC anchor or release proof.
function nativePreview(): Fz3bPreflightRefusalRecoveryContext {
  const sourceRun: Fz3bRunView = { schemaVersion: 1, runId: 'offline-run', taskId: 'offline-task', sessionId: 'offline-session',
    model: 'gpt-6.1-sol', generation: 17, threadId: 'offline-thread', turnId: 'offline-turn',
    profileId: FZ3B_PROFILE.id, profileSha256: fz3bProfileSha256(fixture), status: 'needs_attention', phase: 'needs_attention',
    active: false, hardwareBusy: true, stopRequested: true, nativeApproval: 'not_requested',
    createdAt: new Date(created - 1000).toISOString(), updatedAt: new Date(created).toISOString(), operations: [], calls: [] };
  return { schemaVersion: 1, reason: 'boot-preflight-refused-before-device-v1', id: 'offline-local-recovery', nonce: 'a'.repeat(64),
    createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString(),
    original: { runId: sourceRun.runId, taskId: sourceRun.taskId, sessionId: sourceRun.sessionId,
      operationId: 'offline-inspect', requestKey: 'offline-request', nonce: 'b'.repeat(64), profileSha256: sourceRun.profileSha256, fixture },
    ownerBindingSha256: '1'.repeat(64), originalOperationSha256: '2'.repeat(64), originalEvidenceSha256: '3'.repeat(64),
    sourceRecordSha256: '4'.repeat(64), sourceProjectionSha256: '5'.repeat(64), maintenanceExitSha256: null,
    sourceRun, projection: structuredClone(sourceRun), anchor: { owner: {
      runId: sourceRun.runId, taskId: sourceRun.taskId, sessionId: sourceRun.sessionId, model: sourceRun.model,
      generation: sourceRun.generation, threadId: sourceRun.threadId, turnId: sourceRun.turnId! },
      operationId: 'offline-inspect', runSha256: '5'.repeat(64), operationSha256: '2'.repeat(64),
      evidenceSha256: '3'.repeat(64), intentSha256: '6'.repeat(64), transportSha256: '7'.repeat(64), actualCloseSha256: '8'.repeat(64) } };
}

test('local preflight native presentation discloses local-only scope and requires checkbox', async () => {
  for (const checkboxChecked of [undefined, false, true]) {
    const context = nativePreview(); let owners = 0, shown = 0;
    const result = await requestNativeFz3bPreflightRefusalRecovery(context, new AbortController().signal, {
      now: () => created + 1,
      assertOwner: value => { assert.equal(value.runId, context.original.runId); owners++; },
      show: async options => {
        shown++;
        assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.checkboxChecked, false);
        assert.match(options.title!, /本地预检拒绝恢复/);
        assert.match(options.detail, /不连接 SSH/); assert.match(options.detail, /不授权新 Boot/); assert.match(options.detail, /原 unknown/);
        assert.equal(options.signal?.aborted, false);
        return { response: 1, checkboxChecked };
      },
    });
    assert.equal(result, checkboxChecked === true); assert.equal(shown, 1);
    assert.equal(owners, checkboxChecked === true ? 2 : 1);
  }
});

for (const [name, mutate] of [
  ['recovery nonce', (c: Fz3bPreflightRefusalRecoveryContext) => { c.nonce = 'f'.repeat(64); }],
  ['original nonce', (c: Fz3bPreflightRefusalRecoveryContext) => { c.original.nonce = 'f'.repeat(64); }],
  ['original profile', (c: Fz3bPreflightRefusalRecoveryContext) => { c.original.profileSha256 = 'f'.repeat(64); }],
  ['original request key', (c: Fz3bPreflightRefusalRecoveryContext) => { c.original.requestKey = 'foreign'; }],
  ['source semantic', (c: Fz3bPreflightRefusalRecoveryContext) => { Object.assign(c.sourceRun, { semantic: { synthetic: true } }); }],
  ['projected grant', (c: Fz3bPreflightRefusalRecoveryContext) => { Object.assign(c.projection, { grant: { id: 'foreign' } }); }],
  ['anchor close hash', (c: Fz3bPreflightRefusalRecoveryContext) => { c.anchor.actualCloseSha256 = 'f'.repeat(64); }],
] as const) {
  test(`native asynchronous ${name} mutation cannot authorize a changed recovery context`, async () => {
    const context = nativePreview();
    await assert.rejects(requestNativeFz3bPreflightRefusalRecovery(context, new AbortController().signal, {
      now: () => created + 1, assertOwner: () => {}, show: async () => { mutate(context); return approved; },
    }), /PREVIEW_CHANGED/);
  });
}

test('original native deadline, abort and wall-clock rollback deny even a late affirmative callback', async () => {
  for (const [label, after] of [['exact-expiry', created + 300000], ['late', created + 300001], ['rollback', created - 1]] as const) {
    const context = nativePreview(); let clock = created + 1;
    const result = await requestNativeFz3bPreflightRefusalRecovery(context, new AbortController().signal, {
      now: () => clock, assertOwner: () => {}, show: async () => { clock = after; return approved; },
    });
    assert.equal(result, false, label);
  }
  const abort = new AbortController(); let shown = 0;
  const result = await requestNativeFz3bPreflightRefusalRecovery(nativePreview(), abort.signal, {
    now: () => created + 1, assertOwner: () => {}, show: async options => { shown++; abort.abort(); assert.equal(options.signal?.aborted, true); return approved; },
  });
  assert.equal(result, false); assert.equal(shown, 1);
});

test('pre-dialog fresh owner wait cannot mutate context or extend TTL before presentation', async () => {
  const context = nativePreview(); let shown = 0;
  await assert.rejects(requestNativeFz3bPreflightRefusalRecovery(context, new AbortController().signal, {
    now: () => created + 1,
    assertOwner: () => { context.expiresAt = new Date(created + 600000).toISOString(); },
    show: async () => { shown++; return approved; },
  }), /PREVIEW_CHANGED/);
  assert.equal(shown, 0);
});

// Reconstructed public bytes and synthetic run; never an original private ledger.
function fixedRefusalInput(): Fz3bPreflightRefusalInput {
  const read = (name: string) => readFileSync(new URL(`../engineering/fz3b/product/resources/${name}`, import.meta.url));
  const resources = { manifest: read('manifest.json'), remote: read('remote/remote.py'), wire: read('remote/wire.py'), fixture: read('fixture/host-fixture.json') };
  const owner = { runId: FZ3B_PREFLIGHT_RECOVERY_CASE.runId, sessionId: '9309dc73-fb48-4d29-9226-c5496ca2640d',
    taskId: '9309dc73-fb48-4d29-9226-c5496ca2640d', model: 'gpt-6.1-sol', generation: 1792223279715745,
    threadId: '01a148d5-03a5-7911-ab77-08888c07e2a2', turnId: '01a148d5-0884-7d03-9e9d-de97bd68a3b8' };
  const failure = 'Error: FZ3B receipt is not terminal and quiescent';
  const build: Fz3bOperation = { id: 'f5ac2cc5-2dbe-49f1-8145-34873c48c368',
    requestKey: 'fz3b-7ff9e036050785693c3e10ca3ee8f1c7af3fe66e017014979463909c39936f09',
    nonce: '538b861dce966cb516d2e50ce63fb9e453b69d2740a4b99cea802956ce8aa765', kind: 'build', status: 'succeeded',
    dispatchPhase: 'may-have-started', createdAt: '2026-10-17T07:48:08.268Z', updatedAt: '2026-10-17T07:48:08.385Z',
    processExited: true, remoteQuiescent: true, evidenceSha256: 'e95ce95945e6aa1fd0eadc2e2232a54fa961c6f35a8d590f5dead924a70a92f0' };
  const inspect: Fz3bOperation = { id: FZ3B_PREFLIGHT_RECOVERY_CASE.operationId,
    requestKey: 'fz3b-ef051ca6640a7af7815e4383af2d972b448021d603e0712a6157d18d5bb96de7',
    nonce: FZ3B_PREFLIGHT_RECOVERY_CASE.nonce, kind: 'inspect', status: 'unknown', dispatchPhase: 'may-have-started',
    createdAt: '2026-10-17T07:48:10.779Z', updatedAt: '2026-10-17T07:48:12.466Z', processExited: true, remoteQuiescent: false,
    evidenceSha256: FZ3B_PREFLIGHT_RECOVERY_CASE.evidenceSha256, detail: failure };
  const body = { kind: 'fixed-ps-fixture-package' as const, buildId: build.id, profileSha256: fz3bProfileSha256(fixture),
    sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256, fixtureManifestSha256: fixture.manifestSha256,
    queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256, buildEvidenceSha256: build.evidenceSha256!,
    packageSha256: 'ec1d60ae621e74d341fd393c9e5cc846b0e7b2075f4b4bfcd47cbcbaaa6a6f94',
    packageManifestSha256: 'cb177831310e29ef6f60117a093a4292fdd5e7887e72696bc1da379f86c1deb8', newPlBuilt: false as const, deployed: false as const };
  const artifact: Fz3bArtifact = { id: fz3bDigest(JSON.stringify(body)), ...body };
  const run: Fz3bRunView = { ...owner, schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: body.profileSha256,
    status: 'needs_attention', phase: 'needs_attention', active: false, hardwareBusy: true, stopRequested: true, nativeApproval: 'not_requested',
    createdAt: '2026-10-17T07:48:03.313Z', updatedAt: '2026-10-17T07:48:12.473Z', currentTool: 'fz3b_inspect', artifact, failure,
    operations: [build, inspect], calls: [
      { callId: 'call_status', tool: 'fz3b_status', receivedAt: '2026-10-17T07:48:06.024Z', completedAt: '2026-10-17T07:48:06.024Z', status: 'succeeded',
        result: { runId: owner.runId, callId: 'call_status', tool: 'fz3b_status', ok: true, result: 'status', phase: 'ready' } },
      { callId: 'call_build', tool: 'fz3b_build', receivedAt: '2026-10-17T07:48:07.206Z', completedAt: build.updatedAt, status: 'succeeded', operationId: build.id,
        result: { runId: owner.runId, callId: 'call_build', tool: 'fz3b_build', ok: true, result: 'succeeded', phase: 'ready', operation: structuredClone(build), artifact: structuredClone(artifact) } },
      { callId: 'call_inspect', tool: 'fz3b_inspect', receivedAt: '2026-10-17T07:48:09.739Z', completedAt: inspect.updatedAt, status: 'unknown', operationId: inspect.id,
        error: failure, result: { runId: owner.runId, callId: 'call_inspect', tool: 'fz3b_inspect', ok: false, result: 'unknown', phase: 'needs_attention', operation: structuredClone(inspect), message: failure } },
    ] };
  const remote = { schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: run.profileSha256,
    status: 'failed', remoteQuiescent: false, remoteOutcomeUnknown: false, detail: 'ValueError:boot-changed' };
  const stdout = fz3bCanonicalJson(remote) + '\n';
  const transport = { processExited: true, exitCode: 0, timedOut: false, spawned: true, stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: fz3bDigest(stdout), stderr: '' };
  const request = { schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: run.profileSha256, action: 'inspect' as const };
  const manifestSha256 = fz3bDigest(resources.manifest);
  const payload = fixedFz3bPayload({ fixture, manifestSha256, files: new Map([['remote/remote.py', resources.remote], ['remote/wire.py', resources.wire]]) },
    { schemaVersion: 1, action: 'inspect', operationId: inspect.id, nonce: inspect.nonce, profileSha256: run.profileSha256 });
  const encode = (value: unknown, newline = false) => Buffer.from(JSON.stringify(value, null, 2) + (newline ? '\n' : ''));
  return { run, anchor: fz3bPreflightAnchor(run), resources, files: {
    evidence: encode({ ...request, transport, remoteStdout: stdout, remote: JSON.parse(stdout), resourceManifestSha256: manifestSha256, authenticatedTransport: 'pinned-ssh', helloAuthenticated: false }, true),
    intent: encode({ ...request, resourceManifestSha256: manifestSha256, payloadSha256: fz3bDigest(payload), dispatchPhase: 'may-have-started' }),
    transport: encode({ ...request, resourceManifestSha256: manifestSha256, observedAt: '2026-10-17T07:48:12.457Z', transport }),
    actualClose: encode({ schemaVersion: 1, observedClose: true, exitCode: 0, at: '2026-10-17T07:48:12.457Z', outputSha256: fz3bDigest(stdout) }),
  } };
}

function privateRecord(input: Fz3bPreflightRefusalInput) {
  const build = input.run.operations[0], artifact = input.run.artifact!;
  return { ...structuredClone(input.run), step: 1, results: { fz3b_build: structuredClone(input.run.calls[1].result) }, receipts: {
    [build.id]: { schemaVersion: 1, operationId: build.id, nonce: build.nonce, profileSha256: input.run.profileSha256,
      kind: 'build', status: 'succeeded', processExited: true, remoteQuiescent: true, remoteOutcomeUnknown: false, evidenceSha256: build.evidenceSha256,
      sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256, fixtureManifestSha256: fixture.manifestSha256,
      queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256, newPlBuilt: false, deployed: false,
      packageSha256: artifact.packageSha256, packageManifestSha256: artifact.packageManifestSha256 },
  } };
}

test('consumer public fixture reproduces all four fixed original bytes without a private ledger', () => {
  const input = fixedRefusalInput();
  for (const name of ['evidence', 'intent', 'transport', 'actualClose'] as const) {
    assert.equal(fz3bDigest(input.files[name]), FZ3B_PREFLIGHT_RECOVERY_CASE[`${name}Sha256`], name);
  }
  const proof = verifyFz3bPreflightRefusal(input);
  assert.equal(proof.files.evidenceSha256, FZ3B_PREFLIGHT_RECOVERY_CASE.evidenceSha256);
  assert.equal(proof.files.intentSha256, FZ3B_PREFLIGHT_RECOVERY_CASE.intentSha256);
  assert.equal(proof.files.transportSha256, FZ3B_PREFLIGHT_RECOVERY_CASE.transportSha256);
  assert.equal(proof.files.actualCloseSha256, FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256);
  assert.equal(proof.stdoutBytes, 337); assert.equal(proof.releaseAuthority, 'none');
});

test('maintenance exit projection removes only its validated seal and never hides grant or semantic authority', () => {
  const input = fixedRefusalInput(), original = structuredClone(input.run);
  const sealBody = { schemaVersion: 1 as const, runId: original.runId, taskId: original.taskId, sessionId: original.sessionId,
    profileSha256: original.profileSha256, createdAt: '2026-10-17T07:49:00.000Z', unknownPreserved: true as const,
    localProcessesClosed: true as const, operationSnapshotSha256: fz3bPreflightDigest(original.operations),
    processState: { closed: true, liveChildren: 0, operations: [{ operationId: original.operations[1].id, nonce: original.operations[1].nonce,
      closeConfirmed: true, evidenceSha256: FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256 }] } as Fz3bLocalProcessState };
  const wrongDomain = { ...original, updatedAt: sealBody.createdAt, maintenanceExit: { ...sealBody, sealSha256: fz3bPreflightDigest(sealBody) } };
  assert.throws(() => fz3bPreflightSourceProjection(wrongDomain, fixture), /LOCAL_PROCESS_OWNER/,
    'The old synthetic fixture incorrectly used raw process-exit SHA as legacy aggregate-proof SHA');
  sealBody.processState.operations[0].evidenceSha256 = FZ3B_PREFLIGHT_RECOVERY_CASE.maintenanceLocalCloseProofSha256;
  const current = { ...original, updatedAt: sealBody.createdAt, maintenanceExit: { ...sealBody, sealSha256: fz3bPreflightDigest(sealBody) } };
  const projected = fz3bPreflightSourceProjection(current, fixture);
  assert.equal(projected.projection.maintenanceExit, undefined);
  assert.deepEqual(projected.projection.operations, original.operations); assert.deepEqual(projected.projection.calls, original.calls);
  assert.notEqual(projected.maintenanceExitSha256, null);
  for (const [key, value] of [['grant', { id: 'must-not-disappear' }], ['semantic', { synthetic: true }], ['identity', { bootId: 'new-boot' }], ['extra', true]] as const) {
    assert.throws(() => fz3bPreflightSourceProjection({ ...current, [key]: value }, fixture), /CLOSED_SCHEMA/);
  }
});

test('private record projection validates internal results and receipts rather than accepting a public self-report', () => {
  const input = fixedRefusalInput(), record = privateRecord(input);
  assert.equal(fz3bPreflightRecordProjection(record, fixture).sourceRecordSha256, fz3bPreflightDigest(record));
  for (const change of [
    (r: any) => { r.step = 2; },
    (r: any) => { r.results.fz3b_semantic = { result: 'succeeded' }; },
    (r: any) => { r.receipts.extra = { status: 'unknown' }; },
    (r: any) => { r.grant = { id: 'do-not-hide' }; },
    (r: any) => { r.calls.push({ tool: 'fz3b_semantic', status: 'unknown' }); },
  ]) {
    const altered = structuredClone(record); change(altered);
    assert.throws(() => fz3bPreflightRecordProjection(altered, fixture));
  }
});

const fixtureRoot = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/consumer-fixtures');
const resourceRoot = path.resolve('engineering/fz3b/product/resources');
type PrivateBackend = { records: Map<string, any>; save(record: any): Promise<void> };

async function recoveryFixture() {
  await mkdir(fixtureRoot, { recursive: true });
  const home = await mkdtemp(path.join(fixtureRoot, 'offline-'));
  const workerRoot = path.join(home, 'fz3b-worker');
  const input = fixedRefusalInput(), operation = input.run.operations[1];
  await mkdir(path.join(workerRoot, operation.id), { recursive: true });
  for (const [key, name] of [['evidence', 'evidence.json'], ['intent', 'intent.json'], ['transport', 'transport.json'], ['actualClose', 'process-exit.json']] as const) {
    await writeFile(path.join(workerRoot, operation.id, name), input.files[key], { flag: 'wx' });
  }
  const lease = path.join(workerRoot, 'active.lock');
  await writeFile(lease, JSON.stringify({ schemaVersion: 1, operationId: operation.id, nonce: operation.nonce,
    taskId: input.run.taskId, profileSha256: input.run.profileSha256 }), { flag: 'wx' });
  const state = { now: created, native: true, owner: true, children: 0, released: 0, dispatch: 0, events: [] as string[] };
  const worker = new Fz3bPreflightRecoveryWorker({ root: workerRoot, resourceRoot,
    children: () => state.children, released: () => { state.released++; } });
  (worker as unknown as { now(): number }).now = () => state.now;
  const unavailable = async () => { state.dispatch++; throw new Error('Offline consumer forbids all compute/transport'); };
  const options: Fz3bBackendOptions = { dataDir: home, fixture, now: () => state.now, checkRuntime: async () => {}, assertOwner: () => {},
    assertRecoveryOwner: owner => { if (!state.owner || owner.runId !== input.run.runId) throw new Error('Synthetic owner drift'); },
    requestSemantic: async () => { throw new Error('Semantic consent is never part of local recovery'); },
    requestPreflightRefusalRecovery: async () => { state.events.push('native'); return state.native; },
    adapter: { build: unavailable, inspect: unavailable, semantic: unavailable, readPublicEvidence: unavailable,
      localProcessState: async contexts => ({ closed: state.children === 0, liveChildren: state.children,
        operations: contexts.map(context => ({ operationId: context.operationId, nonce: context.nonce, closeConfirmed: true,
          evidenceSha256: FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256 })) }),
      preparePreflightRefusalRecovery: async context => { state.events.push('prepare'); return worker.prepare(context); },
      readPreflightRefusalRecoveryInput: (context, proof) => worker.readInput(context, proof),
      finalizePreflightRefusalRecovery: async (context, proof) => { state.events.push('finalize'); return worker.finalize(context, proof); },
      acknowledgePreflightRefusalRecovery: async (context, proof, finalization, ack, verify) => {
        state.events.push('ack'); return worker.acknowledge(context, proof, finalization, ack, verify);
      },
      readPreflightRefusalRecoveryCompletion: async (context, proof, finalization, verify, verifyClosure) => {
        state.events.push('read-completion'); return worker.readCompletion(context, proof, finalization, verify, verifyClosure);
      },
      certifyPreflightRefusalRecovery: async (context, proof, finalization, ack, acknowledgment, closure, verify) => {
        state.events.push('certify'); return worker.certify(context, proof, finalization, ack, acknowledgment, closure, verify);
      },
    } };
  const backend = new Fz3bBackend(options);
  await backend.list();
  const internal = backend as unknown as PrivateBackend;
  const record = privateRecord(input);
  internal.records.set(input.run.runId, record);
  await internal.save(record); // Actual backend HMAC save; synthetic home/key only, key bytes never read.
  const ledger = path.join(home, 'fz3b-agent', `${input.run.runId}.json`);
  return { home, workerRoot, input, lease, state, worker, backend, options, internal, record, ledger,
    recover: () => backend.reconcilePreflightRefusedInspect(input.run.runId) };
}

async function productionMaintenanceFixture() {
  const f = await recoveryFixture();
  const producer = new ProductionFz3bAdapter({ resourceRoot, dataDir: f.home });
  const seams = producer as unknown as { projectKey(): Promise<never>; transport(...args: unknown[]): Promise<never> };
  seams.projectKey = async () => { throw new Error('A local maintenance producer cannot read a project key'); };
  seams.transport = async () => { throw new Error('A local maintenance producer cannot dispatch transport'); };
  f.options.adapter.localProcessState = contexts => producer.localProcessState(contexts);
  const seal = await f.backend.prepareMaintenanceExit(f.input.run.runId);
  const source = (await f.backend.status(f.input.run.runId))!;
  const raw = await readFile(path.join(f.workerRoot, f.input.run.operations[1].id, 'local-close-proof.json'));
  return { ...f, source, seal, raw };
}

test('actual maintenance producer and recovery proof have distinct aggregate and raw-close digest domains', async () => {
  const f = await productionMaintenanceFixture(), approvedCase = FZ3B_PREFLIGHT_RECOVERY_CASE;
  assert.equal(fz3bDigest(f.raw), approvedCase.maintenanceLocalCloseProofSha256);
  assert.equal(f.seal.processState.operations[0].evidenceSha256, approvedCase.maintenanceLocalCloseProofSha256);
  assert.notEqual(f.seal.processState.operations[0].evidenceSha256, approvedCase.actualCloseSha256);
  assert.equal(fz3bDigest(f.input.files.actualClose), approvedCase.actualCloseSha256);
  const facts = assertFz3bMaintenanceLocalCloseProof(f.raw, f.source);
  assert.equal(facts.originalCloseSha256, approvedCase.actualCloseSha256);
  assert.equal(facts.originalEvidenceSha256, approvedCase.evidenceSha256);
  assert.equal(facts.originalIntentSha256, approvedCase.intentSha256);
  assert.equal(facts.historicalPidAttested, false);
  assert.equal((await f.backend.recoveryActions(f.source.runId)).reconcilePreflightRefusedInspect, true,
    'The installed capability must accept the actual producer format, not only a handcrafted seal');
  const prepare = f.options.adapter.preparePreflightRefusalRecovery!;
  let reached = false;
  f.options.adapter.preparePreflightRefusalRecovery = async context => {
    const proof = await prepare(context); reached = true;
    assert.equal(context.sourceRun.maintenanceExit?.processState.operations[0].evidenceSha256, approvedCase.maintenanceLocalCloseProofSha256);
    assert.equal(proof.processState.operations[0].evidenceSha256, approvedCase.actualCloseSha256);
    assertFz3bPreflightRecoveryProof(context, proof, f.state.now);
    const swapped = structuredClone(proof); swapped.processState.operations[0].evidenceSha256 = approvedCase.maintenanceLocalCloseProofSha256;
    assert.throws(() => assertFz3bPreflightRecoveryProof(context, swapped, f.state.now), /LOCAL_PROCESS_OWNER/);
    throw new Error('Intentional independent domain-contract stop before any lease finalization');
  };
  await assert.rejects(f.recover(), /Intentional independent domain-contract stop/);
  assert.equal(reached, true); assert.equal(f.state.events.includes('finalize'), false);
  assert.equal((await f.backend.status(f.source.runId))?.hardwareBusy, true);
  assert.equal(f.state.released, 0); assert.equal(f.state.dispatch, 0);
});

test('production maintenance proof is byte-bound and cannot be replaced by semantically similar JSON or raw actual-close', async () => {
  const f = await productionMaintenanceFixture(), value = JSON.parse(f.raw.toString('utf8'));
  for (const replacement of [f.input.files.actualClose, Buffer.concat([f.raw, Buffer.from('\n')]),
    Buffer.from(JSON.stringify(value)), Buffer.from(JSON.stringify({ ...value, historicalPidAttested: true }, null, 2)),
    Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(value).reverse()), null, 2))]) {
    assert.throws(() => assertFz3bMaintenanceLocalCloseProof(replacement, f.source), /MAINTENANCE_LOCAL_CLOSE_BYTES/);
  }
  for (const change of [
    (run: Fz3bRunView) => { run.sessionId = 'foreign-session'; },
    (run: Fz3bRunView) => { run.taskId = 'foreign-task'; },
    (run: Fz3bRunView) => { run.maintenanceExit!.processState.operations[0].evidenceSha256 = FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256; },
  ]) {
    const changed = structuredClone(f.source); change(changed);
    const { sealSha256: _old, ...body } = changed.maintenanceExit!; changed.maintenanceExit!.sealSha256 = fz3bPreflightDigest(body);
    assert.throws(() => assertFz3bMaintenanceLocalCloseProof(f.raw, changed));
  }
  assert.equal(f.state.events.includes('native'), false); assert.equal(f.state.dispatch, 0);
});

function freshReader(f: Awaited<ReturnType<typeof recoveryFixture>>) {
  // The production callback only resets this adapter's in-memory busy bit; it submits no action.
  const worker = new Fz3bPreflightRecoveryWorker({ root: f.workerRoot, resourceRoot, children: () => 0, released: () => {} });
  const options: Fz3bBackendOptions = { ...f.options, adapter: { ...f.options.adapter,
    readPreflightRefusalRecoveryCompletion: (context, proof, finalization, verify, verifyClosure) =>
      worker.readCompletion(context, proof, finalization, verify, verifyClosure),
  } };
  return { worker, backend: new Fz3bBackend(options), options };
}

async function attemptDirectory(f: Awaited<ReturnType<typeof recoveryFixture>>) {
  const directory = path.join(f.workerRoot, 'preflight-refusal-recoveries');
  const entries = await readdir(directory); assert.equal(entries.length, 1);
  return path.join(directory, entries[0]);
}

test('real backend HMAC and local worker complete only this inspect while preserving original unknown', async () => {
  const f = await recoveryFixture(), original = structuredClone(f.input.run);
  const view = await f.recover();
  assert.equal(view.hardwareBusy, false); assert.equal(view.active, false); assert.equal(view.nativeApproval, 'not_requested');
  assert.deepEqual(view.operations, original.operations); assert.deepEqual(view.calls, original.calls);
  assert.equal(view.operations[1].status, 'unknown'); assert.equal(view.operations[1].remoteQuiescent, false);
  assert.equal(view.grant, undefined); assert.equal(view.semantic, undefined); assert.equal(view.identity, undefined);
  assert.deepEqual(f.state.events, ['native', 'prepare', 'finalize', 'ack', 'certify']); assert.equal(f.state.dispatch, 0); assert.equal(f.state.released, 1);
  const saved = JSON.parse(await readFile(f.ledger, 'utf8'));
  assert.match(saved.mac, /^[a-f0-9]{64}$/); assert.equal(saved.payload.preflightRefusalRecoveries[0].status, 'released');
  assert.equal(saved.payload.preflightRefusalRecoveries[0].ack, undefined, 'Worker completion must not require another fallible ledger write');
  const before = await readFile(f.ledger);
  const restarted = new Fz3bBackend(f.options), restored = await restarted.status(original.runId);
  assert.equal(restored?.hardwareBusy, false); assert.deepEqual(restored?.operations, original.operations);
  assert.deepEqual(await readFile(f.ledger), before); assert.equal(f.state.dispatch, 0);
  assert.equal(f.state.released, 2, 'Authenticated restart read resets only the adapter in-memory busy bit');
  assert.deepEqual(f.state.events, ['native', 'prepare', 'finalize', 'ack', 'certify', 'read-completion']);
});

test('public caller rehashing cannot repair an unauthenticated fixture ledger on restart', async () => {
  const f = await recoveryFixture(), originalLease = await readFile(f.lease);
  const envelope = JSON.parse(await readFile(f.ledger, 'utf8'));
  envelope.payload.operations[1].nonce = 'f'.repeat(64);
  envelope.payload.calls[2].result.operation = structuredClone(envelope.payload.operations[1]);
  await writeFile(f.ledger, JSON.stringify(envelope));
  await assert.rejects(new Fz3bBackend(f.options).list(), /integrity failed/);
  assert.deepEqual(await readFile(f.lease), originalLease); assert.deepEqual(f.state.events, []); assert.equal(f.state.dispatch, 0);
});

for (const key of ['grant', 'semantic', 'identity'] as const) {
  test(`even an authentic synthetic HMAC record with ${key} cannot enter the inspect-only recovery exception`, async () => {
    const f = await recoveryFixture(); (f.record as any)[key] = { id: 'must-not-be-projected-away' };
    await f.internal.save(f.record);
    await assert.rejects(f.recover(), /CLOSED_SCHEMA|SOURCE/);
    assert.deepEqual(f.state.events, []); assert.equal(f.state.dispatch, 0);
  });
}

for (const mode of ['cancel', 'expiry', 'owner'] as const) {
  test(`native ${mode} cannot dispatch local prepare or exact lease removal`, async () => {
    const f = await recoveryFixture(), lease = await readFile(f.lease);
    f.options.requestPreflightRefusalRecovery = async context => {
      f.state.events.push('native');
      if (mode === 'expiry') f.state.now = Date.parse(context.expiresAt);
      if (mode === 'owner') f.state.owner = false;
      return mode !== 'cancel';
    };
    await assert.rejects(f.recover());
    assert.deepEqual(f.state.events, ['native']); assert.deepEqual(await readFile(f.lease), lease);
    assert.equal((await f.backend.status(f.input.run.runId))?.hardwareBusy, true); assert.equal(f.state.dispatch, 0);
  });
}

for (const name of ['evidence.json', 'intent.json', 'transport.json', 'process-exit.json']) {
  test(`changed original ${name} refuses against host-pinned bytes before finalization`, async () => {
    const f = await recoveryFixture(), lease = await readFile(f.lease);
    await writeFile(path.join(f.workerRoot, f.input.run.operations[1].id, name), '{}');
    await assert.rejects(f.recover());
    assert.equal(f.state.events.includes('finalize'), false); assert.deepEqual(await readFile(f.lease), lease);
    assert.equal((await f.backend.status(f.input.run.runId))?.hardwareBusy, true); assert.equal(f.state.dispatch, 0);
  });
}

test('a visible but failed final HMAC checkpoint never emits an ACK and restart stays held', async () => {
  const f = await recoveryFixture(), save = f.internal.save.bind(f.backend); let injected = false;
  f.internal.save = async record => {
    await save(record);
    if (!injected && record.preflightRefusalRecoveries?.[0]?.status === 'released') {
      injected = true; throw new Error('Synthetic post-save visibility ambiguity');
    }
  };
  await assert.rejects(f.recover(), /visibility ambiguity/);
  assert.equal(injected, true); assert.equal(f.state.events.includes('ack'), false); assert.equal(f.state.released, 0);
  assert.equal((await new Fz3bBackend(f.options).status(f.input.run.runId))?.hardwareBusy, true);
  await assert.rejects(new Fz3bPreflightRecoveryWorker({ root: f.workerRoot, resourceRoot, children: () => 0, released: () => {} }).assertNoRecoveryBarrier());
  assert.equal(f.state.dispatch, 0);
});

test('barrier unlink visible then failed sync and unavailable restoration cannot mint a closure certificate or clear on restart', async () => {
  const f = await recoveryFixture(); let unlinked = false, restoreAttempts = 0;
  const seams = f.worker as unknown as { removeBarrier(file: string): Promise<void>; persist(file: string, value: unknown): Promise<void> };
  const persist = seams.persist.bind(f.worker);
  seams.persist = async (file, value) => {
    if (unlinked && path.basename(file) === 'preflight-refusal-recovery.lock') {
      restoreAttempts++; throw new Error('Synthetic restoration unavailable');
    }
    return persist(file, value);
  };
  seams.removeBarrier = async file => {
    const original = JSON.parse(await readFile(file, 'utf8')); await unlink(file); unlinked = true;
    await assert.rejects(seams.persist(file, original), /restoration unavailable/);
    throw new Error('Synthetic post-unlink sync failure; no successful worker return');
  };
  await assert.rejects(f.recover(), /post-unlink sync failure/);
  assert.equal(unlinked, true); assert.equal(f.state.events.includes('certify'), false); assert.equal(f.state.released, 0);
  const directory = await attemptDirectory(f);
  assert.equal((await readdir(directory)).includes('closure.json'), false);
  assert.equal(restoreAttempts, 1, 'The synthetic storage layer could not restore the barrier');
  const restarted = freshReader(f);
  assert.equal((await restarted.backend.status(f.input.run.runId))?.hardwareBusy, true);
  await assert.rejects(restarted.worker.assertNoRecoveryBarrier());
  assert.equal(f.state.dispatch, 0);
});

for (const mode of ['missing', 'forged', 'foreign'] as const) {
  test(`${mode} post-worker-success closure certificate cannot authenticate ACK plus bare absence`, async () => {
    const f = await recoveryFixture(); await f.recover();
    const closurePath = path.join(await attemptDirectory(f), 'closure.json');
    if (mode === 'missing') await unlink(closurePath);
    else {
      const value = JSON.parse(await readFile(closurePath, 'utf8'));
      if (mode === 'forged') value.mac = (value.mac[0] === 'a' ? 'b' : 'a') + value.mac.slice(1);
      else value.id = 'foreign-offline-attempt';
      await writeFile(closurePath, JSON.stringify(value, null, 2));
    }
    const restarted = freshReader(f);
    assert.equal((await restarted.backend.status(f.input.run.runId))?.hardwareBusy, true);
    await assert.rejects(restarted.worker.assertNoRecoveryBarrier());
    assert.equal(f.state.dispatch, 0); assert.equal(f.state.released, 1);
  });
}

for (const mode of ['read-completion', 'owner-after-read'] as const) {
  test(`read-only finish ${mode} failure never rewrites its signed checkpoint and can retry the same certificate`, async () => {
    const f = await recoveryFixture(); await f.recover(); const before = await readFile(f.ledger);
    const readCompletion = f.options.adapter.readPreflightRefusalRecoveryCompletion!, owner = f.options.assertRecoveryOwner!;
    let ownerChecks = 0;
    if (mode === 'read-completion') f.options.adapter.readPreflightRefusalRecoveryCompletion = async () => { throw new Error('Synthetic read-only completion unavailable'); };
    else f.options.assertRecoveryOwner = async binding => {
      await owner(binding); if (++ownerChecks === 2) throw new Error('Synthetic owner wait failed after read');
    };
    await assert.rejects(f.recover(), /Synthetic/);
    assert.deepEqual(await readFile(f.ledger), before, 'A read-only failure cannot append error/updateAt to the already signed checkpoint');
    assert.equal((await f.backend.status(f.input.run.runId))?.hardwareBusy, true);
    f.options.adapter.readPreflightRefusalRecoveryCompletion = readCompletion; f.options.assertRecoveryOwner = owner;
    assert.equal((await f.recover()).hardwareBusy, false);
    assert.deepEqual(await readFile(f.ledger), before);
    assert.deepEqual(f.state.events.filter(event => event !== 'read-completion'), ['native', 'prepare', 'finalize', 'ack', 'certify']);
    assert.equal(f.state.dispatch, 0);
  });
}

for (const mode of ['absent', 'foreign'] as const) {
  test(`${mode} original lease is never treated as successful local finalization`, async () => {
    const f = await recoveryFixture();
    if (mode === 'absent') await unlink(f.lease);
    else await writeFile(f.lease, JSON.stringify({ schemaVersion: 1, operationId: 'foreign-operation' }));
    const bytes = mode === 'foreign' ? await readFile(f.lease) : undefined;
    await assert.rejects(f.recover());
    if (bytes) assert.deepEqual(await readFile(f.lease), bytes);
    assert.equal(f.state.events.includes('finalize'), false); assert.equal(f.state.released, 0);
    assert.equal((await freshReader(f).backend.status(f.input.run.runId))?.hardwareBusy, true);
    assert.equal(f.state.dispatch, 0);
  });
}

for (const name of ['prepared.json', 'finalization.json', 'acknowledgment.json'] as const) {
  test(`visible partial ${name} write remains blocked after process replacement`, async () => {
    const f = await recoveryFixture();
    const seams = f.worker as unknown as { persist(file: string, value: unknown): Promise<void> };
    const persist = seams.persist.bind(f.worker); let injected = false;
    seams.persist = async (file, value) => {
      await persist(file, value);
      if (path.basename(file) === name) { injected = true; throw new Error(`Synthetic visible ${name} save failure`); }
    };
    await assert.rejects(f.recover(), /save failure/); assert.equal(injected, true);
    const restarted = freshReader(f);
    assert.equal((await restarted.backend.status(f.input.run.runId))?.hardwareBusy, true);
    await assert.rejects(restarted.worker.assertNoRecoveryBarrier());
    assert.equal(f.state.events.includes('certify'), false); assert.equal(f.state.released, 0); assert.equal(f.state.dispatch, 0);
  });
}

test('real fixture ledger save failure before prepared state cannot reach lease finalization', async () => {
  const f = await recoveryFixture(), prepare = f.options.adapter.preparePreflightRefusalRecovery!;
  f.options.adapter.preparePreflightRefusalRecovery = async context => {
    const proof = await prepare(context);
    assert.ok(!path.relative(fixtureRoot, f.ledger).startsWith('..'));
    await rename(f.ledger, `${f.ledger}.retained`); await mkdir(f.ledger);
    return proof;
  };
  await assert.rejects(f.recover());
  assert.equal(f.state.events.includes('finalize'), false); assert.equal(f.state.released, 0);
  assert.equal((await f.backend.status(f.input.run.runId))?.hardwareBusy, true); assert.equal(f.state.dispatch, 0);
});

test('every ordinary production pipeline refuses a remaining local recovery barrier before key or transport', async () => {
  const f = await recoveryFixture();
  f.options.adapter.finalizePreflightRefusalRecovery = async () => { f.state.events.push('finalize'); throw new Error('Synthetic unfinished finalization'); };
  await assert.rejects(f.recover());
  const adapter = new ProductionFz3bAdapter({ resourceRoot, dataDir: f.home }); let forbidden = 0;
  const seams = adapter as unknown as { projectKey(): Promise<string>; transport(...args: unknown[]): Promise<never> };
  seams.projectKey = async () => { forbidden++; throw new Error('Key must not be opened'); };
  seams.transport = async () => { forbidden++; throw new Error('Transport must not be opened'); };
  const context = { ...nativePreview().original, runId: 'offline-next-run', operationId: 'offline-next-operation', fixture };
  for (const run of [() => adapter.build(context), () => adapter.inspect(context), () => adapter.semantic(context),
    () => adapter.prepareInspectReconciliation({} as never), () => adapter.finalizeInspectReconciliation({} as never, {} as never)]) {
    await assert.rejects(run, /FZ3B_PREFLIGHT_WORKER_PATH_ALREADY_PRESENT/);
  }
  assert.equal(forbidden, 0); assert.equal(f.state.dispatch, 0); assert.equal(f.state.released, 0);
});

function mainFixture(backend: Fz3bBackend, backendOptions: Fz3bBackendOptions, session: Session, save: () => void) {
  const state = { holds: new Set<string>(), releases: 0, engineCreates: 0 };
  const options: Fz3bAgentMainOptions = { backend,
    createEngine: () => { state.engineCreates++; throw new Error('Offline recovery must never create an engine'); },
    getSession: taskId => { assert.equal(taskId, session.taskId); return session; },
    assertCanStart: () => { throw new Error('Offline recovery cannot start'); }, assertBeforeClaim: () => { throw new Error('Offline recovery cannot claim a model'); },
    enterControlledMode: async () => {}, assertGlobalOwner: () => { throw new Error('No model owner exists'); },
    assertGlobalRecoveryOwner: binding => { assert.equal(binding.sessionId, session.id); },
    checkRuntime: async () => {}, readAccount: async () => { throw new Error('Offline recovery cannot read an account'); }, setAccount: () => {},
    hold: id => { state.holds.add(id); }, release: id => { state.releases++; state.holds.delete(id); },
    save, publish: () => {}, log: () => {}, redact: value => value, onEvent: () => {},
  };
  const main = new Fz3bAgentMain(options);
  backendOptions.assertRecoveryOwner = binding => main.assertRecoveryOwner(binding);
  return { main, options, state };
}

for (const mode of ['before-write', 'visible-before-throw'] as const) {
  test(`main session save ${mode} holds both original and restarted managers until explicit same-certificate host finish`, async () => {
    const f = await recoveryFixture(), original = f.input.run;
    const session: Session = { id: original.sessionId, taskId: original.taskId, projectId: 'offline-project', title: 'Offline local recovery',
      status: 'needs_attention', messages: [], threadId: original.threadId, turnId: original.turnId,
      model: original.model, engineProfile: 'fz3b', engineUncertain: true };
    let durableSession = structuredClone(session);
    const first = mainFixture(f.backend, f.options, session, () => {
      if (mode === 'visible-before-throw') durableSession = structuredClone(session);
      throw new Error(`Synthetic session save ${mode}`);
    });
    await first.main.recoverStartup();
    await assert.rejects(first.main.reconcilePreflightRefusedInspect(original.runId), /Synthetic session save/);
    assert.equal(first.main.held, true); assert.equal(first.state.releases, 0);
    assert.equal((await f.backend.status(original.runId))?.hardwareBusy, false, 'Worker proof is complete; unfinished host save is a separate hold');
    assert.equal((await first.main.snapshot()).recoveryActions?.finishPreflightRefusal, true);
    assert.equal(first.state.engineCreates, 0);
    const savedRecord = await readFile(f.ledger), originalActions = [...f.state.events];
    assert.deepEqual(originalActions, ['native', 'prepare', 'finalize', 'ack', 'certify']);
    const reader = freshReader(f), restartedSession = structuredClone(durableSession);
    const restarted = mainFixture(reader.backend, reader.options, restartedSession, () => { durableSession = structuredClone(restartedSession); });
    await restarted.main.recoverStartup();
    assert.equal((await reader.backend.status(original.runId))?.hardwareBusy, false, 'Restart must independently authenticate the complete worker closure');
    assert.equal(restarted.main.held, true); assert.equal(restarted.state.holds.has(original.taskId), true);
    assert.equal((await restarted.main.snapshot()).recoveryActions?.finishPreflightRefusal, true);
    await assert.rejects(restarted.main.assertIdle(), /HELD/);
    await assert.rejects(restarted.main.stop(original.runId), /HOST_FINISH_REQUIRED/);
    await assert.rejects(restarted.main.recover(original.taskId), /HOST_FINISH_REQUIRED/);
    await assert.rejects(restarted.main.reconcileInspect(original.runId), /HOST_FINISH_REQUIRED/);
    await assert.rejects(restarted.main.prepareMaintenanceExit(original.runId), /HOST_FINISH_REQUIRED/);
    await (restarted.main as unknown as { finish(runId: string): Promise<void> }).finish(original.runId);
    assert.equal(restarted.main.held, true); assert.equal(restarted.state.releases, 0);
    const view = await restarted.main.reconcilePreflightRefusedInspect(original.runId);
    assert.equal(restarted.main.held, false); assert.equal(restarted.state.releases, 1); assert.equal(restarted.state.engineCreates, 0);
    assert.deepEqual(view.operations, original.operations); assert.deepEqual(view.calls, original.calls);
    assert.equal(durableSession.engineUncertain, false); assert.equal(durableSession.turnId, undefined);
    assert.deepEqual(await readFile(f.ledger), savedRecord); assert.deepEqual(f.state.events, originalActions); assert.equal(f.state.dispatch, 0);
    const nextReader = freshReader(f);
    const next = mainFixture(nextReader.backend, nextReader.options, structuredClone(durableSession), () => {});
    await next.main.recoverStartup();
    assert.equal(next.main.held, true, 'Every restart conservatively requires explicit host finish; a visible session flag is not an ACK');
    assert.equal(next.state.releases, 0); assert.equal(next.state.engineCreates, 0);
  });
}

test('an older completed local recovery cannot release another owner or semantic unknown on startup', async () => {
  for (const mode of ['active', 'inspect-unknown', 'semantic-unknown'] as const) {
    const f = await recoveryFixture(); await f.recover();
    const foreign = privateRecord(f.input);
    foreign.runId = 'zz-offline-foreign-run'; foreign.taskId = 'offline-foreign-task'; foreign.sessionId = 'offline-foreign-session';
    foreign.active = mode === 'active'; foreign.hardwareBusy = true;
    foreign.operations[1].id = 'offline-foreign-operation'; foreign.operations[1].kind = mode === 'inspect-unknown' ? 'inspect' : 'semantic';
    foreign.calls[2].tool = mode === 'inspect-unknown' ? 'fz3b_inspect' : 'fz3b_semantic';
    foreign.calls[2].result!.operation = structuredClone(foreign.operations[1]);
    f.internal.records.set(foreign.runId, foreign); await f.internal.save(foreign);
    const source = f.input.run, reader = freshReader(f);
    const session: Session = { id: source.sessionId, taskId: source.taskId, projectId: 'offline-project', title: 'Offline local finish', status: 'needs_attention',
      messages: [], threadId: source.threadId, model: source.model, engineProfile: 'fz3b', engineUncertain: false };
    const main = mainFixture(reader.backend, reader.options, session, () => { throw new Error('Another owner must block before session save'); });
    await main.main.recoverStartup();
    assert.equal(main.main.held, true); assert.equal(main.state.holds.has(source.taskId), true); assert.equal(main.state.holds.has(foreign.taskId), true);
    await assert.rejects(main.main.reconcilePreflightRefusedInspect(source.runId), /MULTIPLE_OWNERS|OWNER_MISMATCH/);
    assert.equal(main.main.held, true); assert.equal(main.state.releases, 0); assert.equal(main.state.engineCreates, 0);
    assert.equal((await reader.backend.status(foreign.runId))?.hardwareBusy, true);
    assert.equal((await reader.backend.status(foreign.runId))?.operations[1].status, 'unknown');
    assert.equal((await reader.backend.status(foreign.runId))?.operations[1].remoteQuiescent, false);
    assert.equal((await main.main.snapshot()).recoveryActions, undefined);
    assert.equal(f.state.dispatch, 0);
  }
});
