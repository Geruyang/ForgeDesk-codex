import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FZ3B_PROFILE, fz3bProfileSha256 } from '../../packages/engineering-runner/fz3b/profile';
import type { Fz3bRunView, Fz3bSemanticFixture } from '../../packages/engineering-runner/fz3b/types';
import type { Fz3bNativeReceipt } from './fz3b-native-observer';
import { fz3bSshEnvironment } from '../../packages/engineering-runner/fz3b/ssh-environment';
import { FZ3B_INSTALLED_SCOPE } from './fz3b-installed';
import { snapshotReleaseResources } from './snapshot-installed-release';
import { FZ3B051_BUNDLES, FZ3B051_RESOURCE_MANIFEST, FZ3B051_OUTPUT, FZ3B051_RELEASE_BASE, FZ3B051_CANDIDATE, assertFz3b051Request, fz3b051PlanScope,
  assertFz3b051NativeGrant, fz3b051LaunchEnvironment, type Fz3b051Plan, type Fz3b051GrantObservation } from './fz3b-051-installed';

const sha = 'a'.repeat(64); const root = path.resolve('output/offline-fz3b-051-fixture');
const request = () => ({ schemaVersion: 1 as const, scope: FZ3B_INSTALLED_SCOPE, version: '0.5.1' as const,
  runId: 'fz3b-installed-1792132000000-abcdef', runtimeCommit: 'a'.repeat(40),
  projectRoot: path.join(root, 'output/hardware/reviewed-project'), nativeOperator: 'coordinator-delegated-visible-ui' as const });
const fixture = (): Fz3bSemanticFixture => ({ id: 'fz3b-pillow-scene-v1' as const, manifestSha256: FZ3B_PROFILE.semanticManifestSha256,
  queriesSha256: FZ3B_PROFILE.queriesSha256, imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256,
  width: 914, height: 512, queryCount: 4, embeddingDimensions: 512, expectedLabel: 'pillow' as const,
  queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: structuredClone(FZ3B_PROFILE.encoderIdentity) });
function plan(): Fz3b051Plan {
  const resourceHashes = Object.fromEntries(snapshotReleaseResources.filter(item => item.startsWith('resources/')).map(item => [item, sha]));
  resourceHashes['resources/fz3b/manifest.json'] = FZ3B051_RESOURCE_MANIFEST;
  for (let index = 0; index < 46; index++) resourceHashes[`resources/fz3b/fixture-only-${index}`] = sha;
  const paths = ['apps/desktop/main/index.ts', 'apps/desktop/main/fz3b-agent.ts', 'apps/desktop/main/fz3b-approval.ts',
    'apps/desktop/main/native-dialogs.ts', 'apps/desktop/preload/index.ts', 'apps/desktop/renderer/FZ3BPanel.tsx',
    'packages/engineering-runner/fz3b/backend.ts', 'packages/engineering-runner/fz3b/worker.ts', 'packages/engineering-runner/fz3b/profile.ts',
    'packages/engine-adapter/index.ts', 'package.json'];
  return { ...request(), model: 'gpt-6.1-sol', installedExe: path.join(root, 'install/ForgeDesk.exe'),
    installerPath: path.join(root, FZ3B051_RELEASE_BASE, 'ForgeDesk-0.5.1-x64-setup.exe'), dataDir: path.join(root, '.runtime/app'),
    executableSha256: sha, installerSha256: sha, resourceHashes, fixture: fixture(), profileSha256: fz3bProfileSha256(fixture()),
    preparedAt: '2026-10-16T10:00:00Z', releaseBinding: { candidatePath: path.join(root, FZ3B051_CANDIDATE),
      candidateSha256: sha, supersedesCandidateSha256: sha, gitBaseCommit: request().runtimeCommit, sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit',
      runtimeSourceFiles: paths.map(item => ({ path: item, bytes: 1, sha256: sha })), bundles: Object.fromEntries(FZ3B051_BUNDLES.map(item => [item, sha])) } };
}
function nativeFixture() {
  const run = { taskId: 'fixture-task', runId: 'fixture-run', identity: { hostKeySha256: sha, bootId: 'fixture-boot' }, artifact: { id: 'fixture-artifact' },
    grant: { id: 'fixture-grant', planSha256: sha, createdAt: '2026-10-16T10:00:00.000Z', expiresAt: '2026-10-16T10:05:00.000Z',
      approvedAt: '2026-10-16T10:00:05.000Z', fixture: { queriesSha256: 'query-pin', imageSha256: 'image-pin' } },
    operations: [{ kind: 'semantic', createdAt: '2026-10-16T10:00:06.000Z' }] } as unknown as Fz3bRunView;
  const receipt: Fz3bNativeReceipt = { runId: request().runId, mechanism: 'Original native showMessageBox pass-through observer; no generated answer', calls: [
    { kind: 'close-warning', phase: 'fulfilled', startedAt: '2026-10-16T09:59:59.000Z', finishedAt: '2026-10-16T10:00:02.000Z', response: 0,
      options: { type: 'warning', message: '工程验证正在运行，请等待完成后退出。' } },
    { kind: 'approval', phase: 'fulfilled', startedAt: '2026-10-16T10:00:03.000Z', finishedAt: '2026-10-16T10:00:04.000Z', response: 1, checkboxChecked: true,
      options: { type: 'warning', title: 'ForgeDesk Zynq 单图语义授权', message: 'fixture-only', checkboxLabel: 'fixture-checkbox', checkboxChecked: false,
        buttons: ['取消', '授权本次固定测试'], detail: `fixture-task fixture-run ${sha} fixture-boot fixture-artifact query-pin image-pin\n授权到期：${run.grant!.expiresAt}` } },
  ] };
  const timeline: Fz3b051GrantObservation[] = [{ observedAt: '2026-10-16T10:00:01.000Z', id: run.grant!.id, planSha256: sha,
    createdAt: run.grant!.createdAt, expiresAt: run.grant!.expiresAt }];
  return { run, receipt, timeline };
}

test('051 request is closed and does not weaken the original 050 request/version contract', () => {
  assertFz3b051Request(root, request());
  for (const patch of [{ version: '0.5.0' }, { version: '0.5.2' }, { nativeOperator: 'generated-response' }, { nativeApprove: true },
    { scope: 'model-deploy' }, { projectRoot: path.join(root, '.runtime/app') }]) assert.throws(() => assertFz3b051Request(root, { ...request(), ...patch }));
});

test('051 scope requires exact primary product paths, candidate, bundles and fixed FZ3B pins', () => {
  const good = plan(); assert.equal(fz3b051PlanScope(root, good, {}).output, path.join(root, FZ3B051_OUTPUT, good.runId));
  for (const mutate of [(p: Fz3b051Plan) => { p.dataDir = path.join(root, '.runtime/copied-auth'); },
    (p: Fz3b051Plan) => { p.installedExe = path.join(root, 'release/win-unpacked/ForgeDesk.exe'); },
    (p: Fz3b051Plan) => { p.installerPath = path.join(root, 'release/ForgeDesk-0.5.1-x64-setup.exe'); },
    (p: Fz3b051Plan) => { p.releaseBinding.candidatePath = path.join(root, 'other-candidate.json'); },
    (p: Fz3b051Plan) => { p.releaseBinding.gitBaseCommit = 'b'.repeat(40); },
    (p: Fz3b051Plan) => { delete p.releaseBinding.bundles['dist/main/index.cjs']; },
    (p: Fz3b051Plan) => { p.resourceHashes['resources/fz3b/manifest.json'] = 'b'.repeat(64); },
    (p: Fz3b051Plan) => { p.resourceHashes['resources/../auth.json'] = sha; },
    (p: Fz3b051Plan) => { p.releaseBinding.runtimeSourceFiles.push({ path: 'apps/..\\..\\.runtime/auth.json', bytes: 1, sha256: sha }); },
    (p: Fz3b051Plan) => { p.releaseBinding.runtimeSourceFiles = []; }]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => fz3b051PlanScope(root, bad, {}));
  }
  for (const env of [{ CODEX_HOME: 'private' }, { FORGEDESK_DATA_DIR: 'other' }, { FORGEDESK_FZ3B_NATIVE_RESPONSE: 'yes' }]) assert.throws(() => fz3b051PlanScope(root, good, env));
});

test('051 launch environment excludes authentication keys, Node hooks, Git routing and acceptance overrides', () => {
  assert.deepEqual(fz3b051LaunchEnvironment({ PATH: 'path', USERPROFILE: 'actual-profile', OPENAI_API_KEY: 'private', ANTHROPIC_API_KEY: 'private',
    NODE_OPTIONS: '--require=foreign', NODE_PATH: 'foreign', GIT_DIR: 'foreign', ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: 'foreign',
    SSH_AUTH_SOCK: 'foreign-agent', HOME: 'foreign-home', HTTPS_PROXY: 'foreign-proxy', FORGEDESK_FZ3B_NATIVE_RESPONSE: 'approve' }, 'actual-product-home'),
  { PATH: 'path', USERPROFILE: 'actual-profile', FORGEDESK_DATA_DIR: 'actual-product-home', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' });
});

test('051 launch retains host ProgramData under Windows key casing and leaves production path validation intact', () => {
  const actual = path.join(root, 'host-program-data');
  for (const key of ['ProgramData', 'PROGRAMDATA', 'programdata', 'pRoGrAmDaTa']) {
    const source = { [key]: actual, Path: 'actual-path', PaThExT: 'actual-path-ext', SystemRoot: 'actual-system-root',
      windir: 'actual-windows', ComSpec: 'actual-command-processor', TEMP: 'actual-temp', TMP: 'actual-tmp' };
    const launched = fz3b051LaunchEnvironment(source, 'actual-product-home');
    assert.equal(launched[key], actual);
    assert.equal(Object.keys(launched).filter(name => name.toLowerCase() === 'programdata').length, 1);
    for (const [name, value] of Object.entries(source)) assert.equal(launched[name], value);
    assert.equal(fz3bSshEnvironment(launched).ProgramData, actual);
  }
  for (const source of [{}, { ProgramData: 'relative' }, { PROGRAMDATA: '' }, { programdata: `${actual}\nforeign` }]) {
    const launched = fz3b051LaunchEnvironment(source, 'actual-product-home');
    assert.equal(Object.keys(launched).some(name => name.toLowerCase() === 'programdata'), Object.keys(source).length > 0);
    assert.throws(() => fz3bSshEnvironment(launched), /FZ3B_WINDOWS_PROGRAMDATA_REQUIRED/);
  }
});

test('051 native supplement requires exactly five minutes from creation and immutable original displayed expiry', () => {
  const value = nativeFixture(); const result = assertFz3b051NativeGrant(value.run, value.receipt, value.timeline);
  assert.equal(result.ttlMs, 300000); assert.equal(result.queuedBehindObservedWarning, true); assert.equal(result.warningOverlapMs, 2000);
  for (const mutate of [(v: ReturnType<typeof nativeFixture>) => { v.run.grant!.expiresAt = '2026-10-16T10:05:00.001Z'; },
    (v: ReturnType<typeof nativeFixture>) => { v.run.grant!.createdAt = '2026-10-16T10:00:03.000Z'; v.run.grant!.expiresAt = '2026-10-16T10:05:03.000Z'; },
    (v: ReturnType<typeof nativeFixture>) => { v.receipt.calls[1].options.detail = 'other-expiry'; },
    (v: ReturnType<typeof nativeFixture>) => { v.run.operations[0].createdAt = v.run.grant!.expiresAt; },
    (v: ReturnType<typeof nativeFixture>) => { v.timeline[0].expiresAt = '2026-10-16T10:05:00.001Z'; },
    (v: ReturnType<typeof nativeFixture>) => { v.timeline = []; }]) {
    const bad = nativeFixture(); mutate(bad); assert.throws(() => assertFz3b051NativeGrant(bad.run, bad.receipt, bad.timeline));
  }
});

test('051 native supplement rejects synthetic/cancelled/unchecked callbacks rather than calling them a successful chain', () => {
  for (const mutate of [(v: ReturnType<typeof nativeFixture>) => { v.receipt.mechanism = 'synthetic callback'; },
    (v: ReturnType<typeof nativeFixture>) => { v.receipt.calls[1].response = 0; },
    (v: ReturnType<typeof nativeFixture>) => { v.receipt.calls[1].checkboxChecked = false; },
    (v: ReturnType<typeof nativeFixture>) => { v.receipt.calls[1].phase = 'started'; }]) {
    const bad = nativeFixture(); mutate(bad); assert.throws(() => assertFz3b051NativeGrant(bad.run, bad.receipt, bad.timeline));
  }
});

test('051 report does not claim warning queue overlap when the grant was created after the warning', () => {
  const value = nativeFixture(); value.receipt.calls[0].startedAt = '2026-10-16T09:59:57.000Z'; value.receipt.calls[0].finishedAt = '2026-10-16T09:59:59.000Z';
  const result = assertFz3b051NativeGrant(value.run, value.receipt, value.timeline);
  assert.equal(result.queuedBehindObservedWarning, false); assert.equal(result.warningOverlapMs, 0); assert.equal(result.creationToDisplayMs, 3000);
});
