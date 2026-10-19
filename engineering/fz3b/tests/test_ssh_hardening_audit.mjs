import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { captureAudit, MAX_STDOUT, validateAudit } from '../tools/ssh_hardening_audit.mjs';

function envelope(result = 'audit-collected') {
  return { schemaVersion: 1, scope: 'fz3b-ssh-auth-readonly-audit',
    host: '169.254.220.254', readOnly: true, configurationChanged: false,
    serviceActions: 'not-attempted', passwordOrShadowRead: false,
    privateKeyRead: false, result, issues: [], files: [],
    commands: { effectiveRoot: { exitCode: 0,
      matchContext: 'user=root,host=169.254.142.174,addr=169.254.142.174,laddr=169.254.220.254,lport=22' } },
    expectedConnection: { sourceAddress: '169.254.142.174',
      destinationAddress: '169.254.220.254', destinationPort: 22 },
    currentSessionMatchesExpectedConnection: true };
}

function fakeChild({ killResult = true, killThrows = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unrefCalled = false;
  child.unref = () => { child.unrefCalled = true; };
  child.kill = () => {
    if (killThrows) throw Error('fake kill exception');
    return killResult;
  };
  return child;
}

test('valid fixed audit envelope passes without exposing raw input', () => {
  const parsed = validateAudit(Buffer.from(JSON.stringify(envelope())));
  assert.equal(parsed.currentSessionMatchesExpectedConnection, true);
  assert.throws(() => validateAudit(Buffer.from(JSON.stringify({ ...envelope(), readOnly: false }))),
    /invalid-audit-envelope/);
  assert.throws(() => validateAudit(Buffer.alloc(MAX_STDOUT + 1)), /audit-output-limit/);
});

test('incomplete audit is retained when effective command failed', () => {
  const value = envelope('audit-incomplete');
  value.commands.effectiveRoot = { exitCode: 1 };
  value.issues = ['command-failed:effectiveRoot'];
  assert.equal(validateAudit(Buffer.from(JSON.stringify(value))).result, 'audit-incomplete');
});

test('bounded fake SSH success returns only stdout', async () => {
  const child = fakeChild();
  const spawnImpl = () => {
    setImmediate(() => {
      child.stdout.end(Buffer.from(JSON.stringify(envelope())));
      child.stderr.end(Buffer.from('private stderr ignored'));
      child.emit('close', 0, null);
    });
    return child;
  };
  const response = await captureAudit(Buffer.from('fixed stdin'), [], spawnImpl, 1000);
  assert.equal(validateAudit(response).result, 'audit-collected');
});

test('timeout with no close and failed kill is bounded unknown, never success', async () => {
  const child = fakeChild({ killResult: false });
  await assert.rejects(captureAudit(Buffer.from('source'), [], () => child, 20),
    /termination-unconfirmed/);
  assert.equal(child.unrefCalled, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('output overflow with throwing kill remains controlled and bounded', async () => {
  const child = fakeChild({ killThrows: true });
  setImmediate(() => child.stdout.write(Buffer.alloc(MAX_STDOUT + 1)));
  await assert.rejects(captureAudit(Buffer.from('source'), [], () => child, 20),
    /termination-unconfirmed/);
  assert.equal(child.unrefCalled, true);
});
