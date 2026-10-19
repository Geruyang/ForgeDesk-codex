import assert from 'node:assert/strict';
import path from 'node:path';
import { readdir, lstat } from 'node:fs/promises';
import type { Operation, EngineeringTask, SnapshotProfile } from '../../packages/engineering-runner';
import { validateSnapshotExecutionPolicies } from '../../packages/engineering-runner/snapshots';
import { inside, samePath, plainPath } from './embedded-installed';
import { ROOT, NODE, readStable, sha } from './release-1-policy';

export const BUGGY = 'export function average(values) { return values.reduce((sum, value) => sum + value) / values.length; }\n';
export async function filesIn(directory: string, max = 256) {
  await plainPath(directory); const result: string[] = []; let bytes = 0;
  const visit = async (dir: string, depth: number) => {
    assert.ok(depth <= 16);
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name); await plainPath(file); assert.ok(item.isDirectory() || item.isFile());
      if (item.isDirectory()) await visit(file, depth + 1); else { const stat = await lstat(file); assert.equal(stat.nlink, 1); bytes += stat.size; assert.ok(result.length < max && bytes <= 64 * 1024 * 1024); result.push(path.relative(directory, file).split(path.sep).join('/')); }
    }
  };
  await visit(directory, 0); return result.sort();
}
export async function workspacePins(workspace: string) {
  return Promise.all((await filesIn(workspace)).filter(f => !f.startsWith('.git/')).map(async file => ({ path: file, sha256: sha(await readStable(path.join(workspace, file), 4 * 1024 * 1024)) })));
}
export async function verifySnapshot(operation: Operation, taskId: string, workspace: string, profile: SnapshotProfile) {
  assert.match(taskId, /^[a-f0-9-]{36}$/); assert.match(operation.id, /^[a-f0-9-]{36}$/);
  const value = operation.snapshot; assert.ok(value); assert.equal(operation.evidenceLevel, 'B'); assert.equal(value.profileId, 'forgedesk.node-software.v1');
  const owned = path.join(ROOT, '.runtime/app/engineering/snapshots', taskId, operation.id);
  assert.ok(samePath(value.inputRoot, path.join(owned, 'input'))); assert.ok(samePath(value.outputRoot, path.join(owned, 'output'))); assert.ok(samePath(value.manifestPath, path.join(owned, 'manifest.json')));
  const raw = await readStable(value.manifestPath), manifest = JSON.parse(raw.toString()); assert.equal(sha(raw), value.manifestDigest); assert.equal(manifest.id, operation.id); assert.equal(manifest.taskId, taskId); assert.deepEqual(manifest.excludedInputs, ['.git']); assert.equal(manifest.source.gitCommit, null); assert.equal(manifest.source.dirtyDiffDigest, null);
  assert.deepEqual(await filesIn(value.inputRoot), manifest.source.files.map((f: any) => f.path).sort());
  for (const file of manifest.source.files) { assert.ok(typeof file.path === 'string' && inside(value.inputRoot, path.resolve(value.inputRoot, file.path))); const bytes = await readStable(path.join(value.inputRoot, file.path), 4 * 1024 * 1024); assert.equal(sha(bytes), file.sha256); assert.equal(bytes.length, file.bytes); }
  for (const file of ['ignored.bin', '.cache/necessary-input.txt', 'package-lock.json']) assert.ok(manifest.source.files.some((f: any) => f.path === file)); assert.equal((await lstat(path.join(value.inputRoot, 'empty/nested'))).isDirectory(), true);
  const probeRoot = path.join(ROOT, '.runtime/app/engineering/isolation-probes'); assert.ok(inside(probeRoot, value.isolation.probeLogRef));
  assert.ok(samePath(value.isolation.projectRoot, workspace)); assert.ok(samePath(value.isolation.protectedRoot, path.join(ROOT, '.runtime/app/engineering/snapshots')));
  const proofRaw = await readStable(value.isolation.probeLogRef), proof = JSON.parse(proofRaw.toString()); assert.equal(sha(proofRaw), value.isolation.probeLogSha256); assert.equal(proof.method, 'engine-sandbox-write-denial');
  assert.equal(proof.writeDenied, true); assert.equal(proof.workspaceWritten, true); assert.equal(proof.cleanupComplete, true); assert.equal(proof.originalSha256, proof.protectedAfterSha256);
  assert.equal(value.sandboxProbe?.sqliteInputWriteDenied, true); assert.equal(value.sandboxProbe?.inputWriteDenied, true); assert.equal(value.sandboxProbe?.outputWriteAllowed, true); assert.equal(value.permissionProbe?.build.passed, true); assert.equal(value.permissionProbe?.verify.passed, true);
  // Reuse the actual readonly command/cwd/home/generation proof checker, without its live callback.
  await validateSnapshotExecutionPolicies(value, profile, { dataDir: path.join(ROOT, '.runtime/app') }, false);
  return { operationId: operation.id, manifestDigest: value.manifestDigest, copiedFiles: manifest.source.files.length, probeLogSha256: value.isolation.probeLogSha256, verificationResult: value.verificationResult,
    executionPolicies: value.executionPolicies!.map(p => ({ file: p.file, phase: p.phase, permissionStage: p.permissionStage ?? null, status: p.status, generation: p.before!.generation, policyDigest: p.policyDigest, commandDigest: p.commandDigest, sandboxArgsDigest: p.sandboxArgsDigest })) };
}
export function assertProfile(task: EngineeringTask) {
  const p = task.snapshotProfile; assert.ok(p); assert.equal(p.id, 'forgedesk.node-software.v1'); assert.ok(samePath(p.nodeExecutable, NODE)); assert.ok(samePath(p.sandbox.executable, path.join(ROOT, 'install/resources/codex/codex.exe'))); assert.ok(samePath(p.sandbox.codexHome, path.join(ROOT, '.runtime/app/engine'))); assert.equal(p.sandbox.mode, 'unelevated');
  assert.ok(samePath(p.templateDirectory, path.join(ROOT, 'install/resources/templates/node-software-v1'))); assert.equal(task.acceptance.length, 1); assert.equal(task.acceptance[0].id, 'snapshot-software'); assert.equal(task.acceptance[0].kind, 'automated'); return p;
}
export async function verifyPassed(task: EngineeringTask, workspace: string) {
  assert.equal(task.status, 'passed'); assert.equal(task.acceptance[0].status, 'passed'); const evidence = task.evidence.at(-1); assert.ok(evidence); assert.equal(evidence.result, 'passed'); assert.equal(evidence.evidenceLevel, 'B'); assert.ok(evidence.artifacts.length);
  const operation = task.operations.at(-1)!; const snapshot = await verifySnapshot(operation, task.id, workspace, assertProfile(task));
  for (const artifact of evidence.artifacts) { assert.ok(inside(operation.snapshot!.outputRoot, artifact.path)); const bytes = await readStable(artifact.path, 4 * 1024 * 1024); assert.equal(sha(bytes), artifact.sha256); assert.equal(bytes.length, artifact.bytes); }
  assert.deepEqual(operation.snapshot?.verifierReceipt?.checks, ['empty', 'nonempty', 'signed']); assert.equal(operation.snapshot?.verifierReceipt?.passed, true); assert.equal(operation.snapshot?.verifierReceipt?.sha256, evidence.artifacts[0].sha256);
  return { snapshot, artifacts: evidence.artifacts };
}
export async function verifyExport(directory: string, parent: string, task: EngineeringTask, sentinel: string) {
  assert.ok(inside(parent, directory)); assert.deepEqual((await readdir(directory)).sort(), ['logs', 'manifest.json']); const raw = await readStable(path.join(directory, 'manifest.json')), text = raw.toString(), manifest = JSON.parse(text);
  assert.equal(manifest.evidenceLevel, 'B'); assert.deepEqual(manifest.evidenceLevels, ['B']); assert.equal(manifest.task.status, 'passed'); assert.equal(text.includes(sentinel), false); assert.equal(manifest.logs.length, task.operations.length);
  for (const log of manifest.logs) { const file = path.resolve(directory, log.file); assert.ok(inside(directory, file)); const bytes = await readStable(file, 1024 * 1024); assert.equal(sha(bytes), log.sha256); assert.equal(bytes.toString().includes(sentinel), false); }
  return { directory, manifestSha256: sha(raw), logCount: manifest.logs.length, evidenceLevel: 'B' };
}
