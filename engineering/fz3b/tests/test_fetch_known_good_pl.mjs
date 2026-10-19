import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { captureRemote, commitVerified, manifest, MAX_STDOUT, sourcePath, sourceSha256, sshArgs, validateEnvelope } from '../tools/fetch_known_good_pl.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');

function fixture() {
  const data = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
  const expected = data.map((bytes, index) => ({ name: `fixture-${index}.bin`, bytes: bytes.length, sha256: sha(bytes) }));
  const response = { schemaVersion: 1, scope: 'fz3b-known-good-pl-readonly', readOnly: true,
    deployed: false, entries: data.map((bytes, index) => ({ ...expected[index], base64: bytes.toString('base64') })) };
  return { data, expected, response };
}

test('fixed envelope decodes and checks each byte before returning files', () => {
  const { expected, response } = fixture();
  const files = validateEnvelope(Buffer.from(JSON.stringify(response)), expected);
  assert.deepEqual(files.map(file => file.name), expected.map(item => item.name));
  response.entries[2].base64 = Buffer.from('other').toString('base64');
  assert.throws(() => validateEnvelope(Buffer.from(JSON.stringify(response)), expected), /artifact-declaration-mismatch|artifact-byte-mismatch/);
});

test('noncanonical base64, added records, and oversized stdout fail', () => {
  const { expected, response } = fixture();
  response.entries[0].base64 += '=';
  assert.throws(() => validateEnvelope(Buffer.from(JSON.stringify(response)), expected), /artifact-declaration-mismatch/);
  const clean = fixture();
  clean.response.entries.push(clean.response.entries[0]);
  assert.throws(() => validateEnvelope(Buffer.from(JSON.stringify(clean.response)), expected), /invalid-response-envelope/);
  assert.throws(() => validateEnvelope(Buffer.alloc(MAX_STDOUT + 1), expected), /response-size-limit/);
});

function fakeSpawn(payload, exitCode = 0, emitStderr = Buffer.alloc(0)) {
  const calls = [];
  function spawnImpl(command, args, options) {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.emit('close', null, 'SIGTERM'); };
    setImmediate(() => {
      child.stdout.write(payload);
      child.stderr.write(emitStderr);
      child.stdout.end(); child.stderr.end();
      child.emit('close', exitCode, null);
    });
    return child;
  }
  return { calls, spawnImpl };
}

test('capture uses a fake process only and returns bounded stdout', async () => {
  const fake = fakeSpawn(Buffer.from('fixture'));
  const raw = await captureRemote(Buffer.from('source'), ['fixture-ssh-args'], fake.spawnImpl, 1000);
  assert.equal(raw.toString(), 'fixture');
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, 'ssh.exe');
  assert.equal(fake.calls[0].options.windowsHide, true);
});

test('oversized output or nonzero exit never reaches decoder', async () => {
  const huge = fakeSpawn(Buffer.alloc(MAX_STDOUT + 1));
  await assert.rejects(captureRemote(Buffer.from('source'), [], huge.spawnImpl, 1000), /stdout-size-limit/);
  const failed = fakeSpawn(Buffer.from('partial'), 1);
  await assert.rejects(captureRemote(Buffer.from('source'), [], failed.spawnImpl, 1000), /ssh-nonzero-exit/);
});

test('kill true, false, or throw without close still has bounded unknown outcome', async () => {
  for (const behavior of ['true', 'false', 'throw']) {
    let killed = 0;
    let unrefed = 0;
    let owned;
    function spawnImpl() {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { killed++; if (behavior === 'throw') throw new Error('fixture'); return behavior === 'true'; };
      child.unref = () => { unrefed++; };
      owned = child;
      return child;
    }
    const started = Date.now();
    await assert.rejects(captureRemote(Buffer.from('source'), [], spawnImpl, 30), /outcome-unknown/);
    assert.equal(killed, 1);
    assert.equal(unrefed, 1);
    assert.ok(owned.stdout.destroyed && owned.stderr.destroyed && owned.stdin.destroyed);
    assert.ok(Date.now() - started < 500);
  }
});

test('stdout limit with throwing kill is a controlled unknown outcome', async () => {
  function spawnImpl() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => { throw new Error('fixture-kill'); };
    child.unref = () => {};
    setImmediate(() => child.stdout.write(Buffer.alloc(MAX_STDOUT + 1)));
    return child;
  }
  await assert.rejects(captureRemote(Buffer.from('source'), [], spawnImpl, 30),
    /stdout-size-limit-kill-failed-outcome-unknown/);
});

test('SSH options pin continuity and disable forwarding and passwords', () => {
  const args = sshArgs('known_hosts', 'private_key').join(' ');
  for (const value of ['StrictHostKeyChecking=yes', 'UserKnownHostsFile=known_hosts',
    'IdentitiesOnly=yes', 'IdentityAgent=none', 'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no', 'ForwardAgent=no', 'ClearAllForwardings=yes',
    'root@169.254.220.254', 'python3 -B -']) assert.ok(args.includes(value));
  assert.equal(manifest.length, 3);
  assert.equal(sha(fs.readFileSync(sourcePath)), sourceSha256);
});

test('commit refuses unverified data before any filesystem write', () => {
  assert.throws(() => commitVerified([], 'source-hash'), /unverified-local-files/);
  assert.throws(() => commitVerified([{ name: '../escape', bytes: Buffer.from('x') }], 'source-hash'), /unverified-local-files/);
});
