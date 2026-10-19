import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { digest, inside } from './fingerprint.js';
import { boundedLog, containmentLimitation, redact } from './redaction.js';
import { executionPolicyDigest, nodeCommand, readSnapshotExecutionPolicy, SNAPSHOT_ACCEPTANCE_ID, SNAPSHOT_LIMITATION, validateSnapshotExecutionPolicies } from './snapshots.js';
import { WORKSPACE_PERMISSION_PROFILE_ID, workspaceSandboxArgs } from '../engine-adapter/workspace-policy.js';
import type { SnapshotPolicyEvidence } from '../engine-adapter/snapshot-isolation.js';
import type { CommandSpec, RunnerOptions, SnapshotExecutionPolicy, SnapshotExecutionStagePolicy, SnapshotProfile, TaskSnapshot } from './types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = 'a'.repeat(64);

async function fixture() {
  const parent = path.join(root, 'output/software-audit-20261019/engine/snapshot-policy-fixtures'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'policy-'));
  const home = path.join(directory, 'private', 'engine'); const outputRoot = path.join(directory, 'private', 'output');
  const inputRoot = path.join(directory, 'private', 'input'); const projectRoot = path.join(directory, 'workspace');
  for (const folder of [home, outputRoot, inputRoot, projectRoot]) await mkdir(folder, { recursive: true });
  const isolation = { schemaVersion: 1 as const, method: 'engine-sandbox-write-denial' as const, policyDigest: hash, projectRoot, protectedRoot: inputRoot, verifiedAt: new Date().toISOString(), probeLogRef: '', probeLogSha256: hash };
  const profile: SnapshotProfile = { schemaVersion: 1, id: 'forgedesk.node-software.v1', nodeExecutable: process.execPath, isolation, revision: 1, configuredAt: new Date().toISOString(), templateDirectory: path.join(root, 'engineering/templates/node-software-v1'), trustedFiles: [], profileDigest: hash, sandbox: { executable: path.join(root, 'vendor/codex/codex.exe'), codexHome: home, mode: 'unelevated' } };
  const snapshot: TaskSnapshot = { schemaVersion: 1, id: 'unit-op', taskId: 'unit-task', operationId: 'unit-op', createdAt: new Date().toISOString(), inputRoot, outputRoot, manifestPath: path.join(directory, 'manifest.json'), manifestDigest: hash, contentDigest: hash, sourceInputDigest: hash, profileId: profile.id, profileRevision: 1, isolation, verificationResult: 'passed' };
  const policy = (): SnapshotPolicyEvidence => ({ schemaVersion: 1, method: 'app-server/config-read', generation: 7, observedAt: new Date().toISOString(), projectRoot: outputRoot, home, effectivePolicySha256: hash, managedPolicySha256: 'b'.repeat(64) });
  const options: RunnerOptions = { dataDir: path.join(directory, 'private'), processHost: 'unit-job-host-not-executed', snapshotExecutionPolicy: async () => policy() };
  return { directory, home, projectRoot, profile, snapshot, policy, options };
}

function sourceFunction(file: string, name: string, method = false): string {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const node = method
    ? source.statements.filter(ts.isClassDeclaration).flatMap(value => [...value.members]).find(value => ts.isMethodDeclaration(value) && value.name.getText(source) === name)
    : source.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(node);
  const text = node.getText(source).replace(/^export\s+/, '').replace(/^private\s+/, '');
  const expression = method ? text.replace(/^(async\s+)?/, (_, async = '') => `${async}function `) : text;
  return ts.transpileModule(`var invoke = ${expression};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText + '\ninvoke;';
}

function sandboxHarness(execute: (...args: any[]) => Promise<any>) {
  const sandboxCommand = (profile: SnapshotProfile, command: CommandSpec) => ({ executable: profile.sandbox.executable, args: [...workspaceSandboxArgs(profile.sandbox.mode), command.executable, ...command.args], cwd: command.cwd, timeoutMs: command.timeoutMs });
  return runInNewContext(sourceFunction('./snapshots.ts', 'sandboxExecute'), { path, digest, workspaceSandboxArgs, WORKSPACE_PERMISSION_PROFILE_ID, sandboxCommand, readSnapshotExecutionPolicy, executionPolicyDigest, execute }) as typeof import('./snapshots.js').sandboxExecute;
}

const processResult = () => ({ exitCode: 0, signal: null, output: 'unit output', cancelled: false, timedOut: false, cleanup: 'confirmed' as const });

test('sandbox command uses the shared fixed profile, actual output cwd, Job host and unchanged 30s deadline', async () => {
  const f = await fixture(); const order: string[] = []; const audits: SnapshotExecutionPolicy[] = [];
  f.options.snapshotExecutionPolicy = async cwd => { assert.equal(cwd, f.snapshot.outputRoot); order.push('policy'); return f.policy(); };
  const execute = sandboxHarness(async (command, _control, host, env) => {
    order.push('execute'); assert.equal(command.cwd, f.snapshot.outputRoot); assert.equal(command.timeoutMs, 30000);
    assert.equal(host, f.options.processHost); assert.equal(env.CODEX_HOME, f.home);
    assert.deepEqual([...command.args.slice(0, workspaceSandboxArgs().length)], workspaceSandboxArgs());
    assert.equal(command.args[command.args.indexOf('--permission-profile') + 1], WORKSPACE_PERMISSION_PROFILE_ID);
    return processResult();
  });
  const result = await execute(f.profile, nodeCommand(f.profile, f.snapshot, 'build.mjs', 'unit'), { cancelled: false }, f.options, audit => { audits.push(audit); });
  assert.equal(result.exitCode, 0); assert.deepEqual(order, ['policy', 'execute', 'policy']);
  assert.equal(audits[0].status, 'verified'); assert.equal(audits[0].before?.generation, audits[0].after?.generation);
});

test('missing, stale, malformed or other-cwd/home policy evidence prevents execution', async () => {
  const f = await fixture(); let executed = 0;
  const execute = sandboxHarness(async () => { executed++; return processResult(); });
  const command = nodeCommand(f.profile, f.snapshot, 'verify.mjs', 'unit');
  await assert.rejects(execute(f.profile, command, { cancelled: false }, { ...f.options, snapshotExecutionPolicy: undefined }), /trusted actual-cwd/);
  const mutations = [
    { observedAt: new Date(Date.now() - 61000).toISOString() }, { observedAt: new Date(Date.now() + 10000).toISOString() },
    { generation: 0 }, { generation: 1.5 }, { effectivePolicySha256: 'invalid' }, { projectRoot: f.projectRoot }, { home: f.snapshot.inputRoot },
    { schemaVersion: 2 }, { method: 'synthetic-policy' },
  ];
  for (const mutation of mutations) {
    await assert.rejects(execute(f.profile, command, { cancelled: false }, { ...f.options, snapshotExecutionPolicy: async () => ({ ...f.policy(), ...mutation }) as SnapshotPolicyEvidence }));
  }
  await assert.rejects(execute(f.profile, { ...command, timeoutMs: 60000 }, { cancelled: false }, f.options), /30-second/);
  assert.equal(executed, 0);
});

test('post-command policy change, generation change or connection loss fails closed without changing cleanup facts', async () => {
  const f = await fixture();
  for (const change of ['policy', 'generation', 'connection'] as const) {
    let reads = 0; let audit!: SnapshotExecutionPolicy;
    const options = { ...f.options, snapshotExecutionPolicy: async () => {
      reads++; if (reads === 1) return f.policy();
      if (change === 'connection') throw new Error('engine stopped');
      return { ...f.policy(), ...(change === 'policy' ? { managedPolicySha256: 'c'.repeat(64) } : { generation: 8 }) };
    } };
    const execute = sandboxHarness(async () => processResult());
    const result = await execute(f.profile, nodeCommand(f.profile, f.snapshot, 'verify.mjs', 'unit'), { cancelled: false }, options, value => { audit = value; });
    assert.match(result.error || '', /policy could not be confirmed/); assert.equal(result.exitCode, 0); assert.equal(result.cleanup, 'confirmed'); assert.equal(audit.status, 'rejected');
  }
});

async function completePolicies(f: Awaited<ReturnType<typeof fixture>>) {
  const steps = [['sandbox-probe.mjs', 'sandbox_probe', undefined], ['permission-probe.mjs', 'permission_probe', 'build'], ['build.mjs', 'building', undefined], ['permission-probe.mjs', 'permission_probe', 'verify'], ['verify.mjs', 'verifying', undefined]] as const;
  const execute = sandboxHarness(async () => processResult()); f.snapshot.executionPolicies = [];
  for (const [index, [file, phase, stage]] of steps.entries()) {
    await execute(f.profile, nodeCommand(f.profile, f.snapshot, file, `unit-${index}`, stage), { cancelled: false }, f.options, policy => {
      f.snapshot.executionPolicies!.push(Object.assign(policy, { file, phase, nonce: `unit-${index}`, permissionStage: stage }));
    });
  }
  return f.snapshot.executionPolicies;
}

test('all five stage policies bind exact commands, current cwd and one stable policy but not restart generation', async () => {
  const f = await fixture(); await completePolicies(f);
  await validateSnapshotExecutionPolicies(f.snapshot, f.profile, f.options, true);
  const before = JSON.stringify(f.snapshot);
  await assert.rejects(validateSnapshotExecutionPolicies(f.snapshot, f.profile, { ...f.options, snapshotExecutionPolicy: async () => { throw new Error('engine stopped'); } }, true), /engine stopped/);
  assert.equal(JSON.stringify(f.snapshot), before);
  await validateSnapshotExecutionPolicies(f.snapshot, f.profile, { ...f.options, snapshotExecutionPolicy: async () => ({ ...f.policy(), generation: 99 }) }, true);
  for (const mutation of [
    (values: SnapshotExecutionStagePolicy[]) => { values.pop(); },
    (values: SnapshotExecutionStagePolicy[]) => { values[1].commandDigest = '0'.repeat(64); },
    (values: SnapshotExecutionStagePolicy[]) => { values[1].after!.generation++; },
    (values: SnapshotExecutionStagePolicy[]) => { values[1].before!.generation++; values[1].after!.generation++; },
    (values: SnapshotExecutionStagePolicy[]) => { values[1].before!.effectivePolicySha256 = 'c'.repeat(64); values[1].after!.effectivePolicySha256 = 'c'.repeat(64); values[1].policyDigest = executionPolicyDigest(values[1].before!, workspaceSandboxArgs()); },
  ]) {
    const changed = structuredClone(f.snapshot); mutation(changed.executionPolicies!);
    await assert.rejects(validateSnapshotExecutionPolicies(changed, f.profile, f.options, true));
  }
});

test('current acceptance becomes stale on policy disconnection and is not resurrected by reconnection', async () => {
  const f = await fixture(); await completePolicies(f);
  const proof = JSON.stringify(f.snapshot);
  const task = { projectRoot: f.projectRoot, updatedAt: '', acceptance: [{ status: 'passed' }], evidence: [{ result: 'passed', snapshot: f.snapshot }], operations: [] };
  const context = { clone: structuredClone, now: () => new Date().toISOString() };
  const refresh = runInNewContext(sourceFunction('./index.ts', 'refresh', true), context);
  const staleTask = runInNewContext(sourceFunction('./index.ts', 'staleTask', true), {});
  const beginMetadataWrite = runInNewContext(sourceFunction('./index.ts', 'beginMetadataWrite', true), {});
  let connected = false;
  const owner = { closing: false, metadataWrites: new Set<Promise<void>>(), beginMetadataWrite,
    ready: Promise.resolve(), projects: new Map(), task: () => task, save: async () => {}, deriveStatus() {}, staleTask,
    evidenceCurrent: async () => { await validateSnapshotExecutionPolicies(f.snapshot, f.profile, { ...f.options, snapshotExecutionPolicy: async () => { if (!connected) throw new Error('engine stopped'); return f.policy(); } }, true); return true; } };
  const refreshing = refresh.call(owner, 'unit-task');
  assert.equal(owner.metadataWrites.size, 1);
  const drained = Promise.all([...owner.metadataWrites]);
  await refreshing; await drained; assert.equal(owner.metadataWrites.size, 0);
  assert.equal(task.acceptance[0].status, 'stale'); assert.equal(task.evidence[0].result, 'stale');
  assert.equal(JSON.stringify(f.snapshot), proof); connected = true;
  await refresh.call(owner, 'unit-task'); assert.equal(task.acceptance[0].status, 'stale'); assert.equal(task.evidence[0].result, 'stale');
  assert.equal(owner.metadataWrites.size, 0);
  owner.closing = true;
  await assert.rejects(refresh.call(owner, 'unit-task'), /closing/);
  assert.equal(owner.metadataWrites.size, 0);
});

test('early sandbox failure keeps its phase cause and incomplete stages do not manufacture an integrity failure', async () => {
  for (const integrityFailure of [false, true]) {
    const f = await fixture(); let policyValidation = 0;
    const task = { snapshotProfile: f.profile, projectRoot: f.projectRoot, id: 'unit-task', evidence: [] as any[], acceptance: [{ id: SNAPSHOT_ACCEPTANCE_ID, status: 'pending' }] };
    const operation = { id: 'unit-op', status: 'prepared', cleanup: 'not-needed', failureReason: undefined as string | undefined };
    const configuration = { digest: 'unit-configuration', node: { executable: 'unit-only', sha256: hash, version: 'unit' } };
    const perform = runInNewContext(sourceFunction('./index.ts', 'performSnapshot', true), { path, now: () => new Date().toISOString(), randomUUID: () => 'unit-evidence', mkdir, writeFile, boundedLog, redact, SNAPSHOT_LIMITATION, SNAPSHOT_ACCEPTANCE_ID,
      validateIsolation: async () => {}, profileConfiguration: async () => configuration,
      createTaskSnapshot: async () => ({ snapshot: f.snapshot, before: { inputDigest: 'unit-input' } }),
      runSnapshotCommands: async () => { throw Object.assign(new Error('Snapshot sandbox_probe failed: original-infrastructure-cause'), { output: 'original phase log', result: { ...processResult(), exitCode: 1 } }); },
      fingerprint: async () => { if (integrityFailure) throw new Error('later-source-integrity-failure'); return { inputDigest: 'unit-input' }; },
      snapshotOptions: (options: RunnerOptions) => options, validateTaskSnapshot: async () => {}, validateSnapshotExecutionPolicies: async () => { policyValidation++; throw new Error('missing stages'); } });
    const owner = { options: f.options, directory: path.join(f.options.dataDir, 'engineering'), save: async () => {}, staleTask() {}, completeOperation: async (_task: unknown, op: { status: string }, status: string) => { op.status = status; } };
    await perform.call(owner, task, operation, f.profile.isolation, { cancelled: false });
    assert.equal(policyValidation, 0); assert.equal(operation.status, 'failed'); assert.match(operation.failureReason || '', /original-infrastructure-cause/); assert.doesNotMatch(operation.failureReason || '', /missing stages/);
    assert.equal(task.evidence[0].result, integrityFailure ? 'stale' : 'failed');
    if (integrityFailure) assert.match(operation.failureReason || '', /later-source-integrity-failure/);
  }
});

test('export allowlist keeps stage provenance hashes and omits raw cwd/home/config/auth fields', async () => {
  const f = await fixture(); await completePolicies(f);
  Object.assign(f.snapshot.executionPolicies![0], { secret: 'never-export-stage-secret' });
  Object.assign(f.snapshot.executionPolicies![0].before!, { auth_token: 'never-export-policy-token', rawConfig: { privateKey: 'never-export-config' } });
  const task = { id: 'unit-task', projectRoot: f.projectRoot, title: 'unit export', sessionId: 'unit-session', status: 'draft', profileRevision: 1, acceptance: [], operations: [],
    evidence: [{ id: 'unit-evidence', operationId: 'unit-op', evidenceLevel: 'B', result: 'stale', sourceBefore: { gitCommit: null, dirtyDiffDigest: null, untrackedDigest: hash }, tool: { sha256: hash, version: 'unit' }, snapshot: f.snapshot, artifacts: [] }] };
  const publicExecutionPolicy = runInNewContext(sourceFunction('./index.ts', 'publicExecutionPolicy'), { digest });
  const destinationPath = runInNewContext(sourceFunction('./index.ts', 'destinationPath'), { path, lstat, realpath });
  const exportTask = runInNewContext(sourceFunction('./index.ts', 'exportTask', true), { path, inside, mkdir, realpath, readdir, writeFile, redact, containmentLimitation, SNAPSHOT_LIMITATION, publicExecutionPolicy, destinationPath, now: () => new Date().toISOString() });
  const exported = await exportTask.call({ directory: path.join(f.options.dataDir, 'engineering'), options: f.options, refresh: async () => task }, 'unit-task', path.join(f.directory, 'export'));
  const raw = await readFile(exported.manifest, 'utf8'); const manifest = JSON.parse(raw);
  const policy = manifest.evidence[0].snapshot.executionPolicies[0];
  assert.equal(policy.permissionProfileId, WORKSPACE_PERMISSION_PROFILE_ID); assert.equal(policy.before.cwdDigest, digest(f.snapshot.outputRoot)); assert.equal(policy.before.homeDigest, digest(f.home));
  assert.equal(policy.before.projectRoot, undefined); assert.equal(policy.before.home, undefined); assert.equal(policy.before.rawConfig, undefined);
  assert.doesNotMatch(raw, /never-export|auth_token|privateKey|rawConfig/);
});
