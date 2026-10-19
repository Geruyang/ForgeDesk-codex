import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmed, validateDiagnostic, validateKeyProof, validateResult } from '../tools/ssh_hardening_root_policy.mjs';

const sha = 'a'.repeat(64);
function proof(selected) {
  const service = { available: true, Id: 'ssh.service',
    FragmentPath: '/lib/systemd/system/ssh.service', ActiveState: 'active',
    LoadState: 'loaded', MainPID: 3431, ExecReloadCount: 2,
    ExecReloadEntries: ['{ argv[]=/usr/sbin/sshd -t ; }',
      '{ argv[]=/bin/kill -HUP $MAINPID ; }'] };
  return { schemaVersion: 1, scope: 'fz3b-key-login-service-receipt',
    selectedKey: selected, result: 'key-login-collected',
    sourceSha256: '88f2e5f5b68390ddec340fd25a13f2ccb065a1861cc3ba539d293156e5389a5e',
    helperSha256: '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515',
    hostTrust: 'pinned-ed25519-continuity', authentication: 'single-specified-public-key',
    sourceUnchanged: true, exitCode: 0, signal: null, failure: null,
    sshCloseConfirmed: true, sshExitObserved: true, remoteOutcomeUnknown: false,
    killAttempted: false, cryptographicKeyProof: true, keyProofError: null,
    acceptedPublicKeyFingerprint: selected === 'project' ?
      'SHA256:CK+/QggbKFueu9/aXfdUgOOSeeOM1xYUq+hYCQjBU4E' :
      'SHA256:WZsmwRMiJ+JmafeC7UR7Zfn+fo71YSE4t4ZVzj61TIA',
    acceptedPublicKeyBlobSha256: selected === 'project' ?
      '08afbf42081b285b9ebbdfda5df75480e39279e38cd71614abe8580908c15381' :
      '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80',
    publicKeyFileSha256: selected === 'project' ?
      'f280c358961a097c399cbc179af7e2255c80a0765c7af8eeaad478f579596b0d' :
      '158b56439ebdd62e85d2cc84bdf91ffe76f9189de46b0fbc7dc5a1072e84a27e',
    report: { scope: 'fz3b-key-login-service-readonly',
      readOnly: true, serviceActions: false, filesWritten: false, user: 'root', uid: 0,
      bootId: '5ceb45a3-8903-4efc-9484-ec75c17280df',
      authorizedSha256: 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f',
      authorizedBytes: 221, projectPublicKeyCount: 1, recoveryPublicKeyCount: 1,
      connectionSource: '169.254.142.174', connectionDestination: '169.254.220.254',
      services: { 'ssh.service': service, 'sshd.service': service } } };
}

test('both fixed independent proof schemas must be successful', () => {
  assert.equal(validateKeyProof(Buffer.from(JSON.stringify(proof('project'))), 'project').selectedKey,
    'project');
  assert.equal(validateKeyProof(Buffer.from(JSON.stringify(proof('recovery'))), 'recovery').selectedKey,
    'recovery');
  assert.throws(() => validateKeyProof(Buffer.from(JSON.stringify(proof('project'))), 'recovery'),
    /key-proof-invalid/);
  const failed = proof('project'); failed.sshCloseConfirmed = false;
  assert.throws(() => validateKeyProof(Buffer.from(JSON.stringify(failed)), 'project'),
    /key-proof-invalid/);
});

test('only exact reload transaction report can pass', () => {
  const value = { schemaVersion: 1, scope: 'fz3b-root-publickey-only-policy',
    result: 'committed-reloaded', bootId: '5ceb45a3-8903-4efc-9484-ec75c17280df',
    originalConfigSha256: 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216',
    originalConfigBytes: 3248,
    backupPath: '/etc/ssh/sshd_config.fz3b-prehardening-20261016',
    backupSha256: 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216',
    candidateSha256: sha, candidateBytes: 3405,
    authorizedSha256: 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f',
    rootContextsChecked: 2, nonrootContextsUnchanged: 2,
    serviceId: 'ssh.service', serviceFragment: '/lib/systemd/system/ssh.service',
    serviceAction: 'reload', servicePidBefore: 3431, servicePidAfter: 3431,
    passwordRotated: false, consolePasswordUnchanged: true,
    remotePasswordLoginPostchecked: false };
  assert.equal(validateResult(Buffer.from(JSON.stringify(value))).result, 'committed-reloaded');
  assert.throws(() => validateResult(Buffer.from(JSON.stringify({ ...value, serviceAction: 'restart' }))),
    /policy-result-invalid/);
});

test('unknown diagnostic is bounded and never promotes success', () => {
  const value = { schemaVersion: 1, scope: 'fz3b-root-policy-diagnostic',
    result: 'failed-or-unknown', phase: 'replace-started', candidateSha256: sha,
    errorType: 'OSError', errorCode: 'unclassified', automaticRetry: false,
    automaticRollback: false, operation: 'apply' };
  assert.equal(validateDiagnostic(value).phase, 'replace-started');
  assert.throws(() => validateDiagnostic({ ...value, phase: 'success' }),
    /policy-diagnostic-invalid/);
  const good = { sshCloseConfirmed: true, sshExitObserved: true, exitCode: 0,
    signal: null, failure: null, remoteOutcomeUnknown: false, killAttempted: false };
  assert.equal(confirmed(good), true);
  assert.equal(confirmed({ ...good, sshCloseConfirmed: false }), false);
});
