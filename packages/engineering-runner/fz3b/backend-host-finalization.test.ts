import assert from 'node:assert/strict';
import { link, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Fz3bBackend, assertFz3bHostCompletionRead, consumeFz3bHostCompletionRead } from './backend.js';
import { backendPreflightFixture } from './preflight-recovery.fixture.js';
import { fz3bDigest } from './profile.js';
import { assertFz3bPreflightHostCompletionBinding } from './host-finalization.js';
import { fz3bHostProductionFixture } from '../../../tests/helpers/fz3b-host-production-fixture.js';

async function actualFixture() {
  const fixture = await fz3bHostProductionFixture();
  return { ...fixture, cleanup: async () => {
    const base = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/host-finalization/production-fixtures');
    const relative = path.relative(base, fixture.home);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(fixture.home, { recursive: true, force: true });
  } };
}

test('readonly host binding authenticates raw checkpoint and full worker chain, stable across restart without writes or replay', async () => {
  const f = await backendPreflightFixture();
  try {
    await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    const file = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`), before = await readFile(file);
    const view = await f.backend.status(f.run.runId); f.calls.length = 0;
    const binding = await f.backend.readPreflightHostCompletion(f.run.runId);
    assertFz3bPreflightHostCompletionBinding(binding);
    assert.equal(binding.checkpointEnvelopeSha256, fz3bDigest(before));
    assert.equal(binding.originalUnknownPreserved, true); assert.equal(binding.remoteQuiescence, 'not-established');
    assert.equal(binding.newBootIdentity, 'not-observed-or-adopted');
    assert.deepEqual(f.calls, ['runtime', 'read-completion', 'runtime']);
    const fresh = new Fz3bBackend(f.options);
    assert.deepEqual(await fresh.readPreflightHostCompletion(f.run.runId), binding);
    assert.deepEqual(await readFile(file), before); assert.deepEqual(await f.backend.status(f.run.runId), view);
  } finally { await f.cleanup(); }
});

test('no completed chain means readonly binding cannot invoke native, prepare, finalize, acknowledge or signing', async () => {
  const f = await backendPreflightFixture();
  try {
    const file = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`), before = await readFile(file); f.calls.length = 0;
    await assert.rejects(f.backend.readPreflightHostCompletion(f.run.runId), /authenticated preflight completion/);
    assert.deepEqual(f.calls, []); assert.deepEqual(await readFile(file), before);
  } finally { await f.cleanup(); }
});

test('fresh worker read failure invalidates positive cache, leaves ledger exact and allows only later readonly retry', async () => {
  const f = await backendPreflightFixture();
  try {
    await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    const file = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`), before = await readFile(file);
    const binding = await f.backend.readPreflightHostCompletion(f.run.runId); f.calls.length = 0;
    f.state.lease = true;
    await assert.rejects(f.backend.readPreflightHostCompletion(f.run.runId), /completion absent/);
    assert.equal((await f.backend.status(f.run.runId))!.hardwareBusy, true);
    assert.deepEqual(await readFile(file), before);
    f.state.lease = false;
    assert.deepEqual(await f.backend.readPreflightHostCompletion(f.run.runId), binding);
    assert.equal(f.calls.some(call => ['native', 'prepare', 'finalize', 'ack', 'certify'].includes(call)), false);
  } finally { await f.cleanup(); }
});

test('visible unauthenticated, noncanonical, oversized and multilink checkpoints cannot be used as host evidence', async () => {
  const f = await backendPreflightFixture();
  try {
    await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    const file = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`), before = await readFile(file);
    const extra = path.join(f.directory, 'checkpoint-hardlink');
    for (const fault of ['mac', 'payload', 'extra', 'newline', 'oversize', 'hardlink']) {
      if (fault === 'hardlink') await link(file, extra);
      else if (fault === 'newline') await writeFile(file, Buffer.concat([before, Buffer.from('\n')]));
      else if (fault === 'oversize') await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
      else {
        const value = JSON.parse(before.toString());
        if (fault === 'mac') value.mac = '0'.repeat(64);
        else if (fault === 'payload') value.payload.failure = 'Changed';
        else value.extra = true;
        await writeFile(file, JSON.stringify(value, null, 2));
      }
      await assert.rejects(f.backend.readPreflightHostCompletion(f.run.runId));
      if (fault === 'hardlink') await unlink(extra); else await writeFile(file, before);
    }
    assert.equal((await f.backend.readPreflightHostCompletion(f.run.runId)).originalUnknownPreserved, true);
  } finally { await f.cleanup(); }
});

test('checkpoint mutation while worker verification awaits is rejected and never signed or saved', async () => {
  const f = await backendPreflightFixture();
  try {
    await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    const file = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`), before = await readFile(file);
    const read = f.options.adapter.readPreflightRefusalRecoveryCompletion!;
    f.options.adapter.readPreflightRefusalRecoveryCompletion = async (...args) => { const result = await read(...args); await writeFile(file, Buffer.concat([before, Buffer.from('\n')])); return result; };
    f.calls.length = 0;
    await assert.rejects(f.backend.readPreflightHostCompletion(f.run.runId), /checkpoint envelope changed/);
    assert.deepEqual(await readFile(file), Buffer.concat([before, Buffer.from('\n')]));
    assert.equal(f.calls.some(call => ['native', 'prepare', 'finalize', 'ack', 'certify'].includes(call)), false);
  } finally { await f.cleanup(); }
});

test('another unknown or active owner blocks readonly host qualification', async () => {
  const f = await backendPreflightFixture();
  try {
    await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    const other = structuredClone(f.record); other.runId = 'foreign-run';
    f.internal.records.set(other.runId, other); f.calls.length = 0;
    await assert.rejects(f.backend.readPreflightHostCompletion(f.run.runId), /not locally settled/);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test('actual production read has nonserializable instance/root provenance and one-shot mint consumption', async () => {
  const f = await actualFixture();
  try {
    const before = await readFile(f.ledgerPath), binding = await f.backend.readPreflightHostCompletion(f.owner.runId);
    assertFz3bHostCompletionRead(binding, f.backend, f.home);
    assert.throws(() => assertFz3bHostCompletionRead(structuredClone(binding), f.backend, f.home), /READ_REQUIRED/);
    assert.throws(() => assertFz3bHostCompletionRead(binding, Object.create(Fz3bBackend.prototype), f.home), /READ_REQUIRED/);
    const foreign = path.join(f.home, 'foreign-store'); await mkdir(foreign);
    assert.throws(() => assertFz3bHostCompletionRead(binding, f.backend, foreign), /READ_REQUIRED/);
    consumeFz3bHostCompletionRead(binding, f.backend, f.home);
    assertFz3bHostCompletionRead(binding, f.backend, f.home);
    assert.throws(() => consumeFz3bHostCompletionRead(binding, f.backend, f.home), /ALREADY_CONSUMED/);
    const next = await f.backend.readPreflightHostCompletion(f.owner.runId);
    assert.throws(() => assertFz3bHostCompletionRead(binding, f.backend, f.home), /READ_CHANGED/);
    assertFz3bHostCompletionRead(next, f.backend, f.home);
    let getterRan = false;
    Object.defineProperty(next, 'purpose', { enumerable: true, get() { getterRan = true; return 'exact-local-preflight-host-finish-only'; } });
    assert.throws(() => assertFz3bHostCompletionRead(next, f.backend, f.home), /JSON_DESCRIPTOR/); assert.equal(getterRan, false);
    assert.deepEqual(await readFile(f.ledgerPath), before); assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
  } finally { await f.cleanup(); }
});

test('generic adapter binding cannot acquire an authenticated host read ticket by cloning or recomputing hashes', async () => {
  const f = await backendPreflightFixture();
  try {
    await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    const binding = await f.backend.readPreflightHostCompletion(f.run.runId);
    assertFz3bPreflightHostCompletionBinding(binding);
    assert.throws(() => assertFz3bHostCompletionRead(binding, f.backend, f.directory), /READ_REQUIRED/);
    assert.throws(() => consumeFz3bHostCompletionRead(binding, f.backend, f.directory), /READ_REQUIRED/);
  } finally { await f.cleanup(); }
});

test('sync source witnesses reject modified original bytes, actual lease, current children and changed HMAC after final await', async () => {
  const f = await actualFixture();
  try {
    const original = path.join(f.workerRoot, f.owner.operations[1].id, 'evidence.json'), raw = await readFile(original);
    const binding = await f.backend.readPreflightHostCompletion(f.owner.runId);
    await writeFile(original, Buffer.concat([raw, Buffer.from('\n')]));
    assert.throws(() => consumeFz3bHostCompletionRead(binding, f.backend, f.home), /WITNESS_CHANGED/);
    await writeFile(original, raw);
    const fresh = await f.backend.readPreflightHostCompletion(f.owner.runId);
    const children = (f.adapter as unknown as { children: Set<unknown> }).children, child = {};
    children.add(child); assert.throws(() => assertFz3bHostCompletionRead(fresh, f.backend, f.home), /WITNESS_CHANGED/); children.delete(child);
    const lease = path.join(f.workerRoot, 'active.lock'); await writeFile(lease, 'foreign', { flag: 'wx' });
    assert.throws(() => assertFz3bHostCompletionRead(fresh, f.backend, f.home), /WITNESS_PATH_PRESENT/); await unlink(lease);
    const ledger = await readFile(f.ledgerPath); await writeFile(f.ledgerPath, Buffer.concat([ledger, Buffer.from('\n')]));
    assert.throws(() => consumeFz3bHostCompletionRead(fresh, f.backend, f.home), /READ_CHECKPOINT_CHANGED/);
    assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
  } finally { await f.cleanup(); }
});

test('runtime ticket uses a monotonic bounded age rather than caller timestamps', async t => {
  const f = await actualFixture();
  try {
    const binding = await f.backend.readPreflightHostCompletion(f.owner.runId), original = process.hrtime.bigint;
    const clock = t.mock.method(process.hrtime, 'bigint', () => original() + 31000000000n);
    assert.throws(() => consumeFz3bHostCompletionRead(binding, f.backend, f.home), /READ_REQUIRED/); clock.mock.restore();
    assert.equal(f.state.forbidden, 0);
  } finally { await f.cleanup(); }
});
