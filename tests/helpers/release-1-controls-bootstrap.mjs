import assert from 'node:assert/strict';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{64}$/;
export const RUNTIME_SEEDS = ['@electron/asar', 'playwright', 'tsx', 'typescript'];
export const BOOTSTRAP = 'tests/helpers/release-1-controls-bootstrap.mjs';
export const SOURCE_FILES = [
  'packages/engine-adapter/snapshot-isolation.ts', 'packages/engine-adapter/workspace-policy.ts',
  'packages/engineering-runner/device/types.ts', 'packages/engineering-runner/embedded/files.ts', 'packages/engineering-runner/embedded/profile.ts', 'packages/engineering-runner/embedded/types.ts',
  'packages/engineering-runner/environment.ts', 'packages/engineering-runner/fingerprint.ts', 'packages/engineering-runner/fz3b/availability.ts', 'packages/engineering-runner/fz3b/payload.ts',
  'packages/engineering-runner/fz3b/preflight-refusal-proof.ts', 'packages/engineering-runner/fz3b/profile.ts', 'packages/engineering-runner/fz3b/reconciliation.ts', 'packages/engineering-runner/fz3b/resources.ts', 'packages/engineering-runner/fz3b/types.ts',
  'packages/engineering-runner/index.ts', 'packages/engineering-runner/processes.ts', 'packages/engineering-runner/redaction.ts', 'packages/engineering-runner/snapshots.ts', 'packages/engineering-runner/types.ts',
  'packages/shared/contracts.ts', 'packages/shared/hardware-agent.ts', 'tests/helpers/controls-stop-observer.ts', 'tests/helpers/embedded-installed.ts', 'tests/helpers/fz3b-preflight-observation.ts',
  'tests/helpers/normal-close-observation.ts', 'tests/helpers/playwright-no-kill.ts', 'tests/helpers/release-1-binding.ts', BOOTSTRAP,
  'tests/helpers/release-1-controls-observer.ts', 'tests/helpers/release-1-controls.test.ts', 'tests/helpers/release-1-controls.ts', 'tests/helpers/release-1-files.ts', 'tests/helpers/release-1-historical-inspect.ts', 'tests/helpers/release-1-policy.ts', 'tests/helpers/release-1-software-bootstrap.mjs',
  'tests/helpers/second-user-controls.ts', 'tests/helpers/second-user-missing-tools.ts', 'tests/helpers/snapshot-failure-diagnostics.ts', 'tests/helpers/snapshot-installed-lifecycle.ts', 'tests/helpers/snapshot-smoke-scope.ts',
  'tests/release-1-controls-smoke.ts',
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };
const relative = value => { assert.ok(typeof value === 'string' && value.length <= 512 && !/[\\:\x00-\x1f\x7f]/.test(value)); assert.ok(value.split('/').every(p => p && p !== '.' && p !== '..')); return value; };
async function plain(file) {
  const absolute = path.resolve(file); let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) { current = path.join(current, segment); assert.equal((await lstat(current)).isSymbolicLink(), false); }
}
export async function stable(file, limit = 256 * 1024 * 1024) {
  assert.ok(Number.isSafeInteger(limit) && limit >= 0 && limit <= 256 * 1024 * 1024);
  await plain(file); const before = await lstat(file); assert.ok(before.isFile() && before.nlink === 1 && Number.isSafeInteger(before.size) && before.size >= 0 && before.size <= limit);
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const identity = item => [item.dev, item.ino, item.nlink, item.size, item.ctimeMs, item.mtimeMs];
  try {
    assert.deepEqual(identity(await fd.stat()), identity(before)); const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const part = await fd.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    assert.equal(count, before.size); assert.deepEqual(identity(await fd.stat()), identity(before)); assert.deepEqual(identity(await lstat(file)), identity(before)); await plain(file); return bytes.subarray(0, count);
  } finally { await fd.close(); }
}
async function resolvePackage(root, from, name, optional) {
  assert.match(name, /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i); let current = from;
  while (inside(root, current)) {
    if (path.basename(current) !== 'node_modules') {
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
  const pins = new Map(); let total = 0, directories = 0;
  const visit = async (directory, depth) => {
    assert.ok(depth <= 32 && ++directories <= 10000); await plain(directory); const before = await lstat(directory); assert.ok(before.isDirectory()); const names = (await readdir(directory)).sort();
    for (const name of names) {
      const file = path.join(directory, name), rel = path.relative(root, file).split(path.sep).join('/'); await plain(file); const info = await lstat(file);
      if (info.isDirectory()) await visit(file, depth + 1);
      else if (!pins.has(rel)) { assert.ok(pins.size < 10000); const bytes = await stable(file, Math.min(256 * 1024 * 1024, 512 * 1024 * 1024 - total)); total += bytes.length; pins.set(rel, { path: rel, bytes: bytes.length, sha256: digest(bytes) }); }
    }
    assert.deepEqual((await readdir(directory)).sort(), names); const after = await lstat(directory); assert.deepEqual([before.dev, before.ino, before.ctimeMs, before.mtimeMs], [after.dev, after.ino, after.ctimeMs, after.mtimeMs]);
  };
  for (const directory of [...roots].sort()) await visit(directory, 0);
  return { runtimePackages: [...roots].map(directory => path.relative(root, directory).split(path.sep).join('/')).sort(), runtimePins: [...pins.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
}
export async function verifyRuntime(root, receipt) {
  assert.ok(Array.isArray(receipt.runtimePackages) && receipt.runtimePackages.length >= RUNTIME_SEEDS.length && receipt.runtimePackages.length <= 128);
  assert.ok(Array.isArray(receipt.runtimePins) && receipt.runtimePins.length > 0 && receipt.runtimePins.length <= 10000);
  for (const name of receipt.runtimePackages) { relative(name); assert.ok(name.startsWith('node_modules/')); }
  for (const pin of receipt.runtimePins) { relative(pin.path); assert.ok(pin.path.startsWith('node_modules/')); assert.match(pin.sha256, SHA); assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0); }
  assert.deepEqual(await runtimeClosure(root), { runtimePackages: receipt.runtimePackages, runtimePins: receipt.runtimePins });
}
export async function verifyResolutionMetadata(root, candidateSha256) {
  assert.match(candidateSha256, SHA);
  const raw = await stable(path.join(root, 'output/release-1.0/package-audit/RELEASE_MANIFEST.json'), 8 * 1024 * 1024); assert.equal(digest(raw), candidateSha256);
  const release = JSON.parse(raw.toString()); assert.equal(release.schema, 'forgedesk-release-package-audit-v1'); assert.equal(release.version, '1.0.0');
  for (const [file, key] of [['package.json', 'packageSha256'], ['package-lock.json', 'lockSha256']]) {
    assert.match(release.sourceFreeze[key], SHA); assert.equal(digest(await stable(path.join(root, file), 8 * 1024 * 1024)), release.sourceFreeze[key]);
  }
  const checked = new Set();
  for (const file of SOURCE_FILES) {
    let current = path.dirname(path.join(root, file));
    while (current !== root) {
      assert.ok(inside(root, current)); if (!checked.has(current)) {
        checked.add(current);
        for (const name of ['package.json', 'node_modules']) {
          try { await lstat(path.join(current, name)); throw Error(name === 'package.json' ? 'CONTROLS_UNREVIEWED_SOURCE_PACKAGE_SCOPE' : 'CONTROLS_UNREVIEWED_SOURCE_NODE_MODULES'); }
          catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
      }
      current = path.dirname(current);
    }
  }
}
export async function bootstrap(root, planPath, planSha256, capturedSelfSha256) {
  root = path.resolve(root); assert.equal(process.platform, 'win32'); assert.match(planSha256, SHA); assert.match(capturedSelfSha256, SHA);
  for (const [key, value] of Object.entries(process.env)) if (value && /^(?:NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|ESBUILD_BINARY_PATH|TSX_.*)$/i.test(key)) throw Error('CONTROLS_BOOTSTRAP_AMBIENT_LOADER');
  assert.equal(process.env.NODE_DISABLE_COMPILE_CACHE, '1', 'Root must disable Node compile cache before starting Node');
  assert.ok(path.isAbsolute(planPath) && inside(path.join(root, 'output/release-1.0/controls/runs'), planPath));
  const planRaw = await stable(planPath, 8 * 1024 * 1024); assert.equal(digest(planRaw), planSha256); const plan = JSON.parse(planRaw.toString());
  assert.equal(plan.scope, 'release-1-controls-plan-v1'); assert.equal(plan.version, '1.0.0'); assert.match(plan.id, /^release-1-controls-\d{13}-[a-f0-9]{6}$/);
  assert.equal(path.resolve(planPath), path.join(root, 'output/release-1.0/controls/runs', plan.id, 'plan.json'));
  assert.ok(path.isAbsolute(plan.harnessPath) && inside(path.join(root, 'output/release-1.0/controls/manifests'), plan.harnessPath)); assert.match(plan.harnessSha256, SHA);
  const harnessRaw = await stable(plan.harnessPath, 8 * 1024 * 1024); assert.equal(digest(harnessRaw), plan.harnessSha256); const harness = JSON.parse(harnessRaw.toString());
  assert.equal(harness.scope, 'release-1-controls-harness-v2'); assert.equal(harness.version, '1.0.0'); assert.equal(harness.candidateSha256, plan.candidateSha256);
  assert.ok(Array.isArray(harness.sources) && harness.sources.length > 0 && harness.sources.length <= 256); let total = 0;
  assert.deepEqual(harness.sources.map(pin => pin.path), SOURCE_FILES);
  for (const pin of harness.sources) { relative(pin.path); assert.match(pin.sha256, SHA); const bytes = await stable(path.join(root, pin.path), Math.min(2 * 1024 * 1024, 24 * 1024 * 1024 - total)); total += bytes.length; assert.equal(bytes.length, pin.bytes); assert.equal(digest(bytes), pin.sha256); }
  assert.equal(harness.sources.find(p => p.path === BOOTSTRAP)?.sha256, capturedSelfSha256);
  assert.equal(harness.node.path, 'C:/Program Files/nodejs/node.exe'); assert.equal(path.resolve(process.execPath).toLowerCase(), path.resolve(harness.node.path).toLowerCase());
  const node = await stable(harness.node.path); assert.equal(node.length, harness.node.bytes); assert.equal(digest(node), harness.node.sha256);
  await verifyResolutionMetadata(root, plan.candidateSha256);
  await verifyRuntime(root, harness);
  const require = createRequire(path.join(root, 'package.json')); const loader = require.resolve('tsx/esm/api');
  assert.ok(harness.runtimePins.some(p => path.resolve(root, p.path) === path.resolve(loader)));
  process.env.TSX_DISABLE_CACHE = '1';
  const { tsImport } = await import(pathToFileURL(loader).href);
  const entry = await tsImport(pathToFileURL(path.join(root, 'tests/release-1-controls-smoke.ts')).href, { parentURL: pathToFileURL(path.join(root, 'package.json')).href, tsconfig: false });
  await entry.main(['run', planPath, planSha256], true);
}
