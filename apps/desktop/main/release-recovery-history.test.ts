import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { loadReadonlyHistory } from '../../../packages/engineering-runner/fz3b/history-readonly.js';
import { historicalFz3bProfileDefinitions } from '../../../packages/engineering-runner/fz3b/profile-history.js';
import { readReleaseRecoveryHistory } from './release-recovery-history.js';

const key = Buffer.alloc(32, 7); // Synthetic fixture only.
const old = historicalFz3bProfileDefinitions()[0]!;
function record(runId = 'old-run') {
  return { runId, sessionId: 'session', taskId: 'task', model: old.profile.model, generation: 1, threadId: 'thread',
    schemaVersion: 1, profileId: old.profileId, profileSha256: old.profileSha256, status: 'needs_attention', phase: 'needs_attention',
    active: false, hardwareBusy: true, stopRequested: true, nativeApproval: 'not_requested',
    createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:01.000Z', calls: [],
    operations: [{ id: 'op', requestKey: 'request', nonce: 'a'.repeat(64), kind: 'inspect', status: 'unknown',
      dispatchPhase: 'may-have-started', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:01.000Z' }],
    step: 2, results: {}, receipts: {} };
}
const raw = (payload: unknown) => Buffer.from(JSON.stringify({ payload,
  mac: createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex') }, null, 2));
function reader(records = [record()]) {
  return { async readExistingHistory() {
    const snapshot = loadReadonlyHistory(records.map(payload => ({ name: payload.runId + '.json', raw: raw(payload) })), key);
    return Object.freeze({ ...snapshot, observerKind: 'backend-existing-history-readonly', acquisition: Object.freeze({
      method: 'backend-existing-history-readonly-v1', jsonCensusStableAcrossRead: true,
      completeOperationalQuarantine: false, reservedReadBytes: 4096 }) });
  } };
}
function denied(result: Awaited<ReturnType<typeof readReleaseRecoveryHistory>>) {
  for (const flag of ['admissionAuthorized', 'releaseAuthorized', 'newRunAuthorized', 'activeEpochAdopted',
    'currentBootEstablished', 'automaticReplay', 'strictFinalizationVerified', 'operationalQuarantineVerified'] as const)
    assert.equal(result[flag], false, flag);
}
test('startup only calls existing readonly acquisition once without init or operational methods', async () => {
  let calls = 0;
  const backend = { ...reader(), init() { throw Error('init forbidden'); }, save() { throw Error('save forbidden'); },
    recover() { throw Error('recover forbidden'); }, async readExistingHistory() { calls++; assert.equal(arguments.length, 0); return reader().readExistingHistory(); } };
  const result = await readReleaseRecoveryHistory(backend);
  assert.equal(calls, 1); assert.equal(result.status, 'history-only-blocked'); denied(result);
  assert.equal(result.observationPhase, 'post-startup-reconciliation');
  assert.equal(result.rows[0]!.originalActive, false); assert.equal(result.rows[0]!.unknownOperations, 1);
  assert.equal(result.rows[0]!.classification, 'unresolved-observed');
});
test('opaque status-only preflight history preserves immutable unknown without claiming release structure or active ownership', async () => {
  const payload: any = record(); payload.preflightRefusalRecoveries = [{ status: 'released' }];
  const before = JSON.stringify(payload), result = await readReleaseRecoveryHistory(reader([payload]));
  assert.equal(result.rows[0]!.classification, 'unresolved-observed');
  assert.equal(result.rows[0]!.releaseStructureObserved, false);
  assert.equal(result.rows[0]!.opaquePreflightHistoryObserved, true);
  assert.equal(result.rows[0]!.originalActive, false); assert.equal(result.rows[0]!.operations[0]!.originalStatus, 'unknown');
  assert.equal(result.rows[0]!.strictFinalizationVerified, false); assert.equal(JSON.stringify(payload), before); denied(result);
});
test('terminal rows and empty census do not authorize a new run or adopt an epoch', async () => {
  const payload: any = record(); payload.hardwareBusy = false; payload.status = payload.phase = 'completed'; payload.operations = [];
  const result = await readReleaseRecoveryHistory(reader([payload]));
  assert.equal(result.rows[0]!.classification, 'terminal-history-unqualified'); denied(result);
  const empty = await readReleaseRecoveryHistory(reader([])); assert.equal(empty.rows.length, 0); denied(empty);
});
test('release-shaped historical fields cannot hide current activity or unresolved semantic unknown', async () => {
  for (const semantic of [false, true]) {
    const payload: any = record(); payload.preflightRefusalRecoveries = [{ status: 'released' }];
    if (semantic) payload.operations[0].kind = 'semantic'; else payload.active = true;
    const result = await readReleaseRecoveryHistory(reader([payload]));
    assert.equal(result.rows[0]!.releaseStructureObserved, false);
    assert.equal(result.rows[0]!.classification, 'unresolved-observed'); denied(result);
  }
});
test('any invalid MAC or foreign profile rejects the whole supplied census without partial rows', async () => {
  for (const fault of ['mac', 'profile']) {
    const bad = record('bad-run'); if (fault === 'profile') bad.profileSha256 = 'f'.repeat(64);
    const result = await readReleaseRecoveryHistory({ async readExistingHistory() {
      const badRaw = fault === 'mac' ? Buffer.from(raw(bad).toString().replace(/"mac": "./, '"mac": "z')) : raw(bad);
      return loadReadonlyHistory([{ name: 'old-run.json', raw: raw(record()) }, { name: 'bad-run.json', raw: badRaw }], key) as any;
    } });
    assert.equal(result.status, 'history-read-held'); assert.equal(result.rows.length, 0); denied(result);
  }
});
test('read failures never leak error paths, keys or partial history', async () => {
  const result = await readReleaseRecoveryHistory({ async readExistingHistory(): Promise<any> { throw Error('SECRET-key-path'); } });
  assert.equal(result.status, 'history-read-held'); assert(!JSON.stringify(result).includes('SECRET')); denied(result);
  assert.equal(result.observationPhase, 'post-startup-reconciliation');
});
test('non-acquisition projections and authority booleans cannot substitute for backend readonly census', async () => {
  for (const mutation of [(s: any) => { s.observerKind = 'injected-memory-bytes'; },
    (s: any) => { s.schemaVersion = 2; }, (s: any) => { s.foreignReleaseAuthority = true; },
    (s: any) => { s.admissionAuthorized = true; }, (s: any) => { s.acquisition.jsonCensusStableAcrossRead = false; },
    (s: any) => { s.records.push(s.records[0]); }, (s: any) => { delete s.records[0]; },
    (s: any) => { s.records.map = () => []; },
    (s: any) => { Object.defineProperty(s.records, '0', { get() { throw Error('Accessor must not run'); }, enumerable: true }); }]) {
    const snapshot = structuredClone(await reader().readExistingHistory()); mutation(snapshot);
    const result = await readReleaseRecoveryHistory({ async readExistingHistory() { return snapshot; } });
    assert.equal(result.status, 'history-read-held'); assert.equal(result.rows.length, 0); denied(result);
  }
});
