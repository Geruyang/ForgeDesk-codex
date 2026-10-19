import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeDialogArbiter, NativeDialogCancelledError, type NativeDialogClock } from '../apps/desktop/main/native-dialogs';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
function clock() {
  let now = 1000; const timers = new Map<() => void, number>();
  const value: NativeDialogClock = { now: () => now, schedule(callback, delay) { timers.set(callback, now + delay); return () => { timers.delete(callback); }; } };
  return { value, advance(amount: number) { now += amount; for (const [callback, deadline] of [...timers]) if (deadline <= now) { timers.delete(callback); callback(); } }, get timers() { return timers.size; } };
}

test('one slot serializes notice approval and picker bodies and returns only their actual responses', async () => {
  const a = new NativeDialogArbiter(), first = deferred<object>(), calls: string[] = [];
  const response = { response: 0, checkboxChecked: false };
  const one = a.run({ kind: 'notice' }, async () => { calls.push('notice'); return first.promise; });
  const two = a.run({ kind: 'approval' }, async () => { calls.push('approval'); return response; });
  const three = a.run({ kind: 'picker' }, async () => { calls.push('picker'); return { canceled: true }; });
  assert.equal(a.busy, true); assert.equal(a.approvalPending, true);
  await flush(); assert.deepEqual(calls, ['notice']);
  const nativeAnswer = { exact: 'native-result' }; first.resolve(nativeAnswer);
  assert.equal(await one, nativeAnswer); assert.equal(await two, response); assert.deepEqual(await three, { canceled: true });
  assert.deepEqual(calls, ['notice', 'approval', 'picker']); assert.equal(a.busy, false); assert.equal(a.approvalPending, false);
});

test('abort while queued removes the entry without running it or manufacturing a native answer', async () => {
  const a = new NativeDialogArbiter(), gate = deferred<void>(), abort = new AbortController(); let calls = 0;
  const first = a.run({ kind: 'notice' }, () => gate.promise);
  const queued = a.run({ kind: 'approval', signal: abort.signal }, async () => { ++calls; return { response: 1 }; });
  const denied = assert.rejects(queued, error => error instanceof NativeDialogCancelledError && error.reason === 'aborted');
  abort.abort(); await denied; assert.equal(a.approvalPending, false);
  gate.resolve(); await first; assert.equal(calls, 0); assert.equal(a.busy, false);
});

test('queued expiration uses the original absolute deadline without extending it', async () => {
  const c = clock(), a = new NativeDialogArbiter(c.value), gate = deferred<void>(); let calls = 0;
  const first = a.run({ kind: 'notice' }, () => gate.promise);
  const queued = a.run({ kind: 'approval', deadline: 1100 }, async () => { ++calls; return true; });
  const expired = assert.rejects(queued, error => error instanceof NativeDialogCancelledError && error.reason === 'expired');
  c.advance(100); await expired; assert.equal(calls, 0); assert.equal(c.timers, 0);
  gate.resolve(); await first; assert.equal(a.busy, false);
});

test('owner checks run after slot acquisition so a revoked owner cannot show an authorization', async () => {
  const a = new NativeDialogArbiter(), gate = deferred<void>(); let owner = true, shown = 0;
  const first = a.run({ kind: 'picker' }, () => gate.promise);
  const queued = a.run({ kind: 'approval' }, async () => { if (!owner) throw new Error('Owner revoked'); ++shown; return true; });
  const denied = assert.rejects(queued, /Owner revoked/); owner = false; gate.resolve(); await first; await denied;
  assert.equal(shown, 0); assert.equal(a.busy, false);
});

test('a queue wait consuming most of the grant lifetime leaves only the original remaining time', async () => {
  const c = clock(), a = new NativeDialogArbiter(c.value), warning = deferred<void>(), native = deferred<object>(); let remaining = 0;
  const first = a.run({ kind: 'notice' }, () => warning.promise);
  const approval = a.run({ kind: 'approval', deadline: 1100 }, async () => { remaining = 1100 - c.value.now(); return native.promise; });
  const expired = assert.rejects(approval, error => error instanceof NativeDialogCancelledError && error.reason === 'expired');
  c.advance(90); warning.resolve(); await first; await flush(); assert.equal(remaining, 10);
  c.advance(11); native.resolve({ response: 1, checkboxChecked: true }); await expired;
  assert.equal(a.busy, false);
});

test('active abort does not release the slot until its actual native promise settles', async () => {
  const a = new NativeDialogArbiter(), gate = deferred<object>(), abort = new AbortController(); let next = 0, settled = false;
  const active = a.run({ kind: 'approval', signal: abort.signal }, () => gate.promise);
  const rejected = assert.rejects(active, NativeDialogCancelledError).then(() => { settled = true; });
  await flush(); abort.abort();
  const follower = a.run({ kind: 'notice' }, async () => { ++next; });
  await flush(); assert.equal(settled, false); assert.equal(next, 0); assert.equal(a.approvalPending, true);
  gate.resolve({ response: 1, checkboxChecked: true }); await rejected; await follower;
  assert.equal(next, 1); assert.equal(a.busy, false);
});

test('active expiry never frees a still-pending native promise or accepts its late affirmative response', async () => {
  const c = clock(), a = new NativeDialogArbiter(c.value), gate = deferred<object>(); let next = 0;
  const active = a.run({ kind: 'approval', deadline: 1100 }, () => gate.promise);
  const expired = assert.rejects(active, error => error instanceof NativeDialogCancelledError && error.reason === 'expired');
  await flush(); c.advance(100);
  const follower = a.run({ kind: 'notice' }, async () => { ++next; });
  await flush(); assert.equal(next, 0); assert.equal(a.busy, true);
  gate.resolve({ response: 1, checkboxChecked: true }); await expired; await follower; assert.equal(next, 1);
});

test('native rejection releases the settled slot and preserves its original error', async () => {
  const a = new NativeDialogArbiter(), gate = deferred<void>(), error = new Error('Native failed'); let next = 0;
  const first = a.run({ kind: 'notice' }, () => gate.promise);
  const rejected = assert.rejects(first, value => value === error);
  const second = a.run({ kind: 'picker' }, async () => { ++next; return { canceled: true }; });
  gate.reject(error); await rejected; await second; assert.equal(next, 1); assert.equal(a.busy, false);
});

test('close rejects queued and future requests but does not pretend an active native promise closed', async () => {
  const a = new NativeDialogArbiter(), gate = deferred<void>(); let queuedShows = 0;
  const first = a.run({ kind: 'notice' }, () => gate.promise); await flush();
  const firstRejected = assert.rejects(first, error => error instanceof NativeDialogCancelledError && error.reason === 'closed');
  const second = a.run({ kind: 'approval' }, async () => { ++queuedShows; });
  const rejected = assert.rejects(second, error => error instanceof NativeDialogCancelledError && error.reason === 'closed');
  a.close(); await rejected; assert.equal(a.busy, true);
  await assert.rejects(a.run({ kind: 'picker' }, async () => {}), NativeDialogCancelledError);
  gate.resolve(); await firstRejected; assert.equal(a.busy, false); assert.equal(queuedShows, 0);
});
