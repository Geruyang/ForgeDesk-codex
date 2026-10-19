import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { createPackage, extractFile } from '@electron/asar';
import { snapshotReleaseResources } from './snapshot-installed-release';
import {
  FZ3B_PHASE3_BUNDLES, FZ3B_PHASE3_CANDIDATE, FZ3B_PHASE3_OUTPUT, FZ3B_PHASE3_RELEASE,
  FZ3B_PHASE3_SUPERSEDES, FZ3B_PREVIOUS_EVIDENCE, FZ3B_PREVIOUS_EVIDENCE_SHA256,
  assertFz3bPreflightCandidateShape, assertFz3bPreflightRequest,
  FZ3B_PREFLIGHT_PLAN_MAX_BYTES, FZ3B_PREFLIGHT_REQUEST_MAX_BYTES, fz3bAsarEntryPath, fz3bPreflightLaunchEnvironment,
  createFz3bPreflightRunOutput, fz3bPreflightPlanScope, readFz3bPreflightInput, serializeFz3bPreflightPlan, verifyFz3bPreviousEvidence,
  type Fz3bPreflightPlan, type Fz3bPreflightRequest,
} from './fz3b-preflight-installed';
import { assertFz3bPreflightUnknownSummaryMatches } from './fz3b-preflight-observation';

const sha = 'a'.repeat(64); const root = path.resolve('output/offline-fz3b-preflight-phase3-fixture');
function request(): Fz3bPreflightRequest {
  return { schemaVersion: 2, scope: 'fz3b-preflight-installed-resume-finish-v1', flow: 'resume-finish-only',
    previousEvidencePath: FZ3B_PREVIOUS_EVIDENCE, previousEvidenceSha256: FZ3B_PREVIOUS_EVIDENCE_SHA256, version: '0.5.3',
    runId: 'fz3b-preflight-1792222993309-abcdef', runtimeCommit: 'b'.repeat(40), candidateSha256: sha,
    targetRunId: '07427a29-0eae-44c7-ac35-34d6650eebee', targetOperationId: 'c6a3e027-abd8-40f7-b64e-d1b8e1a4620b',
    projectRoot: path.join(root, 'output/hardware/phase3-project'), nativeOperator: 'coordinator-delegated-visible-ui' };
}
function candidate() {
  const paths = [...snapshotReleaseResources, 'resources/fz3b/manifest.json', 'resources/fz3b/fixture/host-fixture.json'];
  const sourcePaths = ['apps/desktop/main/index.ts', 'apps/desktop/preload/index.ts', 'packages/engineering-runner/fz3b/types.ts',
    'apps/desktop/main/fz3b-agent.ts', 'apps/desktop/main/fz3b-recovery-approval.ts', 'apps/desktop/main/native-dialogs.ts',
    'apps/desktop/renderer/FZ3BPanel.tsx', 'packages/engineering-runner/fz3b/preflight-refusal-proof.ts',
    'packages/engineering-runner/fz3b/preflight-recovery.ts', 'packages/engineering-runner/fz3b/preflight-recovery-worker.ts',
    'packages/engineering-runner/fz3b/reconciliation-worker.ts', 'packages/engineering-runner/fz3b/backend.ts',
    'packages/engineering-runner/fz3b/worker.ts', 'scripts/build.mjs',
    'package.json', 'package-lock.json', `${FZ3B_PHASE3_OUTPUT}/builder.config.cjs`, `${FZ3B_PHASE3_OUTPUT}/record-candidate.ts`,
    'tests/helpers/fz3b-preflight-installed.ts', 'tests/helpers/fz3b-preflight-native-observer.ts',
    'tests/helpers/fz3b-preflight-native-observer.test.ts', 'tests/fz3b-preflight-installed-smoke.ts',
    'tests/helpers/fz3b-preflight-installed.test.ts', 'tests/helpers/fz3b-preflight-observation.ts',
    'tests/helpers/fz3b-preflight-observation.test.ts', 'tests/helpers/phase3-source-inventory.ts',
    'tests/helpers/phase3-source-inventory.test.ts'];
  return { schemaVersion: 1, scope: 'unsigned-phase3-release-candidate', version: '0.5.3',
    sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit', supersedesCandidateSha256: FZ3B_PHASE3_SUPERSEDES,
    builderConfig: { path: `${FZ3B_PHASE3_OUTPUT}/builder.config.cjs`, sha256: sha, output: FZ3B_PHASE3_RELEASE, nsisRunAfterFinish: false },
    sourceResourceManifestSha256: sha, gitBaseCommit: 'b'.repeat(40), workingTreeContainsUncommittedChanges: true,
    hostBuildIdentity: { script: 'scripts/build.mjs', version: '0.5.3', bundles: Object.fromEntries(FZ3B_PHASE3_BUNDLES.map(item => [item, sha])) },
    installer: { path: `${FZ3B_PHASE3_RELEASE}/ForgeDesk-0.5.3-x64-setup.exe`, bytes: 100, sha256: sha },
    resources: paths.map(item => ({ path: item, bytes: 10, sha256: sha })), sourceFiles: sourcePaths.map(item => ({ path: item, bytes: 1, sha256: sha })) };
}
function plan(): Fz3bPreflightPlan {
  const value = request(); const resources = Object.fromEntries([...snapshotReleaseResources, 'resources/fz3b/manifest.json'].map(item => [item, sha]));
  return { ...value, installedExe: path.join(root, 'install/ForgeDesk.exe'),
    installerPath: path.join(root, FZ3B_PHASE3_RELEASE, 'ForgeDesk-0.5.3-x64-setup.exe'), dataDir: path.join(root, '.runtime/app'),
    executableSha256: sha, installerSha256: sha, resourceHashes: resources, preparedAt: '2026-10-17T00:00:00Z',
    releaseBinding: { candidatePath: path.join(root, FZ3B_PHASE3_CANDIDATE), candidateSha256: sha,
      supersedesCandidateSha256: FZ3B_PHASE3_SUPERSEDES, gitBaseCommit: value.runtimeCommit,
      sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit',
      sourceFiles: [{ path: 'apps/desktop/main/index.ts', bytes: 1, sha256: sha }],
      bundles: Object.fromEntries(FZ3B_PHASE3_BUNDLES.map(item => [item, sha])), builderConfigSha256: sha } };
}

test('phase3 request is exact 0.5.3 resume-finish-only scope bound to approved prior evidence', () => {
  assertFz3bPreflightRequest(root, request());
  for (const patch of [{ version: '0.5.1' }, { version: '0.5.2' }, { scope: 'model-deploy' }, { flow: 'initial-recovery' },
    { previousEvidencePath: 'output/foreign/evidence.json' }, { previousEvidenceSha256: 'c'.repeat(64) }, { autoConfirm: true },
    { nativeOperator: 'generated-response' }, { runId: '../arbitrary' }, { candidateSha256: 'c'.repeat(64), targetRunId: 'foreign-run' },
    { targetOperationId: 'foreign-op' }, { projectRoot: path.join(root, '.runtime/app') }]) {
    assert.throws(() => assertFz3bPreflightRequest(root, { ...request(), ...patch }));
  }
});

test('resume evidence requires the exact externally pinned prior real recovery and preserves failure outcome', async () => {
  const rootPath = path.resolve('.');
  const verified = await verifyFz3bPreviousEvidence(rootPath);
  assert.equal(verified.sha256, FZ3B_PREVIOUS_EVIDENCE_SHA256);
  await assert.rejects(verifyFz3bPreviousEvidence(rootPath, FZ3B_PREVIOUS_EVIDENCE, 'c'.repeat(64)), /externally approved SHA/);
  await assert.rejects(verifyFz3bPreviousEvidence(rootPath, 'output/foreign/evidence.json', FZ3B_PREVIOUS_EVIDENCE_SHA256), /approved prior run/);
});

test('unknown-summary comparison matches the actual persisted prior report after JSON round-trip', async () => {
  const { evidence } = await verifyFz3bPreviousEvidence(path.resolve('.'));
  const saved = JSON.parse(JSON.stringify(evidence.originalUnknown));
  const runtimeShape = { ...saved,
    calls: saved.calls.map((call: any) => ({ ...call, operationId: call.operationId })),
    operations: saved.operations.map((operation: any) => ({ ...operation, kind: operation.kind,
      dispatchPhase: operation.dispatchPhase, processExited: operation.processExited, remoteQuiescent: operation.remoteQuiescent })) };
  assert.equal(runtimeShape.calls[0].operationId, undefined, 'The real persisted report omits undefined optional keys');
  assertFz3bPreflightUnknownSummaryMatches(runtimeShape as any, saved);
  assert.throws(() => assertFz3bPreflightUnknownSummaryMatches({ ...runtimeShape, status: 'succeeded' } as any, saved));
  assert.throws(() => assertFz3bPreflightUnknownSummaryMatches({ ...runtimeShape,
    calls: runtimeShape.calls.map((call: any, index: number) => index === 0 ? { ...call, tool: 'foreign' } : call) } as any, saved));
  assert.throws(() => assertFz3bPreflightUnknownSummaryMatches({ ...runtimeShape,
    operations: runtimeShape.operations.map((operation: any, index: number) => index === 0 ? { ...operation, status: 'unknown' } : operation) } as any, saved));
});

test('phase3 candidate binds exact successor, builder, bundle, installer and FZ3B inventory', () => {
  assertFz3bPreflightCandidateShape(candidate());
  for (const mutate of [
    (value: any) => { value.version = '0.5.1'; },
    (value: any) => { value.supersedesCandidateSha256 = 'c'.repeat(64); },
    (value: any) => { value.builderConfig.output = 'release'; },
    (value: any) => { value.builderConfig.nsisRunAfterFinish = true; },
    (value: any) => { delete value.hostBuildIdentity.bundles['dist/main/index.cjs']; },
    (value: any) => { value.resources = value.resources.filter((item: any) => item.path !== 'resources/app.asar'); },
    (value: any) => { value.resources.push({ ...value.resources[0] }); },
    (value: any) => { value.resources = value.resources.filter((item: any) => item.path !== 'resources/fz3b/manifest.json'); },
    (value: any) => { value.resources[0].path = 'resources/../private'; },
    (value: any) => { value.sourceFiles = value.sourceFiles.filter((item: any) => item.path !== 'apps/desktop/main/index.ts'); },
  ]) { const value = candidate(); mutate(value); assert.throws(() => assertFz3bPreflightCandidateShape(value)); }
});

test('ASAR lookup normalizes host separators while candidate paths remain forward-slash canonical', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fz3b-asar-path-'));
  try {
    const source = path.join(temporary, 'source'), archive = path.join(temporary, 'fixture.asar');
    const bundle = 'dist/main/index.cjs', contents = Buffer.from('win32-asar-path-fixture');
    await mkdir(path.join(source, 'dist/main'), { recursive: true }); await writeFile(path.join(source, bundle), contents);
    const stream = await createPackage(source, archive); await finished(stream);
    assert.equal(fz3bAsarEntryPath(bundle), path.normalize(bundle));
    assert.deepEqual(extractFile(archive, fz3bAsarEntryPath(bundle)), contents);
    assert.equal(bundle, 'dist/main/index.cjs', 'Candidate metadata remains forward-slash canonical');
    assert.throws(() => fz3bAsarEntryPath('../outside'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});


test('phase3 plan is pinned to the distinct installed package, official data home and isolated output', () => {
  assert.equal(fz3bPreflightPlanScope(root, plan(), {}).output, path.join(root, FZ3B_PHASE3_OUTPUT, 'runs', request().runId));
  for (const mutate of [
    (value: Fz3bPreflightPlan) => { value.dataDir = path.join(root, '.runtime/copied-auth'); },
    (value: Fz3bPreflightPlan) => { value.installedExe = path.join(root, 'release/win-unpacked/ForgeDesk.exe'); },
    (value: Fz3bPreflightPlan) => { value.installerPath = path.join(root, 'release/ForgeDesk-0.5.3-x64-setup.exe'); },
    (value: Fz3bPreflightPlan) => { value.releaseBinding.candidatePath = path.join(root, 'old-candidate.json'); },
    (value: Fz3bPreflightPlan) => { value.releaseBinding.bundles['dist/main/index.cjs'] = '../private'; },
    (value: Fz3bPreflightPlan) => { value.resourceHashes['resources/../private'] = sha; },
    (value: Fz3bPreflightPlan) => { value.runId = '../arbitrary'; },
    (value: Fz3bPreflightPlan) => { (value as any).extraAuthority = true; },
    (value: Fz3bPreflightPlan) => { (value.releaseBinding as any).unreviewedSource = 'extra'; },
  ]) { const value = structuredClone(plan()); mutate(value); assert.throws(() => fz3bPreflightPlanScope(root, value, {})); }
  for (const env of [{ CODEX_HOME: 'private' }, { ELECTRON_RUN_AS_NODE: '1' }, { FORGEDESK_FZ3B_TEST_MODE: 'yes' }]) {
    assert.throws(() => fz3bPreflightPlanScope(root, plan(), env));
  }
});

test('prepare and execute share request/plan byte bounds, including a serialized 424-source plan', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fz3b-plan-size-'));
  try {
    const largePlan = plan();
    largePlan.releaseBinding.sourceFiles = Array.from({ length: 424 }, (_, index) => ({
      path: `packages/engineering-runner/fz3b/source-${String(index).padStart(4, '0')}.ts`, bytes: 4096, sha256: sha,
    }));
    const planBytes = serializeFz3bPreflightPlan(largePlan);
    assert.ok(planBytes.byteLength > FZ3B_PREFLIGHT_REQUEST_MAX_BYTES);
    assert.ok(planBytes.byteLength < FZ3B_PREFLIGHT_PLAN_MAX_BYTES);
    const planFile = path.join(temporary, '424-source.plan.json'); await writeFile(planFile, planBytes, { flag: 'wx' });
    const decoded = await readFz3bPreflightInput(planFile, 'plan') as Fz3bPreflightPlan;
    assert.equal(decoded.releaseBinding.sourceFiles.length, 424);
    assert.throws(() => serializeFz3bPreflightPlan({ ...largePlan, padding: 'x'.repeat(FZ3B_PREFLIGHT_PLAN_MAX_BYTES) } as any), /Plan exceeds/);
    const tooLargePlan = path.join(temporary, 'too-large.plan.json'); await writeFile(tooLargePlan, Buffer.alloc(FZ3B_PREFLIGHT_PLAN_MAX_BYTES + 1));
    await assert.rejects(readFz3bPreflightInput(tooLargePlan, 'plan'), /plain file no larger/);
    const tooLargeRequest = path.join(temporary, 'too-large.request.json');
    await writeFile(tooLargeRequest, `${JSON.stringify(request())}${' '.repeat(FZ3B_PREFLIGHT_REQUEST_MAX_BYTES)}`);
    await assert.rejects(readFz3bPreflightInput(tooLargeRequest, 'request'), /plain file no larger/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('run output parent is plain and run leaf creation is exclusive', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fz3b-run-output-'));
  try {
    const runId = request().runId, expected = path.join(temporary, FZ3B_PHASE3_OUTPUT, 'runs', runId);
    assert.equal(await createFz3bPreflightRunOutput(temporary, runId), expected);
    await assert.rejects(createFz3bPreflightRunOutput(temporary, runId));
    await assert.rejects(createFz3bPreflightRunOutput(temporary, '../existing-run'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('phase3 launch environment excludes auth, Node hooks, proxy, SSH and acceptance overrides', () => {
  assert.deepEqual(fz3bPreflightLaunchEnvironment({ PATH: 'actual-path', USERPROFILE: 'actual-profile', ProgramData: 'host-program-data',
    OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require=foreign', NODE_PATH: 'foreign', GIT_DIR: 'foreign',
    ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: 'foreign', SSH_AUTH_SOCK: 'foreign', HTTPS_PROXY: 'foreign',
    FORGEDESK_FZ3B_TEST_MODE: 'yes' }, 'official-app-home'),
  { PATH: 'actual-path', USERPROFILE: 'actual-profile', ProgramData: 'host-program-data', FORGEDESK_DATA_DIR: 'official-app-home',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' });
});
