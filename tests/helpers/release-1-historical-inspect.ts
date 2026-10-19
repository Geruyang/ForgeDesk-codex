import assert from 'node:assert/strict';
import path from 'node:path';
import { fz3bReleasedInspectReconciliation, fz3bReconciliationDigest } from '../../packages/engineering-runner/fz3b/reconciliation';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import { ROOT, readStable, sha, type Pin } from './release-1-files';

export const REVIEWED_INSPECT_RUN = '8b065e0a-c1ef-4848-8329-b18c19dda45c';
const OPERATION = 'f44fa8ee-928a-49e0-b77c-527b2a7b108a';
const RECOVERY = 'b2d7037c-a7c2-4a7e-9cbe-c9d36ddc4139';
const RUN_SHA = '6ef725076465c224df61652592714f494815b66e85a2c911781bdca2e95f4596';
const PUBLIC = 'output/hardware/2026-10-16-next/product/';
const WORKER = '.runtime/app/fz3b-worker/';
// These exact historical bytes qualify only this old software-host inventory, not a new device action.
export const REVIEWED_INSPECT_PINS: readonly Readonly<Pin>[] = Object.freeze([
  { path: PUBLIC + 'installed-reconciliation-result.json', bytes: 17302, sha256: '77d5b3e3be88ff0a246a5f637638c5f78033b42bd12f514c44e99ce5d48dabd1' },
  { path: PUBLIC + 'INSTALLED_RECONCILIATION_REVIEW.md', bytes: 7493, sha256: '4393e1a77e0c752af95d768925f0d68ddc066cc1fdf936f8907531987b5bf936' },
  { path: WORKER + OPERATION + '/evidence.json', bytes: 536, sha256: '7aa14eeb18dae936342e8f197d6ca690260d4bd4d47a1178a6a2a33ac0affa43' },
  { path: WORKER + OPERATION + '/intent.json', bytes: 492, sha256: 'f14a2d18c539edfc560aa5a7296a84c31d3e1b5bf4585f1fc94400a98f0a6a0d' },
  { path: WORKER + OPERATION + '/process-exit.json', bytes: 190, sha256: '2b3e7ff0f5efceed96c25fe55178d1cfaba0bab9dd6104d7316fcbe3aa39d91d' },
  { path: WORKER + 'reconciliations/' + RECOVERY + '/proof-evidence.json', bytes: 8967, sha256: '25396c96b8d45d7686cb0185c25c984d2641fb876ca4bd5ef3c2c0fc0a3dc35d' },
  { path: WORKER + 'reconciliations/' + RECOVERY + '/finalization-evidence.json', bytes: 557, sha256: 'c8d18e6acef5d8df2a1545272d6f2927885d6b8e1dc33e7a533e30b4b7148cb3' },
].map(pin => Object.freeze(pin)));

export function assertReviewedHistoricalInspect(run: Fz3bRunView) {
  assert.equal(run.runId, REVIEWED_INSPECT_RUN); assert.equal(sha(JSON.stringify(run)), RUN_SHA);
  const operation = run.operations.find(op => op.id === OPERATION); assert.ok(operation);
  const attempt = run.reconciliations?.at(-1); assert.equal(attempt?.context.id, RECOVERY);
  assert.ok(attempt);
  assert.ok(fz3bReleasedInspectReconciliation(run, operation, attempt.context.original.fixture));
  assert.equal(run.hardwareBusy, false); assert.equal(operation.status, 'unknown'); assert.equal(operation.remoteQuiescent, false);
  return attempt;
}

export function assertReviewedInspectEvidence(files: ReadonlyMap<string, Buffer>) {
  assert.deepEqual([...files.keys()].sort(), REVIEWED_INSPECT_PINS.map(pin => pin.path).sort());
  for (const pin of REVIEWED_INSPECT_PINS) {
    const bytes = files.get(pin.path); assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, pin.bytes); assert.equal(sha(bytes), pin.sha256);
  }
  const json = (index: number) => JSON.parse(files.get(REVIEWED_INSPECT_PINS[index].path)!.toString('utf8'));
  const result = json(0), runs = result.fz3bAgent.runs.filter((run: Fz3bRunView) => run.runId === REVIEWED_INSPECT_RUN);
  assert.equal(runs.length, 1); assert.equal(result.activeRunId, null); assert.equal(result.engine, 'stopped'); assert.equal(result.forceKill, false);
  const attempt = assertReviewedHistoricalInspect(runs[0]), proof = json(5), marker = json(6), operation = runs[0].operations.at(-1);
  assert.deepEqual(proof.context, attempt.context); assert.equal(proof.contextSha256, fz3bReconciliationDigest(attempt.context));
  assert.deepEqual(JSON.parse(proof.remoteStdout), proof.remote); assert.deepEqual(proof.remote.remote, attempt.proof!.remote);
  assert.equal(proof.remote.id, RECOVERY); assert.equal(proof.remote.nonce, attempt.context.nonce); assert.equal(proof.remote.contextSha256, proof.contextSha256);
  assert.equal(proof.transport.spawned, true); assert.equal(proof.transport.closeConfirmed, true); assert.equal(proof.transport.exitCode, 0); assert.equal(proof.transport.timedOut, false);
  assert.equal(proof.originalEvidenceSha256, REVIEWED_INSPECT_PINS[2].sha256);
  assert.equal(proof.originalIntentSha256, REVIEWED_INSPECT_PINS[3].sha256); assert.equal(proof.originalCloseSha256, REVIEWED_INSPECT_PINS[4].sha256);
  assert.equal(marker.contextSha256, proof.contextSha256); assert.equal(marker.proofSha256, fz3bReconciliationDigest(attempt.proof));
  assert.equal(marker.originalOperationId, OPERATION); assert.equal(marker.originalNonce, operation.nonce);
  assert.equal(marker.originalLeaseSha256, proof.originalLeaseSha256); assert.equal(marker.oldUnknownPreserved, true); assert.equal(marker.preparedBeforeExactUnlink, true);
  assert.equal(attempt.proof!.evidenceSha256, REVIEWED_INSPECT_PINS[5].sha256); assert.equal(attempt.finalization!.evidenceSha256, REVIEWED_INSPECT_PINS[6].sha256);
  return runs[0] as Fz3bRunView;
}

export async function verifyReviewedInspectEvidence() {
  const files = new Map<string, Buffer>();
  for (const pin of REVIEWED_INSPECT_PINS) files.set(pin.path, await readStable(path.join(ROOT, pin.path), pin.bytes));
  assertReviewedInspectEvidence(files);
}
