import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { snapshotReleaseResources, snapshotReleaseVersion, verifySnapshotInstalledRelease } from './snapshot-installed-release';

test('installed snapshot identity binds exact candidate resources and rejects tamper, missing pins, wrong version and alternate executable', async () => {
  const base = path.join(process.cwd(), '.runner-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'installed-release-fixture-'));
  const bytes = Buffer.from('NON_EXECUTABLE_TEST_FIXTURE');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const resources = snapshotReleaseResources.map(file => ({ path: file, bytes: bytes.length, sha256 }));
  const installer = { path: `release/ForgeDesk-${snapshotReleaseVersion}-x64-setup.exe`, bytes: bytes.length, sha256 };
  for (const relative of [installer.path, ...resources.map(item => `install/${item.path}`)]) {
    const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
  }
  const candidate = { schemaVersion: 1, scope: 'unsigned-snapshot-release-candidate', version: snapshotReleaseVersion, installer, resources };
  const manifest = path.join(root, 'output/qa/2026-10-16-snapshot-installed/release-candidate.json');
  await mkdir(path.dirname(manifest), { recursive: true });
  const save = async (value: unknown) => writeFile(manifest, JSON.stringify(value));
  await save(candidate);
  const exe = path.join(root, 'install/ForgeDesk.exe');
  assert.equal((await verifySnapshotInstalledRelease(root, exe)).checked.length, resources.length + 1);
  await assert.rejects(verifySnapshotInstalledRelease(root, path.join(root, 'release/win-unpacked/ForgeDesk.exe')));
  await save({ ...candidate, version: '0.5.0' }); await assert.rejects(verifySnapshotInstalledRelease(root, exe));
  await save({ ...candidate, resources: resources.slice(1) }); await assert.rejects(verifySnapshotInstalledRelease(root, exe));
  await save(candidate);
  await writeFile(path.join(root, 'install/resources/app.asar'), Buffer.alloc(bytes.length, 65));
  await assert.rejects(verifySnapshotInstalledRelease(root, exe), /Installed candidate mismatch/);
});
