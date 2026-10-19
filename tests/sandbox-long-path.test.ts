import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../packages/engineering-runner/processes.js';
import { CodexAdapter } from '../packages/engine-adapter/index.js';
import { createTaskSnapshot, runSnapshotCommands, SNAPSHOT_PROFILE_ID, receipt } from '../packages/engineering-runner/snapshots.js';
import type { EngineeringTask, Operation, RunnerOptions, SnapshotProfile, SnapshotIsolationReceipt } from '../packages/engineering-runner/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = 'export function average(values){return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : 0;}\n';

test('native snapshot SQLite long paths write output and really deny the equivalent protected input', { skip: process.platform !== 'win32' }, async t => {
  const cases = path.join(root, '.runner-tests'); await mkdir(cases, { recursive: true });
  const folder = await mkdtemp(path.join(cases, 'sqlite-long-'));
  const projectRoot = path.join(folder, 'source'); await mkdir(projectRoot);
  await writeFile(path.join(projectRoot, 'numbers.mjs'), source);
  const taskId = randomUUID(); const operationId = randomUUID();
  const minimal = path.join(folder, 'd', 'engineering', 'snapshots', taskId, operationId, 'output');
  assert.ok(minimal.length < 216, 'Fixture root must leave space for the reproduced 216-character output root');
  const dataDir = path.join(folder, 'd'.repeat(1 + 216 - minimal.length));
  const directory = path.join(dataDir, 'engineering'); const home = path.join(dataDir, 'home');
  await mkdir(directory, { recursive: true }); await mkdir(home);
  const engine = new CodexAdapter({ executable: path.join(root, 'vendor/codex/codex.exe'),
    processHost: path.join(root, 'vendor/process-host/process-host.exe'), home, onEvent: () => {} });
  t.after(() => engine.stop());
  await engine.start();
  const options: RunnerOptions = { dataDir, processHost: path.join(root, 'vendor/process-host/process-host.exe'),
    snapshotTemplateDirectory: path.join(root, 'engineering/templates/node-software-v1'),
    snapshotExecutionPolicy: cwd => engine.snapshotPolicy(cwd),
    snapshotSandbox: { executable: path.join(root, 'vendor/codex/codex.exe'), codexHome: home, mode: 'unelevated' } };
  const isolation: SnapshotIsolationReceipt = { schemaVersion: 1, method: 'engine-sandbox-write-denial',
    policyDigest: 'a'.repeat(64), projectRoot, protectedRoot: path.join(directory, 'snapshots'),
    verifiedAt: new Date().toISOString(), probeLogRef: 'module-fixture-not-admission', probeLogSha256: 'b'.repeat(64) };
  const profile: SnapshotProfile = { schemaVersion: 1, id: SNAPSHOT_PROFILE_ID, nodeExecutable: process.execPath, isolation,
    revision: 1, configuredAt: new Date().toISOString(), templateDirectory: options.snapshotTemplateDirectory!,
    trustedFiles: [], profileDigest: 'c'.repeat(64), sandbox: options.snapshotSandbox! };
  const task: EngineeringTask = { schemaVersion: 1, id: taskId, sessionId: taskId, projectRoot, title: 'Native SQLite path regression',
    status: 'draft', profileRevision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), acceptance: [], operations: [], evidence: [] };
  const operation: Operation = { schemaVersion: 1, id: operationId, taskId, requestKey: 'long-path-module', argsDigest: 'd'.repeat(64),
    kind: 'build', command: { executable: process.execPath, args: [] }, status: 'prepared', createdAt: new Date().toISOString(), cleanup: 'not-needed' };
  const { snapshot } = await createTaskSnapshot(task, operation, profile, directory, options, isolation, { cancelled: false });
  assert.equal(snapshot.outputRoot.length, 216);
  const nonce = randomUUID(); const database = path.join(snapshot.inputRoot, `.runner-os-probe-${nonce}.db`);
  assert.equal(database.length, 272);
  // This exact input path must be usable outside the sandbox; otherwise a length error could masquerade as denial.
  const control = await execute({ executable: process.execPath, args: ['-e',
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('CREATE TABLE probe(id INTEGER)');db.close();console.log('CONTROL_SQLITE_RECEIPT:'+JSON.stringify({schemaVersion:1,nonce:process.argv[2],created:true,wrote:true,closed:true}));",
    path.toNamespacedPath(database), nonce], cwd: snapshot.outputRoot, timeoutMs: 10000 }, { cancelled: false }, options.processHost);
  assert.equal(control.exitCode, 0, control.output);
  const directReceipt = receipt(control.output, 'CONTROL_SQLITE_RECEIPT:', nonce);
  assert.equal(directReceipt.wrote, true); assert.equal((await lstat(database)).isFile(), true);
  await unlink(database);
  for (const suffix of ['', '-journal', '-wal', '-shm']) await assert.rejects(lstat(database + suffix), { code: 'ENOENT' });
  const phases: string[] = [];
  const result = await runSnapshotCommands(profile, snapshot, options, { cancelled: false }, async phase => { phases.push(phase!); });
  assert.equal(result.result.exitCode, 0, result.output);
  assert.equal(snapshot.sandboxProbe?.passed, true);
  assert.equal(snapshot.sandboxProbe?.sqliteInputWriteDenied, true);
  assert.equal(snapshot.sandboxProbe?.sqliteOutputWriteAllowed, true);
  assert.equal(snapshot.sandboxProbe?.hostMarkersAbsent, true);
  assert.equal(snapshot.verifierReceipt?.passed, true);
  assert.deepEqual(snapshot.verifierReceipt?.checks, ['empty', 'nonempty', 'signed']);
  const outerLine = result.output.split(/\r?\n/).find(line => line.startsWith('FORGEDESK_SANDBOX_RECEIPT:'))!;
  const outer = JSON.parse(outerLine.slice('FORGEDESK_SANDBOX_RECEIPT:'.length));
  assert.equal(outer.facts.inputSqlite.opened, false); assert.equal(outer.facts.inputSqlite.created, false);
  assert.equal(outer.facts.outputSqlite.opened, true); assert.equal(outer.facts.outputSqlite.writeSucceeded, true);
  assert.equal(outer.facts.outputSqlite.closeSucceeded, true); assert.equal(outer.facts.outputSqlite.cleanupComplete, true);
  assert.equal(await readFile(path.join(snapshot.inputRoot, 'numbers.mjs'), 'utf8'), source);
  const evidence = path.join(root, 'output/runner-diagnostics/sqlite-long-path'); await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, `native-${path.basename(folder)}.json`), JSON.stringify({ schemaVersion: 1,
    scope: 'Main SID native runtime module regression only; not model admission or second-SID acceptance',
    outputRootLength: snapshot.outputRoot.length, inputSqlitePathLength: database.length, outputSqlitePathLength: snapshot.outputRoot.length + 57,
    directControl: directReceipt, phases, nativeProbe: outer, snapshot, artifacts: result.artifacts }, null, 2));
});
