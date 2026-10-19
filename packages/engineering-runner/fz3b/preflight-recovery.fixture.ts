/** Offline synthetic ledger/adapter fixture. No application, key, SSH or device access. */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Fz3bBackend, type Fz3bBackendOptions } from './backend.js';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { fixedFz3bPayload } from './payload.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS as pins, verifyFz3bPreflightRefusal, type Fz3bPreflightRefusalInput } from './preflight-refusal-proof.js';
import { FZ3B_PREFLIGHT_RECOVERY_CASE as approved, fz3bPreflightDigest, fz3bPreflightAnchor } from './preflight-recovery.js';
import type { Fz3bBuildReceipt, Fz3bRunView, Fz3bSemanticFixture, Fz3bLocalProcessState, Fz3bPreflightRefusalRecoveryProof,
  Fz3bPreflightRefusalRecoveryFinalization, Fz3bPreflightRefusalRecoveryAck, Fz3bPreflightRefusalRecoveryAcknowledgment,
  Fz3bPreflightRefusalRecoveryClosure } from './types.js';

export function preflightRecoveryFixture() {
  const resource = (name: string) => readFileSync(new URL(`../../../engineering/fz3b/product/resources/${name}`, import.meta.url));
  const resources = { manifest: resource('manifest.json'), remote: resource('remote/remote.py'), wire: resource('remote/wire.py'), fixture: resource('fixture/host-fixture.json') };
  const fixture = JSON.parse(resources.fixture.toString()) as Fz3bSemanticFixture;
  const failure = 'Error: FZ3B receipt is not terminal and quiescent';
  const owner = { runId: approved.runId, sessionId: '9309dc73-fb48-4d29-9226-c5496ca2640d', taskId: '9309dc73-fb48-4d29-9226-c5496ca2640d',
    model: FZ3B_PROFILE.model, generation: 1792223279715745, threadId: '01a148d5-03a5-7911-ab77-08888c07e2a2', turnId: '01a148d5-0884-7d03-9e9d-de97bd68a3b8' };
  const build = { id: 'f5ac2cc5-2dbe-49f1-8145-34873c48c368', requestKey: 'fz3b-7ff9e036050785693c3e10ca3ee8f1c7af3fe66e017014979463909c39936f09',
    nonce: '538b861dce966cb516d2e50ce63fb9e453b69d2740a4b99cea802956ce8aa765', kind: 'build' as const, status: 'succeeded' as const,
    dispatchPhase: 'may-have-started' as const, createdAt: '2026-10-17T07:48:08.268Z', updatedAt: '2026-10-17T07:48:08.385Z',
    processExited: true, remoteQuiescent: true, evidenceSha256: 'e95ce95945e6aa1fd0eadc2e2232a54fa961c6f35a8d590f5dead924a70a92f0' };
  const inspect = { id: approved.operationId, nonce: approved.nonce, requestKey: 'fz3b-ef051ca6640a7af7815e4383af2d972b448021d603e0712a6157d18d5bb96de7',
    kind: 'inspect' as const, status: 'unknown' as const, dispatchPhase: 'may-have-started' as const, createdAt: '2026-10-17T07:48:10.779Z',
    updatedAt: '2026-10-17T07:48:12.466Z', processExited: true, remoteQuiescent: false, evidenceSha256: approved.evidenceSha256, detail: failure };
  const body = { kind: 'fixed-ps-fixture-package' as const, buildId: build.id, profileSha256: pins.profile, sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
    fixtureManifestSha256: fixture.manifestSha256, queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256, buildEvidenceSha256: build.evidenceSha256,
    packageSha256: 'ec1d60ae621e74d341fd393c9e5cc846b0e7b2075f4b4bfcd47cbcbaaa6a6f94', packageManifestSha256: 'cb177831310e29ef6f60117a093a4292fdd5e7887e72696bc1da379f86c1deb8',
    newPlBuilt: false as const, deployed: false as const };
  const artifact = { id: fz3bDigest(JSON.stringify(body)), ...body };
  const run: Fz3bRunView = { ...owner, schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: pins.profile, status: 'needs_attention', phase: 'needs_attention',
    active: false, hardwareBusy: true, stopRequested: true, nativeApproval: 'not_requested', createdAt: '2026-10-17T07:48:03.313Z', updatedAt: '2026-10-17T07:48:12.473Z',
    currentTool: 'fz3b_inspect', failure, operations: [build, inspect], artifact, calls: [
      { callId: 'call_status', tool: 'fz3b_status', status: 'succeeded', receivedAt: '2026-10-17T07:48:06.024Z', completedAt: '2026-10-17T07:48:06.024Z',
        result: { runId: owner.runId, callId: 'call_status', tool: 'fz3b_status', ok: true, result: 'status', phase: 'ready' } },
      { callId: 'call_build', tool: 'fz3b_build', status: 'succeeded', operationId: build.id, receivedAt: '2026-10-17T07:48:07.206Z', completedAt: build.updatedAt,
        result: { runId: owner.runId, callId: 'call_build', tool: 'fz3b_build', ok: true, result: 'succeeded', phase: 'ready', operation: structuredClone(build), artifact: structuredClone(artifact) } },
      { callId: 'call_inspect', tool: 'fz3b_inspect', status: 'unknown', operationId: inspect.id, receivedAt: '2026-10-17T07:48:09.739Z', completedAt: inspect.updatedAt, error: failure,
        result: { runId: owner.runId, callId: 'call_inspect', tool: 'fz3b_inspect', ok: false, result: 'unknown', phase: 'needs_attention', operation: structuredClone(inspect), message: failure } },
    ] };
  const close = { schemaVersion: 1, observedClose: true, exitCode: 0, at: '2026-10-17T07:48:12.457Z', outputSha256: '65898b69d81d3cc1ca903fb7e91606156e4a1f30fe3f95cde00e29752b7f1002' };
  const request = { schemaVersion: 1, action: 'inspect', operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile };
  const context = { schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile, action: 'inspect' };
  const payload = fixedFz3bPayload({ manifestSha256: pins.manifest, fixture, files: new Map([['remote/remote.py', resources.remote], ['remote/wire.py', resources.wire]]) }, request);
  const remote = { schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile, status: 'failed', remoteOutcomeUnknown: false, remoteQuiescent: false, detail: 'ValueError:boot-changed' };
  const remoteStdout = fz3bCanonicalJson(remote) + '\n';
  const transport = { processExited: true, exitCode: 0, timedOut: false, spawned: true, stdoutBytes: Buffer.byteLength(remoteStdout), stdoutSha256: close.outputSha256, stderr: '' };
  const encode = (value: unknown, newline = false) => Buffer.from(JSON.stringify(value, null, 2) + (newline ? '\n' : ''));
  const input: Fz3bPreflightRefusalInput = { run: structuredClone(run), anchor: fz3bPreflightAnchor(run), resources, files: {
    evidence: encode({ ...context, transport, remoteStdout, remote: JSON.parse(remoteStdout), resourceManifestSha256: pins.manifest, authenticatedTransport: 'pinned-ssh', helloAuthenticated: false }, true),
    intent: encode({ ...context, resourceManifestSha256: pins.manifest, payloadSha256: fz3bDigest(payload), dispatchPhase: 'may-have-started' }),
    transport: encode({ ...context, resourceManifestSha256: pins.manifest, observedAt: close.at, transport }), actualClose: encode(close),
  } };
  const receipt: Fz3bBuildReceipt = { schemaVersion: 1, operationId: build.id, nonce: build.nonce, profileSha256: pins.profile, kind: 'build', status: 'succeeded',
    processExited: true, remoteQuiescent: true, remoteOutcomeUnknown: false, evidenceSha256: build.evidenceSha256, sourceManifestSha256: body.sourceManifestSha256,
    fixtureManifestSha256: body.fixtureManifestSha256, queriesSha256: body.queriesSha256, imageSha256: body.imageSha256,
    newPlBuilt: false, deployed: false, packageSha256: body.packageSha256, packageManifestSha256: body.packageManifestSha256 };
  const processState: Fz3bLocalProcessState = { closed: true, liveChildren: 0, operations: [{ operationId: inspect.id, nonce: inspect.nonce, closeConfirmed: true, evidenceSha256: approved.actualCloseSha256 }] };
  const maintenanceProcessState = structuredClone(processState);
  maintenanceProcessState.operations[0].evidenceSha256 = approved.maintenanceLocalCloseProofSha256;
  const localCloseProof = Buffer.from(JSON.stringify({ schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, taskId: owner.taskId,
    runId: owner.runId, sessionId: owner.sessionId, profileSha256: pins.profile, originalEvidenceSha256: approved.evidenceSha256,
    originalIntentSha256: approved.intentSha256, originalCloseSha256: approved.actualCloseSha256, closeConfirmed: true, historicalPidAttested: false,
    claim: 'Bound existing observed-close evidence plus current adapter child census only' }, null, 2));
  const maintenanceBody = { schemaVersion: 1 as const, runId: owner.runId, sessionId: owner.sessionId, taskId: owner.taskId, profileSha256: pins.profile,
    createdAt: '2026-10-17T08:41:07.008Z', unknownPreserved: true as const, localProcessesClosed: true as const, operationSnapshotSha256: fz3bPreflightDigest(run.operations), processState: maintenanceProcessState };
  run.maintenanceExit = { ...maintenanceBody, sealSha256: fz3bPreflightDigest(maintenanceBody) }; run.updatedAt = maintenanceBody.createdAt;
  const record = { ...structuredClone(run), step: 1, results: { fz3b_build: structuredClone(run.calls[1].result!) }, receipts: { [build.id]: receipt } };
  return { run, record, input, fixture, processState, maintenanceProcessState, localCloseProof };
}

export async function backendPreflightFixture() {
  const source = preflightRecoveryFixture(), calls: string[] = [];
  let now = Date.parse('2026-10-17T10:00:00.000Z');
  const base = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/backend-fixtures');
  await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'case-'));
  const state: { barrier: boolean; lease: boolean; ack?: Fz3bPreflightRefusalRecoveryAck; acknowledgment?: Fz3bPreflightRefusalRecoveryAcknowledgment;
    closure?: Fz3bPreflightRefusalRecoveryClosure } = { barrier: false, lease: true };
  const options: Fz3bBackendOptions = { dataDir: directory, fixture: source.fixture, now: () => now,
    assertOwner() { throw new Error('Offline fixture cannot plan a model turn'); }, assertRecoveryOwner() { calls.push('owner'); },
    async checkRuntime() { calls.push('runtime'); }, async requestSemantic() { throw new Error('No semantic grant in offline recovery fixture'); },
    async requestPreflightRefusalRecovery() { calls.push('native'); return true; }, adapter: {
      async build() { throw new Error('No build in offline recovery fixture'); }, async inspect() { throw new Error('No SSH in offline recovery fixture'); },
      async semantic() { throw new Error('No device in offline recovery fixture'); }, async readPublicEvidence() { throw new Error('No public export in fixture'); },
      async preparePreflightRefusalRecovery(context) {
        calls.push('prepare'); state.barrier = true;
        const proof: Fz3bPreflightRefusalRecoveryProof = { schemaVersion: 1, reason: context.reason, id: context.id, nonce: context.nonce,
          contextSha256: fz3bPreflightDigest(context), observedAt: new Date(now).toISOString(),
          classification: verifyFz3bPreflightRefusal({ ...source.input, run: context.projection, anchor: context.anchor }),
          originalLeaseSha256: '2e759a5efd3e85b8cc07f3cd5a3836dc68a18dccc3af4ffa54590496f9574409',
          processState: structuredClone(source.processState), evidenceSha256: 'a'.repeat(64) };
        return proof;
      },
      async readPreflightRefusalRecoveryInput() { calls.push('read-input'); return { resources: source.input.resources, files: source.input.files }; },
      async finalizePreflightRefusalRecovery(context, proof) {
        calls.push('finalize'); if (!state.barrier || !state.lease) throw new Error('No exact original fixture lease'); state.lease = false;
        const value: Fz3bPreflightRefusalRecoveryFinalization = { schemaVersion: 1, id: context.id, contextSha256: fz3bPreflightDigest(context),
          proofSha256: fz3bPreflightDigest(proof), originalLeaseSha256: proof.originalLeaseSha256, leaseUnlinked: true, barrierRetained: true,
          localProcessesClosed: true, finalizedAt: new Date(now).toISOString(), evidenceSha256: 'b'.repeat(64) }; return value;
      },
      async acknowledgePreflightRefusalRecovery(context, proof, finalization, ack, verifyAck) {
        calls.push('ack'); verifyAck(ack); if (state.lease || !state.barrier) throw new Error('Wrong fixture barrier');
        state.ack = structuredClone(ack); state.barrier = false;
        const value: Fz3bPreflightRefusalRecoveryAcknowledgment = { schemaVersion: 1, id: context.id, contextSha256: fz3bPreflightDigest(context),
          proofSha256: fz3bPreflightDigest(proof), finalizationSha256: fz3bPreflightDigest(finalization), ackSha256: fz3bPreflightDigest(ack),
          originalLeaseSha256: proof.originalLeaseSha256, localBarrierRemoved: true, localProcessesClosed: true, evidenceSha256: 'c'.repeat(64) };
        state.acknowledgment = value; return value;
      },
      async certifyPreflightRefusalRecovery(_context, _proof, _finalization, ack, acknowledgment, closure, verifyClosure) {
        calls.push('certify'); verifyClosure(ack, acknowledgment, closure);
        if (state.barrier || state.lease || !state.acknowledgment) throw new Error('Worker did not actually finish fixture acknowledgment');
        state.closure = structuredClone(closure);
      },
      async readPreflightRefusalRecoveryCompletion(_context, _proof, _finalization, verifyAck, verifyClosure) {
        calls.push('read-completion');
        if (state.barrier || state.lease || !state.ack || !state.acknowledgment || !state.closure) throw new Error('Fixture completion absent or incomplete');
        verifyAck(state.ack); verifyClosure(state.ack, state.acknowledgment, state.closure);
        return structuredClone({ ack: state.ack, acknowledgment: state.acknowledgment, closure: state.closure });
      },
    } };
  const backend = new Fz3bBackend(options); await backend.list();
  // Test-only synthetic original ledger: use real backend signing, never read its key.
  const internal = backend as unknown as { records: Map<string, any>; save(record: unknown): Promise<void> };
  internal.records.set(source.run.runId, structuredClone(source.record)); await internal.save(internal.records.get(source.run.runId));
  const cleanup = async () => {
    const relative = path.relative(base, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe isolated fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  };
  return { ...source, directory, options, backend, internal, calls, state, cleanup, advance: (ms: number) => { now += ms; } };
}
