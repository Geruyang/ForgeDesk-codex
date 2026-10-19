import test from 'node:test';
import assert from 'node:assert/strict';
import type { Operation } from '../packages/engineering-runner';
import { assertOriginalSnapshotDefect, snapshotFailureDiagnostic } from './helpers/snapshot-failure-diagnostics';

function original(): Operation {
  const permission = (stage: 'build' | 'verify') => ({ stage, passed: true, inputWriteDenied: true,
    outputWriteAllowed: stage === 'build', outputWriteDenied: stage === 'verify', childProcessDenied: true,
    workerDenied: true, addonDenied: true, wasiDenied: true, inspectorDenied: true });
  return { schemaVersion: 1, id: 'fixture-original-op', taskId: 'fixture-task', requestKey: 'fixture-original', argsDigest: 'fixture',
    kind: 'build', command: { executable: 'fixture', args: [] }, status: 'failed', createdAt: 'fixture', cleanup: 'confirmed',
    exitCode: 1, evidenceLevel: 'B', phase: 'finalizing', failureReason: 'Snapshot verifying failed: exit 1',
    snapshot: { schemaVersion: 1, id: 'fixture-original-op', taskId: 'fixture-task', operationId: 'fixture-original-op', createdAt: 'fixture',
      inputRoot: 'fixture-input', outputRoot: 'fixture-output', manifestPath: 'fixture-manifest', manifestDigest: 'fixture', contentDigest: 'fixture',
      sourceInputDigest: 'fixture', profileId: 'forgedesk.node-software.v1', profileRevision: 1,
      isolation: { schemaVersion: 1, method: 'engine-sandbox-write-denial', policyDigest: 'fixture', projectRoot: 'fixture', protectedRoot: 'fixture', verifiedAt: 'fixture', probeLogRef: 'fixture', probeLogSha256: 'fixture' },
      verificationResult: 'failed', sandboxProbe: { passed: true, inputWriteDenied: true, privateWriteDenied: true, templateWriteDenied: true,
        sqliteInputWriteDenied: true, outputWriteAllowed: true, sqliteOutputWriteAllowed: true, hostMarkersAbsent: true },
      permissionProbe: { build: permission('build'), verify: permission('verify') } } };
}

test('original-defect assertion accepts only completed isolation and permissions before verifier exit 1', () => {
  assert.doesNotThrow(() => assertOriginalSnapshotDefect(original()));
});

test('sandbox-probe and other pre-verifier failures cannot count as original defect reproduction', () => {
  for (const stage of ['sandbox_probe', 'permission_probe', 'building']) {
    const operation = original(); operation.failureReason = `Snapshot ${stage} failed: exit 1`;
    operation.snapshot!.sandboxProbe = undefined; operation.snapshot!.permissionProbe = undefined;
    assert.throws(() => assertOriginalSnapshotDefect(operation), error => {
      assert.match(String(error), /operation=fixture-original-op, phase=finalizing/);
      assert.match(String(error), new RegExp(`reason=Snapshot ${stage} failed: exit 1`)); return true;
    });
  }
});

test('verifier exit 1 without any required sandbox fact or correct Node permission fact is rejected', () => {
  for (const key of Object.keys(original().snapshot!.sandboxProbe!)) {
    const operation = original(); operation.snapshot!.sandboxProbe![key] = false;
    assert.throws(() => assertOriginalSnapshotDefect(operation), /sandbox\./);
  }
  for (const stage of ['build', 'verify'] as const) {
    for (const key of ['passed', 'inputWriteDenied', 'childProcessDenied', 'workerDenied', 'addonDenied', 'wasiDenied', 'inspectorDenied']) {
      const operation = original(); operation.snapshot!.permissionProbe![stage][key] = false;
      assert.throws(() => assertOriginalSnapshotDefect(operation), /permission\./);
    }
    const operation = original(); operation.snapshot!.permissionProbe![stage].outputWriteAllowed = stage === 'verify';
    assert.throws(() => assertOriginalSnapshotDefect(operation), /outputWriteAllowed/);
  }
});

test('contradictory successful or non-verifier failures do not pass the original-defect assertion', () => {
  for (const changed of [{ status: 'succeeded' }, { exitCode: 0 }, { evidenceLevel: 'A' }, { failureReason: 'Snapshot verifying failed: exit 2' }]) {
    assert.throws(() => assertOriginalSnapshotDefect({ ...original(), ...changed } as Operation), /Original defect was not established/);
  }
  const operation = original(); operation.snapshot!.verifierReceipt = { passed: true };
  assert.throws(() => assertOriginalSnapshotDefect(operation), /contradicts original failure/);
});

test('public sandbox failure diagnostics preserve SQLite facts without treating them as accepted proofs', () => {
  const operation = original(); operation.failureReason = 'Snapshot sandbox_probe failed: exit 1';
  const value = { passed: false, outputWriteAllowed: true, sqliteOutputWriteAllowed: false,
    facts: { outputSqlite: { opened: false, created: false, openErrorCode: 'ERR_SQLITE_ERROR' } } };
  const log = '[sandbox_probe]\r\nFORGEDESK_SANDBOX_RECEIPT:' + JSON.stringify(value) + '\r\n' + operation.failureReason;
  const diagnostic = snapshotFailureDiagnostic(operation, log);
  assert.equal(diagnostic.category, 'infrastructure-before-verifier'); assert.equal(diagnostic.failedStage, 'sandbox_probe');
  assert.equal(diagnostic.lastLoggedStage, 'sandbox_probe'); assert.deepEqual(diagnostic.receipts[0].value, value);
  assert.equal(diagnostic.operationId, operation.id); assert.equal(diagnostic.persistedPhase, 'finalizing');
});

test('public log diagnostics are bounded and malformed receipts are not interpreted as proof', () => {
  const diagnostic = snapshotFailureDiagnostic(original(), '[verifying]\nFORGEDESK_TEST_RECEIPT:{not-json}\n' + 'x'.repeat(70000));
  assert.equal(diagnostic.publicLog!.length, 65536); assert.equal(diagnostic.publicLogTruncated, true);
  assert.equal(diagnostic.receipts[0].value, undefined); assert.match(diagnostic.receipts[0].parseError!, /not accepted/);
  assert.equal(diagnostic.category, 'verification-failure-not-automatically-a-defect');
});

test('permission stage suffixes retain the stable base stage in public diagnostics', () => {
  const operation = original(); operation.failureReason = 'Snapshot permission_probe failed: exit 1';
  for (const stage of ['build', 'verify']) {
    const diagnostic = snapshotFailureDiagnostic(operation, `[permission_probe:${stage}]\nFORGEDESK_PERMISSION_RECEIPT:{"stage":"${stage}","passed":false}`);
    assert.equal(diagnostic.lastLoggedStage, 'permission_probe');
    assert.equal(diagnostic.category, 'infrastructure-before-verifier');
    assert.deepEqual(diagnostic.receipts[0].value, { stage, passed: false });
  }
});
