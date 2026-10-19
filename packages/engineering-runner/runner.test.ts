import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { EngineeringRunner } from './index.js';
import { fingerprint } from './fingerprint.js';
import { execute } from './processes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const testRoot = path.join(root, 'output/software-audit-20261019/runner/legacy');
const exec = promisify(execFile);

async function fixture() {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(path.join(testRoot, 'case-'));
  const project = path.join(directory, 'workspace');
  const data = path.join(directory, 'private');
  await mkdir(project);
  const script = path.join(directory, 'verifier.mjs');
  await writeFile(path.join(project, 'input.txt'), 'fixed');
  await writeFile(script, "import {readFileSync} from 'node:fs';import {join} from 'node:path';if(readFileSync(join(process.argv[2],'input.txt'),'utf8')!=='fixed')process.exit(1);console.log('passed');");
  const command = { executable: process.execPath, args: [script, project], cwd: project, timeoutMs: 10000 };
  const runner = new EngineeringRunner({ dataDir: data });
  await runner.createTask({ id: 'task', sessionId: 'session', title: 'Test fixture', projectRoot: project });
  await runner.setAcceptance('task', [{ id: 'check', title: 'Fixed behavior', kind: 'automated', command, verifierFiles: [script] }]);
  return { directory, project, data, script, command, runner };
}

test('trusted software fixture fails before fix, passes after fix, and survives restart', async () => {
  const f = await fixture();
  const source = path.join(root, 'engineering/fixtures/software/workspace/numbers.mjs');
  const verifier = path.join(root, 'engineering/fixtures/software/verifiers/verify-numbers.mjs');
  await writeFile(path.join(f.project, 'numbers.mjs'), await readFile(source));
  const command = { executable: process.execPath, args: [verifier, f.project], cwd: f.project, timeoutMs: 10000 };
  await f.runner.setAcceptance('task', [{ id: 'mean', title: 'Empty input and arithmetic', kind: 'automated', command, verifierFiles: [verifier] }]);
  const before = await f.runner.run({ taskId: 'task', requestKey: 'before', kind: 'test', acceptanceId: 'mean', command });
  assert.equal(before.status, 'failed');
  await writeFile(path.join(f.project, 'numbers.mjs'), 'export function average(values){return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : 0;}\n');
  const after = await f.runner.run({ taskId: 'task', requestKey: 'after', kind: 'test', acceptanceId: 'mean', command });
  assert.equal(after.status, 'succeeded');
  assert.equal((await f.runner.getTask('task')).status, 'passed');
  await f.runner.close();
  const restarted = new EngineeringRunner({ dataDir: f.data });
  assert.equal((await restarted.getTask('task')).status, 'passed');
  assert.equal((await restarted.getTask('task')).evidence.length, 2);
  await restarted.close();
});

test('durable requestKey returns original operation and rejects changed arguments', async () => {
  const f = await fixture();
  try {
    const request = { taskId: 'task', requestKey: 'once', kind: 'test' as const, acceptanceId: 'check', command: f.command };
    const [first, second] = await Promise.all([f.runner.run(request), f.runner.run(request)]);
    assert.equal(first.id, second.id);
    assert.equal((await f.runner.getTask('task')).operations.length, 1);
    await assert.rejects(f.runner.run({ ...request, command: { ...f.command, args: [...f.command.args, 'changed'] } }), /different normalized arguments/);
    await f.runner.close();
    const restarted = new EngineeringRunner({ dataDir: f.data });
    assert.equal((await restarted.run(request)).id, first.id);
    await restarted.close();
  } finally { await f.runner.close(); }
});

test('source, ignored binary, deleted and staged input changes expire evidence', async () => {
  const f = await fixture();
  try {
    await exec('git', ['init', f.project]);
    await writeFile(path.join(f.project, '.gitignore'), 'ignored.bin\n');
    await writeFile(path.join(f.project, 'ignored.bin'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(f.project, 'tracked.bin'), Buffer.from([3, 4, 5]));
    await exec('git', ['-C', f.project, 'add', '.']);
    await exec('git', ['-C', f.project, '-c', 'user.name=ForgeDesk test', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'fixture baseline']);
    const before = await fingerprint(f.project, { dataDir: f.data });
    assert.ok(before.files.some(file => file.path === 'ignored.bin'));
    assert.ok(before.gitCommit);
    await writeFile(path.join(f.project, 'ignored.bin'), Buffer.from([0, 1, 3]));
    await writeFile(path.join(f.project, 'tracked.bin'), Buffer.from([3, 4, 6]));
    await exec('git', ['-C', f.project, 'add', 'tracked.bin']);
    const binary = await fingerprint(f.project, { dataDir: f.data });
    assert.notEqual(binary.inputDigest, before.inputDigest);
    assert.notEqual(binary.dirtyDiffDigest, before.dirtyDiffDigest);
    await f.runner.run({ taskId: 'task', requestKey: 'pass', kind: 'test', acceptanceId: 'check', command: f.command });
    await writeFile(path.join(f.project, 'untracked.txt'), 'new');
    assert.equal((await f.runner.refresh('task')).acceptance[0].status, 'stale');
    await unlink(path.join(f.project, 'ignored.bin'));
    assert.notEqual((await fingerprint(f.project, { dataDir: f.data })).inputDigest, binary.inputDigest);
    await writeFile(path.join(f.project, 'input.txt'), 'staged');
    await exec('git', ['-C', f.project, 'add', 'input.txt']);
    assert.notEqual((await fingerprint(f.project, { dataDir: f.data })).dirtyDiffDigest, binary.dirtyDiffDigest);
  } finally { await f.runner.close(); }
});

test('edits during verification are stale and same-project operations are locked', async () => {
  const f = await fixture();
  try {
    await writeFile(f.script, "import {writeFileSync} from 'node:fs';import {join} from 'node:path';setTimeout(()=>{writeFileSync(join(process.argv[2],'input.txt'),'changed');console.log('done')},350);");
    const pending = f.runner.run({ taskId: 'task', requestKey: 'slow', kind: 'test', acceptanceId: 'check', command: f.command });
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(f.runner.run({ taskId: 'task', requestKey: 'conflict', kind: 'build', command: f.command }), /already locked/);
    const result = await pending;
    assert.equal(result.status, 'succeeded');
    const task = await f.runner.getTask('task');
    assert.equal(task.evidence[0].result, 'stale');
    assert.equal(task.acceptance[0].status, 'stale');
    assert.notEqual(task.status, 'passed');
  } finally { await f.runner.close(); }
});

test('timeout kills managed process and records failure, cancellation has terminal state', async () => {
  const f = await fixture();
  try {
    const command = { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 };
    const result = await f.runner.run({ taskId: 'task', requestKey: 'timeout', kind: 'build', command });
    assert.equal(result.status, 'failed');
    assert.match(result.failureReason!, /timeout/i);
    assert.equal(result.cleanup, 'confirmed');
    const pending = f.runner.run({ taskId: 'task', requestKey: 'cancel', kind: 'build', command: { ...command, timeoutMs: 10000 } });
    await new Promise(resolve => setTimeout(resolve, 150));
    const active = (await f.runner.getTask('task')).operations.at(-1)!;
    const cancelled = await f.runner.cancel(active.id);
    assert.equal(cancelled.status, 'interrupted');
    assert.equal((await pending).status, 'interrupted');
  } finally { await f.runner.close(); }
});

test('export allowlist redacts logs and excludes auth, commands and verifier definitions', async () => {
  const f = await fixture();
  try {
    const command = { executable: process.execPath, args: ['-e', "console.log('API_KEY=super-secret-value Bearer hidden-token sk-0123456789abcdef');console.log(JSON.stringify({access_token:'plain-token-value'}))"] };
    await f.runner.run({ taskId: 'task', requestKey: 'log', kind: 'build', command });
    await writeFile(path.join(f.project, 'auth.json'), '{"access_token":"never-export-this"}');
    const exported = await f.runner.exportTask('task', path.join(f.directory, 'export'));
    const manifest = await readFile(exported.manifest, 'utf8');
    const task = await f.runner.getTask('task');
    const log = await readFile(path.join(exported.path, 'logs', `${task.operations[0].id}.log`), 'utf8');
    assert.ok(!manifest.includes('args') || manifest.includes('argsDigest'));
    assert.ok(!manifest.includes(f.script));
    assert.ok(!manifest.includes('never-export-this'));
    assert.ok(!log.includes('super-secret-value'));
    assert.ok(!log.includes('hidden-token'));
    assert.ok(!log.includes('sk-0123456789abcdef'));
    assert.ok(!log.includes('plain-token-value'));
    assert.ok(log.includes('[REDACTED]'));
  } finally { await f.runner.close(); }
});

test('recovery turns unfinished operations unknown without replay', async () => {
  const f = await fixture();
  const passed = await f.runner.run({ taskId: 'task', requestKey: 'finished', kind: 'test', acceptanceId: 'check', command: f.command });
  await f.runner.close();
  const stateFile = path.join(f.data, 'engineering/state.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.tasks[0].operations[0].status = 'running';
  await writeFile(stateFile, JSON.stringify(state));
  const restarted = new EngineeringRunner({ dataDir: f.data });
  const task = await restarted.getTask('task');
  assert.equal(task.operations[0].status, 'unknown');
  assert.equal(task.operations[0].id, passed.id);
  assert.equal(task.operations.length, 1);
  assert.equal(task.acceptance[0].status, 'stale');
  await restarted.close();
});

test('rejects workspace-owned verifier and bounded traversal failure cannot pass', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.runner.setAcceptance('task', [{ id: 'unsafe', title: 'Unsafe', kind: 'automated', command: f.command,
      verifierFiles: [path.join(f.project, 'input.txt')] }]), /outside the model workspace/);
    await f.runner.close();
    const bounded = new EngineeringRunner({ dataDir: f.data, maxFingerprintFiles: 0 });
    const operation = await bounded.run({ taskId: 'task', requestKey: 'bounded', kind: 'test', acceptanceId: 'check', command: f.command });
    assert.equal(operation.status, 'failed');
    assert.match(operation.failureReason!, /file limit exceeded/);
    assert.notEqual((await bounded.getTask('task')).status, 'passed');
    await bounded.close();
  } finally { await f.runner.close(); }
});

test('trusted verifier and protected rule edits expire passing evidence', async () => {
  const f = await fixture();
  try {
    await f.runner.run({ taskId: 'task', requestKey: 'config-pass', kind: 'test', acceptanceId: 'check', command: f.command });
    await writeFile(f.script, (await readFile(f.script, 'utf8')) + '\n// User changed verifier revision\n');
    assert.equal((await f.runner.refresh('task')).acceptance[0].status, 'stale');
    await f.runner.run({ taskId: 'task', requestKey: 'reverified', kind: 'test', acceptanceId: 'check', command: f.command });
    const rules = path.join(f.data, 'engineering/verifiers/task.json');
    await writeFile(rules, (await readFile(rules, 'utf8')) + '\n');
    assert.equal((await f.runner.refresh('task')).acceptance[0].status, 'stale');
  } finally { await f.runner.close(); }
});

test('native Windows host kills a real grandchild on timeout', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    const host = path.join(root, 'vendor/process-host/process-host.exe');
    const grandchildFile = path.join(f.project, 'grandchild.pid');
    const program = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(grandchildFile)},String(c.pid));setInterval(()=>{},1000);`;
    const result = await execute({ executable: process.execPath, args: ['-e', program], cwd: f.project, timeoutMs: 2000 }, { cancelled: false }, host);
    assert.equal(result.timedOut, true, result.output);
    assert.equal(result.cleanup, 'confirmed');
    const pid = Number(await readFile(grandchildFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { process.kill(pid, 0); } catch { alive = false; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(alive, false, `Grandchild ${pid} survived Job Object closure`);
  } finally { await f.runner.close(); }
});

test('native supervisor absence fails without silently executing directly', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(execute({ executable: process.execPath, args: ['-e', 'process.exit(0)'], cwd: f.project },
      { cancelled: false }, path.join(f.directory, 'missing-host.exe')), /not found/);
  } finally { await f.runner.close(); }
});

test('a failing or cancelled later build overrides earlier passing acceptance', async () => {
  const f = await fixture();
  try {
    await f.runner.run({ taskId: 'task', requestKey: 'initial-pass', kind: 'test', acceptanceId: 'check', command: f.command });
    assert.equal((await f.runner.getTask('task')).status, 'passed');
    await f.runner.run({ taskId: 'task', requestKey: 'failed-build', kind: 'build', command: { executable: process.execPath, args: ['-e', 'process.exit(1)'] } });
    assert.equal((await f.runner.getTask('task')).status, 'failed');
    assert.equal((await f.runner.refresh('task')).status, 'failed');
    const pending = f.runner.run({ taskId: 'task', requestKey: 'cancel-build', kind: 'build', command: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const operation = (await f.runner.getTask('task')).operations.at(-1)!;
    await f.runner.cancel(operation.id);
    await pending;
    assert.equal((await f.runner.getTask('task')).status, 'interrupted');
    assert.equal((await f.runner.refresh('task')).status, 'interrupted');
  } finally { await f.runner.close(); }
});

test('A failure remains active until final evidence is complete', async () => {
  const f = await fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const finalizing = new Promise<void>(resolve => { entered = resolve; });
  const internal = f.runner as unknown as { configuration: (...args: unknown[]) => Promise<string> };
  const original = internal.configuration.bind(f.runner); let calls = 0;
  internal.configuration = async (...args) => {
    if (++calls === 2) { entered(); await gate; }
    return original(...args);
  };
  try {
    const pending = f.runner.run({ taskId: 'task', requestKey: 'finalizing-failure', kind: 'build',
      command: { executable: process.execPath, args: ['-e', 'process.exit(1)'] } });
    await finalizing;
    const active = await f.runner.getTask('task'); const operation = active.operations.at(-1)!;
    assert.equal(active.status, 'running'); assert.equal(operation.status, 'running');
    assert.equal(operation.phase, 'finalizing'); assert.equal(operation.completedAt, undefined);
    release(); const completed = await pending;
    assert.equal(completed.status, 'failed'); assert.ok(completed.completedAt); assert.ok(completed.evidenceId);
    assert.equal((await f.runner.getTask('task')).status, 'failed');
  } finally { release(); await f.runner.close(); }
});

test('A cancellation during finalization waits and cannot publish passing acceptance', async () => {
  const f = await fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const finalizing = new Promise<void>(resolve => { entered = resolve; });
  const internal = f.runner as unknown as { configuration: (...args: unknown[]) => Promise<string> };
  const original = internal.configuration.bind(f.runner); let calls = 0;
  internal.configuration = async (...args) => {
    if (++calls === 2) { entered(); await gate; }
    return original(...args);
  };
  try {
    const pending = f.runner.run({ taskId: 'task', requestKey: 'finalizing-cancel', kind: 'test', acceptanceId: 'check', command: f.command });
    await finalizing;
    const active = (await f.runner.getTask('task')).operations.at(-1)!;
    const cancelled = f.runner.cancel(active.id);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await f.runner.getTask('task')).operations.at(-1)!.status, 'stopping');
    release(); assert.equal((await cancelled).status, 'interrupted'); assert.equal((await pending).status, 'interrupted');
    const task = await f.runner.getTask('task');
    assert.equal(task.status, 'interrupted'); assert.equal(task.acceptance[0].status, 'failed');
    assert.equal(task.evidence.at(-1)!.result, 'failed');
  } finally { release(); await f.runner.close(); }
});

test('A log finalization IO error records unknown and durable duplicate never replays', async () => {
  const f = await fixture();
  const request = { taskId: 'task', requestKey: 'log-io-failure', kind: 'test' as const, acceptanceId: 'check', command: f.command };
  try {
    await writeFile(path.join(f.data, 'engineering/logs'), 'directory creation deliberately blocked');
    const result = await f.runner.run(request);
    assert.equal(result.status, 'unknown'); assert.ok(result.completedAt);
    assert.match(result.failureReason!, /Finalization error/);
    assert.equal((await f.runner.getTask('task')).status, 'needs_attention');
    await f.runner.close();
    const restarted = new EngineeringRunner({ dataDir: f.data });
    try {
      assert.equal((await restarted.run(request)).id, result.id);
      assert.equal((await restarted.getTask('task')).operations.length, 1);
      assert.equal((await restarted.getTask('task')).acceptance[0].status, 'failed');
    } finally { await restarted.close(); }
  } finally { await f.runner.close(); }
});
