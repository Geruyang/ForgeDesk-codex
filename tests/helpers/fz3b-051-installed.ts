import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { extractFile } from '@electron/asar';
import { FZ3B_PROFILE, fz3bDigest, fz3bProfileSha256, validateFz3bFixture } from '../../packages/engineering-runner/fz3b/profile';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import { fileSha256, inside, plainPath, samePath } from './embedded-installed';
import { FZ3B_INSTALLED_SCOPE, readPinnedFz3bResources, type Fz3bInstalledPlan, type Fz3bInstalledRequest } from './fz3b-installed';
import { assertFz3bNativeReceipt, type Fz3bNativeReceipt } from './fz3b-native-observer';
import { snapshotReleaseResources } from './snapshot-installed-release';

export const FZ3B051_OUTPUT = 'output/qa/2026-10-16-fz3b-051';
export const FZ3B051_VERSION = '0.5.1';
export const FZ3B051_RELEASE_BASE = `${FZ3B051_OUTPUT}/release-grant-clock`;
export const FZ3B051_CANDIDATE = `${FZ3B051_OUTPUT}/release-candidate-grant-clock.json`;
export const FZ3B051_RESOURCE_MANIFEST = 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07';
export const FZ3B051_BUNDLES = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.js',
  'dist/renderer/index.css', 'dist/renderer/index.html', 'dist/mcp/index.cjs'] as const;
const SHA = /^[a-f0-9]{64}$/;
const CAPTURE_PATHS = ['apps/desktop/main/index.ts', 'apps/desktop/main/fz3b-agent.ts', 'apps/desktop/main/fz3b-approval.ts',
  'apps/desktop/main/native-dialogs.ts', 'apps/desktop/preload/index.ts', 'apps/desktop/renderer/FZ3BPanel.tsx',
  'packages/engineering-runner/fz3b/backend.ts', 'packages/engineering-runner/fz3b/worker.ts',
  'packages/engineering-runner/fz3b/profile.ts', 'packages/engine-adapter/index.ts', 'package.json'];

export type Fz3b051Request = Fz3bInstalledRequest & { version: '0.5.1' };
export interface Fz3b051ReleaseBinding {
  candidatePath: string; candidateSha256: string; gitBaseCommit: string;
  supersedesCandidateSha256: string;
  sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit';
  runtimeSourceFiles: Array<{ path: string; bytes: number; sha256: string }>;
  bundles: Record<string, string>;
}
export interface Fz3b051Plan extends Fz3bInstalledPlan { version: '0.5.1'; releaseBinding: Fz3b051ReleaseBinding }
export type Fz3b051GrantObservation = { observedAt: string; id: string; planSha256: string; createdAt: string; expiresAt: string };

export function assertFz3b051Request(root: string, value: unknown): asserts value is Fz3b051Request {
  const request = value as Fz3b051Request;
  assert.equal(request?.schemaVersion, 1); assert.equal(request.scope, FZ3B_INSTALLED_SCOPE); assert.equal(request.version, FZ3B051_VERSION);
  assert.deepEqual(Object.keys(request).sort(), ['schemaVersion', 'scope', 'runId', 'version', 'runtimeCommit', 'projectRoot', 'nativeOperator'].sort());
  assert.match(request.runId, /^fz3b-installed-\d{13}-[a-f0-9]{6}$/); assert.match(request.runtimeCommit, /^[a-f0-9]{40}$/);
  assert.equal(request.nativeOperator, 'coordinator-delegated-visible-ui');
  assert.ok(path.isAbsolute(root) && path.isAbsolute(request.projectRoot) && inside(path.join(root, 'output/hardware'), request.projectRoot));
}

export function fz3b051PlanScope(root: string, value: unknown, env: NodeJS.ProcessEnv) {
  const plan = value as Fz3b051Plan;
  const { model: _model, installedExe: _installed, installerPath: _installer, dataDir: _data, executableSha256: _exeHash,
    installerSha256: _installerHash, resourceHashes: _resources, fixture: _fixture, profileSha256: _profile, preparedAt: _prepared,
    releaseBinding: _binding, ...request } = plan;
  assertFz3b051Request(root, request);
  assert.equal(plan.model, 'gpt-6.1-sol'); assert.ok(samePath(plan.installedExe, path.join(root, 'install/ForgeDesk.exe')));
  assert.ok(samePath(plan.dataDir, path.join(root, '.runtime/app')), 'Only the existing official product home; never copied authentication');
  assert.ok(samePath(plan.installerPath, path.join(root, FZ3B051_RELEASE_BASE, 'ForgeDesk-0.5.1-x64-setup.exe')));
  const output = path.join(root, FZ3B051_OUTPUT, plan.runId);
  for (const [left, right] of [[plan.projectRoot, plan.dataDir], [plan.projectRoot, path.dirname(plan.installedExe)], [plan.projectRoot, output], [output, plan.dataDir]]) {
    assert.equal(inside(left, right) || inside(right, left), false);
  }
  for (const [key, entry] of Object.entries(env)) if (entry && (/^(?:FORGEDESK_DATA_DIR|CODEX_HOME|ELECTRON_RUN_AS_NODE)$/i.test(key) || /^FORGEDESK_(?:FZ3B|T2|HARDWARE_AGENT|SNAPSHOT)_/i.test(key))) {
    assert.fail(`Remove ambient acceptance override: ${key}`);
  }
  for (const sha of [plan.executableSha256, plan.installerSha256, plan.profileSha256]) assert.match(sha, SHA);
  for (const resource of snapshotReleaseResources.filter(item => item.startsWith('resources/'))) assert.match(plan.resourceHashes?.[resource], SHA);
  assert.equal(plan.resourceHashes['resources/fz3b/manifest.json'], FZ3B051_RESOURCE_MANIFEST);
  assert.equal(Object.keys(plan.resourceHashes).filter(item => item.startsWith('resources/fz3b/')).length, 47);
  for (const [relative, sha] of Object.entries(plan.resourceHashes)) {
    assert.match(relative, /^resources\/[A-Za-z0-9._/-]+$/); assert.ok(relative.split('/').every(part => part && part !== '.' && part !== '..')); assert.match(sha, SHA);
  }
  validateFz3bFixture(plan.fixture); assert.equal(plan.profileSha256, fz3bProfileSha256(plan.fixture));
  const binding = plan.releaseBinding; assert.ok(binding);
  assert.ok(samePath(binding.candidatePath, path.join(root, FZ3B051_CANDIDATE)));
  assert.match(binding.candidateSha256, SHA); assert.match(binding.supersedesCandidateSha256, SHA); assert.equal(binding.gitBaseCommit, plan.runtimeCommit);
  assert.equal(binding.sourceIdentity, 'captured-file-hashes-not-exact-runtime-commit');
  assert.deepEqual(Object.keys(binding.bundles).sort(), [...FZ3B051_BUNDLES].sort());
  for (const sha of Object.values(binding.bundles)) assert.match(sha, SHA);
  assert.ok(Array.isArray(binding.runtimeSourceFiles));
  for (const required of CAPTURE_PATHS) assert.equal(binding.runtimeSourceFiles.filter(item => item.path === required).length, 1);
  for (const item of binding.runtimeSourceFiles) {
    assert.match(item.path, /^(?:apps\/|packages\/|engineering\/|package\.json$)/);
    assert.match(item.path, /^[A-Za-z0-9._/-]+$/);
    assert.ok(item.path.split('/').every(part => part && part !== '.' && part !== '..')); assert.match(item.sha256, SHA);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
  }
  assert.ok(Number.isFinite(Date.parse(plan.preparedAt)));
  return { root, plan, output };
}

async function captureRelease(root: string) {
  const manifest = path.join(root, FZ3B051_CANDIDATE); await plainPath(manifest);
  const manifestInfo = await lstat(manifest); assert.ok(manifestInfo.isFile() && manifestInfo.nlink === 1 && manifestInfo.size <= 1048576);
  const candidate = JSON.parse(await readFile(manifest, 'utf8'));
  assert.equal(candidate.schemaVersion, 1); assert.equal(candidate.scope, 'unsigned-snapshot-release-candidate'); assert.equal(candidate.version, FZ3B051_VERSION);
  assert.deepEqual(candidate.resources.map((item: { path: string }) => item.path).sort(), [...snapshotReleaseResources].sort());
  const installerPath = `${FZ3B051_RELEASE_BASE}/ForgeDesk-0.5.1-x64-setup.exe`; assert.equal(candidate.installer.path, installerPath);
  const originalManifest = path.join(root, 'output/qa/2026-10-16-snapshot-installed/release-candidate.json'); await plainPath(originalManifest);
  assert.equal(candidate.supersedesCandidateSha256, await fileSha256(originalManifest));
  const checked: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const item of [candidate.installer, ...candidate.resources.map((value: { path: string; bytes: number; sha256: string }) => ({ ...value, path: `install/${value.path}` }))]) {
    assert.match(item.sha256, SHA); assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0);
    const file = path.join(root, item.path); await plainPath(file); const stat = await lstat(file);
    assert.ok(stat.isFile() && stat.nlink === 1); assert.equal(stat.size, item.bytes); assert.equal(await fileSha256(file), item.sha256, `Installed candidate mismatch: ${item.path}`);
    checked.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 });
  }
  const release = { version: candidate.version as '0.5.1', manifest, manifestSha256: await fileSha256(manifest), checked };
  assert.match(candidate.gitBaseCommit, /^[a-f0-9]{40}$/); assert.equal(candidate.sourceIdentity, 'Exact file hashes, not a release commit');
  assert.ok(Array.isArray(candidate.sourceFiles));
  const runtimeSourceFiles = candidate.sourceFiles.filter((item: { path: string }) => /^(?:apps\/|packages\/|engineering\/|package\.json$)/.test(item.path)) as Fz3b051ReleaseBinding['runtimeSourceFiles'];
  for (const required of CAPTURE_PATHS) assert.equal(runtimeSourceFiles.filter(item => item.path === required).length, 1, `Missing original source capture: ${required}`);
  for (const item of runtimeSourceFiles) {
    assert.match(item.path, /^[A-Za-z0-9._/-]+$/);
    assert.ok(item.path.split('/').every(part => part && part !== '.' && part !== '..')); assert.match(item.sha256, SHA);
    const file = path.join(root, item.path); await plainPath(file); const stat = await lstat(file);
    assert.ok(stat.isFile() && stat.nlink === 1); assert.equal(stat.size, item.bytes); assert.equal(await fileSha256(file), item.sha256, `Captured runtime source changed: ${item.path}`);
  }
  const asar = path.join(root, 'install/resources/app.asar'); const unpacked = path.join(root, FZ3B051_RELEASE_BASE, 'win-unpacked');
  const resourceHashes: Record<string, string> = {};
  for (const item of release.checked.filter(item => item.path.startsWith('install/'))) {
    const relative = item.path.slice('install/'.length); const alternate = path.join(unpacked, relative); await plainPath(alternate);
    assert.equal(await fileSha256(alternate), item.sha256, `Installed resource differs from release/win-unpacked: ${relative}`);
    if (relative.startsWith('resources/')) resourceHashes[relative] = item.sha256;
  }
  const packageInfo = JSON.parse(extractFile(asar, 'package.json').toString('utf8')); assert.equal(packageInfo.version, FZ3B051_VERSION);
  const bundles: Record<string, string> = {};
  for (const relative of FZ3B051_BUNDLES) {
    const bytes = extractFile(asar, path.normalize(relative)); const current = path.join(root, relative); await plainPath(current);
    assert.equal(fz3bDigest(bytes), await fileSha256(current), `Current bundle differs from the pinned installed ASAR: ${relative}`); bundles[relative] = fz3bDigest(bytes);
  }
  assert.ok(extractFile(asar, path.normalize('dist/main/index.cjs')).toString('utf8').includes(FZ3B051_RESOURCE_MANIFEST), 'Pinned main bundle lacks its fixed FZ3B resource pin');
  const fzRoot = path.join(root, 'install/resources/fz3b');
  async function pin(directory: string): Promise<void> {
    await plainPath(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); await plainPath(file);
      if (entry.isDirectory()) await pin(file);
      else { const stat = await lstat(file); assert.ok(entry.isFile() && stat.nlink === 1); const relative = path.relative(path.join(root, 'install'), file).split(path.sep).join('/');
        const sha = await fileSha256(file); const alternate = path.join(unpacked, relative); await plainPath(alternate);
        assert.equal(sha, await fileSha256(alternate)); resourceHashes[relative] = sha; }
    }
  }
  await pin(fzRoot); assert.equal(resourceHashes['resources/fz3b/manifest.json'], FZ3B051_RESOURCE_MANIFEST);
  return { release, resourceHashes, fixture: JSON.parse(await readFile(path.join(fzRoot, 'fixture/host-fixture.json'), 'utf8')),
    binding: { candidatePath: release.manifest, candidateSha256: release.manifestSha256, gitBaseCommit: candidate.gitBaseCommit,
      supersedesCandidateSha256: candidate.supersedesCandidateSha256, sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit' as const, runtimeSourceFiles, bundles } };
}

export async function prepareFz3b051Plan(root: string, value: unknown): Promise<Fz3b051Plan> {
  assertFz3b051Request(root, value); const captured = await captureRelease(root);
  assert.equal(value.runtimeCommit, captured.binding.gitBaseCommit);
  const plan: Fz3b051Plan = { ...value, model: 'gpt-6.1-sol', installedExe: path.join(root, 'install/ForgeDesk.exe'),
    installerPath: path.join(root, FZ3B051_RELEASE_BASE, 'ForgeDesk-0.5.1-x64-setup.exe'), dataDir: path.join(root, '.runtime/app'),
    executableSha256: captured.release.checked.find(item => item.path === 'install/ForgeDesk.exe')!.sha256,
    installerSha256: captured.release.checked.find(item => item.path === `${FZ3B051_RELEASE_BASE}/ForgeDesk-0.5.1-x64-setup.exe`)!.sha256,
    resourceHashes: captured.resourceHashes, fixture: captured.fixture, profileSha256: fz3bProfileSha256(captured.fixture),
    preparedAt: new Date().toISOString(), releaseBinding: captured.binding };
  fz3b051PlanScope(root, plan, {}); await plainPath(plan.projectRoot); assert.equal((await readPinnedFz3bResources(plan)).size, 46); return plan;
}

export async function verifyFz3b051PlanBytes(root: string, plan: Fz3b051Plan) {
  const captured = await captureRelease(root);
  assert.deepEqual(captured.binding, plan.releaseBinding); assert.deepEqual(captured.resourceHashes, plan.resourceHashes);
  assert.deepEqual(captured.fixture, plan.fixture);
  assert.equal(await fileSha256(plan.installedExe), plan.executableSha256); assert.equal(await fileSha256(plan.installerPath), plan.installerSha256);
  return captured.release;
}

export function fz3b051LaunchEnvironment(source: NodeJS.ProcessEnv, dataDir: string): Record<string, string> {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)', 'USERNAME', 'USERDOMAIN', 'SESSIONNAME',
    'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP']);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string' && allowed.has(key.toUpperCase())) env[key] = value;
  return { ...env, FORGEDESK_DATA_DIR: dataDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
}

export function assertFz3b051NativeGrant(run: Fz3bRunView, receipt: Fz3bNativeReceipt, timeline: Fz3b051GrantObservation[]) {
  assert.equal(receipt.mechanism, 'Original native showMessageBox pass-through observer; no generated answer');
  assertFz3bNativeReceipt(receipt, [run.taskId, run.runId, run.identity!.hostKeySha256, run.identity!.bootId,
    run.artifact!.id, run.grant!.planSha256, run.grant!.fixture.queriesSha256, run.grant!.fixture.imageSha256]);
  const grant = run.grant!; const created = Date.parse(grant.createdAt), expiry = Date.parse(grant.expiresAt), approved = Date.parse(grant.approvedAt!);
  assert.equal(expiry - created, 300000, 'The backend grant has a fixed five-minute lifetime from creation, never display');
  const approval = receipt.calls.find(call => call.kind === 'approval')!;
  assert.ok(approval.options.detail?.includes(`授权到期：${grant.expiresAt}`), 'Native details must show the original exact expiry');
  const displayed = Date.parse(approval.startedAt), answered = Date.parse(approval.finishedAt!);
  assert.ok(created <= displayed && displayed <= answered && answered <= approved && approved < expiry);
  const semantic = run.operations.find(item => item.kind === 'semantic')!; assert.ok(semantic);
  assert.ok(approved <= Date.parse(semantic.createdAt) && Date.parse(semantic.createdAt) < expiry);
  assert.ok(timeline.length > 0, 'Retain the live grant preview observations');
  for (const observed of timeline) {
    assert.equal(observed.id, grant.id); assert.equal(observed.planSha256, grant.planSha256);
    assert.equal(observed.createdAt, grant.createdAt); assert.equal(observed.expiresAt, grant.expiresAt);
    assert.ok(Date.parse(observed.observedAt) >= created);
  }
  const warning = receipt.calls.find(call => call.kind === 'close-warning')!;
  const warningOpened = Date.parse(warning.startedAt), warningClosed = Date.parse(warning.finishedAt!);
  const warningOverlapMs = Math.max(0, warningClosed - Math.max(created, warningOpened));
  return { ttlMs: expiry - created, originalExpiryShown: true, creationToDisplayMs: displayed - created,
    warningDurationMs: warningClosed - warningOpened, queuedBehindObservedWarning: warningOverlapMs > 0, warningOverlapMs,
    remainingAtDisplayMs: expiry - displayed, approvedBeforeOriginalExpiry: true, consumedBeforeOriginalExpiry: true, timelineObservations: timeline.length };
}
