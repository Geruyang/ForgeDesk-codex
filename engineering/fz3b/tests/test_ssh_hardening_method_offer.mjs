import assert from 'node:assert/strict';
import test from 'node:test';
import { noCredentialArgs, observedOffer, offeredMethods,
  validatePolicyReceipt } from '../tools/ssh_hardening_method_offer.mjs';

test('fixed method probe has no key, agent, password or keyboard input', () => {
  const args = noCredentialArgs('C:/known');
  assert.equal(args.at(-2), 'root@169.254.220.254');
  assert.equal(args.at(-1), 'true');
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('NumberOfPasswordPrompts=0'));
  assert.ok(args.includes('PubkeyAuthentication=no'));
  assert.ok(args.includes('PasswordAuthentication=no'));
  assert.ok(args.includes('KbdInteractiveAuthentication=no'));
  assert.ok(args.includes('IdentityAgent=none'));
  assert.equal(args.includes('-i'), false);
});

test('only one observed publickey offer is accepted', () => {
  const stderr = 'debug1: Authentications that can continue: publickey\nPermission denied (publickey).\n';
  assert.deepEqual(offeredMethods(stderr), ['publickey']);
  for (const invalid of [
    'debug1: Authentications that can continue: publickey,password\n',
    'debug1: Authentications that can continue: keyboard-interactive\n',
    'not an SSH authentication trace',
    stderr + stderr,
  ]) assert.throws(() => offeredMethods(invalid));
});

test('expected denied exit and confirmed close are required', () => {
  const captured = { sshCloseConfirmed: true, sshExitObserved: true, exitCode: 255,
    signal: null, killAttempted: false, stdout: '',
    stderr: 'debug1: Authentications that can continue: publickey\n' };
  assert.deepEqual(observedOffer(captured), ['publickey']);
  assert.throws(() => observedOffer({ ...captured, sshCloseConfirmed: false }),
    /ssh-handshake-unconfirmed/);
  assert.throws(() => observedOffer({ ...captured, exitCode: 0 }),
    /ssh-handshake-unconfirmed/);
});

test('postcheck requires prior committed policy receipt', () => {
  const value = { schemaVersion: 1, scope: 'fz3b-root-publickey-only-policy',
    result: 'committed-reloaded',
    sourceSha256: 'c384335524d64fed22b3b5d865b37a4ab4643c7a14ed25d6eb44a4874dc5bd5f',
    originalConfigSha256: 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216',
    authorizedSha256: 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f',
    candidateBytes: 3405,
    serviceAction: 'reload', sshCloseConfirmed: true, sshExitObserved: true,
    hostTrust: 'pinned-ed25519-continuity',
    passwordLoginStillRequiresIndependentPostcheck: true };
  assert.equal(validatePolicyReceipt(Buffer.from(JSON.stringify(value))).result,
    'committed-reloaded');
  assert.throws(() => validatePolicyReceipt(Buffer.from(JSON.stringify({
    ...value, serviceAction: 'restart' }))), /root-policy-receipt-invalid/);
});
