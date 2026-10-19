import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, lstat, link, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskSnapshot, validateTaskSnapshot, contentDigest, nodeCommand, receipt, runSnapshotCommands, assertSandboxMarkersAbsent, SNAPSHOT_PROFILE_ID } from './snapshots.js';
import { fingerprint, hashFile } from './fingerprint.js';
import { execute } from './processes.js';
import { EngineeringRunner } from './index.js';
import { CodexAdapter } from '../engine-adapter/index.js';
import { probeSnapshotIsolation } from '../engine-adapter/snapshot-isolation.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EngineeringTask, Operation, RunnerOptions, SnapshotProfile, SnapshotIsolationReceipt } from './types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const templateDirectory = path.join(root, 'engineering/templates/node-software-v1');
const fixedSource = 'export function average(values){ return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : 0; }\n';

async function fixture() {
  const cases = path.join(root, '.runner-tests'); await mkdir(cases, { recursive: true });
  const folder = await mkdtemp(path.join(cases, 'snapshot-'));
  const projectRoot = path.join(folder, 'workspace'); const dataDir = path.join(folder, 'private');
  const directory = path.join(dataDir, 'engineering'); const codexHome = path.join(dataDir, 'snapshot-sandbox-home');
  await mkdir(projectRoot); await mkdir(directory, { recursive: true }); await mkdir(codexHome);
  await writeFile(path.join(projectRoot, 'numbers.mjs'), fixedSource);
  const isolation: SnapshotIsolationReceipt = { schemaVersion: 1, method: 'engine-sandbox-write-denial',
    policyDigest: 'a'.repeat(64), projectRoot, protectedRoot: path.join(directory, 'snapshots'), verifiedAt: new Date().toISOString(),
    probeLogRef: path.join(dataDir, 'unit-proof-not-an-admission.json'), probeLogSha256: 'b'.repeat(64) };
  // Module fixtures bypass admission; they are not evidence of an actual model policy/config-read probe.
  const profile: SnapshotProfile = { schemaVersion: 1, id: SNAPSHOT_PROFILE_ID, nodeExecutable: process.execPath, isolation,
    revision: 1, configuredAt: new Date().toISOString(), templateDirectory, trustedFiles: [], profileDigest: 'c'.repeat(64),
    sandbox: { executable: path.join(root, 'vendor/codex/codex.exe'), codexHome, mode: 'unelevated' } };
  const task: EngineeringTask = { schemaVersion: 1, id: 'fixture', projectRoot, sessionId: 'fixture', title: 'Module snapshot fixture',
    status: 'draft', profileRevision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), acceptance: [], operations: [], evidence: [] };
  const operation: Operation = { schemaVersion: 1, id: 'operation-one', taskId: task.id, requestKey: 'unit', argsDigest: 'd'.repeat(64),
    kind: 'build', command: { executable: process.execPath, args: [] }, status: 'prepared', createdAt: new Date().toISOString(), cleanup: 'not-needed' };
  const options: RunnerOptions = { dataDir, processHost: path.join(root, 'vendor/process-host/process-host.exe'), snapshotTemplateDirectory: templateDirectory, snapshotSandbox: profile.sandbox };
  return { folder, task, profile, operation, options, directory, isolation };
}

test('snapshot copies complete ignored/untracked/binary/empty-directory inputs and detaches hardlinks', async () => {
  const f = await fixture();
  await writeFile(path.join(f.task.projectRoot, '.gitignore'), '*.bin\nignored-source.txt\n');
  await writeFile(path.join(f.task.projectRoot, 'ignored-source.txt'), 'required ignored source');
  await writeFile(path.join(f.task.projectRoot, 'binary.bin'), Buffer.from([0, 255, 1, 0]));
  await mkdir(path.join(f.task.projectRoot, 'empty-directory'));
  await mkdir(path.join(f.task.projectRoot, '.git'));
  await writeFile(path.join(f.task.projectRoot, '.git', 'derived.txt'), 'excluded metadata');
  await link(path.join(f.task.projectRoot, 'numbers.mjs'), path.join(f.task.projectRoot, 'numbers-link.mjs'));
  const { snapshot, before } = await createTaskSnapshot(f.task, f.operation, f.profile, f.directory, { ...f.options, excludedGeneratedDirs: ['empty-directory'] }, f.isolation, { cancelled: false });
  assert.ok(before.files.some(file => file.path === 'ignored-source.txt'));
  assert.ok(before.files.some(file => file.path === 'binary.bin'));
  assert.ok(before.directories?.includes('empty-directory'));
  assert.ok(!before.files.some(file => file.path.startsWith('.git/')));
  assert.deepEqual(await readFile(path.join(snapshot.inputRoot, 'binary.bin')), Buffer.from([0, 255, 1, 0]));
  assert.equal((await lstat(path.join(snapshot.inputRoot, 'empty-directory'))).isDirectory(), true);
  assert.equal((await lstat(path.join(snapshot.inputRoot, 'numbers-link.mjs'))).nlink, 1);
  const copied = await fingerprint(snapshot.inputRoot, f.options, false);
  assert.equal(contentDigest(copied), snapshot.contentDigest);
  await assert.rejects(createTaskSnapshot(f.task, f.operation, f.profile, f.directory, f.options, f.isolation, { cancelled: false }), /EEXIST/);
});

test('changed source during copying rejects instead of executing a mixed snapshot', async () => {
  const f = await fixture();
  await writeFile(path.join(f.task.projectRoot, 'aaa.txt'), 'first copied input');
  const source = path.join(f.task.projectRoot, 'numbers.mjs');
  await assert.rejects(createTaskSnapshot(f.task, f.operation, f.profile, f.directory, f.options, f.isolation, { cancelled: false }, async relative => {
    if (relative === 'aaa.txt') await writeFile(source, fixedSource + '// changed before this file was copied\n');
  }), /copy differed/);
  await writeFile(source, fixedSource);
  assert.equal((await readFile(source, 'utf8')), fixedSource);
});

test('snapshot input/manifest mutation and source junctions fail closed', async () => {
  const f = await fixture();
  const { snapshot } = await createTaskSnapshot(f.task, f.operation, f.profile, f.directory, f.options, f.isolation, { cancelled: false });
  await validateTaskSnapshot(snapshot, f.directory, f.options);
  await writeFile(path.join(snapshot.inputRoot, 'added-source.txt'), 'tampered');
  await assert.rejects(validateTaskSnapshot(snapshot, f.directory, f.options), /input changed/);
  const other = await fixture(); const external = path.join(other.folder, 'external'); await mkdir(external);
  await symlink(external, path.join(other.task.projectRoot, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createTaskSnapshot(other.task, other.operation, other.profile, other.directory, other.options, other.isolation, { cancelled: false }), /links|junctions/i);
});

test('real Node permissions deny input writes, child/worker/addon/WASI/inspector and verifier output writes', async () => {
  const f = await fixture(); const { snapshot } = await createTaskSnapshot(f.task, f.operation, f.profile, f.directory, f.options, f.isolation, { cancelled: false });
  for (const stage of ['build', 'verify'] as const) {
    const nonce = 'permission-' + stage;
    const command = nodeCommand(f.profile, snapshot, 'permission-probe.mjs', nonce, stage);
    const result = await execute(command, { cancelled: false }, f.options.processHost);
    assert.equal(result.exitCode, 0, result.output);
    const probe = receipt(result.output, 'FORGEDESK_PERMISSION_RECEIPT:', nonce);
    assert.equal(probe.passed, true);
    assert.equal(probe.inputWriteDenied, true);
    assert.equal(probe.inspectorDenied, true);
    assert.equal(probe.outputWriteAllowed, stage === 'build');
    assert.equal(probe.outputWriteDenied, stage === 'verify');
  }
});

test('zero exit without completed trusted verifier receipt fails', async () => {
  const f = await fixture(); const { snapshot } = await createTaskSnapshot(f.task, f.operation, f.profile, f.directory, f.options, f.isolation, { cancelled: false });
  await writeFile(path.join(snapshot.outputRoot, 'numbers.mjs'), 'process.exit(0); export function average(){return 0}\n');
  const result = await execute(nodeCommand(f.profile, snapshot, 'verify.mjs', 'early-exit'), { cancelled: false }, f.options.processHost);
  assert.equal(result.exitCode, 0);
  assert.throws(() => receipt(result.output, 'FORGEDESK_TEST_RECEIPT:', 'early-exit'), /complete execution receipt/);
});

test('host rejects leftover markers and SQLite auxiliary files independently of a passed child receipt', async () => {
  const f = await fixture(); const { snapshot } = await createTaskSnapshot(f.task, f.operation, f.profile, f.directory, f.options, f.isolation, { cancelled: false });
  const nonce = 'host-marker-check';
  await assertSandboxMarkersAbsent(f.profile, snapshot, nonce);
  const child = receipt(`FORGEDESK_SANDBOX_RECEIPT:${JSON.stringify({ schemaVersion: 1, nonce, passed: true })}`, 'FORGEDESK_SANDBOX_RECEIPT:', nonce);
  assert.equal(child.passed, true);
  await writeFile(path.join(snapshot.inputRoot, `.runner-os-probe-${nonce}`), 'write happened before failed cleanup');
  await assert.rejects(assertSandboxMarkersAbsent(f.profile, snapshot, nonce), /left a marker/);
  const sqliteNonce = 'host-sqlite-check';
  await writeFile(path.join(snapshot.outputRoot, `.runner-os-probe-${sqliteNonce}.db-wal`), 'partial sqlite output');
  await assert.rejects(assertSandboxMarkersAbsent(f.profile, snapshot, sqliteNonce), /SQLite file/);
});

test('native Windows snapshot sandbox really blocks fs/sqlite writes outside separate output and executes all checks', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); const { snapshot } = await createTaskSnapshot(f.task, f.operation, f.profile, f.directory, f.options, f.isolation, { cancelled: false });
  const engine = new CodexAdapter({ executable: f.profile.sandbox.executable, home: f.profile.sandbox.codexHome, processHost: f.options.processHost!, onEvent: () => {} });
  try {
  await engine.start(); f.options.snapshotExecutionPolicy = cwd => engine.snapshotPolicy(cwd);
  const phases: string[] = [];
  const result = await runSnapshotCommands(f.profile, snapshot, f.options, { cancelled: false }, async phase => { phases.push(phase!); });
  assert.equal(result.result.exitCode, 0, result.output);
  assert.equal(snapshot.sandboxProbe?.passed, true);
  assert.equal(snapshot.sandboxProbe?.hostMarkersAbsent, true);
  assert.equal(snapshot.sandboxProbe?.sqliteInputWriteDenied, true);
  assert.equal(snapshot.sandboxProbe?.sqliteOutputWriteAllowed, true);
  assert.equal(snapshot.verifierReceipt?.passed, true);
  assert.deepEqual(snapshot.verifierReceipt?.checks, ['empty', 'nonempty', 'signed']);
  assert.equal(result.artifacts[0].sha256, (await hashFile(path.join(snapshot.inputRoot, 'numbers.mjs'))).sha256);
  assert.ok(phases.includes('sandbox_probe') && phases.includes('building') && phases.includes('verifying'));
  await validateTaskSnapshot(snapshot, f.directory, f.options);
  await writeFile(path.join(f.folder, 'native-runtime-receipts.json'), JSON.stringify({ schemaVersion: 1,
    scope: 'module native runtime test; model config-read/isolation admission is independently tested by integration QA',
    phases, output: result.output, sandboxProbe: snapshot.sandboxProbe, permissionProbe: snapshot.permissionProbe,
    verifierReceipt: snapshot.verifierReceipt, artifact: result.artifacts[0], snapshot }, null, 2));
  } finally { await engine.stop(); }
});

test('B failure/cancellation finalization is atomic and IO failure remains unknown across durable retry', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); const cli = f.profile.sandbox.executable; const host = f.options.processHost!;
  const home = path.join(f.options.dataDir, 'engine'); await mkdir(home);
  const engine = new CodexAdapter({ executable: cli, home, processHost: host, onEvent: () => {} });
  let policyDigest = ''; const options = { ...f.options, snapshotSandbox: { ...f.profile.sandbox, codexHome: home }, snapshotPolicyDigest: () => policyDigest, snapshotExecutionPolicy: (cwd: string) => engine.snapshotPolicy(cwd) };
  let runner = new EngineeringRunner(options);
  let release: (() => void) | undefined;
  try {
    await runner.createTask({ id: 'fixture', projectRoot: f.task.projectRoot, sessionId: 'fixture', title: 'B finalization' });
    await mkdir(path.join(f.directory, 'snapshots'), { recursive: true });
    await engine.start(); const policy = await engine.snapshotPolicy(f.task.projectRoot);
    const isolation = await probeSnapshotIsolation({ projectRoot: f.task.projectRoot, protectedRoot: path.join(f.directory, 'snapshots'),
      dataDir: f.options.dataDir, home, executable: cli, processHost: host, nodeExecutable: process.execPath, policy,
      currentGeneration: () => engine.connectionGeneration });
    policyDigest = isolation.policyDigest;
    await runner.setSnapshotProfile('fixture', { id: SNAPSHOT_PROFILE_ID, nodeExecutable: process.execPath, isolation });
    const internal = runner as unknown as { completeOperation: (...args: any[]) => Promise<void>; save: () => Promise<void> };
    const original = internal.completeOperation.bind(runner);
    for (const kind of ['failed', 'cancelled'] as const) {
      await writeFile(path.join(f.task.projectRoot, 'numbers.mjs'), kind === 'failed'
        ? 'export function average(values){return values.reduce((sum,value)=>sum+value)/values.length;}\n' : fixedSource);
      let entered!: () => void; const finalizing = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      internal.completeOperation = async (...args) => { entered(); await gate; return original(...args); };
      const pending = runner.runSnapshotBuild('fixture', 'b-finalizing-' + kind, isolation);
      await finalizing;
      const task = await runner.getTask('fixture'); const active = task.operations.at(-1)!;
      assert.equal(task.status, 'running'); assert.equal(active.status, 'running');
      assert.equal(active.phase, 'finalizing'); assert.equal(active.completedAt, undefined);
      if (kind === 'cancelled') {
        const cancelled = runner.cancel(active.id);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal((await runner.getTask('fixture')).operations.at(-1)!.status, 'stopping');
        release!(); assert.equal((await cancelled).status, 'interrupted');
      } else release!();
      const completed = await pending;
      assert.equal(completed.status, kind === 'failed' ? 'failed' : 'interrupted'); assert.ok(completed.completedAt);
      assert.equal((await runner.getTask('fixture')).acceptance[0].status, 'failed');
      assert.equal((await runner.getTask('fixture')).evidence.at(-1)!.result, 'failed');
    }
    internal.completeOperation = original;
    const save = internal.save.bind(runner);
    internal.save = async () => {
      await save();
      const operation = (await runner.getTask('fixture')).operations.at(-1)!;
      if (operation.requestKey === 'b-log-io-failure' && operation.phase === 'verifying') await mkdir(operation.logRef!, { recursive: true });
    };
    const unknown = await runner.runSnapshotBuild('fixture', 'b-log-io-failure', isolation);
    assert.equal(unknown.status, 'unknown'); assert.ok(unknown.completedAt);
    assert.match(unknown.failureReason!, /Finalization error/);
    assert.equal((await runner.getTask('fixture')).status, 'needs_attention');
    await runner.close(); runner = new EngineeringRunner(options);
    const repeated = await runner.runSnapshotBuild('fixture', 'b-log-io-failure', { ...isolation, probeLogRef: 'not-read-on-dedup' });
    assert.equal(repeated.id, unknown.id); assert.equal(repeated.status, 'unknown');
    assert.equal((await runner.getTask('fixture')).operations.length, 3);
    await writeFile(path.join(f.folder, 'finalization-receipts.json'), JSON.stringify({ schemaVersion: 1, isolation,
      operations: (await runner.getTask('fixture')).operations, unknown, repeated }, null, 2));
  } finally { release?.(); await runner.close(); await engine.stop(); }
});

test('real model receipt enables mixed A+B acceptance, durable dedup and unknown recovery without replay', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); const cli = f.profile.sandbox.executable; const host = f.options.processHost!;
  const home = path.join(f.options.dataDir, 'engine'); await mkdir(home);
  const engine = new CodexAdapter({ executable: cli, home, processHost: host, onEvent: () => {} });
  let policyDigest = '';
  const options = { ...f.options, snapshotSandbox: { ...f.profile.sandbox, codexHome: home }, snapshotPolicyDigest: () => policyDigest, snapshotExecutionPolicy: (cwd: string) => engine.snapshotPolicy(cwd) };
  let runner = new EngineeringRunner(options);
  try {
    const git = promisify(execFile);
    await git('git', ['init', f.task.projectRoot]); await git('git', ['-C', f.task.projectRoot, 'add', '.']);
    await git('git', ['-C', f.task.projectRoot, '-c', 'user.name=ForgeDesk fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'mixed evidence fixture']);
    await runner.createTask({ id: 'fixture', projectRoot: f.task.projectRoot, sessionId: 'fixture', title: 'Mixed A and B' });
    const verifier = path.join(f.folder, 'a-verifier.mjs');
    await writeFile(verifier, "import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';const {average}=await import(pathToFileURL(path.join(process.argv[2],'numbers.mjs')).href);assert.equal(average([]),0);assert.equal(average([2,4,6]),4);console.log('A checks passed');");
    const command = { executable: process.execPath, args: [verifier, f.task.projectRoot] };
    await runner.setAcceptance('fixture', [{ id: 'ordinary-a', title: 'A acceptance', kind: 'automated', command, verifierFiles: [verifier] }]);
    await mkdir(path.join(f.directory, 'snapshots'), { recursive: true });
    await engine.start(); const policy = await engine.snapshotPolicy(f.task.projectRoot);
    const isolation = await probeSnapshotIsolation({ projectRoot: f.task.projectRoot, protectedRoot: path.join(f.directory, 'snapshots'),
      dataDir: f.options.dataDir, home, executable: cli, processHost: host, nodeExecutable: process.execPath, policy,
      currentGeneration: () => engine.connectionGeneration });
    policyDigest = isolation.policyDigest;
    const configured = await runner.setSnapshotProfile('fixture', { id: SNAPSHOT_PROFILE_ID, nodeExecutable: process.execPath, isolation });
    assert.equal(configured.snapshotProfile?.revision, 1);
    assert.equal(configured.acceptance.length, 2);
    await assert.rejects(runner.setAcceptance('fixture', [{ id: 'snapshot-software', title: 'spoof', kind: 'manual' }]), /cannot be supplied/);
    await runner.run({ taskId: 'fixture', requestKey: 'a-pass', kind: 'test', acceptanceId: 'ordinary-a', command });
    const built = await runner.runSnapshotBuild('fixture', 'b-pass', isolation);
    assert.equal(built.status, 'succeeded', built.failureReason);
    const mixed = await runner.refresh('fixture');
    assert.equal(mixed.status, 'passed');
    assert.ok(mixed.acceptance.every(item => item.status === 'passed'));
    assert.ok(mixed.evidence.some(item => item.evidenceLevel === 'A' && item.sourceBefore.gitCommit));
    const b = mixed.evidence.find(item => item.evidenceLevel === 'B')!;
    assert.equal(b.sourceBefore.gitCommit, null); assert.equal(b.sourceBefore.dirtyDiffDigest, null);
    assert.equal(b.snapshot?.verificationResult, 'passed');
    const repeated = await runner.runSnapshotBuild('fixture', 'b-pass', { ...isolation, probeLogRef: 'missing proof on dedup must not be read' });
    assert.equal(repeated.id, built.id); assert.equal((await runner.getTask('fixture')).operations.length, 2);
    await runner.run({ taskId: 'fixture', requestKey: 'a-pass-again', kind: 'test', acceptanceId: 'ordinary-a', command });
    assert.equal((await runner.refresh('fixture')).status, 'passed');
    await engine.stop(); policyDigest = '';
    const disconnected = await runner.refresh('fixture');
    assert.equal(disconnected.acceptance.find(item => item.id === 'snapshot-software')?.status, 'stale');
    assert.equal(disconnected.evidence.find(item => item.id === b.id)?.snapshot?.verificationResult, 'passed', 'Historical execution proof is retained, but unavailable current cwd policy is not guessed');
    await engine.start();
    assert.equal((await runner.refresh('fixture')).acceptance.find(item => item.id === 'snapshot-software')?.status, 'stale', 'Reconnection does not automatically resurrect stale acceptance');
    await runner.close(); runner = new EngineeringRunner(options);
    assert.equal((await runner.runSnapshotBuild('fixture', 'b-pass')).id, built.id);
    assert.equal((await runner.getTask('fixture')).operations.length, 3);
    await runner.close();
    const stateFile = path.join(f.directory, 'state.json'); const state = JSON.parse(await readFile(stateFile, 'utf8'));
    state.tasks[0].operations.find((operation: Operation) => operation.id === built.id).status = 'running';
    await writeFile(stateFile, JSON.stringify(state)); runner = new EngineeringRunner(options);
    const unknown = await runner.runSnapshotBuild('fixture', 'b-pass');
    assert.equal(unknown.status, 'unknown'); assert.equal(unknown.id, built.id);
    assert.equal((await runner.getTask('fixture')).operations.length, 3);
    assert.equal((await runner.getTask('fixture')).status, 'needs_attention');
    await writeFile(path.join(f.folder, 'public-api-receipts.json'), JSON.stringify({ schemaVersion: 1, isolation,
      built, mixedEvidence: mixed.evidence, duplicateOperation: repeated.id, recoveredOperation: unknown }, null, 2));
  } finally { await runner.close(); await engine.stop(); }
});
