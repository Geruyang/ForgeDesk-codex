import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { extractFile } from '@electron/asar';
import { fileSha256, plainPath, samePath } from './embedded-installed';
import { snapshotReleaseResources } from './snapshot-installed-release';
import type { SnapshotSmokeScope } from './snapshot-smoke-scope';

export const grantClockSnapshotCandidate = 'output/qa/2026-10-16-fz3b-051/release-candidate-grant-clock.json';
export const grantClockSnapshotRelease = 'output/qa/2026-10-16-fz3b-051/release-grant-clock';
export const grantClockSnapshotOutput = 'output/qa/2026-10-16-fz3b-051/software-snapshot';
export const grantClockSnapshotPins = {
  candidate: 'd821ab2ab817e7baa8e38f919a1e0e2270109ff421acb79bba51ab63eddef46a',
  supersedes: 'ddad11a47d65290c1ef104991483e6a4a3a93af011b2d838a2bc4efd75a72792',
  installer: '6e7fc1f5a3f6fde4f41b5275d24a38f068a547064d3fc139f1436f296c486b2c',
  executable: '8e10b3b96af315f30f2efa4883826f457b0df88a1eb148eafafd04e35e8d37a9',
  asar: 'de20124591def50b0f7060a4306d4c6eb4515c331a747c753f2cc1bd26cdd176',
} as const;
const bundles = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.js', 'dist/renderer/index.css', 'dist/renderer/index.html', 'dist/mcp/index.cjs'];
const sourcePattern = /^(?:apps\/|packages\/|engineering\/|package(?:-lock)?\.json$|tsconfig\.json$)/;
const requiredSources = ['apps/desktop/main/index.ts', 'apps/desktop/preload/index.ts', 'apps/desktop/renderer/App.tsx',
  'packages/engineering-runner/index.ts', 'packages/engineering-runner/snapshots.ts', 'packages/engineering-runner/types.ts',
  'packages/engine-adapter/index.ts', 'packages/engine-adapter/workspace-policy.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
type CapturedFile = { path: string; bytes: number; sha256: string };
interface Candidate { schemaVersion: number; scope: string; version: string; sourceIdentity: string; supersedesCandidateSha256: string;
  gitBaseCommit: string; sourceFiles: CapturedFile[]; installer: CapturedFile; resources: CapturedFile[] }

export function snapshotGrantClockFlag(args: string[]): boolean {
  if (!args.length) return false;
  assert.deepEqual(args, ['--grant-clock-release'], 'Only the exact grant-clock release flag is accepted'); return true;
}

export function grantClockScope(scope: SnapshotSmokeScope): SnapshotSmokeScope {
  assert.equal(scope.secondUser, false, 'Second-SID acceptance remains paused and cannot select this release');
  assert.equal(scope.realModel, true, 'Grant-clock software acceptance requires a genuine model run');
  assert.ok(scope.installed && samePath(scope.installed, path.join(scope.root, 'install/ForgeDesk.exe')));
  assert.ok(samePath(scope.dataDir, path.join(scope.root, '.runtime/app')));
  assert.match(scope.runId, /^snapshot-\d+$/);
  assert.ok(samePath(scope.runtime, path.join(scope.root, '.runtime/qa-snapshot', scope.runId)));
  assert.ok(samePath(scope.workspace, path.join(scope.runtime, 'workspace')));
  return { ...scope, output: path.join(scope.root, grantClockSnapshotOutput, scope.runId) };
}

export async function prepareGrantClockOutput(scope: SnapshotSmokeScope): Promise<string> {
  assert.ok(samePath(scope.output, grantClockScope(scope).output), 'Grant-clock output cannot be overridden');
  const parent = path.dirname(scope.output);
  await plainPath(parent); await mkdir(parent, { recursive: true }); await plainPath(parent);
  await mkdir(scope.output, { recursive: false }); await plainPath(scope.output);
  assert.equal((await lstat(scope.output)).isDirectory(), true); assert.deepEqual(await readdir(scope.output), []);
  return scope.output;
}

export function assertGrantClockCandidate(value: unknown, actualSha256: string): asserts value is Candidate {
  assert.equal(actualSha256, grantClockSnapshotPins.candidate); const candidate = value as Candidate;
  assert.equal(candidate?.schemaVersion, 1); assert.equal(candidate.scope, 'unsigned-snapshot-release-candidate'); assert.equal(candidate.version, '0.5.1');
  assert.equal(candidate.sourceIdentity, 'Exact file hashes, not a release commit');
  assert.equal(candidate.supersedesCandidateSha256, grantClockSnapshotPins.supersedes); assert.match(candidate.gitBaseCommit, /^[a-f0-9]{40}$/);
  assert.equal(candidate.installer?.path, `${grantClockSnapshotRelease}/ForgeDesk-0.5.1-x64-setup.exe`);
  assert.equal(candidate.installer.sha256, grantClockSnapshotPins.installer);
  assert.deepEqual(candidate.resources.map(item => item.path).sort(), [...snapshotReleaseResources].sort());
  assert.equal(candidate.resources.find(item => item.path === 'ForgeDesk.exe')?.sha256, grantClockSnapshotPins.executable);
  assert.equal(candidate.resources.find(item => item.path === 'resources/app.asar')?.sha256, grantClockSnapshotPins.asar);
  assert.ok(Array.isArray(candidate.sourceFiles));
  for (const list of [candidate.resources, candidate.sourceFiles]) {
    assert.equal(new Set(list.map(item => item.path)).size, list.length);
    for (const item of list) {
      assert.match(item.path, /^[A-Za-z0-9._/-]+$/); assert.ok(item.path.split('/').every(part => part && part !== '.' && part !== '..'));
      assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0); assert.match(item.sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.ok(Number.isSafeInteger(candidate.installer.bytes) && candidate.installer.bytes > 0);
  const runtimeSources = candidate.sourceFiles.filter(item => sourcePattern.test(item.path));
  assert.equal(runtimeSources.length, 98, 'This immutable candidate captures 96 runtime sources and two build-configuration files');
  for (const relative of requiredSources) assert.equal(runtimeSources.filter(item => item.path === relative).length, 1);
}

export async function verifyGrantClockSnapshotRelease(root: string, executable: string) {
  assert.ok(samePath(executable, path.join(root, 'install/ForgeDesk.exe')));
  const filename = path.join(root, grantClockSnapshotCandidate); await plainPath(filename); const manifestInfo = await lstat(filename);
  assert.ok(manifestInfo.isFile() && manifestInfo.nlink === 1 && manifestInfo.size <= 1048576);
  const candidate: unknown = JSON.parse(await readFile(filename, 'utf8'));
  assertGrantClockCandidate(candidate, await fileSha256(filename));
  const checked: CapturedFile[] = [];
  const check = async (relative: string, expected: CapturedFile) => {
    const file = path.join(root, relative); await plainPath(file); const info = await lstat(file);
    assert.ok(info.isFile() && info.nlink === 1); assert.equal(info.size, expected.bytes); assert.equal(await fileSha256(file), expected.sha256, `Grant-clock identity mismatch: ${relative}`);
    checked.push({ path: relative, bytes: info.size, sha256: expected.sha256 });
  };
  await check(candidate.installer.path, candidate.installer);
  for (const item of candidate.resources) {
    await check(`install/${item.path}`, item); await check(`${grantClockSnapshotRelease}/win-unpacked/${item.path}`, item);
  }
  const runtimeSources = candidate.sourceFiles.filter(item => sourcePattern.test(item.path));
  for (const item of runtimeSources) await check(item.path, item);
  const asar = path.join(root, 'install/resources/app.asar');
  assert.equal(JSON.parse(extractFile(asar, path.normalize('package.json')).toString('utf8')).version, '0.5.1');
  const installedBundles: Array<{ path: string; sha256: string }> = [];
  for (const relative of bundles) {
    const file = path.join(root, relative); await plainPath(file); const info = await lstat(file); assert.ok(info.isFile() && info.nlink === 1);
    const installed = extractFile(asar, path.normalize(relative)); assert.equal(installed.length, info.size);
    assert.deepEqual(installed, await readFile(file), `Packaged bundle mismatch: ${relative}`); installedBundles.push({ path: relative, sha256: await fileSha256(file) });
  }
  return { version: '0.5.1', manifest: filename, manifestSha256: grantClockSnapshotPins.candidate, installer: candidate.installer,
    gitBaseCommit: candidate.gitBaseCommit, sourceIdentity: 'Captured file hashes, not an exact release commit', checked, installedBundles,
    runtimeSourceCount: runtimeSources.length, supersedesCandidateSha256: candidate.supersedesCandidateSha256,
    scope: 'New grant-clock installed bytes; original snapshot candidate and prior output remain unchanged' };
}
