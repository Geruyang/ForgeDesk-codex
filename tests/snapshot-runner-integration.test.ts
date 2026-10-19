import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, readdir, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '../packages/engine-adapter';
import { probeSnapshotIsolation } from '../packages/engine-adapter/snapshot-isolation';
import { EngineeringRunner } from '../packages/engineering-runner';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const corrected = 'export function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }\n';
const probeFilename = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;

async function preserveIsolationProbes(dataDir: string, projectRoot: string, protectedRoot: string, evidenceRoot: string) {
  const logRoot = path.join(dataDir, 'engineering/isolation-probes');
  let entries;
  try { entries = await readdir(logRoot, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  assert.equal(path.relative(logRoot, await realpath(logRoot)), '', 'Probe directory must not be redirected');
  const retained = [];
  for (const entry of entries.filter(entry => probeFilename.test(entry.name))) {
    const source = path.join(logRoot, entry.name); const info = await lstat(source);
    assert.ok(entry.isFile() && info.isFile() && !info.isSymbolicLink() && info.size <= 65536, 'Probe log must be a small ordinary file');
    const bytes = await readFile(source); const proof = JSON.parse(bytes.toString('utf8'));
    assert.equal(proof?.schemaVersion, 1); assert.equal(proof?.method, 'engine-sandbox-write-denial');
    assert.equal(proof.nonce, entry.name.slice(0, -5));
    assert.equal(path.relative(projectRoot, proof.projectRoot), ''); assert.equal(path.relative(protectedRoot, proof.protectedRoot), '');
    assert.equal(path.relative(path.join(protectedRoot, `.forgedesk-snapshot-isolation-${proof.nonce}.protected`), proof.attemptedPath), '');
    await mkdir(evidenceRoot, { recursive: true }); const destination = path.join(evidenceRoot, entry.name);
    await writeFile(destination, bytes, { flag: 'wx' });
    retained.push({ path: destination, sha256: createHash('sha256').update(bytes).digest('hex'),
      result: proof.writeDenied === true && proof.cleanupComplete === true && proof.failure === null ? 'confirmed-probe' : 'failed-unconfirmed',
      snapshotAcceptanceClaim: false });
  }
  return retained;
}

async function fixture(t: TestContext, source: string) {
  const base = path.join(root, '.runtime/qa-snapshot-integration'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'run-')); const projectRoot = path.join(directory, 'source'); const dataDir = path.join(directory, 'data');
  const home = path.join(dataDir, 'engine'); const protectedRoot = path.join(dataDir, 'engineering/snapshots');
  const executable = path.join(root, 'vendor/codex/codex.exe'); const processHost = path.join(root, 'vendor/process-host/process-host.exe');
  await mkdir(projectRoot); await mkdir(home, { recursive: true }); await mkdir(protectedRoot, { recursive: true });
  await writeFile(path.join(projectRoot, 'numbers.mjs'), source);
  let policyDigest = '';
  const engine = new CodexAdapter({ executable, home, processHost, onEvent: () => {} });
  const runner = new EngineeringRunner({ dataDir, processHost, snapshotTemplateDirectory: path.join(root, 'engineering/templates/node-software-v1'),
    snapshotPolicyDigest: () => policyDigest, snapshotExecutionPolicy: cwd => engine.snapshotPolicy(cwd),
    snapshotSandbox: { executable, codexHome: home, mode: 'unelevated' } });
  const record: Record<string, unknown> = { scope: 'Real native runner integration; no Electron, model turn, login or second SID', test: t.name, directory };
  t.after(async () => {
    const evidenceRoot = path.join(root, 'output/qa/snapshot-runner'); await mkdir(evidenceRoot, { recursive: true });
    let preservationError: unknown;
    try { record.nativeProbeLogs = await preserveIsolationProbes(dataDir, projectRoot, protectedRoot, path.join(evidenceRoot, path.basename(directory), 'isolation-probes')); }
    catch (error) { preservationError = error; record.probePreservationError = String(error); }
    await writeFile(path.join(evidenceRoot, `${path.basename(directory)}.json`), JSON.stringify(record, null, 2));
    await runner.close(); await engine.stop();
    const relative = path.relative(base, directory);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    await rm(directory, { recursive: true, force: true });
    if (preservationError) throw preservationError;
  });
  await engine.start(); await runner.createTask({ id: 'task', sessionId: 'session', projectRoot, title: t.name });
  const policy = await engine.snapshotPolicy(projectRoot);
  let isolation;
  try { isolation = await probeSnapshotIsolation({ projectRoot, protectedRoot, dataDir, home, executable, processHost,
    nodeExecutable: process.execPath, policy, currentGeneration: () => engine.connectionGeneration }); }
  catch (error) { record.setupFailure = { phase: 'native-isolation-admission', message: String(error), accepted: false }; throw error; }
  policyDigest = isolation.policyDigest;
  const proof = JSON.parse(await readFile(isolation.probeLogRef, 'utf8')); assert.equal(proof.writeDenied, true); assert.equal(proof.cleanupComplete, true);
  record.isolation = isolation; record.realNativeProof = proof;
  await runner.setSnapshotProfile('task', { id: 'forgedesk.node-software.v1', nodeExecutable: process.execPath, isolation });
  return { directory, projectRoot, dataDir, runner, isolation, record };
}

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(10); }
  throw new Error('Independent snapshot integration observation timed out');
}

test('external workspace edits during real snapshot verification stale current acceptance without changing the checked input', { skip: process.platform !== 'win32' }, async t => {
  const source = 'export function average(values) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }\n';
  const f = await fixture(t, source);
  const pending = f.runner.runSnapshotBuild('task', 'external-during-verification', f.isolation);
  await waitFor(async () => (await f.runner.getTask('task')).operations.at(-1)?.phase === 'verifying');
  const changed = source + '// independent QA external edit during operation\n';
  await writeFile(path.join(f.projectRoot, 'numbers.mjs'), changed);
  const operation = await pending; const task = await f.runner.getTask('task');
  f.record.operation = operation; f.record.task = task;
  assert.equal(operation.status, 'succeeded'); assert.equal(operation.snapshot?.verificationResult, 'passed');
  assert.equal(task.evidence.at(-1)?.evidenceLevel, 'B'); assert.equal(task.evidence.at(-1)?.result, 'stale');
  assert.equal(task.acceptance.find(item => item.id === 'snapshot-software')?.status, 'stale'); assert.notEqual(task.status, 'passed');
  assert.equal(task.evidence.at(-1)?.sourceBefore.gitCommit, null); assert.equal(task.evidence.at(-1)?.sourceBefore.dirtyDiffDigest, null);
  assert.equal(await readFile(path.join(operation.snapshot!.inputRoot, 'numbers.mjs'), 'utf8'), source);
  assert.equal(await readFile(path.join(operation.snapshot!.outputRoot, 'numbers.mjs'), 'utf8'), source);
  assert.equal(await readFile(path.join(f.projectRoot, 'numbers.mjs'), 'utf8'), changed);
});

test('real public runner refuses a source change observed during byte copying before any snapshot command executes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, corrected);
  await writeFile(path.join(f.projectRoot, 'a-large-input.bin'), Buffer.alloc(32 * 1024 * 1024, 7));
  const pending = f.runner.runSnapshotBuild('task', 'external-during-copy', f.isolation);
  let operationId = '';
  await waitFor(async () => {
    operationId = (await f.runner.getTask('task')).operations.at(-1)?.id ?? '';
    if (!operationId) return false;
    try { return (await lstat(path.join(f.dataDir, 'engineering/snapshots/task', operationId, 'input/a-large-input.bin'))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  });
  await writeFile(path.join(f.projectRoot, 'numbers.mjs'), corrected + '// concurrent copy edit\n');
  const operation = await pending; const task = await f.runner.getTask('task');
  f.record.operation = operation; f.record.task = task;
  assert.equal(operation.status, 'failed'); assert.match(operation.failureReason!, /copy differed|changed while copying|changed while fingerprinting/i);
  assert.equal(operation.snapshot?.sandboxProbe, undefined); assert.equal(operation.snapshot?.verifierReceipt, undefined);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'engineering/snapshots/task', operationId, 'output')), []);
  assert.notEqual(task.status, 'passed'); assert.equal(task.evidence.some(item => item.result === 'passed'), false);
});

async function retentionFixture(t: TestContext) {
  const base = path.join(root, 'output/hardware/2026-10-16-next/qa/probe-retention-fixtures'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-')); const projectRoot = path.join(directory, 'source');
  const dataDir = path.join(directory, 'data'); const protectedRoot = path.join(dataDir, 'engineering/snapshots');
  const logRoot = path.join(dataDir, 'engineering/isolation-probes'); const evidenceRoot = path.join(directory, 'retained');
  await mkdir(projectRoot); await mkdir(protectedRoot, { recursive: true }); await mkdir(logRoot, { recursive: true });
  t.after(async () => { const relative = path.relative(base, directory); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await rm(directory, { recursive: true, force: true }); });
  const nonce = '9c139a66-88a4-4104-9e0b-89a65831985f';
  const proof = { schemaVersion: 1, method: 'engine-sandbox-write-denial', nonce, projectRoot, protectedRoot,
    attemptedPath: path.join(protectedRoot, `.forgedesk-snapshot-isolation-${nonce}.protected`),
    writeDenied: false, observedWriteDenied: false, workspaceWritten: false, cleanupComplete: true,
    probe: { timedOut: true, code: null, signal: 'SIGTERM', report: null }, failure: 'Native snapshot write-denial probe was not confirmed' };
  return { directory, dataDir, projectRoot, protectedRoot, logRoot, evidenceRoot, nonce, proof };
}

test('probe retention preserves original failed JSON bytes without claiming acceptance or reading other filenames', async t => {
  const f = await retentionFixture(t); const bytes = Buffer.from(JSON.stringify(f.proof, null, 2) + '\n');
  await writeFile(path.join(f.logRoot, `${f.nonce}.json`), bytes);
  await writeFile(path.join(f.logRoot, 'auth.json'), 'not JSON; this file must never be read');
  const files = await preserveIsolationProbes(f.dataDir, f.projectRoot, f.protectedRoot, f.evidenceRoot);
  assert.equal(files.length, 1); assert.equal(files[0].result, 'failed-unconfirmed'); assert.equal(files[0].snapshotAcceptanceClaim, false);
  assert.equal(files[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(files[0].path), bytes); assert.deepEqual(await readdir(f.evidenceRoot), [`${f.nonce}.json`]);
});

test('probe retention rejects a JSON bound to a different workspace before copying', async t => {
  const f = await retentionFixture(t);
  await writeFile(path.join(f.logRoot, `${f.nonce}.json`), JSON.stringify({ ...f.proof, projectRoot: f.directory }));
  await assert.rejects(preserveIsolationProbes(f.dataDir, f.projectRoot, f.protectedRoot, f.evidenceRoot), /AssertionError/);
  await assert.rejects(lstat(f.evidenceRoot), { code: 'ENOENT' });
});

test('probe retention rejects an allowed-name reparse point without following it', async t => {
  const f = await retentionFixture(t); const target = path.join(f.directory, 'unrelated'); await mkdir(target);
  await writeFile(path.join(target, 'private-marker.txt'), 'must not be inspected');
  await symlink(target, path.join(f.logRoot, `${f.nonce}.json`), 'junction');
  await assert.rejects(preserveIsolationProbes(f.dataDir, f.projectRoot, f.protectedRoot, f.evidenceRoot), /small ordinary file/);
  await assert.rejects(lstat(f.evidenceRoot), { code: 'ENOENT' });
});
