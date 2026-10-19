import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DesktopAPI, Session } from '../packages/shared/contracts';
import { DesktopStore } from '../apps/desktop/main/store';
import { delay, desktopHarness, runInputFromVm, setupSession, taskInputFromVm, until } from './helpers/desktop-harness';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

test('real runner fixture merges only four plain own-data fields across the VM boundary', () => {
  const input = runInNewContext('({id:"fixture",projectRoot:"C:/fixture",sessionId:"session",title:"Title"})');
  assert.deepEqual(taskInputFromVm(input), { id: 'fixture', projectRoot: 'C:/fixture', sessionId: 'session', title: 'Title' });
  assert.equal(Object.getPrototypeOf(taskInputFromVm(input)), Object.prototype);
  for (const extra of ['extra', Symbol('extra')]) {
    const invalid = { ...input, [extra]: 'forbidden' }; assert.throws(() => taskInputFromVm(invalid));
  }
  let getters = 0;
  const accessor = { ...input }; Object.defineProperty(accessor, 'title', { get() { getters++; return 'Title'; } });
  assert.throws(() => taskInputFromVm(accessor)); assert.equal(getters, 0);
  assert.throws(() => taskInputFromVm(Object.assign(Object.create({ inherited: true }), input)));
  const forgedPrototype = Object.create(null); Object.defineProperty(forgedPrototype, 'constructor', { value: Object });
  assert.throws(() => taskInputFromVm(Object.assign(Object.create(forgedPrototype), input)));
  const operation = runInNewContext('({taskId:"fixture",requestKey:"check",kind:"test",acceptanceId:"check",command:{executable:"node",args:["test.mjs"],cwd:"C:/fixture",timeoutMs:1000,artifactPaths:["result.txt"]}})');
  const normalized = runInputFromVm(operation);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
  assert.equal(Object.getPrototypeOf(normalized.command), Object.prototype);
  assert.equal(Object.getPrototypeOf(normalized.command.args), Array.prototype);
  assert.equal(Object.getPrototypeOf(normalized.command.artifactPaths!), Array.prototype);
  assert.deepEqual(normalized.command.args, ['test.mjs']);
  const optionalUndefined = runInNewContext('({taskId:"fixture",requestKey:"check",kind:"test",command:{executable:"node",args:[],artifactPaths:undefined,cwd:undefined,timeoutMs:undefined}})');
  assert.equal(runInputFromVm(optionalUndefined).command.artifactPaths, undefined);
  for (const target of [operation, operation.command, operation.command.args, operation.command.artifactPaths]) {
    for (const extra of ['extra', Symbol('extra')]) {
      Object.defineProperty(target, extra, { value: 'forbidden', configurable: true });
      assert.throws(() => runInputFromVm(operation)); delete target[extra];
    }
  }
  for (const [target, key] of [[operation, 'command'], [operation.command, 'args'], [operation.command.args, '0'], [operation.command.artifactPaths, '0']] as const) {
    const field = Object.getOwnPropertyDescriptor(target, key)!;
    Object.defineProperty(target, key, { get() { getters++; return field.value; }, configurable: true });
    assert.throws(() => runInputFromVm(operation)); Object.defineProperty(target, key, field);
  }
  assert.equal(getters, 0);
  for (const target of [operation, operation.command, operation.command.args, operation.command.artifactPaths]) {
    const original = Object.getPrototypeOf(target), forged = Object.create(Object.getPrototypeOf(original));
    Object.defineProperty(forged, 'constructor', Object.getOwnPropertyDescriptor(original, 'constructor')!);
    Object.setPrototypeOf(target, forged); assert.throws(() => runInputFromVm(operation)); Object.setPrototypeOf(target, original);
  }
  delete operation.command.args[0]; assert.throws(() => runInputFromVm(operation));
});

test('snapshot entry points require an owned idle task and an approved profile', async t => {
  const h = await desktopHarness(); t.after(h.cleanup);
  const session = await setupSession(h);
  await assert.rejects(h.invoke('enableSnapshot', 'foreign-task'), /会话不存在/);
  await assert.rejects(h.invoke('runSnapshotBuild', 'foreign-task', 'foreign-key'), /会话不存在/);
  await assert.rejects(h.invoke('runSnapshotBuild', session.id, 'no-profile'), /NO_APPROVED_BUILD_PROFILE/);
  await h.invoke('send', session.id, 'running task', 'qa-model');
  await assert.rejects(h.invoke('enableSnapshot', session.id), /工程执行期间不能更改快照模板/);
  await assert.rejects(h.bridgeInvoke('engineering.build', { taskId: 'foreign-task', profileRevision: 1, requestKey: 'wrong-scope' }), /TASK_SCOPE_MISMATCH/);
  await assert.rejects(h.bridgeInvoke('engineering.build', { taskId: session.id, profileRevision: 1, requestKey: 'missing-profile' }), /NO_APPROVED_BUILD_PROFILE/);
  h.tasks.find(task => task.id === session.id)!.snapshotProfile = { id: 'forgedesk.node-software.v1', revision: 1, nodeExecutable: process.execPath };
  await assert.rejects(h.invoke('runSnapshotBuild', session.id, 'during-turn'), /工程执行期间不能启动另一轮快照构建/);
  assert.equal((await h.snapshot()).hardware.enabled, false);
});

test('protected close warning is asynchronous and deduplicated while snapshot completion stays live', async t => {
  let releaseProbe!: () => void;
  let dismissWarning!: () => void;
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve; });
  const warningGate = new Promise<void>(resolve => { dismissWarning = resolve; });
  const h = await desktopHarness({ probeSnapshotIsolation: async () => {
    await probeGate; return { policyDigest: 'fixture-policy', fixture: 'not live proof' };
  } }); t.after(h.cleanup);
  const session = await setupSession(h);
  h.tasks.find(task => task.id === session.id)!.snapshotProfile = { id: 'forgedesk.node-software.v1', revision: 1, nodeExecutable: process.execPath };
  let warnings = 0;
  h.dialog.showMessageBox = async () => { warnings++; await warningGate; return { response: 0 }; };
  const build = h.invoke('runSnapshotBuild', session.id, 'close-warning-fixture');
  try {
    await until(() => h.probeCalls.length === 1);
    h.window.callbacks.get('close')!({ preventDefault() {} });
    h.window.callbacks.get('close')!({ preventDefault() {} });
    await until(() => warnings === 1);
    assert.equal(warnings, 1);
    assert.equal(h.closed().quit, false);
    releaseProbe(); await build;
    assert.equal(h.fixtureRunner.snapshotRunCalls.length, 1);
    assert.equal(h.closed().quit, false, 'Completion must not automatically close the app');
    dismissWarning(); await delay();
    h.window.callbacks.get('close')!({ preventDefault() {} });
    await until(() => h.closed().quit);
  } finally { releaseProbe(); dismissWarning(); await build.catch(() => {}); }
});

test('closing the window during interrupt cleanup does not restart the engine', async t => {
  const h = await desktopHarness(); t.after(h.cleanup);
  const session = await setupSession(h);
  await h.invoke('send', session.id, 'run until stopped', 'qa-model');
  const starts = h.engine.startCalls;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.engine.stopBehavior = () => gate;
  const interruption = h.invoke('interrupt', session.id);
  try {
    await until(() => h.engine.stopCalls === 1);
    h.window.callbacks.get('close')!({ preventDefault() {} });
    await h.snapshot();
    assert.equal(h.engine.stopCalls, 1, 'Shutdown must wait for the already-owned interrupt cleanup');
    assert.equal(h.closed().quit, false);
    assert.equal(h.engine.startCalls, starts);
    release(); await interruption;
    await until(() => h.closed().quit);
    assert.equal(h.engine.stopCalls, 2);
    assert.equal(h.engine.startCalls, starts);
    assert.equal(h.engine.sendCalls, 1);
    assert.equal(h.engine.state, 'stopped');
  } finally { release(); await interruption.catch(() => {}); }
});

test('main restricts privileged IPC to its main frame and explicit methods', async t => {
  const h = await desktopHarness(); t.after(h.cleanup);
  await assert.rejects(h.rawInvoke({ ...h.trustedEvent, sender: {} }, 'snapshot', []), /IPC/);
  await assert.rejects(h.rawInvoke({ ...h.trustedEvent, senderFrame: {} }, 'snapshot', []), /IPC/);
  await assert.rejects(h.rawInvoke(h.trustedEvent, '__proto__', []), /IPC/);
  await assert.rejects(h.rawInvoke(h.trustedEvent, 'snapshot', {}), /IPC/);
  await assert.rejects(h.rawInvoke(h.trustedEvent, 'snapshot', Array(6)), /IPC/);
  assert.equal((await h.snapshot()).hardware.enabled, false);
  assert.equal(h.window.options.webPreferences.contextIsolation, true);
  assert.equal(h.window.options.webPreferences.sandbox, true);
  assert.equal(h.window.options.webPreferences.nodeIntegration, false);
  let allowed = true; h.permission(value => { allowed = value; }); assert.equal(allowed, false);
  assert.equal((h.window.openHandler!() as { action: string }).action, 'deny');
  let prevented = false; h.window.contentsCallbacks.get('will-navigate')!({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
});

test('official inProgress turn maps to running, keeps prompt first and binds steer', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  await h.invoke('send', session.id, 'original prompt', 'qa-model');
  const current = (await h.snapshot()).sessions[0];
  assert.equal(current.status, 'running');
  assert.equal(current.turnId, 'turn-1');
  assert.deepEqual(Array.from(current.messages, message => message.role), ['user', 'assistant']);
  await h.invoke('steer', session.id, '追加指令');
  assert.deepEqual(h.engine.steerCalls[0], ['thread-1', 'turn-1', '追加指令']);
  await assert.rejects(h.invoke('send', session.id, 'second prompt'), /任务|执行/);
});

test('turn completion before send response stays terminal, including failed and interrupted', async t => {
  for (const status of ['completed', 'failed', 'interrupted']) {
    const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
    h.engine.sendBehavior = async threadId => {
      h.engine.emit('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress' } });
      h.engine.emit('turn/completed', { threadId, turn: { id: 'turn-1', status } });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    };
    await h.invoke('send', session.id, 'prompt');
    assert.equal((await h.snapshot()).sessions[0].status, status);
    assert.equal((await h.snapshot()).sessions[0].turnId, undefined);
  }
});

test('completed MCP tool projection replaces started text with the actual final error or result', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  await h.invoke('send', session.id, 'run the stored verifier');
  for (const status of ['failed', 'completed']) {
    const id = `mcp-${status}`;
    const item = { id, type: 'mcpToolCall', server: 'engineering', tool: 'engineering.test', status: 'inProgress',
      arguments: { taskId: session.id, verifierId: 'check', requestKey: id }, result: null, error: null };
    h.engine.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', item });
    const completed = { ...item, status,
      result: status === 'completed' ? { content: [{ type: 'text', text: 'authoritative result' }] } : null,
      error: status === 'failed' ? { message: 'user cancelled MCP tool call' } : null };
    h.engine.emit('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: completed });
    const message = (await h.snapshot()).sessions[0].messages.find(message => message.id === id)!;
    assert.equal(message.status, status);
    const projected = JSON.parse(message.text);
    assert.equal(projected.status, status);
    if (status === 'failed') assert.equal(projected.error.message, 'user cancelled MCP tool call');
    else assert.equal(projected.result.content[0].text, 'authoritative result');
  }
});

test('failed steer is not silently resent as a new turn or inserted as delivered', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  await h.invoke('send', session.id, 'prompt');
  h.engine.steerBehavior = async () => { throw new Error('Expected turn mismatch'); };
  await assert.rejects(h.invoke('steer', session.id, 'undelivered text'), /mismatch/);
  assert.equal(h.engine.sendCalls, 1);
  assert.equal((await h.snapshot()).sessions[0].messages.some(message => message.text === 'undelivered text'), false);
});

test('send response loss after turn starts marks delivery uncertain and blocks another task', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  h.engine.sendBehavior = async threadId => {
    h.engine.emit('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress' } });
    throw new Error('Engine turn/start timed out; request was not replayed');
  };
  await assert.rejects(h.invoke('send', session.id, 'possibly delivered prompt'), /timed out/);
  const current = (await h.snapshot()).sessions[0];
  assert.equal(current.status, 'needs_attention');
  assert.equal(current.historyIncomplete, true);
  await assert.rejects(h.invoke('send', session.id, 'must not overlap uncertain turn'), /历史|核验|恢复|任务|结果未知/);
  assert.equal(h.engine.sendCalls, 1);
});

test('interrupt response loss cannot declare an active turn stopped or allow overlapping work', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  await h.invoke('send', session.id, 'prompt');
  h.engine.interruptBehavior = async () => { throw new Error('Engine turn/interrupt timed out; request was not replayed'); };
  await assert.rejects(h.invoke('interrupt', session.id), /timed out/);
  const current = (await h.snapshot()).sessions[0];
  assert.equal(current.status, 'needs_attention'); assert.equal(current.historyIncomplete, true);
  await assert.rejects(h.invoke('send', session.id, 'must not overlap uncertain turn'), /结果未知|恢复|任务/);
  assert.equal(h.engine.sendCalls, 1);
});

test('successful interrupt holds all new sends until engine tree cleanup then reconnects without replay', async t => {
  for (const status of ['interrupted', 'completed']) {
    const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
    const other = await h.invoke('createSession', session.projectId, `Other task ${status}`);
    await h.invoke('send', session.id, 'original prompt');
    h.engine.emit('item/started', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'sleep-command', type: 'commandExecution', command: 'Start-Sleep -Seconds 45', status: 'inProgress' } });
    const startsBefore = h.engine.startCalls;
    let releaseStop: (() => void) | undefined;
    h.engine.stopBehavior = () => new Promise(resolve => { releaseStop = resolve; });
    h.engine.interruptBehavior = async () => { h.engine.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status } }); return {}; };
    const interrupted = h.invoke('interrupt', session.id);
    await delay(20);
    assert.equal(h.engine.stopCalls, 1, 'A successful interrupt must close the native engine process tree');
    assert.equal(h.engine.startCalls, startsBefore, 'Engine cannot reconnect before tree cleanup completes');
    await assert.rejects(h.invoke('send', other.id, 'must not overlap cleanup'), /停止|清理|任务|等待/);
    assert.equal(h.engine.sendCalls, 1);
    releaseStop!(); await interrupted;
    assert.equal(h.engine.startCalls, startsBefore + 1);
    assert.equal(h.engine.sendCalls, 1, 'The original turn must never be replayed on reconnect');
    assert.equal((await h.snapshot()).sessions.find(item => item.id === session.id)!.status, status, 'An observed terminal turn status must be preserved');
    const current = (await h.snapshot()).sessions.find(item => item.id === session.id)!;
    assert.equal(current.messages.find(message => message.id === 'sleep-command')!.status, 'interrupted');
    assert.equal(current.historyIncomplete, true, 'Missing command completion must remain an explicit history gap');
  }
});

test('MCP scope rejects foreign tasks and all device operations', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  await assert.rejects(h.bridgeInvoke('engineering.inspect', { projectId: session.projectId }), /NO_UNIQUE_ACTIVE_TASK/);
  await h.invoke('send', session.id, 'prompt');
  await assert.rejects(h.bridgeInvoke('engineering.inspect', { taskId: 'foreign', projectId: session.projectId }), /TASK_SCOPE_MISMATCH/);
  await assert.rejects(h.bridgeInvoke('engineering.inspect', { projectId: 'foreign' }), /PROJECT_SCOPE_MISMATCH/);
  await assert.rejects(h.bridgeInvoke('device.flash', { taskId: session.id }), /HARDWARE_NOT_ENABLED/);
  await assert.rejects(h.bridgeInvoke('engineering.build', { taskId: session.id }), /NO_APPROVED_BUILD_PROFILE/);
});

test('MCP permits retesting changed source within a turn and dedups only the same invocation key', async t => {
  const h = await desktopHarness(true); t.after(h.cleanup); const session = await setupSession(h);
  const input = path.join(h.projectRoot, 'input.txt');
  const verifier = path.join(h.directory, 'trusted-verifier.mjs');
  await writeFile(input, 'defect');
  await writeFile(verifier, "import { readFileSync } from 'node:fs'; process.exit(readFileSync(process.argv[2], 'utf8') === 'fixed' ? 0 : 1);\n");
  await h.invoke('setAcceptance', session.id, [{ id: 'check', title: 'Protected fixed-input check', kind: 'automated',
    command: { executable: process.execPath, args: [verifier, input], timeoutMs: 10000 }, verifierFiles: [verifier] }]);
  await h.invoke('send', session.id, 'repair the input');
  const first = await h.bridgeInvoke('engineering.test', { taskId: session.id, verifierId: 'check', requestKey: 'first-check' }) as { id: string; status: string };
  assert.equal(first.status, 'failed');
  await writeFile(input, 'fixed');
  const second = await h.bridgeInvoke('engineering.test', { taskId: session.id, verifierId: 'check', requestKey: 'after-fix' }) as { id: string; status: string };
  assert.equal(second.status, 'succeeded'); assert.notEqual(second.id, first.id);
  const repeated = await h.bridgeInvoke('engineering.test', { taskId: session.id, verifierId: 'check', requestKey: 'after-fix' }) as { id: string };
  assert.equal(repeated.id, second.id);
  const task = (await h.snapshot()).tasks.find(task => task.id === session.id)!;
  assert.equal(task.operations.length, 2); assert.equal(task.status, 'passed');
  assert.equal((await h.snapshot()).sessions[0].turnId, 'turn-1');
});

test('journal failure marks history incomplete and prevents a new side effect', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  await mkdir(path.join(h.dataDir, 'events.jsonl'));
  h.engine.emit('engine/diagnostic', { message: 'fixture diagnostic' });
  assert.equal((await h.snapshot()).sessions[0].historyIncomplete, true);
  await assert.rejects(h.invoke('send', session.id, 'must not start'), /保存失败/);
  assert.equal(h.engine.sendCalls, 0);
});

test('diagnostic export redacts structured credentials and URL passwords', async t => {
  const h = await desktopHarness(); t.after(h.cleanup);
  const tokens = ['plain-access-token-qa', 'plain-refresh-token-qa', 'url-password-qa'];
  h.engine.emit('engine/diagnostic', { message: JSON.stringify({ access_token: tokens[0], refresh_token: tokens[1], remote: `https://user:${tokens[2]}@example.invalid/` }) });
  const filename = await h.invoke('exportDiagnostics');
  const output = await readFile(filename, 'utf8');
  const journal = await readFile(path.join(h.dataDir, 'events.jsonl'), 'utf8');
  for (const token of tokens) {
    assert.equal(output.includes(token), false, `Export leaked ${token}`);
    assert.equal(journal.includes(token), false, `Event journal leaked ${token}`);
  }
});

test('operation log IPC uses the actual runner directory and refuses foreign operations and paths', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  const logDirectory = path.join(h.dataDir, 'engineering/logs');
  await mkdir(logDirectory, { recursive: true });
  const logRef = path.join(logDirectory, 'owned.log');
  await writeFile(logRef, '{"access_token":"qa-log-token"}\ntrusted output');
  const task = h.tasks.find(task => task.id === session.id)!;
  task.operations.push({ id: 'owned', status: 'failed', logRef });
  const output = await h.invoke('readOperationLog', session.id, 'owned');
  assert.match(output, /trusted output/); assert.equal(output.includes('qa-log-token'), false);
  await assert.rejects(h.invoke('readOperationLog', session.id, 'foreign'), /不属于/);
  const outside = path.join(h.directory, 'outside.log'); await writeFile(outside, 'private unrelated data');
  task.operations.push({ id: 'outside', status: 'failed', logRef: outside });
  await assert.rejects(h.invoke('readOperationLog', session.id, 'outside'), /超出/);
  await assert.rejects(h.invoke('cancelOperation', session.id, 'foreign'), /不属于/);
});

test('closing an active turn releases engine, bridge and runner and preserves gap warning', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const session = await setupSession(h);
  await h.invoke('send', session.id, 'prompt');
  h.window.callbacks.get('close')!({ preventDefault: () => {} });
  await until(() => h.closed().quit);
  assert.deepEqual(h.closed(), { quit: true, runnerClosed: true, bridgeClosed: true });
  const persisted = JSON.parse(await readFile(path.join(h.dataDir, 'desktop.json'), 'utf8'));
  assert.equal(persisted.sessions[0].status, 'needs_attention');
  assert.equal(persisted.sessions[0].historyIncomplete, true);
});

test('desktop recovery preserves messages and marks interrupted active state uncertain', async t => {
  await mkdir(path.join(root, 'tests/.tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, 'tests/.tmp/recovery-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const session: Session = { id: 'session', taskId: 'session', projectId: 'project', title: 'Persisted session', status: 'running',
    threadId: 'thread', turnId: 'old-turn', messages: [{ id: 'message', role: 'user', text: 'Never replay this instruction', timestamp: '2026-10-14T00:00:00Z' }] };
  await writeFile(path.join(directory, 'desktop.json'), JSON.stringify({ schemaVersion: 1, projects: [], sessions: [session] }));
  const restored = new DesktopStore(directory);
  assert.equal(restored.sessions[0].status, 'needs_attention'); assert.equal(restored.sessions[0].historyIncomplete, true);
  assert.equal(restored.sessions[0].engineUncertain, true); assert.equal(restored.sessions[0].turnId, undefined);
  assert.deepEqual(restored.sessions[0].messages, session.messages);
  const incompatible = '{"schemaVersion":77,"projects":[],"sessions":[]}';
  await writeFile(path.join(directory, 'desktop.json'), incompatible);
  assert.throws(() => new DesktopStore(directory), /schema/);
  assert.equal(await readFile(path.join(directory, 'desktop.json'), 'utf8'), incompatible);
});

test('preload exposes a fixed capability API and removes its exact subscription listener', async () => {
  let api: DesktopAPI | undefined;
  const calls: unknown[][] = [];
  const listeners = new Map<string, unknown>();
  let removed: unknown;
  const result = await build({ entryPoints: [path.join(root, 'apps/desktop/preload/index.ts')], bundle: true,
    platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'qa-electron', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'qa' }));
      builder.onLoad({ filter: /.*/, namespace: 'qa' }, () => ({ contents: 'export const contextBridge = globalThis.__qa.contextBridge; export const ipcRenderer = globalThis.__qa.ipcRenderer;', loader: 'js' }));
    } }] });
  runInNewContext(result.outputFiles[0].text, { __qa: {
    contextBridge: { exposeInMainWorld: (name: string, value: DesktopAPI) => { assert.equal(name, 'forgeDesk'); api = value; } },
    ipcRenderer: { invoke: async (...args: unknown[]) => { calls.push(args); },
      on: (channel: string, listener: unknown) => { listeners.set(channel, listener); },
      removeListener: (channel: string, listener: unknown) => { assert.equal(listeners.get(channel), listener); removed = listener; } }
  }, module: { exports: {} }, exports: {} });
  assert.equal('invoke' in api!, false);
  assert.equal('ipcRenderer' in api!, false);
  assert.deepEqual(Object.keys(api!).sort(), ['snapshot', 'importProject', 'createSession', 'send', 'steer', 'interrupt',
    'approve', 'connect', 'login', 'diff', 'setAcceptance', 'runAcceptance', 'enableSnapshot', 'runSnapshotBuild', 'refreshEvidence', 'readOperationLog',
    'cancelOperation', 'exportTask', 'exportDiagnostics', 'openProject', 'subscribe', 'hardwareSnapshot', 'hardwareConfigure', 'hardwareBuild',
    'hardwareInspect', 'hardwareFlash', 'hardwareVerify', 'hardwareExport', 'hardwareRecover', 'hardwareLeaveMode', 'hardwareAgentStart', 'hardwareAgentStop',
    'fz3bSnapshot', 'fz3bAgentStart', 'fz3bAgentStop', 'fz3bRecover', 'fz3bReconcileInspect', 'fz3bReconcilePreflightRefusedInspect', 'fz3bMaintenanceExit', 'fz3bQuarantineEmptyHostHome', 'fz3bIsolateFailedEmptyIntent', 'fz3bExport', 'fz3bLeaveMode', 'fz3bImportKey'].sort());
  await api!.send('session', 'message', 'model');
  assert.equal(calls[0][0], 'forgedesk:invoke');
  assert.equal(calls[0][1], 'send');
  assert.deepEqual(Array.from(calls[0][2] as string[]), ['session', 'message', 'model']);
  await api!.fz3bQuarantineEmptyHostHome('exact-run-id');
  assert.equal(calls[1][0], 'forgedesk:invoke');
  assert.equal(calls[1][1], 'fz3bQuarantineEmptyHostHome');
  assert.deepEqual(Array.from(calls[1][2] as string[]), ['exact-run-id']);
  await api!.fz3bIsolateFailedEmptyIntent('exact-run-id');
  assert.equal(calls[2][0], 'forgedesk:invoke');
  assert.equal(calls[2][1], 'fz3bIsolateFailedEmptyIntent');
  assert.deepEqual(Array.from(calls[2][2] as string[]), ['exact-run-id']);
  const unsubscribe = api!.subscribe(() => {}); unsubscribe(); assert.ok(removed);
});
