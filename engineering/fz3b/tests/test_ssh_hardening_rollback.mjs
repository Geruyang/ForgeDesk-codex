import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmed, main, validateForwardAttempt, validateRollback } from '../tools/ssh_hardening_rollback.mjs';

const sourceSha = 'c384335524d64fed22b3b5d865b37a4ab4643c7a14ed25d6eb44a4874dc5bd5f';
const configSha = 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216';
const authSha = 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f';

test('rollback cannot be called without explicit operator flag', async () => {
  await assert.rejects(main([]), /explicit --confirm-rollback required/);
  await assert.rejects(main(['--confirm-rollback', '--retry']),
    /explicit --confirm-rollback required/);
});

test('rollback requires matching prior one-shot forward attempt', () => {
  const value = { schemaVersion: 1, scope: 'fz3b-root-policy-attempt',
    sourceSha256: sourceSha, originalConfigSha256: configSha,
    authorizedSha256: authSha, outcome: 'pending-or-unknown',
    automaticRetry: false, automaticRollback: false };
  assert.equal(validateForwardAttempt(Buffer.from(JSON.stringify(value))).scope,
    'fz3b-root-policy-attempt');
  assert.throws(() => validateForwardAttempt(Buffer.from(JSON.stringify({
    ...value, originalConfigSha256: '0'.repeat(64) }))), /forward-attempt-not-matching/);
});

test('rollback receipt requires exact original restored by reload', () => {
  const value = { schemaVersion: 1, scope: 'fz3b-root-policy-rollback',
    result: 'original-restored-reloaded',
    bootId: '5ceb45a3-8903-4efc-9484-ec75c17280df',
    restoredConfigSha256: configSha, restoredConfigBytes: 3248,
    backupPath: '/etc/ssh/sshd_config.fz3b-prehardening-20261016',
    backupSha256: configSha, priorCandidateSha256: 'a'.repeat(64),
    priorCandidateBytes: 3405, authorizedSha256: authSha,
    rootContextsChecked: 2, nonrootContextsUnchanged: 2,
    serviceId: 'ssh.service', serviceFragment: '/lib/systemd/system/ssh.service',
    serviceAction: 'reload', servicePidBefore: 3431, servicePidAfter: 3431,
    passwordRotated: false, remoteRootPasswordRouteRestored: true,
    independentLoginPostchecked: false };
  assert.equal(validateRollback(Buffer.from(JSON.stringify(value))).result,
    'original-restored-reloaded');
  assert.throws(() => validateRollback(Buffer.from(JSON.stringify({
    ...value, serviceAction: 'restart' }))), /rollback-result-invalid/);
});

test('transport unknown never passes rollback', () => {
  const good = { sshCloseConfirmed: true, sshExitObserved: true, exitCode: 0,
    signal: null, failure: null, remoteOutcomeUnknown: false, killAttempted: false };
  assert.equal(confirmed(good), true);
  assert.equal(confirmed({ ...good, sshCloseConfirmed: false }), false);
  assert.equal(confirmed({ ...good, killAttempted: true }), false);
});
