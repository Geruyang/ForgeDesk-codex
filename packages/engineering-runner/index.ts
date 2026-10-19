import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink, realpath, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint, digest, hashFile, inside } from './fingerprint.js';
import { execute, resolveExecutable, toolIdentity, type ProcessControl } from './processes.js';
import { redact, containmentLimitation, boundedLog } from './redaction.js';
import type { AcceptanceDefinition, AcceptanceItem, CommandSpec, EngineeringTask, Evidence, Operation, RunnerOptions, ToolIdentity } from './types.js';
import type { SnapshotProfileInput, SnapshotIsolationReceipt, SnapshotExecutionPolicy, SourceSnapshot, TaskSnapshot } from './types.js';
import { createProfile, createTaskSnapshot, validateIsolation, validateTaskSnapshot, profileConfiguration, runSnapshotCommands,
  snapshotOptions, SNAPSHOT_ACCEPTANCE_ID, SNAPSHOT_PROFILE_ID, SNAPSHOT_LIMITATION, noLinks, validateSnapshotExecutionPolicies } from './snapshots.js';
export * from './types.js';

interface Store { schemaVersion: 1; tasks: EngineeringTask[] }
const clone = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
function publicExecutionPolicy(value: SnapshotExecutionPolicy['before']) {
  return value ? { schemaVersion: value.schemaVersion, method: value.method, generation: value.generation, observedAt: value.observedAt,
    cwdDigest: digest(value.projectRoot), homeDigest: digest(value.home), effectivePolicySha256: value.effectivePolicySha256,
    managedPolicySha256: value.managedPolicySha256 } : undefined;
}
const identifier = (value: string, label: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error(`${label} must contain 1-120 letters, digits, underscores or hyphens`);
  return value;
};
function taskInput(value: { id: string; projectRoot: string; sessionId: string; title: string }) {
  const keys = ['id', 'projectRoot', 'sessionId', 'title'] as const;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) throw new Error('Invalid task input fields');
  const result = {} as typeof value;
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || field.value.includes('\0')) throw new Error(`Task input ${key} must be a string`);
    result[key] = field.value;
  }
  identifier(result.id, 'Task ID');
  return result;
}
function inputFields(value: unknown, required: string[], optional: string[], sampled: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid input fields');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid input fields');
  const result = { ...sampled };
  for (const key of keys as string[]) {
    if (Object.hasOwn(sampled, key)) continue;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) throw new Error('Input fields must be own data');
    result[key] = field.value;
  }
  return result;
}
function inputArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Invalid input array');
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !Object.hasOwn(field, 'value')) throw new Error('Input array fields must be own data');
    result.push(field.value);
  }
  return result;
}
function stringInputArray(value: unknown): string[] {
  return inputArray(value).map(item => {
    if (typeof item !== 'string' || item.includes('\0')) throw new Error('Input array must contain strings');
    return item;
  });
}
function commandInput(value: unknown): CommandSpec {
  const fields = inputFields(value, ['executable', 'args'], ['cwd', 'timeoutMs', 'artifactPaths']);
  if (typeof fields.executable !== 'string' || !fields.executable || fields.executable.includes('\0') ||
    fields.cwd !== undefined && (typeof fields.cwd !== 'string' || fields.cwd.includes('\0'))) throw new Error('Invalid command input fields');
  if (fields.timeoutMs !== undefined && (!Number.isInteger(fields.timeoutMs) || (fields.timeoutMs as number) < 100 || (fields.timeoutMs as number) > 300000)) throw new Error('Command timeout must be between 100 and 300000 ms');
  return { executable: fields.executable, args: stringInputArray(fields.args),
    ...(fields.cwd !== undefined ? { cwd: fields.cwd as string } : {}),
    ...(fields.timeoutMs !== undefined ? { timeoutMs: fields.timeoutMs as number } : {}),
    ...(fields.artifactPaths !== undefined ? { artifactPaths: stringInputArray(fields.artifactPaths) } : {}) };
}
type RunInput = { taskId: string; requestKey: string; command: CommandSpec; kind: 'build' | 'test'; acceptanceId?: string };
function operationInput(value: RunInput): RunInput {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid operation input fields');
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!kind || !Object.hasOwn(kind, 'value')) throw new Error('Operation kind must be own data');
  if (kind.value !== 'build' && kind.value !== 'test') throw new Error('Unsupported operation kind; device operations are unavailable');
  const acceptanceId = Object.getOwnPropertyDescriptor(value, 'acceptanceId');
  if (acceptanceId && !Object.hasOwn(acceptanceId, 'value')) throw new Error('Operation acceptanceId must be own data');
  if (acceptanceId?.value === SNAPSHOT_ACCEPTANCE_ID) throw new Error('Fixed snapshot acceptance must be executed through runSnapshotBuild');
  const fields = inputFields(value, ['taskId', 'requestKey', 'kind', 'command'], ['acceptanceId'],
    { kind: kind.value, ...(acceptanceId ? { acceptanceId: acceptanceId.value } : {}) });
  if (typeof fields.taskId !== 'string' || fields.taskId.includes('\0') ||
    fields.acceptanceId !== undefined && (typeof fields.acceptanceId !== 'string' || fields.acceptanceId.includes('\0'))) throw new Error('Invalid operation input fields');
  if (typeof fields.requestKey !== 'string' || !fields.requestKey || fields.requestKey.length > 256) throw new Error('A durable requestKey of 1-256 characters is required');
  return { taskId: fields.taskId, requestKey: fields.requestKey, kind: kind.value, command: commandInput(fields.command),
    ...(fields.acceptanceId !== undefined ? { acceptanceId: fields.acceptanceId as string } : {}) };
}
function acceptanceInput(value: AcceptanceDefinition[]): AcceptanceDefinition[] {
  const definitions = inputArray(value);
  if (definitions.length > 50) throw new Error('At most 50 acceptance items are supported');
  return definitions.map(value => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid acceptance input fields');
    const kind = Object.getOwnPropertyDescriptor(value, 'kind'), id = Object.getOwnPropertyDescriptor(value, 'id');
    if (!kind || !Object.hasOwn(kind, 'value')) throw new Error('Acceptance kind must be own data');
    if (kind.value !== 'automated' && kind.value !== 'manual') throw new Error('Unknown acceptance kind');
    if (!id || !Object.hasOwn(id, 'value')) throw new Error('Acceptance ID must be own data');
    identifier(id.value, 'Acceptance ID');
    if (id.value === SNAPSHOT_ACCEPTANCE_ID) throw new Error('The fixed snapshot acceptance item cannot be supplied or edited by callers');
    const fields = inputFields(value, ['id', 'title', 'kind'], ['required', 'command', 'verifierFiles', 'expectedExitCode'], { kind: kind.value, id: id.value });
    if (typeof fields.title !== 'string' || fields.title.includes('\0') || fields.required !== undefined && typeof fields.required !== 'boolean') throw new Error('Invalid acceptance input fields');
    if (fields.expectedExitCode !== undefined && fields.expectedExitCode !== 0) throw new Error('Trusted acceptance must exit zero on success');
    return { id: id.value, title: fields.title, kind: kind.value,
      ...(fields.required !== undefined ? { required: fields.required as boolean } : {}),
      ...(fields.verifierFiles !== undefined ? { verifierFiles: stringInputArray(fields.verifierFiles) } : {}),
      ...(fields.expectedExitCode !== undefined ? { expectedExitCode: 0 } : {}),
      ...(fields.command !== undefined ? { command: commandInput(fields.command) } : {}) };
  });
}
async function destinationPath(directory: string): Promise<string> {
  let existing = directory;
  const suffix: string[] = [];
  for (;;) {
    try { await lstat(existing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      suffix.unshift(path.basename(existing)); existing = parent; continue;
    }
    const resolved = await realpath(existing);
    if (!(await lstat(resolved)).isDirectory()) throw new Error('Export destination ancestor must be a directory');
    return path.resolve(resolved, ...suffix);
  }
}

export class EngineeringRunner {
  private readonly options: RunnerOptions;
  private directory: string;
  private readonly ready: Promise<void>;
  private state: Store = { schemaVersion: 1, tasks: [] };
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, ProcessControl>();
  private readonly pending = new Map<string, { digest: string; promise: Promise<Operation> }>();
  private readonly projects = new Map<string, string>();
  private lockOwned = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly metadataWrites = new Set<Promise<void>>();

  private beginMetadataWrite(): () => void {
    if (this.closing) throw new Error('Engineering runner is closing');
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    this.metadataWrites.add(pending);
    return () => { this.metadataWrites.delete(pending); resolve(); };
  }

  constructor(options: RunnerOptions) {
    this.options = options;
    this.directory = path.resolve(options.dataDir, 'engineering');
    this.ready = this.initialize().catch(async error => {
      if (this.lockOwned) { await unlink(path.join(this.directory, 'owner.lock')).catch(() => {}); this.lockOwned = false; }
      throw error;
    });
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.directory = await realpath(this.directory);
    const lock = path.join(this.directory, 'owner.lock');
    try {
      const owner = await open(lock, 'wx');
      await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid }));
      await owner.close(); this.lockOwned = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = JSON.parse(await readFile(lock, 'utf8')) as { pid: number };
      let live = true;
      try { process.kill(owner.pid, 0); } catch (error) { live = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (live) throw new Error('Another engineering runner owns this data directory');
      await unlink(lock);
      const replacement = await open(lock, 'wx');
      await replacement.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid }));
      await replacement.close(); this.lockOwned = true;
    }
    try {
      const parsed = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8')) as Store;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) throw new Error('Unsupported engineering store schema; existing data was preserved');
      this.state = parsed;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.markRecovered();
    await this.save();
  }

  private save(): Promise<void> {
    const serialized = JSON.stringify(this.state, null, 2);
    const next = this.writeQueue.then(async () => {
      const temporary = path.join(this.directory, `state.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx');
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path.join(this.directory, 'state.json'));
      try { this.options.onChange?.(); } catch { /* UI observers cannot invalidate persisted facts. */ }
    });
    this.writeQueue = next.catch(() => {});
    return next;
  }

  private task(taskId: string): EngineeringTask {
    const task = this.state.tasks.find(task => task.id === taskId);
    if (!task) throw new Error(`Engineering task not found: ${taskId}`);
    return task;
  }

  private async normalize(command: CommandSpec, projectRoot: string): Promise<CommandSpec> {
    if (!command || !Array.isArray(command.args) || Array.from(command.args).some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      typeof command.executable !== 'string' || command.executable.includes('\0') ||
      command.cwd !== undefined && (typeof command.cwd !== 'string' || command.cwd.includes('\0')) ||
      command.artifactPaths !== undefined && (!Array.isArray(command.artifactPaths) || Array.from(command.artifactPaths).some(file => typeof file !== 'string' || file.includes('\0')))) throw new Error('Executable, paths and a string argument array are required');
    const executable = await resolveExecutable(command.executable);
    const cwd = await realpath(path.resolve(projectRoot, command.cwd ?? projectRoot));
    if (!inside(projectRoot, cwd)) throw new Error('Command cwd must stay inside the task project');
    const timeoutMs = command.timeoutMs ?? 120000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('Command timeout must be between 100 and 300000 ms');
    const artifactPaths = command.artifactPaths?.map(file => path.resolve(projectRoot, file));
    if (artifactPaths?.some(file => !inside(projectRoot, file))) throw new Error('Artifact paths must stay inside the project');
    return { executable, args: [...command.args], cwd, timeoutMs, ...(artifactPaths ? { artifactPaths } : {}) };
  }

  async createTask(input: { id: string; projectRoot: string; sessionId: string; title: string }): Promise<EngineeringTask> {
    const finish = this.beginMetadataWrite();
    try {
    input = taskInput(input);
    await this.ready;
    identifier(input.id, 'Task ID');
    const projectRoot = await realpath(input.projectRoot);
    if (!(await lstat(projectRoot)).isDirectory()) throw new Error('Project root must be a directory');
    const protectedRoot = await realpath(this.directory);
    if (inside(projectRoot, protectedRoot) || inside(protectedRoot, projectRoot)) throw new Error('Engineering data and verifier definitions must be outside the model project root');
    if (this.options.processHost && inside(projectRoot, await realpath(this.options.processHost))) throw new Error('Native process supervisor must be outside the model project root');
    const existing = this.state.tasks.find(task => task.id === input.id);
    if (existing) {
      if (existing.projectRoot !== projectRoot || existing.sessionId !== input.sessionId) throw new Error('Task ID is already bound to a different project/session');
      return clone(existing);
    }
    const task: EngineeringTask = { schemaVersion: 1, ...input, projectRoot, status: 'draft', profileRevision: 0,
      createdAt: now(), updatedAt: now(), acceptance: [], operations: [], evidence: [] };
    this.state.tasks.push(task); await this.save(); return clone(task);
    } finally { finish(); }
  }

  async listTasks(): Promise<EngineeringTask[]> { await this.ready; return clone(this.state.tasks); }
  async getTask(taskId: string): Promise<EngineeringTask> { await this.ready; return clone(this.task(taskId)); }

  async setAcceptance(taskId: string, definitions: AcceptanceDefinition[]): Promise<EngineeringTask> {
    const finish = this.beginMetadataWrite();
    try {
    definitions = acceptanceInput(definitions);
    await this.ready;
    const task = this.task(taskId);
    const projectKey = task.projectRoot.toLowerCase();
    if (this.projects.has(projectKey)) throw new Error('Cannot change acceptance during same-project verification');
    this.projects.set(projectKey, 'acceptance-update');
    try {
    if (definitions.length > 50) throw new Error('At most 50 acceptance items are supported');
    if (definitions.some(item => item.id === SNAPSHOT_ACCEPTANCE_ID)) throw new Error('The fixed snapshot acceptance item cannot be supplied or edited by callers');
    const ids = new Set<string>();
    const items: AcceptanceItem[] = [];
    for (const definition of definitions) {
      identifier(definition.id, 'Acceptance ID');
      if (ids.has(definition.id)) throw new Error('Acceptance IDs must be unique'); ids.add(definition.id);
      if (!['automated', 'manual'].includes(definition.kind)) throw new Error('Unknown acceptance kind');
      if (definition.expectedExitCode !== undefined && definition.expectedExitCode !== 0) throw new Error('Trusted acceptance must exit zero on success');
      const command = definition.command ? await this.normalize(definition.command, task.projectRoot) : undefined;
      const verifierFiles = await Promise.all((definition.verifierFiles ?? []).map(file => realpath(file)));
      if (definition.kind === 'automated') {
        if (!command || verifierFiles.length === 0) throw new Error('Automated acceptance requires a trusted command and explicit verifierFiles outside the model workspace');
        if (inside(task.projectRoot, command.executable) || verifierFiles.some(file => inside(task.projectRoot, file))) throw new Error('Trusted verifier executable/files must be outside the model workspace');
        for (const file of verifierFiles) await hashFile(file);
      }
      items.push({ schemaVersion: 1, taskId, id: definition.id, title: definition.title, kind: definition.kind,
        required: definition.required ?? true, ...(command ? { command } : {}), verifierFiles,
        expectedExitCode: definition.expectedExitCode ?? 0, status: 'pending' });
    }
    const fixed = task.acceptance.find(item => item.fixedProfileId === SNAPSHOT_PROFILE_ID);
    if (fixed) items.push({ ...clone(fixed), status: fixed.status === 'passed' ? 'stale' : fixed.status });
    await this.persistAcceptance(task, items);
    return clone(task);
    } finally { this.projects.delete(projectKey); }
    } finally { finish(); }
  }

  private async persistAcceptance(task: EngineeringTask, items: AcceptanceItem[]): Promise<void> {
    await mkdir(path.join(this.directory, 'verifiers'), { recursive: true });
    const file = path.join(this.directory, 'verifiers', `${task.id}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, revision: task.profileRevision + 1, items }, null, 2), { flag: 'wx' });
    await rename(temporary, file);
    task.acceptance = items; task.profileRevision++; task.updatedAt = now();
    this.staleTask(task);
    task.status = 'draft'; await this.save();
  }

  private async configuration(task: EngineeringTask, command: CommandSpec, identity: ToolIdentity): Promise<string> {
    const rulesFile = path.join(this.directory, 'verifiers', `${task.id}.json`);
    let rulesDigest: string | null = null;
    try { rulesDigest = (await hashFile(rulesFile)).sha256; }
    catch (error) { if (task.acceptance.length || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const verifiers = [];
    for (const item of task.acceptance) for (const filename of item.verifierFiles ?? []) verifiers.push({ path: filename, ...(await hashFile(filename)) });
    return digest(JSON.stringify({ schemaVersion: 1, revision: task.profileRevision, command, rulesDigest, verifiers, tool: identity }));
  }

  async setSnapshotProfile(taskId: string, input: SnapshotProfileInput): Promise<EngineeringTask> {
    const finish = this.beginMetadataWrite();
    try {
    await this.ready;
    const task = this.task(taskId); const key = task.projectRoot.toLowerCase();
    if (this.projects.has(key)) throw new Error('Cannot enable snapshots during same-project verification');
    this.projects.set(key, 'snapshot-profile-update');
    try {
      const profile = await createProfile(input, task, this.directory, this.options);
      await mkdir(path.join(this.directory, 'profiles'), { recursive: true });
      const file = path.join(this.directory, 'profiles', `${task.id}.json`); const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(profile, null, 2), { flag: 'wx' }); await rename(temporary, file);
      task.snapshotProfile = profile;
      const verifier = path.join(profile.templateDirectory, 'verify.mjs');
      const items = task.acceptance.filter(item => item.id !== SNAPSHOT_ACCEPTANCE_ID).map(clone);
      items.push({ schemaVersion: 1, taskId, id: SNAPSHOT_ACCEPTANCE_ID, title: 'Snapshot: empty input, mean and signed values',
        kind: 'automated', required: true, fixedProfileId: SNAPSHOT_PROFILE_ID, status: 'pending', expectedExitCode: 0,
        command: { executable: profile.nodeExecutable, args: ['--permission', `--allow-fs-read=${profile.templateDirectory}`,
          `--allow-fs-read=${task.projectRoot}`, verifier, task.projectRoot, 'snapshot-only'], cwd: task.projectRoot, timeoutMs: 30000 },
        verifierFiles: profile.trustedFiles.map(file => file.path) });
      await this.persistAcceptance(task, items); return clone(task);
    } finally { this.projects.delete(key); }
    } finally { finish(); }
  }

  async runSnapshotBuild(taskId: string, requestKey: string, isolation?: SnapshotIsolationReceipt): Promise<Operation> {
    await this.ready;
    if (this.closing) throw new Error('Engineering runner is closing');
    if (typeof requestKey !== 'string' || !requestKey || requestKey.length > 256) throw new Error('A durable requestKey of 1-256 characters is required');
    const task = this.task(taskId); const profile = task.snapshotProfile;
    if (!profile) throw new Error('The fixed snapshot template has not been explicitly enabled');
    const argsDigest = digest(JSON.stringify({ taskId, kind: 'build', evidenceLevel: 'B', profileDigest: profile.profileDigest, acceptanceId: SNAPSHOT_ACCEPTANCE_ID }));
    const original = this.state.tasks.flatMap(task => task.operations).find(operation => operation.requestKey === requestKey);
    if (original) {
      if (original.argsDigest !== argsDigest) throw new Error('requestKey is already bound to different normalized arguments or snapshot profile');
      const inflight = this.pending.get(requestKey); return clone(inflight ? await inflight.promise : original);
    }
    const pending = this.pending.get(requestKey);
    if (pending) {
      if (pending.digest !== argsDigest) throw new Error('requestKey is already bound to a different snapshot profile');
      return clone(await pending.promise);
    }
    const key = task.projectRoot.toLowerCase();
    if (this.projects.has(key)) throw new Error(`Project is already locked by operation ${this.projects.get(key)}`);
    const receipt = isolation ?? profile.isolation;
    if (receipt.policyDigest !== profile.isolation.policyDigest) throw new Error('Snapshot policy changed; explicitly enable a new template revision');
    const operation: Operation = { schemaVersion: 1, id: randomUUID(), taskId, requestKey, argsDigest, kind: 'build',
      acceptanceId: SNAPSHOT_ACCEPTANCE_ID, command: { executable: profile.nodeExecutable, args: ['fixed-profile', profile.id, String(profile.revision)] },
      evidenceLevel: 'B', status: 'prepared', createdAt: now(), cleanup: 'not-needed', phase: 'snapshotting' };
    operation.snapshotId = operation.id;
    this.projects.set(key, operation.id); const control: ProcessControl = { cancelled: false }; this.active.set(operation.id, control);
    task.operations.push(operation); task.status = 'running'; task.updatedAt = now();
    const promise = this.performSnapshot(task, operation, receipt, control).finally(() => {
      this.active.delete(operation.id); this.projects.delete(key); this.pending.delete(requestKey);
    });
    this.pending.set(requestKey, { digest: argsDigest, promise }); return clone(await promise);
  }

  async run(input: RunInput): Promise<Operation> {
    if (this.closing) throw new Error('Engineering runner is closing');
    input = operationInput(input);
    await this.ready;
    if (this.closing) throw new Error('Engineering runner is closing');
    if (typeof input.requestKey !== 'string' || !input.requestKey || input.requestKey.length > 256) throw new Error('A durable requestKey of 1-256 characters is required');
    if (input.kind !== 'build' && input.kind !== 'test') throw new Error('Unsupported operation kind; device operations are unavailable');
    const task = this.task(input.taskId);
    const command = await this.normalize(input.command, task.projectRoot);
    const argsDigest = digest(JSON.stringify({ taskId: input.taskId, command, kind: input.kind, acceptanceId: input.acceptanceId ?? null }));
    const original = this.state.tasks.flatMap(task => task.operations).find(operation => operation.requestKey === input.requestKey);
    if (original) {
      if (original.argsDigest !== argsDigest) throw new Error('requestKey is already bound to different normalized arguments');
      const pending = this.pending.get(input.requestKey);
      return pending ? clone(await pending.promise) : clone(original);
    }
    const inflight = this.pending.get(input.requestKey);
    if (inflight) {
      if (inflight.digest !== argsDigest) throw new Error('requestKey is already bound to different normalized arguments');
      return clone(await inflight.promise);
    }
    const acceptance = input.acceptanceId ? task.acceptance.find(item => item.id === input.acceptanceId) : undefined;
    if (input.kind === 'test') {
      if (!acceptance || acceptance.kind !== 'automated' || !acceptance.command) throw new Error('Test requires a user-defined automated acceptanceId');
      if (acceptance.fixedProfileId) throw new Error('Fixed snapshot acceptance must be executed through runSnapshotBuild');
      if (JSON.stringify(command) !== JSON.stringify(acceptance.command)) throw new Error('Test command does not match the protected user verifier configuration');
    }
    const key = task.projectRoot.toLowerCase();
    if (this.closing) throw new Error('Engineering runner is closing');
    if (this.projects.has(key)) throw new Error(`Project is already locked by operation ${this.projects.get(key)}`);
    const operation: Operation = { schemaVersion: 1, id: randomUUID(), taskId: task.id, requestKey: input.requestKey, argsDigest,
      kind: input.kind, acceptanceId: input.acceptanceId, command, status: 'prepared', createdAt: now(), cleanup: 'not-needed' };
    this.projects.set(key, operation.id);
    const control: ProcessControl = { cancelled: false }; this.active.set(operation.id, control);
    task.operations.push(operation); task.status = 'running'; task.updatedAt = now();
    const promise = this.perform(task, operation, control).finally(() => {
      this.active.delete(operation.id); this.projects.delete(key); this.pending.delete(input.requestKey);
    });
    this.pending.set(input.requestKey, { digest: argsDigest, promise });
    return clone(await promise);
  }

  private async perform(task: EngineeringTask, operation: Operation, control: ProcessControl): Promise<Operation> {
    const logFile = path.join(this.directory, 'logs', `${operation.id}.log`);
    operation.logRef = logFile;
    let terminalStatus: Operation['status'] = 'failed';
    try {
      await this.save();
      const before = await fingerprint(task.projectRoot, this.options);
      for (const prior of task.evidence.filter(evidence => evidence.result === 'passed')) {
        if (!(await this.evidenceCurrent(task, prior))) { this.staleTask(task); break; }
      }
      const identity = await toolIdentity(operation.command.executable, this.options.processHost);
      const configurationBefore = await this.configuration(task, operation.command, identity);
      if (control.cancelled) { terminalStatus = 'interrupted'; operation.failureReason = 'Cancelled before execution'; return operation; }
      operation.status = 'running'; operation.startedAt = now(); await this.save();
      const result = await execute(operation.command, control, this.options.processHost);
      await mkdir(path.dirname(logFile), { recursive: true });
      await writeFile(logFile, result.output, { flag: 'wx' });
      operation.exitCode = result.exitCode; operation.signal = result.signal; operation.cleanup = result.cleanup;
      const expected = task.acceptance.find(item => item.id === operation.acceptanceId)?.expectedExitCode ?? 0;
      terminalStatus = result.cancelled ? 'interrupted' : result.timedOut || result.error || result.exitCode !== expected ? 'failed' : 'succeeded';
      operation.failureReason = result.cancelled ? 'Operation cancelled' : result.timedOut ? 'Operation timeout' : result.error ? `Environment error: ${redact(result.error)}` : result.exitCode !== expected ? `${operation.kind} failed (exit ${result.exitCode})` : undefined;
      if (result.cleanup === 'unconfirmed') { terminalStatus = 'unknown'; operation.failureReason = 'Process-tree cleanup could not be confirmed'; }
      operation.phase = 'finalizing';
      let after;
      let currentConfiguration;
      let verificationError: string | undefined;
      const artifacts: Evidence['artifacts'] = [];
      try {
        after = await fingerprint(task.projectRoot, this.options);
        currentConfiguration = await this.configuration(task, operation.command, await toolIdentity(operation.command.executable, this.options.processHost));
        for (const artifact of operation.command.artifactPaths ?? []) {
          const resolved = await realpath(artifact);
          if (!inside(task.projectRoot, resolved)) throw new Error('Artifact resolved outside project root');
          artifacts.push({ path: resolved, ...(await hashFile(resolved)) });
        }
      } catch (error) { verificationError = (error as Error).message; }
      const stale = !!verificationError || before.inputDigest !== after?.inputDigest || configurationBefore !== currentConfiguration;
      const evidence: Evidence = { schemaVersion: 1, id: randomUUID(), taskId: task.id, operationId: operation.id,
        acceptanceId: operation.acceptanceId, evidenceLevel: 'A', result: stale ? 'stale' : terminalStatus === 'succeeded' ? 'passed' : terminalStatus === 'unknown' ? 'unknown' : 'failed',
        createdAt: now(), inputDigest: before.inputDigest, configurationDigest: configurationBefore, sourceBefore: before,
        sourceAfter: after, tool: identity, artifacts, logRef: logFile, limitation: containmentLimitation(this.options.processHost) };
      task.evidence.push(evidence); operation.evidenceId = evidence.id;
      if (stale) operation.failureReason = `Evidence stale: ${verificationError ?? 'inputs, configuration or tool changed during execution'}`;
      if (stale) this.staleTask(task);
      const item = task.acceptance.find(item => item.id === operation.acceptanceId);
      if (item) { item.status = evidence.result === 'passed' ? 'passed' : evidence.result === 'stale' ? 'stale' : 'failed'; item.evidenceId = evidence.id; }
    } catch (error) {
      terminalStatus = control.cancelled ? 'interrupted' : 'failed'; operation.failureReason = `Verification/environment error: ${redact((error as Error).message)}`;
      this.staleTask(task);
      const item = task.acceptance.find(item => item.id === operation.acceptanceId);
      if (item) item.status = 'failed';
      try {
        await mkdir(path.dirname(logFile), { recursive: true });
        try { await writeFile(logFile, operation.failureReason, { flag: 'wx' }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } catch (error) { terminalStatus = 'unknown'; operation.failureReason = `Finalization error: ${redact((error as Error).message)}`; }
    } finally {
      await this.completeOperation(task, operation, terminalStatus, control);
    }
    return operation;
  }

  private async performSnapshot(task: EngineeringTask, operation: Operation, isolation: SnapshotIsolationReceipt, control: ProcessControl): Promise<Operation> {
    const logFile = path.join(this.directory, 'logs', `${operation.id}.log`); operation.logRef = logFile;
    let before: SourceSnapshot | undefined; let snapshot: TaskSnapshot | undefined;
    let configurationBefore: string | undefined; let identity: ToolIdentity | undefined;
    let artifacts: Evidence['artifacts'] = []; let logged = '';
    let terminalStatus: Operation['status'] = 'failed';
    try {
      await this.save(); const profile = task.snapshotProfile!;
      await validateIsolation(isolation, task, this.directory, this.options);
      const configuration = await profileConfiguration(profile, task, this.directory, this.options);
      configurationBefore = configuration.digest; identity = configuration.node;
      const created = await createTaskSnapshot(task, operation, profile, this.directory, this.options, isolation, control);
      before = created.before; snapshot = created.snapshot; operation.snapshot = snapshot;
      for (const prior of task.evidence.filter(item => item.result === 'passed')) if (!(await this.evidenceCurrent(task, prior))) { this.staleTask(task); break; }
      if (control.cancelled) throw new Error('Snapshot operation cancelled before commands');
      await validateIsolation(isolation, task, this.directory, this.options);
      operation.status = 'running'; operation.startedAt = now(); await this.save();
      const result = await runSnapshotCommands(profile, snapshot, this.options, control, async phase => {
        operation.phase = phase; await this.save();
      });
      logged = result.output; artifacts = result.artifacts; operation.exitCode = result.result.exitCode;
      operation.signal = result.result.signal; operation.cleanup = result.result.cleanup;
      terminalStatus = 'succeeded'; snapshot.verificationResult = 'passed';
    } catch (error) {
      const failure = error as Error & { output?: string; result?: { exitCode: number | null; signal: string | null; cleanup: Operation['cleanup']; timedOut: boolean } };
      logged = failure.output ?? logged; operation.exitCode = failure.result?.exitCode; operation.signal = failure.result?.signal;
      operation.cleanup = failure.result?.cleanup ?? 'not-needed';
      terminalStatus = operation.cleanup === 'unconfirmed' ? 'unknown' : control.cancelled ? 'interrupted' : 'failed';
      operation.failureReason = redact(failure.message);
      if (snapshot) snapshot.verificationResult = terminalStatus === 'unknown' ? 'unknown' : 'failed';
    } finally {
      operation.phase = 'finalizing';
      try {
      await mkdir(path.dirname(logFile), { recursive: true });
      await writeFile(logFile, boundedLog(logged + (operation.failureReason ? '\n' + operation.failureReason : '')), { flag: 'wx' });
      if (snapshot && before && configurationBefore && identity) {
        let after: SourceSnapshot | undefined; let stale = false; let integrityError: string | undefined;
        try {
          after = await fingerprint(task.projectRoot, snapshotOptions(this.options), false);
          await validateTaskSnapshot(snapshot, this.directory, this.options);
          await validateIsolation(snapshot.isolation, task, this.directory, this.options, false);
          if (terminalStatus === 'succeeded') await validateSnapshotExecutionPolicies(snapshot, task.snapshotProfile!, this.options, true);
          const current = await profileConfiguration(task.snapshotProfile!, task, this.directory, this.options, false);
          stale = before.inputDigest !== after.inputDigest || current.digest !== configurationBefore;
        } catch (error) { stale = true; integrityError = (error as Error).message; }
        const evidence: Evidence = { schemaVersion: 1, id: randomUUID(), taskId: task.id, operationId: operation.id,
          acceptanceId: SNAPSHOT_ACCEPTANCE_ID, evidenceLevel: 'B', result: stale ? 'stale' : terminalStatus === 'succeeded' ? 'passed' : terminalStatus === 'unknown' ? 'unknown' : 'failed',
          createdAt: now(), inputDigest: before.inputDigest, configurationDigest: configurationBefore, sourceBefore: before,
          sourceAfter: after, tool: identity, artifacts, logRef: logFile, limitation: SNAPSHOT_LIMITATION, snapshot };
        task.evidence.push(evidence); operation.evidenceId = evidence.id;
        if (stale) { this.staleTask(task); operation.failureReason = [operation.failureReason, `Snapshot evidence stale: ${integrityError ?? 'current project, profile or tool changed'}`].filter(Boolean).join('\n'); }
        const item = task.acceptance.find(item => item.id === SNAPSHOT_ACCEPTANCE_ID)!;
        item.status = evidence.result === 'passed' ? 'passed' : evidence.result === 'stale' ? 'stale' : 'failed'; item.evidenceId = evidence.id;
      } else {
        this.staleTask(task); const item = task.acceptance.find(item => item.id === SNAPSHOT_ACCEPTANCE_ID); if (item) item.status = 'failed';
      }
      } catch (error) {
        terminalStatus = 'unknown'; operation.failureReason = `Finalization error: ${redact((error as Error).message)}`;
        this.staleTask(task);
        const evidence = task.evidence.find(item => item.id === operation.evidenceId); if (evidence) evidence.result = 'unknown';
        const item = task.acceptance.find(item => item.id === SNAPSHOT_ACCEPTANCE_ID); if (item) item.status = 'failed';
      }
      await this.completeOperation(task, operation, terminalStatus, control);
    }
    return operation;
  }

  private async completeOperation(task: EngineeringTask, operation: Operation, status: Operation['status'], control: ProcessControl): Promise<void> {
    // Keep the operation active until all asynchronous evidence/log work has finished.
    operation.status = control.cancelled && status === 'succeeded' ? 'interrupted' : status;
    if (operation.status === 'interrupted') {
      operation.failureReason = 'Operation cancelled';
      const evidence = task.evidence.find(item => item.id === operation.evidenceId);
      if (evidence?.result === 'passed') evidence.result = 'failed';
      const item = task.acceptance.find(item => item.id === operation.acceptanceId);
      if (item?.status === 'passed') item.status = 'failed';
    }
    operation.completedAt = now(); task.updatedAt = now(); this.deriveStatus(task, operation);
    try { await this.save(); }
    catch (error) {
      operation.status = 'unknown'; operation.failureReason = `Final state persistence failed: ${redact((error as Error).message)}`;
      this.staleTask(task); this.deriveStatus(task, operation);
      await this.save();
    }
  }

  private async evidenceCurrent(task: EngineeringTask, evidence: Evidence): Promise<boolean> {
    const operation = task.operations.find(item => item.id === evidence.operationId);
    if (!operation) return false;
    const current = await fingerprint(task.projectRoot, evidence.evidenceLevel === 'B' ? snapshotOptions(this.options) : this.options, evidence.evidenceLevel !== 'B');
    if (current.inputDigest !== evidence.inputDigest) return false;
    if (evidence.evidenceLevel === 'B') {
      if (!task.snapshotProfile || !evidence.snapshot || task.snapshotProfile.revision !== evidence.snapshot.profileRevision) return false;
      await validateTaskSnapshot(evidence.snapshot, this.directory, this.options);
      await validateIsolation(evidence.snapshot.isolation, task, this.directory, this.options, false);
      await validateSnapshotExecutionPolicies(evidence.snapshot, task.snapshotProfile, this.options, true);
      const livePolicy = this.options.snapshotPolicyDigest?.(task.projectRoot);
      if (livePolicy && livePolicy !== task.snapshotProfile.isolation.policyDigest) return false;
      if ((await profileConfiguration(task.snapshotProfile, task, this.directory, this.options, false)).digest !== evidence.configurationDigest) return false;
      for (const artifact of evidence.artifacts) {
        if (!inside(evidence.snapshot.outputRoot, artifact.path)) return false;
        await noLinks(evidence.snapshot.outputRoot, artifact.path);
      }
    } else if ((await this.configuration(task, operation.command, await toolIdentity(operation.command.executable, this.options.processHost))) !== evidence.configurationDigest) return false;
    for (const artifact of evidence.artifacts) if ((await hashFile(artifact.path)).sha256 !== artifact.sha256) return false;
    return true;
  }

  private staleTask(task: EngineeringTask): void {
    for (const evidence of task.evidence) if (evidence.result === 'passed') evidence.result = 'stale';
    for (const item of task.acceptance) if (item.status === 'passed') item.status = 'stale';
  }

  private deriveStatus(task: EngineeringTask, operation?: Operation): void {
    const required = task.acceptance.filter(item => item.required);
    if (operation?.status === 'unknown') task.status = 'needs_attention';
    else if (operation?.status === 'interrupted') task.status = 'interrupted';
    else if (task.acceptance.some(item => item.status === 'failed') || operation?.status === 'failed') task.status = 'failed';
    else if (required.length && required.every(item => item.status === 'passed')) task.status = 'passed';
    else task.status = 'needs_attention';
  }

  async cancel(operationId: string): Promise<Operation> {
    await this.ready;
    const operation = this.state.tasks.flatMap(task => task.operations).find(operation => operation.id === operationId);
    if (!operation) throw new Error('Operation not found');
    const control = this.active.get(operationId);
    if (!control || !['prepared', 'running', 'stopping'].includes(operation.status)) return clone(operation);
    control.cancelled = true; operation.status = 'stopping'; await this.save();
    await control.terminate?.();
    const pending = this.pending.get(operation.requestKey);
    return clone(pending ? await pending.promise : operation);
  }

  async refresh(taskId: string): Promise<EngineeringTask> {
    const finish = this.beginMetadataWrite();
    try {
    await this.ready;
    const task = this.task(taskId);
    if (this.projects.has(task.projectRoot.toLowerCase())) return clone(task);
    try {
      for (const evidence of task.evidence.filter(evidence => evidence.result === 'passed')) {
        if (!(await this.evidenceCurrent(task, evidence))) { this.staleTask(task); break; }
      }
    } catch { this.staleTask(task); }
    this.deriveStatus(task, task.operations.at(-1)); task.updatedAt = now(); await this.save(); return clone(task);
    } finally { finish(); }
  }

  private markRecovered(): void {
    for (const task of this.state.tasks) {
      let recovered = false;
      for (const operation of task.operations) if (['prepared', 'running', 'stopping'].includes(operation.status) && !this.active.has(operation.id)) {
        operation.status = 'unknown'; operation.failureReason = 'Interrupted runner: result and process cleanup require manual verification; operation was not replayed';
        operation.cleanup = 'unconfirmed'; operation.completedAt = now(); recovered = true;
      }
      if (recovered) { this.staleTask(task); task.status = 'needs_attention'; task.updatedAt = now(); }
    }
  }

  async recover(): Promise<EngineeringTask[]> {
    const finish = this.beginMetadataWrite();
    try { await this.ready; this.markRecovered(); await this.save(); return clone(this.state.tasks); }
    finally { finish(); }
  }

  async exportTask(taskId: string, destination: string): Promise<{ path: string; manifest: string }> {
    const task = await this.refresh(taskId);
    const output = path.resolve(destination);
    if (inside(task.projectRoot, output) || inside(this.directory, output)) throw new Error('Export destination must be outside the project and engineering state directory');
    const prospectiveOutput = await destinationPath(output);
    if (inside(task.projectRoot, prospectiveOutput) || inside(this.directory, prospectiveOutput)) throw new Error('Export destination resolves into a protected/source directory');
    await mkdir(output, { recursive: true });
    const realOutput = await realpath(output);
    if (inside(task.projectRoot, realOutput) || inside(this.directory, realOutput)) throw new Error('Export destination resolves into a protected/source directory');
    if ((await readdir(realOutput)).length) throw new Error('Export destination must be empty');
    await mkdir(path.join(realOutput, 'logs'));
    const exportedLogs: { operationId: string; file: string; sha256: string }[] = [];
    for (const operation of task.operations) if (operation.logRef) {
      const filename = `${operation.id}.log`;
      const ownedLog = path.join(this.directory, 'logs', filename);
      if (path.resolve(operation.logRef) !== ownedLog) continue;
      try {
        if (!(await lstat(ownedLog)).isFile() || (await lstat(ownedLog)).isSymbolicLink()) throw new Error('Export log must be an owned regular file');
        const handle = await open(ownedLog, 'r');
        const buffer = Buffer.alloc(256 * 1024 + 128);
        let bytesRead: number;
        try { ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0)); } finally { await handle.close(); }
        const log = redact(buffer.subarray(0, bytesRead).toString('utf8'));
        await writeFile(path.join(realOutput, 'logs', filename), log, { flag: 'wx' });
        exportedLogs.push({ operationId: operation.id, file: `logs/${filename}`, sha256: digest(log) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // Explicit fields only: never export workspace files, command arguments, verifier/config files or authentication state.
    const manifest = {
      schemaVersion: 1, exportedAt: now(), evidenceLevel: task.evidence.some(evidence => evidence.evidenceLevel === 'B') ? 'B' : 'A',
      evidenceLevels: [...new Set(task.evidence.map(evidence => evidence.evidenceLevel))],
      limitation: containmentLimitation(this.options.processHost) + (task.snapshotProfile ? ' ' + SNAPSHOT_LIMITATION : ''),
      task: { schemaVersion: 1, id: task.id, title: redact(task.title), sessionId: task.sessionId, status: task.status, profileRevision: task.profileRevision },
      acceptance: task.acceptance.map(item => ({ id: item.id, title: redact(item.title), kind: item.kind, required: item.required, status: item.status, evidenceId: item.evidenceId })),
      operations: task.operations.map(operation => ({ schemaVersion: 1, id: operation.id, kind: operation.kind, status: operation.status,
        argsDigest: operation.argsDigest, createdAt: operation.createdAt, completedAt: operation.completedAt, exitCode: operation.exitCode,
        cleanup: operation.cleanup, failureReason: redact(operation.failureReason ?? '') })),
      evidence: task.evidence.map(evidence => ({ schemaVersion: 1, id: evidence.id, operationId: evidence.operationId, acceptanceId: evidence.acceptanceId,
        evidenceLevel: evidence.evidenceLevel, result: evidence.result, limitation: evidence.limitation, inputDigest: evidence.inputDigest, configurationDigest: evidence.configurationDigest,
        gitCommit: evidence.sourceBefore.gitCommit, dirtyDiffDigest: evidence.sourceBefore.dirtyDiffDigest, untrackedDigest: evidence.sourceBefore.untrackedDigest,
        tool: { sha256: evidence.tool.sha256, version: redact(evidence.tool.version), processHostSha256: evidence.tool.processHost?.sha256 },
        snapshot: evidence.snapshot ? { schemaVersion: 1, id: evidence.snapshot.id, profileId: evidence.snapshot.profileId,
          profileRevision: evidence.snapshot.profileRevision, manifestDigest: evidence.snapshot.manifestDigest, contentDigest: evidence.snapshot.contentDigest,
          sourceInputDigest: evidence.snapshot.sourceInputDigest, verificationResult: evidence.snapshot.verificationResult,
          isolation: { method: evidence.snapshot.isolation.method, policyDigest: evidence.snapshot.isolation.policyDigest,
            verifiedAt: evidence.snapshot.isolation.verifiedAt, probeLogSha256: evidence.snapshot.isolation.probeLogSha256 },
          sandboxProbe: evidence.snapshot.sandboxProbe, permissionProbe: evidence.snapshot.permissionProbe,
          verifierReceipt: evidence.snapshot.verifierReceipt,
          executionPolicies: evidence.snapshot.executionPolicies?.map(policy => ({ schemaVersion: policy.schemaVersion,
            file: policy.file, phase: policy.phase, nonce: policy.nonce, permissionStage: policy.permissionStage, status: policy.status,
            permissionProfileId: policy.permissionProfileId, sandboxArgsDigest: policy.sandboxArgsDigest, commandDigest: policy.commandDigest,
            policyDigest: policy.policyDigest, before: publicExecutionPolicy(policy.before), after: publicExecutionPolicy(policy.after) })) } : undefined,
        artifacts: evidence.artifacts.map(artifact => ({ name: path.basename(artifact.path), sha256: artifact.sha256, bytes: artifact.bytes })) })),
      logs: exportedLogs,
    };
    const manifestFile = path.join(realOutput, 'manifest.json');
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    return { path: realOutput, manifest: manifestFile };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      await this.ready;
      await Promise.all([...this.active.keys()].map(id => this.cancel(id)));
      await Promise.all([...this.pending.values()].map(entry => entry.promise));
      await Promise.all([...this.metadataWrites]);
      await this.writeQueue;
      if (this.lockOwned) { await unlink(path.join(this.directory, 'owner.lock')); this.lockOwned = false; }
    })();
    return this.closePromise;
  }
}
