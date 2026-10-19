import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { HARDWARE_AGENT_TOOLS, type HardwareAgentArtifactView, type HardwareAgentBinding, type HardwareAgentCallAudit,
  type HardwareAgentOperationView, type HardwareAgentRunView, type HardwareAgentToolContext,
  type HardwareAgentToolName, type HardwareAgentToolResult } from '../../shared/hardware-agent.js';
import { digest, durableJson, noLinks, safePart } from './files.js';
import { GESTURESCREEN_PROFILE, GESTURESCREEN_PROFILE_SHA256 } from './profile.js';
import type { EmbeddedGrant, EmbeddedOperation, EmbeddedStatus } from './types.js';

export interface HardwareAgentControllerOptions {
  dataDir: string;
  embedded: {
    status(taskId: string): Promise<EmbeddedStatus>;
    build(taskId: string, requestKey: string): Promise<EmbeddedStatus>;
    inspect(taskId: string, requestKey: string): Promise<EmbeddedStatus>;
    verify(taskId: string, requestKey: string): Promise<EmbeddedStatus>;
    export(taskId: string, destination: string): Promise<{ path: string; sha256: string }>;
  };
  /** The signal may cancel only a not-yet-approved native dialog, never a dispatched worker. */
  requestFlash(taskId: string, requestKey: string, signal: AbortSignal): Promise<EmbeddedStatus>;
  checkRuntime(): Promise<void>;
  assertOwner(binding: HardwareAgentBinding): Promise<void> | void;
  exportDirectory: string; onChange?: () => void; now?: () => number;
}

export interface HardwareAgentQuiescence {
  runId: string; taskId: string; sessionId: string;
  active: boolean; stopRequested: boolean; starting: boolean;
  inflight: boolean; nativePending: boolean; persistencePending: boolean;
  quiescent: boolean;
}

type WriteTool = Exclude<HardwareAgentToolName, 'embedded_status'>;
const SEQUENCE: WriteTool[] = ['embedded_build', 'embedded_inspect', 'embedded_request_flash', 'embedded_verify', 'embedded_export'];
interface RunRecord extends HardwareAgentRunView {
  step: number;
  results: Partial<Record<WriteTool, HardwareAgentToolResult>>;
  flashChain?: { operationId: string; artifactId: string; grantId: string; approvedAt: string; expiresAt: string };
}

export class HardwareAgentController {
  private readonly root: string;
  private readonly records = new Map<string, RunRecord>();
  private readonly inflight = new Map<string, Promise<HardwareAgentToolResult>>();
  private readonly inflightCalls = new Map<string, string>();
  private readonly settling = new Set<string>();
  private readonly dialogs = new Map<string, AbortController>();
  private readonly writes = new Map<string, Promise<void>>();
  private initialization?: Promise<void>;
  private starting = false;
  private key?: Buffer;
  private persist = durableJson;
  constructor(private readonly options: HardwareAgentControllerOptions) {
    this.root = path.resolve(options.dataDir, 'hardware-agent');
    if (!path.isAbsolute(options.exportDirectory)) throw new Error('Host export directory must be absolute');
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private iso() { return new Date(this.now()).toISOString(); }
  private mac(value: unknown) { return createHmac('sha256', this.key!).update(JSON.stringify(value)).digest('hex'); }
  private file(runId: string) { return path.join(this.root, `${safePart(runId)}.json`); }
  private view(record: RunRecord): HardwareAgentRunView {
    const { step: _step, results: _results, flashChain: _chain, ...view } = record;
    return structuredClone(view);
  }
  private async init() {
    this.initialization ??= (async () => {
      await mkdir(this.root, { recursive: true }); await noLinks(this.root);
      const keyFile = path.join(this.root, 'binding.key');
      try {
        const handle = await open(keyFile, 'wx', 0o600);
        try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await noLinks(keyFile); this.key = await readFile(keyFile);
      if (this.key.length !== 32) throw new Error('Hardware-agent binding key is invalid');
      for (const entry of await readdir(this.root, { withFileTypes: true })) {
        if (!entry.name.endsWith('.json')) continue;
        const file = path.join(this.root, entry.name); await noLinks(file);
        if (!entry.isFile() || (await lstat(file)).size > 4 * 1024 * 1024) throw new Error('Hardware-agent run file is invalid');
        const envelope = JSON.parse(await readFile(file, 'utf8')) as { payload: RunRecord; mac: string };
        const expected = Buffer.from(this.mac(envelope.payload), 'hex');
        const actual = typeof envelope.mac === 'string' && /^[a-f0-9]{64}$/.test(envelope.mac) ? Buffer.from(envelope.mac, 'hex') : Buffer.alloc(0);
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || envelope.payload.schemaVersion !== 1 ||
            `${safePart(envelope.payload.runId)}.json` !== entry.name) throw new Error('Hardware-agent run integrity failed');
        const record = envelope.payload;
        this.records.set(record.runId, record);
        if (record.status === 'active' || record.hardwareBusy || record.calls.some(call => call.status === 'running')) {
          record.status = 'needs_attention'; record.phase = 'needs_attention'; record.active = false;
          record.stopRequested = true; record.failure = 'Application restarted; planning stopped and no tool was replayed';
          if (record.nativeApproval === 'pending') record.nativeApproval = 'unknown';
          for (const call of record.calls) if (call.status === 'running') { call.status = 'unknown'; call.error = record.failure; }
          await this.save(record);
        }
      }
    })();
    await this.initialization;
  }
  private async save(record: RunRecord) {
    record.updatedAt = this.iso();
    const payload = structuredClone(record);
    const previous = this.writes.get(record.runId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await noLinks(this.root);
      await this.persist(this.file(record.runId), { payload, mac: this.mac(payload) });
    });
    this.writes.set(record.runId, next);
    try { await next; this.options.onChange?.(); }
    catch (error) {
      this.attention(record, `Run persistence failed: ${String(error)}`);
      throw error;
    } finally { if (this.writes.get(record.runId) === next) this.writes.delete(record.runId); }
  }
  private attention(record: RunRecord, message: string) {
    record.status = 'needs_attention'; record.phase = 'needs_attention'; record.active = false;
    record.stopRequested = true; record.failure = message.slice(0, 4000); record.updatedAt = this.iso();
    if (record.nativeApproval === 'pending') this.dialogs.get(record.runId)?.abort();
    this.options.onChange?.();
  }
  private record(runId: string) { const record = this.records.get(runId); if (!record) throw new Error('Unknown hardware-agent run'); return record; }
  private context(record: RunRecord, context: HardwareAgentToolContext) {
    if (context.runId !== record.runId || context.sessionId !== record.sessionId || context.taskId !== record.taskId ||
        context.generation !== record.generation || context.threadId !== record.threadId || !context.turnId ||
        (record.turnId && context.turnId !== record.turnId) || typeof context.callId !== 'string' || !context.callId || context.callId.length > 256) {
      throw new Error('Hardware-agent host context mismatch');
    }
  }
  async start(binding: HardwareAgentBinding): Promise<HardwareAgentRunView> {
    await this.init(); safePart(binding.runId); safePart(binding.taskId);
    if (![binding.sessionId, binding.threadId, binding.model].every(value => typeof value === 'string' && value.length > 0 && value.length <= 512) ||
        (binding.turnId !== undefined && (typeof binding.turnId !== 'string' || !binding.turnId || binding.turnId.length > 512)) ||
        (binding.instruction !== undefined && (typeof binding.instruction !== 'string' || binding.instruction.length > 16384)) ||
        !Number.isSafeInteger(binding.generation) || binding.generation < 0) throw new Error('Incomplete trusted hardware-agent binding');
    if (this.records.has(binding.runId)) throw new Error('Run ID already exists; runs are never resumed');
    if (this.starting || this.inflight.size || this.settling.size || this.writes.size || [...this.records.values()].some(run => run.active || run.hardwareBusy)) throw new Error('Another hardware-agent run is active or held');
    this.starting = true;
    try {
      await this.options.assertOwner(binding); await this.options.checkRuntime();
      const state = await this.options.embedded.status(binding.taskId);
      if (state.taskId !== binding.taskId || !state.configured || !state.hardwareAvailable || state.profileId !== GESTURESCREEN_PROFILE.id || state.profileSha256 !== GESTURESCREEN_PROFILE_SHA256 ||
          state.operations.some(op => ['prepared', 'running'].includes(op.status) || (op.status === 'unknown' && !op.recoveredAt))) throw new Error('Fixed embedded target is unavailable or requires recovery');
      const record: RunRecord = { ...structuredClone(binding), schemaVersion: 1, status: 'active', phase: 'ready', active: true,
        hardwareBusy: false, stopRequested: false, nativeApproval: 'not_requested', createdAt: this.iso(), updatedAt: this.iso(), calls: [], step: 0, results: {} };
      this.records.set(record.runId, record); await this.save(record); return this.view(record);
    } finally { this.starting = false; }
  }
  async bindTurn(runId: string, binding: { generation: number; threadId: string; turnId: string }): Promise<void> {
    await this.init(); const record = this.record(runId);
    if (!binding.turnId || binding.generation !== record.generation || binding.threadId !== record.threadId || (record.turnId && record.turnId !== binding.turnId)) throw new Error('Hardware-agent turn binding mismatch');
    if (!record.turnId) { record.turnId = binding.turnId; await this.save(record); }
  }
  private operationView(operation: EmbeddedOperation): HardwareAgentOperationView {
    return { id: operation.id, kind: operation.kind, status: operation.status, processExited: operation.processExited,
      detail: operation.detail, progress: operation.progress };
  }
  private artifact(state: EmbeddedStatus): HardwareAgentArtifactView {
    const artifact = state.artifact;
    if (!artifact || artifact.profileSha256 !== GESTURESCREEN_PROFILE_SHA256) throw new Error('No trusted fixed-target artifact');
    return { id: artifact.id, buildId: artifact.buildId, hexSha256: artifact.hexSha256, axfSha256: artifact.axfSha256,
      sourceSha256: artifact.sourceSha256, profileSha256: artifact.profileSha256 };
  }
  private sameArtifact(record: RunRecord, state: EmbeddedStatus) {
    if (!record.artifact || JSON.stringify(this.artifact(state)) !== JSON.stringify(record.artifact)) throw new Error('The run artifact changed');
  }
  private requestKey(record: RunRecord, tool: WriteTool) { return `agent-${digest(`${record.runId}:${tool}`)}`; }
  private async observe(record: RunRecord): Promise<EmbeddedStatus> {
    const state = await this.options.embedded.status(record.taskId);
    if (state.taskId !== record.taskId || !state.configured || state.profileId !== GESTURESCREEN_PROFILE.id || state.profileSha256 !== GESTURESCREEN_PROFILE_SHA256) throw new Error('Fixed embedded task binding changed');
    const keys = new Set(SEQUENCE.map(tool => this.requestKey(record, tool)));
    const owned = state.operations.filter(op => keys.has(op.requestKey));
    record.hardwareBusy = this.inflight.has(record.runId) || owned.some(op => ['prepared', 'running'].includes(op.status) || (op.status === 'unknown' && !op.recoveredAt));
    const failed = owned.find(op => op.status === 'failed' || op.status === 'unknown');
    if (failed && record.status !== 'needs_attention') this.attention(record, failed.detail ?? `Owned ${failed.kind} operation ${failed.status}`);
    const flash = owned.find(op => op.kind === 'flash');
    if (flash && state.grant?.consumedBy === flash.id && state.grant.approvedAt) {
      record.nativeApproval = Date.parse(state.grant.expiresAt) <= this.now() ? 'expired' : 'approved';
      if (record.status === 'active' && ['prepared', 'running'].includes(flash.status)) record.phase = 'flashing';
    }
    return state;
  }
  async status(runId?: string): Promise<HardwareAgentRunView | undefined> {
    await this.init(); const record = runId ? this.records.get(runId) : [...this.records.values()].at(-1);
    if (!record) return undefined;
    try { await this.observe(record); }
    catch (error) { this.attention(record, `Embedded state could not be read: ${String(error)}`); }
    return this.view(record);
  }
  async list(): Promise<HardwareAgentRunView[]> {
    await this.init(); return Promise.all([...this.records.keys()].map(async id => (await this.status(id))!));
  }
  async executeTool(context: HardwareAgentToolContext, name: HardwareAgentToolName, args: unknown): Promise<HardwareAgentToolResult> {
    await this.init(); const record = this.record(context.runId); this.context(record, context);
    if (!HARDWARE_AGENT_TOOLS.includes(name)) {
      this.attention(record, 'Tool is outside the fixed hardware-agent allowlist'); await this.save(record);
      throw new Error(record.failure);
    }
    if (!args || typeof args !== 'object' || Array.isArray(args) || Reflect.ownKeys(args).length ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
      const message = 'Hardware-agent tools accept only an empty argument object';
      if (record.calls.length >= 200) throw new Error('Hardware-agent call budget exhausted');
      record.calls.push({ callId: context.callId, tool: name, receivedAt: this.iso(), completedAt: this.iso(), status: 'rejected', error: message });
      this.attention(record, message); await this.save(record); throw new Error(message);
    }
    if (!record.turnId) await this.bindTurn(record.runId, context);
    const old = record.calls.find(call => call.callId === context.callId);
    if (old) {
      if (old.tool !== name) {
        this.attention(record, 'Tool call ID was reused with another tool'); await this.save(record);
        throw new Error(record.failure);
      }
      const pending = this.inflight.get(record.runId);
      if (pending && this.inflightCalls.get(record.runId) === context.callId) return pending;
      if (old.result) return structuredClone(old.result);
      return { runId: record.runId, callId: context.callId, tool: name, ok: false, result: 'unknown', phase: record.phase, message: 'Prior call has no trustworthy final result; it was not replayed' };
    }
    const audit: HardwareAgentCallAudit = { callId: context.callId, tool: name, receivedAt: this.iso(), status: 'running' };
    if (record.calls.length >= 200) throw new Error('Hardware-agent call budget exhausted');
    record.calls.push(audit);
    if (name === 'embedded_status') {
      try { await this.observe(record); } catch (error) { this.attention(record, `Embedded state could not be read: ${String(error)}`); }
      const result: HardwareAgentToolResult = { runId: record.runId, callId: context.callId, tool: name, ok: true, result: 'status', phase: record.phase,
        artifact: record.artifact, message: record.failure };
      audit.status = 'succeeded'; audit.completedAt = this.iso(); audit.result = result;
      try { await this.save(record); } catch { result.ok = false; result.message = record.failure; }
      return structuredClone(result);
    }
    if (!record.active || record.status !== 'active' || record.stopRequested) {
      audit.status = 'rejected'; audit.error = 'Run is stopped or requires attention'; await this.save(record);
      return { runId: record.runId, callId: context.callId, tool: name, ok: false, result: record.status === 'stopped' ? 'stopped' : 'unknown', phase: record.phase, message: audit.error };
    }
    const prior = record.results[name];
    if (prior) {
      const result = { ...structuredClone(prior), callId: context.callId };
      audit.status = 'replayed'; audit.replayedFromCallId = prior.callId; audit.result = result; audit.operationId = result.operation?.id;
      audit.completedAt = this.iso(); await this.save(record); return result;
    }
    if (this.inflight.has(record.runId) || SEQUENCE[record.step] !== name) {
      audit.status = 'rejected'; audit.error = 'Tool is out of sequence or another action is pending';
      this.attention(record, audit.error); await this.save(record);
      return { runId: record.runId, callId: context.callId, tool: name, ok: false, result: 'failed', phase: record.phase, message: audit.error };
    }
    let pending!: Promise<HardwareAgentToolResult>;
    pending = (async () => {
      // Reserve before starting persistence, so repeated calls await the complete settlement too.
      await Promise.resolve();
      let result: HardwareAgentToolResult | undefined;
      try { result = await this.perform(record, name, audit); return result; }
      finally {
        this.settling.add(record.runId);
        if (this.inflight.get(record.runId) === pending) {
          this.inflight.delete(record.runId); this.inflightCalls.delete(record.runId);
        }
        try { await this.observe(record); await this.save(record); }
        catch (error) {
          this.attention(record, `Tool settlement could not be durably confirmed: ${String(error)}`);
          if (result) { result.ok = false; result.result = 'unknown'; result.phase = record.phase; result.message = record.failure; }
          audit.status = 'unknown'; audit.error = record.failure; audit.result = result;
        }
        finally { this.settling.delete(record.runId); }
      }
    })();
    this.inflight.set(record.runId, pending); this.inflightCalls.set(record.runId, context.callId); record.hardwareBusy = true;
    return pending;
  }
  private validateGrant(record: RunRecord, state: EmbeddedStatus, operation: EmbeddedOperation): EmbeddedGrant {
    const grant = state.grant; this.sameArtifact(record, state);
    const inspect = state.operations.find(op => op.requestKey === this.requestKey(record, 'embedded_inspect') && op.kind === 'inspect' && op.status === 'succeeded' && op.processExited === true);
    let backup: { sha256?: string; bytes?: number; doubleReadMatch?: boolean } | undefined;
    try { backup = JSON.parse(inspect?.receipt ?? '{}').backup; } catch { /* Missing evidence fails closed below. */ }
    const identity = GESTURESCREEN_PROFILE;
    if (!grant?.approvedAt || !Number.isFinite(Date.parse(grant.approvedAt)) || !Number.isFinite(Date.parse(grant.expiresAt)) ||
        Date.parse(grant.approvedAt) > this.now() || Date.parse(grant.approvedAt) >= Date.parse(grant.expiresAt) ||
        grant.taskId !== record.taskId || grant.consumedBy !== operation.id || operation.artifactId !== record.artifact!.id ||
        grant.artifactId !== record.artifact!.id || grant.buildId !== record.artifact!.buildId || grant.hexSha256 !== record.artifact!.hexSha256 ||
        grant.axfSha256 !== record.artifact!.axfSha256 || grant.sourceSha256 !== record.artifact!.sourceSha256 ||
        grant.profileId !== identity.id || grant.profileSha256 !== GESTURESCREEN_PROFILE_SHA256 || grant.scope !== 'flash-and-verify-once' ||
        !backup || backup.bytes !== 1048576 || backup.doubleReadMatch !== true || !/^[a-f0-9]{64}$/.test(backup.sha256 ?? '') || grant.backupSha256 !== backup.sha256 ||
        grant.identity?.probeSerial !== identity.probeSerial || grant.identity.uid !== identity.uid || grant.identity.chipId !== identity.chipId ||
        grant.identity.flashKiB !== identity.flashKiB || grant.identity.cdcSerial !== identity.cdcSerial) throw new Error('Native approval chain is missing or differs from this run');
    return grant;
  }
  private validateFlashChain(record: RunRecord, state: EmbeddedStatus) {
    const chain = record.flashChain;
    const flash = state.operations.find(op => op.id === chain?.operationId && op.kind === 'flash' && op.status === 'succeeded' && op.processExited === true);
    if (!chain || !flash || Date.parse(chain.expiresAt) <= this.now()) {
      if (chain && Date.parse(chain.expiresAt) <= this.now()) record.nativeApproval = 'expired';
      throw new Error('Own flash approval expired or successful flash evidence is missing');
    }
    const grant = this.validateGrant(record, state, flash);
    if (grant.id !== chain.grantId || grant.approvedAt !== chain.approvedAt || grant.expiresAt !== chain.expiresAt) throw new Error('Native approval chain changed before verification completed');
  }
  private async perform(record: RunRecord, tool: WriteTool, audit: HardwareAgentCallAudit): Promise<HardwareAgentToolResult> {
    const key = this.requestKey(record, tool); audit.requestKey = key; record.currentTool = tool;
    record.phase = tool === 'embedded_build' ? 'building' : tool === 'embedded_inspect' ? 'inspecting' : tool === 'embedded_request_flash' ? 'awaiting_native_approval' : tool === 'embedded_verify' ? 'verifying' : 'exporting';
    if (tool === 'embedded_request_flash') record.nativeApproval = 'pending';
    let dispatched = false;
    try {
      await this.save(record); // Intent, including native-dialog waiting, precedes all host side effects.
      await this.options.assertOwner(record); await this.options.checkRuntime();
      if (record.stopRequested || !record.active) throw new Error('Planning was stopped before dispatch');
      let state: EmbeddedStatus | undefined;
      if (tool === 'embedded_export') {
        const current = await this.observe(record); this.sameArtifact(record, current);
        if (record.stopRequested || !record.active) throw new Error('Planning was stopped before export');
        dispatched = true;
        record.export = await this.options.embedded.export(record.taskId, path.join(this.options.exportDirectory, safePart(record.runId)));
      } else {
        if (tool !== 'embedded_build') {
          const current = await this.observe(record); this.sameArtifact(record, current);
          if (tool === 'embedded_verify') this.validateFlashChain(record, current);
        }
        if (record.stopRequested || !record.active) throw new Error('Planning was stopped before dispatch');
        dispatched = true;
        if (tool === 'embedded_build') state = await this.options.embedded.build(record.taskId, key);
        if (tool === 'embedded_inspect') state = await this.options.embedded.inspect(record.taskId, key);
        if (tool === 'embedded_request_flash') {
          const dialog = new AbortController(); this.dialogs.set(record.runId, dialog);
          try { state = await this.options.requestFlash(record.taskId, key, dialog.signal); }
          finally { this.dialogs.delete(record.runId); }
        }
        if (tool === 'embedded_verify') state = await this.options.embedded.verify(record.taskId, key);
        const kind = tool === 'embedded_request_flash' ? 'flash' : tool.slice('embedded_'.length);
        const operation = state!.operations.find(op => op.requestKey === key && op.kind === kind);
        if (operation) audit.operationId = operation.id;
        if (!operation || operation.status !== 'succeeded' || operation.processExited !== true) {
          if (tool === 'embedded_request_flash' && !operation) record.nativeApproval = state!.grant && Date.parse(state!.grant.expiresAt) <= this.now() ? 'expired' : 'cancelled';
          throw new Error(operation?.detail ?? `No successful owned ${kind} operation`);
        }
        if (tool === 'embedded_build') record.artifact = this.artifact(state!); else this.sameArtifact(record, state!);
        if (tool === 'embedded_request_flash') {
          const grant = this.validateGrant(record, state!, operation); record.nativeApproval = 'approved';
          record.flashChain = { operationId: operation.id, artifactId: record.artifact!.id, grantId: grant.id, approvedAt: grant.approvedAt!, expiresAt: grant.expiresAt };
        }
        if (tool === 'embedded_verify') this.validateFlashChain(record, state!);
      }
      await this.observe(record);
      const operation = state?.operations.find(op => op.requestKey === key);
      const result: HardwareAgentToolResult = { runId: record.runId, callId: audit.callId, tool, ok: true, result: 'succeeded',
        phase: record.phase, artifact: record.artifact, ...(operation ? { operation: this.operationView(operation) } : {}), ...(record.export ? { export: record.export } : {}) };
      audit.status = 'succeeded'; audit.completedAt = this.iso(); audit.result = result;
      record.results[tool] = result; record.step++;
      if (record.status === 'needs_attention') record.phase = 'needs_attention';
      else if (record.stopRequested) { record.active = false; record.status = 'stopped'; record.phase = 'stopped'; }
      else if (record.step === SEQUENCE.length) { record.active = false; record.status = 'completed'; record.phase = 'completed'; }
      else record.phase = 'ready';
      result.phase = record.phase;
      await this.save(record); return structuredClone(result);
    } catch (error) {
      let observed: EmbeddedStatus | undefined;
      try { observed = await this.observe(record); } catch { if (dispatched) record.hardwareBusy = true; }
      const stopped = record.stopRequested && record.status === 'stopped' && observed && !observed.operations.some(op =>
        ['prepared', 'running'].includes(op.status) || (op.status === 'unknown' && !op.recoveredAt));
      if (tool === 'embedded_request_flash' && record.nativeApproval === 'pending') record.nativeApproval = stopped ? 'cancelled' : 'unknown';
      if (!stopped) this.attention(record, String(error));
      else { record.active = false; record.phase = 'stopped'; }
      const operation = observed?.operations.find(op => op.requestKey === key);
      if (operation) audit.operationId = operation.id;
      const uncertain = (!observed && dispatched) || (operation && ['prepared', 'running', 'unknown'].includes(operation.status));
      const result: HardwareAgentToolResult = { runId: record.runId, callId: audit.callId, tool, ok: false,
        result: stopped ? 'stopped' : uncertain ? 'unknown' : 'failed', phase: record.phase, message: String(error),
        ...(operation ? { operation: this.operationView(operation) } : {}) };
      audit.status = result.result === 'stopped' ? 'stopped' : result.result === 'unknown' ? 'unknown' : 'failed';
      audit.error = String(error); audit.completedAt = this.iso(); audit.result = result;
      try { await this.save(record); } catch { /* The in-memory gate remains closed; never retry a side effect. */ }
      return result;
    }
  }
  async stop(runId: string): Promise<HardwareAgentRunView> {
    await this.init(); const record = this.record(runId);
    record.stopRequested = true; record.active = false;
    if (record.status === 'active') { record.status = 'stopped'; record.phase = 'stopped'; }
    try { await this.observe(record); } catch { record.hardwareBusy = this.inflight.has(runId); }
    if (['pending', 'not_requested'].includes(record.nativeApproval)) this.dialogs.get(runId)?.abort();
    await this.save(record); return this.view(record);
  }
  async turnEnded(runId: string): Promise<HardwareAgentRunView> {
    await this.init(); const record = this.record(runId);
    if (record.status === 'active') {
      this.attention(record, 'Model turn ended before the hardware workflow completed');
      if (['pending', 'not_requested'].includes(record.nativeApproval)) this.dialogs.get(runId)?.abort();
      await this.save(record);
    }
    return this.view(record);
  }
  async quiescence(runId: string): Promise<HardwareAgentQuiescence> {
    await this.init(); const record = this.record(runId);
    const inflight = this.inflight.has(runId) || this.settling.has(runId);
    const nativePending = this.dialogs.has(runId) || record.nativeApproval === 'pending';
    const persistencePending = this.writes.has(runId);
    return { runId, taskId: record.taskId, sessionId: record.sessionId, active: record.active,
      stopRequested: record.stopRequested, starting: this.starting, inflight, nativePending, persistencePending,
      quiescent: !this.starting && !record.active && record.status !== 'active' && !inflight && !nativePending && !persistencePending };
  }
  /** Main calls only after real EmbeddedService recovery, with both engines confirmed stopped. */
  async checkpointRecovery(runId: string): Promise<HardwareAgentRunView> {
    const quiet = await this.quiescence(runId);
    if (!quiet.quiescent || !quiet.stopRequested) throw new Error('HARDWARE_AGENT_RECOVERY_NOT_QUIESCENT');
    const record = this.record(runId);
    await this.observe(record);
    if (record.hardwareBusy) throw new Error('HARDWARE_AGENT_RECOVERY_STILL_HELD');
    await this.save(record);
    return this.view(record);
  }
  async recover(): Promise<void> {
    await this.init();
    if (this.inflight.size || this.settling.size) throw new Error('Cannot recover an in-flight hardware-agent run');
    for (const record of this.records.values()) {
      if (record.active) { this.attention(record, 'Planning stopped for explicit recovery; no tool was replayed'); await this.save(record); }
      await this.observe(record);
    }
  }
}
