import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { evaluateCapture, helperPath, helperSha256, knownHostLine, parseArgs, projectRoot,
  scenarios, sourcePath, sourceSha256, sshArgs } from './recovery_client_probe.mjs';

// Pure fixed argument/result fixtures only. Never call main or captureOwnedSsh.
function capture(scenario = 'disconnect') {
  const count = scenario === 'checkpoint' ? 1 : 2;
  return { sshCloseConfirmed: true, sshExitObserved: true, exitCode: 0, signal: null,
    failure: null, remoteOutcomeUnknown: false, killAttempted: false,
    observation: { schema: 'fz3b-idle-client-recovery-v1', scenario, result: 'passed', stage: 'complete',
      endpoint: '127.0.0.1:8765', connections_attempted: count, normal_closes_confirmed: count,
      compute_requested: false, service_actions: false, device_opened: false, files_written: false,
      application_imported: false, retries: 0, replay_attempted: false,
      network_fault_injected: false, human_review_required: false } };
}
const identity = () => ({ sourceUnchanged: true, helperUnchanged: true, knownHostUnchanged: true, keyMetadataUnchanged: true });

test('closed scenario parser defaults to preparation, explicit execution flag only', () => {
  for (const scenario of scenarios) {
    assert.deepEqual(parseArgs(['--scenario', scenario]), { scenario, execute: false });
    assert.deepEqual(parseArgs(['--scenario', scenario, '--execute-reviewed']), { scenario, execute: true });
  }
  for (const argv of [[], ['disconnect'], ['--scenario', 'restart'], ['--scenario', 'disconnect;start'],
    ['--scenario', '../disconnect'], ['--scenario', 'disconnect', '--host', 'other'],
    ['--scenario', 'disconnect', '--execute'], ['--execute-reviewed', '--scenario', 'disconnect'],
    ['--scenario', 'disconnect', '--execute-reviewed', '--execute-reviewed']]) {
    assert.throws(() => parseArgs(argv));
  }
});

test('SSH target, key, trust and command are fixed without forwarding/password fallback', () => {
  for (const scenario of scenarios) {
    const args = sshArgs(scenario);
    assert.equal(args.at(-2), 'root@169.254.220.254');
    assert.equal(args.at(-1), `python3 -B - --scenario ${scenario}`);
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('IdentitiesOnly=yes'));
    assert.ok(args.includes('IdentityAgent=none'));
    assert.ok(args.includes('PasswordAuthentication=no'));
    assert.ok(args.includes('KbdInteractiveAuthentication=no'));
    assert.ok(args.includes('ConnectionAttempts=1'));
    assert.ok(args.includes('ForwardAgent=no'));
    assert.ok(args.includes('ClearAllForwardings=yes'));
    assert.ok(args.some(item => item.startsWith('UserKnownHostsFile=') && item.includes('.runtime')));
    assert.ok(args[args.indexOf('-i') + 1].startsWith(projectRoot));
    assert.ok(!args.includes('-L') && !args.includes('-R') && !args.includes('-D'));
  }
  assert.throws(() => sshArgs('checkpoint --host evil'));
  assert.ok(knownHostLine.startsWith('169.254.220.254 ssh-ed25519 '));
});

test('only all transport, identity and application facts allow bounded passed', () => {
  for (const scenario of scenarios) {
    const result = evaluateCapture(capture(scenario), identity(), scenario);
    assert.equal(result.result, 'passed');
    assert.equal(result.historicalUnknownResolved, false);
    assert.equal(result.realNetworkFaultQualified, false);
  }
});

test('passed-looking body cannot override lost close, exit, deadline, signal or local kill', () => {
  for (const change of [{ sshCloseConfirmed: false }, { sshExitObserved: false }, { exitCode: null },
    { exitCode: 1 }, { signal: 'SIGTERM' }, { failure: 'deadline' }, { remoteOutcomeUnknown: true },
    { killAttempted: true }, { failure: undefined }, { sshCloseConfirmed: 'true' }]) {
    const result = evaluateCapture({ ...capture(), ...change }, identity(), 'disconnect');
    assert.equal(result.result, 'unknown');
    assert.equal(result.humanReviewRequired, true);
  }
});

test('source/helper/host/key identity changes all retain unknown', () => {
  for (const key of Object.keys(identity())) {
    const result = evaluateCapture(capture(), { ...identity(), [key]: false }, 'disconnect');
    assert.equal(result.result, 'unknown');
  }
});

test('wrong scenario, incomplete, dangerous or replayed body cannot pass', () => {
  const changes = [{ scenario: 'rejection' }, { schema: 'other' }, { stage: 'next-legal-transaction' },
    { result: 'failed-or-unknown' }, { endpoint: '0.0.0.0:8765' }, { connections_attempted: 3 },
    { normal_closes_confirmed: 1 }, { compute_requested: true }, { service_actions: true },
    { device_opened: true }, { files_written: true }, { application_imported: true },
    { retries: 1 }, { replay_attempted: true }, { network_fault_injected: true }, { human_review_required: true }];
  for (const change of changes) {
    const value = capture(); value.observation = { ...value.observation, ...change };
    assert.equal(evaluateCapture(value, identity(), 'disconnect').result, 'unknown');
  }
  assert.equal(evaluateCapture({}, identity(), 'disconnect').result, 'unknown');
  assert.throws(() => evaluateCapture(capture(), identity(), 'restart'));
});

test('pinned Python source and shared helper bytes still match, without private file reads', () => {
  const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  assert.equal(hash(sourcePath), sourceSha256);
  assert.equal(hash(helperPath), helperSha256);
});
