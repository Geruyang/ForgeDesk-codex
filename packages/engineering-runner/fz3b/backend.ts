import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { durableJson, noLinks, safePart } from '../embedded/files.js';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest, fz3bProfileSha256, validateFz3bFixture, validateFz3bIdentity } from './profile.js';
import { assertFz3bReconciliationContext, assertFz3bReconciliationProof, assertFz3bReconciliationFinalization,
  fz3bReleasedInspectReconciliation, fz3bReconciliationOwnerBinding, fz3bOriginalInspectionContext } from './reconciliation.js';
import { verifyFz3bPreflightRefusal } from './preflight-refusal-proof.js';
import { assertFz3bPreflightHostCompletionBinding, type Fz3bPreflightHostCompletionBinding } from './host-finalization.js';
import { noLinksFz3bHostSync, fz3bHostRootIdentitySync, readFz3bHostWitnessSync } from './host-finalization-witness.js';
import { captureProductionFz3bHostCompletionWitness } from './worker.js';
import { loadReadonlyHistory } from './history-readonly.js';
import { currentSid, fz3bHostDependencyAclSync, fz3bPrivateAclBatchSync } from './credentials.js';
import { FZ3B_PREFLIGHT_ACK_DOMAIN, FZ3B_PREFLIGHT_CLOSURE_DOMAIN, fz3bPreflightRecordProjection, fz3bPreflightAnchor, fz3bReleasedPreflightRefusalRecovery,
  assertFz3bPreflightRecoveryContext, assertFz3bPreflightRecoveryProof, assertFz3bPreflightRecoveryFinalization,
  assertFz3bPreflightRecoveryAck, assertFz3bPreflightRecoveryAcknowledgment, assertFz3bPreflightRecoveryClosure } from './preflight-recovery.js';
import { FZ3B_TOOLS, type Fz3bAdapter, type Fz3bAdapterContext, type Fz3bBinding, type Fz3bBuildReceipt,
  type Fz3bCallAudit, type Fz3bGrantPreview, type Fz3bInspectReceipt, type Fz3bOperation, type Fz3bQuiescence,
  type Fz3bRunView, type Fz3bSemanticFixture, type Fz3bSemanticReceipt,
  type Fz3bInspectReconciliationContext, type Fz3bInspectReconciliationProof, type Fz3bInspectReconciliationFinalization,
  type Fz3bInspectReconciliation, type Fz3bMaintenanceExitSeal,
  type Fz3bPreflightRefusalRecovery, type Fz3bPreflightRefusalRecoveryContext, type Fz3bPreflightRefusalRecoveryAck,
  type Fz3bPreflightRefusalRecoveryAcknowledgment,
  type Fz3bPreflightRefusalRecoveryClosure,
  type Fz3bToolContext, type Fz3bToolName, type Fz3bToolResult } from './types.js';

export interface Fz3bBackendOptions {
  dataDir: string; fixture: Fz3bSemanticFixture; adapter: Fz3bAdapter;
  /** Main owns native confirmation; never expose this callback as model/UI approval IPC. */
  requestSemantic(preview: Fz3bGrantPreview, signal: AbortSignal): Promise<boolean>;
  assertOwner(binding: Fz3bBinding): void | Promise<void>;
  assertRecoveryOwner?(binding: Fz3bBinding): void | Promise<void>;
  requestInspectReconciliation?(context: Fz3bInspectReconciliationContext, signal: AbortSignal): Promise<boolean>;
  requestPreflightRefusalRecovery?(context: Fz3bPreflightRefusalRecoveryContext, signal: AbortSignal): Promise<boolean>;
  checkRuntime(): Promise<void>; onChange?: () => void; now?: () => number;
}
type Action = Exclude<Fz3bToolName, 'fz3b_status'>;
type Receipt = Fz3bBuildReceipt | Fz3bInspectReceipt | Fz3bSemanticReceipt;
interface RecordState extends Fz3bRunView {
  step: number; results: Partial<Record<Action, Fz3bToolResult>>; receipts: Record<string, Receipt>;
}
const ORDER: Action[] = ['fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic', 'fz3b_semantic', 'fz3b_export'];
const SHA = /^[a-f0-9]{64}$/;
const MAX_RUN_BYTES = 2 * 1024 * 1024;
const RECONCILIATION_MAX_AGE = 120000;
const digest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));
const clone = <T>(value: T): T => structuredClone(value);
function same(a: unknown, b: unknown): boolean { return fz3bCanonicalJson(a) === fz3bCanonicalJson(b); }
function text(value: unknown, limit = 512): value is string { return typeof value === 'string' && !!value && value.length <= limit && !value.includes('\0'); }
function hash(value: unknown): value is string { return typeof value === 'string' && SHA.test(value); }
function onlyKeys(value: object, allowed: string[]): boolean {
  return !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key));
}
class KnownFailure extends Error {}
interface HostCompletionRead {
  backend: Fz3bBackend; dataRoot: ReturnType<typeof fz3bHostRootIdentitySync>; digest: string;
  expiresAt: bigint; consumed: boolean; current(): void;
}
const hostCompletionReads = new WeakMap<object, HostCompletionRead>();
/** Main-only runtime provenance; a JSON copy or pure-format binding is never a read ticket. */
export function assertFz3bHostCompletionRead(value: unknown, backend: Fz3bBackend, expectedDataDir: string): asserts value is Fz3bPreflightHostCompletionBinding {
  if (!value || typeof value !== 'object') throw new Error('FZ3B_HOST_COMPLETION_READ_REQUIRED');
  const ticket = hostCompletionReads.get(value);
  if (!ticket || ticket.backend !== backend) throw new Error('FZ3B_HOST_COMPLETION_READ_REQUIRED');
  assertFz3bPreflightHostCompletionBinding(value);
  if (process.hrtime.bigint() > ticket.expiresAt ||
      !same(ticket.dataRoot, fz3bHostRootIdentitySync(expectedDataDir)) || digest(value) !== ticket.digest) throw new Error('FZ3B_HOST_COMPLETION_READ_REQUIRED');
  ticket.current();
}
/** Consumption gates minting once; subsequent assertions may still verify readonly freshness. */
export function consumeFz3bHostCompletionRead(value: unknown, backend: Fz3bBackend, expectedDataDir: string): void {
  assertFz3bHostCompletionRead(value, backend, expectedDataDir);
  const ticket = hostCompletionReads.get(value)!;
  if (ticket.consumed) throw new Error('FZ3B_HOST_COMPLETION_READ_ALREADY_CONSUMED'); ticket.consumed = true;
}

/** Dedicated bounded FZ3B run ledger. It has no SSH, shell, deployment or loader API. */
export class Fz3bBackend {
  private readonly directory: string;
  private readonly fixture: Fz3bSemanticFixture;
  private readonly profileHash: string;
  private readonly records = new Map<string, RecordState>();
  private readonly pending = new Map<string, Promise<Fz3bToolResult>>();
  private readonly pendingCalls = new Map<string, string>();
  private readonly dialogs = new Map<string, AbortController>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly settling = new Set<string>();
  private readonly reconciling = new Set<string>();
  private readonly exporting = new Set<string>();
  private readonly verifiedPreflights = new Map<string, { ack: Fz3bPreflightRefusalRecoveryAck; acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment; closure: Fz3bPreflightRefusalRecoveryClosure }>();
  private initialization?: Promise<void>;
  private key?: Buffer;
  private starting = false;
  private persistenceFailed = false;
  private hostReadEpoch = 0;
  constructor(private readonly options: Fz3bBackendOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new Error('FZ3B data directory must be host-owned and absolute');
    validateFz3bFixture(options.fixture); this.fixture = clone(options.fixture);
    this.profileHash = fz3bProfileSha256(this.fixture);
    this.directory = path.join(options.dataDir, 'fz3b-agent');
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private iso() { return new Date(this.now()).toISOString(); }
  private mac(payload: unknown) { return createHmac('sha256', this.key!).update(JSON.stringify(payload)).digest('hex'); }
  private record(id: string) { const record = this.records.get(id); if (!record) throw new Error('Unknown FZ3B run'); return record; }
  private released(record: RecordState, operation: Fz3bOperation): boolean {
    if (fz3bReleasedInspectReconciliation(record, operation, this.fixture)) return true;
    const completion = this.verifiedPreflights.get(record.runId);
    if (!completion) return false;
    try { this.verifyPreflightClosure(record, completion.ack, completion.acknowledgment, completion.closure); }
    catch { return false; }
    return !!fz3bReleasedPreflightRefusalRecovery(this.preflightView(record), operation, this.fixture);
  }
  private preflightView(record: RecordState): RecordState {
    const value = clone(record), completion = this.verifiedPreflights.get(record.runId);
    const last = value.preflightRefusalRecoveries?.at(-1);
    if (last && completion) { last.ack = clone(completion.ack); last.acknowledgment = clone(completion.acknowledgment); last.closure = clone(completion.closure); }
    return value;
  }
  private hardwareHeld(record: RecordState): boolean {
    return record.hardwareBusy && !(this.verifiedPreflights.has(record.runId) && record.operations.every(op => !this.blocking(record, op)));
  }
  private blocking(record: RecordState, operation: Fz3bOperation): boolean {
    return ['prepared', 'running', 'unknown'].includes(operation.status) && !this.released(record, operation);
  }
  private busy(record: RecordState) {
    return this.persistenceFailed || this.pending.has(record.runId) || this.settling.has(record.runId) || this.reconciling.has(record.runId) ||
      record.operations.some(op => this.blocking(record, op));
  }
  private view(record: RecordState): Fz3bRunView {
    const { step: _step, results: _results, receipts: _receipts, ...view } = this.preflightView(record);
    view.hardwareBusy = this.hardwareHeld(record) || this.busy(record);
    return clone(view);
  }
  private attention(record: RecordState, message: string) {
    record.active = false; record.stopRequested = true; record.status = 'needs_attention'; record.phase = 'needs_attention';
    record.failure = message.slice(0, 2000); this.dialogs.get(record.runId)?.abort();
    if (record.nativeApproval === 'approved' && !record.grant?.consumedBy) record.nativeApproval = 'cancelled';
  }
  private async init(): Promise<void> {
    this.initialization ??= (async () => {
      await mkdir(this.directory, { recursive: true }); await noLinks(this.directory);
      const keyFile = path.join(this.directory, 'binding.key');
      try {
        const handle = await open(keyFile, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await noLinks(keyFile);
      const keyInfo = await lstat(keyFile);
      if (!keyInfo.isFile() || keyInfo.nlink !== 1 || keyInfo.size !== 32) throw new Error('FZ3B ledger key is invalid');
      this.key = await readFile(keyFile);
      for (const entry of await readdir(this.directory, { withFileTypes: true })) {
        if (!entry.name.endsWith('.json')) continue;
        const file = path.join(this.directory, entry.name); await noLinks(file);
        const info = await lstat(file);
        if (!entry.isFile() || !info.isFile() || info.nlink !== 1 || info.size > MAX_RUN_BYTES) throw new Error('FZ3B ledger file is invalid');
        const raw = await readFile(file);
        if (raw.length > MAX_RUN_BYTES) throw new Error('FZ3B ledger exceeded limit');
        const envelope = JSON.parse(raw.toString('utf8')) as { payload: RecordState; mac: string };
        const expected = Buffer.from(this.mac(envelope.payload), 'hex');
        const actual = hash(envelope.mac) ? Buffer.from(envelope.mac, 'hex') : Buffer.alloc(0);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('FZ3B ledger integrity failed');
        const record = envelope.payload;
        if (record.schemaVersion !== 1 || `${safePart(record.runId)}.json` !== entry.name || record.profileSha256 !== this.profileHash ||
            record.profileId !== FZ3B_PROFILE.id || !Array.isArray(record.operations) || !Array.isArray(record.calls)) throw new Error('FZ3B ledger profile changed');
        this.records.set(record.runId, record);
        if (record.preflightRefusalRecoveries?.length) {
          // A visible signed release checkpoint is not proof its save succeeded.
          // Only a separately issued post-save ACK plus worker closure can release it.
          try { await this.readPreflightCompletion(record); } catch { /* Incomplete checkpoint remains held, no action is replayed. */ }
          continue;
        }
        if (record.active || record.hardwareBusy || record.calls.some(call => call.status === 'running') || record.operations.some(op => this.blocking(record, op))) {
          this.attention(record, 'Application restarted; planning stopped and no action was replayed');
          if (record.nativeApproval === 'pending') record.nativeApproval = 'unknown';
          for (const call of record.calls) if (call.status === 'running') { call.status = 'unknown'; call.error = record.failure; }
          for (const op of record.operations) if (['prepared', 'running'].includes(op.status)) {
            op.status = op.dispatchPhase === 'may-have-started' ? 'unknown' : 'failed';
            op.processExited = op.dispatchPhase === 'not-started'; op.remoteQuiescent = op.dispatchPhase === 'not-started';
          }
          record.hardwareBusy = record.operations.some(op => this.blocking(record, op));
          await this.save(record);
        }
      }
    })();
    await this.initialization;
  }
  private async save(record: RecordState): Promise<void> {
    record.updatedAt = this.iso(); const payload = clone(record);
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RUN_BYTES) { this.persistenceFailed = true; this.attention(record, 'FZ3B ledger byte budget exhausted'); throw new Error(record.failure); }
    const previous = this.writes.get(record.runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await noLinks(this.directory);
      await durableJson(path.join(this.directory, `${safePart(record.runId)}.json`), { payload, mac: this.mac(payload) });
    });
    this.writes.set(record.runId, next);
    try { await next; this.options.onChange?.(); }
    catch (error) { this.persistenceFailed = true; record.hardwareBusy = true; this.attention(record, `FZ3B persistence failed: ${String(error)}`); throw error; }
    finally { if (this.writes.get(record.runId) === next) this.writes.delete(record.runId); }
  }
  async start(binding: Fz3bBinding): Promise<Fz3bRunView> {
    await this.init(); safePart(binding.runId); safePart(binding.taskId);
    if (binding.model !== FZ3B_PROFILE.model || ![binding.sessionId, binding.threadId].every(value => text(value)) ||
        !Number.isSafeInteger(binding.generation) || binding.generation < 0 || (binding.turnId !== undefined && !text(binding.turnId)) ||
        (binding.instruction !== undefined && (typeof binding.instruction !== 'string' || binding.instruction.length > 16384))) throw new Error('FZ3B binding is invalid');
    if (this.records.has(binding.runId)) throw new Error('FZ3B runs are never resumed');
    if (this.starting || this.persistenceFailed || this.pending.size || this.settling.size || this.writes.size || this.exporting.size || [...this.records.values()].some(record => record.active || this.hardwareHeld(record) || this.busy(record))) throw new Error('FZ3B run is active or held');
    this.starting = true;
    try {
      await this.options.assertOwner(binding); await this.options.checkRuntime();
      const record: RecordState = { ...clone(binding), schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: this.profileHash,
        status: 'active', phase: 'ready', active: true, hardwareBusy: false, stopRequested: false, nativeApproval: 'not_requested',
        createdAt: this.iso(), updatedAt: this.iso(), calls: [], operations: [], step: 0, results: {}, receipts: {} };
      this.records.set(record.runId, record); await this.save(record); return this.view(record);
    } finally { this.starting = false; }
  }
  async bindTurn(runId: string, binding: { generation: number; threadId: string; turnId: string }): Promise<void> {
    await this.init(); const record = this.record(runId);
    if (record.generation !== binding.generation || record.threadId !== binding.threadId || !text(binding.turnId) || (record.turnId && record.turnId !== binding.turnId)) throw new Error('FZ3B turn binding mismatch');
    if (!record.turnId) { record.turnId = binding.turnId; await this.save(record); }
  }
  private context(record: RecordState, context: Fz3bToolContext) {
    if (record.runId !== context.runId || record.sessionId !== context.sessionId || record.taskId !== context.taskId || record.generation !== context.generation ||
        record.threadId !== context.threadId || !text(context.turnId) || (record.turnId && record.turnId !== context.turnId) || !text(context.callId, 256)) throw new Error('FZ3B tool context mismatch');
  }
  async status(runId?: string): Promise<Fz3bRunView | undefined> {
    await this.init(); const record = runId ? this.records.get(runId) : [...this.records.values()].at(-1);
    return record ? this.view(record) : undefined;
  }
  async list(): Promise<Fz3bRunView[]> { await this.init(); return [...this.records.values()].map(record => this.view(record)); }
  /** Inspect existing historical bytes only. No initialization, repair or operational-map insertion. */
  async readExistingHistory() {
    if (arguments.length !== 0) throw new Error('FZ3B_HISTORY_READ_NO_ARGUMENTS');
    const sid = await currentSid();
    const dataRoot = fz3bHostRootIdentitySync(this.options.dataDir);
    const ledgerRoot = fz3bHostRootIdentitySync(this.directory);
    const directoryIdentity = (file: string) => {
      const info = lstatSync(file);
      if (!info.isDirectory()) throw new Error('FZ3B_HISTORY_READ_DIRECTORY');
      return { dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, size: info.size,
        uid: info.uid, gid: info.gid, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, birthtimeMs: info.birthtimeMs };
    };
    const dataMetadata = directoryIdentity(this.options.dataDir), ledgerMetadata = directoryIdentity(this.directory);
    fz3bHostDependencyAclSync(this.options.dataDir, sid);
    const census = () => {
      const entries = [...readdirSync(this.directory, { withFileTypes: true })];
      if (entries.length > 129 || !entries.some(entry => entry.name === 'binding.key') || entries.some(entry =>
        !entry.isFile() || entry.name !== 'binding.key' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.json$/.test(entry.name))) {
        throw new Error('FZ3B_HISTORY_READ_CENSUS');
      }
      return entries.map(entry => entry.name).sort();
    };
    const names = census(), files = names.filter(name => name !== 'binding.key');
    const checkRoots = () => {
      if (!same(dataRoot, fz3bHostRootIdentitySync(this.options.dataDir)) ||
          !same(ledgerRoot, fz3bHostRootIdentitySync(this.directory)) ||
          !same(dataMetadata, directoryIdentity(this.options.dataDir)) || !same(ledgerMetadata, directoryIdentity(this.directory)) || !same(names, census())) {
        throw new Error('FZ3B_HISTORY_READ_CENSUS_CHANGED');
      }
    };
    const checkFilesAcl = () => {
      for (let offset = 0; offset < files.length; offset += 51)
        fz3bPrivateAclBatchSync(files.slice(offset, offset + 51).map(name => path.join(this.directory, name)), sid);
    };
    const captures: ReturnType<typeof readFz3bHostWitnessSync>[] = [];
    let reserved = 0;
    const read = (name: string, limit: number) => {
      const file = path.join(this.directory, name);
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > limit ||
          reserved + info.size + 1 > 64 * 1024 * 1024) throw new Error('FZ3B_HISTORY_READ_BUDGET_OR_METADATA');
      reserved += info.size + 1;
      const captured = readFz3bHostWitnessSync(file, info.size);
      if (name === 'binding.key') captures.push(captured);
      return captured;
    };
    try {
      checkFilesAcl(); checkRoots();
      const key = read('binding.key', 32);
      if (key.bytes.length !== 32) throw new Error('FZ3B_HISTORY_READ_KEY');
      const records = files.map(name => ({ name, captured: read(name, MAX_RUN_BYTES) }));
      const result = loadReadonlyHistory(records.map(row => ({ name: row.name, raw: row.captured.bytes })), key.bytes);
      checkRoots();
      for (const row of [{ name: 'binding.key', captured: key }, ...records]) {
        const again = read(row.name, row.name === 'binding.key' ? 32 : MAX_RUN_BYTES);
        if (again.identity !== row.captured.identity || !again.bytes.equals(row.captured.bytes)) throw new Error('FZ3B_HISTORY_READ_CONTENT_CHANGED');
      }
      fz3bHostDependencyAclSync(this.options.dataDir, sid); checkFilesAcl(); checkRoots();
      for (const row of [{ name: 'binding.key', captured: key }, ...records]) {
        const file = path.join(this.directory, row.name);
        noLinksFz3bHostSync(file);
        const info = lstatSync(file);
        const identity = fz3bCanonicalJson({ dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink,
          size: info.size, uid: info.uid, gid: info.gid, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
        if (!info.isFile() || info.nlink !== 1 || identity !== row.captured.identity) throw new Error('FZ3B_HISTORY_READ_FINAL_IDENTITY_CHANGED');
      }
      checkRoots();
      return Object.freeze({ ...result, observerKind: 'backend-existing-history-readonly', acquisition: Object.freeze({ method: 'backend-existing-history-readonly-v1',
        jsonCensusStableAcrossRead: true, completeOperationalQuarantine: false, reservedReadBytes: reserved }) });
    } finally {
      for (const captured of captures) captured.bytes.fill(0);
    }
  }
  async executeTool(context: Fz3bToolContext, name: Fz3bToolName, args: unknown): Promise<Fz3bToolResult> {
    await this.init(); const record = this.record(context.runId); this.context(record, context);
    if (!FZ3B_TOOLS.includes(name) || !args || typeof args !== 'object' || Array.isArray(args) || Reflect.ownKeys(args).length || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
      this.attention(record, 'FZ3B tools accept only the fixed allowlist and empty arguments'); await this.save(record); throw new Error(record.failure);
    }
    if (!record.turnId) await this.bindTurn(record.runId, context);
    const old = record.calls.find(call => call.callId === context.callId);
    if (old) {
      if (old.tool !== name) { this.attention(record, 'FZ3B call ID reused with another tool'); await this.save(record); throw new Error(record.failure); }
      if (this.pendingCalls.get(record.runId) === context.callId) return this.pending.get(record.runId)!;
      return old.result ? clone(old.result) : { runId: record.runId, callId: context.callId, tool: name, ok: false, result: 'unknown', phase: record.phase, message: 'Prior action was not replayed' };
    }
    if (!record.active && (record.preflightRefusalRecoveries?.length || record.operations.some(operation => this.released(record, operation)))) {
      return { runId: record.runId, callId: context.callId, tool: name, ok: false, result: 'stopped', phase: record.phase, message: 'Reconciled inspect history is frozen; a separate new run is required' };
    }
    if (record.calls.length >= 100) { this.attention(record, 'FZ3B call budget exhausted'); await this.save(record); throw new Error(record.failure); }
    const audit: Fz3bCallAudit = { callId: context.callId, tool: name, receivedAt: this.iso(), status: 'running' };
    record.calls.push(audit);
    if (name === 'fz3b_status') {
      const result: Fz3bToolResult = { runId: record.runId, callId: audit.callId, tool: name, ok: true, result: 'status', phase: record.phase,
        artifact: record.artifact, identity: record.identity, semantic: record.semantic, message: record.failure };
      audit.status = 'succeeded'; audit.completedAt = this.iso(); audit.result = result; await this.save(record); return clone(result);
    }
    if (!record.active || record.stopRequested || record.status !== 'active') {
      const result: Fz3bToolResult = { runId: record.runId, callId: audit.callId, tool: name, ok: false, result: record.status === 'stopped' ? 'stopped' : 'unknown', phase: record.phase, message: 'FZ3B planning is stopped or held' };
      audit.status = 'rejected'; audit.result = result; audit.completedAt = this.iso(); await this.save(record); return clone(result);
    }
    const prior = record.results[name];
    if (prior) {
      const result = { ...clone(prior), callId: audit.callId };
      audit.status = 'replayed'; audit.replayedFromCallId = prior.callId; audit.result = result; audit.completedAt = this.iso(); await this.save(record); return clone(result);
    }
    if (this.pending.has(record.runId) || ORDER[record.step] !== name) {
      this.attention(record, 'FZ3B action out of sequence or another action is pending'); audit.status = 'rejected'; audit.error = record.failure;
      const result: Fz3bToolResult = { runId: record.runId, callId: audit.callId, tool: name, ok: false, result: 'failed', phase: record.phase, message: record.failure };
      audit.result = result; audit.completedAt = this.iso(); await this.save(record); return result;
    }
    let pending!: Promise<Fz3bToolResult>;
    pending = (async () => {
      await Promise.resolve();
      let result: Fz3bToolResult | undefined;
      try { result = await this.perform(record, name, audit); return result; }
      finally {
        this.settling.add(record.runId);
        this.pending.delete(record.runId); this.pendingCalls.delete(record.runId);
        record.hardwareBusy = this.persistenceFailed || record.operations.some(op => ['prepared', 'running', 'unknown'].includes(op.status));
        try { await this.save(record); }
        catch {
          if (result) { result.ok = false; result.result = 'unknown'; result.phase = record.phase; result.message = record.failure; }
          audit.status = 'unknown'; audit.result = result;
        } finally { this.settling.delete(record.runId); }
      }
    })();
    this.pending.set(record.runId, pending); this.pendingCalls.set(record.runId, audit.callId);
    return pending;
  }
  private assertActive(record: RecordState) {
    if (!record.active || record.stopRequested || this.persistenceFailed) throw new Error('FZ3B planning stopped before dispatch');
  }
  private receipt(record: RecordState, operation: Fz3bOperation, receipt: Receipt) {
    const commonKeys = ['schemaVersion', 'operationId', 'nonce', 'profileSha256', 'status', 'processExited', 'remoteQuiescent', 'remoteOutcomeUnknown', 'evidenceSha256', 'detail', 'kind'];
    const extraKeys = operation.kind === 'build' ? ['sourceManifestSha256', 'fixtureManifestSha256', 'queriesSha256', 'imageSha256', 'newPlBuilt', 'deployed', 'packageSha256', 'packageManifestSha256'] :
      operation.kind === 'inspect' ? ['identity', 'readOnly'] : ['identity', 'semantic', 'grantId'];
    if (!receipt || !onlyKeys(receipt, [...commonKeys, ...extraKeys]) || Buffer.byteLength(JSON.stringify(receipt)) > 128 * 1024 ||
        (receipt.detail !== undefined && !text(receipt.detail, 2000)) || receipt.schemaVersion !== 1 || receipt.operationId !== operation.id || receipt.nonce !== operation.nonce || receipt.profileSha256 !== this.profileHash || receipt.kind !== operation.kind ||
        !hash(receipt.evidenceSha256) || !['succeeded', 'failed', 'unknown'].includes(receipt.status) || typeof receipt.processExited !== 'boolean' || typeof receipt.remoteQuiescent !== 'boolean' || typeof receipt.remoteOutcomeUnknown !== 'boolean') throw new Error('FZ3B receipt is not context-bound');
    operation.processExited = receipt.processExited; operation.remoteQuiescent = receipt.remoteQuiescent; operation.evidenceSha256 = receipt.evidenceSha256;
    if (receipt.processExited !== true || receipt.remoteQuiescent !== true || receipt.remoteOutcomeUnknown !== false) throw new Error('FZ3B receipt is not terminal and quiescent');
    if (receipt.status === 'failed') { operation.status = 'failed'; throw new KnownFailure(receipt.detail ?? 'FZ3B worker failed with confirmed quiescence'); }
    if (receipt.status !== 'succeeded') throw new Error('FZ3B worker outcome unknown');
    if (receipt.kind === 'build') {
      if (receipt.sourceManifestSha256 !== FZ3B_PROFILE.deployedManifestSha256 || receipt.fixtureManifestSha256 !== this.fixture.manifestSha256 || receipt.queriesSha256 !== this.fixture.queriesSha256 || receipt.imageSha256 !== this.fixture.imageSha256 ||
          receipt.newPlBuilt !== false || receipt.deployed !== false || !hash(receipt.packageSha256) || !hash(receipt.packageManifestSha256)) throw new Error('FZ3B package receipt changed the approved inputs or scope');
      const body = { kind: 'fixed-ps-fixture-package' as const, buildId: operation.id, profileSha256: this.profileHash,
        sourceManifestSha256: receipt.sourceManifestSha256, fixtureManifestSha256: receipt.fixtureManifestSha256,
        queriesSha256: receipt.queriesSha256, imageSha256: receipt.imageSha256, buildEvidenceSha256: receipt.evidenceSha256,
        packageSha256: receipt.packageSha256, packageManifestSha256: receipt.packageManifestSha256, newPlBuilt: false as const, deployed: false as const };
      record.artifact = { id: fz3bDigest(JSON.stringify(body)), ...body };
    } else {
      if (!receipt.identity) throw new Error('FZ3B successful identity receipt is missing');
      validateFz3bIdentity(receipt.identity);
      if (receipt.kind === 'inspect') {
        if (receipt.readOnly !== true) throw new Error('FZ3B inspect must not prepare or control the runtime');
        record.identity = clone(receipt.identity);
      } else {
        if (!same(receipt.identity, record.identity) || receipt.grantId !== record.grant?.id || record.grant?.consumedBy !== operation.id) throw new Error('FZ3B semantic identity or native grant changed');
        const semantic = receipt.semantic;
        if (!semantic || !onlyKeys(semantic, ['jobId', 'frameId', 'queryRevision', 'completedFrames', 'fixtureManifestSha256', 'queriesSha256', 'imageSha256', 'encoderIdentity', 'ranking', 'bestId', 'semanticInput', 'synthetic', 'classificationUnknown', 'threshold', 'thresholdHit', 'expectedLabel', 'expectedLabelMatched', 'inferenceStopped', 'newPlLoaded']) ||
            semantic.jobId !== `fd-semantic-${operation.id.replaceAll('-', '')}` || semantic.frameId !== 0 || !Number.isSafeInteger(semantic.queryRevision) || semantic.queryRevision < 1 ||
            semantic.completedFrames !== 1 || semantic.fixtureManifestSha256 !== this.fixture.manifestSha256 || semantic.queriesSha256 !== this.fixture.queriesSha256 || semantic.imageSha256 !== this.fixture.imageSha256 || !same(semantic.encoderIdentity, this.fixture.encoderIdentity) ||
            semantic.semanticInput !== 'real-text-encoder' || semantic.synthetic !== false || semantic.inferenceStopped !== true || semantic.newPlLoaded !== false ||
            typeof semantic.classificationUnknown !== 'boolean' || semantic.threshold !== 0.2 || typeof semantic.thresholdHit !== 'boolean' || semantic.expectedLabel !== this.fixture.expectedLabel || typeof semantic.expectedLabelMatched !== 'boolean' ||
            !Array.isArray(semantic.ranking) || semantic.ranking.length !== 4 || new Set(semantic.ranking.map(item => item.id)).size !== 4 ||
            semantic.ranking.some((item, index) => !item || !onlyKeys(item, ['id', 'label', 'score']) || !this.fixture.queryIds.includes(item.id) || item.label !== item.id || typeof item.score !== 'number' || !Number.isFinite(item.score) || Math.abs(item.score) > 1.001 || (index > 0 && item.score > semantic.ranking[index - 1].score)) ||
            semantic.bestId !== semantic.ranking[0].id || semantic.thresholdHit !== (semantic.ranking[0].score >= 0.2) || semantic.classificationUnknown !== !semantic.thresholdHit ||
            semantic.expectedLabelMatched !== (semantic.bestId === this.fixture.expectedLabel && semantic.ranking.slice(1).every(item => semantic.ranking[0].score > item.score))) throw new Error('FZ3B semantic result is not the fixed real-text single-image fixture');
        record.semantic = clone(semantic);
      }
    }
    operation.status = 'succeeded'; record.receipts[operation.id] = clone(receipt);
  }
  private grant(record: RecordState): Fz3bGrantPreview {
    if (!record.artifact || !record.identity) throw new Error('FZ3B package and inspected identity required');
    const createdMs = this.now();
    const body = { id: randomUUID(), runId: record.runId, sessionId: record.sessionId, taskId: record.taskId, artifactId: record.artifact.id,
      profileSha256: this.profileHash, identity: clone(record.identity), fixture: clone(this.fixture),
      scope: 'existing-candidate008-real-text-single-image-once' as const, actions: clone(FZ3B_PROFILE.actions), createdAt: new Date(createdMs).toISOString(), expiresAt: new Date(createdMs + 300000).toISOString() };
    return { ...body, planSha256: fz3bDigest(JSON.stringify(body)) };
  }
  private checkGrant(record: RecordState) {
    const grant = record.grant;
    const now = this.now(), created = Date.parse(grant?.createdAt ?? ''), approved = Date.parse(grant?.approvedAt ?? ''), expires = Date.parse(grant?.expiresAt ?? '');
    if (!grant || ![now, created, approved, expires].every(Number.isFinite) ||
        typeof grant.createdAt !== 'string' || typeof grant.approvedAt !== 'string' || typeof grant.expiresAt !== 'string' ||
        created > approved || approved > now || approved >= expires || expires <= now || expires - created > 300000 || grant.consumedBy ||
        grant.profileSha256 !== this.profileHash || grant.runId !== record.runId || grant.sessionId !== record.sessionId || grant.taskId !== record.taskId ||
        grant.artifactId !== record.artifact?.id || !same(grant.identity, record.identity) || !same(grant.fixture, this.fixture)) {
      if (grant && Number.isFinite(expires) && expires <= now) record.nativeApproval = 'expired';
      throw new Error('FZ3B native semantic grant is absent, expired, consumed or changed');
    }
    const { planSha256, approvedAt: _approved, consumedBy: _consumed, ...body } = grant;
    if (fz3bDigest(JSON.stringify(body)) !== planSha256) throw new Error('FZ3B native grant plan changed');
  }
  private async exportRecord(record: RecordState, manual = false): Promise<{ path: string; sha256: string }> {
    const parent = path.join(this.options.dataDir, 'exports', 'fz3b-agent');
    await mkdir(parent, { recursive: true }); await noLinks(parent);
    const output = path.join(parent, manual ? `${safePart(record.runId)}-snapshot-${randomUUID()}` : safePart(record.runId)); await mkdir(output); await noLinks(output);
    const files: { path: string; sha256: string; bytes: number }[] = [];
    let total = 0;
    for (const operation of record.operations) {
      if (!operation.evidenceSha256) continue;
      const evidence = await this.options.adapter.readPublicEvidence(operation.id, operation.evidenceSha256);
      if (!Array.isArray(evidence) || evidence.length > 3 || new Set(evidence.map(file => file.name)).size !== evidence.length || !evidence.some(file => file.name === 'evidence.json')) throw new Error('FZ3B worker evidence inventory is incomplete');
      const workerDirectory = path.join(output, 'workers', safePart(operation.id));
      await mkdir(workerDirectory, { recursive: true }); await noLinks(workerDirectory);
      for (const file of evidence) {
        const expected = file.name === 'evidence.json' ? operation.evidenceSha256 : operation.kind === 'build' && record.artifact?.buildId === operation.id ?
          file.name === 'ps-acceptance.tar' ? record.artifact.packageSha256 : file.name === 'package-manifest.json' ? record.artifact.packageManifestSha256 : undefined : undefined;
        if (!expected || !Buffer.isBuffer(file.bytes) || file.bytes.length > 4 * 1024 * 1024 || file.sha256 !== expected) throw new Error('FZ3B worker evidence is outside the fixed file/hash allowlist');
        const bytes = Buffer.from(file.bytes); total += bytes.length;
        if (total > 16 * 1024 * 1024 || fz3bDigest(bytes) !== expected) throw new Error('FZ3B worker evidence bytes changed or exceeded budget');
        const target = path.join(workerDirectory, file.name); const handle = await open(target, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if (fz3bDigest(await readFile(target)) !== expected) throw new Error('FZ3B exported worker evidence verification failed');
        files.push({ path: `workers/${operation.id}/${file.name}`, sha256: expected, bytes: bytes.length });
      }
      if (operation.kind === 'build' && operation.status === 'succeeded' && !['ps-acceptance.tar', 'package-manifest.json'].every(name => evidence.some(file => file.name === name))) throw new Error('FZ3B built package is missing from export');
    }
    for (const attempt of record.reconciliations ?? []) {
      if (!attempt.proof) continue;
      if (!this.options.adapter.readInspectReconciliationEvidence) throw new Error('FZ3B reconciliation evidence reader is unavailable');
      const evidence = await this.options.adapter.readInspectReconciliationEvidence(clone(attempt.context), clone(attempt.proof), clone(attempt.finalization));
      const names = attempt.finalization ? ['proof-evidence.json', 'finalization-evidence.json'] : ['proof-evidence.json'];
      if (!Array.isArray(evidence) || evidence.length !== names.length || new Set(evidence.map(file => file.name)).size !== names.length ||
          evidence.some(file => !names.includes(file.name))) throw new Error('FZ3B reconciliation evidence inventory is incomplete');
      const directory = path.join(output, 'reconciliations', safePart(attempt.context.id)); await mkdir(directory, { recursive: true }); await noLinks(directory);
      for (const file of evidence) {
        const expected = file.name === 'proof-evidence.json' ? attempt.proof.evidenceSha256 : attempt.finalization?.evidenceSha256;
        if (!expected || !Buffer.isBuffer(file.bytes) || file.bytes.length > 131072 || file.sha256 !== expected) throw new Error('FZ3B reconciliation export is outside its fixed file/hash allowlist');
        const bytes = Buffer.from(file.bytes); total += bytes.length;
        if (total > 16 * 1024 * 1024 || fz3bDigest(bytes) !== expected) throw new Error('FZ3B reconciliation evidence bytes changed or exceeded budget');
        const target = path.join(directory, file.name); const handle = await open(target, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if (fz3bDigest(await readFile(target)) !== expected) throw new Error('FZ3B exported reconciliation verification failed');
        files.push({ path: `reconciliations/${attempt.context.id}/${file.name}`, sha256: expected, bytes: bytes.length });
      }
    }
    const manifest = { schemaVersion: 1, scope: FZ3B_PROFILE.id, exportKind: manual ? 'local-snapshot' : 'model-tool', profile: FZ3B_PROFILE, fixture: this.fixture,
      run: this.view(record), receipts: record.receipts, files,
      limitations: ['Existing candidate008 only; no new PL build or deployment.', 'One predeclared real-text image is not general semantic accuracy or performance qualification.', 'SSH trust continuity is not HELLO authentication or bitstream attestation.'] };
    const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (raw.length > MAX_RUN_BYTES) throw new Error('FZ3B export budget exhausted');
    const handle = await open(path.join(output, 'manifest.json'), 'wx', 0o600);
    try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    return { path: output, sha256: fz3bDigest(raw) };
  }
  private async perform(record: RecordState, name: Action, audit: Fz3bCallAudit): Promise<Fz3bToolResult> {
    record.currentTool = name;
    record.phase = name === 'fz3b_build' ? 'building' : name === 'fz3b_inspect' ? 'inspecting' : name === 'fz3b_request_semantic' ? 'awaiting_native_approval' : name === 'fz3b_semantic' ? 'semantic' : 'exporting';
    let operation: Fz3bOperation | undefined; let dispatched = false;
    try {
      await this.save(record); await this.options.assertOwner(record); await this.options.checkRuntime(); this.assertActive(record);
      if (name === 'fz3b_request_semantic') {
        const preview = this.grant(record); record.grant = clone(preview); record.nativeApproval = 'pending';
        const controller = new AbortController(); this.dialogs.set(record.runId, controller);
        try {
          await this.save(record); this.assertActive(record);
          const approved = await this.options.requestSemantic(clone(preview), controller.signal);
          if (controller.signal.aborted || record.stopRequested) { record.nativeApproval = 'cancelled'; throw new KnownFailure('FZ3B native confirmation cancelled'); }
          const approvalNow = this.now(), approvalExpires = Date.parse(preview.expiresAt);
          if (!Number.isFinite(approvalNow) || !Number.isFinite(approvalExpires) || approvalExpires <= approvalNow || approvalExpires - approvalNow > 300000) {
            record.nativeApproval = 'expired'; throw new KnownFailure('FZ3B native confirmation expired');
          }
          if (approved !== true) { record.nativeApproval = 'cancelled'; throw new KnownFailure('FZ3B native confirmation refused'); }
          this.assertActive(record); record.grant.approvedAt = new Date(approvalNow).toISOString(); record.nativeApproval = 'approved';
        } finally { this.dialogs.delete(record.runId); }
      } else if (name === 'fz3b_export') {
        if (!record.semantic || !record.artifact) throw new Error('FZ3B verified semantic receipt required for export');
        record.export = await this.exportRecord(record);
      } else {
        const kind = name === 'fz3b_build' ? 'build' : name === 'fz3b_inspect' ? 'inspect' : 'semantic';
        if (kind !== 'build' && !record.artifact) throw new Error('FZ3B artifact required');
        if (kind === 'semantic') this.checkGrant(record);
        operation = { id: randomUUID(), requestKey: `fz3b-${fz3bDigest(`${record.runId}:${name}`)}`, nonce: randomBytes(32).toString('hex'), kind,
          status: 'prepared', dispatchPhase: 'not-started', createdAt: this.iso(), updatedAt: this.iso() };
        record.operations.push(operation); audit.operationId = operation.id; await this.save(record); this.assertActive(record);
        if (kind === 'semantic') { this.checkGrant(record); record.grant!.consumedBy = operation.id; }
        operation.status = 'running'; operation.dispatchPhase = 'may-have-started'; await this.save(record); this.assertActive(record);
        if (kind === 'semantic') {
          const dispatchNow = this.now(), dispatchExpires = Date.parse(record.grant!.expiresAt);
          if (!Number.isFinite(dispatchNow) || !Number.isFinite(dispatchExpires) || dispatchExpires <= dispatchNow || dispatchExpires - dispatchNow > 300000) {
            record.nativeApproval = 'expired'; throw new Error('FZ3B native grant expired during durable dispatch preparation');
          }
        }
        const context: Fz3bAdapterContext = { runId: record.runId, sessionId: record.sessionId, taskId: record.taskId, operationId: operation.id,
          requestKey: operation.requestKey, nonce: operation.nonce, profileSha256: this.profileHash, fixture: clone(this.fixture),
          artifact: clone(record.artifact), identity: clone(record.identity), grant: clone(record.grant) };
        dispatched = true;
        const receipt = kind === 'build' ? await this.options.adapter.build(context) : kind === 'inspect' ? await this.options.adapter.inspect(context) : await this.options.adapter.semantic(context);
        this.receipt(record, operation, receipt); operation.updatedAt = this.iso();
      }
      const result: Fz3bToolResult = { runId: record.runId, callId: audit.callId, tool: name, ok: true, result: 'succeeded', phase: record.phase,
        ...(operation ? { operation: clone(operation) } : {}), artifact: clone(record.artifact), identity: clone(record.identity), semantic: clone(record.semantic), export: clone(record.export) };
      audit.status = 'succeeded'; audit.completedAt = this.iso(); audit.result = result; record.results[name] = result; record.step++;
      if (record.status === 'needs_attention') record.phase = 'needs_attention';
      else if (record.stopRequested) { record.active = false; record.status = 'stopped'; record.phase = 'stopped'; }
      else if (record.step === ORDER.length) { record.active = false; record.status = 'completed'; record.phase = 'completed'; }
      else record.phase = 'ready';
      result.phase = record.phase; await this.save(record); return clone(result);
    } catch (error) {
      const uncertain = this.persistenceFailed || (dispatched && !(error instanceof KnownFailure));
      if (operation) { operation.status = uncertain ? 'unknown' : 'failed'; operation.updatedAt = this.iso(); operation.detail = String(error).slice(0, 2000); if (!dispatched) { operation.processExited = true; operation.remoteQuiescent = true; } }
      if (record.nativeApproval === 'pending') record.nativeApproval = record.stopRequested ? 'cancelled' : 'unknown';
      if (!record.stopRequested || record.status !== 'stopped') this.attention(record, String(error));
      record.hardwareBusy = uncertain || record.operations.some(op => ['prepared', 'running', 'unknown'].includes(op.status));
      const result: Fz3bToolResult = { runId: record.runId, callId: audit.callId, tool: name, ok: false, result: uncertain ? 'unknown' : record.status === 'stopped' ? 'stopped' : 'failed', phase: record.phase,
        ...(operation ? { operation: clone(operation) } : {}), message: String(error).slice(0, 2000) };
      audit.status = result.result === 'unknown' ? 'unknown' : result.result === 'stopped' ? 'stopped' : 'failed'; audit.completedAt = this.iso(); audit.error = result.message; audit.result = result;
      try { await this.save(record); } catch { result.result = 'unknown'; }
      return result;
    }
  }
  async stop(runId: string): Promise<Fz3bRunView> {
    await this.init(); const record = this.record(runId);
    if (record.preflightRefusalRecoveries?.at(-1)?.status === 'released') return this.view(record);
    record.active = false; record.stopRequested = true;
    if (record.status === 'active') { record.status = 'stopped'; record.phase = 'stopped'; }
    this.dialogs.get(runId)?.abort();
    if (record.nativeApproval === 'approved' && !record.grant?.consumedBy) record.nativeApproval = 'cancelled';
    record.hardwareBusy = this.busy(record); await this.save(record); return this.view(record);
  }
  async turnEnded(runId: string): Promise<Fz3bRunView> {
    await this.init(); const record = this.record(runId);
    if (record.active) { this.attention(record, 'Model turn ended before the fixed FZ3B workflow completed'); await this.save(record); }
    return this.view(record);
  }
  private ownerBinding(record: RecordState): Fz3bBinding {
    return fz3bReconciliationOwnerBinding(record);
  }
  private originalContext(record: RecordState, operation: Fz3bOperation): Fz3bAdapterContext {
    return fz3bOriginalInspectionContext(record, operation, this.fixture);
  }
  private locallySettled(record: RecordState): boolean {
    return !this.persistenceFailed && !record.active && !this.starting && !this.pending.size && !this.settling.size &&
      !this.dialogs.size && !this.writes.size && !this.reconciling.size && !this.exporting.size &&
      ![...this.records.values()].some(other => other !== record && (other.active || this.hardwareHeld(other) || this.busy(other)));
  }
  private inspectCandidate(record: RecordState): Fz3bOperation {
    const unknown = record.operations.filter(op => op.status === 'unknown');
    const operation = unknown[0];
    if (record.preflightRefusalRecoveries?.length || record.active || record.status !== 'needs_attention' || !record.stopRequested || record.grant || record.semantic ||
        record.nativeApproval !== 'not_requested' || !record.artifact || unknown.length !== 1 || !operation ||
        operation.kind !== 'inspect' || operation.processExited !== true || !hash(operation.evidenceSha256) ||
        record.operations.at(-1) !== operation || record.operations.some(op => op !== operation && (op.kind !== 'build' || op.status !== 'succeeded')) ||
        record.calls.some(call => !['fz3b_status', 'fz3b_build', 'fz3b_inspect'].includes(call.tool)) ||
        !record.calls.some(call => call.tool === 'fz3b_inspect' && call.status === 'unknown' && call.operationId === operation.id)) {
      throw new Error('FZ3B reconciliation is restricted to a settled, never-authorized inspect-only unknown');
    }
    if (record.reconciliations?.some(attempt => attempt.status === 'released') && !this.released(record, operation)) throw new Error('FZ3B released reconciliation proof changed; manual review is required');
    return operation;
  }
  private preflightAvailable(): boolean {
    const adapter = this.options.adapter;
    return !!this.options.assertRecoveryOwner && !!this.options.requestPreflightRefusalRecovery && !!adapter.preparePreflightRefusalRecovery &&
      !!adapter.readPreflightRefusalRecoveryInput && !!adapter.finalizePreflightRefusalRecovery && !!adapter.acknowledgePreflightRefusalRecovery &&
      !!adapter.readPreflightRefusalRecoveryCompletion && !!adapter.certifyPreflightRefusalRecovery;
  }
  private preflightCandidate(record: RecordState) {
    if (!record.preflightRefusalRecoveries?.length) return fz3bPreflightRecordProjection(JSON.parse(JSON.stringify(record)), this.fixture);
    if (record.preflightRefusalRecoveries.length !== 1) throw new Error('FZ3B local preflight recovery attempt count is not exact');
    if (record.preflightRefusalRecoveries[0].status !== 'released') throw new Error('FZ3B prior local recovery remains held; no automatic retry or finalization is allowed');
    const context = record.preflightRefusalRecoveries[0].context;
    this.assertPreflightUnchanged(record, context);
    return { sourceRun: clone(context.sourceRun), projection: clone(context.projection),
      maintenanceExitSha256: context.maintenanceExitSha256, sourceRecordSha256: context.sourceRecordSha256 };
  }
  private assertPreflightUnchanged(record: RecordState, context: Fz3bPreflightRefusalRecoveryContext) {
    assertFz3bPreflightRecoveryContext(context, this.fixture);
    if (!['Error: FZ3B receipt is not terminal and quiescent', 'Application restarted; planning stopped and no action was replayed'].includes(record.failure ?? '')) {
      throw new Error('FZ3B preflight source host state changed');
    }
    const { preflightRefusalRecoveries: _attempts, ...base } = JSON.parse(JSON.stringify(record)) as RecordState;
    base.updatedAt = context.sourceRun.updatedAt; base.failure = context.sourceRun.failure;
    if (digest(base) !== context.sourceRecordSha256) throw new Error('FZ3B preflight authenticated source record changed');
    fz3bPreflightRecordProjection(base, this.fixture);
  }
  private verifyPreflightAck(record: RecordState, ack: Fz3bPreflightRefusalRecoveryAck) {
    const attempt = record.preflightRefusalRecoveries?.at(-1);
    if (!attempt || attempt.status !== 'released' || !attempt.proof || !attempt.finalization || attempt.ack || attempt.acknowledgment) {
      throw new Error('FZ3B preflight post-save checkpoint is not exact');
    }
    this.assertPreflightUnchanged(record, attempt.context);
    assertFz3bPreflightRecoveryProof(attempt.context, attempt.proof);
    assertFz3bPreflightRecoveryFinalization(attempt.context, attempt.proof, attempt.finalization);
    assertFz3bPreflightRecoveryAck(attempt.context, attempt.proof, attempt.finalization, ack);
    const { mac, ...body } = ack;
    const expected = createHmac('sha256', this.key!).update(FZ3B_PREFLIGHT_ACK_DOMAIN).update(fz3bCanonicalJson(body)).digest();
    const actual = hash(mac) ? Buffer.from(mac, 'hex') : Buffer.alloc(0);
    if (ack.checkpointSha256 !== digest(record) || ack.checkpointUpdatedAt !== record.updatedAt || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('FZ3B preflight post-save ACK is not authenticated to this checkpoint');
    }
  }
  private async readPreflightCompletion(record: RecordState) {
    const attempt = record.preflightRefusalRecoveries?.at(-1);
    if (!attempt || attempt.status !== 'released' || !attempt.proof || !attempt.finalization || !this.options.adapter.readPreflightRefusalRecoveryCompletion) {
      throw new Error('FZ3B preflight completion is unavailable');
    }
    const result = await this.options.adapter.readPreflightRefusalRecoveryCompletion(clone(attempt.context), clone(attempt.proof), clone(attempt.finalization),
      value => this.verifyPreflightAck(record, value), (ack, acknowledgment, value) => this.verifyPreflightClosure(record, ack, acknowledgment, value));
    this.verifyPreflightClosure(record, result.ack, result.acknowledgment, result.closure);
    this.verifiedPreflights.set(record.runId, clone(result));
  }
  private verifyPreflightClosure(record: RecordState, ack: Fz3bPreflightRefusalRecoveryAck,
    acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment, closure: Fz3bPreflightRefusalRecoveryClosure) {
    this.verifyPreflightAck(record, ack);
    const attempt = record.preflightRefusalRecoveries!.at(-1)!;
    assertFz3bPreflightRecoveryAcknowledgment(attempt.context, attempt.proof!, attempt.finalization!, ack, acknowledgment);
    assertFz3bPreflightRecoveryClosure(attempt.context, attempt.proof!, attempt.finalization!, ack, acknowledgment, closure);
    const { mac, ...body } = closure;
    const expected = createHmac('sha256', this.key!).update(FZ3B_PREFLIGHT_CLOSURE_DOMAIN).update(fz3bCanonicalJson(body)).digest();
    const actual = hash(mac) ? Buffer.from(mac, 'hex') : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('FZ3B worker closure certificate is not authenticated');
  }
  private async readExactPreflightCheckpoint(record: RecordState): Promise<string> {
    const file = path.join(this.directory, `${safePart(record.runId)}.json`);
    await noLinks(file);
    const namedBefore = await lstat(file);
    if (!namedBefore.isFile() || namedBefore.nlink !== 1 || namedBefore.size < 1 || namedBefore.size > MAX_RUN_BYTES) throw new Error('FZ3B host checkpoint file is invalid');
    const identity = (info: Stats, crossApi = false) => ({ dev: info.dev, ino: info.ino, size: info.size, mode: info.mode,
      nlink: info.nlink, uid: info.uid, gid: info.gid, mtimeMs: info.mtimeMs, ...(!crossApi ? { ctimeMs: info.ctimeMs } : {}) });
    const handle = await open(file, 'r');
    let raw: Buffer;
    try {
      const before = await handle.stat();
      if (!same(identity(namedBefore, true), identity(before, true))) throw new Error('FZ3B host checkpoint identity changed');
      const buffer = Buffer.alloc(MAX_RUN_BYTES + 1); let bytes = 0;
      while (bytes < buffer.length) {
        const result = await handle.read(buffer, bytes, Math.min(65536, buffer.length - bytes), bytes);
        if (!result.bytesRead) break; bytes += result.bytesRead;
      }
      raw = buffer.subarray(0, bytes);
      if (raw.length !== before.size || raw.length > MAX_RUN_BYTES || !same(identity(before), identity(await handle.stat()))) throw new Error('FZ3B host checkpoint changed during read');
    } finally { await handle.close(); }
    await noLinks(file);
    if (!same(identity(namedBefore), identity(await lstat(file)))) throw new Error('FZ3B host checkpoint path changed during read');
    const encoded = raw.toString('utf8');
    if (!Buffer.from(encoded).equals(raw)) throw new Error('FZ3B host checkpoint UTF-8 changed');
    const envelope = JSON.parse(encoded) as { payload: RecordState; mac: string };
    if (!onlyKeys(envelope, ['payload', 'mac']) || Object.keys(envelope).length !== 2 || JSON.stringify(envelope, null, 2) !== encoded || !hash(envelope.mac)) {
      throw new Error('FZ3B host checkpoint envelope changed');
    }
    const expected = Buffer.from(this.mac(envelope.payload), 'hex'), actual = Buffer.from(envelope.mac, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || !same(envelope.payload, record)) throw new Error('FZ3B host checkpoint is not authenticated to the current record');
    return fz3bDigest(raw);
  }
  /** Readonly local evidence. It neither signs a host save nor changes the original unknown. */
  async readPreflightHostCompletion(runId: string): Promise<Fz3bPreflightHostCompletionBinding> {
    await this.init(); const epoch = ++this.hostReadEpoch, record = this.record(runId);
    if (!this.locallySettled(record)) throw new Error('FZ3B host completion is not locally settled');
    this.preflightCandidate(record);
    const attempt = record.preflightRefusalRecoveries?.at(-1);
    if (!attempt || attempt.status !== 'released' || !attempt.proof || !attempt.finalization) throw new Error('FZ3B authenticated preflight completion is required');
    this.reconciling.add(runId);
    try {
      await this.options.checkRuntime();
      const checkpointEnvelopeSha256 = await this.readExactPreflightCheckpoint(record);
      // Never retain an old positive cache after a fresh completion read failed.
      this.verifiedPreflights.delete(runId);
      await this.readPreflightCompletion(record);
      await this.options.checkRuntime();
      if (this.persistenceFailed || record.active || this.pending.size || this.settling.size || this.dialogs.size || this.writes.size || this.exporting.size ||
          [...this.records.values()].some(other => other !== record && (other.active || this.hardwareHeld(other) || this.busy(other)))) throw new Error('FZ3B host completion owner changed');
      if (checkpointEnvelopeSha256 !== await this.readExactPreflightCheckpoint(record)) throw new Error('FZ3B host checkpoint changed across completion verification');
      const completion = this.verifiedPreflights.get(runId)!;
      this.verifyPreflightClosure(record, completion.ack, completion.acknowledgment, completion.closure);
      const context = attempt.context;
      const body: Omit<Fz3bPreflightHostCompletionBinding, 'completeChainSha256'> = {
        schemaVersion: 1, method: 'fz3b-preflight-host-completion-binding-v1', purpose: 'exact-local-preflight-host-finish-only',
        owner: clone(context.anchor.owner), recoveryId: context.id, operationId: context.original.operationId, nonce: context.original.nonce,
        profileSha256: record.profileSha256, resourceManifestSha256: attempt.proof.classification.pins.manifest,
        checkpointSha256: digest(record), checkpointEnvelopeSha256, sourceRecordSha256: context.sourceRecordSha256,
        sourceProjectionSha256: context.sourceProjectionSha256, maintenanceExitSha256: context.maintenanceExitSha256,
        originalHistorySha256: digest({ operations: record.operations, calls: record.calls }), contextSha256: digest(context),
        proofSha256: digest(attempt.proof), finalizationSha256: digest(attempt.finalization), ackSha256: digest(completion.ack),
        acknowledgmentSha256: digest(completion.acknowledgment), closureSha256: digest(completion.closure), closureIssuedAt: completion.closure.issuedAt,
        originalUnknownPreserved: true, remoteQuiescence: 'not-established', newBootIdentity: 'not-observed-or-adopted',
        localProcessesClosed: true, leaseAndBarrierAbsent: true,
      };
      const binding = { ...body, completeChainSha256: digest(body) };
      assertFz3bPreflightHostCompletionBinding(binding);
      const result = clone(binding);
      const witness = captureProductionFz3bHostCompletionWitness(this.options.adapter, this.options.dataDir, context, attempt.proof, attempt.finalization,
        completion.ack, completion.acknowledgment, completion.closure);
      if (witness) {
        const dataRoot = fz3bHostRootIdentitySync(this.options.dataDir), file = path.join(this.directory, `${safePart(runId)}.json`);
        const checkpoint = readFz3bHostWitnessSync(file);
        if (checkpoint.sha256 !== checkpointEnvelopeSha256) throw new Error('FZ3B host checkpoint changed before witness capture');
        hostCompletionReads.set(result, { backend: this, dataRoot, digest: digest(result), expiresAt: process.hrtime.bigint() + 30000000000n,
          consumed: false, current: () => {
            if (this.hostReadEpoch !== epoch || !same(dataRoot, fz3bHostRootIdentitySync(this.options.dataDir)) || !this.locallySettled(record) ||
                this.hardwareHeld(record) || this.busy(record) || digest(record) !== binding.checkpointSha256) throw new Error('FZ3B_HOST_COMPLETION_READ_CHANGED');
            witness(); this.verifyPreflightClosure(record, completion.ack, completion.acknowledgment, completion.closure);
            const current = readFz3bHostWitnessSync(file);
            if (current.sha256 !== checkpoint.sha256 || current.identity !== checkpoint.identity) throw new Error('FZ3B_HOST_COMPLETION_READ_CHECKPOINT_CHANGED');
          } });
      }
      return result;
    } catch (error) { this.verifiedPreflights.delete(runId); throw error; }
    finally { this.reconciling.delete(runId); }
  }
  private checkReconciliationContext(record: RecordState, operation: Fz3bOperation, context: Fz3bInspectReconciliationContext) {
    assertFz3bReconciliationContext(record, operation, this.fixture, context);
  }
  private checkReconciliationProof(context: Fz3bInspectReconciliationContext, proof: Fz3bInspectReconciliationProof, fresh: boolean) {
    assertFz3bReconciliationProof(context, proof, fresh ? this.now() : undefined);
  }
  private checkReconciliationFinalization(context: Fz3bInspectReconciliationContext, proof: Fz3bInspectReconciliationProof, value: Fz3bInspectReconciliationFinalization) {
    assertFz3bReconciliationFinalization(context, proof, value);
  }
  async recoveryActions(runId: string): Promise<{ reconcileInspect: boolean; reconcilePreflightRefusedInspect?: boolean; maintenanceExit: boolean; exportEvidence: boolean }> {
    await this.init(); const record = this.record(runId);
    const settled = this.locallySettled(record) && !!this.options.assertRecoveryOwner;
    let candidate = false;
    try { this.inspectCandidate(record); candidate = true; } catch { /* Not an inspect-only hold. */ }
    let preflightCandidate = false;
    try { this.preflightCandidate(record); preflightCandidate = true; } catch { /* Not the one approved local preflight refusal. */ }
    return { reconcileInspect: settled && candidate && !!this.options.requestInspectReconciliation && !!this.options.adapter.prepareInspectReconciliation && !!this.options.adapter.finalizeInspectReconciliation,
      reconcilePreflightRefusedInspect: settled && preflightCandidate && this.preflightAvailable(),
      maintenanceExit: settled && this.hardwareHeld(record) && !!this.options.adapter.localProcessState,
      exportEvidence: settled && record.operations.every(op => !['prepared', 'running'].includes(op.status) && (op.dispatchPhase !== 'may-have-started' || op.processExited === true)) };
  }
  /** Host-native only. This never rewrites a call/operation or resumes the failed model run. */
  async reconcileInspect(runId: string): Promise<Fz3bRunView> {
    await this.init(); const record = this.record(runId);
    if (!this.locallySettled(record) || !this.options.assertRecoveryOwner || !this.options.requestInspectReconciliation ||
        !this.options.adapter.prepareInspectReconciliation || !this.options.adapter.finalizeInspectReconciliation) throw new Error('FZ3B inspect reconciliation is unavailable or locally busy');
    const operation = this.inspectCandidate(record);
    this.reconciling.add(runId);
    let attempt: Fz3bInspectReconciliation | undefined;
    const controller = new AbortController(); this.dialogs.set(runId, controller);
    try {
      await this.options.assertRecoveryOwner(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      if (!this.released(record, operation)) {
        const prior = record.reconciliations?.at(-1);
        if (prior?.status === 'prepared' && prior.proof && this.now() - Date.parse(prior.context.createdAt) <= RECONCILIATION_MAX_AGE) {
          this.checkReconciliationContext(record, operation, prior.context); this.checkReconciliationProof(prior.context, prior.proof, true); attempt = prior;
        } else {
          const context: Fz3bInspectReconciliationContext = { schemaVersion: 1, id: randomUUID(), nonce: randomBytes(32).toString('hex'), createdAt: this.iso(),
            original: this.originalContext(record, operation), originalOperationSha256: digest(operation), originalEvidenceSha256: operation.evidenceSha256!, ownerBindingSha256: digest(this.ownerBinding(record)) };
          attempt = { schemaVersion: 1, context, status: 'preparing', createdAt: this.iso(), updatedAt: this.iso() };
          record.reconciliations ??= []; if (record.reconciliations.length >= 16) throw new Error('FZ3B reconciliation attempt budget exhausted');
          record.reconciliations.push(attempt); await this.save(record);
        }
        if (controller.signal.aborted || !await this.options.requestInspectReconciliation(clone(attempt.context), controller.signal) || controller.signal.aborted) throw new Error('FZ3B readonly reconciliation was not natively confirmed');
        this.dialogs.delete(runId);
        await this.options.assertRecoveryOwner(clone(this.ownerBinding(record))); await this.options.checkRuntime();
        if (controller.signal.aborted) throw new Error('FZ3B readonly reconciliation was cancelled');
        if (!attempt.proof) {
          const proof = await this.options.adapter.prepareInspectReconciliation(clone(attempt.context));
          this.checkReconciliationContext(record, operation, attempt.context); this.checkReconciliationProof(attempt.context, proof, true);
          attempt.proof = clone(proof); attempt.status = 'prepared'; attempt.updatedAt = this.iso(); await this.save(record);
        }
        this.checkReconciliationProof(attempt.context, attempt.proof, true);
        await this.options.assertRecoveryOwner(clone(this.ownerBinding(record))); await this.options.checkRuntime();
        if (controller.signal.aborted) throw new Error('FZ3B readonly reconciliation was cancelled before finalization');
        this.checkReconciliationProof(attempt.context, attempt.proof, true);
        const finalization = await this.options.adapter.finalizeInspectReconciliation(clone(attempt.context), clone(attempt.proof));
        this.checkReconciliationFinalization(attempt.context, attempt.proof, finalization);
        this.checkReconciliationProof(attempt.context, attempt.proof, true);
        attempt.finalization = clone(finalization); attempt.status = 'released'; attempt.updatedAt = this.iso();
        record.hardwareBusy = record.operations.some(op => this.blocking(record, op));
        await this.save(record);
      }
    } catch (error) {
      if (attempt) {
        // Prepared proofs remain retryable after an interrupted exact-lock finalization.
        if (attempt.status === 'preparing') attempt.status = 'failed';
        if (this.persistenceFailed && attempt.status === 'released') { attempt.status = 'prepared'; delete attempt.finalization; }
        attempt.error = String(error).slice(0, 2000); attempt.updatedAt = this.iso(); record.hardwareBusy = true;
        await this.save(record);
      }
      throw error;
    } finally { this.dialogs.delete(runId); this.reconciling.delete(runId); this.options.onChange?.(); }
    return this.view(record);
  }
  /** Native host-only, exact approved case. It performs no SSH and never changes original unknown facts. */
  async reconcilePreflightRefusedInspect(runId: string): Promise<Fz3bRunView> {
    await this.init(); const record = this.record(runId);
    if (!this.locallySettled(record) || !this.preflightAvailable()) throw new Error('FZ3B local preflight recovery is unavailable or locally busy');
    const source = this.preflightCandidate(record), adapter = this.options.adapter;
    this.reconciling.add(runId);
    const controller = new AbortController();
    let attempt = record.preflightRefusalRecoveries?.at(-1);
    let checkpointSaved = attempt?.status === 'released';
    try {
      await this.options.assertRecoveryOwner!(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      if (attempt?.status === 'released') {
        // Idempotent read-only main/save follow-up, never another finalization.
        await this.readPreflightCompletion(record);
        await this.options.assertRecoveryOwner!(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      } else {
      if (attempt) throw new Error('FZ3B prior local recovery remains held; no automatic retry or finalization is allowed');
      const created = this.now();
      const context: Fz3bPreflightRefusalRecoveryContext = { schemaVersion: 1, reason: 'boot-preflight-refused-before-device-v1',
        id: randomUUID(), nonce: randomBytes(32).toString('hex'), createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString(),
        original: this.originalContext(record, record.operations[1]), ownerBindingSha256: digest(this.ownerBinding(record)),
        originalOperationSha256: digest(record.operations[1]), originalEvidenceSha256: record.operations[1].evidenceSha256!,
        sourceRecordSha256: source.sourceRecordSha256, sourceProjectionSha256: digest(source.projection), maintenanceExitSha256: source.maintenanceExitSha256,
        sourceRun: clone(source.sourceRun), projection: clone(source.projection), anchor: fz3bPreflightAnchor(source.projection) };
      assertFz3bPreflightRecoveryContext(context, this.fixture, this.now());
      attempt = { schemaVersion: 1, context, status: 'preparing', createdAt: context.createdAt, updatedAt: context.createdAt };
      record.preflightRefusalRecoveries = [attempt]; await this.save(record);
      this.dialogs.set(runId, controller);
      const approved = await this.options.requestPreflightRefusalRecovery!(clone(context), controller.signal);
      this.dialogs.delete(runId);
      this.assertPreflightUnchanged(record, context); assertFz3bPreflightRecoveryContext(context, this.fixture, this.now());
      if (approved !== true || controller.signal.aborted) throw new Error('FZ3B local preflight recovery was not natively confirmed');
      await this.options.assertRecoveryOwner!(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      this.assertPreflightUnchanged(record, context); assertFz3bPreflightRecoveryContext(context, this.fixture, this.now());
      if (controller.signal.aborted) throw new Error('FZ3B local preflight recovery was cancelled');
      const proof = await adapter.preparePreflightRefusalRecovery!(clone(context));
      const input = await adapter.readPreflightRefusalRecoveryInput!(clone(context), clone(proof));
      const classified = verifyFz3bPreflightRefusal({ run: clone(context.projection), anchor: clone(context.anchor), resources: input.resources, files: input.files });
      if (!same(classified, proof.classification)) throw new Error('FZ3B preflight worker classification differs from independently checked bytes');
      assertFz3bPreflightRecoveryProof(context, proof, this.now()); this.assertPreflightUnchanged(record, context);
      attempt.proof = clone(proof); attempt.status = 'prepared'; attempt.updatedAt = this.iso(); await this.save(record);
      await this.options.assertRecoveryOwner!(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      this.assertPreflightUnchanged(record, context); assertFz3bPreflightRecoveryContext(context, this.fixture, this.now());
      assertFz3bPreflightRecoveryProof(context, proof, this.now());
      if (controller.signal.aborted) throw new Error('FZ3B local preflight recovery cancelled before exact lease release');
      const finalization = await adapter.finalizePreflightRefusalRecovery!(clone(context), clone(proof));
      assertFz3bPreflightRecoveryFinalization(context, proof, finalization); this.assertPreflightUnchanged(record, context);
      assertFz3bPreflightRecoveryContext(context, this.fixture, this.now()); assertFz3bPreflightRecoveryProof(context, proof, this.now());
      await this.options.assertRecoveryOwner!(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      this.assertPreflightUnchanged(record, context); assertFz3bPreflightRecoveryContext(context, this.fixture, this.now());
      if (controller.signal.aborted) throw new Error('FZ3B local preflight recovery cancelled before final checkpoint');
      attempt.finalization = clone(finalization); attempt.status = 'released'; attempt.updatedAt = this.iso();
      // This is the LAST required ledger write, while the worker barrier still exists.
      await this.save(record); checkpointSaved = true;
      const issuedAt = this.iso();
      const body: Omit<Fz3bPreflightRefusalRecoveryAck, 'mac'> = { schemaVersion: 1, method: 'fz3b-preflight-refusal-post-save-ack-v1',
        purpose: 'exact-local-inspect-release-only', id: context.id, contextSha256: digest(context), proofSha256: digest(proof),
        finalizationSha256: digest(finalization), checkpointSha256: digest(record), checkpointUpdatedAt: record.updatedAt, issuedAt };
      const ack: Fz3bPreflightRefusalRecoveryAck = { ...body, mac: createHmac('sha256', this.key!).update(FZ3B_PREFLIGHT_ACK_DOMAIN).update(fz3bCanonicalJson(body)).digest('hex') };
      this.verifyPreflightAck(record, ack);
      const acknowledgment = await adapter.acknowledgePreflightRefusalRecovery!(clone(context), clone(proof), clone(finalization), clone(ack),
        value => this.verifyPreflightAck(record, value));
      this.verifyPreflightAck(record, ack); assertFz3bPreflightRecoveryAcknowledgment(context, proof, finalization, ack, acknowledgment);
      // A release authorization is not an observed successful worker close.
      // Mint this independent certificate only AFTER acknowledge actually returned success.
      await this.options.assertRecoveryOwner!(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      this.verifyPreflightAck(record, ack);
      const closureBody: Omit<Fz3bPreflightRefusalRecoveryClosure, 'mac'> = { schemaVersion: 1, method: 'fz3b-preflight-refusal-worker-closed-v1',
        purpose: 'actual-local-barrier-close-only', id: context.id, contextSha256: digest(context), proofSha256: digest(proof), finalizationSha256: digest(finalization),
        ackSha256: digest(ack), acknowledgmentSha256: digest(acknowledgment), checkpointSha256: ack.checkpointSha256, issuedAt: this.iso() };
      const closure: Fz3bPreflightRefusalRecoveryClosure = { ...closureBody,
        mac: createHmac('sha256', this.key!).update(FZ3B_PREFLIGHT_CLOSURE_DOMAIN).update(fz3bCanonicalJson(closureBody)).digest('hex') };
      this.verifyPreflightClosure(record, ack, acknowledgment, closure);
      await adapter.certifyPreflightRefusalRecovery!(clone(context), clone(proof), clone(finalization), clone(ack), clone(acknowledgment), clone(closure),
        (signedAck, actualClose, value) => this.verifyPreflightClosure(record, signedAck, actualClose, value));
      this.verifyPreflightClosure(record, ack, acknowledgment, closure);
      this.verifiedPreflights.set(runId, { ack: clone(ack), acknowledgment: clone(acknowledgment), closure: clone(closure) });
      // Derived completion is supplied from separately authenticated worker bytes on restart.
      // No fallible required ledger write occurs after the worker clears its last barrier.
      }
    } catch (error) {
      this.verifiedPreflights.delete(runId);
      if (attempt && !checkpointSaved && !this.persistenceFailed) {
        if (attempt.status !== 'released') attempt.status = 'failed';
        attempt.error = String(error).slice(0, 2000); attempt.updatedAt = this.iso();
        await this.save(record);
      }
      throw error;
    } finally { this.dialogs.delete(runId); this.reconciling.delete(runId); this.options.onChange?.(); }
    return this.view(record);
  }
  /** Local maintenance exit only: uncertainty and hardware ownership are deliberately preserved. */
  async prepareMaintenanceExit(runId: string): Promise<Fz3bMaintenanceExitSeal> {
    await this.init(); const record = this.record(runId);
    if (record.preflightRefusalRecoveries?.at(-1)?.status === 'released') throw new Error('FZ3B post-save recovery checkpoint is immutable; no new ledger seal may replace it');
    if (!this.locallySettled(record) || !this.hardwareHeld(record) || !this.options.assertRecoveryOwner || !this.options.adapter.localProcessState) throw new Error('FZ3B maintenance exit is unavailable or locally busy');
    this.reconciling.add(runId);
    try {
      await this.options.assertRecoveryOwner(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      const remote = record.operations.filter(op => op.dispatchPhase === 'may-have-started' && op.kind !== 'build');
      if (record.operations.some(op => op.kind === 'build' && op.processExited !== true)) throw new Error('FZ3B local build exit is not confirmed');
      const state = await this.options.adapter.localProcessState(remote.map(op => this.originalContext(record, op)));
      if (!state || !onlyKeys(state, ['closed', 'liveChildren', 'operations']) || state.closed !== true || state.liveChildren !== 0 || !Array.isArray(state.operations) ||
          state.operations.length !== remote.length || new Set(state.operations.map(op => op.operationId)).size !== remote.length ||
          remote.some(op => !state.operations.some(value => onlyKeys(value, ['operationId', 'nonce', 'closeConfirmed', 'evidenceSha256']) && value.operationId === op.id &&
            value.nonce === op.nonce && value.closeConfirmed === true && hash(value.evidenceSha256)))) throw new Error('FZ3B maintenance requires actual local transport close evidence');
      await this.options.assertRecoveryOwner(clone(this.ownerBinding(record))); await this.options.checkRuntime();
      const payload = { schemaVersion: 1 as const, runId, sessionId: record.sessionId, taskId: record.taskId, profileSha256: record.profileSha256,
        createdAt: this.iso(), unknownPreserved: true as const, localProcessesClosed: true as const,
        operationSnapshotSha256: digest(record.operations), processState: clone(state) };
      const seal: Fz3bMaintenanceExitSeal = { ...payload, sealSha256: digest(payload) };
      record.maintenanceExit = seal; await this.save(record); return clone(seal);
    } finally { this.reconciling.delete(runId); this.options.onChange?.(); }
  }
  async quiescence(runId: string): Promise<Fz3bQuiescence> {
    await this.init(); const record = this.record(runId);
    const inflight = this.pending.has(runId) || this.settling.has(runId) || this.reconciling.has(runId) || this.exporting.has(runId), nativePending = this.dialogs.has(runId), persistencePending = this.writes.has(runId);
    const hardwareBusy = this.hardwareHeld(record) || this.busy(record);
    return { runId, taskId: record.taskId, sessionId: record.sessionId, active: record.active, stopRequested: record.stopRequested,
      starting: this.starting, inflight, nativePending, persistencePending, hardwareBusy,
      quiescent: !record.active && !this.starting && !inflight && !nativePending && !persistencePending && !hardwareBusy };
  }
  async recover(): Promise<void> {
    await this.init();
    if (this.pending.size || this.settling.size || this.dialogs.size || this.writes.size || this.reconciling.size || this.exporting.size) throw new Error('FZ3B live action cannot be recovered or replayed');
    for (const record of this.records.values()) if (record.active) { this.attention(record, 'Explicit recovery stops planning only; remote uncertainty is not cleared'); await this.save(record); }
  }
  /** Pure local evidence copy, including unknown runs; it neither adds a model call nor releases ownership. */
  async export(runId: string): Promise<{ path: string; sha256: string }> {
    await this.init(); const record = this.record(runId);
    if (this.starting || this.pending.size || this.settling.size || this.dialogs.size || this.writes.size || this.reconciling.size || this.exporting.size) throw new Error('FZ3B export waits for local callbacks and persistence to settle');
    this.exporting.add(runId);
    try { return await this.exportRecord(record, true); }
    finally { this.exporting.delete(runId); this.options.onChange?.(); }
  }
}
