import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import { FZ3B_PROFILE, fz3bDigest, fz3bProfileSha256, validateFz3bIdentity } from '../../packages/engineering-runner/fz3b/profile';
import { inside, plainPath, samePath } from './embedded-installed';
import { assertFz3bCloseSafe, readPinnedFz3bResources } from './fz3b-installed';
import { fz3b051PlanScope, type Fz3b051Plan } from './fz3b-051-installed';
import { parseFz3bRemoteResult } from '../../packages/engineering-runner/fz3b/worker';
import { deterministicPsPackage } from '../../packages/engineering-runner/fz3b/package';

export const CANCEL_OUTPUT = 'output/qa/2026-10-17-fz3b-recovery';
export const CANCEL_TOOLS = ['fz3b_status', 'fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic', 'fz3b_semantic'] as const;
const SHA = /^[a-f0-9]{64}$/;
export function cancelPlanScope(root: string, value: unknown, env: NodeJS.ProcessEnv) {
  const original = fz3b051PlanScope(root, value, env);
  const output = path.join(root, CANCEL_OUTPUT, original.plan.runId);
  for (const other of [original.plan.dataDir, original.plan.projectRoot, path.dirname(original.plan.installedExe)]) {
    assert.equal(inside(other, output) || inside(output, other), false);
  }
  assert.equal(original.plan.releaseBinding.candidateSha256, 'd821ab2ab817e7baa8e38f919a1e0e2270109ff421acb79bba51ab63eddef46a');
  assert.equal(original.plan.executableSha256, '8e10b3b96af315f30f2efa4883826f457b0df88a1eb148eafafd04e35e8d37a9');
  assert.equal(original.plan.resourceHashes['resources/app.asar'], 'de20124591def50b0f7060a4306d4c6eb4515c331a747c753f2cc1bd26cdd176');
  assert.equal(original.plan.installerSha256, '6e7fc1f5a3f6fde4f41b5275d24a38f068a547064d3fc139f1436f296c486b2c');
  return { ...original, output };
}
export function assertCancelDispatch(run: Fz3bRunView, plan: Fz3b051Plan) {
  assert.equal(run.profileId, FZ3B_PROFILE.id); assert.equal(run.profileSha256, fz3bProfileSha256(plan.fixture));
  assert.equal(run.model, plan.model); assert.equal(run.status, 'active'); assert.equal(run.phase, 'semantic');
  assert.equal(run.active, true); assert.equal(run.stopRequested, false); assert.equal(run.hardwareBusy, true);
  assert.equal(run.nativeApproval, 'approved'); assert.equal(run.currentTool, 'fz3b_semantic');
  assert.deepEqual(run.calls.map(call => call.tool), [...CANCEL_TOOLS]);
  assert.equal(new Set(run.calls.map(call => call.callId)).size, 5);
  assert.deepEqual(run.operations.map(op => op.kind), ['build', 'inspect', 'semantic']);
  const operation = run.operations[2]; assert.equal(operation.status, 'running'); assert.equal(operation.dispatchPhase, 'may-have-started');
  assert.equal(run.calls[4].status, 'running'); assert.equal(run.calls[4].operationId, operation.id);
  for (const call of run.calls.slice(0, 4)) { assert.equal(call.status, 'succeeded'); assert.equal(call.result?.ok, true); }
  assert.equal(run.grant?.consumedBy, operation.id); assert.equal(run.grant?.runId, run.runId);
  assert.equal(run.grant?.taskId, run.taskId); assert.equal(run.grant?.sessionId, run.sessionId);
  assert.equal(run.export, undefined); assert.equal(run.semantic, undefined);
  assert.equal(new Set(run.operations.map(op => op.id)).size, 3); assert.equal(new Set(run.operations.map(op => op.nonce)).size, 3);
  for (const op of run.operations) { assert.match(op.nonce, SHA); assert.equal(op.requestKey, `fz3b-${fz3bDigest(`${run.runId}:fz3b_${op.kind}`)}`); }
  for (const op of run.operations.slice(0, 2)) { assert.equal(op.status, 'succeeded'); assert.equal(op.processExited, true); assert.equal(op.remoteQuiescent, true); }
  return operation;
}
export function assertCancelDrained(before: Fz3bRunView, after: Fz3bRunView, state: AppSnapshot, stopStartedAt: number) {
  for (const key of ['runId', 'taskId', 'sessionId', 'model', 'generation', 'threadId', 'turnId', 'profileSha256'] as const) assert.equal(after[key], before[key]);
  assert.equal(after.status, 'stopped'); assert.equal(after.phase, 'stopped'); assert.equal(after.stopRequested, true);
  assertFz3bCloseSafe(after, state.fz3bAgent?.engineState ?? '', state.fz3bAgent?.activeRunId);
  assert.deepEqual(after.grant, before.grant); assert.deepEqual(after.artifact, before.artifact); assert.deepEqual(after.identity, before.identity);
  assert.deepEqual(after.operations.map(op => [op.id, op.requestKey, op.nonce, op.kind, op.createdAt]), before.operations.map(op => [op.id, op.requestKey, op.nonce, op.kind, op.createdAt]));
  assert.deepEqual(after.operations.slice(0, 2), before.operations.slice(0, 2));
  assert.deepEqual(after.calls.map(call => [call.callId, call.tool, call.receivedAt, call.operationId]), before.calls.map(call => [call.callId, call.tool, call.receivedAt, call.operationId]));
  assert.deepEqual(after.calls.slice(0, 4), before.calls.slice(0, 4));
  assert.equal(after.export, undefined, 'No subsequent model export tool may run');
  const operation = after.operations[2]; assert.equal(operation.status, 'succeeded', 'Known failed worker may be close-safe, but is not this positive drain acceptance');
  assert.ok(Number.isFinite(stopStartedAt) && stopStartedAt <= Date.parse(operation.updatedAt), 'Stop missed the observed dispatch window');
  assert.match(operation.evidenceSha256!, SHA); assert.equal(after.calls[4].status, 'succeeded');
  assert.equal(after.calls[4].result?.ok, true); assert.deepEqual(after.calls[4].result?.operation, operation);
  const semantic = after.semantic!; assert.ok(semantic); validateFz3bIdentity(after.identity!);
  assert.equal(semantic.jobId, `fd-semantic-${operation.id.replaceAll('-', '')}`); assert.equal(semantic.inferenceStopped, true);
  assert.equal(semantic.semanticInput, 'real-text-encoder'); assert.equal(semantic.synthetic, false); assert.equal(semantic.completedFrames, 1);
  assert.equal(semantic.fixtureManifestSha256, before.grant!.fixture.manifestSha256);
  assert.equal(semantic.queriesSha256, before.grant!.fixture.queriesSha256); assert.equal(semantic.imageSha256, before.grant!.fixture.imageSha256);
  assert.deepEqual(semantic.encoderIdentity, before.grant!.fixture.encoderIdentity); assert.equal(semantic.newPlLoaded, false);
  assert.deepEqual(after.calls[4].result?.semantic, semantic);
  const session = state.sessions.find(item => item.id === after.sessionId); assert.equal(session?.status, 'interrupted'); assert.equal(session?.turnId, undefined);
  return { label: 'model-planner-stopped-original-worker-drained', semanticOperationId: operation.id, remoteQuiescent: true, inferenceInterruptedByUi: false };
}
export async function verifyCancelExport(dataDir: string, directory: string, run: Fz3bRunView, plan: Fz3b051Plan) {
  const parent = path.join(dataDir, 'exports/fz3b-agent'); assert.ok(samePath(path.dirname(directory), parent));
  assert.ok(path.basename(directory).startsWith(`${run.runId}-snapshot-`));
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function read(file: string, maximum: number, expected?: string) {
    await plainPath(file); const stat = await lstat(file); assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= maximum);
    const bytes = await readFile(file); assert.equal(bytes.length, stat.size); const sha256 = fz3bDigest(bytes);
    if (expected) assert.equal(sha256, expected); files.push({ path: file, bytes: bytes.length, sha256 }); return bytes;
  }
  const raw = await read(path.join(directory, 'manifest.json'), 2 * 1048576); const manifest = JSON.parse(raw.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.scope, FZ3B_PROFILE.id); assert.equal(manifest.exportKind, 'local-snapshot');
  assert.deepEqual(manifest.profile, FZ3B_PROFILE); assert.deepEqual(manifest.fixture, plan.fixture);
  assert.deepEqual(manifest.run, JSON.parse(JSON.stringify(run))); assert.equal(manifest.run.export, undefined);
  assert.deepEqual(Object.keys(manifest.receipts).sort(), run.operations.map(op => op.id).sort());
  const expected = run.operations.flatMap(op => [{ path: `workers/${op.id}/evidence.json`, sha256: op.evidenceSha256! },
    ...(op.kind === 'build' ? [{ path: `workers/${op.id}/ps-acceptance.tar`, sha256: run.artifact!.packageSha256 }, { path: `workers/${op.id}/package-manifest.json`, sha256: run.artifact!.packageManifestSha256 }] : [])]);
  assert.equal(manifest.files.length, 5); assert.deepEqual(manifest.files.map((item: any) => item.path).sort(), expected.map(item => item.path).sort());
  for (const copy of expected) {
    const item = manifest.files.find((file: any) => file.path === copy.path); assert.equal(item.sha256, copy.sha256);
    const bytes = await read(path.join(directory, copy.path), copy.path.endsWith('.tar') ? 8 * 1048576 : 2 * 1048576, copy.sha256); assert.equal(item.bytes, bytes.length);
    if (copy.path.endsWith('/evidence.json')) {
      const operation = run.operations.find(op => copy.path === `workers/${op.id}/evidence.json`)!;
      const receipt = manifest.receipts[operation.id], evidence = JSON.parse(bytes.toString('utf8'));
      assert.equal(receipt.operationId, operation.id); assert.equal(receipt.nonce, operation.nonce); assert.equal(receipt.profileSha256, run.profileSha256);
      assert.equal(receipt.status, 'succeeded'); assert.equal(receipt.processExited, true); assert.equal(receipt.remoteQuiescent, true); assert.equal(receipt.remoteOutcomeUnknown, false);
      assert.equal(receipt.evidenceSha256, operation.evidenceSha256); assert.equal(receipt.kind, operation.kind);
      assert.equal(evidence.operationId, operation.id); assert.equal(evidence.nonce, operation.nonce); assert.equal(evidence.profileSha256, run.profileSha256);
      assert.equal(evidence.resourceManifestSha256, plan.resourceHashes['resources/fz3b/manifest.json']); assert.equal(evidence.action, operation.kind);
      const original = await read(path.join(dataDir, 'fz3b-worker', operation.id, 'evidence.json'), 2 * 1048576, operation.evidenceSha256);
      assert.deepEqual(bytes, original);
      if (operation.kind === 'build') {
        assert.equal(evidence.kind, 'fixed-ps-fixture-package'); assert.equal(evidence.newPlBuilt, false); assert.equal(evidence.deployed, false);
        assert.equal(evidence.packageSha256, run.artifact!.packageSha256); assert.equal(evidence.packageManifestSha256, run.artifact!.packageManifestSha256);
        const installed = await readPinnedFz3bResources(plan);
        const rebuilt = deterministicPsPackage([...installed].filter(([name]) => /^(ps-src|fixture|licenses)\//.test(name)).map(([name, bytes]) => ({ path: name, bytes })));
        assert.deepEqual(await read(path.join(directory, `workers/${operation.id}/ps-acceptance.tar`), 8 * 1048576, run.artifact!.packageSha256), rebuilt.archive);
        assert.deepEqual(await read(path.join(directory, `workers/${operation.id}/package-manifest.json`), 65536, run.artifact!.packageManifestSha256), rebuilt.manifest);
      } else {
        assert.equal(evidence.authenticatedTransport, 'pinned-ssh'); assert.equal(evidence.helloAuthenticated, false);
        assert.equal(evidence.transport.processExited, true); assert.equal(evidence.transport.exitCode, 0); assert.equal(evidence.transport.timedOut, false);
        const parsed = parseFz3bRemoteResult(evidence.remoteStdout, { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, operationId: operation.id,
          requestKey: operation.requestKey, nonce: operation.nonce, profileSha256: run.profileSha256, fixture: plan.fixture, artifact: run.artifact, identity: run.identity, grant: run.grant }, operation.kind);
        assert.deepEqual(parsed, evidence.remote); assert.equal(parsed.status, 'succeeded'); assert.deepEqual(receipt.identity, run.identity);
        if (operation.kind === 'semantic') { assert.equal(receipt.grantId, run.grant!.id); assert.equal(parsed.grantId, run.grant!.id); assert.deepEqual(receipt.semantic, run.semantic); assert.deepEqual(parsed.semantic, run.semantic); }
        else assert.equal(receipt.readOnly, true);
      }
    }
  }
  const names: string[] = [];
  async function walk(parent: string): Promise<void> { await plainPath(parent); for (const item of await readdir(parent, { withFileTypes: true })) {
    const file = path.join(parent, item.name); await plainPath(file); if (item.isDirectory()) await walk(file); else { assert.ok(item.isFile()); names.push(path.relative(directory, file).split(path.sep).join('/')); }
  } }
  await walk(directory); assert.deepEqual(names.sort(), ['manifest.json', ...expected.map(item => item.path)].sort());
  return { path: directory, sha256: fz3bDigest(raw), files, exportKind: 'local-snapshot', modelExportInvoked: false };
}
