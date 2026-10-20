import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { assertHistoricalFz3bProfileBinding } from './profile-history.js';
import { fz3bReleasedInspectReconciliation } from './reconciliation.js';
import type { Fz3bRunView } from './types.js';

const LIMIT = 2 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const PART = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const TOOLS = ['fz3b_status', 'fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic', 'fz3b_semantic', 'fz3b_export'];
type Data = Record<string, any>;
const requireValue = (ok: unknown, reason: string): void => { if (!ok) throw new Error('readonly-history-' + reason); };
const hash = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0');
const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
function object(v: unknown): v is Data { return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype; }
function closed(v: unknown, required: string[], optional: string[], reason: string): asserts v is Data {
  requireValue(object(v), reason);
  const keys = Reflect.ownKeys(v as object);
  requireValue(required.every(k => Object.hasOwn(v as object, k)) &&
    keys.every(k => typeof k === 'string' && [...required, ...optional].includes(k) &&
      Object.getOwnPropertyDescriptor(v, k)?.get === undefined && Object.getOwnPropertyDescriptor(v, k)?.set === undefined), reason);
}
function boundedTree(value: unknown): void {
  let nodes = 0;
  function walk(v: unknown, depth: number): void {
    requireValue(++nodes <= 100000 && depth <= 48, 'json-budget');
    if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child, depth + 1);
  }
  walk(value, 0);
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    for (const child of Object.values(v)) freeze(child);
    Object.freeze(v);
  }
  return v;
}

const RECORD_REQUIRED = ['runId', 'sessionId', 'taskId', 'model', 'generation', 'threadId', 'schemaVersion',
  'profileId', 'profileSha256', 'status', 'phase', 'active', 'hardwareBusy', 'stopRequested', 'nativeApproval',
  'createdAt', 'updatedAt', 'calls', 'operations', 'step', 'results', 'receipts'];
const RECORD_OPTIONAL = ['turnId', 'instruction', 'currentTool', 'artifact', 'identity', 'grant', 'semantic',
  'export', 'failure', 'reconciliations', 'maintenanceExit', 'preflightRefusalRecoveries'];

function checkRecord(record: unknown, filename: string): Data {
  closed(record, RECORD_REQUIRED, RECORD_OPTIONAL, 'record-schema');
  requireValue(record.schemaVersion === 1 && typeof record.runId === 'string' && PART.test(record.runId) &&
    filename === record.runId + '.json', 'record-leaf-binding');
  const historical = assertHistoricalFz3bProfileBinding({ profileId: record.profileId, profileSha256: record.profileSha256 });
  requireValue(record.model === historical.profile.model && [record.sessionId, record.taskId, record.threadId].every(v => text(v)) &&
    Number.isSafeInteger(record.generation) && record.generation >= 0 && Number.isSafeInteger(record.step) && record.step >= 0 && record.step <= 5,
  'record-context');
  requireValue(['active', 'completed', 'stopped', 'needs_attention'].includes(record.status) &&
    ['ready', 'building', 'inspecting', 'awaiting_native_approval', 'semantic', 'exporting', 'completed', 'stopped', 'needs_attention'].includes(record.phase) &&
    ['not_requested', 'pending', 'approved', 'cancelled', 'expired', 'unknown'].includes(record.nativeApproval) &&
    ['active', 'hardwareBusy', 'stopRequested'].every(k => typeof record[k] === 'boolean') && date(record.createdAt) && date(record.updatedAt), 'record-state');
  for (const k of ['turnId', 'failure']) if (Object.hasOwn(record, k)) requireValue(text(record[k], k === 'failure' ? 2000 : 512), 'record-text');
  if (Object.hasOwn(record, 'instruction')) requireValue(typeof record.instruction === 'string' && record.instruction.length <= 16384, 'instruction');
  if (Object.hasOwn(record, 'currentTool')) requireValue(TOOLS.includes(record.currentTool), 'current-tool');
  requireValue(Array.isArray(record.operations) && record.operations.length <= 1000 && Array.isArray(record.calls) && record.calls.length <= 1000 &&
    object(record.results) && Object.keys(record.results).every(k => TOOLS.includes(k) && k !== 'fz3b_status') && object(record.receipts), 'record-collections');
  const ids = new Set<string>();
  for (const op of record.operations) {
    closed(op, ['id', 'requestKey', 'nonce', 'kind', 'status', 'dispatchPhase', 'createdAt', 'updatedAt'],
      ['processExited', 'remoteQuiescent', 'evidenceSha256', 'detail', 'progress'], 'operation-schema');
    requireValue(typeof op.id === 'string' && PART.test(op.id) && !ids.has(op.id) && text(op.requestKey) &&
      typeof op.nonce === 'string' && SHA.test(op.nonce) && ['build', 'inspect', 'semantic'].includes(op.kind) &&
      ['prepared', 'running', 'succeeded', 'failed', 'unknown'].includes(op.status) && ['not-started', 'may-have-started'].includes(op.dispatchPhase) &&
      date(op.createdAt) && date(op.updatedAt), 'operation-state');
    ids.add(op.id);
    for (const k of ['processExited', 'remoteQuiescent']) if (Object.hasOwn(op, k)) requireValue(typeof op[k] === 'boolean', 'operation-flag');
    if (Object.hasOwn(op, 'evidenceSha256')) requireValue(typeof op.evidenceSha256 === 'string' && SHA.test(op.evidenceSha256), 'operation-evidence-hash');
  }
  const calls = new Set<string>();
  for (const call of record.calls) {
    closed(call, ['callId', 'tool', 'receivedAt', 'status'], ['completedAt', 'operationId', 'replayedFromCallId', 'error', 'result'], 'call-schema');
    requireValue(text(call.callId, 256) && !calls.has(call.callId) && TOOLS.includes(call.tool) && date(call.receivedAt) &&
      ['running', 'succeeded', 'failed', 'unknown', 'replayed', 'rejected', 'stopped'].includes(call.status), 'call-state');
    calls.add(call.callId);
    if (Object.hasOwn(call, 'operationId')) requireValue(typeof call.operationId === 'string' && ids.has(call.operationId), 'orphan-call');
    if (Object.hasOwn(call, 'completedAt')) requireValue(date(call.completedAt), 'call-date');
  }
  for (const k of ['artifact', 'identity', 'grant', 'semantic', 'export', 'maintenanceExit'])
    if (Object.hasOwn(record, k)) requireValue(object(record[k]), 'opaque-evidence-object');
  for (const k of ['reconciliations', 'preflightRefusalRecoveries'])
    if (Object.hasOwn(record, k)) requireValue(Array.isArray(record[k]) && record[k].length <= 1000, 'opaque-evidence-array');
  // Nested receipt/grant/recovery evidence stays opaque unless the existing
  // exact structural predicate below recognizes it. It never supplies authority.
  return record;
}

export function decodeReadonlyLedger(raw: Buffer, filename: string, ownedKey: Buffer) {
  requireValue(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= LIMIT, 'raw-budget');
  requireValue(typeof filename === 'string' && filename.endsWith('.json') && PART.test(filename.slice(0, -5)), 'leaf-name');
  requireValue(Buffer.isBuffer(ownedKey) && ownedKey.length === 32, 'owned-key');
  const bytes = Buffer.from(raw), key = Buffer.from(ownedKey), utf8 = bytes.toString('utf8');
  requireValue(Buffer.from(utf8, 'utf8').equals(bytes), 'utf8');
  const envelope = JSON.parse(utf8);
  boundedTree(envelope);
  closed(envelope, ['payload', 'mac'], [], 'envelope-schema');
  // Actual durableJson byte shape also rejects duplicate keys, alternate key
  // spellings and extra trailing data without changing the original MAC recipe.
  requireValue(JSON.stringify(envelope, null, 2) === utf8, 'durable-envelope-encoding');
  requireValue(typeof envelope.mac === 'string' && SHA.test(envelope.mac), 'mac-shape');
  const expected = createHmac('sha256', key).update(JSON.stringify(envelope.payload)).digest();
  key.fill(0);
  requireValue(timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex')), 'integrity');
  const record = checkRecord(envelope.payload, filename);
  const historical = assertHistoricalFz3bProfileBinding({ profileId: record.profileId, profileSha256: record.profileSha256 });
  const holds: string[] = [];
  if (record.active) holds.push('original-active');
  if (record.hardwareBusy) holds.push('original-hardware-busy');
  if (['pending', 'unknown'].includes(record.nativeApproval)) holds.push('original-native-' + record.nativeApproval);
  for (const op of record.operations) {
    if (['prepared', 'running', 'unknown'].includes(op.status)) holds.push('original-operation-' + op.id + '-' + op.status);
    if (op.kind !== 'build' && (op.processExited !== true || op.remoteQuiescent !== true)) holds.push('original-quiescence-unproven-' + op.id);
  }
  for (const call of record.calls) if (['running', 'unknown'].includes(call.status)) holds.push('original-call-' + call.callId + '-' + call.status);
  if (record.preflightRefusalRecoveries?.length) holds.push('preflight-post-save-ack-closure-not-acquired');
  const inspectReleaseStructures = record.operations.filter((op: any) =>
    fz3bReleasedInspectReconciliation(record as Fz3bRunView, op, historical.fixture)).map((op: any) => op.id);
  return freeze({ schemaVersion: 1, kind: 'readonly-historical-ledger-bytes', filename,
    envelopeSha256: hash(bytes), envelopeBytes: bytes.length, rawEnvelopeHex: bytes.toString('hex'), record,
    historicalProfileSha256: historical.profileSha256, macVerifiedForSuppliedKey: true,
    nestedEvidenceQualified: false, inspectReleaseStructures, originalHoldReasons: holds,
    observerKind: 'injected-memory-bytes', liveObservation: false, diskInventoryComplete: false,
    currentBootEstablished: false, activeEpochAdopted: false, releaseAuthorized: false,
    newRunAuthorized: false, testDeploymentAuthorized: false, finalReleaseAuthorized: false,
    automaticReplay: false, unknownHistoryRewritten: false });
}

export function loadReadonlyHistory(entries: { name: string; raw: Buffer }[], ownedKey: Buffer) {
  requireValue(Array.isArray(entries) && Object.getPrototypeOf(entries) === Array.prototype && entries.length <= 128, 'snapshot-array');
  const descriptors = Object.getOwnPropertyDescriptors(entries);
  const keys = Reflect.ownKeys(descriptors);
  requireValue(keys.length === entries.length + 1 && keys.every(k => {
    if (k === 'length') return true;
    if (typeof k !== 'string' || !/^(0|[1-9]\d*)$/.test(k) || Number(k) >= entries.length) return false;
    const d = Object.getOwnPropertyDescriptor(entries, k)!;
    return d.enumerable === true && d.get === undefined && d.set === undefined;
  }), 'snapshot-array');
  requireValue(Buffer.isBuffer(ownedKey) && ownedKey.length === 32, 'owned-key');
  let total = 0;
  const seen = new Set<string>();
  const rows = entries.map(entry => {
    closed(entry, ['name', 'raw'], [], 'snapshot-entry');
    requireValue(typeof entry.name === 'string' && !seen.has(entry.name), 'duplicate-leaf');
    seen.add(entry.name);
    requireValue(Buffer.isBuffer(entry.raw), 'snapshot-raw');
    total += entry.raw.length; requireValue(total <= 32 * 1024 * 1024, 'snapshot-byte-budget');
    return decodeReadonlyLedger(entry.raw, entry.name, ownedKey);
  }).sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
  const mapping = Object.fromEntries(rows.map(row => [row.filename, row.envelopeSha256]));
  return freeze({ schemaVersion: 1, kind: 'readonly-supplied-history-subset', records: rows,
    suppliedBytes: total, suppliedEntriesSha256: hash(JSON.stringify(mapping)),
    historicalHoldObserved: rows.some(row => row.originalHoldReasons.length > 0),
    status: 'history-only-blocked', observerKind: 'injected-memory-bytes',
    diskInventoryComplete: false, durableQuarantineVerified: false, nestedEvidenceQualified: false,
    currentBootEstablished: false, activeEpochAdopted: false, admissionAuthorized: false,
    releaseAuthorized: false, newRunAuthorized: false, testDeploymentAuthorized: false,
    finalReleaseAuthorized: false, automaticReplay: false, unknownHistoryRewritten: false });
}
