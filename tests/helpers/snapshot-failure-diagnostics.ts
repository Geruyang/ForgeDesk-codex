import assert from 'node:assert/strict';
import type { Operation } from '../../packages/engineering-runner';

export function assertOriginalSnapshotDefect(operation: Operation): void {
  const context = `Original defect was not established: operation=${operation.id}, phase=${operation.phase ?? 'unknown'}, status=${operation.status}, reason=${operation.failureReason ?? 'none'}`;
  assert.equal(operation.status, 'failed', context);
  assert.equal(operation.evidenceLevel, 'B', context);
  assert.equal(operation.exitCode, 1, context);
  assert.equal(operation.failureReason, 'Snapshot verifying failed: exit 1', context);
  assert.equal(operation.snapshot?.verificationResult, 'failed', context);
  const sandbox = operation.snapshot?.sandboxProbe;
  for (const key of ['passed', 'inputWriteDenied', 'privateWriteDenied', 'templateWriteDenied', 'sqliteInputWriteDenied', 'outputWriteAllowed', 'sqliteOutputWriteAllowed', 'hostMarkersAbsent']) assert.equal(sandbox?.[key], true, `${context}; sandbox.${key}`);
  for (const stage of ['build', 'verify'] as const) {
    const permission: Record<string, unknown> | undefined = operation.snapshot?.permissionProbe?.[stage];
    assert.equal(permission?.stage, stage, `${context}; permission.${stage}.stage`);
    for (const key of ['passed', 'inputWriteDenied', 'childProcessDenied', 'workerDenied', 'addonDenied', 'wasiDenied', 'inspectorDenied']) assert.equal(permission?.[key], true, `${context}; permission.${stage}.${key}`);
    assert.equal(permission?.outputWriteAllowed, stage === 'build', `${context}; permission.${stage}.outputWriteAllowed`);
    assert.equal(permission?.outputWriteDenied, stage === 'verify', `${context}; permission.${stage}.outputWriteDenied`);
  }
  assert.ok(operation.snapshot?.verifierReceipt == null, `${context}; a completed passing verifier receipt contradicts original failure`);
}

export function snapshotFailureDiagnostic(operation: Operation, publicLog?: string) {
  const boundedLog = publicLog?.slice(0, 65536);
  const receipts: { prefix: string; value?: unknown; parseError?: string }[] = [];
  let lastLoggedStage: string | undefined;
  for (const line of boundedLog?.split(/\r?\n/) ?? []) {
    const stage = /^\[(sandbox_probe|permission_probe|building|verifying)(?::(?:build|verify))?\]$/.exec(line.trim());
    if (stage) lastLoggedStage = stage[1];
    const receipt = /^(FORGEDESK_(?:SANDBOX|PERMISSION|BUILD|TEST)_RECEIPT:)(.*)$/.exec(line);
    if (receipt && receipts.length < 8) {
      try { receipts.push({ prefix: receipt[1], value: JSON.parse(receipt[2]) }); }
      catch { receipts.push({ prefix: receipt[1], parseError: 'Receipt JSON is incomplete or invalid; not accepted as a proof' }); }
    }
  }
  const failedStage = /^Snapshot (sandbox_probe|permission_probe|building|verifying) failed:/.exec(operation.failureReason ?? '')?.[1];
  return { operationId: operation.id, status: operation.status, persistedPhase: operation.phase ?? null,
    failureReason: operation.failureReason ?? null, exitCode: operation.exitCode ?? null,
    failedStage: failedStage ?? null, lastLoggedStage: lastLoggedStage ?? null,
    category: failedStage === 'sandbox_probe' || failedStage === 'permission_probe' ? 'infrastructure-before-verifier'
      : failedStage === 'verifying' ? 'verification-failure-not-automatically-a-defect' : 'unclassified-operation-failure',
    receipts, publicLog: boundedLog ?? null, publicLogTruncated: (publicLog?.length ?? 0) > 65536 };
}
