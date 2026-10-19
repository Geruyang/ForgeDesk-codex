import assert from 'node:assert/strict';
import test from 'node:test';
import { transportIsConfirmed, validateRecovery } from '../tools/ssh_hardening_add_recovery.mjs';

function receipt() {
  return { schemaVersion: 1, scope: 'fz3b-recovery-key-added',
    sshdConfigChanged: false, sshdReloaded: false,
    passwordAuthenticationChanged: false, passwordRotated: false,
    originalAuthorizedSha256: '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b',
    backupPath: '/root/.ssh/authorized_keys.fz3b-prehardening-20261016',
    backupSha256: '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b',
    authorizedSha256: 'a'.repeat(64), authorizedBytes: 222,
    projectPublicKeyCount: 1, recoveryPublicKeyCount: 1,
    recoveryPublicKeyBlobSha256: '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80',
    independentRecoveryLoginVerified: false };
}

test('fixed success fields validate without claiming a login or reload', () => {
  const value = validateRecovery(Buffer.from(JSON.stringify(receipt())));
  assert.equal(value.independentRecoveryLoginVerified, false);
  assert.equal(value.sshdReloaded, false);
});

test('changed backup/preimage and invented login proof are rejected', () => {
  for (const delta of [
    { originalAuthorizedSha256: '0'.repeat(64) },
    { backupPath: '/tmp/other' },
    { independentRecoveryLoginVerified: true },
    { sshdReloaded: true },
    { recoveryPublicKeyCount: 2 },
  ]) {
    assert.throws(() => validateRecovery(Buffer.from(JSON.stringify({ ...receipt(), ...delta }))),
      /invalid-recovery-receipt/);
  }
});

test('unknown fields and oversized output fail closed', () => {
  assert.throws(() => validateRecovery(Buffer.from(JSON.stringify({
    ...receipt(), privateKey: 'secret' }))), /invalid-recovery-receipt/);
  assert.throws(() => validateRecovery(Buffer.alloc(32 * 1024 + 1)), /recovery-output-limit/);
});

test('transport success requires observed exit and close without kill or unknown', () => {
  const good = { sshCloseConfirmed: true, sshExitObserved: true, exitCode: 0,
    signal: null, failure: null, killAttempted: false, remoteOutcomeUnknown: false };
  assert.equal(transportIsConfirmed(good), true);
  for (const delta of [{ sshCloseConfirmed: false }, { sshExitObserved: false },
    { exitCode: null }, { signal: 'SIGTERM' }, { failure: 'deadline' },
    { killAttempted: true }, { remoteOutcomeUnknown: true }]) {
    assert.equal(transportIsConfirmed({ ...good, ...delta }), false);
  }
});
