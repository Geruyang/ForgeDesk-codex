import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as filesystemPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSnapshot, Session } from '../../packages/shared/contracts';
import { EngineeringRunner } from '../../packages/engineering-runner';
import { EmbeddedService } from '../../packages/engineering-runner/embedded';
import type { EmbeddedOptions } from '../../packages/engineering-runner/embedded/types';
import { verifyHardwareRuntime } from '../../apps/desktop/main/hardware-runtime';
import { Fz3bBackend, type Fz3bBackendOptions } from '../../packages/engineering-runner/fz3b/backend';
import type { Fz3bSemanticFixture } from '../../packages/engineering-runner/fz3b/types';
import type { Fz3bAvailability } from '../../packages/engineering-runner/fz3b/availability';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
export const delay = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
// The bundled main runs in a VM; only this fixture seam merges its plain-data realm.
export function taskInputFromVm(value: unknown): Parameters<EngineeringRunner['createTask']>[0] {
  const keys = ['id', 'projectRoot', 'sessionId', 'title'] as const;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length) throw new Error('Invalid fixture task fields');
  const prototype = Object.getPrototypeOf(value);
  const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor');
  const constructorPrototype = constructor && Object.hasOwn(constructor, 'value') && typeof constructor.value === 'function'
    ? Object.getOwnPropertyDescriptor(constructor.value, 'prototype') : undefined;
  if (!prototype || Object.getPrototypeOf(prototype) !== null || !constructor || !Object.hasOwn(constructor, 'value') ||
      typeof constructor.value !== 'function' || !constructorPrototype || !Object.hasOwn(constructorPrototype, 'value') || constructorPrototype.value !== prototype ||
      Function.prototype.toString.call(constructor.value) !== Function.prototype.toString.call(Object)) throw new Error('Invalid fixture task prototype');
  const result = {} as Parameters<EngineeringRunner['createTask']>[0];
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || field.value.includes('\0')) throw new Error('Invalid fixture task value');
    result[key] = field.value;
  }
  return result;
}
function nativeFixturePrototype(prototype: object | null, expected: ObjectConstructor | ArrayConstructor): boolean {
  if (!prototype) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !Object.hasOwn(constructor, 'value') || typeof constructor.value !== 'function') return false;
  const self = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
  if (!self || !Object.hasOwn(self, 'value') || self.value !== prototype ||
      Function.prototype.toString.call(constructor.value) !== Function.prototype.toString.call(expected)) return false;
  return expected === Object ? Object.getPrototypeOf(prototype) === null : nativeFixturePrototype(Object.getPrototypeOf(prototype), Object);
}
function ownFixtureFields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !nativeFixturePrototype(Object.getPrototypeOf(value), Object)) throw new Error('Invalid fixture record prototype');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid fixture record fields');
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value')) throw new Error('Fixture fields must be own data');
    result[key] = field.value;
  }
  return result;
}
function fixtureStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !nativeFixturePrototype(Object.getPrototypeOf(value), Array)) throw new Error('Invalid fixture array prototype');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 ||
      Reflect.ownKeys(value).length !== length.value + 1) throw new Error('Invalid fixture array fields');
  const result: string[] = [];
  for (let index = 0; index < length.value; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string' || field.value.includes('\0')) throw new Error('Fixture array entries must be own string data');
    result.push(field.value);
  }
  return result;
}
export function runInputFromVm(value: unknown): Parameters<EngineeringRunner['run']>[0] {
  const input = ownFixtureFields(value, ['taskId', 'requestKey', 'kind', 'command'], ['acceptanceId']);
  const command = ownFixtureFields(input.command, ['executable', 'args'], ['cwd', 'timeoutMs', 'artifactPaths']);
  command.args = fixtureStringArray(command.args);
  if (command.artifactPaths !== undefined) command.artifactPaths = fixtureStringArray(command.artifactPaths);
  // Preserve primitive values for the real runner's unchanged semantic validation.
  return { ...input, command } as unknown as Parameters<EngineeringRunner['run']>[0];
}
export async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(10); }
  throw new Error('QA harness did not become ready');
}

let mainSource: Promise<string> | undefined;
function bundleMain() {
  return mainSource ??= build({ entryPoints: [path.join(root, 'apps/desktop/main/index.ts')], bundle: true,
    platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'qa-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(electron|\.\/hardware-runtime|\.\/host-finalization-store|\.\.\/\.\.\/\.\.\/packages\/(engine-adapter(?:\/snapshot-isolation|\/restricted-hardware|\/restricted-fz3b)?|engineering-runner(?:\/embedded|\/device\/real-stm32|\/fz3b\/(?:backend|worker|credentials))?|engineering-mcp))$/ },
        args => ({ path: args.path, namespace: 'qa-boundary' }));
      builder.onLoad({ filter: /.*/, namespace: 'qa-boundary' }, args => {
        const exports = args.path === 'electron'
          ? ['app', 'BrowserWindow', 'dialog', 'ipcMain', 'shell', 'session']
          : args.path.endsWith('hardware-runtime') ? ['verifyHardwareRuntime']
          : args.path.endsWith('host-finalization-store') ? ['createFz3bHostFinalizationStore', 'hasFz3bHostFinalization', 'finishFz3bHostFinalization', 'readFz3bHostLocalProof', 'assertFz3bHostLocalProof', 'canQuarantineFz3bEmptyHome', 'prepareFz3bEmptyHome', 'quarantineFz3bEmptyHome']
          : args.path.endsWith('fz3b/credentials') ? ['currentSid', 'fz3bPrivateAclBatchSync', 'fz3bPrivateAclSync']
          : args.path.endsWith('real-stm32') ? ['FixedStm32HardwareService']
          : args.path.endsWith('embedded') ? ['EmbeddedService']
          : args.path.endsWith('snapshot-isolation') ? ['probeSnapshotIsolation']
          : args.path.endsWith('restricted-hardware') ? ['RestrictedHardwareAdapter']
          : args.path.endsWith('restricted-fz3b') ? ['RestrictedFz3bAdapter']
          : args.path.endsWith('fz3b/backend') ? ['Fz3bBackend']
          : args.path.endsWith('fz3b/worker') ? ['ProductionFz3bAdapter', 'checkFz3bAvailability', 'importFz3bProjectKey', 'loadFz3bFixture', 'verifyFz3bResources']
          : args.path.endsWith('engine-adapter') ? ['CodexAdapter']
          : args.path.endsWith('engineering-runner') ? ['EngineeringRunner'] : ['startRunnerBridge', 'ENGINEERING_TOOLS'];
        return { contents: exports.map(name => `export const ${name} = globalThis.__qa.${name};`).join('\n'), loader: 'js' };
      });
    } }] }).then(result => result.outputFiles[0].text);
}

export interface DesktopHarnessOptions {
  fixtureRoot?: string;
  beforeRename?: (from: string, to: string) => Promise<void>;
  realRunner?: boolean;
  probeSnapshotIsolation?: (options: Record<string, any>) => Promise<unknown>;
  /** Explicit source-level hardware fixture only; never an installed/native worker. */
  embeddedFactory?: (options: EmbeddedOptions) => EmbeddedService;
  verifyHardwareRuntime?: (root: string, worker?: string) => Promise<void>;
  initialHardwareMode?: unknown;
  /** Explicit protocol fixture; does not enable native devices or real model access. */
  allowRestrictedEngine?: boolean;
  /** Explicit offline FZ3B fixture only. Default has no resources, key or worker. */
  fz3bFixture?: Fz3bSemanticFixture;
  fz3bFactory?: (options: Fz3bBackendOptions) => Fz3bBackend;
  allowFz3bEngine?: boolean;
  fz3bAvailable?: boolean;
  fz3bAvailability?: Fz3bAvailability;
  fz3bImportKey?: (sourcePath: string, dataDir: string) => Promise<void>;
  fz3bAccountBehavior?: () => Promise<unknown>;
  fz3bStopBehavior?: () => Promise<void>;
}

export async function desktopHarness(input: boolean | DesktopHarnessOptions = false) {
  const options: DesktopHarnessOptions = typeof input === 'boolean' ? { realRunner: input } : input;
  const fixtureRoot = options.fixtureRoot ?? path.join(root, 'tests/.tmp');
  await mkdir(fixtureRoot, { recursive: true });
  const directory = await mkdtemp(path.join(fixtureRoot, 'desktop-'));
  const projectRoot = path.join(directory, 'source');
  const dataDir = path.join(directory, 'data');
  await mkdir(projectRoot);
  if (options.initialHardwareMode !== undefined) { await mkdir(dataDir); await writeFile(path.join(dataDir, 'hardware-mode.json'), JSON.stringify(options.initialHardwareMode)); }
  let invokeHandler: ((event: unknown, method: unknown, args: unknown) => Promise<any>) | undefined;
  let engine: MockEngine | undefined;
  let restrictedEngine: MockRestrictedEngine | undefined;
  let fz3bEngine: MockFz3bEngine | undefined;
  let fz3bBackend: Fz3bBackend | undefined;
  let fz3bImportCalls = 0;
  let win: MockWindow | undefined;
  let permission: ((contents: unknown, name: string, callback: (allowed: boolean) => void) => void) | undefined;
  let bridgeHandler: ((name: string, args: Record<string, unknown>) => Promise<unknown>) | undefined;
  let runnerClosed = false;
  let bridgeClosed = false;
  let quit = false;
  const failures: string[] = [];
  const externalURLs: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const events: Array<{ generation: number; sequence: number; method: string; params: unknown }> = [];
  const tasks: Array<any> = [];
  const probeCalls: Array<Record<string, any>> = [];
  let productionRunner: EngineeringRunner | undefined;
  let fixtureRunner: MockRunner | undefined;
  let embedded: EmbeddedService | undefined;
  const hardwareRuntimeCalls: string[] = [];
  class MockEngine {
    state = 'stopped';
    options: any;
    sendCalls = 0;
    startCalls = 0;
    stopCalls = 0;
    accountCalls = 0;
    modelsCalls = 0;
    connectionGeneration = 1;
    steerCalls: unknown[][] = [];
    sendBehavior: (threadId: string, text: string) => Promise<unknown> = async threadId => {
      this.emit('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress' } });
      this.emit('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'assistant-1', delta: 'response' });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    };
    steerBehavior: () => Promise<unknown> = async () => ({});
    interruptBehavior: () => Promise<unknown> = async () => ({});
    stopBehavior: () => Promise<void> = async () => {};
    accountBehavior: () => Promise<unknown> = async () => ({ account: { type: 'chatgpt', email: 'qa@example.invalid' } });
    snapshotPolicyBehavior: (projectRoot: string) => Promise<unknown> = async projectRoot => ({
      generation: this.connectionGeneration, projectRoot, fixture: 'not a live isolation receipt' });
    constructor(options: any) { this.options = options; engine = this; }
    emit(method: string, params: unknown) {
      const event = { generation: 1, sequence: events.length + 1, method, params };
      events.push(event); this.options.onEvent(event);
    }
    async start() { this.startCalls++; this.state = 'ready'; }
    async stop() { this.stopCalls++; this.state = 'stopping'; await this.stopBehavior(); this.state = 'stopped'; }
    async account() { this.accountCalls++; return this.accountBehavior(); }
    async models() { this.modelsCalls++; return { data: [{ id: 'qa-model', displayName: 'Fixture model' }] }; }
    async startThread() { return { thread: { id: 'thread-1' } }; }
    async resumeThread() { return { thread: { id: 'thread-1' } }; }
    async send(threadId: string, text: string) { this.sendCalls++; return this.sendBehavior(threadId, text); }
    async steer(...args: unknown[]) { this.steerCalls.push(args); return this.steerBehavior(); }
    async interrupt() { return this.interruptBehavior(); }
    async approve() { return {}; }
    async login() { return { authUrl: 'https://auth.openai.com/authorize' }; }
    pendingApprovals() { return []; }
    async snapshotPolicy(projectRoot: string) { return this.snapshotPolicyBehavior(projectRoot); }
  }
  class MockRestrictedEngine {
    state = 'stopped';
    connectionGeneration = 1;
    startCalls = 0;
    stopCalls = 0;
    sendCalls = 0;
    options: any;
    policy = { fixture: true, noRealModel: true };
    stopBehavior: () => Promise<void> = async () => {};
    accountBehavior: () => Promise<unknown> = async () => ({ account: { type: 'chatgpt', email: 'qa@example.invalid' } });
    sendBehavior: (threadId: string, text: string) => Promise<unknown> = async threadId => {
      this.emit('turn/started', { threadId, turn: { id: 'hardware-turn-1', status: 'inProgress' } });
      return { turn: { id: 'hardware-turn-1', status: 'inProgress' } };
    };
    constructor(input: any) { this.options = input; restrictedEngine = this; }
    emit(method: string, params: unknown) { this.options.onEvent({ generation: this.connectionGeneration, sequence: events.length + 1, method, params }); }
    async start() { if (!options.allowRestrictedEngine) throw new Error('Restricted model disabled in fixture'); this.startCalls++; this.state = 'ready'; }
    async account() { return this.accountBehavior(); }
    policySnapshot() { if (this.state !== 'ready') throw new Error('Restricted fixture is not ready'); return structuredClone(this.policy); }
    async startThread() { return 'hardware-thread-1'; }
    async send(threadId: string, text: string) { this.sendCalls++; return this.sendBehavior(threadId, text); }
    async interrupt() { return {}; }
    async stop() { this.stopCalls++; this.state = 'stopping'; await this.stopBehavior(); this.state = 'stopped'; }
    async toolCall(name: string, args: unknown = {}, context: Record<string, unknown> = {}) {
      const wireArgs = args && Object.getPrototypeOf(args) === Object.prototype ? qa.parseProtocol(JSON.stringify(args)) : args;
      return this.options.onToolCall({ generation: this.connectionGeneration, threadId: 'hardware-thread-1', turnId: 'hardware-turn-1', callId: `fixture-${name}`, ...context }, name, wireArgs);
    }
  }
  class MockFz3bEngine extends MockRestrictedEngine {
    override policy = { fixture: true, noRealModel: true, profile: 'restricted-fz3b' };
    override sendBehavior: (threadId: string, text: string) => Promise<unknown> = async threadId => {
      this.emit('turn/started', { threadId, turn: { id: 'fz3b-turn-1', status: 'inProgress' } });
      return { turn: { id: 'fz3b-turn-1', status: 'inProgress' } };
    };
    constructor(input: any) {
      super(input); fz3bEngine = this; restrictedEngine = undefined;
      if (options.fz3bAccountBehavior) this.accountBehavior = options.fz3bAccountBehavior;
      if (options.fz3bStopBehavior) this.stopBehavior = options.fz3bStopBehavior;
    }
    override async start() { if (!options.allowFz3bEngine) throw new Error('FZ3B model disabled in fixture'); this.startCalls++; this.state = 'ready'; }
    override async startThread() { return 'fz3b-thread-1'; }
    override async stop() { try { await super.stop(); } catch (error) { this.state = 'failed'; throw error; } }
    override async toolCall(name: string, args: unknown = {}, context: Record<string, unknown> = {}) {
      return this.options.onToolCall({ generation: this.connectionGeneration, threadId: 'fz3b-thread-1', turnId: 'fz3b-turn-1', callId: `fixture-${name}`, ...context }, name, args);
    }
  }
  class MockWindow {
    options: any;
    callbacks = new Map<string, (...args: any[]) => void>();
    contentsCallbacks = new Map<string, (...args: any[]) => void>();
    openHandler?: () => unknown;
    destroyed = false;
    webContents = { mainFrame: {}, send: () => {}, setWindowOpenHandler: (callback: () => unknown) => { this.openHandler = callback; },
      on: (name: string, callback: (...args: any[]) => void) => { this.contentsCallbacks.set(name, callback); } };
    constructor(options: any) { this.options = options; win = this; }
    async loadFile() {}
    on(name: string, callback: (...args: any[]) => void) { this.callbacks.set(name, callback); }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() {}
  }
  class MockRunner {
    options: Record<string, any>;
    snapshotSetCalls: Array<{ taskId: string; profile: Record<string, any> }> = [];
    snapshotRunCalls: Array<{ taskId: string; requestKey: string; isolation?: unknown }> = [];
    snapshotRunBehavior: (taskId: string, requestKey: string, isolation?: unknown) => Promise<unknown> = async (taskId, requestKey) => {
      const task = await this.getTask(taskId);
      let operation = task.operations.find((item: any) => item.requestKey === requestKey);
      if (!operation) { operation = { id: `snapshot-${task.operations.length + 1}`, requestKey, status: 'succeeded' }; task.operations.push(operation); }
      return structuredClone(operation);
    };
    constructor(options: Record<string, any>) { this.options = options; fixtureRunner = this; }
    async recover() { return []; }
    async close() { runnerClosed = true; }
    async listTasks() { return structuredClone(tasks); }
    async createTask(input: any) { const task = { ...input, status: 'draft', acceptance: [], operations: [], evidence: [] }; tasks.push(task); return task; }
    async getTask(id: string) { return tasks.find(task => task.id === id); }
    async refresh(id: string) { return this.getTask(id); }
    async setAcceptance(id: string, items: unknown[]) { (await this.getTask(id)).acceptance = items; }
    async run() { return { status: 'succeeded' }; }
    async exportTask() { return {}; }
    async setSnapshotProfile(taskId: string, profile: Record<string, any>) {
      this.snapshotSetCalls.push({ taskId, profile });
      const task = await this.getTask(taskId);
      task.snapshotProfile = { ...profile, revision: (task.snapshotProfile?.revision ?? 0) + 1 };
      return task;
    }
    async runSnapshotBuild(taskId: string, requestKey: string, isolation?: unknown) {
      this.snapshotRunCalls.push({ taskId, requestKey, isolation });
      return this.snapshotRunBehavior(taskId, requestKey, isolation);
    }
  }
  class ProductionRunner extends EngineeringRunner {
    constructor(options: ConstructorParameters<typeof EngineeringRunner>[0]) { super(options); productionRunner = this; }
    override async createTask(input: Parameters<EngineeringRunner['createTask']>[0]) { return super.createTask(taskInputFromVm(input)); }
    override async run(input: Parameters<EngineeringRunner['run']>[0]) { return super.run(runInputFromVm(input)); }
    override async close() { runnerClosed = true; await super.close(); }
  }
  class HarnessEmbeddedService extends EmbeddedService {
    constructor(input: EmbeddedOptions) { super(input); embedded = options.embeddedFactory?.(input) ?? this; return embedded; }
  }
  class DisabledHardwareWorker {
    async inspect(): Promise<never> { throw new Error('Native hardware is disabled in the desktop VM fixture'); }
    async flash(): Promise<never> { throw new Error('Native hardware is disabled in the desktop VM fixture'); }
    async verify(): Promise<never> { throw new Error('Native hardware is disabled in the desktop VM fixture'); }
    async confirmProcessExited() { return false; }
  }
  class HarnessFz3bBackend extends Fz3bBackend {
    constructor(input: Fz3bBackendOptions) { super(input); fz3bBackend = options.fz3bFactory?.(input) ?? this; return fz3bBackend; }
  }
  class DisabledFz3bWorker {
    async build(): Promise<never> { throw new Error('Native FZ3B worker is disabled in desktop VM fixture'); }
    async inspect(): Promise<never> { throw new Error('Native FZ3B worker is disabled in desktop VM fixture'); }
    async semantic(): Promise<never> { throw new Error('Native FZ3B worker is disabled in desktop VM fixture'); }
    async readPublicEvidence(): Promise<never> { throw new Error('Native FZ3B worker is disabled in desktop VM fixture'); }
  }
  const qa = {
    // These older IPC fixtures do not attest host certificates or query a real Windows token.
    createFz3bHostFinalizationStore: () => undefined,
    hasFz3bHostFinalization: async () => { throw new Error('Host finalization is disabled in the legacy desktop IPC fixture'); },
    finishFz3bHostFinalization: async () => { throw new Error('Host finalization is disabled in the legacy desktop IPC fixture'); },
    readFz3bHostLocalProof: async () => { throw new Error('Local host proof is disabled in the legacy desktop IPC fixture'); },
    assertFz3bHostLocalProof: () => { throw new Error('Local host proof is disabled in the legacy desktop IPC fixture'); },
    canQuarantineFz3bEmptyHome: () => false,
    prepareFz3bEmptyHome: async () => { throw new Error('Empty-home isolation is disabled in the legacy desktop IPC fixture'); },
    quarantineFz3bEmptyHome: async () => { throw new Error('Empty-home isolation is disabled in the legacy desktop IPC fixture'); },
    fz3bPrivateAclBatchSync: () => { throw new Error('Native private ACL batch is disabled in the desktop VM fixture'); },
    fz3bPrivateAclSync: () => { throw new Error('Native private ACL is disabled in the desktop VM fixture'); },
    currentSid: async () => 'S-1-5-21-1-2-3-1001',
    parseProtocol: JSON.parse as (text: string) => unknown,
    app: { setName: () => {}, requestSingleInstanceLock: () => true, quit: () => { quit = true; },
      whenReady: () => Promise.resolve(), getVersion: () => '0.1.0', getPath: () => dataDir,
      setPath: () => {}, getAppPath: () => root, isPackaged: false, on: () => {} },
    BrowserWindow: MockWindow, CodexAdapter: MockEngine, EngineeringRunner: options.realRunner ? ProductionRunner : MockRunner,
    RestrictedHardwareAdapter: MockRestrictedEngine,
    RestrictedFz3bAdapter: MockFz3bEngine, Fz3bBackend: HarnessFz3bBackend, ProductionFz3bAdapter: DisabledFz3bWorker,
    loadFz3bFixture: async () => { if (!options.fz3bFixture) throw new Error('FZ3B resources disabled in desktop VM fixture'); return structuredClone(options.fz3bFixture); },
    verifyFz3bResources: async () => { if (!options.fz3bFixture) throw new Error('FZ3B resources disabled in desktop VM fixture'); },
    checkFz3bAvailability: async () => structuredClone(options.fz3bAvailability ?? {
      available: !!options.fz3bFixture && options.fz3bAvailable !== false,
      status: !options.fz3bFixture ? 'invalid-resources' : options.fz3bAvailable === false ? 'missing-key' : 'available',
      resourcesVerified: !!options.fz3bFixture,
      reason: !options.fz3bFixture ? 'FZ3B resources disabled in desktop VM fixture' : options.fz3bAvailable === false ? 'FZ3B project key missing in fixture' : undefined,
    }),
    importFz3bProjectKey: async (sourcePath: string, targetDataDir: string) => { ++fz3bImportCalls; if (!options.fz3bImportKey) throw new Error('FZ3B key import disabled in fixture'); await options.fz3bImportKey(sourcePath, targetDataDir); },
    EmbeddedService: HarnessEmbeddedService, FixedStm32HardwareService: DisabledHardwareWorker,
    verifyHardwareRuntime: async (runtimeRoot: string, worker?: string) => {
      hardwareRuntimeCalls.push(runtimeRoot);
      if (options.verifyHardwareRuntime) return options.verifyHardwareRuntime(runtimeRoot, worker);
      // Legacy software-only fixtures admit startup recovery, never a hardware action.
      if (hardwareRuntimeCalls.length === 1) return;
      return (verifyHardwareRuntime as (root: string, worker?: string) => Promise<void>)(runtimeRoot, worker);
    },
    probeSnapshotIsolation: async (input: Record<string, any>) => {
      probeCalls.push(input);
      if (!options.probeSnapshotIsolation) throw new Error('Live snapshot isolation probe is disabled in the fixture harness');
      return options.probeSnapshotIsolation(input);
    },
    ipcMain: { handle: (_channel: string, handler: typeof invokeHandler) => { invokeHandler = handler; } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [projectRoot] }),
      showSaveDialog: async () => ({ filePath: path.join(directory, 'diagnostics.json') }),
      showErrorBox: (_title: string, message: string) => failures.push(message), showMessageBox: async (_windowOrOptions: Record<string, any>, _options?: Record<string, any>): Promise<{ response: number; checkboxChecked?: boolean }> => ({ response: 0 }) },
    shell: { openExternal: async (url: string) => { externalURLs.push(url); }, openPath: async () => '' },
    session: { defaultSession: { setPermissionRequestHandler: (handler: typeof permission) => { permission = handler; } } },
    ENGINEERING_TOOLS: [], startRunnerBridge: async (options: any) => { bridgeHandler = options.handle; return { close: async () => { bridgeClosed = true; } }; }
  };
  const scopedRequire = (name: string) => name === 'node:fs/promises' && options.beforeRename ? {
    ...filesystemPromises, rename: async (from: string, to: string) => {
      await options.beforeRename!(from, to); return filesystemPromises.rename(from, to);
    },
  } : require(name);
  const vmStdout = new EventEmitter(), vmStderr = new EventEmitter();
  const vmConsole = { ...console };
  runInNewContext(`globalThis.__qa.parseProtocol = text => JSON.parse(text);\n${await bundleMain()}`, { __qa: qa, require: scopedRequire, module: { exports: {} }, exports: {}, __dirname: path.join(root, 'dist/main'),
    process: { ...process, env: { ...process.env, FORGEDESK_DATA_DIR: dataDir }, execPath: process.execPath, stdout: vmStdout, stderr: vmStderr },
    console: vmConsole, URL, Buffer, AbortController, AbortSignal, setTimeout: (callback: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, ms); timers.add(timer); return timer;
    }, clearTimeout, structuredClone });
  await until(() => !!invokeHandler && !!win && !!engine && (options.initialHardwareMode !== undefined ? engine.state === 'stopped' : engine.state === 'ready'));
  await delay();
  const trustedEvent = { sender: win!.webContents, senderFrame: win!.webContents.mainFrame };
  const invoke = (method: string, ...args: unknown[]) => invokeHandler!(trustedEvent, method, args);
  return { directory, dataDir, projectRoot, engine: engine!, window: win!, failures, externalURLs,
    get restrictedEngine() { return restrictedEngine; },
    get fz3bEngine() { return fz3bEngine; }, get fz3bBackend() { return fz3bBackend; }, get fz3bImportCalls() { return fz3bImportCalls; },
    invoke, rawInvoke: invokeHandler!, trustedEvent, tasks, probeCalls, dialog: qa.dialog, standardStreams: { stdout: vmStdout, stderr: vmStderr },
    fixtureRunner: fixtureRunner!, productionRunner, embedded: embedded!, hardwareRuntimeCalls,
    bridgeInvoke: (name: string, args: Record<string, unknown>) => bridgeHandler!(name, args),
    snapshot: () => invoke('snapshot') as Promise<AppSnapshot>,
    permission: (callback: (allowed: boolean) => void) => permission!({}, 'clipboard-read', callback),
    closed: () => ({ quit, runnerClosed, bridgeClosed }),
    cleanup: async () => { for (const timer of timers) clearTimeout(timer); await embedded?.close(); await productionRunner?.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

export async function setupSession(harness: Awaited<ReturnType<typeof desktopHarness>>): Promise<Session> {
  const project = await harness.invoke('importProject');
  return harness.invoke('createSession', project.id, 'Integration task');
}
