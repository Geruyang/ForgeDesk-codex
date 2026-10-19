import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { captureConfirmed, extractPythonStderr, parseArgs, sshArgs, validateDiagnostic,
  validateProbe, parsePublicKey, acceptedFingerprint } from '../tools/ssh_hardening_key_service_probe.mjs';
import { projectRoot } from '../tools/fetch_known_good_pl.mjs';

const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
function service() {
  return { Id: 'ssh.service', Names: 'ssh.service sshd.service',
    FragmentPath: '/lib/systemd/system/ssh.service',
    ExecReloadEntries: ['/bin/kill -HUP $MAINPID', '/usr/sbin/sshd -t'],
    ExecReloadEntrySha256: [emptySha, emptySha], ExecReloadCount: 2,
    MainPID: 123, ActiveState: 'active',
    LoadState: 'loaded', exitCode: 0, stderrSha256: emptySha, available: true };
}
function report() {
  return { schemaVersion: 1, scope: 'fz3b-key-login-service-readonly',
    readOnly: true, serviceActions: false, filesWritten: false,
    user: 'root', uid: 0, bootId: '5ceb45a3-8903-4efc-9484-ec75c17280df',
    connectionSource: '169.254.142.174', connectionDestination: '169.254.220.254',
    authorizedSha256: 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f',
    authorizedBytes: 221,
    backupSha256: '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b',
    projectPublicKeyCount: 1, recoveryPublicKeyCount: 1,
    passwordOrShadowRead: false, privateKeyRead: false,
    services: { 'ssh.service': service(), 'sshd.service': service() } };
}

test('only two key selections are accepted, with one explicit identity', () => {
  assert.equal(parseArgs(['--key', 'project']), 'project');
  assert.equal(parseArgs(['--key', 'recovery']), 'recovery');
  for (const args of [[], ['--key', 'other'], ['--key', 'project', '--retry']])
    assert.throws(() => parseArgs(args), /only --key/);
  const args = sshArgs('C:/known', 'C:/one-key');
  assert.equal(args[args.indexOf('-i') + 1], 'C:/one-key');
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('IdentityAgent=none'));
  assert.ok(args.includes('PasswordAuthentication=no'));
  assert.ok(args.includes('KbdInteractiveAuthentication=no'));
  assert.ok(args.includes('ControlMaster=no'));
  assert.ok(args.includes('ControlPath=none'));
  assert.ok(args.includes('-v'));
});

test('two public blobs and accepted-key fingerprints are cryptographically distinct', () => {
  const fingerprints = [];
  for (const selected of ['project', 'recovery']) {
    const filename = selected === 'project' ? 'fz3b_acceptance_ed25519.pub' :
      'fz3b_recovery_ed25519.pub';
    const proof = parsePublicKey(fs.readFileSync(path.join(projectRoot,
      '.runtime/fz3b-private', filename)), selected);
    fingerprints.push(proof.fingerprint);
    const trace = `debug1: Server accepts key: C:/one ED25519 ${proof.fingerprint} explicit\n`;
    assert.equal(acceptedFingerprint(trace, selected), proof.fingerprint);
    assert.throws(() => acceptedFingerprint(trace +
      'debug1: Server accepts key: C:/other RSA SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA explicit\n', selected),
      /accepted-key-fingerprint-mismatch/);
    assert.throws(() => acceptedFingerprint(trace, selected === 'project' ? 'recovery' : 'project'),
      /accepted-key-fingerprint-mismatch/);
  }
  assert.notEqual(fingerprints[0], fingerprints[1]);
});

test('fixed root/boot/authorized/service schema validates', () => {
  assert.equal(validateProbe(Buffer.from(JSON.stringify(report()))).uid, 0);
  for (const delta of [{ uid: 1000 }, { bootId: 'other' },
    { authorizedSha256: '0'.repeat(64) }, { privateKeyRead: true }])
    assert.throws(() => validateProbe(Buffer.from(JSON.stringify({ ...report(), ...delta }))),
      /invalid-probe-envelope/);
});

test('missing service fields or unconfirmed transport never passes', () => {
  const bad = report();
  bad.services['ssh.service'].MainPID = -1;
  assert.throws(() => validateProbe(Buffer.from(JSON.stringify(bad))),
    /invalid-service-properties/);
  const excess = report();
  excess.services['ssh.service'].ExecReloadCount = 9;
  assert.throws(() => validateProbe(Buffer.from(JSON.stringify(excess))),
    /invalid-service-properties/);
  const good = { sshCloseConfirmed: true, sshExitObserved: true, exitCode: 0,
    signal: null, failure: null, remoteOutcomeUnknown: false, killAttempted: false };
  assert.equal(captureConfirmed(good), true);
  assert.equal(captureConfirmed({ ...good, sshCloseConfirmed: false }), false);
  assert.equal(captureConfirmed({ ...good, killAttempted: true }), false);
});

test('missing secondary alias is observed without failing active ssh.service', () => {
  const value = report();
  value.services['sshd.service'] = { available: false, exitCode: 4, stderrSha256: emptySha };
  assert.equal(validateProbe(Buffer.from(JSON.stringify(value))).services['ssh.service'].ActiveState,
    'active');
  value.services['ssh.service'].ActiveState = 'inactive';
  assert.throws(() => validateProbe(Buffer.from(JSON.stringify(value))), /no-active-ssh-service/);
});

test('only controlled diagnostic type, code and source line are accepted', () => {
  const diagnostic = { schemaVersion: 1, scope: 'fz3b-key-service-diagnostic',
    result: 'failed', errorType: 'ValueError', errorCode: 'systemctl-output-limit',
    function: '_service', line: 133, errno: null, readOnly: true,
    serviceActions: false, filesWritten: false };
  assert.equal(validateDiagnostic(diagnostic).errorCode, 'systemctl-output-limit');
  const property = { ...diagnostic, errorCode: 'unsafe-systemctl-property',
    propertyKey: 'ExecReload', propertyLine: 4, valueLength: 2048, duplicateCount: 1 };
  assert.equal(validateDiagnostic(property).propertyKey, 'ExecReload');
  assert.throws(() => validateDiagnostic({ ...property, propertyKey: 'Environment' }),
    /invalid-controlled-diagnostic/);
  assert.throws(() => validateDiagnostic({ ...property, valueLength: -1 }),
    /invalid-controlled-diagnostic/);
  assert.throws(() => validateDiagnostic({ ...diagnostic, errorCode: 'secret=value' }),
    /invalid-controlled-diagnostic/);
});

test('Python stderr fallback retains only error type and stdin line', () => {
  const raw = '  File "<stdin>", line 117\n    secret_config_value\nSyntaxError: secret detail\n';
  const value = extractPythonStderr(raw);
  assert.deepEqual(value, { scope: 'fz3b-key-service-stderr-diagnostic',
    errorType: 'SyntaxError', line: 117, contentOmitted: true });
  assert.equal(extractPythonStderr('ssh: Authentication failed'), null);
});
