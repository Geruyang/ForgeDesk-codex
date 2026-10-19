import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest, fz3bProfileSha256 } from './profile.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS, type Fz3bPreflightRefusalAnchor } from './preflight-refusal-proof.js';
import { fz3bOriginalInspectionContext, fz3bReconciliationOwnerBinding } from './reconciliation.js';
import type { Fz3bOperation, Fz3bRunView, Fz3bSemanticFixture, Fz3bMaintenanceLocalCloseProof, Fz3bPreflightRefusalRecoveryContext,
  Fz3bPreflightRefusalRecoveryProof, Fz3bPreflightRefusalRecoveryFinalization,
  Fz3bPreflightRefusalRecoveryAck, Fz3bPreflightRefusalRecoveryAcknowledgment, Fz3bPreflightRefusalRecoveryClosure,
  Fz3bPreflightRefusalRecovery } from './types.js';

export const FZ3B_PREFLIGHT_RECOVERY_CASE = Object.freeze({
  runId: '07427a29-0eae-44c7-ac35-34d6650eebee', operationId: 'c6a3e027-abd8-40f7-b64e-d1b8e1a4620b',
  nonce: '4d67dddacca4e468e6870c9df3c75601e11b6c9cbf10ec477b4181d5a0ac3d49',
  evidenceSha256: '85e658c19cebd39040ed2352948aaadb1b5612443a0b879456bb6744079d2a72',
  intentSha256: '0f88e4eeeebf5ac13db8827ee2978631c4a1025211082f64847e31d1b544d2fd',
  transportSha256: '49e4cb0f9e3901319cd6e4576a4f477864880e1ed884908ed412dcb168f594fe',
  actualCloseSha256: '1acea923364eae8d5c2bfa48e6dd58c1ee3fdb527930b23f71061f09cba9d6ef',
  maintenanceLocalCloseProofSha256: '6f7ade3ffaeae1bd661ab39c5703e795074556790c5d903b45cf0789f4d61be3',
});
export const FZ3B_PREFLIGHT_ACK_DOMAIN = 'ForgeDesk/FZ3B/PreflightRefusalPostSaveAck/v1\0';
export const FZ3B_PREFLIGHT_CLOSURE_DOMAIN = 'ForgeDesk/FZ3B/PreflightRefusalWorkerClosed/v1\0';
const failure = 'Error: FZ3B receipt is not terminal and quiescent';
const restarted = 'Application restarted; planning stopped and no action was replayed';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const fz3bPreflightDigest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));
const same = (a: unknown, b: unknown) => fz3bCanonicalJson(a) === fz3bCanonicalJson(b);
const hash = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`FZ3B_PREFLIGHT_RECOVERY_${code}`); }
function object(value: unknown): asserts value is Record<string, any> {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'OBJECT');
}
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
  object(value); const names = Reflect.ownKeys(value);
  check(names.every(k => typeof k === 'string' && [...required, ...optional].includes(k)) && required.every(k => names.includes(k)), 'CLOSED_SCHEMA');
}
function at(value: unknown): number {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'TIME'); return Date.parse(value);
}
const runKeys = ['schemaVersion', 'runId', 'sessionId', 'taskId', 'model', 'generation', 'threadId', 'turnId', 'profileId', 'profileSha256',
  'status', 'phase', 'active', 'hardwareBusy', 'stopRequested', 'nativeApproval', 'createdAt', 'updatedAt', 'calls', 'operations', 'artifact', 'failure'];

/** Explicit normalization of an authenticated current run, not a pick-allowed-keys filter. */
export function fz3bPreflightSourceProjection(source: unknown, fixture: Fz3bSemanticFixture): { sourceRun: Fz3bRunView; projection: Fz3bRunView; maintenanceExitSha256: string | null } {
  shape(source, runKeys, ['instruction', 'currentTool', 'maintenanceExit']);
  const run = source as Fz3bRunView, approved = FZ3B_PREFLIGHT_RECOVERY_CASE;
  check(run.schemaVersion === 1 && run.runId === approved.runId && run.model === FZ3B_PROFILE.model && run.profileId === FZ3B_PROFILE.id &&
    run.profileSha256 === fz3bProfileSha256(fixture) && run.profileSha256 === FZ3B_PREFLIGHT_REFUSAL_PINS.profile &&
    run.active === false && run.hardwareBusy === true && run.status === 'needs_attention' && run.phase === 'needs_attention' &&
    run.stopRequested === true && run.nativeApproval === 'not_requested' && [failure, restarted].includes(run.failure!) &&
    (run.currentTool === undefined || run.currentTool === 'fz3b_inspect'), 'SOURCE_STATE');
  check(Array.isArray(run.operations) && run.operations.length === 2 && Array.isArray(run.calls) && run.calls.length === 3, 'SOURCE_HISTORY');
  const [build, inspect] = run.operations;
  check(build.kind === 'build' && build.status === 'succeeded' && build.processExited === true && build.remoteQuiescent === true &&
    inspect.id === approved.operationId && inspect.nonce === approved.nonce && inspect.evidenceSha256 === approved.evidenceSha256 &&
    inspect.kind === 'inspect' && inspect.status === 'unknown' && inspect.dispatchPhase === 'may-have-started' && inspect.processExited === true &&
    inspect.remoteQuiescent === false && inspect.detail === failure, 'EXACT_CASE');
  check(run.calls.every((call, i) => call.tool === ['fz3b_status', 'fz3b_build', 'fz3b_inspect'][i] && call.status === (i === 2 ? 'unknown' : 'succeeded')) &&
    run.calls[2].operationId === inspect.id && run.calls[2].error === failure && run.calls[2].result?.message === failure &&
    same(run.calls[2].result?.operation, inspect), 'IMMUTABLE_CALLS');
  check(at(run.updatedAt) >= at(inspect.updatedAt) && at(inspect.updatedAt) >= at(run.createdAt), 'SOURCE_TIME');
  let maintenanceExitSha256: string | null = null;
  if (run.maintenanceExit !== undefined) {
    const seal = run.maintenanceExit;
    shape(seal, ['schemaVersion', 'runId', 'sessionId', 'taskId', 'profileSha256', 'createdAt', 'unknownPreserved', 'localProcessesClosed', 'operationSnapshotSha256', 'processState', 'sealSha256']);
    const { sealSha256, ...body } = seal;
    check(seal.schemaVersion === 1 && seal.runId === run.runId && seal.sessionId === run.sessionId && seal.taskId === run.taskId &&
      seal.profileSha256 === run.profileSha256 && seal.unknownPreserved === true && seal.localProcessesClosed === true &&
      seal.operationSnapshotSha256 === fz3bPreflightDigest(run.operations) && sealSha256 === fz3bPreflightDigest(body) &&
      at(seal.createdAt) >= at(inspect.updatedAt) && at(run.updatedAt) >= at(seal.createdAt), 'MAINTENANCE_SEAL');
    // The legacy maintenance producer hashes its aggregate local-close-proof,
    // not the raw process-exit file used by the new recovery proof.
    const legacy = maintenanceLocalCloseFacts(run);
    check(fz3bDigest(Buffer.from(JSON.stringify(legacy, null, 2))) === approved.maintenanceLocalCloseProofSha256, 'MAINTENANCE_LOCAL_CLOSE_BINDING');
    assertProcessState(seal.processState, inspect, approved.maintenanceLocalCloseProofSha256); maintenanceExitSha256 = fz3bPreflightDigest(seal);
  }
  const sourceRun = structuredClone(run), projection = structuredClone(run);
  delete projection.maintenanceExit;
  // Host restart failure text is state projection, not a rewrite of original op/call evidence.
  projection.failure = failure;
  return { sourceRun, projection, maintenanceExitSha256 };
}

/** Whole private record constraints run before extracting its public source snapshot. */
export function fz3bPreflightRecordProjection(value: unknown, fixture: Fz3bSemanticFixture) {
  shape(value, [...runKeys, 'step', 'results', 'receipts'], ['instruction', 'currentTool', 'maintenanceExit']);
  check(value.step === 1, 'PRIVATE_STEP');
  const { step: _step, results, receipts, ...view } = value;
  const result = fz3bPreflightSourceProjection(view, fixture), build = result.sourceRun.operations[0];
  shape(results, ['fz3b_build']); check(same(results.fz3b_build, result.sourceRun.calls[1].result), 'PRIVATE_RESULTS');
  shape(receipts, [build.id]); const receipt = receipts[build.id];
  shape(receipt, ['schemaVersion', 'operationId', 'nonce', 'profileSha256', 'status', 'processExited', 'remoteQuiescent', 'remoteOutcomeUnknown',
    'evidenceSha256', 'kind', 'sourceManifestSha256', 'fixtureManifestSha256', 'queriesSha256', 'imageSha256', 'newPlBuilt', 'deployed', 'packageSha256', 'packageManifestSha256']);
  check(receipt.schemaVersion === 1 && receipt.operationId === build.id && receipt.nonce === build.nonce && receipt.kind === 'build' && receipt.status === 'succeeded' &&
    receipt.processExited === true && receipt.remoteQuiescent === true && receipt.remoteOutcomeUnknown === false && receipt.evidenceSha256 === build.evidenceSha256 &&
    receipt.profileSha256 === result.sourceRun.profileSha256 && receipt.newPlBuilt === false && receipt.deployed === false &&
    receipt.sourceManifestSha256 === FZ3B_PROFILE.deployedManifestSha256 && receipt.fixtureManifestSha256 === fixture.manifestSha256 &&
    receipt.queriesSha256 === fixture.queriesSha256 && receipt.imageSha256 === fixture.imageSha256 &&
    receipt.packageSha256 === result.sourceRun.artifact?.packageSha256 && receipt.packageManifestSha256 === result.sourceRun.artifact?.packageManifestSha256,
    'PRIVATE_BUILD_RECEIPT');
  return { ...result, sourceRecordSha256: fz3bPreflightDigest(value) };
}

function assertProcessState(value: unknown, operation: Fz3bOperation, expectedEvidenceSha256: string) {
  shape(value, ['closed', 'liveChildren', 'operations']);
  check(value.closed === true && value.liveChildren === 0 && Array.isArray(value.operations) && value.operations.length === 1, 'LOCAL_PROCESSES');
  const op = value.operations[0]; shape(op, ['operationId', 'nonce', 'closeConfirmed', 'evidenceSha256']);
  check(op.operationId === operation.id && op.nonce === operation.nonce && op.closeConfirmed === true &&
    op.evidenceSha256 === expectedEvidenceSha256, 'LOCAL_PROCESS_OWNER');
}

function maintenanceLocalCloseFacts(run: Fz3bRunView): Fz3bMaintenanceLocalCloseProof {
  const approved = FZ3B_PREFLIGHT_RECOVERY_CASE, operation = run.operations[1];
  check(run.runId === approved.runId && run.profileSha256 === FZ3B_PREFLIGHT_REFUSAL_PINS.profile && operation?.id === approved.operationId &&
    operation.nonce === approved.nonce && operation.evidenceSha256 === approved.evidenceSha256, 'MAINTENANCE_LOCAL_CLOSE_BINDING');
  // Preserve the production durableJson property order/encoding, including no trailing LF.
  return { schemaVersion: 1, operationId: operation.id, nonce: operation.nonce, taskId: run.taskId, runId: run.runId, sessionId: run.sessionId,
    profileSha256: run.profileSha256, originalEvidenceSha256: approved.evidenceSha256, originalIntentSha256: approved.intentSha256,
    originalCloseSha256: approved.actualCloseSha256, closeConfirmed: true, historicalPidAttested: false,
    claim: 'Bound existing observed-close evidence plus current adapter child census only' };
}

/** Strict legacy aggregate-file domain, never a replacement for raw actual-close evidence. */
export function assertFz3bMaintenanceLocalCloseProof(raw: Buffer, sourceRun: Fz3bRunView): Fz3bMaintenanceLocalCloseProof {
  const approved = FZ3B_PREFLIGHT_RECOVERY_CASE;
  check(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 16384 && fz3bDigest(raw) === approved.maintenanceLocalCloseProofSha256,
    'MAINTENANCE_LOCAL_CLOSE_BYTES');
  const facts = maintenanceLocalCloseFacts(sourceRun);
  check(raw.equals(Buffer.from(JSON.stringify(facts, null, 2))) && sourceRun.maintenanceExit !== undefined, 'MAINTENANCE_LOCAL_CLOSE_BINDING');
  const seal = sourceRun.maintenanceExit;
  shape(seal, ['schemaVersion', 'runId', 'sessionId', 'taskId', 'profileSha256', 'createdAt', 'unknownPreserved', 'localProcessesClosed', 'operationSnapshotSha256', 'processState', 'sealSha256']);
  const { sealSha256, ...body } = seal;
  check(seal.schemaVersion === 1 && seal.runId === sourceRun.runId && seal.sessionId === sourceRun.sessionId && seal.taskId === sourceRun.taskId &&
    seal.profileSha256 === sourceRun.profileSha256 && seal.operationSnapshotSha256 === fz3bPreflightDigest(sourceRun.operations) &&
    seal.unknownPreserved === true && seal.localProcessesClosed === true && sealSha256 === fz3bPreflightDigest(body) &&
    at(seal.createdAt) >= at(sourceRun.operations[1].updatedAt) && at(sourceRun.updatedAt) >= at(seal.createdAt), 'MAINTENANCE_SEAL');
  assertProcessState(seal.processState, sourceRun.operations[1], approved.maintenanceLocalCloseProofSha256);
  return facts;
}

export function fz3bPreflightAnchor(run: Fz3bRunView): Fz3bPreflightRefusalAnchor {
  check(typeof run.turnId === 'string' && !!run.turnId, 'TURN');
  return { owner: { ...fz3bReconciliationOwnerBinding(run), turnId: run.turnId } as Fz3bPreflightRefusalAnchor['owner'],
    operationId: FZ3B_PREFLIGHT_RECOVERY_CASE.operationId, runSha256: fz3bPreflightDigest(run), operationSha256: fz3bPreflightDigest(run.operations[1]),
    evidenceSha256: FZ3B_PREFLIGHT_RECOVERY_CASE.evidenceSha256, intentSha256: FZ3B_PREFLIGHT_RECOVERY_CASE.intentSha256,
    transportSha256: FZ3B_PREFLIGHT_RECOVERY_CASE.transportSha256, actualCloseSha256: FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256 };
}

export function assertFz3bPreflightRecoveryContext(context: Fz3bPreflightRefusalRecoveryContext, fixture: Fz3bSemanticFixture, now?: number) {
  shape(context, ['schemaVersion', 'reason', 'id', 'nonce', 'createdAt', 'expiresAt', 'original', 'ownerBindingSha256', 'originalOperationSha256',
    'originalEvidenceSha256', 'sourceRecordSha256', 'sourceProjectionSha256', 'maintenanceExitSha256', 'sourceRun', 'projection', 'anchor']);
  const projected = fz3bPreflightSourceProjection(context.sourceRun, fixture), op = projected.sourceRun.operations[1];
  check(context.schemaVersion === 1 && context.reason === 'boot-preflight-refused-before-device-v1' && UUID.test(context.id) && hash(context.nonce) &&
    hash(context.sourceRecordSha256) && context.sourceProjectionSha256 === fz3bPreflightDigest(projected.projection) &&
    context.maintenanceExitSha256 === projected.maintenanceExitSha256 && same(context.projection, projected.projection) &&
    same(context.anchor, fz3bPreflightAnchor(projected.projection)) &&
    context.ownerBindingSha256 === fz3bPreflightDigest(fz3bReconciliationOwnerBinding(projected.sourceRun)) &&
    context.originalOperationSha256 === fz3bPreflightDigest(op) && context.originalEvidenceSha256 === FZ3B_PREFLIGHT_RECOVERY_CASE.evidenceSha256 &&
    same(context.original, fz3bOriginalInspectionContext(projected.sourceRun, op, fixture)), 'CONTEXT_BINDING');
  const created = at(context.createdAt), expires = at(context.expiresAt);
  check(expires - created === 300000 && created >= at(context.sourceRun.updatedAt) && (now === undefined || created <= now && now < expires), 'CONTEXT_EXPIRY');
}

export function assertFz3bPreflightRecoveryProof(context: Fz3bPreflightRefusalRecoveryContext, proof: Fz3bPreflightRefusalRecoveryProof, now?: number) {
  shape(proof, ['schemaVersion', 'reason', 'id', 'nonce', 'contextSha256', 'observedAt', 'classification', 'originalLeaseSha256', 'processState', 'evidenceSha256']);
  const c = proof.classification, { proofSha256, ...body } = c;
  shape(c, ['schemaVersion', 'proofScope', 'classification', 'owner', 'ownerSha256', 'runSha256', 'operationId', 'operationSha256',
    'originalOperationStatus', 'originalUnknownPreserved', 'originalHardwareBusy', 'pins', 'files', 'requestSha256', 'payloadSha256',
    'stdoutSha256', 'stdoutBytes', 'originalCloseObservedAt', 'transportObservedAt', 'closeEvidenceFormat', 'inspectDeviceBranch',
    'remoteQuiescence', 'newBootIdentity', 'leaseDisposition', 'releaseAuthority', 'integration', 'limitations', 'proofSha256']);
  check(proof.schemaVersion === 1 && proof.reason === context.reason && proof.id === context.id && proof.nonce === context.nonce &&
    proof.contextSha256 === fz3bPreflightDigest(context) && hash(proof.originalLeaseSha256) && hash(proof.evidenceSha256) &&
    c.schemaVersion === 1 && c.proofScope === 'exact-preflight-branch-only' && c.classification === 'inspect-preflight-refusal-observed' &&
    c.operationId === context.original.operationId && c.ownerSha256 === fz3bPreflightDigest(context.anchor.owner) &&
    c.originalOperationStatus === 'unknown' && c.originalUnknownPreserved === true && c.originalHardwareBusy === true &&
    c.inspectDeviceBranch === 'not-entered-by-this-bound-request' && c.remoteQuiescence === 'not-established' &&
    c.newBootIdentity === 'not-observed-or-adopted' && c.leaseDisposition === 'unchanged-not-authorized' &&
    c.closeEvidenceFormat === 'v1-observed-close-without-pid-or-process-args' &&
    c.payloadSha256 === '09f9c9ff2e43d9fdfee736ea54f7f3f4cf29d7558c9d6f2d96e2270c1d62faaa' &&
    c.stdoutSha256 === '65898b69d81d3cc1ca903fb7e91606156e4a1f30fe3f95cde00e29752b7f1002' && c.stdoutBytes === 337 &&
    hash(c.requestSha256) && at(c.originalCloseObservedAt) <= at(c.transportObservedAt) &&
    Array.isArray(c.limitations) && c.limitations.length === 5 && c.limitations.every(value => typeof value === 'string' && value.length < 2000) &&
    c.releaseAuthority === 'none' && c.integration === 'pure-unintegrated' &&
    proofSha256 === fz3bPreflightDigest(body) && c.runSha256 === context.sourceProjectionSha256 && c.operationSha256 === context.originalOperationSha256 &&
    same(c.owner, context.anchor.owner) && same(c.files, { evidenceSha256: context.anchor.evidenceSha256, intentSha256: context.anchor.intentSha256,
      transportSha256: context.anchor.transportSha256, actualCloseSha256: context.anchor.actualCloseSha256 }) && same(c.pins, FZ3B_PREFLIGHT_REFUSAL_PINS), 'PROOF_BINDING');
  assertProcessState(proof.processState, context.sourceRun.operations[1], FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256);
  const observed = at(proof.observedAt); check(observed >= at(context.createdAt) && observed < at(context.expiresAt) &&
    (now === undefined || observed <= now && now - observed <= 120000 && now < at(context.expiresAt)), 'PROOF_EXPIRY');
}

export function assertFz3bPreflightRecoveryFinalization(context: Fz3bPreflightRefusalRecoveryContext, proof: Fz3bPreflightRefusalRecoveryProof, value: Fz3bPreflightRefusalRecoveryFinalization) {
  shape(value, ['schemaVersion', 'id', 'contextSha256', 'proofSha256', 'originalLeaseSha256', 'leaseUnlinked', 'barrierRetained', 'localProcessesClosed', 'finalizedAt', 'evidenceSha256']);
  check(value.schemaVersion === 1 && value.id === context.id && value.contextSha256 === fz3bPreflightDigest(context) && value.proofSha256 === fz3bPreflightDigest(proof) &&
    value.originalLeaseSha256 === proof.originalLeaseSha256 && value.leaseUnlinked === true && value.barrierRetained === true && value.localProcessesClosed === true &&
    at(value.finalizedAt) >= at(proof.observedAt) && at(value.finalizedAt) < at(context.expiresAt) && hash(value.evidenceSha256), 'FINALIZATION');
}

export function assertFz3bPreflightRecoveryAck(context: Fz3bPreflightRefusalRecoveryContext, proof: Fz3bPreflightRefusalRecoveryProof,
  finalization: Fz3bPreflightRefusalRecoveryFinalization, ack: Fz3bPreflightRefusalRecoveryAck) {
  shape(ack, ['schemaVersion', 'method', 'purpose', 'id', 'contextSha256', 'proofSha256', 'finalizationSha256', 'checkpointSha256', 'checkpointUpdatedAt', 'issuedAt', 'mac']);
  check(ack.schemaVersion === 1 && ack.method === 'fz3b-preflight-refusal-post-save-ack-v1' && ack.purpose === 'exact-local-inspect-release-only' &&
    ack.id === context.id && ack.contextSha256 === fz3bPreflightDigest(context) && ack.proofSha256 === fz3bPreflightDigest(proof) &&
    ack.finalizationSha256 === fz3bPreflightDigest(finalization) && hash(ack.checkpointSha256) && hash(ack.mac) &&
    at(ack.issuedAt) >= at(ack.checkpointUpdatedAt) && at(ack.checkpointUpdatedAt) >= at(finalization.finalizedAt) && at(ack.issuedAt) < at(context.expiresAt), 'ACK_BINDING');
}

export function assertFz3bPreflightRecoveryAcknowledgment(context: Fz3bPreflightRefusalRecoveryContext, proof: Fz3bPreflightRefusalRecoveryProof,
  finalization: Fz3bPreflightRefusalRecoveryFinalization, ack: Fz3bPreflightRefusalRecoveryAck, value: Fz3bPreflightRefusalRecoveryAcknowledgment) {
  shape(value, ['schemaVersion', 'id', 'contextSha256', 'proofSha256', 'finalizationSha256', 'ackSha256', 'originalLeaseSha256', 'localBarrierRemoved', 'localProcessesClosed', 'evidenceSha256']);
  check(value.schemaVersion === 1 && value.id === context.id && value.contextSha256 === fz3bPreflightDigest(context) && value.proofSha256 === fz3bPreflightDigest(proof) &&
    value.finalizationSha256 === fz3bPreflightDigest(finalization) && value.ackSha256 === fz3bPreflightDigest(ack) && value.originalLeaseSha256 === proof.originalLeaseSha256 &&
    value.localBarrierRemoved === true && value.localProcessesClosed === true && hash(value.evidenceSha256), 'ACKNOWLEDGMENT');
}

export function assertFz3bPreflightRecoveryClosure(context: Fz3bPreflightRefusalRecoveryContext, proof: Fz3bPreflightRefusalRecoveryProof,
  finalization: Fz3bPreflightRefusalRecoveryFinalization, ack: Fz3bPreflightRefusalRecoveryAck,
  acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment, value: Fz3bPreflightRefusalRecoveryClosure) {
  shape(value, ['schemaVersion', 'method', 'purpose', 'id', 'contextSha256', 'proofSha256', 'finalizationSha256', 'ackSha256', 'acknowledgmentSha256', 'checkpointSha256', 'issuedAt', 'mac']);
  check(value.schemaVersion === 1 && value.method === 'fz3b-preflight-refusal-worker-closed-v1' && value.purpose === 'actual-local-barrier-close-only' &&
    value.id === context.id && value.contextSha256 === fz3bPreflightDigest(context) && value.proofSha256 === fz3bPreflightDigest(proof) &&
    value.finalizationSha256 === fz3bPreflightDigest(finalization) && value.ackSha256 === fz3bPreflightDigest(ack) &&
    value.acknowledgmentSha256 === fz3bPreflightDigest(acknowledgment) && value.checkpointSha256 === ack.checkpointSha256 &&
    at(value.issuedAt) >= at(ack.issuedAt) && hash(value.mac), 'CLOSURE');
}

/** Structural public history predicate only; backend separately authenticates HMAC/post-save ACK and worker bytes. */
export function fz3bReleasedPreflightRefusalRecovery(run: Fz3bRunView, operation: Fz3bOperation, fixture: Fz3bSemanticFixture): Fz3bPreflightRefusalRecovery | undefined {
  try {
    const attempt = run.preflightRefusalRecoveries?.at(-1);
    if (!attempt || run.preflightRefusalRecoveries?.length !== 1 || attempt.status !== 'released' || !attempt.proof || !attempt.finalization || !attempt.ack || !attempt.acknowledgment || !attempt.closure ||
      run.active || !run.stopRequested || run.status !== 'needs_attention' || run.grant || run.semantic || run.identity || run.export || run.reconciliations || run.nativeApproval !== 'not_requested') return undefined;
    assertFz3bPreflightRecoveryContext(attempt.context, fixture); assertFz3bPreflightRecoveryProof(attempt.context, attempt.proof);
    assertFz3bPreflightRecoveryFinalization(attempt.context, attempt.proof, attempt.finalization);
    assertFz3bPreflightRecoveryAck(attempt.context, attempt.proof, attempt.finalization, attempt.ack);
    assertFz3bPreflightRecoveryAcknowledgment(attempt.context, attempt.proof, attempt.finalization, attempt.ack, attempt.acknowledgment);
    assertFz3bPreflightRecoveryClosure(attempt.context, attempt.proof, attempt.finalization, attempt.ack, attempt.acknowledgment, attempt.closure);
    const source = attempt.context.sourceRun;
    if (operation.id !== FZ3B_PREFLIGHT_RECOVERY_CASE.operationId || !same(operation, source.operations[1]) || !same(run.operations, source.operations) ||
      !same(run.calls, source.calls) || !same(run.artifact, source.artifact) || !same(fz3bReconciliationOwnerBinding(run), fz3bReconciliationOwnerBinding(source)) ||
      !same(run.maintenanceExit ?? null, source.maintenanceExit ?? null)) return undefined;
    return structuredClone(attempt);
  } catch { return undefined; }
}
