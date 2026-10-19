import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import type { EmbeddedStatus } from '../../packages/engineering-runner/embedded/types';
import { fileSha256, inside, persistentEmbeddedOperations, plainPath } from './embedded-installed';

export async function verifyEmbeddedExport(destination: string, expected: EmbeddedStatus) {
  await plainPath(destination); assert.equal((await lstat(destination)).isDirectory(), true);
  assert.match(expected.taskId, /^[a-zA-Z0-9_-]+$/);
  const prefix = `forgedesk-embedded-${expected.taskId}-`;
  const bundles = (await readdir(destination, { withFileTypes: true })).filter(entry => entry.name.startsWith(prefix) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.name.slice(prefix.length)));
  assert.equal(bundles.length, 1, 'Expected one nested embedded export bundle, not a JSON file in the outer destination');
  assert.equal(bundles[0].isDirectory(), true); const directory = path.join(destination, bundles[0].name); await plainPath(directory);
  const filename = path.join(directory, 'evidence.json'); await plainPath(filename);
  const stat = await lstat(filename); assert.ok(stat.isFile() && stat.nlink === 1);
  const exported = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(exported.schemaVersion, 1); assert.equal(exported.state?.taskId, expected.taskId);
  assert.deepEqual(persistentEmbeddedOperations(exported.state.operations), persistentEmbeddedOperations(expected.operations));
  assert.deepEqual(exported.state.builds?.at(-1), expected.artifact);
  assert.ok(Array.isArray(exported.files) && exported.files.length > 0);
  const seen = new Set<string>();
  for (const file of exported.files) {
    assert.equal(typeof file.path, 'string'); assert.ok(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/).some((part: string) => !part || part === '.' || part === '..'));
    assert.ok(!seen.has(file.path.toLowerCase()), 'Duplicate export manifest file'); seen.add(file.path.toLowerCase());
    const target = path.join(directory, file.path); assert.ok(inside(directory, target)); await plainPath(target);
    const info = await lstat(target); assert.ok(info.isFile() && info.nlink === 1); assert.equal(info.size, file.bytes);
    assert.equal(await fileSha256(target), file.sha256, `Export copy mismatch: ${file.path}`);
  }
  for (const required of ['firmware/GestureScreen.hex', 'firmware/GestureScreen.axf', 'build/keil-build.log', 'build/source-manifest.json']) assert.ok(seen.has(required.toLowerCase()), `Missing exported ${required}`);
  for (const operation of expected.operations.filter(item => item.receipt)) assert.ok(seen.has(`receipts/${operation.id}.json`.toLowerCase()), 'Missing exported operation receipt');
  assert.equal(await fileSha256(path.join(directory, 'firmware/GestureScreen.hex')), expected.artifact?.hexSha256);
  assert.equal(await fileSha256(path.join(directory, 'firmware/GestureScreen.axf')), expected.artifact?.axfSha256);
  const manifest = JSON.parse(await readFile(path.join(directory, 'build/source-manifest.json'), 'utf8'));
  assert.equal(manifest.sourceSha256, expected.artifact?.sourceSha256); assert.equal(manifest.projectSourceSha256, expected.artifact?.projectSourceAfter);
  assert.equal(manifest.buildId, expected.artifact?.buildId); assert.equal(manifest.profileSha256, expected.profileSha256); assert.deepEqual(manifest.files, expected.artifact?.files);
  return { path: filename, sha256: await fileSha256(filename), fileCount: exported.files.length, operationCount: exported.state.operations.length,
    files: exported.files as Array<{ path: string; sha256: string; bytes: number }> };
}
