import { safePart } from '../embedded/files.js';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest, fz3bProfileSha256, validateFz3bFixture, validateFz3bIdentity } from './profile.js';
import type { Fz3bAdapterContext, Fz3bBinding, Fz3bInspectReconciliation, Fz3bInspectReconciliationContext,
  Fz3bInspectReconciliationFinalization, Fz3bInspectReconciliationProof, Fz3bOperation, Fz3bRunView, Fz3bSemanticFixture } from './types.js';

const OLD_INSPECT_RESOURCE = '951b6ec48562e56b67b158c237b2f0317e3cd9f965db981e78d2a003c2675dfa';
const SHA = /^[a-f0-9]{64}$/;
const hash = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);
const keys = (value: object, allowed: string[]) => !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
export const fz3bReconciliationDigest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));
export function fz3bReconciliationOwnerBinding(run: Fz3bRunView): Fz3bBinding {
  return { runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, model: run.model, generation: run.generation,
    threadId: run.threadId, ...(run.turnId ? { turnId: run.turnId } : {}) };
}
export function fz3bOriginalInspectionContext(run: Fz3bRunView, operation: Fz3bOperation, fixture: Fz3bSemanticFixture): Fz3bAdapterContext {
  return { runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, operationId: operation.id, requestKey: operation.requestKey,
    nonce: operation.nonce, profileSha256: run.profileSha256, fixture: structuredClone(fixture), ...(run.artifact ? { artifact: structuredClone(run.artifact) } : {}) };
}
export function assertFz3bReconciliationContext(run: Fz3bRunView, operation: Fz3bOperation, fixture: Fz3bSemanticFixture, context: Fz3bInspectReconciliationContext) {
  if (!context || !keys(context, ['schemaVersion', 'id', 'nonce', 'createdAt', 'original', 'originalOperationSha256', 'originalEvidenceSha256', 'ownerBindingSha256']) ||
      context.schemaVersion !== 1 || typeof context.id !== 'string' || safePart(context.id) !== context.id || !hash(context.nonce) ||
      !Number.isFinite(Date.parse(context.createdAt)) || context.originalOperationSha256 !== fz3bReconciliationDigest(operation) ||
      context.originalEvidenceSha256 !== operation.evidenceSha256 || context.ownerBindingSha256 !== fz3bReconciliationDigest(fz3bReconciliationOwnerBinding(run)) ||
      fz3bCanonicalJson(context.original) !== fz3bCanonicalJson(fz3bOriginalInspectionContext(run, operation, fixture))) throw new Error('FZ3B reconciliation original binding changed');
}
/** Omit now only for already-durable history; current finalization always supplies host time. */
export function assertFz3bReconciliationProof(context: Fz3bInspectReconciliationContext, proof: Fz3bInspectReconciliationProof, now?: number) {
  if (!proof || Buffer.byteLength(JSON.stringify(proof)) > 131072 ||
      !keys(proof, ['schemaVersion', 'id', 'nonce', 'contextSha256', 'originalEvidenceSha256', 'originalIntentSha256', 'originalCloseSha256',
        'originalResourceManifestSha256', 'localOriginalCloseConfirmed', 'identity', 'observedAt', 'evidenceSha256', 'transport', 'remote']) ||
      proof.schemaVersion !== 1 || proof.id !== context.id || proof.nonce !== context.nonce || proof.contextSha256 !== fz3bReconciliationDigest(context) ||
      proof.originalEvidenceSha256 !== context.originalEvidenceSha256 || !hash(proof.originalIntentSha256) || !hash(proof.originalCloseSha256) ||
      proof.originalResourceManifestSha256 !== OLD_INSPECT_RESOURCE || proof.localOriginalCloseConfirmed !== true || !hash(proof.evidenceSha256) ||
      !proof.transport || !keys(proof.transport, ['spawned', 'closeConfirmed', 'exitCode', 'timedOut']) || proof.transport.spawned !== true ||
      proof.transport.closeConfirmed !== true || proof.transport.exitCode !== 0 || proof.transport.timedOut !== false ||
      !proof.remote || !keys(proof.remote, ['readOnly', 'metadataStable', 'deviceOwners', 'controlConnections', 'inspectorPids', 'unfinishedJournalEntries',
        'scanCount', 'procScanComplete', 'journalScanComplete', 'originalInspectorAbsent']) || proof.remote.readOnly !== true || proof.remote.metadataStable !== true ||
      !Array.isArray(proof.remote.deviceOwners) || proof.remote.deviceOwners.length !== 0 || proof.remote.controlConnections !== 0 ||
      !Array.isArray(proof.remote.inspectorPids) || proof.remote.inspectorPids.length !== 0 || proof.remote.unfinishedJournalEntries !== 0 ||
      !Number.isSafeInteger(proof.remote.scanCount) || proof.remote.scanCount < 2 || proof.remote.procScanComplete !== true ||
      proof.remote.journalScanComplete !== true || proof.remote.originalInspectorAbsent !== true) throw new Error('FZ3B readonly reconciliation proof is incomplete');
  validateFz3bIdentity(proof.identity);
  const observed = Date.parse(proof.observedAt), created = Date.parse(context.createdAt);
  if (!Number.isFinite(observed) || observed < created || (now !== undefined && (now - created > 120000 || observed > now + 1000 || now - observed > 120000))) throw new Error('FZ3B readonly reconciliation proof is stale');
}
export function assertFz3bReconciliationFinalization(context: Fz3bInspectReconciliationContext, proof: Fz3bInspectReconciliationProof, value: Fz3bInspectReconciliationFinalization) {
  if (!value || !keys(value, ['schemaVersion', 'id', 'contextSha256', 'proofSha256', 'lockReleased', 'localProcessesClosed', 'evidenceSha256']) ||
      value.schemaVersion !== 1 || value.id !== context.id || value.contextSha256 !== fz3bReconciliationDigest(context) || value.proofSha256 !== fz3bReconciliationDigest(proof) ||
      value.lockReleased !== true || value.localProcessesClosed !== true || !hash(value.evidenceSha256)) throw new Error('FZ3B inspect hold finalization is not exact and durable');
}
/** Public structural predicate, not a replacement for ledger HMAC or actual evidence-byte verification. */
export function fz3bReleasedInspectReconciliation(run: Fz3bRunView, operation: Fz3bOperation, fixture: Fz3bSemanticFixture): Fz3bInspectReconciliation | undefined {
  try {
    validateFz3bFixture(fixture);
    if (run.schemaVersion !== 1 || run.model !== FZ3B_PROFILE.model || run.profileId !== FZ3B_PROFILE.id || run.profileSha256 !== fz3bProfileSha256(fixture) ||
        run.active || run.status !== 'needs_attention' || !run.stopRequested || run.grant || run.semantic || run.nativeApproval !== 'not_requested' ||
        operation.kind !== 'inspect' || operation.status !== 'unknown' || operation.processExited !== true || !hash(operation.evidenceSha256) ||
        run.operations.filter(op => op.id === operation.id).length !== 1 || fz3bCanonicalJson(run.operations.at(-1)) !== fz3bCanonicalJson(operation) ||
        run.operations.some(op => op.id !== operation.id && (op.kind !== 'build' || op.status !== 'succeeded')) ||
        run.calls.some(call => !['fz3b_status', 'fz3b_build', 'fz3b_inspect'].includes(call.tool) || call.status === 'running' ||
          (call.status === 'unknown' && (call.tool !== 'fz3b_inspect' || call.operationId !== operation.id))) ||
        run.calls.filter(call => call.tool === 'fz3b_inspect' && call.operationId === operation.id && call.status === 'unknown').length !== 1) return undefined;
    for (const attempt of run.reconciliations ?? []) {
      if (attempt !== run.reconciliations?.at(-1) || attempt.schemaVersion !== 1 || !keys(attempt, ['schemaVersion', 'context', 'status', 'createdAt', 'updatedAt', 'proof', 'finalization', 'error']) ||
          !Number.isFinite(Date.parse(attempt.createdAt)) || !Number.isFinite(Date.parse(attempt.updatedAt)) || attempt.status !== 'released' || !attempt.proof || !attempt.finalization) continue;
      try {
        assertFz3bReconciliationContext(run, operation, fixture, attempt.context);
        assertFz3bReconciliationProof(attempt.context, attempt.proof);
        assertFz3bReconciliationFinalization(attempt.context, attempt.proof, attempt.finalization);
        return structuredClone(attempt);
      } catch { /* Another attempt may have a complete exact release. */ }
    }
  } catch { /* Untrusted public snapshots are fail-closed. */ }
  return undefined;
}
