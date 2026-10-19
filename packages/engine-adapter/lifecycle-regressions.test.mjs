import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const home = path.resolve('output/software-audit-20261019/engine/fake-home');
const cache = new Map();
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function child() {
  const value = new EventEmitter();
  value.stdout = new EventEmitter(); value.stderr = new EventEmitter();
  value.stdin = new EventEmitter();
  Object.assign(value.stdin, { writable: true, destroyed: false, writableLength: 0,
    write(line, done) { value.writes.push(JSON.parse(line)); queueMicrotask(() => done?.()); return true; },
    end() { value.endCalls++; } });
  Object.assign(value, { exitCode: null, signalCode: null, endCalls: 0, killCalls: 0, writes: [],
    kill() { value.killCalls++; return true; } });
  return value;
}
async function compiled(entry) {
  if (!cache.has(entry)) cache.set(entry, build({ entryPoints: [entry], bundle: true,
    platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'pure-fs', setup(b) {
      b.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'fs', namespace: 'pure' }));
      b.onLoad({ filter: /.*/, namespace: 'pure' }, () => ({ contents:
        'export const {mkdir,realpath,stat,readFile,writeFile,unlink}=globalThis.__ports.fs;' }));
    } }] }).then(value => value.outputFiles[0].text));
  return cache.get(entry);
}
async function adapter(kind = 'ordinary', pauseMkdir = false, manualTimers = false, protocol = false) {
  const entered = deferred(), release = deferred(), launched = [], events = [], timers = [];
  const ports = { fs: { async mkdir() { entered.resolve(); if (pauseMkdir) await release.promise; },
    async realpath(file) { return path.resolve(file); }, async stat() { return { isDirectory: () => true }; },
    async readFile() { throw Error('Unexpected file read'); }, async writeFile() { throw Error('Unexpected file write'); },
    async unlink() { throw Error('Unexpected unlink'); } } };
  const module = { exports: {} };
  runInNewContext(await compiled(`packages/engine-adapter/${kind === 'ordinary' ? 'index' : 'restricted-hardware'}.ts`),
    { module, exports: module.exports, require(name) {
      if (name === 'node:child_process') return { spawn() { throw Error('Native subprocess forbidden'); } };
      return require(name);
    }, Buffer, process: { platform: process.platform, env: {}, execPath: process.execPath }, console, URL, AbortController, AbortSignal,
    setTimeout: manualTimers ? (callback, ms) => { const timer = { callback, ms }; timers.push(timer); return timer; } : setTimeout,
    clearTimeout: manualTimers ? timer => { if (timer) timer.cleared = true; } : clearTimeout,
    structuredClone, __ports: ports });
  const Constructor = kind === 'ordinary' ? module.exports.CodexAdapter : module.exports.RestrictedHardwareAdapter;
  const value = new Constructor({ executable: process.execPath, home, onEvent: event => events.push(event),
    onToolCall: async () => { throw Error('Host operation forbidden'); } });
  value.createProcess = () => {
    const owned = child(); launched.push(owned);
    if (protocol) {
      const write = owned.stdin.write;
      owned.stdin.write = (line, done) => {
        const request = JSON.parse(line); write(line, done);
        if (!request.id) return true;
        const result = request.method === 'initialize' ? {
          userAgent: `forgedesktop/${module.exports.CODEX_PROTOCOL_VERSION} (pure fixture)`, codexHome: home,
        } : request.method === 'config/read' ? { config: {
          approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
          sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
          default_permissions: 'forgedesk_workspace_v1', permissions: { forgedesk_workspace_v1: {
            extends: ':workspace', filesystem: { ':tmpdir': 'read', ':slash_tmp': 'read' }, network: { enabled: false },
          } },
        } } : request.method === 'configRequirements/read' ? { requirements: null } : {};
        queueMicrotask(() => owned.stdout.emit('data', Buffer.from(JSON.stringify({ id: request.id, result }) + '\n')));
        return true;
      };
      owned.stdin.end = () => { owned.endCalls++; queueMicrotask(() => { owned.exitCode = 0; owned.emit('close', 0, null); }); };
    }
    return owned;
  };
  if (!protocol) {
    value.request = async method => method === 'initialize' ? {
      userAgent: `forgedesktop/${module.exports.CODEX_PROTOCOL_VERSION} (pure fixture)`, codexHome: home,
    } : {};
    value.checkConfig = () => {}; value.checkRequirements = () => {};
  }
  return { value, entered, release, launched, events, timers };
}

test('ordinary real JSONL handshake and fixed policy still become ready and close exactly once', async () => {
  const f = await adapter('ordinary', false, false, true);
  await f.value.start();
  assert.equal(f.value.state, 'ready'); assert.equal(f.launched.length, 1);
  const methods = f.launched[0].writes.map(message => message.method);
  assert.deepEqual(methods.slice(0, 4), ['initialize', 'initialized', 'config/read', 'configRequirements/read']);
  await f.value.stop();
  assert.equal(f.value.state, 'stopped'); assert.equal(f.launched[0].endCalls, 1);
  assert.equal(f.launched[0].killCalls, 0);
});

test('ordinary malformed protocol still fails closed and drains only its owned fake process', async () => {
  const f = await adapter('ordinary', false, false, true);
  await f.value.start();
  f.launched[0].stdout.emit('data', Buffer.from('not-json\n'));
  assert.equal(f.value.state, 'failed');
  await f.value.stop();
  assert.equal(f.value.state, 'stopped'); assert.equal(f.launched[0].endCalls, 1);
});

test('ordinary shutdown grace timer never signals a PID that exited before stdio close', async () => {
  const f = await adapter('ordinary', false, true), owned = child(); owned.pid = 123456;
  f.value.process = owned; f.value.phase = 'ready'; f.value.attach(owned, f.value.connectionGeneration);
  const stopping = f.value.stop();
  try {
    assert.equal(f.timers.length, 1); assert.equal(f.timers[0].ms, 1500);
    owned.exitCode = 0; owned.emit('exit', 0, null);
    assert.doesNotThrow(() => f.timers[0].callback(), 'do not taskkill an exited PID while pipes drain');
    assert.equal(owned.killCalls, 0);
  } finally { owned.emit('close', 0, null); await stopping; }
});

for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']) {
  test(`${method} cannot queue an approval for a thread not owned by this connection`, async () => {
    const f = await adapter(), owned = child();
    f.value.process = owned; f.value.phase = 'ready'; f.value.attach(owned, f.value.connectionGeneration);
    try {
      await f.value.serverRequest(method, 'foreign-id', { threadId: 'foreign-thread', turnId: 'turn', itemId: 'item' }, f.value.connectionGeneration);
      assert.equal(f.value.pendingApprovals().length, 0);
      assert.equal(owned.writes.length, 1); assert.equal(owned.writes[0].error.code, -32602);
      f.value.workspaces.set('known-thread', '/known-workspace');
      await f.value.serverRequest(method, 'known-id', { threadId: 'known-thread', turnId: 'turn', itemId: 'item' }, f.value.connectionGeneration);
      assert.equal(f.value.pendingApprovals().length, 1, 'legitimate loaded-thread approval is retained');
    } finally { owned.emit('close', 0, null); await f.value.stop(); }
  });
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('stop during ordinary startup filesystem work prevents any later engine launch', async () => {
  const f = await adapter('ordinary', true);
  const starting = f.value.start().then(() => ({ ok: true }), error => ({ ok: false, error }));
  await f.entered.promise;
  const stopping = f.value.stop();
  f.release.resolve();
  try {
    const outcome = await starting; await stopping;
    assert.equal(f.launched.length, 0, 'a stopped startup must not spawn a new engine');
    assert.equal(outcome.ok, false); assert.match(outcome.error.message, /cancelled|stopped/i);
    assert.equal(f.value.state, 'stopped');
  } finally {
    for (const owned of f.launched) owned.emit('close', 0, null);
    await f.value.stop();
  }
});

for (const kind of ['ordinary', 'restricted']) {
  test(`${kind} stop waits for actual close after exitCode becomes available`, async () => {
    const f = await adapter(kind), owned = child();
    f.value[kind === 'ordinary' ? 'process' : 'child'] = owned;
    f.value.phase = 'ready'; f.value.attach(owned, f.value.connectionGeneration);
    owned.exitCode = 0; owned.emit('exit', 0, null);
    let settled = false;
    const stopping = f.value.stop().then(() => { settled = true; });
    try {
      await nextTurn();
      assert.equal(settled, false, 'exit is not the stdio close event');
      assert.equal(f.value.state, 'stopping');
      assert.equal(owned.killCalls, 0, 'do not signal an already exited PID');
    } finally { owned.emit('close', 0, null); await stopping; }
    assert.equal(f.value.state, 'stopped');
  });
}
