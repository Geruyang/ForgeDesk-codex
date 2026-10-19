import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { fileSha256, plainPath, samePath } from './embedded-installed';

export const snapshotReleaseVersion = '0.5.1';
export const snapshotReleaseResources = [
  'ForgeDesk.exe', 'resources/app.asar', 'resources/codex/codex.exe',
  'resources/codex/codex-code-mode-host.exe', 'resources/codex/codex-command-runner.exe',
  'resources/codex/codex-windows-sandbox-setup.exe', 'resources/process-host/process-host.exe',
  ...['build.mjs', 'verify.mjs', 'permission-probe.mjs', 'sandbox-probe.mjs'].map(name => `resources/templates/node-software-v1/${name}`),
];

export async function verifySnapshotInstalledRelease(root: string, executable: string) {
  assert.equal(samePath(executable, path.join(root, 'install/ForgeDesk.exe')), true);
  const filename = path.join(root, 'output/qa/2026-10-16-snapshot-installed/release-candidate.json');
  await plainPath(filename);
  const candidate = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.version, snapshotReleaseVersion);
  assert.equal(candidate.scope, 'unsigned-snapshot-release-candidate');
  assert.equal(candidate.installer.path, `release/ForgeDesk-${snapshotReleaseVersion}-x64-setup.exe`);
  assert.deepEqual(candidate.resources.map((item: { path: string }) => item.path).sort(), [...snapshotReleaseResources].sort());
  const checked = [];
  for (const item of [candidate.installer, ...candidate.resources.map((item: { path: string; sha256: string; bytes: number }) => ({ ...item, path: `install/${item.path}` }))]) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    const target = path.join(root, item.path); await plainPath(target);
    const stat = await lstat(target); assert.ok(stat.isFile()); assert.equal(stat.size, item.bytes);
    assert.equal(await fileSha256(target), item.sha256, `Installed candidate mismatch: ${item.path}`);
    checked.push({ path: item.path, sha256: item.sha256, bytes: item.bytes });
  }
  return { version: candidate.version, manifest: filename, manifestSha256: await fileSha256(filename), checked };
}
