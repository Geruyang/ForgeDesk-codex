import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { snapshotReleaseResources } from './snapshot-installed-release';
import { deriveSnapshotScope } from './snapshot-smoke-scope';
import { assertGrantClockCandidate, grantClockScope, grantClockSnapshotOutput, grantClockSnapshotRelease,
  grantClockSnapshotPins as pins, prepareGrantClockOutput, snapshotGrantClockFlag } from './snapshot-grant-clock-release';

const root = path.resolve('output/offline-grant-clock-snapshot-fixture');
const runId = 'snapshot-1792159000000';
const primary = () => deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_REAL_MODEL: '1', FORGEDESK_SNAPSHOT_INSTALLED_EXE: path.join(root, 'install/ForgeDesk.exe') }, runId);
function candidate() {
  const sources = ['apps/desktop/main/index.ts', 'apps/desktop/preload/index.ts', 'apps/desktop/renderer/App.tsx',
    'packages/engineering-runner/index.ts', 'packages/engineering-runner/snapshots.ts', 'packages/engineering-runner/types.ts',
    'packages/engine-adapter/index.ts', 'packages/engine-adapter/workspace-policy.ts', 'package.json', 'package-lock.json', 'tsconfig.json'];
  while (sources.length < 98) sources.push(`packages/offline-fixture/file-${sources.length}.ts`);
  const file = (relative: string, sha256 = 'a'.repeat(64)) => ({ path: relative, bytes: 1, sha256 });
  return { schemaVersion: 1, scope: 'unsigned-snapshot-release-candidate', version: '0.5.1',
    sourceIdentity: 'Exact file hashes, not a release commit', gitBaseCommit: 'a'.repeat(40), supersedesCandidateSha256: String(pins.supersedes),
    installer: file(`${grantClockSnapshotRelease}/ForgeDesk-0.5.1-x64-setup.exe`, pins.installer),
    resources: snapshotReleaseResources.map(relative => file(relative, relative === 'ForgeDesk.exe' ? pins.executable : relative === 'resources/app.asar' ? pins.asar : 'a'.repeat(64))),
    sourceFiles: sources.map(relative => file(relative)) };
}

test('grant-clock selection is explicit and closed while the original no-argument selection remains unchanged', () => {
  assert.equal(snapshotGrantClockFlag([]), false); assert.equal(snapshotGrantClockFlag(['--grant-clock-release']), true);
  for (const args of [['--release=anything'], ['--grant-clock-release', '--grant-clock-release'], ['--grant-clock-release', '--second-user'], ['--grant-clock-release', 'foreign.json']]) assert.throws(() => snapshotGrantClockFlag(args));
});

test('grant-clock output is separate and only the exact primary installed real-model scope is admitted', () => {
  const original = primary(), selected = grantClockScope(original);
  assert.equal(selected.output, path.join(root, grantClockSnapshotOutput, runId));
  assert.equal(original.output, path.join(root, 'output/playwright/snapshot/installed', runId));
  assert.equal(selected.dataDir, path.join(root, '.runtime/app')); assert.equal(selected.workspace, original.workspace);
  for (const patch of [{ secondUser: true }, { realModel: false }, { installed: undefined }, { installed: path.join(root, 'release/win-unpacked/ForgeDesk.exe') },
    { dataDir: path.join(root, '.runtime/copied-auth') }, { runtime: path.join(root, 'foreign') }, { workspace: path.join(root, '.runtime/app') }]) assert.throws(() => grantClockScope({ ...primary(), ...patch }));
});

test('grant-clock metadata binds the immutable new candidate, installer, EXE and ASAR, never the old release', () => {
  assertGrantClockCandidate(candidate(), pins.candidate);
  assert.throws(() => assertGrantClockCandidate(candidate(), pins.supersedes));
  for (const mutate of [(value: ReturnType<typeof candidate>) => { value.version = '0.5.0'; },
    (value: ReturnType<typeof candidate>) => { value.installer.path = 'release/ForgeDesk-0.5.1-x64-setup.exe'; },
    (value: ReturnType<typeof candidate>) => { value.installer.sha256 = 'b'.repeat(64); },
    (value: ReturnType<typeof candidate>) => { value.resources[0].sha256 = 'b'.repeat(64); },
    (value: ReturnType<typeof candidate>) => { value.resources.find(item => item.path === 'resources/app.asar')!.sha256 = 'b'.repeat(64); },
    (value: ReturnType<typeof candidate>) => { value.supersedesCandidateSha256 = 'b'.repeat(64); },
    (value: ReturnType<typeof candidate>) => { value.resources.pop(); }]) {
    const value = candidate(); mutate(value); assert.throws(() => assertGrantClockCandidate(value, pins.candidate));
  }
});

test('grant-clock source capture rejects missing core sources, traversal, duplicate paths and invalid sizes', () => {
  for (const mutate of [(value: ReturnType<typeof candidate>) => { value.sourceFiles.pop(); },
    (value: ReturnType<typeof candidate>) => { value.sourceFiles[0].path = 'packages/another.ts'; },
    (value: ReturnType<typeof candidate>) => { value.sourceFiles[0].path = 'apps/../../.runtime/auth.json'; },
    (value: ReturnType<typeof candidate>) => { value.sourceFiles[0].path = value.sourceFiles[1].path; },
    (value: ReturnType<typeof candidate>) => { value.sourceFiles[0].bytes = -1; }]) {
    const value = candidate(); mutate(value); assert.throws(() => assertGrantClockCandidate(value, pins.candidate));
  }
});

async function outputFixture() {
  const base = path.join(process.cwd(), '.runner-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'grant-clock-output-'));
  return grantClockScope(deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_REAL_MODEL: '1', FORGEDESK_SNAPSHOT_INSTALLED_EXE: path.join(root, 'install/ForgeDesk.exe') }, runId));
}

test('grant-clock output creates one fresh empty directory and never reuses existing evidence', async () => {
  const scope = await outputFixture(); assert.equal(await prepareGrantClockOutput(scope), scope.output);
  assert.deepEqual(await readdir(scope.output), []);
  await assert.rejects(prepareGrantClockOutput(scope), { code: 'EEXIST' });
  const marker = path.join(scope.output, 'prior-evidence.json'); await writeFile(marker, 'retain-original', { flag: 'wx' });
  await assert.rejects(prepareGrantClockOutput(scope), { code: 'EEXIST' });
  assert.equal(await readFile(marker, 'utf8'), 'retain-original');
  await assert.rejects(prepareGrantClockOutput({ ...scope, output: path.join(scope.root, 'redirected') }), /cannot be overridden/);
});

test('grant-clock output rejects a junction in its new parent chain without touching the target', async () => {
  const scope = await outputFixture(), target = path.join(scope.root, 'retained-target'), parent = path.dirname(scope.output);
  await mkdir(path.dirname(parent), { recursive: true }); await mkdir(target);
  const marker = path.join(target, 'prior-evidence.json'); await writeFile(marker, 'retain-original', { flag: 'wx' });
  await symlink(target, parent, 'junction');
  await assert.rejects(prepareGrantClockOutput(scope), /Linked|reparse|Resolved/);
  assert.deepEqual(await readdir(target), ['prior-evidence.json']); assert.equal(await readFile(marker, 'utf8'), 'retain-original');
});

test('grant-clock output rejects a junction at the run directory without touching the target', async () => {
  const scope = await outputFixture(), target = path.join(scope.root, 'retained-target');
  await mkdir(path.dirname(scope.output), { recursive: true }); await mkdir(target);
  const marker = path.join(target, 'prior-evidence.json'); await writeFile(marker, 'retain-original', { flag: 'wx' });
  await symlink(target, scope.output, 'junction');
  await assert.rejects(prepareGrantClockOutput(scope), /EEXIST|Linked|reparse|Resolved/);
  assert.deepEqual(await readdir(target), ['prior-evidence.json']); assert.equal(await readFile(marker, 'utf8'), 'retain-original');
});
