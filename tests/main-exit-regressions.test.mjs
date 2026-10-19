import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(root + '/package.json')('typescript');
const source = ts.createSourceFile('index.ts', fs.readFileSync(root + '/apps/desktop/main/index.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const compile = raw => ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function callback(expression, name) {
  const found = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === expression && node.arguments[0]?.text === name) found.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.equal(found.length, 1);
  return found[0].getText(source);
}
function code(name) {
  const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return compile(node.getText(source));
}
function methodCode(name) {
  const statement = source.statements.find(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(source) === 'handlers'));
  const object = statement.declarationList.declarations.find(d => d.name.getText(source) === 'handlers').initializer;
  const method = object.properties.find(p => p.name?.getText(source) === name);
  assert.ok(method && ts.isMethodDeclaration(method));
  return compile('const fixtureMethod=({' + method.getText(source) + '}).' + name + ';');
}
function setup(options = {}) {
  const calls = { stop: 0, start: 0, bridge: 0, embedded: 0, runner: 0, save: 0, destroy: 0, quit: 0, warning: 0 };
  const mainFrame = {}, webContents = { mainFrame };
  const globals = {
    closing: false, shutdownPending: false, shutdownFailed: false, closeWarningOpen: false, pendingMainWork: new Set(),
    startupHistoryOwner: options.startupHistoryOwner ?? undefined,
    fz3bHostActionRunId: undefined, fz3bHostStartupReadOnly: false, fz3bKeyImporting: false,
    hardwareAgentStarting: false, hardwareAgentRunId: undefined, fz3bUnavailableHold: false,
    protectedTasks: new Set(), sendingSessions: new Set(), stoppingSessions: new Set(),
    hardwareMode: false, hardwareEngine: options.hardwareEngine, fz3bAgent: undefined,
    engineError: undefined, persistenceFailed: false, account: {}, models: [], evidenceTimer: undefined,
    nativeDialogs: { busy: false, close() {} }, store: { sessions: [{ id: 's', status: options.status ?? 'draft', messages: [], engineUncertain: options.uncertain, turnId: options.turnId, engineProfile: options.engineProfile }] },
    embedded: { assertIdle: options.idle ?? (async () => {}), close: async () => { calls.embedded++; await options.embedded?.(); } },
    engine: { state: 'stopped', stop: async () => { calls.stop++; await options.stop?.(); },
      start: async () => { calls.start++; await options.start?.(); }, models: async () => ({ data: [] }) },
    bridge: { close: async () => { calls.bridge++; await options.bridge?.(); } },
    runner: { close: async () => { calls.runner++; await options.runner?.(); } },
    window: { webContents, isDestroyed: () => false, destroy: () => { calls.destroy++; } }, app: { quit: () => { calls.quit++; } },
    save: () => { calls.save++; options.save?.(); }, log() {}, publish() {},
    showCloseWarning: async () => { calls.warning++; }, refreshAccount: async () => {}, asRecord: x => x ?? {}, redact: x => x,
    clearTimeout() {}, Set, Error,
  };
  const functions = ['assertMainWorkAllowed', 'connect', 'shutdown'].map(code).join('\n');
  const context = runInNewContext(functions + '\nconst handlers = { connect, snapshot: async()=>"readonly", interrupt: async()=>"manual", fz3bMaintenanceExit: async()=>"maintenance" };\nconst ipc=' + callback('ipcMain.handle', 'forgedesk:invoke') + ';({shutdown,connect,ipc});', globals);
  return { ...context, calls, globals, event: { sender: webContents, senderFrame: mainFrame } };
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

let historyReaderFactory;
async function ownedHistoryFixture() {
  historyReaderFactory ??= (async () => {
    const { build } = createRequire(root + '/package.json')('esbuild');
    const result = await build({ entryPoints: [root + '/apps/desktop/main/release-recovery-history-async.ts'],
      bundle: true, write: false, platform: 'node', format: 'cjs' });
    const module = { exports: {} };
    runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require: createRequire(root + '/package.json'),
      Buffer, process, setTimeout, clearTimeout });
    return module.exports.createStartupHistoryAsyncReader;
  })();
  const create = await historyReaderFactory, events = new EventEmitter(), timers = new Map();
  let launches = 0, kills = 0;
  const child = { once: events.once.bind(events), stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: { on() {}, end() {} }, kill() { kills++; return true; } };
  const owner = create(root, false, () => { launches++; return child; }, (callback, ms) => {
    assert(!timers.has(ms)); timers.set(ms, callback); return () => timers.delete(ms);
  });
  const pending = owner.read(); events.emit('spawn');
  return { owner, pending, events, launches: () => launches, kills: () => kills,
    tick(ms) { const callback = timers.get(ms); assert(callback); timers.delete(ms); callback(); } };
}

test('an actual diagnostic owner with unconfirmed close retains the window and blocks all teardown', async () => {
  const history = await ownedHistoryFixture(), f = setup({ startupHistoryOwner: history.owner });
  const closing = f.shutdown(); await Promise.resolve(); assert.equal(f.calls.stop, 0); assert.equal(f.calls.quit, 0);
  history.tick(20000); assert.equal(history.kills(), 1); history.tick(5000);
  const result = await history.pending; assert.equal(result.closeConfirmed, false); assert.equal(result.status, 'unknown');
  await closing; assert.equal(f.calls.warning, 1);
  for (const name of ['stop', 'bridge', 'embedded', 'runner', 'save', 'destroy', 'quit']) assert.equal(f.calls[name], 0, name);
  assert.equal(f.globals.shutdownFailed, true); assert.equal(f.globals.shutdownPending, false);
  await assert.rejects(f.ipc(f.event, 'connect', []), /SHUTDOWN/);
  assert.equal(await f.ipc(f.event, 'snapshot', []), 'readonly');
  history.events.emit('close', 0, null);
  assert.equal(await history.owner.read(), result); assert.equal(history.launches(), 1); assert.equal(f.calls.quit, 0);
});

test('an actual diagnostic owner permits existing teardown only after confirmed child close', async () => {
  const history = await ownedHistoryFixture(), f = setup({ startupHistoryOwner: history.owner });
  const closing = f.shutdown(); await Promise.resolve(); assert.equal(f.calls.stop, 0); assert.equal(f.calls.quit, 0);
  history.events.emit('close', 2, null); // Diagnostic read refused, but the actual owned close was observed.
  const result = await history.pending; assert.equal(result.closeConfirmed, true); assert.equal(result.status, 'held');
  await closing;
  for (const name of ['stop', 'bridge', 'embedded', 'runner', 'save', 'destroy', 'quit']) assert.equal(f.calls[name], 1, name);
  assert.equal(f.calls.warning, 0); assert.equal(history.launches(), 1); assert.equal(history.kills(), 0);
});

test('a second native close cannot bypass an in-progress shutdown', async () => {
  let prevented = 0, shutdowns = 0;
  const close = runInNewContext(compile('(' + callback('window.on', 'close') + ')'), { closing: true, shutdown: () => { shutdowns++; } });
  close({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1, 'Every native close remains prevented until explicit confirmed destroy');
  assert.equal(shutdowns, 1);
});

test('shutdown owner is synchronously claimed before idle and rejects new IPC work', async () => {
  const gate = defer(), f = setup({ idle: () => gate.promise });
  const first = f.shutdown(), second = f.shutdown();
  assert.equal(f.globals.shutdownPending, true);
  await assert.rejects(f.ipc(f.event, 'connect', []), /SHUTDOWN/);
  assert.equal(await f.ipc(f.event, 'snapshot', []), 'readonly');
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(f.calls.stop, 1); assert.equal(f.calls.quit, 1);
});

test('every independent cleanup is attempted but each failure retains the window and work hold', async () => {
  for (const key of ['stop', 'bridge', 'embedded', 'runner', 'save']) {
    const f = setup({ [key]: () => { throw Error('unconfirmed-' + key); } });
    await f.shutdown();
    for (const name of ['stop', 'bridge', 'embedded', 'runner', 'save']) assert.equal(f.calls[name], 1, key + ':' + name);
    assert.equal(f.calls.destroy, 0); assert.equal(f.calls.quit, 0);
    assert.equal(f.globals.shutdownFailed, true); assert.equal(f.globals.shutdownPending, false); assert.equal(f.globals.closing, false);
    await assert.rejects(f.ipc(f.event, 'connect', []), /SHUTDOWN/);
    assert.equal(await f.ipc(f.event, 'snapshot', []), 'readonly');
    assert.equal(await f.ipc(f.event, 'interrupt', []), 'manual');
    assert.equal(await f.ipc(f.event, 'fz3bMaintenanceExit', ['fixture-run']), 'maintenance');
  }
});

test('an already-awaited uncertain connect cannot start after shutdown claims ownership', async () => {
  const gate = defer(), f = setup({ uncertain: true, stop: () => gate.promise });
  const connection = f.connect();
  const rejection = assert.rejects(connection, /SHUTDOWN/);
  const exit = f.shutdown();
  assert.equal(f.calls.quit, 0); gate.resolve();
  await rejection; await exit;
  assert.equal(f.calls.start, 0); assert.equal(f.calls.quit, 1);
});

test('shutdown waits for admitted start to settle before stopping its owning engine', async () => {
  const gate = defer(), f = setup({ start: () => gate.promise });
  const connection = f.connect(); const rejection = assert.rejects(connection, /SHUTDOWN/);
  const exit = f.shutdown(); assert.equal(f.calls.stop, 0); assert.equal(f.calls.quit, 0);
  gate.resolve(); await rejection; await exit;
  assert.equal(f.calls.start, 1); assert.equal(f.calls.stop, 1); assert.equal(f.calls.quit, 1);
});

test('a failed shutdown permits an explicit later close, never an automatic device retry', async () => {
  let failed = true; const f = setup({ stop: () => { if (failed) throw Error('unknown'); } });
  await f.shutdown(); assert.equal(f.calls.stop, 1); assert.equal(f.calls.quit, 0);
  await Promise.resolve(); assert.equal(f.calls.stop, 1);
  failed = false; await f.shutdown(); assert.equal(f.calls.stop, 2); assert.equal(f.calls.quit, 1);
});

test('idle device uncertainty stays held without any cleanup or process exit', async () => {
  const f = setup({ idle: async () => { throw Error('device-unknown'); } }); await f.shutdown();
  assert.equal(f.calls.stop, 0); assert.equal(f.calls.quit, 0); assert.equal(f.calls.destroy, 0);
  assert.equal(f.globals.shutdownFailed, true); assert.equal(f.globals.shutdownPending, false);
});

test('a failed software stop preserves durable unknown state and removes the stale active turn', async () => {
  let saved;
  const f = setup({ status: 'running', turnId: 'old-turn', stop: async () => { throw Error('unknown'); },
    save: () => { saved = JSON.parse(JSON.stringify(f.globals.store.sessions)); } });
  await f.shutdown();
  assert.equal(saved[0].engineUncertain, true); assert.equal(saved[0].status, 'needs_attention');
  assert.equal(saved[0].historyIncomplete, true); assert.equal(saved[0].turnId, undefined);
  assert.equal(f.calls.quit, 0);
  const stored = JSON.stringify({ schemaVersion: 1, projects: [], sessions: saved });
  const module = { exports: {} };
  const fakeFs = { mkdirSync() {}, existsSync: () => true, readFileSync: () => stored,
    writeFileSync: () => assert.fail('reload cannot write'), renameSync: () => assert.fail('reload cannot rename'), appendFileSync: () => assert.fail('reload cannot append') };
  const storeCode = ts.transpileModule(fs.readFileSync(root + '/apps/desktop/main/store.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  runInNewContext(storeCode, { exports: module.exports, module, require: name => {
    if (name === 'node:fs') return fakeFs; if (name === 'node:path') return path.win32;
    assert.fail('unexpected store dependency ' + name);
  } });
  const loaded = new module.exports.DesktopStore('C:\\Fixture\\data');
  assert.equal(loaded.sessions[0].engineUncertain, true); assert.equal(loaded.sessions[0].turnId, undefined);
});

test('only owning software stop confirmation clears its marker, never a restricted device session', async () => {
  for (const engineProfile of [undefined, 'stm32', 'fz3b']) {
    const f = setup({ status: 'stopping', turnId: 'old-turn', engineProfile }); await f.shutdown();
    assert.equal(f.globals.store.sessions[0].engineUncertain, engineProfile !== undefined);
    assert.equal(f.globals.store.sessions[0].turnId, undefined);
  }
});

test('hardware engine stop failure does not skip the remaining local cleanup', async () => {
  let stop = 0; const f = setup({ hardwareEngine: { stop: async () => { stop++; throw Error('unknown-hardware-close'); } } });
  await f.shutdown(); assert.equal(stop, 1); assert.equal(f.calls.stop, 1); assert.equal(f.calls.runner, 1);
  assert.equal(f.calls.save, 1); assert.equal(f.calls.quit, 0); assert.equal(f.calls.destroy, 0);
});

test('IPC admitted immediately before close is gated again before handler entry', async () => {
  const f = setup(); const work = f.ipc(f.event, 'connect', []); const rejection = assert.rejects(work, /SHUTDOWN/);
  await f.shutdown(); await rejection; assert.equal(f.calls.start, 0); assert.equal(f.calls.quit, 1);
});

test('project imports and persisted project access reject both canonical overlap directions', () => {
  const privatePath = 'C:\\Fixture\\ForgeDesk\\data';
  const globals = { dataDir: privatePath, path: path.win32, realpathSync: p => path.win32.normalize(p), store: { projects: [] } };
  const f = runInNewContext(code('assertProjectDataSeparation') + code('getProject') + ';({assertProjectDataSeparation,getProject});', globals);
  for (const p of [privatePath, privatePath + '\\fz3b-private', 'c:\\fixture\\forgedesk', privatePath.toUpperCase()]) {
    assert.throws(() => f.assertProjectDataSeparation(p), /项目/);
    globals.store.projects = [{ id: 'p', root: p }]; assert.throws(() => f.getProject('p'), /项目/);
  }
  for (const p of ['C:\\Fixture\\ForgeDesk\\data-independent', 'C:\\Fixture\\ForgeDesk\\..cache']) assert.equal(f.assertProjectDataSeparation(p), path.win32.normalize(p));
  globals.realpathSync = p => p === 'C:\\alias' ? privatePath + '\\engine' : path.win32.normalize(p);
  assert.throws(() => f.assertProjectDataSeparation('C:\\alias'), /项目/);
});

test('native project selection rechecks current canonical data aliases after its await', async () => {
  const gate = defer(), dataDir = 'C:\\Fixture\\DataAlias'; let target = 'C:\\Fixture\\Product';
  const globals = { dataDir, path: path.win32, store: { projects: [] }, ensureWritable() {}, assertNoHardwareAgent() {},
    nativeOpenDialog: () => gate.promise, realpathSync: p => p === dataDir ? target : path.win32.normalize(p),
    randomUUID: () => 'p', save: () => assert.fail('unsafe project must not persist'), publish() {} };
  const f = runInNewContext(code('assertProjectDataSeparation') + methodCode('importProject') + '\nfixtureMethod;', globals);
  const result = f(); target = 'C:\\Fixture\\Chosen';
  gate.resolve({ canceled: false, filePaths: ['c:\\fixture\\chosen\\fz3b-private'] });
  await assert.rejects(result, /项目/); assert.equal(globals.store.projects.length, 0);
});
