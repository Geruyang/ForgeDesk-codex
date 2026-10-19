import assert from 'node:assert/strict';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readdir, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const PROJECT = 'E:/AiProject/agent-design/ForgeDesk-codex';
export const OUTPUT = 'output/release-1.0/software-acceptance';
export const BOOTSTRAP = 'tests/helpers/release-1-software-bootstrap.mjs';
export const NODE = 'C:/Program Files/nodejs/node.exe';
export const GIT = 'C:/Program Files/Git/mingw64/libexec/git-core/git.exe';
export const RUNTIME_SEEDS = Object.freeze(['@electron/asar', 'playwright', 'tsx', 'typescript']);
export const SOURCE_FILES = Object.freeze([
  "package-lock.json",
  "package.json",
  "packages/engine-adapter/snapshot-isolation.ts",
  "packages/engine-adapter/workspace-policy.ts",
  "packages/engineering-runner/device/types.ts",
  "packages/engineering-runner/embedded/files.ts",
  "packages/engineering-runner/embedded/profile.ts",
  "packages/engineering-runner/embedded/types.ts",
  "packages/engineering-runner/environment.ts",
  "packages/engineering-runner/fingerprint.ts",
  "packages/engineering-runner/fz3b/availability.ts",
  "packages/engineering-runner/fz3b/payload.ts",
  "packages/engineering-runner/fz3b/preflight-refusal-proof.ts",
  "packages/engineering-runner/fz3b/profile.ts",
  "packages/engineering-runner/fz3b/reconciliation.ts",
  "packages/engineering-runner/fz3b/resources.ts",
  "packages/engineering-runner/fz3b/types.ts",
  "packages/engineering-runner/index.ts",
  "packages/engineering-runner/processes.ts",
  "packages/engineering-runner/redaction.ts",
  "packages/engineering-runner/snapshots.ts",
  "packages/engineering-runner/types.ts",
  "packages/shared/contracts.ts",
  "packages/shared/hardware-agent.ts",
  "scripts/release-package-audit.mjs",
  "tests/helpers/embedded-installed.ts",
  "tests/helpers/fz3b-preflight-observation.ts",
  "tests/helpers/normal-close-observation.ts",
  "tests/helpers/playwright-no-kill.ts",
  "tests/helpers/release-1-binding.ts",
  "tests/helpers/release-1-files.ts",
  "tests/helpers/release-1-historical-inspect.ts",
  "tests/helpers/release-1-observer.ts",
  "tests/helpers/release-1-policy.ts",
  "tests/helpers/release-1-snapshot-checks.ts",
  "tests/helpers/release-1-software-bootstrap.d.mts",
  "tests/helpers/release-1-software-bootstrap.mjs",
  "tests/helpers/release-1-software-bootstrap.test.mjs",
  "tests/helpers/release-1-software.test.ts",
  "tests/helpers/release-1-workflow.ts",
  "tests/helpers/second-user-controls.ts",
  "tests/helpers/snapshot-failure-diagnostics.ts",
  "tests/helpers/snapshot-installed-lifecycle.ts",
  "tests/helpers/snapshot-smoke-scope.ts",
  "tests/release-1-software-smoke.ts",
  "tsconfig.json"
]);
const SHA = /^[a-f0-9]{64}$/;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
function exact(value, keys) { assert.ok(value && Object.getPrototypeOf(value) === Object.prototype); assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
function relative(value) { assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\:\x00-\x1f\x7f]/.test(value)); assert.ok(value.split('/').every(p => p && p !== '.' && p !== '..')); return value; }
async function plain(file) {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, segment); assert.equal((await lstat(current)).isSymbolicLink(), false); }
}
export async function stable(file, limit = 256 * 1024 * 1024, expectedStat) {
  await plain(file); const before = await lstat(file); assert.ok(before.isFile() && before.nlink === 1 && before.size >= 0 && before.size <= limit);
  const identity = item => [item.dev, item.ino, item.nlink, item.size, item.ctimeMs, item.mtimeMs];
  if (expectedStat) assert.deepEqual(identity(before), identity(expectedStat));
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.deepEqual(identity(await fd.stat()), identity(before)); const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const part = await fd.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    assert.equal(count, before.size); assert.deepEqual(identity(await fd.stat()), identity(before)); assert.deepEqual(identity(await lstat(file)), identity(before)); await plain(file); return bytes.subarray(0, count);
  } finally { await fd.close(); }
}
async function resolvePackage(root, from, name, optional) {
  assert.match(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i); let current = from;
  while (inside(root, current)) {
    if (path.basename(current).toLowerCase() !== 'node_modules') {
      const candidate = path.join(current, 'node_modules', ...name.split('/'));
      try { await stable(path.join(candidate, 'package.json'), 2 * 1024 * 1024); return candidate; }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    if (current === root) break; current = path.dirname(current);
  }
  assert.ok(optional, 'Missing runtime dependency: ' + name); return undefined;
}
export async function runtimeClosure(root) {
  root = path.resolve(root); const todo = [];
  for (const name of RUNTIME_SEEDS) todo.push(await resolvePackage(root, root, name, false));
  const roots = new Set();
  while (todo.length) {
    const directory = todo.pop(); if (roots.has(directory)) continue; assert.ok(roots.size < 128 && inside(path.join(root, 'node_modules'), directory)); roots.add(directory);
    const pkg = JSON.parse((await stable(path.join(directory, 'package.json'), 2 * 1024 * 1024)).toString());
    const optional = pkg.optionalDependencies ?? {}, dependencies = { ...(pkg.dependencies ?? {}), ...optional };
    for (const name of Object.keys(dependencies).sort()) { const found = await resolvePackage(root, directory, name, Object.hasOwn(optional, name)); if (found) todo.push(found); }
  }
  const pins = new Map(); let reserved = 0, directories = 0;
  const visit = async (directory, depth) => {
    assert.ok(depth <= 32 && ++directories <= 10000); await plain(directory); const before = await lstat(directory); assert.ok(before.isDirectory()); const names = (await readdir(directory)).sort();
    for (const name of names) {
      const file = path.join(directory, name), rel = path.relative(root, file).split(path.sep).join('/'); await plain(file); const info = await lstat(file);
      if (info.isDirectory()) await visit(file, depth + 1);
      else if (!pins.has(rel)) { assert.ok(pins.size < 10000); reserved += info.size + 1; assert.ok(reserved <= 512 * 1024 * 1024); const bytes = await stable(file, 256 * 1024 * 1024, info); pins.set(rel, { path: rel, bytes: bytes.length, sha256: digest(bytes) }); }
    }
    assert.deepEqual((await readdir(directory)).sort(), names); const after = await lstat(directory); assert.deepEqual([before.dev, before.ino, before.ctimeMs, before.mtimeMs], [after.dev, after.ino, after.ctimeMs, after.mtimeMs]);
  };
  for (const directory of [...roots].sort()) await visit(directory, 0);
  return { runtimePackages: [...roots].map(directory => path.relative(root, directory).split(path.sep).join('/')).sort(), runtimePins: [...pins.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
export function assertRuntimeShape(value) {
  assert.ok(Array.isArray(value.runtimePackages) && value.runtimePackages.length >= RUNTIME_SEEDS.length && value.runtimePackages.length <= 128);
  assert.ok(Array.isArray(value.runtimePins) && value.runtimePins.length > 0 && value.runtimePins.length <= 10000);
  assert.deepEqual(value.runtimePackages, [...new Set(value.runtimePackages)].sort());
  assert.deepEqual(value.runtimePins.map(p => p.path), [...new Set(value.runtimePins.map(p => p.path))].sort());
  for (const name of value.runtimePackages) { relative(name); assert.ok(name.startsWith('node_modules/')); }
  for (const p of value.runtimePins) { exact(p, ['path', 'bytes', 'sha256']); relative(p.path); assert.ok(p.path.startsWith('node_modules/')); assert.match(p.sha256, SHA); assert.ok(Number.isSafeInteger(p.bytes) && p.bytes >= 0 && p.bytes <= 256 * 1024 * 1024); }
}
export async function verifyRuntime(root, value) {
  assertRuntimeShape(value); assert.deepEqual(await runtimeClosure(root), { runtimePackages: value.runtimePackages, runtimePins: value.runtimePins });
}
export async function sourceClosure(root) {
  await resolutionMetadata(root, stable);
  const rows = []; let reserved = 0;
  for (const name of SOURCE_FILES) { const file = path.join(root, name), info = await lstat(file); reserved += info.size + 1; assert.ok(reserved <= 24 * 1024 * 1024); const raw = await stable(file, 2 * 1024 * 1024, info); rows.push({ path: name, bytes: raw.length, sha256: digest(raw) }); }
  await resolutionMetadata(root, stable); return rows;
}
export async function resolutionMetadata(root, read = stable) {
  root = path.resolve(root); const seen = new Set();
  for (const source of SOURCE_FILES) {
    let current = path.dirname(path.join(root, source)), depth = 0;
    while (inside(root, current) && current !== root) {
      assert.ok(++depth <= 32);
      for (const [name, limit] of [['package.json', 2 * 1024 * 1024], ['node_modules', 0]]) {
        const file = path.join(current, name);
        if (!seen.has(file)) {
          seen.add(file); assert.ok(seen.size <= 256);
          try { await read(file, limit); throw Error('SOFTWARE_UNLISTED_PACKAGE_SCOPE'); }
          catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
      }
      current = path.dirname(current);
    }
  }
}
export function assertLoaderEnvironment(env) {
  for (const [key, value] of Object.entries(env)) if (value && (/^(?:NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|NODE_V8_COVERAGE|ESBUILD_BINARY_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key) || /^(?:TSX_|PLAYWRIGHT_|PWTEST_)/i.test(key))) throw Error('SOFTWARE_BOOTSTRAP_AMBIENT_LOADER');
}
function assertHarness(harness) {
  exact(harness, ['schemaVersion', 'scope', 'version', 'candidateSha256', 'sources', 'node', 'git', 'runtimePackages', 'runtimePins']);
  assert.equal(harness.schemaVersion, 1); assert.equal(harness.scope, 'release-1-independent-harness-v2'); assert.equal(harness.version, '1.0.0'); assert.match(harness.candidateSha256, SHA);
  assert.ok(Array.isArray(harness.sources)); assert.deepEqual(harness.sources.map(p => p.path), [...SOURCE_FILES]);
  for (const p of [...harness.sources, harness.node, harness.git]) { exact(p, ['path', 'bytes', 'sha256']); assert.ok(Number.isSafeInteger(p.bytes) && p.bytes > 0); assert.match(p.sha256, SHA); }
  assert.equal(harness.node.path, NODE); assert.equal(harness.git.path, GIT); assertRuntimeShape(harness);
}
const realIo = {
  read: stable, sources: sourceClosure, runtime: runtimeClosure,
  identity: () => ({ platform: process.platform, executable: process.execPath })
};
async function rootFreeze(root, releaseSha256, read) {
  assert.match(releaseSha256, SHA); const raw = await read(path.join(root, 'output/release-1.0/package-audit/RELEASE_MANIFEST.json'), 8 * 1024 * 1024);
  assert.equal(digest(raw), releaseSha256); const release = JSON.parse(raw.toString());
  assert.equal(release.schema, 'forgedesk-release-package-audit-v1'); assert.equal(release.version, '1.0.0'); assert.equal(release.appId, 'dev.forgedesk.codex');
  for (const [name, key] of [['package.json', 'packageSha256'], ['package-lock.json', 'lockSha256'], ['scripts/release-package-audit.mjs', 'auditSourceSha256'], ['scripts/build.mjs', 'buildSourceSha256']]) {
    assert.match(release.sourceFreeze?.[key], SHA); assert.equal(digest(await read(path.join(root, name), 8 * 1024 * 1024)), release.sourceFreeze[key]);
  }
  assert.equal(release.sourceFreeze.assetApproval?.path, 'output/release-1.0/ASSET_DISTRIBUTION_APPROVAL.json'); assert.match(release.sourceFreeze.assetApproval?.sha256, SHA);
  assert.equal(digest(await read(path.join(root, release.sourceFreeze.assetApproval.path), 4096)), release.sourceFreeze.assetApproval.sha256);
}
// Data-only verifier. Injected test ports cannot dispatch or mint a native capability.
export async function verifyBeforeImport(root, request, selfSha256, expectedNodeSha256, io = realIo) {
  root = path.resolve(root); assert.match(selfSha256, SHA); assert.match(expectedNodeSha256, SHA);
  exact(request, ['mode', 'path', 'sha256']); assert.ok(request.mode === 'prepare' || request.mode === 'observe'); assert.match(request.sha256, SHA);
  const identity = io.identity(); assert.equal(identity.platform, 'win32'); assert.equal(path.resolve(identity.executable).toLowerCase(), path.resolve(NODE).toLowerCase());
  let manifestPath = request.path, manifestSha256 = request.sha256, plan;
  if (request.mode === 'observe') {
    assert.ok(path.isAbsolute(request.path) && inside(path.join(root, OUTPUT, 'runs'), request.path));
    const raw = await io.read(request.path, 8 * 1024 * 1024); assert.equal(digest(raw), request.sha256); plan = JSON.parse(raw.toString());
    exact(plan, ['schemaVersion', 'scope', 'version', 'acceptanceId', 'preparedAt', 'candidateSha256', 'manifestPath', 'manifestSha256', 'release', 'host']);
    assert.equal(plan.schemaVersion, 1); assert.equal(plan.scope, 'release-1-root-phased-snapshot-v1'); assert.equal(plan.version, '1.0.0'); assert.match(plan.acceptanceId, /^release-1-\d{13}-[a-f0-9]{6}$/);
    assert.equal(path.resolve(request.path), path.join(root, OUTPUT, 'runs', plan.acceptanceId, 'plan.json'));
    manifestPath = plan.manifestPath; manifestSha256 = plan.manifestSha256;
  }
  assert.ok(path.isAbsolute(manifestPath) && inside(path.join(root, OUTPUT, 'manifests'), manifestPath)); assert.match(manifestSha256, SHA);
  const raw = await io.read(manifestPath, 8 * 1024 * 1024); assert.equal(digest(raw), manifestSha256); const harness = JSON.parse(raw.toString()); assertHarness(harness);
  assert.equal(harness.sources.find(p => p.path === BOOTSTRAP)?.sha256, selfSha256); assert.equal(harness.node.sha256, expectedNodeSha256);
  if (plan) assert.equal(plan.candidateSha256, harness.candidateSha256);
  await rootFreeze(root, harness.candidateSha256, io.read);
  await resolutionMetadata(root, io.read);
  for (const p of [harness.node, harness.git]) { const bytes = await io.read(p.path, 256 * 1024 * 1024); assert.equal(bytes.length, p.bytes); assert.equal(digest(bytes), p.sha256); }
  assert.deepEqual(await io.sources(root), harness.sources);
  assert.deepEqual(await io.runtime(root), { runtimePackages: harness.runtimePackages, runtimePins: harness.runtimePins });
  return { harness, plan };
}
async function writeNew(file, value) {
  await plain(path.dirname(file)); const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); assert.ok(bytes.length <= 8 * 1024 * 1024); const fd = await open(file, 'wx');
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
  assert.ok((await stable(file, 8 * 1024 * 1024)).equals(bytes)); return digest(bytes);
}
async function capture(root, releaseSha256, selfSha256, expectedNodeSha256) {
  await rootFreeze(root, releaseSha256, stable);
  const sources = await sourceClosure(root); assert.equal(sources.find(p => p.path === BOOTSTRAP)?.sha256, selfSha256);
  const nodeRaw = await stable(NODE), gitRaw = await stable(GIT); assert.equal(digest(nodeRaw), expectedNodeSha256);
  const manifest = { schemaVersion: 1, scope: 'release-1-independent-harness-v2', version: '1.0.0', candidateSha256: releaseSha256, sources, node: { path: NODE, bytes: nodeRaw.length, sha256: digest(nodeRaw) }, git: { path: GIT, bytes: gitRaw.length, sha256: digest(gitRaw) }, ...await runtimeClosure(root) };
  assertHarness(manifest);
  const directory = path.join(root, OUTPUT, 'manifests'); await plain(path.dirname(directory)); try { await mkdir(directory); } catch (e) { if (e?.code !== 'EEXIST') throw e; } await plain(directory);
  const file = path.join(directory, 'manifest-v2-' + Date.now() + '-' + randomBytes(3).toString('hex') + '.json'), pin = await writeNew(file, manifest);
  return { result: 'source-runtime-manifest-only-not-authorized-not-eligible', manifest: file, sha256: pin };
}
export async function bootstrap(root, mode, args, selfSha256, expectedNodeSha256) {
  root = path.resolve(root); assert.equal(root.toLowerCase(), path.resolve(PROJECT).toLowerCase()); assert.equal(process.platform, 'win32'); assert.equal(path.resolve(process.execPath).toLowerCase(), path.resolve(NODE).toLowerCase());
  assertLoaderEnvironment(process.env); assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1', 'Start fixed Node with NODE_DISABLE_COMPILE_CACHE=1'); assert.match(selfSha256, SHA); assert.match(expectedNodeSha256, SHA); assert.ok(Array.isArray(args) && args.every(v => typeof v === 'string'));
  if (mode === 'capture') { assert.equal(args.length, 1); console.log(JSON.stringify(await capture(root, args[0], selfSha256, expectedNodeSha256))); return; }
  assert.ok(mode === 'prepare' || mode === 'observe'); assert.equal(args.length, mode === 'prepare' ? 6 : 2);
  const checked = await verifyBeforeImport(root, { mode, path: args[0], sha256: args[1] }, selfSha256, expectedNodeSha256);
  process.env.TSX_DISABLE_CACHE = '1'; process.env.NODE_DISABLE_COMPILE_CACHE = '1';
  const require = createRequire(path.join(root, 'package.json')); const loader = require.resolve('tsx/esm/api');
  assert.ok(checked.harness.runtimePins.some(p => path.resolve(root, p.path) === path.resolve(loader)));
  const { tsImport } = await import(pathToFileURL(loader).href);
  const entry = await tsImport(pathToFileURL(path.join(root, 'tests/release-1-software-smoke.ts')).href, { parentURL: pathToFileURL(path.join(root, 'package.json')).href, tsconfig: false });
  await entry.main([mode === 'prepare' ? '--prepare-only' : '--observe', ...args], true);
}
