import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FlashOutcome } from '../device/types.js';
import { digest, durableJson, fileHash, sourceFiles } from './files.js';
import { EmbeddedService } from './service.js';
import type { EmbeddedHardwareAdapter, EmbeddedHardwareContext, EmbeddedOptions, EmbeddedTaskState, EmbeddedToolPaths } from './types.js';

async function fixture(options: Partial<EmbeddedOptions> = {}) {
  const fixtureRoot = path.resolve('.runner-tests/embedded-service');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, 'case-'));
  const project = path.join(root, 'project');
  const template = path.join(root, 'template');
  const data = path.join(root, 'state');
  await mkdir(path.join(project, 'MDK-ARM'), { recursive: true });
  await cp(fileURLToPath(new URL('../../../engineering/templates/gesturescreen-v1/', import.meta.url)), template, { recursive: true });
  await writeFile(path.join(project, 'main.c'), 'int main(void) { return 0; }\n');
  await writeFile(path.join(project, 'MDK-ARM', 'GestureScreen.uvprojx'), '<TargetName>GestureScreen</TargetName>');
  let now = Date.parse('2026-10-15T00:00:00Z');
  let inspectCalls = 0; let flashCalls = 0; let verifyCalls = 0;
  const hardware: EmbeddedHardwareAdapter = {
    async inspect(ctx) {
      inspectCalls++;
      const backup = path.join(ctx.operationDir, 'backup.bin');
      await writeFile(backup, Buffer.alloc(1024 * 1024, 0xff));
      return { status: 'succeeded', processExited: true, receipt: JSON.stringify({ action: 'inspect', operationId: ctx.operationId,
        backup: { path: backup, sha256: await fileHash(backup), bytes: 1024 * 1024, doubleReadMatch: true } }) };
    },
    async flash() { flashCalls++; return { status: 'succeeded', processExited: true, receipt: '{"action":"flash","readback":true}' }; },
    async verify() { verifyCalls++; return { status: 'succeeded', processExited: true, receipt: '{"action":"verify"}' }; },
    async confirmProcessExited() { return false; },
  };
  const service = new EmbeddedService({ dataDir: data, templateRoot: template, hardware, now: () => now,
    async execute(command) {
      assert.equal(command.args.filter(arg => arg === '-j0').length, 1, 'Service must use UV4 GUI-suppressed batch compilation');
      const snapshot = path.resolve(command.cwd!, '..');
      const header = await readFile(path.join(snapshot, 'App', 'Inc', 'forgedesk_build_id.h'), 'utf8');
      const buildId = Buffer.from([...header.matchAll(/0x([a-f0-9]{2})/g)].map(match => Number.parseInt(match[1], 16)));
      assert.equal(buildId.length, 32);
      const objects = path.join(snapshot, 'MDK-ARM', 'Objects');
      await mkdir(objects, { recursive: true });
      await writeFile(path.join(objects, 'GestureScreen.axf'), Buffer.concat([Buffer.from('ELF test fixture'), buildId]));
      await writeFile(path.join(objects, 'GestureScreen.hex'), ':00000001FF\n');
      await writeFile(command.args[command.args.indexOf('-o') + 1], 'GestureScreen - 0 Error(s), 0 Warning(s).\n');
      return { exitCode: 0, signal: null, output: 'test compiler', timedOut: false, cancelled: false, cleanup: 'not-needed' };
    }, ...options });
  // Isolate state-machine tests from the locally installed Keil binaries and reviewed project fixture.
  const internals = service as unknown as {
    tools(tools: EmbeddedToolPaths): Promise<Record<string, string>>;
    validateProject(project: string): Promise<void>;
    save(state: EmbeddedTaskState): Promise<void>;
    required(task: string): Promise<EmbeddedTaskState>;
    read(task: string): Promise<EmbeddedTaskState | undefined>;
    persist: typeof durableJson;
    releaseProbe(taskId: string, operationId: string): Promise<void>;
    acquireProbe(taskId: string, operationId: string): Promise<void>;
  };
  internals.tools = async () => ({ compiler: digest('test compiler') });
  internals.validateProject = async () => {};
  const configure = (id = 'task1') => service.configure(id, project, { keilExecutable: process.execPath });
  const build = async (id = 'task1') => { await configure(id); const result = await service.build(id, 'build1'); assert.equal(result.operations.at(-1)?.status, 'succeeded'); return result; };
  return { root, project, template, data, service, internals, hardware, configure, build,
    counters: () => ({ inspectCalls, flashCalls, verifyCalls }), advance: (ms: number) => { now += ms; },
    cleanup: async () => { await service.close(); await rm(root, { recursive: true, force: true }); } };
}

test('snapshot exclusions are exact and preserve arbitrary image/source paths', async () => {
  const f = await fixture();
  try {
    for (const relative of ['Build/old.log', 'MDK-ARM/Objects/old.hex', 'demo/GestureScreen-demo-HQ.mp4', 'Other/Build/keep.c', 'App/image.png']) {
      await mkdir(path.dirname(path.join(f.project, relative)), { recursive: true });
      await writeFile(path.join(f.project, relative), 'fixture');
    }
    const files = await sourceFiles(f.project);
    assert.deepEqual(files.filter(file => /keep|image/.test(file.path)).map(file => file.path), ['App/image.png', 'Other/Build/keep.c']);
    assert.equal(files.some(file => /old|\.mp4/.test(file.path)), false);
  } finally { await f.cleanup(); }
});

test('snapshot refuses directory junctions or symbolic links', async () => {
  const f = await fixture();
  try {
    await symlink(f.template, path.join(f.project, 'linked-template'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(sourceFiles(f.project), /Reparse/);
  } finally { await f.cleanup(); }
});

test('build creates unique linked identity and source/artifact evidence outside project', async () => {
  const f = await fixture();
  try {
    const status = await f.build(); const artifact = status.artifact!;
    assert.equal(artifact.buildId.length, 64);
    assert.notEqual(artifact.buildId, '0'.repeat(64));
    assert.equal(artifact.projectSourceBefore, artifact.projectSourceAfter);
    assert.equal(artifact.snapshotSourceBefore, artifact.snapshotSourceAfter);
    assert.ok(artifact.sourceRoot.startsWith(f.data));
    assert.ok((await readFile(artifact.axfPath)).includes(Buffer.from(artifact.buildId, 'hex')));
    const repeat = await f.service.build('task1', 'build1');
    assert.equal(repeat.artifact!.id, artifact.id);
    assert.equal(repeat.operations.length, 1);
  } finally { await f.cleanup(); }
});

test('native challenge approval is mandatory and duplicate flash key never replays', async () => {
  const f = await fixture();
  try {
    await f.build(); await f.service.inspect('task1', 'inspect1');
    const preview = await f.service.prepareGrant('task1');
    await assert.rejects(f.service.flash('task1', 'flash-no-approval'), /approval/);
    await assert.rejects(f.service.approveGrant('task1', 'wrong-challenge'), /stale/);
    await f.service.approveGrant('task1', preview.id);
    const flash = await f.service.flash('task1', 'flash1');
    assert.equal(flash.operations.at(-1)?.status, 'succeeded');
    assert.equal(flash.grant!.consumedBy, flash.operations.at(-1)!.id);
    await f.service.flash('task1', 'flash1');
    assert.equal(f.counters().flashCalls, 1);
    await assert.rejects(f.service.flash('task1', 'flash2'), /approval|inspection/);
    const verify = await f.service.verify('task1', 'verify1');
    assert.equal(verify.operations.at(-1)?.status, 'succeeded');
  } finally { await f.cleanup(); }
});

test('modified source, artifact, template and expired grants block hardware execution', async () => {
  for (const change of ['source', 'artifact', 'template', 'expired'] as const) {
    const f = await fixture();
    try {
      const status = await f.build(); await f.service.inspect('task1', 'inspect1');
      const preview = await f.service.prepareGrant('task1'); await f.service.approveGrant('task1', preview.id);
      if (change === 'source') await writeFile(path.join(f.project, 'main.c'), 'changed');
      if (change === 'artifact') await writeFile(status.artifact!.hexPath, 'changed');
      if (change === 'template') await writeFile(path.join(f.template, 'new-file.c'), 'changed');
      if (change === 'expired') f.advance(5 * 60 * 1000 + 1);
      await assert.rejects(f.service.flash('task1', 'flash1'), /changed|mismatch|approval|overlay/);
      assert.equal(f.counters().flashCalls, 0);
    } finally { await f.cleanup(); }
  }
});

test('tampered persisted state is rejected before it can authorize a device', async () => {
  const f = await fixture();
  try {
    await f.configure();
    const statePath = path.join(f.data, 'embedded', 'task1', 'state.json');
    const envelope = JSON.parse(await readFile(statePath, 'utf8'));
    envelope.payload.projectRoot = f.template;
    await writeFile(statePath, JSON.stringify(envelope));
    await assert.rejects(f.service.status('task1'), /binding failed/);
  } finally { await f.cleanup(); }
});

test('unknown device result holds global lock and is not replayed after recovery', async () => {
  const f = await fixture();
  try {
    await f.configure();
    let calls = 0;
    f.hardware.inspect = async () => { calls++; return { status: 'unknown', processExited: false, detail: 'test visibility deadline' }; };
    const result = await f.service.inspect('task1', 'inspect1');
    assert.equal(result.operations.at(-1)!.status, 'unknown');
    await assert.rejects(f.service.assertIdle(), /lock remains/);
    await f.service.recover(); await f.service.inspect('task1', 'inspect1');
    assert.equal(calls, 1);
    await assert.rejects(f.service.inspect('task1', 'inspect2'), /unresolved/);
    await assert.rejects(f.service.revokeGrants(), /lock remains/);
  } finally { await f.cleanup(); }
});

test('confirmed process exit releases lock but preserves unknown hardware outcome', async () => {
  const f = await fixture();
  try {
    await f.configure();
    f.hardware.inspect = async () => ({ status: 'unknown', processExited: false });
    await f.service.inspect('task1', 'inspect1');
    f.hardware.confirmProcessExited = async () => true;
    await f.service.recover(); await f.service.assertIdle();
    const status = await f.service.status('task1');
    assert.equal(status.operations[0].status, 'unknown');
    assert.equal(status.operations[0].processExited, true);
  } finally { await f.cleanup(); }
});

test('probe lock covers another task build while an inspect process is alive', async () => {
  const f = await fixture();
  let finish: (value: FlashOutcome) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  try {
    await f.configure('task1'); await f.configure('task2');
    f.hardware.inspect = async (_ctx: EmbeddedHardwareContext) => { started(); return new Promise(resolve => { finish = resolve; }); };
    const first = f.service.inspect('task1', 'inspect1'); await ready;
    const second = await f.service.build('task2', 'build1');
    assert.equal(second.operations.at(-1)!.status, 'failed');
    assert.match(second.operations.at(-1)!.detail!, /held/);
    finish({ status: 'failed', processExited: true }); await first;
    await f.service.assertIdle();
  } finally { finish({ status: 'failed', processExited: true }); await f.cleanup(); }
});

test('reconfigure and leaving controlled mode invalidate durable approval', async () => {
  const f = await fixture();
  try {
    await f.build(); await f.service.inspect('task1', 'inspect1');
    let preview = await f.service.prepareGrant('task1'); await f.service.approveGrant('task1', preview.id);
    await f.configure(); assert.equal((await f.service.status('task1')).grant, undefined);
    preview = await f.service.prepareGrant('task1'); await f.service.approveGrant('task1', preview.id);
    await f.service.revokeGrants(); assert.equal((await f.service.status('task1')).grant, undefined);
  } finally { await f.cleanup(); }
});

test('changed bound backup rejects approval and flash before a worker can start', async () => {
  const f = await fixture();
  try {
    await f.build(); const inspect = await f.service.inspect('task1', 'inspect1');
    const preview = await f.service.prepareGrant('task1');
    const receipt = JSON.parse(inspect.operations.at(-1)!.receipt!);
    await writeFile(receipt.backup.path, Buffer.alloc(1024 * 1024, 0));
    await assert.rejects(f.service.approveGrant('task1', preview.id), /backup changed/);
    assert.equal(f.counters().flashCalls, 0);
  } finally { await f.cleanup(); }
});

test('source changes during compilation invalidate produced artifacts', async () => {
  const f = await fixture();
  try {
    const internal = f.service as unknown as { options: EmbeddedOptions };
    const compiler = internal.options.execute!;
    internal.options.execute = async (...args) => {
      const result = await compiler(...args);
      await writeFile(path.join(f.project, 'main.c'), 'changed while compiling');
      return result;
    };
    await f.configure(); const status = await f.service.build('task1', 'build1');
    assert.equal(status.artifact, undefined);
    assert.equal(status.operations.at(-1)!.status, 'failed');
    assert.match(status.operations.at(-1)!.detail!, /source changed/);
    await f.service.assertIdle();
  } finally { await f.cleanup(); }
});

test('export bundles copied artifact bytes and verifiable allowlisted evidence', async () => {
  const f = await fixture();
  try {
    const built = await f.build(); await f.service.inspect('task1', 'inspect1');
    const output = await f.service.export('task1', path.join(f.root, 'exports'));
    const envelope = JSON.parse(await readFile(output.path, 'utf8'));
    assert.equal(await fileHash(output.path), output.sha256);
    assert.ok(envelope.files.some((file: { path: string }) => file.path === 'build/overlay-manifest.json'));
    for (const file of envelope.files) assert.equal(await fileHash(path.join(path.dirname(output.path), file.path)), file.sha256);
    assert.equal(await fileHash(path.join(path.dirname(output.path), 'firmware/GestureScreen.hex')), built.artifact!.hexSha256);
    await assert.rejects(f.service.export('task1', path.join(f.project, 'exports')), /outside/);
    await writeFile(built.artifact!.logPath, 'altered log');
    await assert.rejects(f.service.export('task1', path.join(f.root, 'exports')), /log changed/);
  } finally { await f.cleanup(); }
});

test('unknown flash needs confirmed recovery and a fresh inspection before a new grant', async () => {
  const f = await fixture();
  try {
    await f.build(); await f.service.inspect('task1', 'inspect1');
    const preview = await f.service.prepareGrant('task1'); await f.service.approveGrant('task1', preview.id);
    f.hardware.flash = async () => ({ status: 'unknown', processExited: true, detail: 'readback failure' });
    const flash = await f.service.flash('task1', 'flash1');
    assert.equal(flash.operations.at(-1)!.status, 'unknown');
    await assert.rejects(f.service.inspect('task1', 'inspect2'), /unresolved/);
    await f.service.recover();
    await assert.rejects(f.service.prepareGrant('task1'), /new successful inspection/);
    await f.service.inspect('task1', 'inspect3');
    assert.ok((await f.service.prepareGrant('task1')).id);
  } finally { await f.cleanup(); }
});

test('hardware snapshots expose live progress without upgrading an unknown result', async () => {
  const f = await fixture();
  try {
    await f.configure();
    f.hardware.inspect = async () => ({ status: 'unknown', processExited: false, detail: 'IPSR=3; test unknown hardware state' });
    let completed = 0;
    f.hardware.readProgress = async (action, id) => ({ schemaVersion: 1, operationId: id, action,
      stage: 'backup_read_1', sequence: completed, updatedAt: '2026-10-15T00:00:00Z', completed, total: 1048576, unit: 'bytes' });
    const first = await f.service.inspect('task1', 'inspect1');
    assert.equal(first.operations[0].progress!.completed, 0);
    completed = 1048576;
    const latest = await f.service.status('task1');
    assert.equal(latest.operations[0].progress!.completed, 1048576);
    assert.equal(latest.operations[0].status, 'unknown');
    assert.match(latest.operations[0].detail!, /IPSR=3/);
    assert.equal(latest.operations[0].processExited, false);
    assert.equal(latest.grant, undefined);
    const persisted = await f.internals.required('task1');
    assert.equal(persisted.operations[0].progress, undefined);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
    f.hardware.readProgress = async () => { throw new Error('bad optional telemetry'); };
    assert.equal((await f.service.status('task1')).operations[0].status, 'unknown');
  } finally { await f.cleanup(); }
});

test('a failed initial hardware intent write leaves no lock, worker or active queue', async () => {
  const f = await fixture();
  try {
    await f.configure(); const persist = f.internals.persist;
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'state.json' && (value as { payload: EmbeddedTaskState }).payload.operations.length) throw new Error('injected initial intent write failed');
      await persist(file, value);
    };
    await assert.rejects(f.service.inspect('task1', 'inspect1'), /initial intent/);
    assert.equal(f.counters().inspectCalls, 0);
    assert.equal((await f.service.status('task1')).operations.length, 0);
    await f.service.assertIdle(); await f.service.close();
  } finally { await f.cleanup(); }
});

test('running-state write failure records known no-dispatch failure and releases only its own lock', async () => {
  const f = await fixture();
  try {
    await f.configure(); const persist = f.internals.persist;
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'state.json' && (value as { payload: EmbeddedTaskState }).payload.operations.at(-1)?.status === 'running') throw new Error('injected running state write failed');
      await persist(file, value);
    };
    const result = await f.service.inspect('task1', 'inspect1');
    assert.equal(result.operations[0].status, 'failed');
    assert.equal(result.operations[0].processExited, true);
    assert.equal(result.operations[0].dispatchPhase, 'not-started');
    assert.match(result.operations[0].detail!, /not dispatched/);
    assert.equal(f.counters().inspectCalls, 0);
    await f.service.assertIdle(); await f.service.inspect('task1', 'inspect1');
    assert.equal(f.counters().inspectCalls, 0);
    await f.service.recover(); await f.service.assertIdle(); await f.service.close();
  } finally { await f.cleanup(); }
});

test('persistent state-write failure after durable prepare is recovered without dispatch or deadlock', async () => {
  const f = await fixture(); let restarted: EmbeddedService | undefined;
  try {
    await f.configure(); const persist = f.internals.persist;
    f.internals.persist = async (file, value) => {
      const state = (value as { payload?: EmbeddedTaskState }).payload;
      if (path.basename(file) === 'state.json' && state?.operations.length && state.operations.at(-1)!.status !== 'prepared') throw new Error('persistent state write denial');
      await persist(file, value);
    };
    await assert.rejects(f.service.inspect('task1', 'inspect1'), /persistent state write denial/);
    const prepared = (await f.service.status('task1')).operations[0];
    assert.equal(prepared.status, 'prepared'); assert.equal(prepared.dispatchPhase, 'not-started');
    assert.equal(f.counters().inspectCalls, 0);
    await f.service.assertIdle(); await f.service.close();
    restarted = new EmbeddedService({ dataDir: f.data, templateRoot: f.template, hardware: f.hardware });
    await restarted.recover(); await restarted.assertIdle();
    const recovered = (await restarted.status('task1')).operations[0];
    assert.equal(recovered.status, 'failed'); assert.equal(recovered.processExited, true);
    await restarted.inspect('task1', 'inspect1'); assert.equal(f.counters().inspectCalls, 0);
  } finally { await restarted?.close(); await f.cleanup(); }
});

test('owner-file persistence failure rolls back this newly created probe directory', async () => {
  const f = await fixture();
  try {
    await f.configure(); const persist = f.internals.persist;
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'owner.json') throw new Error('injected owner file write failed');
      await persist(file, value);
    };
    const result = await f.service.inspect('task1', 'inspect1');
    assert.equal(result.operations[0].status, 'failed'); assert.equal(result.operations[0].processExited, true);
    assert.match(result.operations[0].detail!, /owner file/); assert.equal(f.counters().inspectCalls, 0);
    await f.service.assertIdle(); await f.service.close();
  } finally { await f.cleanup(); }
});

test('pre-dispatch failure does not delete another operation probe lock', async () => {
  const f = await fixture();
  try {
    await f.configure();
    const lock = path.join(f.data, 'embedded/probe.lock'); await mkdir(lock);
    const owner = JSON.stringify({ taskId: 'another-task', operationId: 'another-operation' });
    await writeFile(path.join(lock, 'owner.json'), owner);
    const result = await f.service.inspect('task1', 'inspect1');
    assert.equal(result.operations[0].status, 'failed'); assert.equal(f.counters().inspectCalls, 0);
    assert.equal(await readFile(path.join(lock, 'owner.json'), 'utf8'), owner);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
  } finally { await f.cleanup(); }
});

test('terminal-write failure after dispatch retains the unknown operation lock and never replays', async () => {
  const f = await fixture();
  try {
    await f.configure(); const persist = f.internals.persist; let calls = 0;
    f.hardware.inspect = async () => { calls++; return { status: 'unknown', processExited: false }; };
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'state.json' && (value as { payload: EmbeddedTaskState }).payload.operations.at(-1)?.status === 'unknown') throw new Error('terminal persistence denied');
      await persist(file, value);
    };
    await assert.rejects(f.service.inspect('task1', 'inspect1'), /terminal persistence denied/);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
    assert.equal((await f.service.status('task1')).operations[0].dispatchPhase, 'may-have-started');
    f.internals.persist = persist; await f.service.recover();
    await assert.rejects(f.service.inspect('task1', 'inspect1'), /unrecovered exit checkpoint/);
    assert.equal(calls, 1); await assert.rejects(f.service.assertIdle(), /lock remains/);
  } finally { await f.cleanup(); }
});

test('lock cleanup failure keeps the confirmed exit fact and can be explicitly recovered', async () => {
  const f = await fixture();
  try {
    await f.configure(); const release = f.internals.releaseProbe.bind(f.service); let first = true;
    f.internals.releaseProbe = async (...args) => { if (first) { first = false; throw new Error('injected lock cleanup failed'); } await release(...args); };
    await assert.rejects(f.service.inspect('task1', 'inspect1'), /lock cleanup failed/);
    const failedCleanup = (await f.service.status('task1')).operations[0];
    assert.equal(failedCleanup.processExited, true); assert.equal(failedCleanup.status, 'unknown');
    assert.match(failedCleanup.detail!, /exit is confirmed/); await assert.rejects(f.service.assertIdle(), /lock remains/);
    await f.service.recover(); await f.service.assertIdle();
    assert.equal((await f.service.status('task1')).operations[0].status, 'unknown');
    assert.ok((await f.service.status('task1')).operations[0].recoveredAt);
    assert.equal(f.counters().inspectCalls, 1);
  } finally { await f.cleanup(); }
});

test('build terminal-state failure checkpoints exit facts without restoring successful build acceptance', async () => {
  const f = await fixture();
  try {
    await f.configure(); const persist = f.internals.persist;
    const options = (f.service as unknown as { options: EmbeddedOptions }).options;
    const execute = options.execute!; let builds = 0;
    options.execute = async (...args) => { builds++; return execute(...args); };
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'state.json' && (value as { payload: EmbeddedTaskState }).payload.operations.at(-1)?.status === 'succeeded') throw new Error('build terminal save denied');
      await persist(file, value);
    };
    await assert.rejects(f.service.build('task1', 'build1'), /terminal save denied/);
    const checkpointed = await f.service.status('task1');
    assert.equal(checkpointed.operations[0].status, 'unknown');
    assert.equal(checkpointed.operations[0].processExited, true);
    assert.equal(checkpointed.artifact, undefined);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
    f.internals.persist = persist; await f.service.recover(); await f.service.assertIdle();
    const recovered = await f.service.build('task1', 'build1');
    assert.equal(recovered.operations[0].status, 'unknown'); assert.equal(recovered.artifact, undefined);
    assert.equal(recovered.operations[0].processExited, true); assert.ok(recovered.operations[0].recoveredAt);
    assert.equal(builds, 1);
  } finally { await f.cleanup(); }
});

test('build lock cleanup failure retains exit facts and recovers without a second compiler execution', async () => {
  const f = await fixture();
  try {
    await f.configure(); const release = f.internals.releaseProbe.bind(f.service); let first = true;
    f.internals.releaseProbe = async (...args) => { if (first) { first = false; throw new Error('build lock cleanup denied'); } return release(...args); };
    await assert.rejects(f.service.build('task1', 'build1'), /build lock cleanup denied/);
    const recorded = await f.service.status('task1');
    assert.equal(recorded.operations[0].status, 'unknown'); assert.equal(recorded.operations[0].processExited, true);
    assert.match(recorded.operations[0].detail!, /cleanup failed/);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
    await f.service.recover(); await f.service.assertIdle();
    const repeated = await f.service.build('task1', 'build1');
    assert.equal(repeated.operations[0].id, recorded.operations[0].id);
    assert.equal(repeated.operations[0].status, 'unknown');
  } finally { await f.cleanup(); }
});

test('failure to persist both terminal state and exit checkpoint remains held and unknown', async () => {
  const f = await fixture();
  try {
    await f.configure(); const persist = f.internals.persist;
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'exit-checkpoint.json') throw new Error('checkpoint save denied');
      if (path.basename(file) === 'state.json' && (value as { payload: EmbeddedTaskState }).payload.operations.at(-1)?.status === 'succeeded') throw new Error('terminal save denied');
      await persist(file, value);
    };
    await assert.rejects(f.service.build('task1', 'build1'), /terminal persistence/);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
    f.internals.persist = persist; await f.service.recover();
    const recovered = await f.service.status('task1');
    assert.equal(recovered.operations[0].status, 'unknown'); assert.equal(recovered.operations[0].processExited, false);
    assert.equal(recovered.operations[0].recoveredAt, undefined);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
  } finally { await f.cleanup(); }
});

test('exit checkpoints reject byte tampering and replay into another task intent', async () => {
  const f = await fixture();
  try {
    await f.configure(); const persist = f.internals.persist;
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'state.json' && (value as { payload: EmbeddedTaskState }).payload.operations.at(-1)?.status === 'succeeded') throw new Error('terminal save denied');
      await persist(file, value);
    };
    await assert.rejects(f.service.build('task1', 'build1'), /terminal save denied/);
    f.internals.persist = persist;
    const first = (await f.internals.read('task1'))!; const op = first.operations[0];
    const checkpoint = path.join(f.data, 'embedded/task1/builds', op.id, 'exit-checkpoint.json');
    const original = await readFile(checkpoint, 'utf8'); const altered = JSON.parse(original);
    altered.payload.processExited = false; await writeFile(checkpoint, JSON.stringify(altered));
    await assert.rejects(f.service.status('task1'), /checkpoint.*binding/);
    await assert.rejects(f.service.recover(), /checkpoint.*binding/);
    await assert.rejects(f.service.assertIdle(), /lock remains/);
    await writeFile(checkpoint, original); await f.configure('task2');
    const second = await f.internals.required('task2');
    second.operations.push({ ...op, id: randomUUID(), nonce: 'different-nonce', argsDigest: digest('different intent') });
    await f.internals.save(second);
    const replay = path.join(f.data, 'embedded/task2/builds', second.operations[0].id, 'exit-checkpoint.json');
    await mkdir(path.dirname(replay), { recursive: true }); await writeFile(replay, original);
    await assert.rejects(f.service.status('task2'), /checkpoint.*binding/);
  } finally { await f.cleanup(); }
});

test('legacy pending state without dispatch proof or checkpoint remains unknown with its lock held', async () => {
  for (const status of ['prepared', 'running'] as const) {
    const f = await fixture();
    try {
      await f.configure(); const state = await f.internals.required('task1');
      const id = randomUUID();
      state.operations.push({ id, requestKey: 'legacy1', kind: 'inspect', argsDigest: digest('legacy'), nonce: 'legacy-nonce',
        status, processExited: true, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z' });
      await f.internals.save(state); await f.internals.acquireProbe('task1', id);
      await f.service.recover(); const recovered = (await f.service.status('task1')).operations[0];
      assert.equal(recovered.status, 'unknown'); assert.equal(recovered.processExited, false);
      assert.equal(recovered.recoveredAt, undefined); assert.equal(f.counters().inspectCalls, 0);
      await assert.rejects(f.service.assertIdle(), /lock remains/);
    } finally { await f.cleanup(); }
  }
});

test('an unrecovered checkpoint blocks export and grants when raw state still says succeeded', async () => {
  const f = await fixture();
  try {
    await f.build(); const persist = f.internals.persist;
    f.internals.releaseProbe = async () => { throw new Error('inspect lock cleanup denied'); };
    f.internals.persist = async (file, value) => {
      if (path.basename(file) === 'state.json' && (value as { payload: EmbeddedTaskState }).payload.operations.at(-1)?.status === 'unknown') throw new Error('unknown state save denied');
      await persist(file, value);
    };
    await assert.rejects(f.service.inspect('task1', 'inspect1'), /terminal persistence/);
    assert.equal((await f.internals.read('task1'))!.operations.at(-1)!.status, 'succeeded');
    const visible = await f.service.status('task1');
    assert.equal(visible.operations.at(-1)!.status, 'unknown'); assert.equal(visible.operations.at(-1)!.processExited, true);
    await assert.rejects(f.service.export('task1', path.join(f.root, 'exports')), /unrecovered exit checkpoint/);
    await assert.rejects(f.service.prepareGrant('task1'), /unrecovered exit checkpoint/);
    await assert.rejects(f.service.inspect('task1', 'inspect2'), /unrecovered exit checkpoint/);
    assert.equal(f.counters().inspectCalls, 1); await assert.rejects(f.service.assertIdle(), /lock remains/);
  } finally { await f.cleanup(); }
});
