import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { discoverTestFiles, parseArguments, runTests } from '../scripts/run-tests.mjs';

test('discovers renderer TSX, nested helpers and MJS omitted by the old entry', () => {
  const f = base({ 'apps/desktop/renderer/missed.test.tsx': 'file', 'packages/process-host': 'dir',
    'packages/process-host/covered.test.mjs': 'file', 'packages/unit': 'dir', 'packages/unit/covered.test.ts': 'file',
    'tests/covered.test.ts': 'file', 'tests/helpers': 'dir', 'tests/helpers/missed.test.ts': 'file', 'tests/missed.test.mjs': 'file' });
  assert.deepEqual(discoverTestFiles(f.root, f.fs), [
    'apps/desktop/renderer/missed.test.tsx', 'packages/process-host/covered.test.mjs',
    'packages/unit/covered.test.ts', 'tests/covered.test.ts', 'tests/helpers/missed.test.ts', 'tests/missed.test.mjs',
  ]);
});

function tree(entries) {
  const root = path.resolve('fake-repo');
  const kinds = new Map(Object.entries(entries).map(([key, value]) => [path.resolve(root, key), value]));
  const fs = {
    lstatSync: filename => { const kind = kinds.get(filename); if (!kind) throw Error('missing: ' + filename);
      return { isSymbolicLink: () => kind === 'link', isDirectory: () => kind === 'dir', isFile: () => kind === 'file' }; },
    readdirSync: directory => [...kinds.keys()].filter(p => path.dirname(p) === directory && p !== directory).map(p => path.basename(p)).reverse(),
  };
  return { root, fs };
}
function base(extra = {}) {
  return tree({ '.': 'dir', apps: 'dir', 'apps/desktop': 'dir', 'apps/desktop/renderer': 'dir',
    packages: 'dir', tests: 'dir', ...extra });
}
test('does not walk symlink files/directories, excluded artifact trees or non-test files', () => {
  const f = base({ 'tests/visible.test.mjs': 'file', 'tests/link': 'link', 'tests/link/hidden.test.ts': 'file',
    'tests/alias.test.ts': 'link', 'tests/output': 'dir', 'tests/output/hidden.test.ts': 'file',
    'tests/vendor': 'dir', 'tests/vendor/hidden.test.ts': 'file', 'tests/.runtime': 'dir', 'tests/.runtime/hidden.test.ts': 'file',
    'tests/OUTPUT': 'dir', 'tests/OUTPUT/hidden.test.ts': 'file',
    'packages/.test-output': 'dir', 'packages/.test-output/imported-plugin.test.ts': 'file',
    'tests/node_modules': 'dir', 'tests/node_modules/hidden.test.ts': 'file', 'tests/helper.ts': 'file', 'tests/test_fixture.mjs': 'file' });
  assert.deepEqual(discoverTestFiles(f.root, f.fs), ['tests/visible.test.mjs']);
});
test('refuses linked root components, missing roots, read errors and empty discovery', () => {
  for (const entries of [{ apps: 'link' }, { tests: 'link' }, { '.': 'link' }, {}]) {
    const f = base(entries); assert.throws(() => discoverTestFiles(f.root, f.fs));
  }
  const f = base({ 'tests/ok.test.ts': 'file' }); f.fs.readdirSync = () => { throw Error('read-denied'); };
  assert.throws(() => discoverTestFiles(f.root, f.fs), /read-denied/);
  const missing = base(); missing.fs.lstatSync = () => { throw Error('missing-root'); };
  assert.throws(() => discoverTestFiles(missing.root, missing.fs), /missing-root/);
});
test('argument parser defaults to one and accepts explicit current npm concurrency syntax', () => {
  assert.deepEqual(parseArguments([]), { concurrency: 1 });
  assert.deepEqual(parseArguments(['--test-concurrency=2']), { concurrency: 2 });
  assert.deepEqual(parseArguments(['--test-concurrency', '3']), { concurrency: 3 });
  for (const argv of [['--test-concurrency'], ['--test-concurrency=0'], ['--test-concurrency=-1'], ['--test-concurrency=1.5'],
    ['--test-concurrency=Infinity'], ['--test-concurrency=9007199254740992'], ['--test-concurrency=2', '--test-concurrency=1'],
    ['--real-smoke'], ['tests/only.test.ts'], ['--import=evil']]) assert.throws(() => parseArguments(argv));
});

function launchFixture() {
  const child = new EventEmitter(), signals = new EventEmitter(), calls = [], errors = [], kills = [];
  child.pid = 123; child.kill = signal => { kills.push(signal); return true; };
  const ports = { execPath: 'C:/fixed/node.exe', signals, reportError: error => errors.push(error),
    spawn: (...args) => { calls.push(args); return child; } };
  return { child, signals, calls, errors, kills, ports };
}
test('one shell-free current-Node run receives explicit sorted test files and preserves exit code', async () => {
  const f = launchFixture(), root = path.resolve('repo with spaces');
  const promise = runTests(['tests/a.test.mjs', 'apps/desktop/renderer/b.test.tsx'], { concurrency: 2, root }, f.ports);
  assert.deepEqual(f.calls, [['C:/fixed/node.exe', ['--import', 'tsx', '--test', '--test-concurrency=2',
    path.join(root, 'tests/a.test.mjs'), path.join(root, 'apps/desktop/renderer/b.test.tsx')], { cwd: root, shell: false, stdio: 'inherit' }]]);
  f.child.emit('exit', 7, null); let resolved = false; promise.then(() => { resolved = true; }); await Promise.resolve(); assert.equal(resolved, false);
  f.child.emit('close', 7, null); assert.equal(await promise, 7); assert.equal(f.signals.listenerCount('SIGINT'), 0);
});
test('cancellation forwards only to owned child, second signal escalates once and reports cancellation', async () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = launchFixture(), promise = runTests(['tests/a.test.ts'], {}, f.ports);
    f.signals.emit(signal); f.signals.emit(signal); f.signals.emit(signal);
    assert.deepEqual(f.kills, [signal, 'SIGKILL']); f.child.emit('close', 0, null); assert.equal(await promise, code);
    assert.equal(f.signals.listenerCount('SIGINT'), 0); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  }
});
test('spawn errors, synchronous failure and unknown signal exits fail without retry', async () => {
  const f = launchFixture(), promise = runTests(['tests/a.test.ts'], {}, f.ports);
  f.child.emit('error', Error('spawn-failed')); f.child.emit('close', -1, null);
  assert.equal(await promise, 1); assert.equal(f.calls.length, 1); assert.match(f.errors[0], /spawn-failed/);
  const g = launchFixture(); g.ports.spawn = () => { throw Error('sync-failed'); };
  assert.equal(await runTests(['tests/a.test.ts'], {}, g.ports), 1); assert.equal(g.signals.listenerCount('SIGINT'), 0);
  const h = launchFixture(), unknown = runTests(['tests/a.test.ts'], {}, h.ports); h.child.emit('close', null, 'SIGABRT');
  assert.equal(await unknown, 1);
});
