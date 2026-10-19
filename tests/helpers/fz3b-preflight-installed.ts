import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';
import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileSha256, inside, plainPath, samePath } from './embedded-installed';
import { snapshotReleaseResources } from './snapshot-installed-release';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from '../../packages/engineering-runner/fz3b/preflight-recovery';

export const FZ3B_PHASE3_OUTPUT = 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/revision-0.5.3';
export const FZ3B_PHASE3_RELEASE = `${FZ3B_PHASE3_OUTPUT}/release`;
export const FZ3B_PHASE3_CANDIDATE = `${FZ3B_PHASE3_OUTPUT}/release-candidate-0.5.3-resume-finish-json.json`;
export const FZ3B_PHASE3_VERSION = '0.5.3';
export const FZ3B_PHASE3_SUPERSEDES = '908d6fb059b2f7495658fd4de86dd63814dfae6dbb51c749f5c6d499d76f0c58';
export const FZ3B_PREVIOUS_EVIDENCE = 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/revision-0.5.3/runs/fz3b-preflight-1792237043341-b83725/evidence.json';
export const FZ3B_PREVIOUS_EVIDENCE_SHA256 = '77affe796d4c0ca692abc5688b452ddb36539875517d987f53f4def1343190d6';
export const FZ3B_PREVIOUS_EVIDENCE_CANDIDATE_SHA256 = '908d6fb059b2f7495658fd4de86dd63814dfae6dbb51c749f5c6d499d76f0c58';
export const FZ3B_PREFLIGHT_REQUEST_MAX_BYTES = 64 * 1024;
export const FZ3B_PREFLIGHT_PLAN_MAX_BYTES = 512 * 1024;
export const FZ3B_PHASE3_BUNDLES = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.js', 'dist/renderer/index.css',
  'dist/renderer/index.html', 'dist/mcp/index.cjs'] as const;
const SHA = /^[a-f0-9]{64}$/;
export const FZ3B_PHASE3_REQUIRED_SOURCES = [
  'apps/desktop/main/index.ts', 'apps/desktop/preload/index.ts', 'packages/engineering-runner/fz3b/types.ts',
  'apps/desktop/main/fz3b-agent.ts', 'apps/desktop/main/fz3b-recovery-approval.ts', 'apps/desktop/main/native-dialogs.ts',
  'apps/desktop/renderer/FZ3BPanel.tsx', 'packages/engineering-runner/fz3b/preflight-refusal-proof.ts',
  'packages/engineering-runner/fz3b/preflight-recovery.ts', 'packages/engineering-runner/fz3b/preflight-recovery-worker.ts',
  'packages/engineering-runner/fz3b/reconciliation-worker.ts', 'packages/engineering-runner/fz3b/backend.ts',
  'packages/engineering-runner/fz3b/worker.ts', 'scripts/build.mjs', 'package.json', 'package-lock.json',
  `${FZ3B_PHASE3_OUTPUT}/builder.config.cjs`, `${FZ3B_PHASE3_OUTPUT}/record-candidate.ts`,
  'tests/helpers/fz3b-preflight-installed.ts', 'tests/helpers/fz3b-preflight-native-observer.ts',
  'tests/helpers/fz3b-preflight-native-observer.test.ts', 'tests/fz3b-preflight-installed-smoke.ts',
  'tests/helpers/fz3b-preflight-installed.test.ts', 'tests/helpers/fz3b-preflight-observation.ts',
  'tests/helpers/fz3b-preflight-observation.test.ts', 'tests/helpers/phase3-source-inventory.ts',
  'tests/helpers/phase3-source-inventory.test.ts',
] as const;

export function fz3bAsarEntryPath(relative: string): string {
  assert.ok(relative && !path.isAbsolute(relative) && relative.split(/[\\/]/).every(part => part && part !== '.' && part !== '..'));
  return path.normalize(relative);
}

export interface Fz3bPreflightRequest {
  schemaVersion: 2; scope: 'fz3b-preflight-installed-resume-finish-v1'; flow: 'resume-finish-only';
  previousEvidencePath: string; previousEvidenceSha256: string; version: '0.5.3'; runId: string;
  runtimeCommit: string; candidateSha256: string; targetRunId: string; targetOperationId: string;
  projectRoot: string; nativeOperator: 'coordinator-delegated-visible-ui';
}
export interface Fz3bPreflightPlan extends Fz3bPreflightRequest {
  installedExe: string; installerPath: string; dataDir: string; executableSha256: string; installerSha256: string;
  resourceHashes: Record<string, string>; preparedAt: string;
  releaseBinding: { candidatePath: string; candidateSha256: string; supersedesCandidateSha256: string; gitBaseCommit: string;
    sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit'; sourceFiles: Array<{ path: string; bytes: number; sha256: string }>;
    bundles: Record<string, string>; builderConfigSha256: string };
}

export function assertFz3bPreflightCandidateShape(candidate: any) {
  assert.equal(candidate?.schemaVersion, 1); assert.equal(candidate.scope, 'unsigned-phase3-release-candidate');
  assert.equal(candidate.version, FZ3B_PHASE3_VERSION); assert.equal(candidate.sourceIdentity, 'captured-file-hashes-not-exact-runtime-commit');
  assert.equal(candidate.supersedesCandidateSha256, FZ3B_PHASE3_SUPERSEDES);
  assert.equal(candidate.builderConfig?.path, `${FZ3B_PHASE3_OUTPUT}/builder.config.cjs`);
  assert.equal(candidate.builderConfig.output, FZ3B_PHASE3_RELEASE); assert.equal(candidate.builderConfig.nsisRunAfterFinish, false);
  assert.match(candidate.builderConfig.sha256, SHA); assert.match(candidate.sourceResourceManifestSha256, SHA);
  assert.match(candidate.gitBaseCommit, /^[a-f0-9]{40}$/); assert.equal(candidate.workingTreeContainsUncommittedChanges, true);
  assert.deepEqual(Object.keys(candidate.hostBuildIdentity?.bundles ?? {}).sort(), [...FZ3B_PHASE3_BUNDLES].sort());
  assert.equal(candidate.hostBuildIdentity.script, 'scripts/build.mjs'); assert.equal(candidate.hostBuildIdentity.version, FZ3B_PHASE3_VERSION);
  for (const hash of Object.values(candidate.hostBuildIdentity.bundles)) assert.match(hash as string, SHA);
  assert.deepEqual(candidate.resources.filter((item: any) => snapshotReleaseResources.includes(item.path)).map((item: any) => item.path).sort(),
    [...snapshotReleaseResources].sort());
  const resourcePaths = candidate.resources.map((item: any) => item.path);
  assert.equal(new Set(resourcePaths).size, resourcePaths.length, 'Release resource inventory must not contain duplicates');
  assert.ok(resourcePaths.includes('ForgeDesk.exe') && resourcePaths.includes('resources/app.asar'), 'Candidate must pin the installed executable and ASAR');
  assert.ok(resourcePaths.includes('resources/fz3b/manifest.json'));
  for (const entry of candidate.resources) {
    assert.ok(entry.path === 'ForgeDesk.exe' || /^resources\/[A-Za-z0-9._/-]+$/.test(entry.path));
    assert.ok(entry.path.split('/').every((part: string) => part && part !== '.' && part !== '..'));
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0); assert.match(entry.sha256, SHA);
  }
  assert.deepEqual(Object.keys(candidate.installer ?? {}).sort(), ['bytes', 'path', 'sha256']);
  assert.equal(candidate.installer.path, `${FZ3B_PHASE3_RELEASE}/ForgeDesk-${FZ3B_PHASE3_VERSION}-x64-setup.exe`);
  assert.ok(Number.isSafeInteger(candidate.installer.bytes) && candidate.installer.bytes > 0); assert.match(candidate.installer.sha256, SHA);
  assert.ok(Array.isArray(candidate.sourceFiles) && candidate.sourceFiles.length > 0);
  const sourcePaths = candidate.sourceFiles.map((item: any) => item.path);
  assert.equal(new Set(sourcePaths).size, sourcePaths.length, 'Source inventory must not contain duplicates');
  for (const item of candidate.sourceFiles) {
    assert.match(item.path, /^[A-Za-z0-9._/-]+$/); assert.ok(item.path.split('/').every((part: string) => part && part !== '.' && part !== '..'));
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0); assert.match(item.sha256, SHA);
  }
  for (const item of FZ3B_PHASE3_REQUIRED_SOURCES) assert.equal(sourcePaths.filter((value: string) => value === item).length, 1, `Missing phase3 source pin ${item}`);
  return candidate;
}

export function assertFz3bPreflightRequest(root: string, value: unknown): asserts value is Fz3bPreflightRequest {
  const request = value as Fz3bPreflightRequest;
  assert.equal(request?.schemaVersion, 2); assert.equal(request.scope, 'fz3b-preflight-installed-resume-finish-v1');
  assert.equal(request.flow, 'resume-finish-only');
  assert.equal(request.previousEvidencePath, FZ3B_PREVIOUS_EVIDENCE);
  assert.equal(request.previousEvidenceSha256, FZ3B_PREVIOUS_EVIDENCE_SHA256);
  assert.equal(request.version, FZ3B_PHASE3_VERSION);
  assert.deepEqual(Object.keys(request).sort(), ['schemaVersion', 'scope', 'flow', 'previousEvidencePath', 'previousEvidenceSha256',
    'version', 'runId', 'runtimeCommit', 'candidateSha256', 'targetRunId', 'targetOperationId', 'projectRoot', 'nativeOperator'].sort());
  assert.match(request.runId, /^fz3b-preflight-\d{13}-[a-f0-9]{6}$/); assert.match(request.runtimeCommit, /^[a-f0-9]{40}$/);
  assert.match(request.candidateSha256, SHA);
  assert.equal(request.targetRunId, FZ3B_PREFLIGHT_RECOVERY_CASE.runId); assert.equal(request.targetOperationId, FZ3B_PREFLIGHT_RECOVERY_CASE.operationId);
  assert.equal(request.nativeOperator, 'coordinator-delegated-visible-ui');
  assert.ok(path.isAbsolute(root) && path.isAbsolute(request.projectRoot) && inside(path.join(root, 'output/hardware'), request.projectRoot));
}

export async function verifyFz3bPreviousEvidence(root: string, relative = FZ3B_PREVIOUS_EVIDENCE, expectedSha256 = FZ3B_PREVIOUS_EVIDENCE_SHA256) {
  assert.equal(relative, FZ3B_PREVIOUS_EVIDENCE, 'Resume evidence path must be the approved prior run');
  assert.equal(expectedSha256, FZ3B_PREVIOUS_EVIDENCE_SHA256, 'Resume evidence requires the externally approved SHA');
  const file = path.join(root, relative); await plainPath(file); const info = await lstat(file);
  assert.ok(info.isFile() && info.nlink === 1 && info.size <= 2 * 1024 * 1024);
  const bytes = await readFile(file), after = await lstat(file);
  assert.ok(after.isFile() && after.nlink === 1 && after.dev === info.dev && after.ino === info.ino && after.size === info.size && bytes.byteLength === info.size,
    'Previous evidence changed while being read');
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(actualSha256, expectedSha256, 'Previous actual evidence changed');
  const evidence = JSON.parse(bytes.toString('utf8'));
  assert.equal(evidence.runId, 'fz3b-preflight-1792237043341-b83725');
  assert.equal(evidence.candidateSha256, FZ3B_PREVIOUS_EVIDENCE_CANDIDATE_SHA256);
  assert.equal(evidence.originalUnknown?.runId, FZ3B_PREFLIGHT_RECOVERY_CASE.runId);
  assert.ok(evidence.originalUnknown?.operations?.some((item: any) => item.id === FZ3B_PREFLIGHT_RECOVERY_CASE.operationId && item.status === 'unknown'));
  const initial = evidence.initialRecovery;
  assert.equal(initial?.status, 'released'); assert.equal(initial?.native?.realDialogForwarded, true);
  assert.equal(initial?.native?.synthesizedResponse, false); assert.equal(initial?.native?.nativeDialogCount, 1);
  assert.equal(initial?.proofPresent, true); assert.equal(initial?.finalizationPresent, true);
  assert.equal(initial?.acknowledgmentPresent, true); assert.equal(initial?.workerClosurePresent, true);
  assert.match(initial?.completionEvidenceSha256 ?? '', SHA);
  assert.ok(evidence.observations?.some((item: any) => item.stage === 'restart-reheld'));
  assert.ok(evidence.closes?.some((item: any) => item.index === 1 && item.normalClose === true && item.launcherExitCode === 0));
  assert.match(evidence.failure ?? '', /Native window close did not produce launcher close within 30 seconds; no force-close was attempted/);
  assert.ok(evidence.closes?.every((item: any) => item.forcedKill === false));
  assert.equal(evidence.lifecycleProtection?.safeHarnessExit, true);
  assert.equal(evidence.lifecycleProtection?.needsHumanClose, true);
  return { file, evidence, sha256: actualSha256 };
}

export function serializeFz3bPreflightPlan(plan: Fz3bPreflightPlan): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  assert.ok(bytes.byteLength <= FZ3B_PREFLIGHT_PLAN_MAX_BYTES, `Plan exceeds ${FZ3B_PREFLIGHT_PLAN_MAX_BYTES} bytes`);
  return bytes;
}

export async function readFz3bPreflightInput(filename: string, kind: 'request' | 'plan'): Promise<unknown> {
  const limit = kind === 'request' ? FZ3B_PREFLIGHT_REQUEST_MAX_BYTES : FZ3B_PREFLIGHT_PLAN_MAX_BYTES;
  await plainPath(filename); const before = await lstat(filename);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= limit, `${kind} must be a plain file no larger than ${limit} bytes`);
  const bytes = await readFile(filename); const after = await lstat(filename);
  assert.ok(after.isFile() && after.nlink === 1 && after.dev === before.dev && after.ino === before.ino && after.size === before.size && bytes.byteLength === before.size,
    `${kind} changed while being read`);
  assert.ok(bytes.byteLength <= limit, `${kind} exceeds ${limit} bytes`);
  return JSON.parse(bytes.toString('utf8'));
}

export async function createFz3bPreflightRunOutput(root: string, runId: string): Promise<string> {
  assert.ok(path.isAbsolute(root)); assert.match(runId, /^fz3b-preflight-\d{13}-[a-f0-9]{6}$/);
  const runs = path.join(root, FZ3B_PHASE3_OUTPUT, 'runs'), output = path.join(runs, runId);
  await plainPath(runs); await mkdir(runs, { recursive: true }); await plainPath(runs);
  assert.ok((await lstat(runs)).isDirectory(), 'Runs parent must be a plain directory');
  await mkdir(output, { recursive: false }); await plainPath(output);
  assert.ok((await lstat(output)).isDirectory(), 'Run output must be a newly created plain directory');
  return output;
}

async function candidateFromDisk(root: string, expectedCandidateSha256: string) {
  assert.match(expectedCandidateSha256, SHA, 'A root-reviewed external candidate SHA pin is required');
  const manifest = path.join(root, FZ3B_PHASE3_CANDIDATE); await plainPath(manifest);
  const stat = await lstat(manifest); assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 2 * 1024 * 1024);
  const candidateSha256 = await fileSha256(manifest);
  assert.equal(candidateSha256, expectedCandidateSha256, 'Candidate differs from the root-reviewed external SHA pin');
  const candidate = assertFz3bPreflightCandidateShape(JSON.parse(await readFile(manifest, 'utf8')));
  const config = path.join(root, candidate.builderConfig.path); await plainPath(config);
  assert.equal(await fileSha256(config), candidate.builderConfig.sha256, 'Builder config changed after candidate recording');
  for (const source of candidate.sourceFiles) {
    const file = path.join(root, source.path); await plainPath(file); const info = await lstat(file);
    assert.ok(info.isFile() && info.nlink === 1); assert.equal(info.size, source.bytes); assert.equal(await fileSha256(file), source.sha256, `Source changed after freeze: ${source.path}`);
  }
  return { manifest, candidate, candidateSha256 };
}

export async function verifyFz3bPreflightCandidate(root: string, expectedCandidateSha256: string) {
  const captured = await candidateFromDisk(root, expectedCandidateSha256); const candidate = captured.candidate;
  const installerPath = path.join(root, candidate.installer.path); await plainPath(installerPath);
  const installerStat = await lstat(installerPath); assert.ok(installerStat.isFile() && installerStat.nlink === 1);
  assert.equal(installerStat.size, candidate.installer.bytes); assert.equal(await fileSha256(installerPath), candidate.installer.sha256);
  for (const item of candidate.resources) {
    const unpackedPath = path.join(root, FZ3B_PHASE3_RELEASE, 'win-unpacked', item.path); await plainPath(unpackedPath);
    const info = await lstat(unpackedPath); assert.ok(info.isFile() && info.nlink === 1);
    assert.equal(info.size, item.bytes); assert.equal(await fileSha256(unpackedPath), item.sha256, `Unpacked release mismatch: ${item.path}`);
  }
  const pinnedFz3b = new Set(candidate.resources.filter((item: any) => item.path.startsWith('resources/fz3b/')).map((item: any) => item.path));
  const unpackedFz3b = new Set((await walkFiles(path.join(root, FZ3B_PHASE3_RELEASE, 'win-unpacked/resources/fz3b')))
    .map(file => path.relative(path.join(root, FZ3B_PHASE3_RELEASE, 'win-unpacked'), file).split(path.sep).join('/')));
  assert.deepEqual([...unpackedFz3b].sort(), [...pinnedFz3b].sort(), 'Unpacked FZ3B tree differs from the entire pinned release inventory');
  for (const bundle of FZ3B_PHASE3_BUNDLES) {
    const file = path.join(root, bundle); await plainPath(file);
    assert.equal(await fileSha256(file), candidate.hostBuildIdentity.bundles[bundle], `Host build changed after candidate recording: ${bundle}`);
  }
  return { manifest: captured.manifest, candidateSha256: captured.candidateSha256, candidate };
}

export async function verifyFz3bPreflightInstalled(root: string, executable: string, expectedCandidateSha256: string) {
  assert.ok(samePath(executable, path.join(root, 'install/ForgeDesk.exe')));
  const { manifest, candidateSha256, candidate } = await verifyFz3bPreflightCandidate(root, expectedCandidateSha256);
  const checked = [];
  for (const item of candidate.resources) {
    const file = path.join(root, 'install', item.path); await plainPath(file); const stat = await lstat(file);
    assert.ok(stat.isFile() && stat.nlink === 1); assert.equal(stat.size, item.bytes); assert.equal(await fileSha256(file), item.sha256, `Installed candidate mismatch: ${item.path}`);
    const unpacked = path.join(root, FZ3B_PHASE3_RELEASE, 'win-unpacked', item.path); await plainPath(unpacked);
    assert.equal(await fileSha256(unpacked), item.sha256, `Unpacked candidate mismatch: ${item.path}`);
    checked.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 });
  }
  const exe = await lstat(executable); assert.ok(exe.isFile() && exe.nlink === 1);
  const exeHash = await fileSha256(executable);
  const asarPath = path.join(root, 'install/resources/app.asar'); await plainPath(asarPath);
  const packageInfo = JSON.parse(extractFile(asarPath, fz3bAsarEntryPath('package.json')).toString('utf8'));
  assert.equal(packageInfo.version, FZ3B_PHASE3_VERSION);
  for (const bundle of FZ3B_PHASE3_BUNDLES) {
    assert.equal(createHash('sha256').update(extractFile(asarPath, fz3bAsarEntryPath(bundle))).digest('hex'), candidate.hostBuildIdentity.bundles[bundle], `Installed ASAR bundle mismatch: ${bundle}`);
  }
  const expectedFz3b = new Set(candidate.resources.filter((item: any) => item.path.startsWith('resources/fz3b/')).map((item: any) => item.path));
  const actualFz3b = new Set((await walkFiles(path.join(root, 'install/resources/fz3b'))).map(file => path.relative(path.join(root, 'install'), file).split(path.sep).join('/')));
  assert.deepEqual([...actualFz3b].sort(), [...expectedFz3b].sort(), 'Installed FZ3B resource tree differs from pinned candidate');
  return { manifest, candidateSha256, version: candidate.version, executableSha256: exeHash,
    installerSha256: candidate.installer.sha256, resourceHashes: Object.fromEntries(checked.map(item => [item.path, item.sha256])), checked };
}

export async function prepareFz3bPreflightPlan(root: string, value: unknown, env: NodeJS.ProcessEnv): Promise<Fz3bPreflightPlan> {
  assertFz3bPreflightRequest(root, value);
  await verifyFz3bPreviousEvidence(root, value.previousEvidencePath, value.previousEvidenceSha256);
  const installed = await verifyFz3bPreflightInstalled(root, path.join(root, 'install/ForgeDesk.exe'), value.candidateSha256);
  const candidate = (await verifyFz3bPreflightCandidate(root, value.candidateSha256)).candidate;
  assert.equal(value.runtimeCommit, candidate.gitBaseCommit, 'Request must bind the candidate source base');
  const plan: Fz3bPreflightPlan = { ...value, installedExe: path.join(root, 'install/ForgeDesk.exe'),
    installerPath: path.join(root, candidate.installer.path), dataDir: path.join(root, '.runtime/app'),
    executableSha256: installed.executableSha256, installerSha256: installed.installerSha256,
    resourceHashes: installed.resourceHashes, preparedAt: new Date().toISOString(), releaseBinding: {
      candidatePath: installed.manifest, candidateSha256: installed.candidateSha256,
      supersedesCandidateSha256: candidate.supersedesCandidateSha256, gitBaseCommit: candidate.gitBaseCommit,
      sourceIdentity: 'captured-file-hashes-not-exact-runtime-commit', sourceFiles: candidate.sourceFiles,
      bundles: candidate.hostBuildIdentity.bundles, builderConfigSha256: candidate.builderConfig.sha256,
    } };
  fz3bPreflightPlanScope(root, plan, env);
  return plan;
}

export async function verifyFz3bPreflightPlanBytes(root: string, plan: Fz3bPreflightPlan) {
  fz3bPreflightPlanScope(root, plan, {});
  const current = await prepareFz3bPreflightPlan(root, { schemaVersion: plan.schemaVersion, scope: plan.scope,
    flow: plan.flow, previousEvidencePath: plan.previousEvidencePath, previousEvidenceSha256: plan.previousEvidenceSha256,
    version: plan.version, runId: plan.runId, runtimeCommit: plan.runtimeCommit, candidateSha256: plan.candidateSha256,
    targetRunId: plan.targetRunId, targetOperationId: plan.targetOperationId, projectRoot: plan.projectRoot,
    nativeOperator: plan.nativeOperator }, {});
  assert.deepEqual(current.releaseBinding, plan.releaseBinding, 'Frozen candidate/source binding changed after plan preparation');
  assert.deepEqual(current.resourceHashes, plan.resourceHashes, 'Installed release resources changed after plan preparation');
  assert.equal(current.executableSha256, plan.executableSha256); assert.equal(current.installerSha256, plan.installerSha256);
  return current;
}

async function walkFiles(directory: string): Promise<string[]> {
  await plainPath(directory); const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); await plainPath(file);
    if (entry.isDirectory()) result.push(...await walkFiles(file)); else { assert.ok(entry.isFile()); result.push(file); }
  }
  return result;
}

export function fz3bPreflightPlanScope(root: string, value: unknown, env: NodeJS.ProcessEnv) {
  const plan = value as Fz3bPreflightPlan;
  assert.deepEqual(Object.keys(plan ?? {}).sort(), ['schemaVersion', 'scope', 'flow', 'previousEvidencePath', 'previousEvidenceSha256',
    'version', 'runId', 'runtimeCommit', 'candidateSha256', 'targetRunId', 'targetOperationId', 'projectRoot', 'nativeOperator', 'installedExe', 'installerPath', 'dataDir', 'executableSha256', 'installerSha256',
    'resourceHashes', 'preparedAt', 'releaseBinding'].sort(), 'Plan keys must be exact');
  const { installedExe: _exe, installerPath: _installer, dataDir: _data, executableSha256: _exeHash, installerSha256: _installerHash,
    resourceHashes: _resources, preparedAt: _prepared, releaseBinding: _binding, ...request } = plan;
  assertFz3bPreflightRequest(root, request);
  assert.ok(samePath(plan.installedExe, path.join(root, 'install/ForgeDesk.exe')));
  assert.ok(samePath(plan.installerPath, path.join(root, `${FZ3B_PHASE3_RELEASE}/ForgeDesk-${FZ3B_PHASE3_VERSION}-x64-setup.exe`)));
  assert.ok(samePath(plan.dataDir, path.join(root, '.runtime/app')), 'Use existing official product data home only');
  const output = path.join(root, FZ3B_PHASE3_OUTPUT, 'runs', plan.runId);
  for (const [left, right] of [[plan.projectRoot, plan.dataDir], [plan.projectRoot, path.dirname(plan.installedExe)], [plan.projectRoot, output], [output, plan.dataDir]]) {
    assert.equal(inside(left, right) || inside(right, left), false);
  }
  for (const [key, entry] of Object.entries(env)) if (entry && (/^(?:FORGEDESK_DATA_DIR|CODEX_HOME|ELECTRON_RUN_AS_NODE)$/i.test(key) || /^FORGEDESK_(?:FZ3B|T2|HARDWARE_AGENT|SNAPSHOT)_/i.test(key))) {
    assert.fail(`Remove ambient acceptance override: ${key}`);
  }
  for (const digest of [plan.executableSha256, plan.installerSha256]) assert.match(digest, SHA);
  assert.ok(plan.resourceHashes && plan.resourceHashes['resources/fz3b/manifest.json']);
  for (const [relative, digest] of Object.entries(plan.resourceHashes)) {
    assert.ok(relative === 'ForgeDesk.exe' || /^resources\/[A-Za-z0-9._/-]+$/.test(relative));
    assert.ok(relative.split('/').every(part => part && part !== '.' && part !== '..')); assert.match(digest, SHA);
  }
  const binding = plan.releaseBinding; assert.ok(binding);
  assert.deepEqual(Object.keys(binding).sort(), ['candidatePath', 'candidateSha256', 'supersedesCandidateSha256', 'gitBaseCommit',
    'sourceIdentity', 'sourceFiles', 'bundles', 'builderConfigSha256'].sort(), 'Candidate binding keys must be exact');
  assert.ok(samePath(binding.candidatePath, path.join(root, FZ3B_PHASE3_CANDIDATE)));
  assert.match(binding.candidateSha256, SHA); assert.equal(binding.candidateSha256, plan.candidateSha256);
  assert.equal(binding.supersedesCandidateSha256, FZ3B_PHASE3_SUPERSEDES);
  assert.match(binding.gitBaseCommit, /^[a-f0-9]{40}$/); assert.equal(binding.sourceIdentity, 'captured-file-hashes-not-exact-runtime-commit');
  assert.match(binding.builderConfigSha256, SHA); assert.deepEqual(Object.keys(binding.bundles).sort(), [...FZ3B_PHASE3_BUNDLES].sort());
  for (const digest of Object.values(binding.bundles)) assert.match(digest, SHA);
  assert.ok(Array.isArray(binding.sourceFiles) && binding.sourceFiles.length > 0);
  for (const file of binding.sourceFiles) { assert.match(file.sha256, SHA); assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0); }
  assert.ok(Number.isFinite(Date.parse(plan.preparedAt)));
  return { root, plan, output };
}

export function fz3bPreflightLaunchEnvironment(source: NodeJS.ProcessEnv, dataDir: string): Record<string, string> {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)', 'USERNAME', 'USERDOMAIN', 'SESSIONNAME',
    'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP']);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string' && allowed.has(key.toUpperCase())) env[key] = value;
  return { ...env, FORGEDESK_DATA_DIR: dataDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
}
