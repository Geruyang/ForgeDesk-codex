import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import type { EmbeddedOperation, EmbeddedStatus } from '../../packages/engineering-runner/embedded/types';

export interface EmbeddedInstalledPlan {
  schemaVersion: 1;
  scope: 'user-driven-fixed-target-installed-T2';
  runId: string;
  version: string;
  runtimeCommit: string;
  installedExe: string;
  installerPath: string;
  installerSha256: string;
  executableSha256: string;
  projectRoot: string;
  keilExecutable: string;
  resourceHashes: Record<string, string>;
  expectedProfile: { id: string; sha256: string; probeSerial: string; uid: string; chipId: number; flashKiB: number; cdcSerial: string };
  artifactTamperPreflight: boolean;
}
export interface EmbeddedInstalledScope {
  root: string; runtime: string; dataDir: string; output: string; plan: EmbeddedInstalledPlan;
}
const coreResources = ['resources/app.asar', 'resources/codex/codex.exe', 'resources/codex/codex-code-mode-host.exe',
  'resources/codex/codex-command-runner.exe', 'resources/codex/codex-windows-sandbox-setup.exe', 'resources/process-host/process-host.exe'];
export function inside(base: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export function samePath(left: string, right: string): boolean { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function sha(value: unknown, label: string): asserts value is string { assert.equal(typeof value, 'string', label); assert.match(value as string, /^[a-f0-9]{64}$/i, label); }
function disjoint(left: string, right: string) { assert.equal(inside(left, right) || inside(right, left), false, 'T2 project, runtime, output and installation must be disjoint'); }

// This plan is an operator-reviewed test input, never an authorization to flash.
export function deriveEmbeddedInstalledScope(root: string, value: unknown, environment: NodeJS.ProcessEnv): EmbeddedInstalledScope {
  assert.ok(path.isAbsolute(root), 'Repository root must be absolute');
  const plan = value as EmbeddedInstalledPlan;
  assert.equal(plan?.schemaVersion, 1); assert.equal(plan.scope, 'user-driven-fixed-target-installed-T2');
  assert.match(plan.runId, /^t2-\d{13}-[a-z0-9]{4,12}$/);
  assert.equal(plan.version, '0.3.4', 'This harness accepts only the reviewed T2 release'); assert.match(plan.runtimeCommit, /^[a-f0-9]{40}$/i);
  for (const key of ['FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE']) assert.ok(!environment[key], `Remove ambient ${key}; T2 scope must not reuse a credential home`);
  for (const [key, item] of Object.entries(environment)) if (key.startsWith('FORGEDESK_T2_') && item) {
    assert.ok(key === 'FORGEDESK_T2_NATIVE_OPERATOR' && item === 'delegated-ui', `Unsupported T2 environment override: ${key}`);
  }
  for (const [label, filename] of Object.entries({ installedExe: plan.installedExe, installerPath: plan.installerPath, projectRoot: plan.projectRoot })) {
    assert.equal(typeof filename, 'string', label); assert.ok(path.isAbsolute(filename), `${label} must be absolute`);
    assert.ok(inside(root, filename) && !samePath(root, filename), `${label} escapes the repository`);
  }
  assert.equal(path.basename(plan.installedExe).toLowerCase(), 'forgedesk.exe');
  assert.ok(inside(path.join(root, 'output/hardware'), plan.projectRoot), 'Use only the root-prepared T2 project copy, never a private runtime or user project');
  assert.equal(path.extname(plan.installerPath).toLowerCase(), '.exe');
  assert.ok(path.isAbsolute(plan.keilExecutable), 'Keil must use a reviewed absolute path');
  assert.equal(samePath(plan.keilExecutable, 'D:/STSoft/Keil5/UV4/UV4.exe'), true, 'The UI uses the fixed reviewed Keil path, not an override');
  sha(plan.installerSha256, 'Installer SHA-256'); sha(plan.executableSha256, 'Installed executable SHA-256');
  assert.ok(plan.resourceHashes && typeof plan.resourceHashes === 'object' && !Array.isArray(plan.resourceHashes));
  for (const required of coreResources) assert.ok(Object.hasOwn(plan.resourceHashes, required), `Missing core resource pin: ${required}`);
  for (const required of ['resources/hardware/python/python.exe', 'resources/hardware/manifest.json', 'resources/hardware-worker.py']) assert.ok(Object.hasOwn(plan.resourceHashes, required), `Missing hardware resource pin: ${required}`);
  assert.ok(Object.keys(plan.resourceHashes).some(filename => filename.startsWith('resources/templates/gesturescreen-v1/')), 'Plan must pin the packaged firmware template');
  for (const [relative, hash] of Object.entries(plan.resourceHashes)) {
    assert.match(relative, /^resources\/[a-zA-Z0-9._/-]+$/); assert.ok(!relative.split('/').some(part => part === '..' || part === '.' || !part));
    sha(hash, `Resource SHA-256: ${relative}`);
  }
  assert.equal(plan.expectedProfile?.id, 'gesturescreen-challenger-v1'); sha(plan.expectedProfile.sha256, 'Profile SHA-256');
  assert.match(plan.expectedProfile.probeSerial, /^[a-zA-Z0-9]+$/); assert.match(plan.expectedProfile.uid, /^[a-f0-9]{24}$/i);
  assert.equal(plan.expectedProfile.chipId, 0x419); assert.equal(plan.expectedProfile.flashKiB, 1024); assert.match(plan.expectedProfile.cdcSerial, /^[a-zA-Z0-9]+$/);
  assert.equal(typeof plan.artifactTamperPreflight, 'boolean');
  const runtime = path.join(root, '.runtime/t2', plan.runId); const dataDir = path.join(runtime, 'data'); const output = path.join(root, 'output/t2', plan.runId);
  const installDirectory = path.dirname(plan.installedExe);
  for (const filename of [plan.projectRoot, installDirectory, runtime, output]) assert.ok(!inside(path.join(root, '.runtime/app'), filename), 'Primary product home is forbidden');
  disjoint(plan.projectRoot, installDirectory); disjoint(plan.projectRoot, runtime); disjoint(plan.projectRoot, output);
  disjoint(installDirectory, runtime); disjoint(installDirectory, output); disjoint(runtime, output);
  return { root: path.resolve(root), runtime, dataDir, output, plan };
}
export async function plainPath(filename: string): Promise<void> {
  const absolute = path.resolve(filename); const parsed = path.parse(absolute); let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const info = await lstat(current); assert.equal(info.isSymbolicLink(), false, `Linked/reparse test path is forbidden: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  try { assert.equal(samePath(await realpath(absolute), absolute), true, 'Resolved test path differs'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function fileSha256(filename: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
export function successfulOperation(status: EmbeddedStatus, kind: EmbeddedOperation['kind'], key?: string): EmbeddedOperation {
  const matches = status.operations.filter(operation => operation.kind === kind && (!key || operation.requestKey === key));
  assert.equal(matches.length, 1, `Expected exactly one ${kind} operation${key ? ` for ${key}` : ''}`);
  const operation = matches[0];
  assert.equal(operation.status, 'succeeded', `${kind} ${operation.id}: ${operation.status}; ${operation.detail ?? ''}`);
  assert.equal(operation.processExited, true, `${kind} process exit must be observed`); return operation;
}
export function assertEmbeddedBuild(status: EmbeddedStatus, profile: EmbeddedInstalledPlan['expectedProfile']) {
  assert.equal(status.configured, true); assert.equal(status.profileId, profile.id); assert.equal(status.profileSha256, profile.sha256);
  const artifact = status.artifact; assert.ok(artifact, 'Build artifact is missing'); const operation = successfulOperation(status, 'build');
  assert.equal(operation.id, artifact.id); assert.equal(operation.artifactId, artifact.id);
  for (const [label, value] of Object.entries({ id: artifact.buildId, hex: artifact.hexSha256, axf: artifact.axfSha256, source: artifact.sourceSha256, template: artifact.templateSha256, log: artifact.logSha256 })) sha(value, label);
  assert.ok(Object.keys(artifact.toolHashes).length > 0); for (const [tool, hash] of Object.entries(artifact.toolHashes)) sha(hash, `Tool ${tool}`);
  assert.equal(artifact.profileSha256, profile.sha256); assert.equal(artifact.projectSourceBefore, artifact.projectSourceAfter);
  assert.equal(artifact.snapshotSourceBefore, artifact.snapshotSourceAfter); assert.equal(artifact.snapshotSourceAfter, artifact.sourceSha256);
  assert.ok([0, 1].includes(artifact.processExit ?? -1)); assert.ok(artifact.files.length > 0); return artifact;
}
export function assertFlashGrant(status: EmbeddedStatus, profile: EmbeddedInstalledPlan['expectedProfile'], flash: EmbeddedOperation) {
  const artifact = status.artifact; const grant = status.grant; assert.ok(artifact && grant);
  assert.equal(grant.scope, 'flash-and-verify-once'); assert.equal(grant.taskId, status.taskId); assert.equal(grant.artifactId, artifact.id);
  assert.equal(grant.profileId, profile.id); sha(grant.backupSha256, 'Grant backup SHA-256');
  assert.equal(grant.consumedBy, flash.id); assert.equal(grant.hexSha256, artifact.hexSha256); assert.equal(grant.axfSha256, artifact.axfSha256);
  assert.equal(grant.buildId, artifact.buildId); assert.equal(grant.sourceSha256, artifact.sourceSha256); assert.equal(grant.profileSha256, profile.sha256);
  assert.deepEqual(grant.identity, { probeSerial: profile.probeSerial, uid: profile.uid, chipId: profile.chipId, flashKiB: profile.flashKiB, cdcSerial: profile.cdcSerial });
  assert.ok(grant.approvedAt && Number.isFinite(Date.parse(grant.approvedAt))); assert.ok(Date.parse(grant.approvedAt) < Date.parse(grant.expiresAt));
  assert.ok(Date.parse(grant.approvedAt) <= Date.parse(flash.createdAt) && Date.parse(flash.createdAt) < Date.parse(grant.expiresAt), 'Flash must start within the native grant lifetime');
}
export function assertNoEmbeddedReplay(before: EmbeddedStatus, after: EmbeddedStatus) {
  assert.equal(after.taskId, before.taskId); assert.deepEqual(persistentEmbeddedOperations(after.operations), persistentEmbeddedOperations(before.operations), 'Same request or restart must not create/advance a hardware operation');
  assert.deepEqual(after.artifact, before.artifact, 'Same request must retain the complete bound build record');
}
export function persistentEmbeddedOperations(operations: EmbeddedOperation[]) {
  return operations.map(({ progress: _telemetry, ...persistent }) => persistent);
}
