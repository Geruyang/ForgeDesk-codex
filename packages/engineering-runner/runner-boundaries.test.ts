import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineeringRunner } from './index.js';
import { SNAPSHOT_ACCEPTANCE_ID } from './snapshots.js';
import type { CommandSpec, Operation } from './types.js';

const output = fileURLToPath(new URL('../../output/software-audit-20261019/runner/', import.meta.url));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture() {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, 'case-'));
  const project = path.join(directory, 'project'), data = path.join(directory, 'data');
  await mkdir(project);
  const input = { id: 'task', projectRoot: project, sessionId: 'session', title: 'Boundary fixture' };
  const runner = new EngineeringRunner({ dataDir: data });
  await runner.listTasks();
  return { runner, input, data };
}

test('task creation rejects undeclared task state and non-string identifiers', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runner.createTask({ ...f.input, schemaVersion: 2, snapshotProfile: { id: 'injected' } } as typeof f.input), /input|field/i);
    await assert.rejects(f.runner.createTask({ ...f.input, id: 12 as unknown as string }), /Task ID|string/i);
    assert.deepEqual(await f.runner.listTasks(), []);
  } finally { await f.runner.close(); }
});

test('task fields snapshot before async work and accessor inputs are not evaluated', async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const accessor = Object.defineProperty({ ...f.input }, 'title', { enumerable: true, get: () => { reads++; return 'getter'; } });
    await assert.rejects(f.runner.createTask(accessor), /input|string/i);
    assert.equal(reads, 0);
    const input = { ...f.input }, created = f.runner.createTask(input);
    input.title = 'changed'; input.sessionId = 'changed';
    const task = await created;
    assert.equal(task.title, f.input.title); assert.equal(task.sessionId, f.input.sessionId);
  } finally { await f.runner.close(); }
});

test('sparse args and malformed path collections reject before process execution', async () => {
  const f = await fixture(); await f.runner.createTask(f.input);
  const normalize = f.runner as unknown as { normalize: (command: CommandSpec, root: string) => Promise<CommandSpec> };
  try {
    for (const command of [{ executable: process.execPath, args: new Array(1) },
      { executable: process.execPath, args: [], artifactPaths: [undefined] },
      { executable: process.execPath, args: [], artifactPaths: 'not-an-array' },
      { executable: process.execPath, args: [], cwd: 12 }]) {
      await assert.rejects(normalize.normalize(command as CommandSpec, f.input.projectRoot), /string|paths/i);
    }
  } finally { await f.runner.close(); }
});

test('closed runner cannot rewrite metadata after a new owner acquires the store', async () => {
  const f = await fixture();
  await f.runner.createTask(f.input); await f.runner.close();
  const replacement = new EngineeringRunner({ dataDir: f.data });
  try {
    await replacement.listTasks();
    const before = await readFile(path.join(f.data, 'engineering/state.json'), 'utf8');
    await assert.rejects(f.runner.createTask({ ...f.input, id: 'late' }), /closing|closed/i);
    await assert.rejects(f.runner.setAcceptance('task', []), /closing|closed/i);
    await assert.rejects(f.runner.refresh('task'), /closing|closed/i);
    await assert.rejects(f.runner.recover(), /closing|closed/i);
    assert.equal(await readFile(path.join(f.data, 'engineering/state.json'), 'utf8'), before);
  } finally { await replacement.close(); }
});

test('close joins concurrent calls and retains store ownership through an admitted configuration update', async () => {
  const f = await fixture(); await f.runner.createTask(f.input);
  const entered = deferred(), release = deferred();
  const internals = f.runner as unknown as { normalize: (command: CommandSpec, root: string) => Promise<CommandSpec> };
  const command: CommandSpec = { executable: 'unused-fixture', args: [] };
  internals.normalize = async () => { entered.resolve(); await release.promise; return command; };
  const update = f.runner.setAcceptance('task', [{ id: 'manual', kind: 'manual', title: 'Manual fixture', command }]);
  await entered.promise;
  let closed = false;
  const closing = Promise.all([f.runner.close(), f.runner.close()]).then(() => { closed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, false, 'close released ownership while configuration was suspended');
  } finally {
    release.resolve(); await update; await closing;
  }
});

test('request object mutation cannot change the pending cleanup key', async () => {
  const f = await fixture(); await f.runner.createTask(f.input);
  const entered = deferred(), release = deferred();
  const internals = f.runner as unknown as {
    normalize: (command: CommandSpec, root: string) => Promise<CommandSpec>;
    perform: (task: unknown, operation: Operation, control: unknown) => Promise<Operation>;
    pending: Map<string, unknown>;
  };
  let captured: CommandSpec | undefined;
  internals.normalize = async command => { captured = command; return { ...command, args: [...command.args] }; };
  internals.perform = async (_task, operation) => { entered.resolve(); await release.promise; operation.status = 'failed'; return operation; };
  const input = { taskId: 'task', requestKey: 'original-key', kind: 'build' as const, command: { executable: 'unused-fixture', args: ['original'] } };
  try {
    const operation = f.runner.run(input);
    input.requestKey = 'mutated-key'; (input as { kind: string }).kind = 'flash';
    input.command.executable = 'changed'; input.command.args[0] = 'changed';
    await entered.promise;
    assert.equal(captured?.executable, 'unused-fixture'); assert.deepEqual(captured?.args, ['original']);
    input.requestKey = 'mutated-again'; release.resolve();
    const result = await operation;
    assert.equal(result.requestKey, 'original-key'); assert.equal(result.kind, 'build');
    assert.equal(internals.pending.size, 0);
  } finally { release.resolve(); await f.runner.close(); }
});

test('rejected export through a junction cannot create inside the source project', async () => {
  const f = await fixture(); await f.runner.createTask(f.input);
  const link = path.join(path.dirname(f.input.projectRoot), 'export-link');
  await symlink(f.input.projectRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(f.runner.exportTask('task', path.join(link, 'must-not-create')), /protected|source|outside/i);
    await assert.rejects(access(path.join(f.input.projectRoot, 'must-not-create')), { code: 'ENOENT' });
  } finally { await f.runner.close(); }
});

test('unsupported operation kinds refuse before command or unrelated getter access', async () => {
  const f = await fixture(); let reads = 0;
  try {
    for (const kind of ['flash', 'verify', 'device.bind', 'device.flash', 'device.verify', 'read_flash']) {
      await assert.rejects(f.runner.run({ taskId: 'missing', requestKey: 'rejected', kind: kind as 'build',
        get command(): never { reads++; throw Error('command-getter'); },
        get extra(): never { reads++; throw Error('extra-getter'); },
      } as Parameters<EngineeringRunner['run']>[0]), /Unsupported operation kind; device operations are unavailable/);
    }
    assert.equal(reads, 0); assert.deepEqual(await f.runner.listTasks(), []);
  } finally { await f.runner.close(); }
});

test('run rejects nonobjects, kind accessors and undeclared/accessor fields without evaluating them', async () => {
  const f = await fixture(); await f.runner.createTask(f.input); let reads = 0;
  const command = { executable: 'unused-fixture', args: [] as string[] };
  try {
    for (const input of [null, undefined, 1, [], { taskId: 'task', requestKey: 'getter',
      get kind() { reads++; return reads === 1 ? 'build' : 'flash'; }, command },
    { taskId: 'task', requestKey: 'getter', kind: 'build', command, get extra() { reads++; throw Error('extra-getter'); } },
    { taskId: 'task', requestKey: 'getter', kind: 'build', get command() { reads++; throw Error('command-getter'); } },
    Object.assign(Object.create({ inherited: true }), { taskId: 'task', requestKey: 'getter', kind: 'build', command })]) {
      await assert.rejects(f.runner.run(input as Parameters<EngineeringRunner['run']>[0]), /input|kind|field|argument/i);
    }
    await assert.rejects(f.runner.run({ taskId: 'task', requestKey: 'fixed', kind: 'test', acceptanceId: SNAPSHOT_ACCEPTANCE_ID,
      get command(): never { reads++; throw Error('fixed-command-getter'); },
    }), /input|field|snapshot/i);
    assert.equal(reads, 0); assert.equal((await f.runner.getTask('task')).operations.length, 0);
  } finally { await f.runner.close(); }
});

test('nested command and array accessors, prototypes and unknown fields are never evaluated', async () => {
  const f = await fixture(); await f.runner.createTask(f.input); let reads = 0;
  const args = [] as string[];
  Object.defineProperty(args, '0', { enumerable: true, get: () => { reads++; throw Error('arg-getter'); } });
  const commands = [
    { executable: 'unused-fixture', get args() { reads++; throw Error('args-getter'); } },
    { executable: 'unused-fixture', args },
    { executable: 'unused-fixture', args: [], get extra() { reads++; throw Error('extra-command-getter'); } },
    Object.assign(Object.create({ inherited: true }), { executable: 'unused-fixture', args: [] }),
    { executable: 'unused-fixture', args: Object.assign([], { extra: 'undeclared' }) },
    { executable: 'unused-fixture', args: [], artifactPaths: args },
  ];
  try {
    for (const [index, command] of commands.entries()) await assert.rejects(f.runner.run({ taskId: 'task', requestKey: 'nested-' + index, kind: 'build', command: command as CommandSpec }), /input|field|array|argument/i);
    assert.equal(reads, 0); assert.equal((await f.runner.getTask('task')).operations.length, 0);
  } finally { await f.runner.close(); }
});

test('acceptance kind and reserved ID refuse before command capture; accessors and extra fields are rejected', async () => {
  const f = await fixture(); await f.runner.createTask(f.input); let reads = 0;
  try {
    for (const [id, kind] of [['check', 'flash'], [SNAPSHOT_ACCEPTANCE_ID, 'manual']]) {
      const definition = { id, kind, title: 'Rejected', get command(): never { reads++; throw Error('command-getter'); } };
      await assert.rejects(f.runner.setAcceptance('task', [definition as Parameters<EngineeringRunner['setAcceptance']>[1][number]]), /kind|fixed snapshot/i);
    }
    const command = { executable: 'unused-fixture', args: [] as string[] };
    const args = [] as string[];
    Object.defineProperty(args, '0', { enumerable: true, get: () => { reads++; throw Error('arg-getter'); } });
    for (const definition of [
      { id: 'check', title: 'Rejected', get kind() { reads++; return 'manual'; }, command },
      { id: 'check', title: 'Rejected', kind: 'manual', command, get extra() { reads++; throw Error('extra-getter'); } },
      { id: 'check', title: 'Rejected', kind: 'manual', command: { executable: 'unused-fixture', args } },
      { id: 'check', title: 'Rejected', kind: 'manual', verifierFiles: args },
    ]) await assert.rejects(f.runner.setAcceptance('task', [definition as Parameters<EngineeringRunner['setAcceptance']>[1][number]]), /input|kind|field|array/i);
    assert.equal(reads, 0); assert.deepEqual((await f.runner.getTask('task')).acceptance, []);
  } finally { await f.runner.close(); }
});

test('acceptance command and metadata remain immutable during asynchronous normalization', async () => {
  const f = await fixture(); await f.runner.createTask(f.input);
  const entered = deferred(), release = deferred();
  const internals = f.runner as unknown as { normalize: (command: CommandSpec, root: string) => Promise<CommandSpec> };
  internals.normalize = async command => { entered.resolve(); await release.promise; return command; };
  const definition = { id: 'check', title: 'Original', kind: 'manual' as const, command: { executable: 'unused-fixture', args: ['original'] } };
  try {
    const update = f.runner.setAcceptance('task', [definition]); await entered.promise;
    definition.title = 'Changed'; definition.command.args[0] = 'changed'; release.resolve();
    const task = await update;
    assert.equal(task.acceptance[0].title, 'Original'); assert.deepEqual(task.acceptance[0].command?.args, ['original']);
  } finally { release.resolve(); await f.runner.close(); }
});
