import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { mkdir, writeFile, readFile, mkdtemp, link, symlink, lstat } from 'node:fs/promises';
import { SOURCE_FILES, RUNTIME_SEEDS, NODE, GIT, OUTPUT, BOOTSTRAP, digest, runtimeClosure, verifyRuntime, verifyBeforeImport, assertLoaderEnvironment, stable } from './release-1-software-bootstrap.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PIN = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const copy = value => structuredClone(value);
const json = value => Buffer.from(JSON.stringify(value));
function inputs() {
  const map = new Map(SOURCE_FILES.map(name => [path.join(ROOT, name), Buffer.from('source:' + name)]));
  map.set(NODE, Buffer.from('fixed fake Node, never executed')); map.set(GIT, Buffer.from('fixed fake Git, never executed'));
  const approvalPath = 'output/release-1.0/ASSET_DISTRIBUTION_APPROVAL.json'; map.set(path.join(ROOT, approvalPath), Buffer.from('fake approval, not authority'));
  const sourceFreeze = Object.fromEntries([['package.json', 'packageSha256'], ['package-lock.json', 'lockSha256'], ['scripts/release-package-audit.mjs', 'auditSourceSha256'], ['scripts/build.mjs', 'buildSourceSha256']].map(([name, key]) => {
    if (!map.has(path.join(ROOT, name))) map.set(path.join(ROOT, name), Buffer.from('source:' + name));
    return [key, digest(map.get(path.join(ROOT, name)))];
  }));
  sourceFreeze.assetApproval = { path: approvalPath, sha256: digest(map.get(path.join(ROOT, approvalPath))) };
  const release = json({ schema: 'forgedesk-release-package-audit-v1', version: '1.0.0', appId: 'dev.forgedesk.codex', sourceFreeze });
  map.set(path.join(ROOT, 'output/release-1.0/package-audit/RELEASE_MANIFEST.json'), release);
  const sources = SOURCE_FILES.map(name => ({ path: name, bytes: map.get(path.join(ROOT, name)).length, sha256: digest(map.get(path.join(ROOT, name))) }));
  const runtimePackages = RUNTIME_SEEDS.map(name => 'node_modules/' + name).sort();
  const runtimePins = runtimePackages.map(name => ({ path: name + '/package.json', bytes: 1, sha256: PIN })).sort((a, b) => a.path < b.path ? -1 : 1);
  const harness = { schemaVersion: 1, scope: 'release-1-independent-harness-v2', version: '1.0.0', candidateSha256: digest(release), sources,
    node: { path: NODE, bytes: map.get(NODE).length, sha256: digest(map.get(NODE)) }, git: { path: GIT, bytes: map.get(GIT).length, sha256: digest(map.get(GIT)) }, runtimePackages, runtimePins };
  const manifestPath = path.join(ROOT, OUTPUT, 'manifests/synthetic.json');
  const plan = { schemaVersion: 1, scope: 'release-1-root-phased-snapshot-v1', version: '1.0.0', acceptanceId: 'release-1-1792377600000-abcdef', preparedAt: '2026-10-19T00:00:00.000Z', candidateSha256: harness.candidateSha256,
    manifestPath, manifestSha256: '', release: {}, host: {} };
  const planPath = path.join(ROOT, OUTPUT, 'runs', plan.acceptanceId, 'plan.json');
  const events = [];
  const io = { identity: () => ({ platform: 'win32', executable: NODE }), read: async file => { events.push(['read', file]); if (!map.has(file)) throw Object.assign(Error('fixture absent'), { code: 'ENOENT' }); return map.get(file); },
    sources: async () => { events.push(['sources']); return copy(harness.sources); }, runtime: async () => { events.push(['runtime']); return { runtimePackages: copy(harness.runtimePackages), runtimePins: copy(harness.runtimePins) }; } };
  const update = () => { map.set(manifestPath, json(harness)); plan.manifestSha256 = digest(map.get(manifestPath)); map.set(planPath, json(plan)); };
  update();
  const expectedSelf = harness.sources.find(p => p.path === BOOTSTRAP).sha256;
  const request = mode => ({ mode, path: mode === 'prepare' ? manifestPath : planPath, sha256: digest(map.get(mode === 'prepare' ? manifestPath : planPath)) });
  const verify = mode => verifyBeforeImport(ROOT, request(mode), expectedSelf, harness.node.sha256, io);
  return { harness, plan, manifestPath, planPath, map, io, events, update, request, verify };
}
test('builtins gate validates both prepare and observe before any third-party dispatch', async () => {
  for (const mode of ['prepare', 'observe']) {
    const f = inputs(), value = await f.verify(mode); assert.deepEqual(value.harness, f.harness);
    assert.ok(f.events.find(e => e[0] === 'sources')); assert.equal(f.events.at(-1)[0], 'runtime');
    assert.equal(f.events.some(e => e[0] === 'import' || e[0] === 'dispatch'), false);
  }
});
test('wrong external SHA, old namespace or absent runtime binding never reaches runtime/import', async () => {
  const bad = inputs(); await assert.rejects(verifyBeforeImport(ROOT, { ...bad.request('prepare'), sha256: OTHER }, PIN, bad.harness.node.sha256, bad.io)); assert.equal(bad.events.some(e => e[0] === 'runtime'), false);
  for (const change of [f => f.harness.scope = 'release-1-independent-harness-v1', f => delete f.harness.runtimePins, f => f.plan.acceptanceId = 'software-057-1792377600000-abcdef']) {
    const f = inputs(); change(f); f.update(); await assert.rejects(f.verify(f.plan.acceptanceId.startsWith('software') ? 'observe' : 'prepare')); assert.equal(f.events.some(e => e[0] === 'runtime'), false);
  }
});
test('root package self-reference, source drift, runtime drift and missing bootstrap pin reject', async () => {
  for (const change of [
    f => { f.map.set(path.join(ROOT, 'package.json'), Buffer.from('{"name":"typescript","exports":"./evil.js"}')); f.harness.sources.find(p => p.path === 'package.json').sha256 = digest(f.map.get(path.join(ROOT, 'package.json'))); },
    f => { f.io.sources = async () => f.harness.sources.slice(1); },
    f => { f.io.runtime = async () => ({ runtimePackages: f.harness.runtimePackages, runtimePins: [] }); },
    f => { f.harness.sources = f.harness.sources.filter(p => p.path !== BOOTSTRAP); }
  ]) { const f = inputs(); change(f); f.update(); await assert.rejects(f.verify('prepare')); }
});
test('new nested package scope cannot redirect a pinned relative source import', async () => {
  for (const name of ['tests/package.json', 'tests/helpers/package.json', 'packages/engineering-runner/package.json', 'tests/helpers/node_modules', 'tests/node_modules', 'packages/engineering-runner/node_modules']) {
    const f = inputs(); f.map.set(path.join(ROOT, name), Buffer.from('{"name":"typescript","exports":"./evil.js"}'));
    await assert.rejects(f.verify('prepare'), /UNLISTED_PACKAGE_SCOPE/); assert.equal(f.events.some(e => e[0] === 'runtime'), false);
  }
});
test('literal fixed Node identity, independently expected Node hash and closed plan inputs reject drift', async () => {
  const f = inputs(); await assert.rejects(verifyBeforeImport(ROOT, f.request('prepare'), f.harness.sources.find(p => p.path === BOOTSTRAP).sha256, OTHER, f.io));
  for (const change of [f => f.io.identity = () => ({ platform: 'win32', executable: 'foreign.exe' }), f => f.plan.authorized = true, f => f.plan.manifestPath = path.join(ROOT, '.runtime/auth.json')]) {
    const f = inputs(); change(f); f.update(); await assert.rejects(f.verify('observe'));
  }
});
test('preload, cache, transpiler and executable override environments are rejected', () => {
  assertLoaderEnvironment({ PATH: 'ordinary', NODE_DISABLE_COMPILE_CACHE: '1' });
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'NODE_V8_COVERAGE', 'ESBUILD_BINARY_PATH', 'TSX_TSCONFIG_PATH', 'TSX_DISABLE_CACHE', 'PLAYWRIGHT_NODEJS_PATH', 'PWTEST_CLI_IS_UNDER_TEST', 'ELECTRON_RUN_AS_NODE']) assert.throws(() => assertLoaderEnvironment({ [name]: '1' }));
});
async function runtimeFixture() {
  const base = path.join(ROOT, OUTPUT, 'bootstrap-fixtures'); await mkdir(base, { recursive: true }); const root = await mkdtemp(path.join(base, 'runtime-'));
  const put = async (name, value) => { const file = path.resolve(root, name); assert.ok(file.startsWith(root + path.sep)); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value, { flag: 'wx' }); return file; };
  for (const name of RUNTIME_SEEDS) await put('node_modules/' + name + '/package.json', JSON.stringify({ name, ...(name === 'tsx' ? { dependencies: { leaf: '1' }, optionalDependencies: { 'optional-native': '1' } } : {}) }));
  await put('node_modules/tsx/node_modules/leaf/package.json', '{"name":"leaf"}'); await put('node_modules/tsx/node_modules/leaf/index.js', '/* data only, never imported */');
  return { root, put };
}
test('runtime capture includes every transitive package file; new/changed/optional bytes invalidate it', async () => {
  const f = await runtimeFixture(), receipt = await runtimeClosure(f.root); assert.equal(receipt.runtimePackages.length, 5); assert.ok(receipt.runtimePins.some(p => p.path.endsWith('/leaf/index.js'))); await verifyRuntime(f.root, receipt);
  await f.put('node_modules/optional-native/package.json', '{"name":"optional-native"}'); await assert.rejects(verifyRuntime(f.root, receipt));
  const current = await runtimeClosure(f.root); await f.put('node_modules/tsx/new.js', '/* unlisted */'); await assert.rejects(verifyRuntime(f.root, current));
});
test('runtime resolver ignores impossible node_modules/node_modules and refuses required external fallback', async () => {
  const f = await runtimeFixture(); await f.put('node_modules/node_modules/leaf/package.json', '{"name":"shadow"}');
  const receipt = await runtimeClosure(f.root); assert.equal(receipt.runtimePackages.some(p => p === 'node_modules/node_modules/leaf'), false);
  const base = path.join(ROOT, OUTPUT, 'bootstrap-fixtures'), empty = await mkdtemp(path.join(base, 'missing-')); await assert.rejects(runtimeClosure(empty));
});
test('stable read refuses oversized/hardlinked data and runtime package junctions', async () => {
  const f = await runtimeFixture(), file = await f.put('one.txt', 'a'); await assert.rejects(stable(file, 0));
  await link(file, path.join(f.root, 'two.txt')); await assert.rejects(stable(file));
  const target = path.join(f.root, 'own-target'); await mkdir(target); await writeFile(path.join(target, 'package.json'), '{}');
  await symlink(target, path.join(f.root, 'node_modules/linked'), 'junction');
  const pkg = path.join(f.root, 'node_modules/tsx/package.json'); await writeFile(pkg, '{"name":"tsx","dependencies":{"linked":"1"}}'); await assert.rejects(runtimeClosure(f.root));
});
test('bootstrap is builtin-only, verifies before dynamic import and disables ambient config/cache', async () => {
  const source = await readFile(path.join(ROOT, BOOTSTRAP), 'utf8');
  for (const match of source.matchAll(/^import .*? from '([^']+)'/gm)) assert.ok(match[1].startsWith('node:'));
  const entry = source.slice(source.indexOf('export async function bootstrap('));
  assert.ok(entry.indexOf('await verifyBeforeImport(') < entry.indexOf("await import(pathToFileURL(loader).href)"));
  assert.ok(entry.indexOf("process.env.TSX_DISABLE_CACHE = '1'") < entry.indexOf("await import(pathToFileURL(loader).href)"));
  assert.ok(entry.includes("process.env.NODE_DISABLE_COMPILE_CACHE, '1'")); assert.ok(entry.includes('tsconfig: false'));
  assert.ok(!entry.includes('child_process') && !entry.includes('.kill('));
});
test('the exact outer stat reserved by an aggregate budget is bound before opening or reading', async () => {
  const f = await runtimeFixture(), file = await f.put('budget-source.txt', 'a'), reserved = await lstat(file);
  await writeFile(file, 'a larger but per-file-valid body');
  assert.ok((await lstat(file)).size > reserved.size + 1);
  await assert.rejects(stable(file, 1024, reserved));
});

test('both real tsx entry calls use encoded file URLs on paths containing spaces and hash characters', async () => {
  const base = path.join(ROOT, OUTPUT, 'bootstrap-fixtures'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'real tsx # entry-')); await mkdir(path.join(root, 'tests'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}', { flag: 'wx' });
  const named = path.join(root, 'tests', 'inert # module.ts');
  await writeFile(named, "export const marker: string = 'encoded-file-name';", { flag: 'wx' });
  const previous = process.env.TSX_DISABLE_CACHE; process.env.TSX_DISABLE_CACHE = '1';
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
    for (const role of ['software', 'controls']) {
      const file = path.join(root, `tests/release-1-${role}-smoke.ts`);
      await writeFile(file, `export const marker: string = 'inert-${role}';`, { flag: 'wx' });
      const source = await readFile(path.join(ROOT, `tests/helpers/release-1-${role}-bootstrap.mjs`), 'utf8');
      const calls = [...source.matchAll(/const entry = await (tsImport\([^\r\n]+);/g)]; assert.equal(calls.length, 1);
      const call = calls[0][1], encoded = `pathToFileURL(path.join(root, 'tests/release-1-${role}-smoke.ts')).href`;
      assert.equal(call.split(encoded).length, 2);
      const original = call.replace(encoded, `path.join(root, 'tests/release-1-${role}-smoke.ts')`);
      if (process.platform === 'win32') {
        await assert.rejects(vm.runInNewContext(original, { tsImport, root, path, pathToFileURL }), error => error?.code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME' && /protocol '[a-z]:'/i.test(error.message));
      }
      const value = await vm.runInNewContext(call, { tsImport, root, path, pathToFileURL });
      assert.deepEqual(Object.keys(value), ['marker']); assert.equal(value.marker, `inert-${role}`); assert.equal(value.main, undefined);
    }
    const url = pathToFileURL(named).href; assert.ok(url.includes('%20') && url.includes('%23'));
    const value = await tsImport(url, { parentURL: pathToFileURL(path.join(root, 'package.json')).href, tsconfig: false });
    assert.deepEqual(Object.keys(value), ['marker']); assert.equal(value.marker, 'encoded-file-name');
  } finally {
    if (previous === undefined) delete process.env.TSX_DISABLE_CACHE; else process.env.TSX_DISABLE_CACHE = previous;
  }
});
