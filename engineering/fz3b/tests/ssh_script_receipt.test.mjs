import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { captureOwnedSsh, root, SSH_CLEANUP_TIMEOUT_MS } from '../tools/ssh_script_receipt.mjs';

// No runReviewedScript call: fixtures never read private files or start an executable.
class FakeClock {
  now = 0;
  next = 0;
  pending = new Map();
  setTimeout = (callback, delay) => {
    const id = ++this.next;
    this.pending.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = id => this.pending.delete(id);
  advance(milliseconds) {
    const end = this.now + milliseconds;
    while (true) {
      const next = [...this.pending].filter(([, entry]) => entry.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, entry] = next;
      this.pending.delete(id);
      this.now = entry.at;
      entry.callback();
    }
    this.now = end;
  }
}

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new EventEmitter();
  killCalls = 0;
  unrefCalls = 0;
  constructor(killBehavior = () => false, endBehavior = () => {}) {
    super();
    this.killBehavior = killBehavior;
    this.stdin.end = script => { this.script = script; endBehavior(this); };
  }
  kill() { this.killCalls++; return this.killBehavior(this); }
  unref() { this.unrefCalls++; throw new Error('A potentially live child must not be unrefed'); }
}

function fixture({ timeoutMs = 20, killBehavior, endBehavior } = {}) {
  const clock = new FakeClock();
  const child = new FakeChild(killBehavior, endBehavior);
  const calls = [];
  let settled = false;
  const promise = captureOwnedSsh(Buffer.from('print("fixture")\n'), ['fixed-owned-args'], {
    timeoutMs, timers: clock,
    spawnChild: (...args) => { calls.push(args); return child; },
  });
  promise.then(() => { settled = true; });
  return { child, clock, calls, promise, timeoutMs, settled: () => settled };
}

const outputJson = child => child.stdout.emit('data', Buffer.from('{"result":"passed"}'));
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

test('normal completion retains existing receipt fields and fixed spawn properties', async () => {
  const f = fixture();
  outputJson(f.child);
  f.child.stderr.emit('data', Buffer.from('diagnostic'));
  f.child.emit('exit', 0, null);
  f.child.emit('close', 0, null);
  const result = await f.promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.failure, null);
  assert.deepEqual(result.observation, { result: 'passed' });
  assert.equal(result.stdout, '{"result":"passed"}');
  assert.equal(result.stderr, 'diagnostic');
  assert.equal(result.sshCloseConfirmed, true);
  assert.equal(result.sshExitObserved, true);
  assert.equal(result.remoteOutcomeUnknown, false);
  assert.equal(result.killAttempted, false);
  assert.equal(result.localSshPid, 4242);
  assert.equal(result.cleanupTimeoutMs, 5000);
  assert.equal(f.clock.pending.size, 0);
  assert.equal(f.child.killCalls, 0);
  assert.equal(f.child.unrefCalls, 0);
  assert.deepEqual(f.calls, [['ssh.exe', ['fixed-owned-args'], {
    windowsHide: true, cwd: root, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  }]]);
  assert.equal(f.child.script.toString(), 'print("fixture")\n');
});

for (const [name, behavior, returned, error] of [
  ['false', () => false, false, null],
  ['true', () => true, true, null],
  ['throw', () => { throw new Error('owned kill denied'); }, null, 'owned kill denied'],
]) {
  test(`deadline kill ${name} without close has bounded capture and no false exit zero`, async () => {
    const f = fixture({ killBehavior: behavior });
    outputJson(f.child);
    f.clock.advance(f.timeoutMs);
    assert.equal(f.child.killCalls, 1);
    f.clock.advance(SSH_CLEANUP_TIMEOUT_MS - 1);
    await tick();
    assert.equal(f.settled(), false);
    f.clock.advance(1);
    const result = await f.promise;
    assert.match(result.failure, /deadline.*unknown/);
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, null);
    assert.equal(result.sshCloseConfirmed, false);
    assert.equal(result.remoteOutcomeUnknown, true);
    assert.equal(result.cleanupDeadlineExceeded, true);
    assert.equal(result.killAttempted, true);
    assert.equal(result.killReturn, returned);
    assert.equal(result.killError, error);
    assert.equal(result.localSshPid, 4242);
    assert.equal(result.captureTimeoutMs, f.timeoutMs);
    assert.equal(result.cleanupTimeoutMs, SSH_CLEANUP_TIMEOUT_MS);
    assert.equal(f.child.killCalls, 1);
    assert.equal(f.child.unrefCalls, 0);
    assert.equal(f.clock.pending.size, 0);
  });
}

test('late close/error/data after cleanup cannot change the saved unknown result or crash', async () => {
  const f = fixture();
  outputJson(f.child);
  f.clock.advance(f.timeoutMs + SSH_CLEANUP_TIMEOUT_MS);
  const result = await f.promise;
  const before = JSON.stringify(result);
  assert.doesNotThrow(() => {
    f.child.emit('exit', 0, null);
    f.child.emit('close', 0, null);
    f.child.emit('error', new Error('late process error'));
    for (const stream of [f.child.stdin, f.child.stdout, f.child.stderr]) stream.emit('error', new Error('late stream error'));
    f.child.stdout.emit('data', Buffer.from('LATE'));
  });
  assert.equal(JSON.stringify(result), before);
  assert.equal(f.child.killCalls, 1);
  assert.equal(f.child.unrefCalls, 0);
});

test('close within cleanup records actual close but does not erase the deadline failure', async () => {
  const f = fixture({ killBehavior: () => true });
  outputJson(f.child);
  f.clock.advance(f.timeoutMs);
  f.clock.advance(100);
  f.child.emit('close', 0, null);
  const result = await f.promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.sshCloseConfirmed, true);
  assert.equal(result.remoteOutcomeUnknown, true);
  assert.match(result.failure, /deadline/);
  assert.equal(result.cleanupDeadlineExceeded, false);
  assert.equal(f.clock.pending.size, 0);
});

test('exit zero alone is not close confirmation or a successful remote receipt', async () => {
  const f = fixture();
  outputJson(f.child);
  f.child.emit('exit', 0, null);
  await tick();
  assert.equal(f.settled(), false);
  f.clock.advance(f.timeoutMs + SSH_CLEANUP_TIMEOUT_MS);
  const result = await f.promise;
  assert.equal(result.sshExitObserved, true);
  assert.equal(result.sshCloseConfirmed, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.remoteOutcomeUnknown, true);
});

for (const [stream, cap] of [['stdout', 1024 * 1024], ['stderr', 32768]]) {
  test(`${stream} oversize bounds bytes, attempts kill once and settles without close`, async () => {
    const f = fixture();
    if (stream === 'stderr') outputJson(f.child);
    f.child[stream].emit('data', Buffer.alloc(cap + 100, 65));
    f.child[stream].emit('data', Buffer.alloc(100, 66));
    f.child.stdin.emit('error', new Error('secondary failure'));
    assert.equal(f.child.killCalls, 1);
    f.clock.advance(SSH_CLEANUP_TIMEOUT_MS);
    const result = await f.promise;
    assert.match(result.failure, new RegExp(`${stream} limit`));
    assert.equal(Buffer.byteLength(result[stream]), cap);
    assert.equal(result.exitCode, null);
    assert.equal(result.sshCloseConfirmed, false);
    assert.equal(result.remoteOutcomeUnknown, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.child.killCalls, 1);
  });
}

test('split multibyte UTF8 is assembled before JSON parsing', async () => {
  const f = fixture();
  const bytes = Buffer.from('{"value":"\u4e2d"}');
  for (const byte of bytes) f.child.stdout.emit('data', Buffer.from([byte]));
  f.child.emit('close', 0, null);
  const result = await f.promise;
  assert.equal(result.failure, null);
  assert.deepEqual(result.observation, { value: '\u4e2d' });
});

test('asynchronous child error is bounded even if kill throws and close never arrives', async () => {
  const f = fixture({ killBehavior: () => { throw new Error('kill error'); } });
  f.child.emit('error', Object.assign(new Error('spawn error'), { code: 'EACCES' }));
  f.clock.advance(SSH_CLEANUP_TIMEOUT_MS);
  const result = await f.promise;
  assert.match(result.failure, /EACCES/);
  assert.equal(result.killError, 'kill error');
  assert.equal(result.exitCode, null);
  assert.equal(result.remoteOutcomeUnknown, true);
});

test('stdin error is handled before synchronous end callback can emit it', async () => {
  const f = fixture({ endBehavior: child => child.stdin.emit('error', new Error('EPIPE')) });
  f.clock.advance(SSH_CLEANUP_TIMEOUT_MS);
  const result = await f.promise;
  assert.match(result.failure, /stdin error/);
  assert.equal(result.killAttempted, true);
  assert.equal(result.sshCloseConfirmed, false);
});

test('synchronous stdin end throw is captured instead of rejecting/crashing', async () => {
  const f = fixture({ endBehavior: () => { throw new Error('write threw'); } });
  f.clock.advance(SSH_CLEANUP_TIMEOUT_MS);
  const result = await f.promise;
  assert.match(result.failure, /stdin write failed: write threw/);
  assert.equal(result.remoteOutcomeUnknown, true);
});

test('synchronous spawn throw returns a failure without a child, timer or retry', async () => {
  const clock = new FakeClock();
  let calls = 0;
  const result = await captureOwnedSsh(Buffer.from('fixture'), [], {
    timers: clock,
    spawnChild: () => { calls++; throw Object.assign(new Error('missing ssh'), { code: 'ENOENT' }); },
  });
  assert.match(result.failure, /spawn failure: ENOENT/);
  assert.equal(result.localSshPid, null);
  assert.equal(result.killAttempted, false);
  assert.equal(result.sshCloseConfirmed, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.remoteOutcomeUnknown, true);
  assert.equal(clock.pending.size, 0);
  assert.equal(calls, 1);
});

for (const stream of ['stdout', 'stderr']) {
  test(`${stream} stream error starts only one cleanup`, async () => {
    const f = fixture();
    f.child[stream].emit('error', new Error('stream broke'));
    f.child.emit('error', new Error('second error'));
    f.clock.advance(SSH_CLEANUP_TIMEOUT_MS);
    const result = await f.promise;
    assert.match(result.failure, new RegExp(`${stream} error`));
    assert.equal(f.child.killCalls, 1);
    assert.equal(result.exitCode, null);
  });
}

test('non-JSON, nonzero or signal close cannot become a passing receipt', async () => {
  for (const [text, code, signal] of [['not-json', 0, null], ['{}', 255, null], ['{}', null, 'SIGTERM'], ['{}', 0, 'SIGTERM']]) {
    const f = fixture();
    f.child.stdout.emit('data', Buffer.from(text));
    f.child.emit('close', code, signal);
    const result = await f.promise;
    assert.ok(result.failure);
    assert.equal(result.sshCloseConfirmed, true);
    assert.equal(result.remoteOutcomeUnknown, true);
    assert.equal(f.child.killCalls, 0);
  }
});

test('synchronous close caused by owned kill cancels cleanup without a second kill', async () => {
  const f = fixture({ killBehavior: child => { child.emit('close', null, 'SIGTERM'); return true; } });
  outputJson(f.child);
  f.clock.advance(f.timeoutMs);
  const result = await f.promise;
  assert.equal(result.sshCloseConfirmed, true);
  assert.equal(result.remoteOutcomeUnknown, true);
  assert.equal(result.cleanupDeadlineExceeded, false);
  assert.equal(result.killReturn, true);
  assert.equal(f.child.killCalls, 1);
  assert.equal(f.clock.pending.size, 0);
});

test('invalid budgets/payloads are rejected before spawn', async () => {
  let calls = 0;
  const spawnChild = () => { calls++; throw new Error('must not spawn'); };
  for (const timeoutMs of [0, -1, Infinity, 1.2, 600001]) {
    await assert.rejects(captureOwnedSsh(Buffer.from('fixture'), [], { timeoutMs, spawnChild }), /deadline/);
  }
  await assert.rejects(captureOwnedSsh('not-buffer', [], { spawnChild }), /buffer/);
  await assert.rejects(captureOwnedSsh(Buffer.alloc(1024 * 1024 + 1), [], { spawnChild }), /buffer/);
  assert.equal(calls, 0);
});
