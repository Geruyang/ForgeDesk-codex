import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import test from 'node:test';
import { createNativeStartupHistoryOwner } from './release-recovery-history-launch.js';
import { startupHistoryWorkerFrame } from './release-recovery-history-worker.js';
import { readReleaseRecoveryHistory } from './release-recovery-history.js';

const options = () => ({ dataDir: process.cwd(), packaged: false, mainDirectory: path.join(process.cwd(), 'dist/main'),
  resourcesPath: path.join(process.cwd(), 'offline-resources'), appPath: process.cwd(), executable: process.execPath });
function child() {
  const events = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough(); let input: Buffer = Buffer.alloc(0);
  return { events, input: () => input, port: { once: events.once.bind(events), stdout, stderr,
    stdin: { on() {}, end(raw: Buffer) { input = raw; } }, kill() { return true; } }, stdout };
}
test('native composition pins fixed worker and process host before one launch and captures root before async work', async () => {
  const config = options(), originalRoot = config.dataDir, f = child(); let calls = 0, verified = false;
  const owner = createNativeStartupHistoryOwner(config, { async verify(worker, host) {
    assert.equal(worker, path.join(config.mainDirectory, 'release-recovery-history-worker.cjs'));
    assert.equal(host, path.join(config.appPath, 'vendor/process-host/process-host.exe')); verified = true;
  }, launch: ((file: string, args: string[], launchOptions: any) => {
    calls++; assert(verified); assert.equal(file, path.join(process.cwd(), 'vendor/process-host/process-host.exe'));
    assert.deepEqual(args, ['--', process.execPath, path.join(process.cwd(), 'dist/main/release-recovery-history-worker.cjs')]);
    assert.equal(launchOptions.shell, false); assert.equal(launchOptions.windowsHide, true);
    assert.deepEqual(Object.keys(launchOptions.env).sort(), ['ELECTRON_RUN_AS_NODE', 'SystemRoot', 'WINDIR']);
    return f.port;
  }) as any });
  const pending = owner.read(); config.dataDir = path.join(process.cwd(), 'renderer-mutation');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  assert.equal(JSON.parse(f.input().toString()).dataDir, originalRoot);
  f.events.emit('spawn');
  f.stdout.write(await startupHistoryWorkerFrame(f.input(), async () => readReleaseRecoveryHistory({ async readExistingHistory(): Promise<any> { throw Error('Offline missing home'); } })));
  f.events.emit('close', 0, null); const result = await pending;
  assert.equal(result.status, 'observed'); assert.equal(result.projection!.status, 'history-read-held');
  assert.equal(owner.read(), pending); assert.equal(calls, 1);
});
test('pin verification refusal starts no process and emits no private error text', async () => {
  let calls = 0;
  const owner = createNativeStartupHistoryOwner(options(), { async verify() { throw Error('private-key-path'); }, launch: (() => { calls++; throw Error(); }) as any });
  const result = await owner.read(); assert.equal(calls, 0); assert.equal(result.status, 'held');
  assert.equal(result.closeConfirmed, true); assert(!JSON.stringify(result).includes('private-key'));
});
test('packaged composition uses fixed installed process host and rejects foreign executable before any port', async () => {
  const config = { ...options(), packaged: true }; let verified = 0;
  assert.throws(() => createNativeStartupHistoryOwner({ ...config, executable: path.join(process.cwd(), 'foreign.exe') }));
  const owner = createNativeStartupHistoryOwner(config, { async verify(worker, host) {
    assert.equal(worker, path.join(config.resourcesPath, 'startup-history/release-recovery-history-worker.cjs'));
    verified++; assert.equal(host, path.join(config.resourcesPath, 'process-host/process-host.exe')); throw Error('Stop fixture');
  }, launch: (() => { throw Error('Must not launch'); }) as any });
  await owner.read(); assert.equal(verified, 1);
});
test('entry bundle bounds stdin and never calls the worker on oversized input', async () => {
  const result = await build({ entryPoints: ['apps/desktop/main/release-recovery-history-worker-entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'pure-entry-port', setup(builder) {
      builder.onResolve({ filter: /release-recovery-history-worker\.js$/ }, () => ({ path: 'worker', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const startupHistoryWorkerFrame = globalThis.fixtureRead;' }));
    } }] });
  for (const oversized of [false, true]) {
    const stdin = new EventEmitter(); let calls = 0, output = '';
    const fake = { stdin, stdout: { on() {}, end(bytes: Buffer, done: () => void) { output = bytes.toString(); done(); } },
      execPath: process.execPath, exitCode: undefined as number | undefined };
    const module = { exports: {} };
    runInNewContext(result.outputFiles[0]!.text, { module, exports: module.exports, require: (name: string) => { assert.equal(name, 'node:path'); return path; },
      Buffer, process: fake, fixtureRead: async () => { calls++; return Buffer.from('fixture-result'); } });
    stdin.emit('data', Buffer.alloc(oversized ? 8193 : 1)); stdin.emit('end');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, oversized ? 0 : 1); assert.equal(fake.exitCode, oversized ? 2 : 0); assert.equal(output, oversized ? '' : 'fixture-result');
  }
});
test('main starts background read only after window visibility and shutdown checks owner before existing teardown', async () => {
  const main = await readFile('apps/desktop/main/index.ts', 'utf8'), buildSource = await readFile('scripts/build.mjs', 'utf8');
  const loaded = main.indexOf('await window.loadFile('), start = main.indexOf('const startReadonlyHistoryDiagnostic =');
  assert(loaded >= 0 && start > loaded); assert(main.includes('!window?.isVisible()'));
  assert(main.includes('setImmediate(startReadonlyHistoryDiagnostic)'));
  const shutdown = main.slice(main.indexOf('async function shutdown()'));
  assert(shutdown.indexOf('await startupHistoryOwner.read()') > 0 &&
    shutdown.indexOf('await startupHistoryOwner.read()') < shutdown.indexOf('try { await embedded.assertIdle(); await fz3bAgent?.assertIdle();'));
  assert(buildSource.indexOf("outfile: 'dist/main/release-recovery-history-worker.cjs'") < buildSource.indexOf("outfile: 'dist/main/index.cjs'"));
  assert(buildSource.includes('define: hardwareDefines'));
});
