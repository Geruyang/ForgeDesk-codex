import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { installConsolePipeGuard, isBrokenStandardPipe } from '../apps/desktop/main/console-pipe-guard';
import { desktopHarness } from './helpers/desktop-harness';

const broken = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });
function fixture(body: (this: unknown, ...args: unknown[]) => unknown) {
  const stdout = new EventEmitter(), stderr = new EventEmitter();
  const console = { log: body, info: body, debug: body, warn: body, error: body };
  const reports: string[] = [];
  const dispose = installConsolePipeGuard({ console, stdout, stderr, onPipeClosed: stream => { reports.push(stream); } });
  return { console, stdout, stderr, reports, dispose };
}
test('only exact EPIPE/write is a broken standard output pipe', () => {
  assert.equal(isBrokenStandardPipe(broken()), true);
  for (const value of [null, 'EPIPE', new Error('EPIPE'), { code: 'EPIPE' }, { code: 'EPIPE', syscall: 'read' }, { code: 'EIO', syscall: 'write' }]) assert.equal(isBrokenStandardPipe(value), false);
});
test('console wrappers preserve this, arguments and result without changing business state', () => {
  const receiver = { sentinel: true }, args = [new Error('device outcome unknown'), { operation: 'unchanged' }], returned = {};
  let seen: unknown;
  const f = fixture(function (...values) { seen = { receiver: this, values }; return returned; });
  try { assert.equal(f.console.error.call(receiver, ...args), returned); assert.deepEqual(seen, { receiver, values: args }); assert.deepEqual(f.reports, []); }
  finally { f.dispose(); }
});
test('sync console and asynchronous stdio EPIPE are contained and reported once per stream', () => {
  const f = fixture(() => { throw broken(); });
  try {
    f.console.error('Electron replyWithError'); f.console.warn('again'); f.console.log('stdout'); f.console.debug('again');
    f.stderr.emit('error', broken()); f.stdout.emit('error', broken());
    assert.deepEqual(f.reports, ['stderr', 'stdout']);
  } finally { f.dispose(); }
});
test('later asynchronous standard-pipe errors stay contained without a global exception handler', async () => {
  const f = fixture(() => undefined);
  try {
    await new Promise<void>((resolve, reject) => { queueMicrotask(() => {
      try { f.stdout.emit('error', broken()); f.stderr.emit('error', broken()); resolve(); } catch (error) { reject(error); }
    }); });
    assert.deepEqual(f.reports, ['stdout', 'stderr']);
    const other = Object.assign(new Error('async non-pipe failure'), { code: 'EIO', syscall: 'write' });
    await assert.rejects(new Promise<void>((resolve, reject) => { queueMicrotask(() => {
      try { f.stdout.emit('error', other); resolve(); } catch (error) { reject(error); }
    }); }), value => value === other);
  } finally { f.dispose(); }
});
test('non-EPIPE failures and non-write EPIPE propagate exactly, even after a pipe was reported', () => {
  const expected = new Error('real device or formatter failure'); let failure: unknown = broken();
  const f = fixture(() => { throw failure; });
  try {
    f.console.error('pipe failure'); failure = expected;
    assert.throws(() => f.console.error('not swallowed'), value => value === expected);
    for (const other of [Object.assign(new Error('read'), { code: 'EPIPE', syscall: 'read' }), Object.assign(new Error('write'), { code: 'EIO', syscall: 'write' })]) {
      failure = other; assert.throws(() => f.console.log('not swallowed'), value => value === other);
      assert.throws(() => f.stdout.emit('error', other), value => value === other);
    }
  } finally { f.dispose(); }
});
test('diagnostic errors are not swallowed and disposal never overwrites a later console replacement', () => {
  const stdout = new EventEmitter(), stderr = new EventEmitter(), diagnosticError = new Error('diagnostic failed');
  const original = (): void => { throw broken(); }; const console = { log: original, info: original, debug: original, warn: original, error: original };
  const dispose = installConsolePipeGuard({ console, stdout, stderr, onPipeClosed: () => { throw diagnosticError; } });
  assert.throws(() => console.error(), value => value === diagnosticError);
  const replacement = () => undefined; console.error = replacement; dispose();
  assert.equal(console.error, replacement); assert.equal(console.log, original); assert.equal(stdout.listenerCount('error'), 0); assert.equal(stderr.listenerCount('error'), 0);
});
test('production main installs guards in a VM without changing the test runner console or streams', async () => {
  const log = console.log, error = console.error, stdoutListeners = process.stdout.listenerCount('error'), stderrListeners = process.stderr.listenerCount('error');
  const h = await desktopHarness();
  try {
    assert.equal(console.log, log); assert.equal(console.error, error);
    assert.equal(process.stdout.listenerCount('error'), stdoutListeners); assert.equal(process.stderr.listenerCount('error'), stderrListeners);
    h.standardStreams.stderr.emit('error', broken()); h.standardStreams.stderr.emit('error', broken());
    const state = await h.snapshot(); assert.equal(state.diagnostics.filter(line => line.includes('(stderr)')).length, 1);
    const other = new Error('not a pipe failure'); assert.throws(() => h.standardStreams.stderr.emit('error', other), value => value === other);
    const unrelated = new EventEmitter(); assert.throws(() => unrelated.emit('error', broken()), /EPIPE/);
  } finally { await h.cleanup(); }
});
