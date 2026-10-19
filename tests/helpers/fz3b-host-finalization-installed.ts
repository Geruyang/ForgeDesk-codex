import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import { assertFz3bOriginalUnknownPreserved, assertFz3bPreflightFinished, fz3bPreflightTarget,
  fz3bPreflightUnknownSummary, fz3bPreflightRecoverySettled, fz3bFinishUiSettled } from './fz3b-preflight-observation';
import { assertFz3bHostFinalizationIpcReceipt, type Fz3bHostFinalizationIpcReceipt } from './fz3b-host-finalization-ipc-observer';
import { fileSha256, inside, plainPath, samePath } from './embedded-installed';
import { snapshotReleaseResources } from './snapshot-installed-release';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from '../../packages/engineering-runner/fz3b/preflight-recovery';
import { fz3bAsarEntryPath } from './fz3b-preflight-installed';

export const FZ3B_HOST_FINAL_OUTPUT = 'output/qa/2026-10-17-fz3b-recovery/nextphase-qa/revision-0.5.5';
export const FZ3B_HOST_FINAL_RELEASE = `${FZ3B_HOST_FINAL_OUTPUT}/release`;
export const FZ3B_HOST_FINAL_CANDIDATE = `${FZ3B_HOST_FINAL_OUTPUT}/release-candidate-0.5.5.json`;
export const FZ3B_HOST_FINAL_VERSION = '0.5.5';
export const FZ3B_HOST_FINAL_SUPERSEDES = '669aa82bbaf8df5bab12f84f5baaf026a9b67010ebb1e0365da749f9973c1f79';
export const FZ3B_HOST_FINAL_SUCCESS_EVIDENCE = 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/revision-0.5.3/runs/fz3b-preflight-1792238733530-866856/evidence.json';
export const FZ3B_HOST_FINAL_SUCCESS_SHA256 = '45e0f5d9f4a39c767647b4ecf0bb10120942d1e863fc9d89f900275c5ee5d0f2';
export const FZ3B_HOST_FINAL_SUCCESS_CANDIDATE_SHA256 = '2db95b25b51572ace32efa91d257f05f810e0bb7f7d086f399aa0f4b2ced22ee';
export const FZ3B_HOST_FINAL_FAILURE_EVIDENCE = 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/revision-0.5.3/runs/fz3b-preflight-1792237043341-b83725/evidence.json';
export const FZ3B_HOST_FINAL_FAILURE_SHA256 = '77affe796d4c0ca692abc5688b452ddb36539875517d987f53f4def1343190d6';
export const FZ3B_HOST_FINAL_COMPLETION_SHA256 = '39db6cadca3e679ba927294fc0bf07bdf294c553eb3bf0bb6085dd79d7df7e11';
export const FZ3B_HOST_FINAL_BUNDLES = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.js', 'dist/renderer/index.css',
  'dist/renderer/index.html', 'dist/mcp/index.cjs'] as const;
const SHA = /^[a-f0-9]{64}$/;
export const FZ3B_HOST_FINAL_REQUIRED_SOURCES = [
  'apps/desktop/main/index.ts', 'apps/desktop/main/fz3b-agent.ts', 'apps/desktop/main/host-finalization-store.ts',
  'apps/desktop/main/store.ts', 'packages/engineering-runner/fz3b/credentials.ts', 'tests/helpers/desktop-harness.ts',
  'packages/engineering-runner/fz3b/backend.ts', 'packages/engineering-runner/fz3b/backend-host-finalization.test.ts',
  'packages/engineering-runner/fz3b/host-finalization.ts', 'packages/engineering-runner/fz3b/host-finalization.test.ts',
  'packages/engineering-runner/fz3b/host-finalization-witness.ts', 'packages/engineering-runner/fz3b/preflight-recovery.ts',
  'packages/engineering-runner/fz3b/preflight-recovery-worker.ts', 'packages/engineering-runner/fz3b/worker.ts',
  'apps/desktop/preload/index.ts', 'apps/desktop/renderer/FZ3BPanel.tsx', 'engineering/fz3b/product/resources/manifest.json',
  'tests/helpers/fz3b-preflight-installed.ts',
  'tests/fz3b-host-finalization-store.test.ts', 'tests/fz3b-host-finalization-main.test.ts',
  'tests/fz3b-host-finalization-boundaries.test.ts', 'tests/fz3b-host-finalization-acl.test.ts',
  'tests/fz3b-host-finalization-installed-smoke.ts',
  'tests/helpers/fz3b-host-finalization-installed.ts', 'tests/helpers/fz3b-host-finalization-installed.test.ts',
  'tests/helpers/fz3b-host-finalization-ipc-observer.ts', 'tests/helpers/fz3b-host-finalization-ipc-observer.test.ts',
  'tests/helpers/fz3b-host-native-exit.ts', 'tests/helpers/fz3b-host-native-exit.test.ts',
  'tests/helpers/fz3b-host-finalization-observation.test.ts',
  'tests/fz3b-host-empty-home-startup.test.ts',
  `${FZ3B_HOST_FINAL_OUTPUT}/builder.config.cjs`, `${FZ3B_HOST_FINAL_OUTPUT}/record-candidate.ts`,
] as const;

export interface Fz3bHostFinalRequest {
  schemaVersion: 1; scope: 'fz3b-host-finalization-installed-three-launch-v2'; flow: 'maintenance-exit-then-quarantine-finish-then-no-rehold';
  version: '0.5.5'; runId: string; runtimeCommit: string; candidateSha256: string; targetRunId: string; targetOperationId: string;
  projectRoot: string; priorSuccessEvidencePath: string; priorSuccessEvidenceSha256: string;
  priorFailureEvidencePath: string; priorFailureEvidenceSha256: string; nativeOperator: 'coordinator-delegated-visible-ui';
}
export interface Fz3bHostFinalPlan extends Fz3bHostFinalRequest {
  installedExe: string; installerPath: string; dataDir: string; executableSha256: string; installerSha256: string;
  resourceHashes: Record<string, string>; preparedAt: string;
  releaseBinding: { candidatePath: string; candidateSha256: string; supersedesCandidateSha256: string; gitBaseCommit: string;
    sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit'; sourceFiles: Array<{ path: string; bytes: number; sha256: string }>;
    bundles: Record<string, string>; builderConfigSha256: string };
}

export async function observeFz3bHostFinalOriginalCall(before: Fz3bRunView, read: {
  ipc(): Promise<Fz3bHostFinalizationIpcReceipt>;
  snapshot(): Promise<AppSnapshot>;
  dom(): Promise<unknown>;
}, purpose: 'finish' | 'quarantine' = 'finish'): Promise<{ settled: boolean; state: AppSnapshot; ipc: Fz3bHostFinalizationIpcReceipt; dom: unknown }> {
  // Read the original Promise first; never validate a pre-terminal snapshot as its final projection.
  const ipc = await read.ipc();
  assert.equal(ipc.runId, before.runId);
  assert.equal(ipc.purpose, purpose === 'finish' ? undefined : purpose);
  assert.equal(ipc.electronVersion, '44.7.2');
  assert.equal(ipc.mechanism, 'test-only exact-run original forgedesk:invoke pass-through observer');
  assert.ok(ipc.calls.length <= 1, 'Duplicate visible finish IPC calls are not accepted');
  const call = ipc.calls[0];
  if (call) {
    assert.equal(call.argumentsValid, true); assert.equal(call.argumentCount, 1);
    assert.ok(Number.isFinite(call.startedAt));
    assert.ok(['started', 'fulfilled', 'rejected'].includes(call.phase));
    if (call.phase === 'rejected') throw new Error(`Original visible finish IPC rejected: ${call.error ?? 'unknown error'}`);
    if (call.phase === 'fulfilled') assertFz3bHostFinalizationIpcReceipt(ipc, 1, purpose);
    else { assert.equal(call.finishedAt, undefined); assert.equal(call.error, undefined); }
  }
  const state = await read.snapshot(), run = fz3bPreflightTarget(state, before.runId);
  assert.deepEqual(fz3bPreflightUnknownSummary(run), fz3bPreflightUnknownSummary(before));
  if (call?.phase === 'started') {
    assert.equal(run.taskId, before.taskId); assert.equal(run.sessionId, before.sessionId);
    for (const field of ['calls', 'operations', 'artifact', 'identity', 'grant', 'semantic', 'maintenanceExit'] as const) {
      assert.deepEqual(run[field], before[field], `Original ${field} changed while the original IPC was pending`);
    }
  } else assertFz3bOriginalUnknownPreserved(before, run);
  const dom = await read.dom();
  const ui = dom as any;
  const domSettled = purpose === 'finish' ? fz3bFinishUiSettled(dom, before.taskId) : ui?.taskId === before.taskId &&
    ui.connected === true && ui.sameElement === true && ui.initialIntent === '' && ui.currentIntent === '' &&
    ui.ariaBusy === 'false' && ui.actionErrorCount === 0 && JSON.stringify(ui.sequence) === JSON.stringify(['', 'quarantine-empty-home', '']);
  const settled = call?.phase === 'fulfilled' && domSettled && (purpose === 'finish'
    ? fz3bPreflightRecoverySettled(state, before.runId)
    : fz3bHostFinalFirstLaunchQuietExceptHeldOwner(state, before.runId) && state.fz3bAgent?.recoveryActions?.finishPreflightRefusal === true &&
      state.fz3bAgent.recoveryActions.quarantineEmptyHome === false);
  if (settled && purpose === 'finish') assertFz3bPreflightFinished(state, before.runId, before);
  return { settled, state, ipc, dom };
}

export function fz3bHostFinalFirstLaunchQuietExceptHeldOwner(state: any, runId: string): boolean {
  const run = state.fz3bAgent?.runs.find((item: any) => item.runId === runId);
  const taskOperationsQuiet = Array.isArray(state.tasks) && state.tasks.every((task: any) => Array.isArray(task.operations) && task.operations.every((operation: any) =>
    !['prepared', 'running', 'stopping', 'unknown'].includes(String(operation.status).toLowerCase()) && operation.cleanup !== 'unknown'));
  const sessionsQuiet = Array.isArray(state.sessions) && state.sessions.every((session: any) =>
    !session.engineUncertain && !['running', 'stopping'].includes(String(session.status).toLowerCase()));
  return !!run && state.fz3bAgent?.activeRunId === runId && state.fz3bAgent?.engineState === 'stopped' &&
    Array.isArray(state.fz3bAgent?.runs) && state.fz3bAgent.runs.every((item: any) => !item.active && !item.hardwareBusy && item.nativeApproval !== 'pending') &&
    state.hardwareAgent?.activeRunId === undefined && state.hardwareAgent?.engineState === 'stopped' &&
    Array.isArray(state.hardwareAgent?.runs) && state.hardwareAgent.runs.every((item: any) => !item.active && !item.hardwareBusy && item.nativeApproval !== 'pending') &&
    state.engine?.state === 'stopped' && Array.isArray(state.approvals) && state.approvals.length === 0 && taskOperationsQuiet && sessionsQuiet;
}

export function assertFz3bHostFinalRequest(root: string, input: unknown): asserts input is Fz3bHostFinalRequest {
  const request = input as Fz3bHostFinalRequest;
  assert.equal(request?.schemaVersion, 1); assert.equal(request.scope, 'fz3b-host-finalization-installed-three-launch-v2');
  assert.equal(request.flow, 'maintenance-exit-then-quarantine-finish-then-no-rehold'); assert.equal(request.version, FZ3B_HOST_FINAL_VERSION);
  assert.deepEqual(Object.keys(request).sort(), ['schemaVersion', 'scope', 'flow', 'version', 'runId', 'runtimeCommit', 'candidateSha256',
    'targetRunId', 'targetOperationId', 'projectRoot', 'priorSuccessEvidencePath', 'priorSuccessEvidenceSha256',
    'priorFailureEvidencePath', 'priorFailureEvidenceSha256', 'nativeOperator'].sort());
  assert.match(request.runId, /^fz3b-host-final-\d{13}-[a-f0-9]{6}$/); assert.match(request.runtimeCommit, /^[a-f0-9]{40}$/);
  assert.match(request.candidateSha256, SHA); assert.equal(request.targetRunId, FZ3B_PREFLIGHT_RECOVERY_CASE.runId);
  assert.equal(request.targetOperationId, FZ3B_PREFLIGHT_RECOVERY_CASE.operationId);
  assert.equal(request.priorSuccessEvidencePath, FZ3B_HOST_FINAL_SUCCESS_EVIDENCE);
  assert.equal(request.priorSuccessEvidenceSha256, FZ3B_HOST_FINAL_SUCCESS_SHA256);
  assert.equal(request.priorFailureEvidencePath, FZ3B_HOST_FINAL_FAILURE_EVIDENCE);
  assert.equal(request.priorFailureEvidenceSha256, FZ3B_HOST_FINAL_FAILURE_SHA256);
  assert.equal(request.nativeOperator, 'coordinator-delegated-visible-ui');
  assert.ok(path.isAbsolute(root) && path.isAbsolute(request.projectRoot) && inside(path.join(root, 'output/hardware'), request.projectRoot));
}

export function assertFz3bHostFinalCandidateShape(candidate: any) {
  assert.equal(candidate?.schemaVersion, 1); assert.equal(candidate.scope, 'unsigned-phase3-release-candidate');
  assert.equal(candidate.version, FZ3B_HOST_FINAL_VERSION); assert.equal(candidate.sourceIdentity, 'captured-file-hashes-not-exact-runtime-commit');
  assert.equal(candidate.supersedesCandidateSha256, FZ3B_HOST_FINAL_SUPERSEDES);
  assert.equal(candidate.builderConfig?.path, `${FZ3B_HOST_FINAL_OUTPUT}/builder.config.cjs`);
  assert.equal(candidate.builderConfig.output, FZ3B_HOST_FINAL_RELEASE); assert.equal(candidate.builderConfig.nsisRunAfterFinish, false);
  assert.match(candidate.builderConfig.sha256, SHA); assert.match(candidate.sourceResourceManifestSha256, SHA);
  assert.match(candidate.gitBaseCommit, /^[a-f0-9]{40}$/); assert.equal(candidate.workingTreeContainsUncommittedChanges, true);
  assert.equal(candidate.hostBuildIdentity.script, 'scripts/build.mjs'); assert.equal(candidate.hostBuildIdentity.version, FZ3B_HOST_FINAL_VERSION);
  assert.deepEqual(Object.keys(candidate.hostBuildIdentity.bundles ?? {}).sort(), [...FZ3B_HOST_FINAL_BUNDLES].sort());
  for (const hash of Object.values(candidate.hostBuildIdentity.bundles)) assert.match(hash as string, SHA);
  const resourcePaths = candidate.resources.map((item: any) => item.path);
  assert.equal(new Set(resourcePaths).size, resourcePaths.length);
  assert.deepEqual(candidate.resources.filter((item: any) => !item.path.startsWith('resources/fz3b/')).map((item: any) => item.path).sort(),
    [...snapshotReleaseResources].sort(), 'Non-FZ3B release resources must be the exact reviewed fixed set');
  assert.ok(resourcePaths.includes('ForgeDesk.exe') && resourcePaths.includes('resources/app.asar'));
  assert.ok(resourcePaths.includes('resources/fz3b/manifest.json'));
  assert.deepEqual(candidate.resources.filter((item: any) => snapshotReleaseResources.includes(item.path)).map((item: any) => item.path).sort(),
    [...snapshotReleaseResources].sort());
  for (const item of candidate.resources) {
    assert.ok(item.path === 'ForgeDesk.exe' || /^resources\/[A-Za-z0-9._/-]+$/.test(item.path));
    assert.ok(item.path.split('/').every((part: string) => part && part !== '.' && part !== '..'));
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0); assert.match(item.sha256, SHA);
  }
  assert.deepEqual(Object.keys(candidate.installer ?? {}).sort(), ['bytes', 'path', 'sha256']);
  assert.equal(candidate.installer.path, `${FZ3B_HOST_FINAL_RELEASE}/ForgeDesk-${FZ3B_HOST_FINAL_VERSION}-x64-setup.exe`);
  assert.ok(Number.isSafeInteger(candidate.installer.bytes) && candidate.installer.bytes > 0); assert.match(candidate.installer.sha256, SHA);
  const sourcePaths = candidate.sourceFiles.map((item: any) => item.path);
  assert.equal(new Set(sourcePaths).size, sourcePaths.length);
  for (const item of candidate.sourceFiles) {
    assert.match(item.path, /^[A-Za-z0-9._/-]+$/); assert.ok(item.path.split('/').every((part: string) => part && part !== '.' && part !== '..'));
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0); assert.match(item.sha256, SHA);
  }
  for (const required of FZ3B_HOST_FINAL_REQUIRED_SOURCES) assert.equal(sourcePaths.filter((item: string) => item === required).length, 1,
    `Missing ${FZ3B_HOST_FINAL_VERSION} source pin ${required}`);
  return candidate;
}

export async function readFz3bHostFinalEvidence(root: string, relative: string, expectedSha: string, kind: 'success' | 'failure') {
  const expectedPath = kind === 'success' ? FZ3B_HOST_FINAL_SUCCESS_EVIDENCE : FZ3B_HOST_FINAL_FAILURE_EVIDENCE;
  const expectedHash = kind === 'success' ? FZ3B_HOST_FINAL_SUCCESS_SHA256 : FZ3B_HOST_FINAL_FAILURE_SHA256;
  assert.equal(relative, expectedPath); assert.equal(expectedSha, expectedHash);
  const filename = path.join(root, relative); await plainPath(filename); const before = await lstat(filename);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= 2 * 1024 * 1024);
  const bytes = await readFile(filename), after = await lstat(filename);
  assert.ok(after.isFile() && after.nlink === 1 && after.dev === before.dev && after.ino === before.ino && after.size === before.size && bytes.length === before.size);
  const sha256 = createHash('sha256').update(bytes).digest('hex'); assert.equal(sha256, expectedHash);
  const evidence = JSON.parse(bytes.toString('utf8'));
  if (kind === 'success') {
    assert.equal(evidence.scope, 'fz3b-preflight-installed-resume-finish-v1'); assert.equal(evidence.flow, 'resume-finish-only');
    assert.equal(evidence.runId, 'fz3b-preflight-1792238733530-866856');
    assert.equal(evidence.result, 'observed-only-resume-finish'); assert.equal(evidence.candidateSha256, FZ3B_HOST_FINAL_SUCCESS_CANDIDATE_SHA256);
    assert.equal(evidence.previousEvidence?.path, FZ3B_HOST_FINAL_FAILURE_EVIDENCE);
    assert.equal(evidence.previousEvidence?.sha256, FZ3B_HOST_FINAL_FAILURE_SHA256);
    assert.equal(evidence.originalUnknown?.runId, FZ3B_PREFLIGHT_RECOVERY_CASE.runId);
    assert.ok(evidence.originalUnknown?.operations?.some((item: any) => item.id === FZ3B_PREFLIGHT_RECOVERY_CASE.operationId && item.status === 'unknown'));
    const finish = evidence.observations?.find((item: any) => item.stage === 'human-finish-observed');
    assert.equal(finish?.recoveryStatus, 'released'); assert.equal(finish?.completionEvidenceSha256, FZ3B_HOST_FINAL_COMPLETION_SHA256);
    assert.equal(evidence.closes?.some((item: any) => item.index === 1 && item.normalClose === true && item.launcherExitCode === 0), true);
    assert.equal(evidence.observations?.some((item: any) => item.stage === 'human-finish-observed' && item.originalUnknownPreserved === true), true);
  } else {
    assert.equal(evidence.scope, 'fz3b-preflight-installed-recovery-v2');
    assert.equal(evidence.runId, 'fz3b-preflight-1792237043341-b83725');
    assert.equal(evidence.lifecycleProtection?.safeHarnessExit, true);
    assert.match(evidence.failure ?? '', /Native window close did not produce launcher close within 30 seconds/);
    assert.equal(evidence.closes?.some((item: any) => item.index === 1 && item.normalClose === true && item.launcherExitCode === 0), true);
    assert.equal(evidence.lifecycleProtection?.needsHumanClose, true);
  }
  return { filename, evidence, sha256 };
}

export function serializeFz3bHostFinalPlan(plan: Fz3bHostFinalPlan): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  assert.ok(bytes.byteLength <= 512 * 1024, 'Plan exceeds the fixed 512 KiB limit'); return bytes;
}

export async function readFz3bHostFinalInput(filename: string, kind: 'request' | 'plan'): Promise<unknown> {
  const limit = kind === 'request' ? 64 * 1024 : 512 * 1024; await plainPath(filename); const before = await lstat(filename);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= limit, `${kind} must be a plain file <= ${limit} bytes`);
  const bytes = await readFile(filename), after = await lstat(filename);
  assert.ok(after.isFile() && after.nlink === 1 && after.dev === before.dev && after.ino === before.ino && after.size === before.size && bytes.length === before.size);
  assert.ok(bytes.length <= limit); return JSON.parse(bytes.toString('utf8'));
}

async function walkFiles(directory: string): Promise<string[]> {
  await plainPath(directory); const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); await plainPath(file);
    if (entry.isDirectory()) result.push(...await walkFiles(file)); else { assert.ok(entry.isFile()); result.push(file); }
  }
  return result;
}

async function readCandidate(root: string, expectedSha: string) {
  assert.match(expectedSha, SHA, 'A root-reviewed candidate SHA in the request is required');
  const file = path.join(root, FZ3B_HOST_FINAL_CANDIDATE); await plainPath(file); const info = await lstat(file);
  assert.ok(info.isFile() && info.nlink === 1 && info.size <= 2 * 1024 * 1024);
  const bytes = await readFile(file), after = await lstat(file);
  assert.ok(after.isFile() && after.nlink === 1 && after.dev === info.dev && after.ino === info.ino && after.size === info.size);
  const actual = createHash('sha256').update(bytes).digest('hex'); assert.equal(actual, expectedSha);
  const candidate = assertFz3bHostFinalCandidateShape(JSON.parse(bytes.toString('utf8')));
  const config = path.join(root, candidate.builderConfig.path); await plainPath(config); assert.equal(await fileSha256(config), candidate.builderConfig.sha256);
  for (const item of candidate.sourceFiles) {
    const source = path.join(root, item.path); await plainPath(source); const stat = await lstat(source);
    assert.ok(stat.isFile() && stat.nlink === 1); assert.equal(stat.size, item.bytes); assert.equal(await fileSha256(source), item.sha256, `Frozen source changed: ${item.path}`);
  }
  return { file, candidate, sha256: actual };
}

export async function verifyFz3bHostFinalCandidate(root: string, expectedSha: string) {
  const manifest = await readCandidate(root, expectedSha), candidate = manifest.candidate;
  const sourceManifestPath = path.join(root, 'engineering/fz3b/product/resources/manifest.json'); await plainPath(sourceManifestPath);
  const sourceManifestBytes = await readFile(sourceManifestPath);
  assert.equal(createHash('sha256').update(sourceManifestBytes).digest('hex'), candidate.sourceResourceManifestSha256,
    'Source FZ3B resource manifest changed after candidate freeze');
  const sourceManifest = JSON.parse(sourceManifestBytes.toString('utf8'));
  assert.equal(sourceManifest.schemaVersion, 1); assert.equal(sourceManifest.scope, 'fixed-fz3b-product-resources-v1');
  const sourceResourcePaths = sourceManifest.files.map((item: any) => item.path);
  assert.equal(new Set(sourceResourcePaths).size, sourceResourcePaths.length);
  const candidateFz3bResources = candidate.resources.filter((item: any) => item.path.startsWith('resources/fz3b/'));
  const expectedFz3bPaths = ['resources/fz3b/manifest.json', ...sourceResourcePaths.map((item: string) => `resources/fz3b/${item}`)].sort();
  assert.deepEqual(candidateFz3bResources.map((item: any) => item.path).sort(), expectedFz3bPaths,
    'Candidate must pin every resource declared by the exact source manifest, with no extras');
  for (const item of sourceManifest.files) {
    assert.ok(typeof item.path === 'string' && item.path.split('/').every((part: string) => part && part !== '.' && part !== '..'));
    const pinned = candidateFz3bResources.find((entry: any) => entry.path === `resources/fz3b/${item.path}`);
    assert.ok(pinned); assert.equal(pinned.bytes, item.bytes); assert.equal(pinned.sha256, item.sha256);
  }
  const installer = path.join(root, candidate.installer.path); await plainPath(installer); const installerStat = await lstat(installer);
  assert.ok(installerStat.isFile() && installerStat.nlink === 1); assert.equal(installerStat.size, candidate.installer.bytes);
  assert.equal(await fileSha256(installer), candidate.installer.sha256);
  for (const item of candidate.resources) {
    const releaseFile = path.join(root, FZ3B_HOST_FINAL_RELEASE, 'win-unpacked', item.path); await plainPath(releaseFile);
    const stat = await lstat(releaseFile); assert.ok(stat.isFile() && stat.nlink === 1); assert.equal(stat.size, item.bytes);
    assert.equal(await fileSha256(releaseFile), item.sha256, `Unpacked resource changed: ${item.path}`);
  }
  const sourceFz3b = new Set(candidate.resources.filter((item: any) => item.path.startsWith('resources/fz3b/')).map((item: any) => item.path));
  const releaseRoot = path.join(root, FZ3B_HOST_FINAL_RELEASE, 'win-unpacked');
  const unpackedFz3b = new Set((await walkFiles(path.join(releaseRoot, 'resources/fz3b'))).map(file => path.relative(releaseRoot, file).split(path.sep).join('/')));
  assert.deepEqual([...unpackedFz3b].sort(), [...sourceFz3b].sort(), 'Complete unpacked FZ3B tree differs from frozen candidate');
  for (const bundle of FZ3B_HOST_FINAL_BUNDLES) assert.equal(await fileSha256(path.join(root, bundle)), candidate.hostBuildIdentity.bundles[bundle]);
  return { manifest: manifest.file, candidate, sha256: manifest.sha256 };
}

export async function verifyFz3bHostFinalInstalled(root: string, expectedSha: string) {
  const verified = await verifyFz3bHostFinalCandidate(root, expectedSha), checked: Record<string, string> = {};
  for (const item of verified.candidate.resources) {
    const file = path.join(root, 'install', item.path); await plainPath(file); const info = await lstat(file);
    assert.ok(info.isFile() && info.nlink === 1); assert.equal(info.size, item.bytes); assert.equal(await fileSha256(file), item.sha256);
    checked[item.path] = item.sha256;
  }
  const asar = path.join(root, 'install/resources/app.asar'); await plainPath(asar);
  const pkg = JSON.parse(extractFile(asar, fz3bAsarEntryPath('package.json')).toString('utf8'));
  assert.equal(pkg.version, FZ3B_HOST_FINAL_VERSION);
  for (const bundle of FZ3B_HOST_FINAL_BUNDLES) assert.equal(createHash('sha256').update(extractFile(asar, fz3bAsarEntryPath(bundle))).digest('hex'),
    verified.candidate.hostBuildIdentity.bundles[bundle], `Installed ASAR mismatch: ${bundle}`);
  const expectedFz3b = new Set(verified.candidate.resources.filter((item: any) => item.path.startsWith('resources/fz3b/')).map((item: any) => item.path));
  const installedFz3b = new Set((await walkFiles(path.join(root, 'install/resources/fz3b'))).map(file => path.relative(path.join(root, 'install'), file).split(path.sep).join('/')));
  assert.deepEqual([...installedFz3b].sort(), [...expectedFz3b].sort());
  return { manifest: verified.manifest, candidateSha256: verified.sha256, version: verified.candidate.version,
    executableSha256: checked['ForgeDesk.exe'], installerSha256: verified.candidate.installer.sha256, resourceHashes: checked };
}

export async function prepareFz3bHostFinalPlan(root: string, input: unknown, env: NodeJS.ProcessEnv): Promise<Fz3bHostFinalPlan> {
  assertFz3bHostFinalRequest(root, input);
  await readFz3bHostFinalEvidence(root, input.priorSuccessEvidencePath, input.priorSuccessEvidenceSha256, 'success');
  await readFz3bHostFinalEvidence(root, input.priorFailureEvidencePath, input.priorFailureEvidenceSha256, 'failure');
  const installed = await verifyFz3bHostFinalInstalled(root, input.candidateSha256);
  const candidate = (await verifyFz3bHostFinalCandidate(root, input.candidateSha256)).candidate;
  assert.equal(input.runtimeCommit, candidate.gitBaseCommit);
  const plan: Fz3bHostFinalPlan = { ...input, installedExe: path.join(root, 'install/ForgeDesk.exe'),
    installerPath: path.join(root, candidate.installer.path), dataDir: path.join(root, '.runtime/app'),
    executableSha256: installed.executableSha256, installerSha256: installed.installerSha256, resourceHashes: installed.resourceHashes,
    preparedAt: new Date().toISOString(), releaseBinding: { candidatePath: installed.manifest, candidateSha256: installed.candidateSha256,
      supersedesCandidateSha256: candidate.supersedesCandidateSha256, gitBaseCommit: candidate.gitBaseCommit,
      sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit', sourceFiles: candidate.sourceFiles,
      bundles: candidate.hostBuildIdentity.bundles, builderConfigSha256: candidate.builderConfig.sha256 } };
  fz3bHostFinalPlanScope(root, plan, env); return plan;
}

export function fz3bHostFinalPlanScope(root: string, input: unknown, env: NodeJS.ProcessEnv) {
  const plan = input as Fz3bHostFinalPlan;
  assert.deepEqual(Object.keys(plan ?? {}).sort(), ['schemaVersion', 'scope', 'flow', 'version', 'runId', 'runtimeCommit', 'candidateSha256',
    'targetRunId', 'targetOperationId', 'projectRoot', 'priorSuccessEvidencePath', 'priorSuccessEvidenceSha256', 'priorFailureEvidencePath',
    'priorFailureEvidenceSha256', 'nativeOperator', 'installedExe', 'installerPath', 'dataDir', 'executableSha256', 'installerSha256',
    'resourceHashes', 'preparedAt', 'releaseBinding'].sort());
  const { installedExe: _exe, installerPath: _installer, dataDir: _data, executableSha256: _exeHash, installerSha256: _installerHash,
    resourceHashes: _resources, preparedAt: _prepared, releaseBinding: _binding, ...request } = plan;
  assertFz3bHostFinalRequest(root, request); assert.ok(samePath(plan.installedExe, path.join(root, 'install/ForgeDesk.exe')));
  assert.ok(samePath(plan.installerPath, path.join(root, `${FZ3B_HOST_FINAL_RELEASE}/ForgeDesk-${FZ3B_HOST_FINAL_VERSION}-x64-setup.exe`)));
  assert.ok(samePath(plan.dataDir, path.join(root, '.runtime/app')));
  const output = path.join(root, FZ3B_HOST_FINAL_OUTPUT, 'runs', plan.runId);
  for (const [left, right] of [[plan.projectRoot, plan.dataDir], [plan.projectRoot, path.dirname(plan.installedExe)], [plan.projectRoot, output], [output, plan.dataDir]]) {
    assert.equal(inside(left, right) || inside(right, left), false);
  }
  for (const [key, value] of Object.entries(env)) if (value && (/^(?:FORGEDESK_DATA_DIR|CODEX_HOME|ELECTRON_RUN_AS_NODE)$/i.test(key) ||
    /^FORGEDESK_(?:FZ3B|T2|HARDWARE_AGENT|SNAPSHOT)_/i.test(key))) assert.fail(`Remove ambient acceptance override: ${key}`);
  for (const digest of [plan.executableSha256, plan.installerSha256]) assert.match(digest, SHA);
  assert.ok(plan.resourceHashes?.['resources/fz3b/manifest.json']);
  for (const [relative, hash] of Object.entries(plan.resourceHashes)) {
    assert.ok(relative === 'ForgeDesk.exe' || /^resources\/[A-Za-z0-9._/-]+$/.test(relative));
    assert.ok(relative.split('/').every(part => part && part !== '.' && part !== '..')); assert.match(hash, SHA);
  }
  const binding = plan.releaseBinding; assert.ok(binding);
  assert.deepEqual(Object.keys(binding).sort(), ['candidatePath', 'candidateSha256', 'supersedesCandidateSha256', 'gitBaseCommit',
    'sourceIdentity', 'sourceFiles', 'bundles', 'builderConfigSha256'].sort());
  assert.ok(samePath(binding.candidatePath, path.join(root, FZ3B_HOST_FINAL_CANDIDATE)));
  assert.equal(binding.candidateSha256, plan.candidateSha256); assert.equal(binding.supersedesCandidateSha256, FZ3B_HOST_FINAL_SUPERSEDES);
  assert.equal(binding.sourceIdentity, 'captured-file-hashes-not-exact-runtime-commit'); assert.match(binding.gitBaseCommit, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(binding.bundles).sort(), [...FZ3B_HOST_FINAL_BUNDLES].sort());
  assert.match(binding.builderConfigSha256, SHA); assert.ok(Number.isFinite(Date.parse(plan.preparedAt)));
  return { root, plan, output };
}

export async function verifyFz3bHostFinalPlanBytes(root: string, plan: Fz3bHostFinalPlan) {
  fz3bHostFinalPlanScope(root, plan, {});
  const current = await prepareFz3bHostFinalPlan(root, { schemaVersion: plan.schemaVersion, scope: plan.scope, flow: plan.flow,
    version: plan.version, runId: plan.runId, runtimeCommit: plan.runtimeCommit, candidateSha256: plan.candidateSha256,
    targetRunId: plan.targetRunId, targetOperationId: plan.targetOperationId, projectRoot: plan.projectRoot,
    priorSuccessEvidencePath: plan.priorSuccessEvidencePath, priorSuccessEvidenceSha256: plan.priorSuccessEvidenceSha256,
    priorFailureEvidencePath: plan.priorFailureEvidencePath, priorFailureEvidenceSha256: plan.priorFailureEvidenceSha256,
    nativeOperator: plan.nativeOperator }, {});
  assert.deepEqual(current.releaseBinding, plan.releaseBinding); assert.deepEqual(current.resourceHashes, plan.resourceHashes);
  assert.equal(current.executableSha256, plan.executableSha256); assert.equal(current.installerSha256, plan.installerSha256);
  return current;
}

export async function createFz3bHostFinalRunOutput(root: string, runId: string): Promise<string> {
  assert.ok(path.isAbsolute(root)); assert.match(runId, /^fz3b-host-final-\d{13}-[a-f0-9]{6}$/);
  const runs = path.join(root, FZ3B_HOST_FINAL_OUTPUT, 'runs'), output = path.join(runs, runId);
  await plainPath(runs); await mkdir(runs, { recursive: true }); await plainPath(runs);
  assert.ok((await lstat(runs)).isDirectory()); await mkdir(output, { recursive: false }); await plainPath(output);
  assert.ok((await lstat(output)).isDirectory()); return output;
}

export function fz3bHostFinalLaunchEnvironment(source: NodeJS.ProcessEnv, dataDir: string): Record<string, string> {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)', 'USERNAME', 'USERDOMAIN', 'SESSIONNAME',
    'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP']);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string' && allowed.has(key.toUpperCase())) env[key] = value;
  return { ...env, FORGEDESK_DATA_DIR: dataDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
}
