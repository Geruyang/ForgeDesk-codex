import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { copyFile, mkdir, lstat, realpath, writeFile, readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { digest, fingerprint, hashFile, inside } from './fingerprint.js';
import { resolveExecutable, toolIdentity, execute, type ProcessControl, type ProcessResult } from './processes.js';
import type { EngineeringTask, Operation, RunnerOptions, SnapshotIsolationReceipt, SnapshotProfile, SnapshotProfileInput, SourceSnapshot, TaskSnapshot, ToolIdentity, CommandSpec } from './types.js';
import { boundedLog } from './redaction.js';
import { WORKSPACE_PERMISSION_PROFILE_ID, workspaceSandboxArgs } from '../engine-adapter/workspace-policy.js';
import type { SnapshotPolicyEvidence } from '../engine-adapter/snapshot-isolation.js';
import type { SnapshotExecutionPolicy } from './types.js';

export const SNAPSHOT_PROFILE_ID = 'forgedesk.node-software.v1' as const;
export const SNAPSHOT_ACCEPTANCE_ID = 'snapshot-software';
export const SNAPSHOT_TEMPLATE_FILES = ['build.mjs', 'verify.mjs', 'permission-probe.mjs', 'sandbox-probe.mjs'] as const;
export const SNAPSHOT_LIMITATION = 'B-level task-specific snapshot build for the fixed trusted Node arithmetic template. The model workspace and build input are outside the tested writable roots; outputs are separate. Native sandbox denial and Node permission probes are recorded. This is not a frozen-input or tamper-proof guarantee against arbitrary malicious code or same-user processes; Node permissions alone are not a security boundary.';

export const snapshotOptions = (options: RunnerOptions): RunnerOptions => ({ ...options, excludedGeneratedDirs: [] });
export const contentDigest = (source: SourceSnapshot): string => digest(JSON.stringify({ files: source.files, directories: source.directories ?? [] }));

export async function noLinks(root: string, filename: string): Promise<void> {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(filename);
  if (!inside(absoluteRoot, absolute)) throw new Error('Snapshot path escaped its owned root');
  let current = absoluteRoot;
  if ((await lstat(current)).isSymbolicLink()) throw new Error('Snapshot roots cannot be links or junctions');
  for (const part of path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Snapshot paths cannot contain links or junctions');
  }
}

function proofIdentity(info: Stats, cross = false): string {
  // Windows named/FD ctime can differ; retain it for comparisons within each API.
  return JSON.stringify({ dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, size: info.size,
    uid: info.uid, gid: info.gid, mtimeMs: info.mtimeMs, ...(!cross ? { ctimeMs: info.ctimeMs } : {}) });
}

async function readIsolationProof(filename: string): Promise<Buffer> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 256 * 1024) {
    throw new Error('Isolation proof log exceeded its limit or was not a regular single-link file');
  }
  const handle = await open(filename, 'r');
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (proofIdentity(before, true) !== proofIdentity(opened, true)) throw new Error('Snapshot isolation proof log changed');
    const buffer = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== before.size || proofIdentity(opened) !== proofIdentity(await handle.stat())) throw new Error('Snapshot isolation proof log changed');
    bytes = buffer.subarray(0, offset);
  } finally { await handle.close(); }
  if (proofIdentity(before) !== proofIdentity(await lstat(filename))) throw new Error('Snapshot isolation proof log changed');
  return bytes;
}

export async function validateIsolation(receipt: SnapshotIsolationReceipt, task: EngineeringTask, directory: string, options: RunnerOptions, checkCurrentPolicy = true): Promise<void> {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.method !== 'engine-sandbox-write-denial' ||
    !/^[a-f0-9]{64}$/.test(receipt.policyDigest) || !/^[a-f0-9]{64}$/.test(receipt.probeLogSha256) || !Number.isFinite(Date.parse(receipt.verifiedAt))) {
    throw new Error('B snapshots require a real trusted engine-sandbox isolation receipt');
  }
  const protectedRoot = path.join(directory, 'snapshots');
  await mkdir(protectedRoot, { recursive: true });
  await noLinks(directory, protectedRoot);
  if (await realpath(receipt.projectRoot) !== task.projectRoot || await realpath(receipt.protectedRoot) !== await realpath(protectedRoot)) throw new Error('Snapshot isolation receipt belongs to different roots');
  if (checkCurrentPolicy && (!options.snapshotPolicyDigest || options.snapshotPolicyDigest(task.projectRoot) !== receipt.policyDigest)) throw new Error('Current engine policy has not been verified for snapshot isolation');
  const log = await realpath(receipt.probeLogRef);
  if (inside(task.projectRoot, log) || !inside(await realpath(options.dataDir), log)) throw new Error('Isolation proof must be an owned product-private log outside the model workspace');
  await noLinks(await realpath(options.dataDir), log);
  const proofBytes = await readIsolationProof(log);
  if (digest(proofBytes) !== receipt.probeLogSha256) throw new Error('Snapshot isolation proof log changed');
  const proof = JSON.parse(proofBytes.toString('utf8')) as Record<string, unknown>;
  if (proof.schemaVersion !== 1 || proof.method !== receipt.method || proof.policyDigest !== receipt.policyDigest ||
    proof.projectRoot !== receipt.projectRoot || proof.protectedRoot !== receipt.protectedRoot || proof.verifiedAt !== receipt.verifiedAt ||
    proof.writeDenied !== true || proof.cleanupComplete !== true || typeof proof.attemptedPath !== 'string' ||
    !inside(protectedRoot, path.resolve(proof.attemptedPath)) || path.resolve(proof.attemptedPath) === protectedRoot) throw new Error('Isolation receipt did not record an actual denied protected-root write');
}

export async function createProfile(input: SnapshotProfileInput, task: EngineeringTask, directory: string, options: RunnerOptions): Promise<SnapshotProfile> {
  if (input.id !== SNAPSHOT_PROFILE_ID || !options.snapshotTemplateDirectory || !options.snapshotSandbox) throw new Error('Only the packaged trusted Node software snapshot template with a native sandbox is supported');
  const templateDirectory = await realpath(options.snapshotTemplateDirectory);
  if (inside(task.projectRoot, templateDirectory)) throw new Error('Snapshot templates must be outside the model workspace');
  const nodeExecutable = await resolveExecutable(input.nodeExecutable);
  if (inside(task.projectRoot, nodeExecutable)) throw new Error('Snapshot Node executable must be outside the model workspace');
  const identity = await toolIdentity(nodeExecutable, options.processHost);
  if (!/^v24\.(?:1[2-9]|[2-9]\d)\.\d+(?:\s|$)/.test(identity.version)) throw new Error('The fixed snapshot template requires a stable Node 24.12+ executable');
  const sandbox = { ...options.snapshotSandbox, executable: await resolveExecutable(options.snapshotSandbox.executable), codexHome: await realpath(options.snapshotSandbox.codexHome) };
  if (!['mxc', 'elevated', 'unelevated'].includes(sandbox.mode) || inside(task.projectRoot, sandbox.executable) || inside(task.projectRoot, sandbox.codexHome) ||
    !inside(await realpath(options.dataDir), sandbox.codexHome)) throw new Error('Snapshot sandbox executable/home/mode must be trusted and its home must stay in the product data directory');
  if (process.platform === 'win32' && !options.processHost) throw new Error('B snapshots on Windows require the native Job Object supervisor');
  await validateIsolation(input.isolation, task, directory, options);
  const trustedFiles = [];
  for (const name of SNAPSHOT_TEMPLATE_FILES) {
    const filename = path.join(templateDirectory, name); await noLinks(templateDirectory, filename);
    trustedFiles.push({ path: filename, sha256: (await hashFile(filename)).sha256 });
  }
  const revision = (task.snapshotProfile?.revision ?? 0) + 1;
  const stable = { schemaVersion: 1, id: SNAPSHOT_PROFILE_ID, revision, nodeExecutable, nodeIdentity: identity, templateDirectory, trustedFiles, sandbox, policyDigest: input.isolation.policyDigest };
  return { schemaVersion: 1, id: SNAPSHOT_PROFILE_ID, nodeExecutable, isolation: structuredClone(input.isolation), revision,
    configuredAt: new Date().toISOString(), templateDirectory, trustedFiles, sandbox, profileDigest: digest(JSON.stringify(stable)) };
}

export async function profileConfiguration(profile: SnapshotProfile, task: EngineeringTask, directory: string, options: RunnerOptions, checkCurrentPolicy = true): Promise<{ digest: string; node: ToolIdentity }> {
  if (profile.id !== SNAPSHOT_PROFILE_ID || !options.snapshotSandbox) throw new Error('Snapshot profile/sandbox is unavailable');
  if (checkCurrentPolicy && (!options.snapshotPolicyDigest || options.snapshotPolicyDigest(task.projectRoot) !== profile.isolation.policyDigest)) throw new Error('Snapshot policy has changed or is unavailable');
  if (JSON.stringify(profile.sandbox) !== JSON.stringify({ ...options.snapshotSandbox, executable: await resolveExecutable(options.snapshotSandbox.executable), codexHome: await realpath(options.snapshotSandbox.codexHome) })) throw new Error('Snapshot sandbox configuration changed');
  for (const file of profile.trustedFiles) {
    await noLinks(profile.templateDirectory, file.path);
    if ((await hashFile(file.path)).sha256 !== file.sha256) throw new Error('Fixed snapshot template changed; explicitly enable a new profile revision');
  }
  const node = await toolIdentity(profile.nodeExecutable, options.processHost);
  const sandbox = await toolIdentity(profile.sandbox.executable, options.processHost);
  const rules = await hashFile(path.join(directory, 'verifiers', `${task.id}.json`));
  const profileFile = path.join(directory, 'profiles', `${task.id}.json`);
  const storedProfile = await hashFile(profileFile);
  if (storedProfile.bytes > 64 * 1024 || JSON.stringify(JSON.parse(await readFile(profileFile, 'utf8'))) !== JSON.stringify(profile)) throw new Error('Protected snapshot profile did not match the authoritative task configuration');
  return { digest: digest(JSON.stringify({ profileDigest: profile.profileDigest, node, sandbox, rules: rules.sha256, storedProfile: storedProfile.sha256,
    permissionProfileId: WORKSPACE_PERMISSION_PROFILE_ID, sandboxArgs: workspaceSandboxArgs(profile.sandbox.mode) })), node };
}

export async function createTaskSnapshot(task: EngineeringTask, operation: Operation, profile: SnapshotProfile, directory: string, options: RunnerOptions,
  isolation: SnapshotIsolationReceipt, control: ProcessControl, onCopied?: (relative: string) => Promise<void>): Promise<{ snapshot: TaskSnapshot; before: SourceSnapshot }> {
  if (![task.id, operation.id].every(value => /^[A-Za-z0-9_-]{1,120}$/.test(value))) throw new Error('Snapshot task/operation identity was invalid');
  const snapshotsRoot = path.join(directory, 'snapshots');
  const taskRoot = path.join(snapshotsRoot, task.id);
  await mkdir(taskRoot, { recursive: true }); await noLinks(directory, taskRoot);
  const operationRoot = path.join(taskRoot, operation.id);
  await mkdir(operationRoot); await noLinks(directory, operationRoot);
  const inputRoot = path.join(operationRoot, 'input'); const outputRoot = path.join(operationRoot, 'output');
  await mkdir(inputRoot); await mkdir(outputRoot);
  const before = await fingerprint(task.projectRoot, snapshotOptions(options), false);
  if (!before.files.some(file => file.path === 'numbers.mjs')) throw new Error('The fixed Node snapshot template requires numbers.mjs at the project root');
  for (const relative of before.directories ?? []) await mkdir(path.join(inputRoot, relative), { recursive: true });
  for (const file of before.files) {
    if (control.cancelled) throw new Error('Snapshot copying was cancelled');
    const source = path.join(task.projectRoot, file.path); const destination = path.join(inputRoot, file.path);
    await noLinks(task.projectRoot, source);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const actual = await hashFile(destination);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) throw new Error(`Snapshot copy differed from the captured source: ${file.path}`);
    await onCopied?.(file.path);
  }
  const after = await fingerprint(task.projectRoot, snapshotOptions(options), false);
  if (before.inputDigest !== after.inputDigest) throw new Error('Project changed while copying; no snapshot command was executed');
  const copied = await fingerprint(inputRoot, snapshotOptions(options), false);
  if (contentDigest(before) !== contentDigest(copied)) throw new Error('Snapshot input manifest was incomplete or changed while copying');
  const manifestPath = path.join(operationRoot, 'manifest.json');
  const manifest = { schemaVersion: 1, id: operation.id, taskId: task.id, createdAt: new Date().toISOString(), profileId: profile.id,
    profileRevision: profile.revision, profileDigest: profile.profileDigest, source: before, contentDigest: contentDigest(copied),
    isolation: structuredClone(isolation), excludedInputs: ['.git'], gitMetadata: 'not-collected-fixed-template-does-not-use-git', limitation: SNAPSHOT_LIMITATION };
  const serialized = JSON.stringify(manifest, null, 2); await writeFile(manifestPath, serialized, { flag: 'wx' });
  return { before, snapshot: { schemaVersion: 1, id: operation.id, taskId: task.id, operationId: operation.id, createdAt: manifest.createdAt,
    inputRoot, outputRoot, manifestPath, manifestDigest: digest(serialized), contentDigest: manifest.contentDigest, sourceInputDigest: before.inputDigest,
    profileId: profile.id, profileRevision: profile.revision, isolation: structuredClone(isolation) } };
}

export async function validateTaskSnapshot(snapshot: TaskSnapshot, directory: string, options: RunnerOptions): Promise<void> {
  if (![snapshot.taskId, snapshot.operationId].every(value => /^[A-Za-z0-9_-]{1,120}$/.test(value))) throw new Error('Snapshot identity was invalid');
  const operationRoot = path.join(directory, 'snapshots', snapshot.taskId, snapshot.operationId);
  if (snapshot.id !== snapshot.operationId || snapshot.inputRoot !== path.join(operationRoot, 'input') || snapshot.outputRoot !== path.join(operationRoot, 'output') || snapshot.manifestPath !== path.join(operationRoot, 'manifest.json')) throw new Error('Snapshot ownership/path did not match its task operation');
  for (const filename of [snapshot.inputRoot, snapshot.outputRoot, snapshot.manifestPath]) await noLinks(directory, filename);
  if ((await hashFile(snapshot.manifestPath)).sha256 !== snapshot.manifestDigest) throw new Error('Snapshot manifest changed');
  const copied = await fingerprint(snapshot.inputRoot, snapshotOptions(options), false);
  if (contentDigest(copied) !== snapshot.contentDigest) throw new Error('Snapshot input changed');
}

export function receipt(output: string, prefix: string, nonce: string): Record<string, unknown> {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) throw new Error('Trusted snapshot command did not provide exactly one complete execution receipt');
  const result = JSON.parse(lines[0].slice(prefix.length)) as Record<string, unknown>;
  if (result.schemaVersion !== 1 || result.nonce !== nonce) throw new Error('Snapshot receipt did not match this execution');
  return result;
}

function selected(receipt: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, receipt[key]]));
}

function validPermissionProbe(probe: Record<string, unknown>, stage: 'build' | 'verify'): boolean {
  return probe.passed === true && probe.stage === stage &&
    ['inputWriteDenied', 'childProcessDenied', 'workerDenied', 'addonDenied', 'wasiDenied', 'inspectorDenied'].every(key => probe[key] === true) &&
    probe.outputWriteAllowed === (stage === 'build') && probe.outputWriteDenied === (stage === 'verify');
}

export function nodeCommand(profile: SnapshotProfile, snapshot: TaskSnapshot, file: typeof SNAPSHOT_TEMPLATE_FILES[number], nonce: string, stage?: 'build' | 'verify'): CommandSpec {
  const script = path.join(profile.templateDirectory, file);
  let args: string[];
  if (file === 'sandbox-probe.mjs') {
    args = [script, snapshot.inputRoot, snapshot.outputRoot, path.resolve(snapshot.inputRoot, '../../../..'), profile.templateDirectory, nonce];
  } else {
    args = ['--permission', `--allow-fs-read=${profile.templateDirectory}`, `--allow-fs-read=${snapshot.inputRoot}`, `--allow-fs-read=${snapshot.outputRoot}`];
    if (file === 'build.mjs' || stage === 'build') args.push(`--allow-fs-write=${snapshot.outputRoot}`);
    args.push(script, ...(file === 'build.mjs' ? [snapshot.inputRoot, snapshot.outputRoot, nonce]
      : file === 'verify.mjs' ? [snapshot.outputRoot, nonce] : [snapshot.inputRoot, snapshot.outputRoot, nonce, stage!]));
  }
  return { executable: profile.nodeExecutable, args, cwd: snapshot.outputRoot, timeoutMs: 30000 };
}

export function executionPolicyDigest(policy: SnapshotPolicyEvidence, args: readonly string[]): string {
  return digest(JSON.stringify({ schemaVersion: policy.schemaVersion, method: policy.method, projectRoot: policy.projectRoot, home: policy.home,
    effectivePolicySha256: policy.effectivePolicySha256, managedPolicySha256: policy.managedPolicySha256,
    permissionProfileId: WORKSPACE_PERMISSION_PROFILE_ID, sandboxArgs: args }));
}

async function checkedExecutionPolicy(value: SnapshotPolicyEvidence, profile: SnapshotProfile, cwd: string, fresh: boolean): Promise<SnapshotPolicyEvidence> {
  if (!value || value.schemaVersion !== 1 || value.method !== 'app-server/config-read' || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    !/^[a-f0-9]{64}$/.test(value.effectivePolicySha256) || !/^[a-f0-9]{64}$/.test(value.managedPolicySha256) ||
    typeof value.projectRoot !== 'string' || !path.isAbsolute(value.projectRoot) || typeof value.home !== 'string' || !path.isAbsolute(value.home)) throw new Error('Snapshot execution requires validated config/read policy evidence');
  const observed = Date.parse(value.observedAt);
  if (!Number.isFinite(observed) || fresh && (Date.now() - observed > 60000 || observed > Date.now() + 5000)) throw new Error('Snapshot execution policy evidence is not fresh');
  const actualCwd = await realpath(cwd); const home = await realpath(profile.sandbox.codexHome);
  if (await realpath(value.projectRoot) !== actualCwd || await realpath(value.home) !== home) throw new Error('Snapshot execution policy belongs to a different cwd or home');
  return { schemaVersion: 1, method: 'app-server/config-read', generation: value.generation, observedAt: value.observedAt,
    projectRoot: actualCwd, home, effectivePolicySha256: value.effectivePolicySha256, managedPolicySha256: value.managedPolicySha256 };
}

export async function readSnapshotExecutionPolicy(profile: SnapshotProfile, cwd: string, options: RunnerOptions): Promise<SnapshotPolicyEvidence> {
  if (!options.snapshotExecutionPolicy) throw new Error('Snapshot execution requires the trusted actual-cwd policy callback');
  return checkedExecutionPolicy(await options.snapshotExecutionPolicy(cwd), profile, cwd, true);
}

function sandboxCommand(profile: SnapshotProfile, command: CommandSpec): CommandSpec {
  return { executable: profile.sandbox.executable, args: [...workspaceSandboxArgs(profile.sandbox.mode), command.executable, ...command.args],
    cwd: command.cwd, timeoutMs: command.timeoutMs };
}

export async function sandboxExecute(profile: SnapshotProfile, command: CommandSpec, control: ProcessControl, options: RunnerOptions,
  onPolicy?: (policy: SnapshotExecutionPolicy) => void | Promise<void>): Promise<ProcessResult> {
  if (!command.cwd || !path.isAbsolute(command.cwd) || command.timeoutMs !== 30000) throw new Error('Snapshot sandbox requires an absolute cwd and the fixed 30-second deadline');
  const args = workspaceSandboxArgs(profile.sandbox.mode); const actual = sandboxCommand(profile, command);
  const audit: SnapshotExecutionPolicy = { schemaVersion: 1, permissionProfileId: WORKSPACE_PERMISSION_PROFILE_ID,
    sandboxArgsDigest: digest(JSON.stringify(args)), commandDigest: digest(JSON.stringify(actual)), status: 'pending' };
  try {
    audit.before = await readSnapshotExecutionPolicy(profile, command.cwd, options);
    audit.policyDigest = executionPolicyDigest(audit.before, args);
    await onPolicy?.(audit);
    if (control.cancelled) throw new Error('Snapshot operation cancelled before sandbox command');
  } catch (error) { audit.status = 'rejected'; throw error; }
  let result: ProcessResult;
  try { result = await execute(actual, control, options.processHost, { CODEX_HOME: profile.sandbox.codexHome }); }
  catch (error) { audit.status = 'rejected'; throw error; }
  try {
    audit.after = await readSnapshotExecutionPolicy(profile, command.cwd, options);
    if (audit.after.generation !== audit.before.generation || executionPolicyDigest(audit.after, args) !== audit.policyDigest) throw new Error('Snapshot effective execution policy changed during command');
    audit.status = 'verified';
  } catch {
    audit.status = 'rejected';
    result.error = result.error ?? 'Snapshot effective execution policy could not be confirmed unchanged after command';
  }
  return result;
}

export async function validateSnapshotExecutionPolicies(snapshot: TaskSnapshot, profile: SnapshotProfile, options: RunnerOptions, refreshCurrent = false): Promise<void> {
  const expected = [['sandbox-probe.mjs', 'sandbox_probe', undefined], ['permission-probe.mjs', 'permission_probe', 'build'],
    ['build.mjs', 'building', undefined], ['permission-probe.mjs', 'permission_probe', 'verify'], ['verify.mjs', 'verifying', undefined]] as const;
  if (snapshot.executionPolicies?.length !== expected.length) throw new Error('Snapshot lacks complete actual-cwd execution policy evidence');
  const args = workspaceSandboxArgs(profile.sandbox.mode); let stable: string | undefined; let generation: number | undefined;
  const nonces = new Set<string>();
  for (const [index, [file, phase, stage]] of expected.entries()) {
    const audit = snapshot.executionPolicies[index];
    if (audit.schemaVersion !== 1 || audit.file !== file || audit.phase !== phase || audit.permissionStage !== stage || audit.status !== 'verified' ||
      !/^[A-Za-z0-9-]{1,120}$/.test(audit.nonce) || nonces.has(audit.nonce) || audit.permissionProfileId !== WORKSPACE_PERMISSION_PROFILE_ID ||
      audit.sandboxArgsDigest !== digest(JSON.stringify(args)) || audit.commandDigest !== digest(JSON.stringify(sandboxCommand(profile, nodeCommand(profile, snapshot, file, audit.nonce, stage)))) ||
      !audit.before || !audit.after) throw new Error('Snapshot execution stage policy evidence did not match its command');
    nonces.add(audit.nonce);
    const before = await checkedExecutionPolicy(audit.before, profile, snapshot.outputRoot, false);
    const after = await checkedExecutionPolicy(audit.after, profile, snapshot.outputRoot, false);
    const bound = executionPolicyDigest(before, args);
    if (before.generation !== after.generation || generation !== undefined && generation !== before.generation || executionPolicyDigest(after, args) !== bound || audit.policyDigest !== bound || stable && stable !== bound) throw new Error('Snapshot execution policy evidence changed across commands');
    stable = bound; generation = before.generation;
  }
  if (refreshCurrent && executionPolicyDigest(await readSnapshotExecutionPolicy(profile, snapshot.outputRoot, options), args) !== stable) throw new Error('Current actual-cwd snapshot policy changed');
}

export async function assertSandboxMarkersAbsent(profile: SnapshotProfile, snapshot: TaskSnapshot, nonce: string): Promise<void> {
  if (!/^[A-Za-z0-9-]{1,120}$/.test(nonce)) throw new Error('Invalid native sandbox probe nonce');
  const roots = [snapshot.inputRoot, path.resolve(snapshot.inputRoot, '../../../..'), profile.templateDirectory, snapshot.outputRoot];
  for (const root of roots) for (const suffix of ['', '.db', '.db-journal', '.db-wal', '.db-shm']) {
    const filename = path.join(root, `.runner-os-probe-${nonce}${suffix}`);
    try { await lstat(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    throw new Error('Native sandbox probe left a marker or SQLite file; denial/cleanup was not verified');
  }
}

export async function runSnapshotCommands(profile: SnapshotProfile, snapshot: TaskSnapshot, options: RunnerOptions, control: ProcessControl,
  onPhase: (phase: Operation['phase']) => Promise<void>): Promise<{ output: string; result: ProcessResult; artifacts: { path: string; sha256: string; bytes: number }[] }> {
  const output: string[] = [];
  let final: ProcessResult | undefined;
  const invoke = async (file: typeof SNAPSHOT_TEMPLATE_FILES[number], phase: Operation['phase'], prefix: string, stage?: 'build' | 'verify') => {
    if (control.cancelled) throw new Error('Snapshot operation was cancelled');
    const nonce = randomUUID();
    const result = await sandboxExecute(profile, nodeCommand(profile, snapshot, file, nonce, stage), control, options, async policy => {
      snapshot.executionPolicies ??= [];
      if (snapshot.executionPolicies.some(prior => prior.policyDigest !== policy.policyDigest || prior.before?.generation !== policy.before?.generation)) throw new Error('Snapshot execution policy or connection generation changed between commands');
      snapshot.executionPolicies.push(Object.assign(policy, { file, phase: phase!, nonce, permissionStage: stage }));
      await onPhase(phase);
    });
    output.push(`[${phase}${stage ? ':' + stage : ''}]\n${result.output}`); final = result;
    if (result.cancelled || result.timedOut || result.cleanup === 'unconfirmed' || result.error || result.exitCode !== 0) throw new Error(`Snapshot ${phase} failed${result.timedOut ? ': timeout' : result.cancelled ? ': cancelled' : result.error ? ': ' + result.error : ': exit ' + result.exitCode}`);
    const received = receipt(result.output, prefix, nonce);
    if (file === 'sandbox-probe.mjs') {
      await assertSandboxMarkersAbsent(profile, snapshot, nonce);
      received.hostMarkersAbsent = true;
    }
    return received;
  };
  try {
    const outer = await invoke('sandbox-probe.mjs', 'sandbox_probe', 'FORGEDESK_SANDBOX_RECEIPT:');
    if (outer.passed !== true || !['inputWriteDenied', 'privateWriteDenied', 'templateWriteDenied', 'sqliteInputWriteDenied', 'outputWriteAllowed', 'sqliteOutputWriteAllowed'].every(key => outer[key] === true)) throw new Error('Native snapshot sandbox boundaries were not verified');
    snapshot.sandboxProbe = selected(outer, ['schemaVersion', 'nonce', 'inputWriteDenied', 'privateWriteDenied', 'templateWriteDenied', 'sqliteInputWriteDenied', 'outputWriteAllowed', 'sqliteOutputWriteAllowed', 'hostMarkersAbsent', 'passed']);
    const buildProbe = await invoke('permission-probe.mjs', 'permission_probe', 'FORGEDESK_PERMISSION_RECEIPT:', 'build');
    if (!validPermissionProbe(buildProbe, 'build')) throw new Error('Node build permissions were not enforced');
    const built = await invoke('build.mjs', 'building', 'FORGEDESK_BUILD_RECEIPT:');
    const artifact = path.join(snapshot.outputRoot, 'numbers.mjs'); await noLinks(snapshot.outputRoot, artifact);
    const hashed = await hashFile(artifact);
    if (built.artifact !== 'numbers.mjs' || built.sha256 !== hashed.sha256) throw new Error('Build receipt did not match the independent output artifact');
    const verifyProbe = await invoke('permission-probe.mjs', 'permission_probe', 'FORGEDESK_PERMISSION_RECEIPT:', 'verify');
    if (!validPermissionProbe(verifyProbe, 'verify')) throw new Error('Node verifier permissions were not enforced');
    const permissionKeys = ['schemaVersion', 'nonce', 'stage', 'inputWriteDenied', 'outputWriteAllowed', 'outputWriteDenied', 'childProcessDenied', 'workerDenied', 'addonDenied', 'wasiDenied', 'inspectorDenied', 'passed'];
    snapshot.permissionProbe = { build: selected(buildProbe, permissionKeys), verify: selected(verifyProbe, permissionKeys) };
    const verified = await invoke('verify.mjs', 'verifying', 'FORGEDESK_TEST_RECEIPT:');
    if (verified.passed !== true || JSON.stringify(verified.checks) !== JSON.stringify(['empty', 'nonempty', 'signed']) || verified.sha256 !== hashed.sha256 || (await hashFile(artifact)).sha256 !== hashed.sha256) throw new Error('Trusted verifier did not complete all three fixed arithmetic checks');
    snapshot.verifierReceipt = { schemaVersion: 1, nonce: verified.nonce, checks: ['empty', 'nonempty', 'signed'], sha256: hashed.sha256, passed: true };
    await validateSnapshotExecutionPolicies(snapshot, profile, options);
    return { output: boundedLog(output.join('\n')), result: final!, artifacts: [{ path: artifact, ...hashed }] };
  } catch (error) {
    const failure = error as Error & { output?: string; result?: ProcessResult };
    failure.output = boundedLog(output.join('\n')); failure.result = final;
    throw failure;
  }
}
