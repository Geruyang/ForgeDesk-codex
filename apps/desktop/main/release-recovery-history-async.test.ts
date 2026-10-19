import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createStartupHistoryAsyncReader, type StartupHistoryChild } from './release-recovery-history-async.js';
import { startupHistoryWorkerFrame, STARTUP_HISTORY_OUTPUT_LIMIT } from './release-recovery-history-worker.js';
import { readReleaseRecoveryHistory } from './release-recovery-history.js';
import { loadReadonlyHistory } from '../../../packages/engineering-runner/fz3b/history-readonly.js';

function fixture() {
  const events = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough();
  let frame: Buffer = Buffer.alloc(0), launches = 0, kills = 0;
  const timers = new Map<number, () => void>();
  const child: StartupHistoryChild = { once: ((name: string, callback: (...args: any[]) => void) => events.once(name, callback)) as StartupHistoryChild['once'],
    stdout, stderr, stdin: { on() {}, end(bytes) { frame = bytes; } }, kill() { kills++; return true; } };
  const reader = createStartupHistoryAsyncReader(process.cwd(), false, () => { launches++; return child; }, (callback, ms) => {
    assert(!timers.has(ms)); timers.set(ms, callback); return () => { timers.delete(ms); };
  });
  return { events, stdout, stderr, reader, frame: () => frame, launches: () => launches, kills: () => kills,
    tick(ms: number) { const callback = timers.get(ms); assert(callback); timers.delete(ms); callback(); },
    async response() {
      return startupHistoryWorkerFrame(frame, async () => readReleaseRecoveryHistory({ async readExistingHistory() {
        return { ...loadReadonlyHistory([], Buffer.alloc(32)), observerKind: 'backend-existing-history-readonly', acquisition: {
          method: 'backend-existing-history-readonly-v1', jsonCensusStableAcrossRead: true, completeOperationalQuarantine: false, reservedReadBytes: 66 } };
      } }));
    } };
}
test('async reader returns before child work, uses one no-argument read, and accepts only normal close', async () => {
  const f = fixture(), pending = f.reader.read(); assert.equal(f.reader.read(), pending); assert.equal(f.launches(), 1);
  let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  f.events.emit('spawn'); f.stdout.write(await f.response()); await Promise.resolve(); assert.equal(settled, false);
  f.events.emit('close', 0, null); const result = await pending;
  assert.equal(result.status, 'observed'); assert.equal(result.closeConfirmed, true);
  assert.equal(result.projection!.admissionAuthorized, false); assert.equal(f.kills(), 0);
  assert.equal(result.projection!.observationPhase, 'post-startup-reconciliation');
});
test('deadline requests owned termination but waits for actual close and never treats kill true as stopped', async () => {
  const f = fixture(), pending = f.reader.read(); f.events.emit('spawn'); f.tick(20000);
  assert.equal(f.kills(), 1); let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  f.tick(5000); const result = await pending;
  assert.equal(result.status, 'unknown'); assert.equal(result.closeConfirmed, false); assert.equal(result.projection, null);
  f.events.emit('close', 0, null); assert.equal(await f.reader.read(), result); assert.equal(f.launches(), 1);
});
test('close after deadline is a confirmed held result, never a successful observation', async () => {
  const f = fixture(), pending = f.reader.read(); f.events.emit('spawn'); f.tick(20000);
  f.stdout.write(await f.response()); f.events.emit('close', 0, null);
  const result = await pending; assert.equal(result.status, 'held'); assert.equal(result.closeConfirmed, true); assert.equal(result.projection, null);
});
test('stderr and oversized stdout request termination and discard all projection authority', async () => {
  for (const fault of ['stderr', 'overflow', 'stdout-error', 'stderr-error']) {
    const f = fixture(), pending = f.reader.read(); f.events.emit('spawn');
    if (fault === 'stderr') f.stderr.write('private path must not appear in result');
    else if (fault === 'stdout-error' || fault === 'stderr-error')
      assert.doesNotThrow(() => (fault === 'stdout-error' ? f.stdout : f.stderr).emit('error', Error('private stream error')));
    else f.stdout.write(Buffer.alloc(STARTUP_HISTORY_OUTPUT_LIMIT + 1));
    assert.equal(f.kills(), 1); let settled = false; void pending.then(() => { settled = true; });
    await Promise.resolve(); assert.equal(settled, false);
    f.events.emit('close', 0, null); const result = await pending;
    assert.equal(result.status, 'held'); assert.equal(result.projection, null); assert(!JSON.stringify(result).includes('private path'));
  }
});
test('wrong nonce, foreign schema, claimed authority, abnormal exit and missing spawn all refuse', async () => {
  for (const fault of ['nonce', 'schema', 'authority', 'exit', 'spawn', 'phase', 'missing-phase']) {
    const f = fixture(), pending = f.reader.read(); if (fault !== 'spawn') f.events.emit('spawn');
    const response = JSON.parse((await f.response()).toString());
    if (fault === 'nonce') response.nonce = 'f'.repeat(64);
    if (fault === 'schema') response.extra = true;
    if (fault === 'authority') response.projection.releaseAuthorized = true;
    if (fault === 'phase') response.projection.observationPhase = 'pre-startup-immutable-raw';
    if (fault === 'missing-phase') delete response.projection.observationPhase;
    f.stdout.write(JSON.stringify(response) + '\n'); f.events.emit('close', fault === 'exit' ? 2 : 0, null);
    assert.equal((await pending).status, 'held');
  }
});
test('worker refuses malformed root/extra parameters before calling any acquisition port', async () => {
  let reads = 0;
  for (const change of [{ dataDir: 'relative' }, { packaged: 'true' }, { release: true }, { nonce: [] }]) {
    const request = { schemaVersion: 1, kind: 'startup-history-existing-read', nonce: 'a'.repeat(64), dataDir: process.cwd(), packaged: false, ...change };
    await assert.rejects(startupHistoryWorkerFrame(Buffer.from(JSON.stringify(request) + '\n'), async () => { reads++; throw Error(); }));
  }
  assert.equal(reads, 0);
});
test('worker has bounded stdin/output and passes only captured main root and packaged mode to the child acquisition', async () => {
  const f = fixture(); f.reader.read(); let calls = 0;
  const expected = JSON.parse(f.frame().toString());
  const body = await startupHistoryWorkerFrame(f.frame(), async (root, packaged) => {
    calls++; assert.equal(root, process.cwd()); assert.equal(packaged, false); return JSON.parse((await f.response()).toString()).projection;
  });
  assert.equal(calls, 1); assert.equal(JSON.parse(body.toString()).nonce, expected.nonce);
  await assert.rejects(startupHistoryWorkerFrame(Buffer.alloc(8193), async () => { throw Error('Must not read'); }));
  await assert.rejects(startupHistoryWorkerFrame(f.frame(), async () => ({ payload: 'x'.repeat(STARTUP_HISTORY_OUTPUT_LIMIT) }) as any));
  f.events.emit('close', 2, null);
});
