import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { snapshotReleaseResources } from './snapshot-installed-release';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from '../../packages/engineering-runner/fz3b/preflight-recovery';
import {
  FZ3B_HOST_FINAL_BUNDLES, FZ3B_HOST_FINAL_CANDIDATE, FZ3B_HOST_FINAL_FAILURE_EVIDENCE,
  FZ3B_HOST_FINAL_FAILURE_SHA256, FZ3B_HOST_FINAL_OUTPUT, FZ3B_HOST_FINAL_SUCCESS_EVIDENCE,
  FZ3B_HOST_FINAL_SUCCESS_SHA256, FZ3B_HOST_FINAL_SUPERSEDES, FZ3B_HOST_FINAL_VERSION,
  assertFz3bHostFinalCandidateShape, assertFz3bHostFinalRequest, createFz3bHostFinalRunOutput,
  fz3bHostFinalPlanScope, fz3bHostFinalLaunchEnvironment, fz3bHostFinalFirstLaunchQuietExceptHeldOwner, readFz3bHostFinalEvidence,
  serializeFz3bHostFinalPlan, type Fz3bHostFinalPlan, type Fz3bHostFinalRequest,
} from './fz3b-host-finalization-installed';

const SHA = 'a'.repeat(64), ROOT = path.resolve('output/qa/2026-10-17-fz3b-recovery/nextphase-qa/revision-0.5.5-fixture');
function request(): Fz3bHostFinalRequest {
  return { schemaVersion: 1, scope: 'fz3b-host-finalization-installed-three-launch-v2', flow: 'maintenance-exit-then-quarantine-finish-then-no-rehold',
    version: '0.5.5', runId: 'fz3b-host-final-1792300000000-a1b2c3', runtimeCommit: 'b'.repeat(40), candidateSha256: SHA,
    targetRunId: FZ3B_PREFLIGHT_RECOVERY_CASE.runId, targetOperationId: FZ3B_PREFLIGHT_RECOVERY_CASE.operationId,
    projectRoot: path.join(ROOT, 'output/hardware/host-final-project'), priorSuccessEvidencePath: FZ3B_HOST_FINAL_SUCCESS_EVIDENCE,
    priorSuccessEvidenceSha256: FZ3B_HOST_FINAL_SUCCESS_SHA256, priorFailureEvidencePath: FZ3B_HOST_FINAL_FAILURE_EVIDENCE,
    priorFailureEvidenceSha256: FZ3B_HOST_FINAL_FAILURE_SHA256, nativeOperator: 'coordinator-delegated-visible-ui' };
}

function candidate() {
  const resources = [...new Set([...snapshotReleaseResources, 'resources/fz3b/manifest.json', 'resources/fz3b/product.json'])];
  const sourceFiles = ['apps/desktop/main/index.ts', 'apps/desktop/main/fz3b-agent.ts', 'apps/desktop/main/host-finalization-store.ts',
    'apps/desktop/main/store.ts', 'packages/engineering-runner/fz3b/credentials.ts', 'tests/helpers/desktop-harness.ts',
    'packages/engineering-runner/fz3b/backend.ts', 'packages/engineering-runner/fz3b/backend-host-finalization.test.ts',
    'packages/engineering-runner/fz3b/host-finalization.ts', 'packages/engineering-runner/fz3b/host-finalization.test.ts',
    'packages/engineering-runner/fz3b/host-finalization-witness.ts', 'packages/engineering-runner/fz3b/preflight-recovery.ts',
    'packages/engineering-runner/fz3b/preflight-recovery-worker.ts', 'packages/engineering-runner/fz3b/worker.ts',
    'apps/desktop/preload/index.ts', 'apps/desktop/renderer/FZ3BPanel.tsx', 'engineering/fz3b/product/resources/manifest.json',
    'tests/helpers/fz3b-preflight-installed.ts', `${FZ3B_HOST_FINAL_OUTPUT}/builder.config.cjs`, `${FZ3B_HOST_FINAL_OUTPUT}/record-candidate.ts`,
    'tests/fz3b-host-finalization-store.test.ts', 'tests/fz3b-host-finalization-main.test.ts',
    'tests/fz3b-host-finalization-boundaries.test.ts', 'tests/fz3b-host-finalization-acl.test.ts',
    'tests/fz3b-host-finalization-installed-smoke.ts', 'tests/helpers/fz3b-host-finalization-installed.ts',
    'tests/helpers/fz3b-host-finalization-installed.test.ts', 'tests/helpers/fz3b-host-finalization-ipc-observer.ts',
    'tests/helpers/fz3b-host-finalization-ipc-observer.test.ts', 'tests/helpers/fz3b-host-native-exit.ts',
    'tests/helpers/fz3b-host-native-exit.test.ts', 'tests/helpers/fz3b-host-finalization-observation.test.ts',
    'tests/fz3b-host-empty-home-startup.test.ts'];
  return { schemaVersion: 1, scope: 'unsigned-phase3-release-candidate', version: FZ3B_HOST_FINAL_VERSION,
    sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit', supersedesCandidateSha256: FZ3B_HOST_FINAL_SUPERSEDES,
    builderConfig: { path: `${FZ3B_HOST_FINAL_OUTPUT}/builder.config.cjs`, sha256: SHA, output: `${FZ3B_HOST_FINAL_OUTPUT}/release`, nsisRunAfterFinish: false },
    sourceResourceManifestSha256: SHA, gitBaseCommit: 'b'.repeat(40), workingTreeContainsUncommittedChanges: true,
    hostBuildIdentity: { script: 'scripts/build.mjs', version: FZ3B_HOST_FINAL_VERSION, bundles: Object.fromEntries(FZ3B_HOST_FINAL_BUNDLES.map(item => [item, SHA])) },
    installer: { path: `${FZ3B_HOST_FINAL_OUTPUT}/release/ForgeDesk-0.5.5-x64-setup.exe`, bytes: 100, sha256: SHA },
    resources: resources.map(item => ({ path: item, bytes: 10, sha256: SHA })), sourceFiles: sourceFiles.map(item => ({ path: item, bytes: 1, sha256: SHA })) };
}

function plan(): Fz3bHostFinalPlan {
  return { ...request(), installedExe: path.join(ROOT, 'install/ForgeDesk.exe'), installerPath: path.join(ROOT, FZ3B_HOST_FINAL_OUTPUT, 'release/ForgeDesk-0.5.5-x64-setup.exe'),
    dataDir: path.join(ROOT, '.runtime/app'), executableSha256: SHA, installerSha256: SHA,
    resourceHashes: { 'ForgeDesk.exe': SHA, 'resources/fz3b/manifest.json': SHA }, preparedAt: '2026-10-17T00:00:00Z',
    releaseBinding: { candidatePath: path.join(ROOT, FZ3B_HOST_FINAL_CANDIDATE), candidateSha256: SHA,
      supersedesCandidateSha256: FZ3B_HOST_FINAL_SUPERSEDES, gitBaseCommit: 'b'.repeat(40),
      sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit', sourceFiles: [{ path: 'apps/desktop/main/index.ts', bytes: 1, sha256: SHA }],
      bundles: Object.fromEntries(FZ3B_HOST_FINAL_BUNDLES.map(item => [item, SHA])), builderConfigSha256: SHA } };
}

test('0.5.5 request binds exact three-launch local flow and both immutable prior evidence files', () => {
  assertFz3bHostFinalRequest(ROOT, request());
  for (const patch of [{ version: '0.5.3' }, { version: '0.5.4' }, { scope: 'fz3b-host-finalization-installed-two-launch-v1' },
    { flow: 'first-finish-then-second-no-rehold' }, { scope: 'new-boot-admission' }, { flow: 'finish-twice' }, { autoFinish: true },
    { priorSuccessEvidencePath: 'output/foreign/evidence.json' }, { priorSuccessEvidenceSha256: 'c'.repeat(64) },
    { priorFailureEvidenceSha256: 'c'.repeat(64) }, { candidateSha256: '../manifest' }, { targetRunId: 'foreign' },
    { nativeOperator: 'automated-ipc' }, { extra: true }, { projectRoot: path.join(ROOT, '.runtime/app') }]) {
    assert.throws(() => assertFz3bHostFinalRequest(ROOT, { ...request(), ...patch }));
  }
});

test('candidate schema closes version, predecessor, installer, bundle, complete resource and required source pins', () => {
  const valid = candidate(); assert.equal(assertFz3bHostFinalCandidateShape(valid), valid);
  for (const patch of [{ version: '0.5.3' }, { version: '0.5.4' }, { supersedesCandidateSha256: 'c'.repeat(64) },
    { hostBuildIdentity: { ...candidate().hostBuildIdentity, bundles: {} } },
    { resources: candidate().resources.filter((item: any) => item.path !== 'resources/app.asar') },
    { resources: [...candidate().resources, { path: 'resources/unreviewed.bin', bytes: 1, sha256: SHA }] },
    { sourceFiles: candidate().sourceFiles.filter((item: any) => item.path !== 'apps/desktop/main/host-finalization-store.ts') }]) {
    assert.throws(() => assertFz3bHostFinalCandidateShape({ ...candidate(), ...patch }));
  }
});

test('approved 0.5.3 success and prior failure evidence are read once, hash-pinned and not reclassified', async () => {
  const root = path.resolve('.');
  const success = await readFz3bHostFinalEvidence(root, FZ3B_HOST_FINAL_SUCCESS_EVIDENCE, FZ3B_HOST_FINAL_SUCCESS_SHA256, 'success');
  assert.equal(success.evidence.result, 'observed-only-resume-finish');
  assert.equal(success.evidence.observations.find((item: any) => item.stage === 'human-finish-observed').completionEvidenceSha256,
    '39db6cadca3e679ba927294fc0bf07bdf294c553eb3bf0bb6085dd79d7df7e11');
  const failure = await readFz3bHostFinalEvidence(root, FZ3B_HOST_FINAL_FAILURE_EVIDENCE, FZ3B_HOST_FINAL_FAILURE_SHA256, 'failure');
  assert.ok(failure.evidence.failure);
  await assert.rejects(readFz3bHostFinalEvidence(root, FZ3B_HOST_FINAL_SUCCESS_EVIDENCE, 'c'.repeat(64), 'success'));
});

test('plan scope rejects added fields, ambient overrides and non-primary data home', () => {
  const value = plan(); fz3bHostFinalPlanScope(ROOT, value, {});
  assert.throws(() => fz3bHostFinalPlanScope(ROOT, { ...value, approved: true }, {}));
  assert.throws(() => fz3bHostFinalPlanScope(ROOT, value, { FORGEDESK_FZ3B_TEST_OVERRIDE: '1' }), /ambient acceptance override/);
  assert.throws(() => fz3bHostFinalPlanScope(ROOT, { ...value, dataDir: path.join(ROOT, '.runtime/other') }, {}));
  assert.throws(() => serializeFz3bHostFinalPlan({ ...value, releaseBinding: { ...value.releaseBinding,
    sourceFiles: Array(30000).fill({ path: 'x', bytes: 0, sha256: SHA }) } } as any), /512 KiB/);
});

test('first-launch hold predicate requires exact target owner and affirmative global quiet fields', () => {
  const held = { fz3bAgent: { activeRunId: FZ3B_PREFLIGHT_RECOVERY_CASE.runId, engineState: 'stopped', runs: [
    { runId: FZ3B_PREFLIGHT_RECOVERY_CASE.runId, active: false, hardwareBusy: false, nativeApproval: 'not_requested' } ] },
    hardwareAgent: { activeRunId: undefined, engineState: 'stopped', runs: [] }, engine: { state: 'stopped' }, approvals: [], tasks: [], sessions: [] };
  assert.equal(fz3bHostFinalFirstLaunchQuietExceptHeldOwner(held, FZ3B_PREFLIGHT_RECOVERY_CASE.runId), true);
  for (const alter of [
    (value: any) => { value.fz3bAgent.activeRunId = 'foreign'; },
    (value: any) => { value.hardwareAgent.activeRunId = 'foreign'; },
    (value: any) => { value.engine.state = 'running'; },
    (value: any) => { value.approvals.push({ id: 1 }); },
    (value: any) => { value.tasks.push({ operations: [{ status: 'unknown' }] }); },
    (value: any) => { value.sessions.push({ status: 'stopping', engineUncertain: false }); },
    (value: any) => { value.tasks = undefined; },
  ]) { const state = structuredClone(held); alter(state); assert.equal(fz3bHostFinalFirstLaunchQuietExceptHeldOwner(state, FZ3B_PREFLIGHT_RECOVERY_CASE.runId), false); }
});

test('launch environment is allowlisted and run output is exclusive', async () => {
  const environment = fz3bHostFinalLaunchEnvironment({ PATH: 'path', USERPROFILE: 'profile', CODEX_HOME: 'secret', GIT_DIR: 'override' }, path.join(ROOT, '.runtime/app'));
  assert.equal(environment.PATH, 'path'); assert.equal(environment.CODEX_HOME, undefined); assert.equal(environment.GIT_DIR, undefined);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fz3b-host-final-output-'));
  try {
    const runId = 'fz3b-host-final-1792300000000-a1b2c3'; const output = await createFz3bHostFinalRunOutput(temporary, runId);
    assert.equal(path.basename(output), runId); await assert.rejects(createFz3bHostFinalRunOutput(temporary, runId));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
