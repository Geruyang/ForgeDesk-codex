import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('../apps/desktop/main/hardware-runtime.ts', import.meta.url));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function verifier(manifest: string, worker: string, defineWorker = true) {
  const result = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false,
    define: { __FORGEDESK_HARDWARE_MANIFEST_SHA256__: JSON.stringify(hash(manifest)),
      ...(defineWorker ? { __FORGEDESK_HARDWARE_WORKER_SHA256__: JSON.stringify(hash(worker)) } : {}) } });
  const module = { exports: {} as { verifyHardwareRuntime(root: string, worker?: string): Promise<void> } };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, process, Buffer });
  return module.exports.verifyHardwareRuntime;
}
async function fixture(layout: 'development' | 'packaged' = 'packaged') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgedesk-runtime-test-'));
  const runtime = layout === 'development' ? path.join(root, 'vendor/hardware') : path.join(root, 'resources/hardware');
  const worker = layout === 'development' ? path.join(root, 'engineering/hardware-worker.py') : path.join(root, 'resources/hardware-worker.py');
  const contents = 'raise RuntimeError("fixture must never execute")\n';
  const files = [{ path: 'python/python.exe', data: 'not an executable' }, { path: 'python/Lib/site-packages/serial/__init__.py', data: 'fixture' }, { path: 'python/python313._pth', data: 'python313.zip\n.\nLib/site-packages\n' }];
  for (const file of files) { const absolute = path.join(runtime, file.path); await mkdir(path.dirname(absolute), { recursive: true }); await writeFile(absolute, file.data); }
  await mkdir(path.dirname(worker), { recursive: true }); await writeFile(worker, contents);
  const manifest = JSON.stringify({ schemaVersion: 1, files: files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.data), sha256: hash(file.data) })) });
  await writeFile(path.join(runtime, 'manifest.json'), manifest);
  return { root, runtime, worker, contents, manifest, files, verify: await verifier(manifest, contents),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('runtime verifier accepts exact packaged and development layouts without executing worker', async () => {
  for (const layout of ['development', 'packaged'] as const) {
    const f = await fixture(layout);
    try { await f.verify(f.runtime); await f.verify(f.runtime, f.worker); }
    finally { await f.cleanup(); }
  }
});

test('runtime verifier requires a compiled worker hash', async () => {
  const f = await fixture();
  try { await assert.rejects((await verifier(f.manifest, f.contents, false))(f.runtime, f.worker), /worker is not pinned/); }
  finally { await f.cleanup(); }
});

test('runtime verifier rejects modified worker and modified listed runtime file', async () => {
  for (const modified of ['worker', 'runtime'] as const) {
    const f = await fixture();
    try {
      await writeFile(modified === 'worker' ? f.worker : path.join(f.runtime, 'python/python.exe'), 'modified');
      await assert.rejects(f.verify(f.runtime, f.worker), /changed/);
    } finally { await f.cleanup(); }
  }
});

test('runtime verifier rejects unlisted Python, DLL, bytecode and root files', async () => {
  for (const injected of ['python/sitecustomize.py', 'python/Lib/site-packages/serial/extra.pyc', 'python/injected.dll', 'extra.json']) {
    const f = await fixture();
    try { await writeFile(path.join(f.runtime, injected), 'injected'); await assert.rejects(f.verify(f.runtime, f.worker), /Unlisted/); }
    finally { await f.cleanup(); }
  }
});

test('runtime verifier rejects an extra empty import directory', async () => {
  const f = await fixture();
  try { await mkdir(path.join(f.runtime, 'python/extra_namespace')); await assert.rejects(f.verify(f.runtime, f.worker), /Unlisted.*directory/); }
  finally { await f.cleanup(); }
});

test('runtime verifier rejects a linked runtime ancestor even when all bytes match', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.root, 'linked-resources');
    await symlink(path.dirname(f.runtime), alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.verify(path.join(alias, 'hardware'), f.worker), /links|reparse/);
  } finally { await f.cleanup(); }
});

test('runtime verifier rejects a linked nested directory into otherwise trusted bytes', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.runtime, 'python/Lib'); const relocated = path.join(f.root, 'original-lib');
    await rename(directory, relocated); await symlink(relocated, directory, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.verify(f.runtime, f.worker), /links|reparse/);
  } finally { await f.cleanup(); }
});

test('each verification call rechecks hashes and inventory with no cross-call cache', async () => {
  const f = await fixture();
  try {
    await f.verify(f.runtime, f.worker);
    await writeFile(path.join(f.runtime, 'python/python.exe'), f.files[0].data.replace('executable', 'EXECUTABLE'));
    await assert.rejects(f.verify(f.runtime, f.worker), /changed/);
    await writeFile(path.join(f.runtime, 'python/python.exe'), f.files[0].data);
    await f.verify(f.runtime, f.worker);
    await writeFile(path.join(f.runtime, 'python/injected.dll'), 'injected');
    await assert.rejects(f.verify(f.runtime, f.worker), /Unlisted/);
  } finally { await f.cleanup(); }
});

test('runtime verifier rejects a linked worker ancestor', async () => {
  const f = await fixture();
  try {
    const alias = path.join(f.root, 'worker-parent');
    await symlink(path.dirname(f.worker), alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.verify(f.runtime, path.join(alias, path.basename(f.worker))), /links|reparse/);
  } finally { await f.cleanup(); }
});

test('runtime manifest must be a regular file and cannot be followed through links', async () => {
  const f = await fixture();
  try {
    const manifest = path.join(f.runtime, 'manifest.json'); const relocated = path.join(f.root, 'manifest-original.json');
    await rename(manifest, relocated);
    if (process.platform === 'win32') {
      // Directory junctions need no Windows symbolic-link privilege.
      await mkdir(manifest); await assert.rejects(f.verify(f.runtime, f.worker), /not a regular file/);
    } else {
      await symlink(relocated, manifest); await assert.rejects(f.verify(f.runtime, f.worker), /links|reparse/);
    }
  } finally { await f.cleanup(); }
});

test('pinned manifests still reject traversal, Windows aliases, duplicate paths and invalid sizes', async () => {
  for (const mutate of [
    (files: any[]) => { files[0].path = '../escape.exe'; },
    (files: any[]) => { files[0].path = 'C:escape.exe'; },
    (files: any[]) => { files[0].path = 'python/python.exe:stream'; },
    (files: any[]) => { files[0].path = 'python/python.exe.'; },
    (files: any[]) => { files.push({ ...files[0], path: 'PYTHON/PYTHON.EXE' }); },
    (files: any[]) => { files[0].bytes = -1; },
  ]) {
    const f = await fixture();
    try {
      const manifest = JSON.parse(f.manifest); mutate(manifest.files); const raw = JSON.stringify(manifest);
      await writeFile(path.join(f.runtime, 'manifest.json'), raw);
      await assert.rejects((await verifier(raw, f.contents))(f.runtime, f.worker), /Invalid|Duplicate/);
    } finally { await f.cleanup(); }
  }
});
