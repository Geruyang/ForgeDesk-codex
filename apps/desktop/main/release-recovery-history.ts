import type { Fz3bBackend } from '../../../packages/engineering-runner/fz3b/backend.js';

type Reader = Pick<Fz3bBackend, 'readExistingHistory'>;
type Snapshot = Awaited<ReturnType<Reader['readExistingHistory']>>;
const SHA = /^[a-f0-9]{64}$/;
const denied = { admissionAuthorized: false, releaseAuthorized: false, newRunAuthorized: false,
  activeEpochAdopted: false, currentBootEstablished: false, automaticReplay: false,
  strictFinalizationVerified: false, operationalQuarantineVerified: false } as const;

function need(ok: unknown): asserts ok { if (!ok) throw new Error('Startup history projection refused'); }
function data(value: unknown, depth = 0, budget = { left: 200000 }): void {
  need(--budget.left >= 0 && depth <= 52);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { need(Number.isFinite(value)); return; }
  need(typeof value === 'object' && value !== null);
  const array = Array.isArray(value);
  need(Object.getPrototypeOf(value) === (array ? Array.prototype : Object.prototype));
  const keys = Reflect.ownKeys(value);
  if (array) need(keys.length === (value as unknown[]).length + 1);
  for (const key of keys) {
    need(typeof key === 'string');
    if (array && key === 'length') continue;
    if (array) need(/^(0|[1-9]\d*)$/.test(key) && Number(key) < (value as unknown[]).length);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    need(descriptor.get === undefined && descriptor.set === undefined && descriptor.enumerable);
    data(descriptor.value, depth + 1, budget);
  }
}

function project(snapshot: Snapshot) {
  data(snapshot);
  const snapshotKeys = ['schemaVersion', 'kind', 'records', 'suppliedBytes', 'suppliedEntriesSha256', 'historicalHoldObserved',
    'status', 'observerKind', 'diskInventoryComplete', 'durableQuarantineVerified', 'nestedEvidenceQualified',
    'currentBootEstablished', 'activeEpochAdopted', 'admissionAuthorized', 'releaseAuthorized', 'newRunAuthorized',
    'testDeploymentAuthorized', 'finalReleaseAuthorized', 'automaticReplay', 'unknownHistoryRewritten', 'acquisition'];
  need(Object.keys(snapshot).length === snapshotKeys.length && Object.keys(snapshot).every(key => snapshotKeys.includes(key)));
  need(snapshot.schemaVersion === 1 && snapshot.kind === 'readonly-supplied-history-subset' &&
    snapshot.status === 'history-only-blocked' && snapshot.observerKind === 'backend-existing-history-readonly' &&
    snapshot.acquisition?.method === 'backend-existing-history-readonly-v1' &&
    snapshot.acquisition.jsonCensusStableAcrossRead === true && snapshot.acquisition.completeOperationalQuarantine === false &&
    snapshot.diskInventoryComplete === false && snapshot.durableQuarantineVerified === false && snapshot.nestedEvidenceQualified === false &&
    snapshot.currentBootEstablished === false && snapshot.activeEpochAdopted === false && snapshot.admissionAuthorized === false &&
    snapshot.releaseAuthorized === false && snapshot.newRunAuthorized === false && snapshot.testDeploymentAuthorized === false &&
    snapshot.finalReleaseAuthorized === false && snapshot.automaticReplay === false && snapshot.unknownHistoryRewritten === false &&
    typeof snapshot.suppliedEntriesSha256 === 'string' && SHA.test(snapshot.suppliedEntriesSha256) &&
    Array.isArray(snapshot.records) && snapshot.records.length <= 128);
  const names = new Set<string>();
  const rows = snapshot.records.map(row => {
    const rowKeys = ['schemaVersion', 'kind', 'filename', 'envelopeSha256', 'envelopeBytes', 'rawEnvelopeHex', 'record',
      'historicalProfileSha256', 'macVerifiedForSuppliedKey', 'nestedEvidenceQualified', 'inspectReleaseStructures',
      'originalHoldReasons', 'observerKind', 'liveObservation', 'diskInventoryComplete', 'currentBootEstablished',
      'activeEpochAdopted', 'releaseAuthorized', 'newRunAuthorized', 'testDeploymentAuthorized', 'finalReleaseAuthorized',
      'automaticReplay', 'unknownHistoryRewritten'];
    need(Object.keys(row).length === rowKeys.length && Object.keys(row).every(key => rowKeys.includes(key)));
    need(typeof row.filename === 'string' && !names.has(row.filename) && row.filename === row.record.runId + '.json');
    names.add(row.filename);
    need(row.schemaVersion === 1 && row.kind === 'readonly-historical-ledger-bytes' && row.macVerifiedForSuppliedKey === true &&
      row.nestedEvidenceQualified === false && typeof row.envelopeSha256 === 'string' && SHA.test(row.envelopeSha256) &&
      Array.isArray(row.originalHoldReasons) && row.originalHoldReasons.every((v: unknown) => typeof v === 'string') &&
      Array.isArray(row.inspectReleaseStructures) && row.inspectReleaseStructures.every((v: unknown) => typeof v === 'string'));
    const record = row.record;
    need(['active', 'completed', 'stopped', 'needs_attention'].includes(record.status) &&
      ['active', 'hardwareBusy', 'stopRequested'].every(key => typeof record[key] === 'boolean') &&
      Array.isArray(record.operations) && Array.isArray(record.calls));
    const operations = record.operations.map((op: any) => {
      need(typeof op.id === 'string' && ['build', 'inspect', 'semantic'].includes(op.kind) &&
        ['prepared', 'running', 'succeeded', 'failed', 'unknown'].includes(op.status));
      return Object.freeze({ id: op.id as string, kind: op.kind as string, originalStatus: op.status as string });
    });
    const unknownOperations = operations.filter(op => op.originalStatus === 'unknown').length;
    const unknownCalls = record.calls.filter((call: any) => call.status === 'unknown').length;
    const releaseStructureObserved = row.inspectReleaseStructures.length > 0;
    const opaquePreflightHistoryObserved = (record.preflightRefusalRecoveries?.length ?? 0) > 0;
    // The reader's complete hold inventory takes precedence over any historical structure hint.
    const unresolvedObserved = row.originalHoldReasons.length > 0 || record.active || record.hardwareBusy ||
      ['pending', 'unknown'].includes(record.nativeApproval) ||
      operations.some(op => ['prepared', 'running', 'unknown'].includes(op.originalStatus)) ||
      record.calls.some((call: any) => ['running', 'unknown'].includes(call.status));
    const classification = unresolvedObserved ? 'unresolved-observed' :
      releaseStructureObserved ? 'historical-release-structure-unqualified' : 'terminal-history-unqualified';
    return Object.freeze({ filename: row.filename, runId: record.runId as string, envelopeSha256: row.envelopeSha256,
      originalStatus: record.status as string, originalPhase: record.phase as string,
      originalActive: record.active as boolean, originalHardwareBusy: record.hardwareBusy as boolean,
      originalNativeApproval: record.nativeApproval as string, unknownOperations, unknownCalls,
      originalHoldReasons: Object.freeze([...row.originalHoldReasons]), operations: Object.freeze(operations),
      classification, releaseStructureObserved, opaquePreflightHistoryObserved, strictFinalizationVerified: false as const });
  });
  return Object.freeze({ schemaVersion: 1 as const, status: 'history-only-blocked' as const,
    observationPhase: 'post-startup-reconciliation' as const,
    observation: 'stable-existing-json-census' as const, failure: null,
    suppliedEntriesSha256: snapshot.suppliedEntriesSha256, rows: Object.freeze(rows), ...denied });
}

/** Post-startup-reconciliation diagnostic only; existing startup recovery may already have saved records. */
export async function readReleaseRecoveryHistory(backend: Reader) {
  try { return project(await backend.readExistingHistory()); }
  catch {
    // Do not publish arbitrary filesystem errors, key paths or partial successful rows.
    return Object.freeze({ schemaVersion: 1 as const, status: 'history-read-held' as const,
      observationPhase: 'post-startup-reconciliation' as const,
      observation: 'unavailable' as const, failure: 'history-read-or-validation-refused' as const,
      suppliedEntriesSha256: null, rows: Object.freeze([]), ...denied });
  }
}
