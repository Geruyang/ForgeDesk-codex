import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FixedStm32HardwareService, parseFixedWorkerProgress } from './real-stm32.js';
import { GESTURESCREEN_PROFILE } from '../embedded/profile.js';

const operationId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
async function fixtureRoot(prefix: string) {
  const root = path.resolve('.runner-tests/embedded-progress');
  await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, prefix));
}
const progress = (extra: Record<string, unknown> = {}) => JSON.stringify({ schemaVersion: 1,
  operationId, action: 'flash', stage: 'erase_program', sequence: 3, updatedAt: '2026-10-15T00:00:00Z', ...extra });

test('progress supports unknown stages of work without inventing a percentage', () => {
  const value = parseFixedWorkerProgress(progress({ stage: 'connecting' }), 'flash', operationId);
  assert.equal(value.stage, 'connecting');
  assert.equal(value.completed, undefined);
  assert.equal(value.total, undefined);
  assert.equal(value.unit, undefined);
});

test('progress keeps actual stage byte counts or pyOCD fractions and drops outcome claims', () => {
  const fraction = parseFixedWorkerProgress(progress({ completed: 0.375, total: 1, unit: 'fraction', status: 'succeeded', overallPercent: 100 }), 'flash', operationId);
  assert.equal(fraction.completed, 0.375);
  assert.equal(fraction.total, 1);
  assert.equal('status' in fraction, false);
  assert.equal('overallPercent' in fraction, false);
  const bytes = parseFixedWorkerProgress(progress({ stage: 'readback', completed: 4096, total: 1048576, unit: 'bytes' }), 'flash', operationId);
  assert.equal(bytes.completed, 4096);
  assert.equal(bytes.total, 1048576);
});

test('progress parser rejects wrong identity, unknown phases, invalid timestamps and counts', () => {
  for (const extra of [
    { operationId: randomUUID() }, { action: 'inspect' }, { stage: 'everything_succeeded' },
    { updatedAt: 'yesterday' }, { sequence: -1 }, { sequence: 0.5 },
    { completed: 1 }, { total: 1 }, { unit: 'fraction' },
    { completed: -0.1, total: 1, unit: 'fraction' }, { completed: 1.1, total: 1, unit: 'fraction' },
    { completed: 1, total: 2, unit: 'fraction' }, { completed: 1, total: 0, unit: 'bytes' },
    { completed: 0.5, total: 2, unit: 'bytes' }, { completed: 1, total: 2.5, unit: 'steps' },
    { completed: null, total: 1, unit: 'fraction' }, { completed: 1, total: 2, unit: 'percent' },
    { message: 'x'.repeat(241) },
  ]) assert.throws(() => parseFixedWorkerProgress(progress(extra), 'flash', operationId), /progress/);
  assert.throws(() => parseFixedWorkerProgress(' '.repeat(4097), 'flash', operationId), /bounds/);
});

test('reading durable progress never launches a worker and ignores missing or malformed telemetry', async () => {
  const root = await fixtureRoot('progress-');
  try {
    const adapter = new FixedStm32HardwareService({ processHost: process.execPath, pythonExecutable: process.execPath,
      workerScript: path.join(root, 'must-not-execute.py') });
    assert.equal(await adapter.readProgress('flash', operationId, root), undefined);
    await writeFile(path.join(root, 'progress.json'), progress({ completed: 1, total: 1, unit: 'fraction' }));
    assert.equal((await adapter.readProgress('flash', operationId, root))!.completed, 1);
    assert.equal(await adapter.readProgress('verify', operationId, root), undefined);
    await writeFile(path.join(root, 'progress.json'), '{partial');
    assert.equal(await adapter.readProgress('flash', operationId, root), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('durable progress cannot be read through a linked operation parent', async () => {
  const root = await fixtureRoot('link-');
  try {
    const real = path.join(root, 'operation'); await mkdir(real);
    await writeFile(path.join(real, 'progress.json'), progress());
    const linked = path.join(root, 'linked-operation');
    await symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const adapter = new FixedStm32HardwareService({ processHost: process.execPath, pythonExecutable: process.execPath,
      workerScript: path.join(root, 'must-not-execute.py') });
    assert.equal(await adapter.readProgress('flash', operationId, linked), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker input persistence failure is known pre-spawn failure rather than unknown hardware', async () => {
  const root = await fixtureRoot('input-');
  try {
    await writeFile(path.join(root, 'worker-input.json'), 'existing protected input');
    const adapter = new FixedStm32HardwareService({ processHost: process.execPath, pythonExecutable: process.execPath,
      workerScript: path.join(root, 'must-not-execute.py') });
    let spawned = 0;
    (adapter as unknown as { spawnWorker: () => never }).spawnWorker = () => { spawned++; throw new Error('must not spawn'); };
    const result = await adapter.inspect({ taskId: 'fixture', operationId, operationDir: root, nonce: 'fixture', profile: GESTURESCREEN_PROFILE });
    assert.equal(result.status, 'failed'); assert.equal(result.processExited, true);
    assert.match(result.detail!, /no process was started/); assert.equal(spawned, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('input write, flush and close failures never dispatch a hardware process', async () => {
  for (const stage of ['write', 'sync', 'close']) {
    const root = await fixtureRoot(`${stage}-`);
    try {
      const adapter = new FixedStm32HardwareService({ processHost: process.execPath, pythonExecutable: process.execPath,
        workerScript: path.join(root, 'must-not-execute.py') });
      let spawned = 0; let closed = 0;
      const internal = adapter as unknown as { spawnWorker: () => never; openInput: () => Promise<unknown> };
      internal.spawnWorker = () => { spawned++; throw new Error('must not spawn'); };
      internal.openInput = async () => ({
        async writeFile() { if (stage === 'write') throw new Error('input write denied'); },
        async sync() { if (stage === 'sync') throw new Error('input flush denied'); },
        async close() { closed++; if (stage === 'close') throw new Error('input close denied'); },
      });
      const result = await adapter.inspect({ taskId: 'fixture', operationId, operationDir: root, nonce: 'fixture', profile: GESTURESCREEN_PROFILE });
      assert.equal(result.status, 'failed'); assert.equal(result.processExited, true);
      assert.match(result.detail!, /no process was started/); assert.equal(spawned, 0); assert.equal(closed, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
