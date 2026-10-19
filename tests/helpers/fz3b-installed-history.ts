import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { fz3bReleasedInspectReconciliation } from '../../packages/engineering-runner/fz3b/reconciliation';
import { fz3bCanonicalJson, fz3bDigest } from '../../packages/engineering-runner/fz3b/profile';
import { legacyInspectPayload, LEGACY_INSPECT_RESOURCE_SHA256 } from '../../packages/engineering-runner/fz3b/payload';
import type { Fz3bRunView, Fz3bSemanticFixture } from '../../packages/engineering-runner/fz3b/types';
import { plainPath } from './embedded-installed';

const digest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));
function persisted(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { assert.ok(Number.isFinite(value)); return value; }
  if (Array.isArray(value)) { assert.equal(Object.keys(value).length, value.length); return value.map(persisted); }
  assert.ok(value && typeof value === 'object'); assert.ok([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  assert.equal(Object.getOwnPropertySymbols(value).length, 0);
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, persisted(item)]));
}
function safeId(value: string) { assert.match(value, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/); return value; }

export function assertFz3bRunUnheld(run: Fz3bRunView, fixture?: Fz3bSemanticFixture) {
  assert.equal(run.active, false); assert.equal(run.hardwareBusy, false); assert.notEqual(run.nativeApproval, 'pending');
  for (const operation of run.operations) {
    if (['prepared', 'running', 'unknown'].includes(operation.status)) {
      assert.ok(fixture && fz3bReleasedInspectReconciliation(run, operation, fixture), 'Unreleased or non-inspect unknown history still holds the device');
    }
  }
}

export function assertFz3bHistoryStable(baseline: Fz3bRunView[], current: Fz3bRunView[], currentRunId?: string) {
  const retained = current.filter(run => run.runId !== currentRunId);
  const order = (runs: Fz3bRunView[]) => [...runs].sort((a, b) => a.runId.localeCompare(b.runId));
  assert.deepEqual(persisted(order(retained)), persisted(order(baseline)), 'All historical runs must remain exact; no skipped history or rewritten unknown operation');
}

/** Independent public-byte check. The installed main, not this reader, authenticates its HMAC ledger. */
export async function verifyFz3bHistoricalReleases(dataDir: string, runs: Fz3bRunView[], fixture: Fz3bSemanticFixture, resources: Map<string, Buffer>) {
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const releases: Array<{ runId: string; operationId: string; reconciliationId: string; originalStatus: 'unknown'; releaseOnly: true }> = [];
  const read = async (file: string, expected: string) => {
    assert.match(expected, /^[a-f0-9]{64}$/); await plainPath(file); const info = await lstat(file);
    assert.ok(info.isFile() && info.nlink === 1 && info.size <= 131072, 'Historical public evidence must be a bounded regular file');
    const bytes = await readFile(file); assert.equal(bytes.length, info.size); assert.equal(fz3bDigest(bytes), expected);
    files.push({ path: file, bytes: bytes.length, sha256: expected }); return JSON.parse(bytes.toString('utf8'));
  };
  for (const run of runs) {
    assertFz3bRunUnheld(run, fixture);
    for (const operation of run.operations.filter(item => item.status === 'unknown')) {
      const attempts = (run.reconciliations ?? []).filter(attempt => attempt.status === 'released'); assert.ok(attempts.length > 0);
      for (const attempt of attempts) {
        assert.ok(fz3bReleasedInspectReconciliation({ ...run, reconciliations: [attempt] }, operation, fixture), 'Every claimed released reconciliation must match this exact original inspect');
        const context = attempt.context, proof = attempt.proof!, finalization = attempt.finalization!;
        const worker = path.join(dataDir, 'fz3b-worker', safeId(operation.id));
        const directory = path.join(dataDir, 'fz3b-worker/reconciliations', safeId(context.id));
        const original = await read(path.join(worker, 'evidence.json'), context.originalEvidenceSha256);
        assert.equal(original.schemaVersion, 1); assert.equal(original.operationId, operation.id); assert.equal(original.nonce, operation.nonce);
        assert.equal(original.profileSha256, run.profileSha256); assert.equal(original.kind, 'inspect'); assert.equal(original.readOnly, true);
        assert.equal(original.status, 'unknown'); assert.equal(original.processExited, true); assert.equal(context.originalEvidenceSha256, operation.evidenceSha256);
        const intent = await read(path.join(worker, 'intent.json'), proof.originalIntentSha256);
        assert.equal(intent.schemaVersion, 1); assert.equal(intent.operationId, operation.id); assert.equal(intent.nonce, operation.nonce);
        assert.equal(intent.profileSha256, run.profileSha256); assert.equal(intent.action, 'inspect'); assert.equal(intent.dispatchPhase, 'may-have-started');
        assert.equal(intent.resourceManifestSha256, LEGACY_INSPECT_RESOURCE_SHA256);
        const payload = legacyInspectPayload({ fixture, manifestSha256: LEGACY_INSPECT_RESOURCE_SHA256, files: resources }, context.original);
        assert.equal(intent.payloadSha256, fz3bDigest(payload));
        const close = await read(path.join(worker, 'process-exit.json'), proof.originalCloseSha256);
        assert.equal(close.schemaVersion, 1); assert.equal(close.observedClose, true); assert.ok(Number.isInteger(close.exitCode));
        assert.match(close.outputSha256, /^[a-f0-9]{64}$/); assert.ok(Number.isFinite(Date.parse(close.at)));
        const actualProof = await read(path.join(directory, 'proof-evidence.json'), proof.evidenceSha256);
        assert.equal(actualProof.schemaVersion, 1); assert.deepEqual(actualProof.context, persisted(context)); assert.equal(actualProof.contextSha256, digest(context));
        assert.equal(actualProof.originalEvidenceSha256, context.originalEvidenceSha256); assert.equal(actualProof.originalIntentSha256, proof.originalIntentSha256);
        assert.equal(actualProof.originalCloseSha256, proof.originalCloseSha256); assert.equal(actualProof.originalUnknownPreserved, true);
        assert.equal(actualProof.observedAt, proof.observedAt); assert.deepEqual(actualProof.transport, proof.transport);
        assert.match(actualProof.originalLeaseSha256, /^[a-f0-9]{64}$/);
        assert.equal(typeof actualProof.remoteStdout, 'string'); assert.ok(Buffer.byteLength(actualProof.remoteStdout) <= 131072 && actualProof.remoteStdout.endsWith('\n') && actualProof.remoteStdout.trim().split('\n').length === 1);
        const remote = JSON.parse(actualProof.remoteStdout); assert.deepEqual(remote, actualProof.remote);
        assert.equal(remote.schemaVersion, 1); assert.equal(remote.id, context.id); assert.equal(remote.nonce, context.nonce);
        assert.equal(remote.contextSha256, digest(context)); assert.equal(remote.profileSha256, run.profileSha256); assert.equal(remote.status, 'succeeded');
        assert.deepEqual(remote.remote, proof.remote);
        const { hostKeySha256: _key, transport: _transport, helloAuthenticated: _hello, ...identity } = proof.identity;
        for (const [key, value] of Object.entries(identity)) assert.deepEqual(remote.identity?.[key], value);
        const actualFinalization = await read(path.join(directory, 'finalization-evidence.json'), finalization.evidenceSha256);
        assert.equal(actualFinalization.schemaVersion, 1); assert.equal(actualFinalization.id, context.id);
        assert.equal(actualFinalization.contextSha256, digest(context)); assert.equal(actualFinalization.proofSha256, digest(proof));
        assert.equal(actualFinalization.originalOperationId, operation.id); assert.equal(actualFinalization.originalNonce, operation.nonce);
        assert.equal(actualFinalization.originalLeaseSha256, actualProof.originalLeaseSha256); assert.equal(actualFinalization.oldUnknownPreserved, true);
        assert.equal(actualFinalization.preparedBeforeExactUnlink, true);
        releases.push({ runId: run.runId, operationId: operation.id, reconciliationId: context.id, originalStatus: 'unknown', releaseOnly: true });
      }
    }
  }
  return { releases, files, hmacKeyRead: false, ledgerAuthentication: 'Installed main authenticates persisted ledger; this helper independently validates retained public bytes, not HMAC signatures' };
}
