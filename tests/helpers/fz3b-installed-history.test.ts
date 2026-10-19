import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bDigest, fz3bProfileSha256 } from '../../packages/engineering-runner/fz3b/profile';
import { fz3bOriginalInspectionContext, fz3bReconciliationDigest, fz3bReconciliationOwnerBinding } from '../../packages/engineering-runner/fz3b/reconciliation';
import { legacyInspectPayload, LEGACY_INSPECT_RESOURCE_SHA256 } from '../../packages/engineering-runner/fz3b/payload';
import type { Fz3bInspectReconciliationContext, Fz3bInspectReconciliationProof, Fz3bRunView, Fz3bSemanticFixture } from '../../packages/engineering-runner/fz3b/types';
import { assertFz3bHistoryStable, assertFz3bRunUnheld, verifyFz3bHistoricalReleases } from './fz3b-installed-history';
import { assertFz3bStartupIdle } from './fz3b-installed-startup';
import type { AppSnapshot } from '../../packages/shared/contracts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), resourceRoot = path.join(root, 'engineering/fz3b/product/resources');
const sha = (value: string) => value.repeat(64);
async function fixture() {
  const semantic: Fz3bSemanticFixture = JSON.parse(await readFile(path.join(resourceRoot, 'fixture/host-fixture.json'), 'utf8'));
  const resources = new Map<string, Buffer>();
  for (const file of ['remote/remote.py', 'remote/wire.py']) resources.set(file, await readFile(path.join(resourceRoot, file)));
  const dataDir = path.join(root, 'output/hardware/2026-10-16-next/product', `history-helper-fixture-${randomUUID()}`);
  const run: Fz3bRunView = { schemaVersion: 1, runId: 'old-run', taskId: 'old-task', sessionId: 'old-session', model: 'gpt-6.1-sol',
    generation: 1, threadId: 'old-thread', turnId: 'old-turn', profileId: FZ3B_PROFILE.id, profileSha256: fz3bProfileSha256(semantic),
    status: 'needs_attention', phase: 'needs_attention', active: false, hardwareBusy: false, stopRequested: true, nativeApproval: 'not_requested',
    createdAt: '2026-10-16T06:00:00.000Z', updatedAt: '2026-10-16T06:02:00.000Z', calls: [], operations: [] };
  run.operations = [{ id: '10000000-0000-4000-8000-000000000000', requestKey: 'old-build', nonce: sha('1'), kind: 'build', status: 'succeeded',
    dispatchPhase: 'may-have-started', processExited: true, remoteQuiescent: true, evidenceSha256: sha('2'), createdAt: run.createdAt, updatedAt: run.updatedAt },
  { id: '20000000-0000-4000-8000-000000000000', requestKey: 'old-inspect', nonce: sha('3'), kind: 'inspect', status: 'unknown',
    dispatchPhase: 'may-have-started', processExited: true, remoteQuiescent: false, evidenceSha256: sha('4'), createdAt: run.createdAt, updatedAt: run.updatedAt }];
  run.artifact = { id: sha('5'), kind: 'fixed-ps-fixture-package', buildId: run.operations[0].id, profileSha256: run.profileSha256,
    sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256, fixtureManifestSha256: semantic.manifestSha256, queriesSha256: semantic.queriesSha256,
    imageSha256: semantic.imageSha256, buildEvidenceSha256: sha('2'), packageSha256: sha('6'), packageManifestSha256: sha('7'), newPlBuilt: false, deployed: false };
  run.calls = [{ callId: 'old-status', tool: 'fz3b_status', status: 'succeeded', receivedAt: run.createdAt, completedAt: run.updatedAt },
    { callId: 'old-build', tool: 'fz3b_build', status: 'succeeded', operationId: run.operations[0].id, receivedAt: run.createdAt, completedAt: run.updatedAt },
    { callId: 'old-inspect', tool: 'fz3b_inspect', status: 'unknown', operationId: run.operations[1].id, receivedAt: run.createdAt, completedAt: run.updatedAt }];
  const operation = run.operations[1], worker = path.join(dataDir, 'fz3b-worker', operation.id);
  const contents = new Map<string, Buffer>();
  async function put(file: string, value: unknown) { const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); contents.set(file, bytes); return fz3bDigest(bytes); }
  const originalEvidenceSha256 = await put(path.join(worker, 'evidence.json'), { schemaVersion: 1, operationId: operation.id, nonce: operation.nonce,
    profileSha256: run.profileSha256, kind: 'inspect', readOnly: true, status: 'unknown', processExited: true, remoteQuiescent: false, remoteOutcomeUnknown: true });
  operation.evidenceSha256 = originalEvidenceSha256;
  const original = fz3bOriginalInspectionContext(run, operation, semantic);
  const originalIntentSha256 = await put(path.join(worker, 'intent.json'), { schemaVersion: 1, operationId: operation.id, nonce: operation.nonce,
    profileSha256: run.profileSha256, action: 'inspect', dispatchPhase: 'may-have-started', resourceManifestSha256: LEGACY_INSPECT_RESOURCE_SHA256,
    payloadSha256: fz3bDigest(legacyInspectPayload({ fixture: semantic, manifestSha256: LEGACY_INSPECT_RESOURCE_SHA256, files: resources }, original)) });
  const originalCloseSha256 = await put(path.join(worker, 'process-exit.json'), { schemaVersion: 1, observedClose: true, exitCode: 255, outputSha256: fz3bDigest(''), at: run.updatedAt });
  const context: Fz3bInspectReconciliationContext = { schemaVersion: 1, id: 'readonly-release-fixture', nonce: sha('8'), createdAt: run.updatedAt, original,
    originalOperationSha256: fz3bReconciliationDigest(operation), originalEvidenceSha256, ownerBindingSha256: fz3bReconciliationDigest(fz3bReconciliationOwnerBinding(run)) };
  const identity = { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot, platform: 'A0005' as const,
    contractId: FZ3B_PROFILE.encoderIdentity.contractId, deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256, existingPlSha256: FZ3B_PROFILE.existingPlSha256,
    transport: 'pinned-ssh' as const, helloAuthenticated: false as const };
  const remote = { readOnly: true as const, metadataStable: true as const, deviceOwners: [], controlConnections: 0 as const, inspectorPids: [], unfinishedJournalEntries: 0 as const,
    scanCount: 2, procScanComplete: true as const, journalScanComplete: true as const, originalInspectorAbsent: true as const };
  const { hostKeySha256: _key, transport: _transport, helloAuthenticated: _hello, ...remoteIdentity } = identity;
  const result = { schemaVersion: 1, id: context.id, nonce: context.nonce, contextSha256: fz3bReconciliationDigest(context), profileSha256: run.profileSha256,
    status: 'succeeded', identity: remoteIdentity, remote };
  const directory = path.join(dataDir, 'fz3b-worker/reconciliations', context.id);
  const proofTransport = { spawned: true as const, closeConfirmed: true as const, exitCode: 0 as const, timedOut: false as const };
  const evidenceSha256 = await put(path.join(directory, 'proof-evidence.json'), { schemaVersion: 1, context, contextSha256: result.contextSha256, originalLeaseSha256: sha('9'),
    originalEvidenceSha256, originalIntentSha256, originalCloseSha256, transport: proofTransport, remoteStdout: JSON.stringify(result) + '\n', remote: result,
    observedAt: context.createdAt, originalUnknownPreserved: true });
  const proof: Fz3bInspectReconciliationProof = { schemaVersion: 1, id: context.id, nonce: context.nonce, contextSha256: result.contextSha256,
    originalEvidenceSha256, originalIntentSha256, originalCloseSha256, originalResourceManifestSha256: LEGACY_INSPECT_RESOURCE_SHA256,
    localOriginalCloseConfirmed: true, identity, observedAt: context.createdAt, evidenceSha256, transport: proofTransport, remote };
  const finalSha = await put(path.join(directory, 'finalization-evidence.json'), { schemaVersion: 1, id: context.id, contextSha256: result.contextSha256, proofSha256: fz3bReconciliationDigest(proof),
    originalOperationId: operation.id, originalNonce: operation.nonce, originalLeaseSha256: sha('9'), oldUnknownPreserved: true, preparedBeforeExactUnlink: true });
  run.reconciliations = [{ schemaVersion: 1, context, status: 'released', createdAt: context.createdAt, updatedAt: context.createdAt, proof,
    finalization: { schemaVersion: 1, id: context.id, contextSha256: result.contextSha256, proofSha256: fz3bReconciliationDigest(proof), lockReleased: true, localProcessesClosed: true, evidenceSha256: finalSha } }];
  return { run, semantic, resources, dataDir, contents };
}

test('strict released inspect history is eligible without rewriting its unknown operation or calls', async () => {
  const f = await fixture(), baseline = structuredClone(f.run);
  assertFz3bRunUnheld(f.run, f.semantic);
  const verified = await verifyFz3bHistoricalReleases(f.dataDir, [f.run], f.semantic, f.resources);
  assert.equal(verified.releases.length, 1); assert.equal(verified.files.length, 5); assert.equal(verified.hmacKeyRead, false);
  assert.deepEqual(f.run, baseline); assert.equal(f.run.operations[1].status, 'unknown'); assert.equal(f.run.calls[2].status, 'unknown');
  const state: AppSnapshot = { schemaVersion: 1, version: '0.5.0', projects: [], sessions: [], tasks: [], approvals: [], diagnostics: [], models: [],
    engine: { state: 'stopped', executable: 'fixture', home: 'fixture' }, account: { loggedIn: true, label: 'fixture' }, hardware: { enabled: false, modeActive: false, reason: 'fixture' }, dataDir: f.dataDir,
    fz3bAgent: { available: true, status: 'available', resourcesVerified: true, keyImportAllowed: true, engineState: 'stopped', runs: [f.run] } };
  assertFz3bStartupIdle(state, f.semantic); assert.throws(() => assertFz3bStartupIdle(state));
});

test('semantic unknown, unreleased/malformed proof, foreign bindings and unknown-history skipping remain denied', async () => {
  const f = await fixture();
  const mutations: Array<(run: Fz3bRunView) => void> = [
    run => { run.operations[1].kind = 'semantic'; }, run => { run.reconciliations![0].status = 'prepared'; }, run => { delete run.reconciliations![0].proof; },
    run => { run.reconciliations![0].proof!.remote.procScanComplete = false as true; }, run => { run.reconciliations![0].proof!.identity.bootId = 'foreign'; },
    run => { run.reconciliations![0].finalization!.lockReleased = false as true; }, run => { run.operations[1].nonce = sha('a'); },
    run => { run.taskId = 'foreign'; }, run => { run.hardwareBusy = true; }, run => { run.active = true; },
    run => { run.calls.push({ callId: 'semantic', tool: 'fz3b_semantic', receivedAt: run.createdAt, status: 'unknown' }); },
  ];
  for (const mutate of mutations) { const bad = structuredClone(f.run); mutate(bad); assert.throws(() => assertFz3bRunUnheld(bad, f.semantic)); }
  assertFz3bHistoryStable([f.run], [structuredClone(f.run)]); assert.throws(() => assertFz3bHistoryStable([f.run], []));
  const rewritten = structuredClone(f.run); rewritten.operations[1].status = 'succeeded'; assert.throws(() => assertFz3bHistoryStable([f.run], [rewritten]));
  assert.throws(() => assertFz3bHistoryStable([f.run], [{ ...f.run, reconciliations: [] }]));
  const invalidNumber = structuredClone(f.run); (invalidNumber as any).progress = NaN;
  assert.throws(() => assertFz3bHistoryStable([f.run], [invalidNumber]));
});

test('each original/proof/finalization public byte file is independently hashed; even a rehashed false remote body is denied', async () => {
  const f = await fixture();
  for (const [file, bytes] of f.contents) {
    await writeFile(file, Buffer.concat([bytes, Buffer.from('tampered')]));
    await assert.rejects(verifyFz3bHistoricalReleases(f.dataDir, [f.run], f.semantic, f.resources)); await writeFile(file, bytes);
  }
  const attempt = f.run.reconciliations![0], proofFile = [...f.contents.keys()].find(file => file.endsWith('proof-evidence.json'))!;
  const body = JSON.parse(f.contents.get(proofFile)!.toString()); const remote = JSON.parse(body.remoteStdout);
  remote.remote.deviceOwners = [123]; body.remoteStdout = JSON.stringify(remote) + '\n'; body.remote = remote;
  const bytes = Buffer.from(JSON.stringify(body, null, 2) + '\n'); await writeFile(proofFile, bytes); attempt.proof!.evidenceSha256 = fz3bDigest(bytes);
  attempt.finalization!.proofSha256 = fz3bReconciliationDigest(attempt.proof);
  await assert.rejects(verifyFz3bHistoricalReleases(f.dataDir, [f.run], f.semantic, f.resources));
});
