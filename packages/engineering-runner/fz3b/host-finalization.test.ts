import assert from 'node:assert/strict';
import test from 'node:test';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from './preflight-recovery.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS } from './preflight-refusal-proof.js';
import { FZ3B_HOST_FINALIZATION_DOMAIN, FZ3B_HOST_FINALIZATION_PRODUCER, FZ3B_HOST_FINALIZATION_LIMITS,
  assertFz3bPreflightHostCompletionBinding, assertFz3bHostFinalizationBody, assertFz3bHostFinalizationCertificate,
  assertFz3bHostTargetProjection, fz3bHostTargetProjection, fz3bHostFinalizationDigest,
  type Fz3bPreflightHostCompletionBinding, type Fz3bHostFinalizationBody, type Fz3bHostFinalizationExpected } from './host-finalization.js';

function fixture() {
  // Deliberately structural only: these public synthetic hashes are not authenticated authority.
  const base: Omit<Fz3bPreflightHostCompletionBinding, 'completeChainSha256'> = {
    schemaVersion: 1, method: 'fz3b-preflight-host-completion-binding-v1', purpose: 'exact-local-preflight-host-finish-only',
    owner: { runId: FZ3B_PREFLIGHT_RECOVERY_CASE.runId, taskId: 'task1', sessionId: 'session1', threadId: 'thread1', turnId: 'turn1', model: 'gpt-6.1-sol', generation: 3 },
    recoveryId: '11111111-1111-4111-8111-111111111111', operationId: FZ3B_PREFLIGHT_RECOVERY_CASE.operationId, nonce: FZ3B_PREFLIGHT_RECOVERY_CASE.nonce,
    profileSha256: FZ3B_PREFLIGHT_REFUSAL_PINS.profile, resourceManifestSha256: FZ3B_PREFLIGHT_REFUSAL_PINS.manifest,
    checkpointSha256: 'a'.repeat(64), checkpointEnvelopeSha256: 'b'.repeat(64), sourceRecordSha256: 'c'.repeat(64), sourceProjectionSha256: 'd'.repeat(64),
    maintenanceExitSha256: null, originalHistorySha256: 'e'.repeat(64), contextSha256: 'f'.repeat(64), proofSha256: '1'.repeat(64), finalizationSha256: '2'.repeat(64),
    ackSha256: '3'.repeat(64), acknowledgmentSha256: '4'.repeat(64), closureSha256: '5'.repeat(64), closureIssuedAt: '2026-10-17T12:00:00.000Z',
    originalUnknownPreserved: true, remoteQuiescence: 'not-established', newBootIdentity: 'not-observed-or-adopted', localProcessesClosed: true, leaseAndBarrierAbsent: true,
  };
  const binding: Fz3bPreflightHostCompletionBinding = { ...base, completeChainSha256: fz3bHostFinalizationDigest(base) };
  const project = { id: 'project1', root: 'E:\\Projects\\fixed', name: 'Fixed project' };
  const session = { id: 'session1', taskId: 'task1', projectId: project.id, title: 'Display title', status: 'needs_attention', threadId: 'thread1',
    model: 'gpt-6.1-sol', engineProfile: 'fz3b' as const, historyIncomplete: true, engineUncertain: false, turnId: undefined,
    messages: [{ id: 'message1', role: 'system', text: 'Original unknown preserved', timestamp: '2026-10-17T11:00:00.000Z' }] };
  const target = fz3bHostTargetProjection(project, session, binding);
  const expected: Fz3bHostFinalizationExpected = { storeIdentitySha256: '6'.repeat(64), producerVersion: FZ3B_HOST_FINALIZATION_PRODUCER };
  const body: Fz3bHostFinalizationBody = { schemaVersion: 1, method: 'fz3b-preflight-host-finalization-v1',
    certificateId: '22222222-2222-4222-8222-222222222222', issuedAt: '2026-10-17T12:01:00.000Z', producerVersion: FZ3B_HOST_FINALIZATION_PRODUCER,
    storeIdentitySha256: expected.storeIdentitySha256, completion: binding, target, targetSha256: fz3bHostFinalizationDigest(target),
    snapshot: { sha256: '7'.repeat(64), bytes: 1024, checkpointSha256: '7'.repeat(64),
      checkpointFile: `${binding.owner.runId}/22222222-2222-4222-8222-222222222222.desktop.json` } };
  return { binding, project, session, expected, body };
}

test('host-finalization policy is structural only, with a separate local MAC domain and bounded budgets', () => {
  const f = fixture(); assertFz3bHostFinalizationBody(f.body, f.binding, f.expected);
  assertFz3bHostFinalizationCertificate({ ...f.body, mac: '0'.repeat(64) }, f.binding, f.expected);
  assert.equal(FZ3B_HOST_FINALIZATION_DOMAIN, 'ForgeDesk/FZ3B/PreflightHostFinalization/v1\0');
  assert.deepEqual(FZ3B_HOST_FINALIZATION_LIMITS, { snapshotBytes: 16777216, certificateBytes: 65536, certificateEntries: 16, checkpointTotalBytes: 268435456 });
});

test('binding rejects authority expansion, changed component digests, unknown keys and non-integer owner generation', () => {
  for (const mutate of [
    (v: any) => { v.remoteQuiescence = 'established'; }, (v: any) => { v.newBootIdentity = 'adopted'; },
    (v: any) => { v.originalUnknownPreserved = false; }, (v: any) => { v.owner.generation = false; },
    (v: any) => { v.resourceManifestSha256 = '0'.repeat(64); }, (v: any) => { v.closureSha256 = '0'.repeat(64); },
    (v: any) => { v.saved = true; },
  ]) {
    const f = fixture(), value = structuredClone(f.binding); mutate(value);
    assert.throws(() => assertFz3bPreflightHostCompletionBinding(value));
  }
});

test('only display title changes are intentionally unbound; message or target authority changes are not', () => {
  const f = fixture(), original = fz3bHostTargetProjection(f.project, f.session, f.binding);
  f.session.title = 'Renamed'; assert.deepEqual(fz3bHostTargetProjection(f.project, f.session, f.binding), original);
  f.session.messages[0].text = 'Changed'; assert.notDeepEqual(fz3bHostTargetProjection(f.project, f.session, f.binding), original);
  for (const key of ['grant', 'semantic', 'identity', 'newBoot', 'saved', 'recoveryAuthority']) {
    const value: any = structuredClone(f.session); value[key] = {};
    assert.throws(() => fz3bHostTargetProjection(f.project, value, f.binding), /CLOSED_SCHEMA/);
  }
  assert.throws(() => fz3bHostTargetProjection({ ...f.project, grant: true }, f.session, f.binding), /CLOSED_SCHEMA/);
});

test('full target session/message schema is checked before projection, including getters and sparse arrays', () => {
  const f = fixture();
  for (const mutate of [
    (s: any) => { s.messages[0].grant = true; }, (s: any) => { s.messages[0].timestamp = 'not-time'; },
    (s: any) => { s.messages[0].role = 'grant'; }, (s: any) => { delete s.messages[0]; },
    (s: any) => { Object.defineProperty(s, 'title', { enumerable: true, get() { throw new Error('Getter must never run'); } }); },
  ]) {
    const value = structuredClone(f.session); mutate(value);
    assert.throws(() => fz3bHostTargetProjection(f.project, value, f.binding), /FZ3B_HOST_FINALIZATION_/);
  }
});

test('terminal projection refuses foreign owners, active turns, running or uncertain state and hidden extra fields', () => {
  const f = fixture();
  for (const key of ['id', 'taskId', 'projectId', 'threadId', 'model', 'engineProfile', 'status', 'historyIncomplete', 'engineUncertain', 'turnId', 'messagesSha256', 'extra']) {
    const target: any = structuredClone(f.body.target); target.session[key] = 'foreign';
    assert.throws(() => assertFz3bHostTargetProjection(target, f.binding));
  }
  assert.throws(() => fz3bHostTargetProjection(f.project, { ...f.session, turnId: 'active-turn' }, f.binding), /SESSION/);
});

test('body binds exact independently supplied completion, store identity, producer and target digest', () => {
  const f = fixture();
  for (const mutate of [
    (v: any) => { v.completion.closureSha256 = '0'.repeat(64); }, (v: any) => { v.storeIdentitySha256 = '0'.repeat(64); },
    (v: any) => { v.producerVersion = 'future-unreviewed'; }, (v: any) => { v.targetSha256 = '0'.repeat(64); },
    (v: any) => { v.method = 'remote-finalize'; }, (v: any) => { v.remoteQuiet = true; },
    (v: any) => { v.issuedAt = '2026-10-17T11:59:59.999Z'; }, (v: any) => { v.certificateId = '../escape'; },
  ]) { const value = structuredClone(f.body); mutate(value); assert.throws(() => assertFz3bHostFinalizationBody(value, f.binding, f.expected)); }
});

test('snapshot binds identical exact checkpoint bytes, controlled relative name, positive bounded byte count', () => {
  const f = fixture();
  for (const mutate of [
    (v: any) => { v.bytes = false; }, (v: any) => { v.bytes = 0; }, (v: any) => { v.bytes = 16777217; },
    (v: any) => { v.checkpointSha256 = '0'.repeat(64); }, (v: any) => { v.checkpointFile = '../desktop.json'; },
    (v: any) => { v.checkpointFile = 'C:\\desktop.json'; }, (v: any) => { v.extra = 'saved'; },
  ]) { const value = structuredClone(f.body); mutate(value.snapshot); assert.throws(() => assertFz3bHostFinalizationBody(value, f.binding, f.expected)); }
});

test('certificate closed encoding and UTF-8 byte budget remain mandatory independently of MAC format', () => {
  const f = fixture();
  assert.throws(() => assertFz3bHostFinalizationCertificate({ ...f.body, mac: 'not-a-MAC' }, f.binding, f.expected), /MAC_FORMAT/);
  assert.throws(() => assertFz3bHostFinalizationCertificate({ ...f.body, mac: '0'.repeat(64), saved: true }, f.binding, f.expected), /CLOSED_SCHEMA/);
  const large = structuredClone(f.body); large.target.project.root = 'C:\\' + 'a'.repeat(32760); large.target.project.name = '\u754c'.repeat(10000);
  large.targetSha256 = fz3bHostFinalizationDigest(large.target);
  assert.throws(() => assertFz3bHostFinalizationCertificate({ ...large, mac: '0'.repeat(64) }, f.binding, f.expected), /CERTIFICATE_BYTE_BUDGET/);
});
