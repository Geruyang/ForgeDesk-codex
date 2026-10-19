import path from 'node:path';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS } from './preflight-refusal-proof.js';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from './preflight-recovery.js';
import type { Fz3bBinding } from './types.js';

export const FZ3B_HOST_FINALIZATION_DOMAIN = 'ForgeDesk/FZ3B/PreflightHostFinalization/v1\0';
export const FZ3B_HOST_FINALIZATION_PRODUCER = 'forgedesk-main-host-finalization-v1';
export const FZ3B_HOST_FINALIZATION_LIMITS = Object.freeze({
  snapshotBytes: 16 * 1024 * 1024, certificateBytes: 64 * 1024, certificateEntries: 16, checkpointTotalBytes: 256 * 1024 * 1024,
});
export const fz3bHostFinalizationDigest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));

export interface Fz3bPreflightHostCompletionBinding {
  schemaVersion: 1; method: 'fz3b-preflight-host-completion-binding-v1'; purpose: 'exact-local-preflight-host-finish-only';
  owner: Required<Pick<Fz3bBinding, 'runId' | 'taskId' | 'sessionId' | 'threadId' | 'turnId' | 'model' | 'generation'>>;
  recoveryId: string; operationId: string; nonce: string; profileSha256: string; resourceManifestSha256: string;
  checkpointSha256: string; checkpointEnvelopeSha256: string; sourceRecordSha256: string; sourceProjectionSha256: string;
  maintenanceExitSha256: string | null; originalHistorySha256: string; contextSha256: string; proofSha256: string;
  finalizationSha256: string; ackSha256: string; acknowledgmentSha256: string; closureSha256: string; closureIssuedAt: string;
  completeChainSha256: string; originalUnknownPreserved: true; remoteQuiescence: 'not-established';
  newBootIdentity: 'not-observed-or-adopted'; localProcessesClosed: true; leaseAndBarrierAbsent: true;
}
export interface Fz3bHostTargetProjection {
  schemaVersion: 1; project: { id: string; root: string; name: string };
  session: { id: string; taskId: string; projectId: string; threadId: string; model: string; engineProfile: 'fz3b';
    status: 'needs_attention'; historyIncomplete: true; engineUncertain: false; turnId: null; messagesSha256: string };
}
export interface Fz3bHostFinalizationBody {
  schemaVersion: 1; method: 'fz3b-preflight-host-finalization-v1'; certificateId: string; issuedAt: string;
  producerVersion: typeof FZ3B_HOST_FINALIZATION_PRODUCER; storeIdentitySha256: string;
  completion: Fz3bPreflightHostCompletionBinding; target: Fz3bHostTargetProjection; targetSha256: string;
  snapshot: { sha256: string; bytes: number; checkpointSha256: string; checkpointFile: string };
}
export interface Fz3bHostFinalizationCertificate extends Fz3bHostFinalizationBody { mac: string }
export interface Fz3bHostFinalizationExpected {
  storeIdentitySha256: string; producerVersion: typeof FZ3B_HOST_FINALIZATION_PRODUCER;
}

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(`FZ3B_HOST_FINALIZATION_${code}`); }
function hash(value: unknown): value is string { return typeof value === 'string' && SHA.test(value); }
function text(value: unknown, limit = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0'); }
function plain(value: unknown, allowUndefined = false, depth = 0, budget = { nodes: 0 }): void {
  check(depth <= 24 && ++budget.nodes <= 200000, 'JSON_BUDGET');
  if (value === null || typeof value === 'boolean' || allowUndefined && value === undefined) return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'NUMBER'); return; }
  if (typeof value === 'string') { check(value.length <= FZ3B_HOST_FINALIZATION_LIMITS.snapshotBytes, 'STRING_BUDGET'); return; }
  check(value && typeof value === 'object' && [Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)), 'PLAIN_JSON');
  check(Object.getOwnPropertySymbols(value).length === 0, 'SYMBOLS');
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && name === 'length') continue;
    check(descriptor.enumerable && 'value' in descriptor, 'JSON_DESCRIPTOR'); plain(descriptor.value, allowUndefined, depth + 1, budget);
  }
  if (Array.isArray(value)) check(Object.keys(value).length === value.length, 'SPARSE_ARRAY');
}
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'OBJECT');
  const keys = Reflect.ownKeys(value);
  check(keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key)) && required.every(key => keys.includes(key)), 'CLOSED_SCHEMA');
}
function at(value: unknown): number {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'TIME'); return Date.parse(value);
}
function same(a: unknown, b: unknown) { return fz3bCanonicalJson(a) === fz3bCanonicalJson(b); }
const bindingKeys = ['schemaVersion', 'method', 'purpose', 'owner', 'recoveryId', 'operationId', 'nonce', 'profileSha256', 'resourceManifestSha256',
  'checkpointSha256', 'checkpointEnvelopeSha256', 'sourceRecordSha256', 'sourceProjectionSha256', 'maintenanceExitSha256', 'originalHistorySha256',
  'contextSha256', 'proofSha256', 'finalizationSha256', 'ackSha256', 'acknowledgmentSha256', 'closureSha256', 'closureIssuedAt', 'completeChainSha256',
  'originalUnknownPreserved', 'remoteQuiescence', 'newBootIdentity', 'localProcessesClosed', 'leaseAndBarrierAbsent'];

/** Format validation only. Authority comes from the backend's authenticated readonly method. */
export function assertFz3bPreflightHostCompletionBinding(value: unknown): asserts value is Fz3bPreflightHostCompletionBinding {
  plain(value); shape(value, bindingKeys);
  check(value.schemaVersion === 1 && value.method === 'fz3b-preflight-host-completion-binding-v1' && value.purpose === 'exact-local-preflight-host-finish-only', 'BINDING_METHOD');
  shape(value.owner, ['runId', 'taskId', 'sessionId', 'threadId', 'turnId', 'model', 'generation']);
  check(['runId', 'taskId', 'sessionId', 'threadId', 'turnId'].every(key => text(value.owner[key])) && value.owner.runId === FZ3B_PREFLIGHT_RECOVERY_CASE.runId &&
    value.owner.model === FZ3B_PROFILE.model && Number.isSafeInteger(value.owner.generation) && value.owner.generation >= 0, 'OWNER');
  check(typeof value.recoveryId === 'string' && UUID.test(value.recoveryId) && value.operationId === FZ3B_PREFLIGHT_RECOVERY_CASE.operationId &&
    value.nonce === FZ3B_PREFLIGHT_RECOVERY_CASE.nonce && value.profileSha256 === FZ3B_PREFLIGHT_REFUSAL_PINS.profile &&
    value.resourceManifestSha256 === FZ3B_PREFLIGHT_REFUSAL_PINS.manifest, 'EXACT_CASE');
  check(['checkpointSha256', 'checkpointEnvelopeSha256', 'sourceRecordSha256', 'sourceProjectionSha256', 'originalHistorySha256', 'contextSha256',
    'proofSha256', 'finalizationSha256', 'ackSha256', 'acknowledgmentSha256', 'closureSha256', 'completeChainSha256'].every(key => hash(value[key])) &&
    (value.maintenanceExitSha256 === null || hash(value.maintenanceExitSha256)), 'CHAIN_HASH');
  at(value.closureIssuedAt);
  check(value.originalUnknownPreserved === true && value.remoteQuiescence === 'not-established' && value.newBootIdentity === 'not-observed-or-adopted' &&
    value.localProcessesClosed === true && value.leaseAndBarrierAbsent === true, 'PRESERVATION');
  const { completeChainSha256, ...body } = value;
  check(completeChainSha256 === fz3bHostFinalizationDigest(body), 'CHAIN_DIGEST');
}

export function assertFz3bHostTargetProjection(value: unknown, binding: Fz3bPreflightHostCompletionBinding): asserts value is Fz3bHostTargetProjection {
  assertFz3bPreflightHostCompletionBinding(binding); plain(value); shape(value, ['schemaVersion', 'project', 'session']);
  shape(value.project, ['id', 'root', 'name']);
  check(value.schemaVersion === 1 && text(value.project.id) && text(value.project.name, 10000) && text(value.project.root, 32768) &&
    (path.win32.isAbsolute(value.project.root) || path.posix.isAbsolute(value.project.root)), 'PROJECT');
  shape(value.session, ['id', 'taskId', 'projectId', 'threadId', 'model', 'engineProfile', 'status', 'historyIncomplete', 'engineUncertain', 'turnId', 'messagesSha256']);
  const session = value.session, owner = binding.owner;
  check(session.id === owner.sessionId && session.taskId === owner.taskId && session.projectId === value.project.id && session.threadId === owner.threadId &&
    session.model === owner.model && session.engineProfile === 'fz3b' && session.status === 'needs_attention' && session.historyIncomplete === true &&
    session.engineUncertain === false && session.turnId === null && hash(session.messagesSha256), 'TERMINAL_TARGET');
}

/** Validate full known inputs first. Only the display title is deliberately not bound. */
export function fz3bHostTargetProjection(project: unknown, session: unknown, binding: Fz3bPreflightHostCompletionBinding): Fz3bHostTargetProjection {
  plain(project); plain(session, true);
  shape(project, ['id', 'root', 'name']);
  shape(session, ['id', 'taskId', 'projectId', 'title', 'status', 'messages'], ['threadId', 'turnId', 'model', 'historyIncomplete', 'engineUncertain', 'engineProfile']);
  check(typeof session.title === 'string' && session.title.length <= 10000 && !session.title.includes('\0') && session.turnId === undefined && Array.isArray(session.messages), 'SESSION');
  check(Buffer.byteLength(JSON.stringify({ project, session })) <= FZ3B_HOST_FINALIZATION_LIMITS.snapshotBytes, 'TARGET_BYTE_BUDGET');
  for (const message of session.messages) {
    shape(message, ['id', 'role', 'text', 'timestamp'], ['status']);
    check(text(message.id) && ['user', 'assistant', 'tool', 'system'].includes(message.role) && typeof message.text === 'string' &&
      (message.status === undefined || text(message.status)), 'MESSAGE'); at(message.timestamp);
  }
  const result: Fz3bHostTargetProjection = { schemaVersion: 1, project: { id: project.id, root: project.root, name: project.name },
    session: { id: session.id, taskId: session.taskId, projectId: session.projectId, threadId: session.threadId, model: session.model,
      engineProfile: session.engineProfile, status: session.status, historyIncomplete: session.historyIncomplete, engineUncertain: session.engineUncertain,
      turnId: null, messagesSha256: fz3bHostFinalizationDigest(session.messages) } };
  assertFz3bHostTargetProjection(result, binding); return result;
}

const bodyKeys = ['schemaVersion', 'method', 'certificateId', 'issuedAt', 'producerVersion', 'storeIdentitySha256', 'completion', 'target', 'targetSha256', 'snapshot'];
/** No MAC, save-success or filesystem authentication is performed by this pure validator. */
export function assertFz3bHostFinalizationBody(value: unknown, binding: Fz3bPreflightHostCompletionBinding, expected: Fz3bHostFinalizationExpected): asserts value is Fz3bHostFinalizationBody {
  plain(value); shape(value, bodyKeys); assertFz3bPreflightHostCompletionBinding(binding);
  shape(expected, ['storeIdentitySha256', 'producerVersion']);
  check(hash(expected.storeIdentitySha256) && expected.producerVersion === FZ3B_HOST_FINALIZATION_PRODUCER, 'EXPECTED_IDENTITY');
  check(value.schemaVersion === 1 && value.method === 'fz3b-preflight-host-finalization-v1' && typeof value.certificateId === 'string' && UUID.test(value.certificateId) &&
    value.producerVersion === expected.producerVersion && value.storeIdentitySha256 === expected.storeIdentitySha256, 'CERTIFICATE_IDENTITY');
  check(at(value.issuedAt) >= at(binding.closureIssuedAt), 'CERTIFICATE_TIME');
  check(same(value.completion, binding), 'COMPLETION_CHANGED'); assertFz3bHostTargetProjection(value.target, binding);
  check(value.targetSha256 === fz3bHostFinalizationDigest(value.target), 'TARGET_DIGEST');
  shape(value.snapshot, ['sha256', 'bytes', 'checkpointSha256', 'checkpointFile']);
  check(hash(value.snapshot.sha256) && value.snapshot.checkpointSha256 === value.snapshot.sha256 && Number.isSafeInteger(value.snapshot.bytes) &&
    value.snapshot.bytes > 0 && value.snapshot.bytes <= FZ3B_HOST_FINALIZATION_LIMITS.snapshotBytes &&
    value.snapshot.checkpointFile === `${binding.owner.runId}/${value.certificateId}.desktop.json`, 'SNAPSHOT');
  check(Buffer.byteLength(fz3bCanonicalJson(value)) <= FZ3B_HOST_FINALIZATION_LIMITS.certificateBytes, 'CERTIFICATE_BYTE_BUDGET');
}

/** Structural gate only. The trusted main component must verify its independent domain MAC. */
export function assertFz3bHostFinalizationCertificate(value: unknown, binding: Fz3bPreflightHostCompletionBinding, expected: Fz3bHostFinalizationExpected): asserts value is Fz3bHostFinalizationCertificate {
  plain(value); shape(value, [...bodyKeys, 'mac']); check(hash(value.mac), 'MAC_FORMAT');
  check(Buffer.byteLength(fz3bCanonicalJson(value)) <= FZ3B_HOST_FINALIZATION_LIMITS.certificateBytes, 'CERTIFICATE_BYTE_BUDGET');
  const { mac: _mac, ...body } = value; assertFz3bHostFinalizationBody(body, binding, expected);
}
