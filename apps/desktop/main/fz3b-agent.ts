import { randomUUID } from 'node:crypto';
import { configuredFailedEmptyIntentRecovery, isolateFailedEmptyIntent, type IsolationAudit } from './host-failed-empty-intent';
import type { Session, Fz3bEmptyHomeReceipt } from '../../../packages/shared/contracts';
import type { EngineEvent, EngineState } from '../../../packages/engine-adapter';
import type { RestrictedFz3bAdapterOptions } from '../../../packages/engine-adapter/restricted-fz3b';
import type { Fz3bBackend } from '../../../packages/engineering-runner/fz3b/backend';
import type { Fz3bBinding, Fz3bMaintenanceExitSeal, Fz3bRunView, Fz3bToolContext } from '../../../packages/engineering-runner/fz3b/types';
import { hasFz3bHostFinalization, finishFz3bHostFinalization, readFz3bHostLocalProof, assertFz3bHostLocalProof, canQuarantineFz3bEmptyHome, prepareFz3bEmptyHome, quarantineFz3bEmptyHome, type Fz3bEmptyHomeIntent, type Fz3bHostLocalProof, type Fz3bHostFinalizationStore } from './host-finalization-store';

type Backend = Pick<Fz3bBackend, 'start' | 'bindTurn' | 'executeTool' | 'status' | 'list' | 'stop' | 'turnEnded' | 'quiescence' | 'recover' | 'export' | 'recoveryActions' | 'reconcileInspect' | 'reconcilePreflightRefusedInspect' | 'readPreflightHostCompletion' | 'prepareMaintenanceExit'>;
export interface Fz3bEnginePort {
  readonly state: EngineState;
  readonly connectionGeneration: number;
  start(): Promise<void>; stop(): Promise<void>; account(): Promise<unknown>;
  startThread(model: string, instructions: string): Promise<string>;
  send(threadId: string, text: string, model: string): Promise<unknown>;
  policySnapshot(): unknown;
}
export interface Fz3bAgentMainOptions {
  backend: Backend;
  createEngine(callbacks: Pick<RestrictedFz3bAdapterOptions, 'onEvent' | 'onToolCall'>): Fz3bEnginePort;
  getSession(taskId: string): Session;
  assertCanStart(): void | Promise<void>;
  /** Synchronous final admission check; no await is permitted before hold(). */
  assertBeforeClaim(): void;
  enterControlledMode(): Promise<void>;
  assertGlobalOwner(binding: Fz3bBinding): void | Promise<void>;
  assertGlobalRecoveryOwner(binding: Fz3bBinding): void | Promise<void>;
  assertHostCommitOwner?(binding: Fz3bBinding): void;
  checkRuntime(): Promise<void>;
  readAccount(engine: Fz3bEnginePort): Promise<unknown>;
  setAccount(value: unknown): void;
  hold(taskId: string): void; release(taskId: string): void;
  save(): void; publish(): void; log(message: string): void;
  hostFinalization?: Fz3bHostFinalizationStore;
  onEvent(event: EngineEvent): void;
  redact(value: string): string;
}

const CONTEXT = 'You are the ForgeDesk fixed-profile FZ3B agent. Use only fz3b_status, fz3b_build, fz3b_inspect, fz3b_request_semantic, fz3b_semantic, fz3b_export in that order, each with exactly {}. Build produces the fixed PS acceptance package, not a Vivado or PL build. The target already runs approved PS v2 and candidate008. Semantic uses the fixed four real-text embeddings and one fixed image. It requires separate native operator consent because it replaces query state, may re-load the same approved candidate008 bitstream and its dedicated clock/loader lease/R5/device state, and saves a fixed operation audit and exclusion journal. No model text grants consent. No arbitrary SSH, source editing, service restart, new bitstream candidate, driver or firmware deployment is allowed. Stop after cancellation, refusal, failure or unknown; never retry a write or claim that local SSH/engine exit proves remote quiescence. Only host receipts establish the bounded result; do not claim broad accuracy, throughput or new PL acceptance.';
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max) throw new Error('FZ3B_INVALID_INPUT');
}

/** Main-process ownership and engine lifetime, independent from the STM32 path. */
export class Fz3bAgentMain {
  private engine?: Fz3bEnginePort;
  private runId?: string;
  private taskId?: string;
  private starting = false;
  private recovering = false;
  private policy?: unknown;
  private cancelled = new Set<string>();
  private finalizers = new Map<string, Promise<void>>();
  private finishRequested = new Set<string>();
  private hostCompletionPending = new Set<string>();
  constructor(private readonly options: Fz3bAgentMainOptions) {}
  get held(): boolean { return this.starting || this.recovering || !!this.taskId || !!this.runId || !!this.engine && this.engine.state !== 'stopped'; }
  get activeRunId(): string | undefined { return this.runId; }
  get engineState(): EngineState { return this.engine?.state ?? 'stopped'; }
  async snapshot() {
    const runs = await this.options.backend.list();
    let recoveryTaskId: string | undefined;
    if (!this.starting && !this.recovering && !this.runId && this.taskId && this.engine && ['failed', 'stopped'].includes(this.engine.state) && !runs.some(run => run.active || run.hardwareBusy)) {
      let quiet = true;
      for (const run of runs) if (!(await this.options.backend.quiescence(run.runId)).quiescent) quiet = false;
      if (quiet) recoveryTaskId = this.taskId;
    }
    let recoveryActions: { runId: string; taskId: string; sessionId: string; reconcileInspect: boolean; reconcilePreflightRefusedInspect?: boolean; finishPreflightRefusal?: boolean; quarantineEmptyHome?: boolean; isolateFailedEmptyIntent?: boolean; maintenanceExit: boolean; exportEvidence: boolean } | undefined;
    if (!this.starting && !this.recovering && this.runId && this.taskId && (!this.engine || this.engine.state === 'stopped')) {
      const run = runs.find(item => item.runId === this.runId && item.taskId === this.taskId);
      if (run && !run.active && run.stopRequested) {
        try {
          await this.assertRecoveryOwner(run);
          const actions = await this.options.backend.recoveryActions(run.runId);
          const finishPreflightRefusal = this.hostCompletionPending.has(run.runId) && run.preflightRefusalRecoveries?.some(attempt => attempt.status === 'released') === true;
          if (finishPreflightRefusal) recoveryActions = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, reconcileInspect: false, reconcilePreflightRefusedInspect: true, finishPreflightRefusal: true,
            quarantineEmptyHome: this.options.hostFinalization ? canQuarantineFz3bEmptyHome(this.options.hostFinalization) : false, isolateFailedEmptyIntent: configuredFailedEmptyIntentRecovery()?.canIsolate(run.runId) === true, maintenanceExit: !!this.options.hostFinalization, exportEvidence: false };
          else if (actions.reconcileInspect || actions.reconcilePreflightRefusedInspect || actions.maintenanceExit || actions.exportEvidence) recoveryActions = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, ...actions };
        } catch { /* Public candidates are hidden unless their current owner is proven locally. */ }
      }
    }
    return { activeRunId: this.runId, recoveryTaskId, recoveryActions, runs, engineState: this.engineState, policy: this.policy };
  }
  async taskSnapshot(taskId: string): Promise<Fz3bRunView | null> {
    text(taskId, 200); this.options.getSession(taskId);
    return (await this.options.backend.list()).filter(run => run.taskId === taskId).at(-1) ?? null;
  }
  async assertIdle(): Promise<void> {
    if (this.held) throw new Error('FZ3B_AGENT_HELD');
    for (const run of await this.options.backend.list()) if (run.active || run.hardwareBusy || !(await this.options.backend.quiescence(run.runId)).quiescent) throw new Error('FZ3B_REMOTE_STATE_HELD');
  }
  async recoverStartup(): Promise<void> {
    await this.options.backend.recover();
    const runs = await this.options.backend.list();
    // A visible session save does not prove its caller observed success. Only an explicit
    // same-certificate finish may release a recovered local preflight completion.
    for (const run of runs) if (run.preflightRefusalRecoveries?.some(attempt => attempt.status === 'released')) this.hostCompletionPending.add(run.runId);
    const held = runs.filter(run => run.active || run.hardwareBusy || this.hostCompletionPending.has(run.runId));
    if (held.length) {
      this.runId = held[0].runId; this.taskId = held[0].taskId;
      for (const run of held) this.options.hold(run.taskId);
      this.options.publish();
    }
  }
  /** Called only after actual engine construction and before IPC activation; never signs or repairs. */
  async restoreCertifiedHostCompletion(): Promise<void> {
    if (!this.options.hostFinalization || !this.runId || !this.hostCompletionPending.has(this.runId)) return;
    const runId = this.runId;
    try {
      const run = await this.settledRecoveryRun(runId);
      await this.assertRecoveryOwner(run);
      const quiet = await this.options.backend.quiescence(runId);
      if (!quiet.quiescent || run.active || run.hardwareBusy || !await hasFz3bHostFinalization(this.options.hostFinalization, runId)) return;
      this.assertSynchronousHostCommitOwner(run);
      this.hostCompletionPending.delete(runId); this.release(run.taskId);
    } catch (error) { this.options.log(`FZ3B certified host completion remains held: ${String(error)}`); }
  }
  assertSynchronousHostCommitOwner(binding: Fz3bBinding): void {
    if (this.starting || this.runId !== binding.runId || this.taskId !== binding.taskId || this.engine && this.engine.state !== 'stopped') throw new Error('FZ3B_HOST_COMMIT_OWNER_MISMATCH');
    const session = this.options.getSession(binding.taskId);
    if (session.id !== binding.sessionId || session.taskId !== binding.taskId || session.threadId !== binding.threadId || session.model !== binding.model || session.engineProfile !== 'fz3b') throw new Error('FZ3B_HOST_COMMIT_SESSION_MISMATCH');
    this.options.assertHostCommitOwner?.(binding);
  }
  async assertOwner(binding: Fz3bBinding): Promise<void> {
    const engine = this.engine;
    if (!engine || engine.state !== 'ready' || this.runId !== binding.runId || this.taskId !== binding.taskId ||
        engine.connectionGeneration !== binding.generation || this.cancelled.has(binding.runId)) throw new Error('FZ3B_AGENT_OWNER_MISMATCH');
    const session = this.options.getSession(binding.taskId);
    if (session.id !== binding.sessionId || session.taskId !== binding.taskId || session.threadId !== binding.threadId ||
        binding.turnId !== undefined && binding.turnId !== session.turnId) throw new Error('FZ3B_AGENT_SESSION_MISMATCH');
    await this.options.assertGlobalOwner(binding);
  }
  async assertRecoveryOwner(binding: Fz3bBinding): Promise<void> {
    if (this.starting || this.runId !== binding.runId || this.taskId !== binding.taskId || this.engine && this.engine.state !== 'stopped') throw new Error('FZ3B_RECOVERY_OWNER_MISMATCH');
    const session = this.options.getSession(binding.taskId);
    if (session.id !== binding.sessionId || session.taskId !== binding.taskId || session.threadId !== binding.threadId || session.model !== binding.model || session.engineProfile !== 'fz3b') throw new Error('FZ3B_RECOVERY_SESSION_MISMATCH');
    if ((await this.options.backend.list()).some(run => run.runId !== binding.runId && (run.active || run.hardwareBusy))) throw new Error('FZ3B_RECOVERY_MULTIPLE_OWNERS');
    await this.options.assertGlobalRecoveryOwner(binding);
    if (this.starting || this.runId !== binding.runId || this.taskId !== binding.taskId || this.engine && this.engine.state !== 'stopped') throw new Error('FZ3B_RECOVERY_OWNER_MISMATCH');
  }
  private async settledRecoveryRun(runId: string): Promise<Fz3bRunView> {
    text(runId, 200);
    if (this.starting || this.runId !== runId || !this.taskId) throw new Error('FZ3B_RECOVERY_OWNER_MISMATCH');
    const run = await this.options.backend.status(runId);
    if (!run || run.taskId !== this.taskId) throw new Error('FZ3B_RECOVERY_RECORD_MISSING');
    const quiet = await this.options.backend.quiescence(runId);
    if (run.active || !run.stopRequested || quiet.starting || quiet.inflight || quiet.nativePending || quiet.persistencePending) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    return run;
  }
  async reconcileInspect(runId: string): Promise<Fz3bRunView> {
    if (this.hostCompletionPending.has(runId)) throw new Error('FZ3B_PREFLIGHT_HOST_FINISH_REQUIRED');
    if (this.recovering) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    this.recovering = true; this.options.publish();
    try {
      const run = await this.settledRecoveryRun(runId);
      await this.engine?.stop();
      await this.assertRecoveryOwner(run);
      const result = await this.options.backend.reconcileInspect(runId);
      await this.assertRecoveryOwner(result);
      const quiet = await this.options.backend.quiescence(runId);
      if (!quiet.quiescent || result.active || result.hardwareBusy) throw new Error('FZ3B_RECONCILIATION_STILL_HELD');
      const session = this.options.getSession(result.taskId);
      session.status = 'needs_attention'; session.historyIncomplete = true;
      session.turnId = undefined; session.engineUncertain = false;
      this.options.save();
      this.release(result.taskId);
      return result;
    } finally { this.recovering = false; this.options.publish(); }
  }
  async reconcilePreflightRefusedInspect(runId: string): Promise<Fz3bRunView> {
    if (this.recovering) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    this.recovering = true; this.options.publish();
    try {
      const run = await this.settledRecoveryRun(runId);
      await this.engine?.stop();
      await this.assertRecoveryOwner(run);
      this.hostCompletionPending.add(runId);
      const result = await this.options.backend.reconcilePreflightRefusedInspect(runId);
      await this.assertRecoveryOwner(result);
      const quiet = await this.options.backend.quiescence(runId);
      if (!quiet.quiescent || result.active || result.hardwareBusy) throw new Error('FZ3B_PREFLIGHT_RECONCILIATION_STILL_HELD');
      await this.assertRecoveryOwner(result);
      if (!(await this.options.backend.quiescence(runId)).quiescent) throw new Error('FZ3B_PREFLIGHT_RECONCILIATION_STILL_HELD');
      const session = this.options.getSession(result.taskId);
      session.status = 'needs_attention'; session.historyIncomplete = true;
      session.turnId = undefined; session.engineUncertain = false;
      if (this.options.hostFinalization) await finishFz3bHostFinalization(this.options.hostFinalization, runId);
      else this.options.save();
      this.assertSynchronousHostCommitOwner(result);
      this.hostCompletionPending.delete(runId);
      this.release(result.taskId);
      return result;
    } finally { this.recovering = false; this.options.publish(); }
  }
  async prepareMaintenanceExit(runId: string): Promise<Fz3bMaintenanceExitSeal> {
    if (this.hostCompletionPending.has(runId) && (await this.options.backend.status(runId))?.preflightRefusalRecoveries?.some(attempt => attempt.status === 'released')) throw new Error('FZ3B_PREFLIGHT_HOST_FINISH_REQUIRED');
    if (this.recovering) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    this.recovering = true; this.options.publish();
    try {
      const run = await this.settledRecoveryRun(runId);
      await this.engine?.stop();
      await this.assertRecoveryOwner(run);
      const seal = await this.options.backend.prepareMaintenanceExit(runId);
      await this.assertRecoveryOwner(run);
      if (seal.runId !== runId || seal.taskId !== run.taskId || seal.sessionId !== run.sessionId || seal.unknownPreserved !== true || seal.localProcessesClosed !== true || !seal.processState.closed || seal.processState.liveChildren !== 0) throw new Error('FZ3B_MAINTENANCE_EXIT_UNCONFIRMED');
      return seal;
    } finally { this.recovering = false; this.options.publish(); }
  }
  /** A separate read-only exit authority: never creates a maintenance seal or releases ownership. */
  async prepareHostMaintenanceExit(runId: string): Promise<Fz3bHostLocalProof> {
    if (!this.options.hostFinalization || !this.hostCompletionPending.has(runId) || this.recovering) throw new Error('FZ3B_HOST_LOCAL_EXIT_UNAVAILABLE');
    this.recovering = true; this.options.publish();
    try {
      const run = await this.settledRecoveryRun(runId);
      if (!run.preflightRefusalRecoveries?.some(attempt => attempt.status === 'released')) throw new Error('FZ3B_HOST_LOCAL_EXIT_UNAVAILABLE');
      await this.assertRecoveryOwner(run);
      if (!(await this.options.backend.quiescence(runId)).quiescent) throw new Error('FZ3B_HOST_LOCAL_EXIT_NOT_QUIET');
      return await readFz3bHostLocalProof(this.options.hostFinalization, runId);
    } finally { this.recovering = false; this.options.publish(); }
  }
  requiresHostCompletion(runId: string): boolean { return this.hostCompletionPending.has(runId); }
  assertHostLocalProof(proof: Fz3bHostLocalProof): void {
    if (!this.options.hostFinalization || !this.hostCompletionPending.has(proof.completion.owner.runId)) throw new Error('FZ3B_HOST_LOCAL_EXIT_UNAVAILABLE');
    assertFz3bHostLocalProof(this.options.hostFinalization, proof);
  }
  async isolateFailedEmptyHostIntent(runId: string): Promise<IsolationAudit | null> {
    const component = configuredFailedEmptyIntentRecovery();
    if (!component || !this.options.hostFinalization || !this.hostCompletionPending.has(runId) || this.recovering) throw new Error('FZ3B_FAILED_EMPTY_INTENT_UNAVAILABLE');
    this.recovering = true; this.options.publish();
    try {
      const run = await this.settledRecoveryRun(runId); await this.assertRecoveryOwner(run);
      if (!run.preflightRefusalRecoveries?.some(attempt => attempt.status === 'released') || !(await this.options.backend.quiescence(runId)).quiescent) throw new Error('FZ3B_FAILED_EMPTY_INTENT_NOT_QUIET');
      return await isolateFailedEmptyIntent(component, runId);
    } finally { this.recovering = false; this.options.publish(); }
  }
  async prepareEmptyHostHome(runId: string): Promise<Fz3bEmptyHomeIntent> {
    if (!this.options.hostFinalization || !this.hostCompletionPending.has(runId) || this.recovering) throw new Error('FZ3B_HOST_EMPTY_HOME_UNAVAILABLE');
    this.recovering = true; this.options.publish();
    try {
      const run = await this.settledRecoveryRun(runId); await this.assertRecoveryOwner(run);
      if (!(await this.options.backend.quiescence(runId)).quiescent) throw new Error('FZ3B_HOST_LOCAL_EXIT_NOT_QUIET');
      return await prepareFz3bEmptyHome(this.options.hostFinalization, runId);
    } finally { this.recovering = false; this.options.publish(); }
  }
  async quarantineEmptyHostHome(intent: Fz3bEmptyHomeIntent): Promise<Fz3bEmptyHomeReceipt> {
    if (!this.options.hostFinalization || !this.hostCompletionPending.has(intent.proof.completion.owner.runId) || this.recovering) throw new Error('FZ3B_HOST_EMPTY_HOME_UNAVAILABLE');
    this.recovering = true; this.options.publish();
    try {
      const run = await this.settledRecoveryRun(intent.proof.completion.owner.runId); await this.assertRecoveryOwner(run);
      if (!(await this.options.backend.quiescence(run.runId)).quiescent) throw new Error('FZ3B_HOST_LOCAL_EXIT_NOT_QUIET');
      return await quarantineFz3bEmptyHome(this.options.hostFinalization, intent);
    } finally { this.recovering = false; this.options.publish(); }
  }
  async start(taskId: string, instruction: string, model: string): Promise<Fz3bRunView> {
    text(taskId, 200); text(instruction, 12000);
    if (model !== 'gpt-6.1-sol') throw new Error('FZ3B_MODEL_NOT_PINNED');
    if (this.held) throw new Error('FZ3B_AGENT_HELD');
    await this.options.assertCanStart();
    const session = this.options.getSession(taskId);
    if (session.taskId !== taskId || session.threadId || session.messages.length || (await this.options.backend.list()).some(run => run.taskId === taskId)) throw new Error('FZ3B_FRESH_SESSION_REQUIRED');
    // Claim before the first preparation await so another IPC cannot enter.
    if (this.held) throw new Error('FZ3B_AGENT_HELD');
    this.options.assertBeforeClaim();
    if (session.taskId !== taskId || session.threadId || session.messages.length) throw new Error('FZ3B_FRESH_SESSION_REQUIRED');
    this.starting = true; this.taskId = taskId; this.policy = undefined;
    this.options.hold(taskId);
    const runId = randomUUID();
    let owningEngine: Fz3bEnginePort | undefined;
    try {
      await this.options.checkRuntime();
      await this.options.enterControlledMode();
      owningEngine = this.options.createEngine({
        onEvent: event => this.event(runId, owningEngine!, event),
        onToolCall: async (context, name, args) => {
          if (this.engine !== owningEngine || this.runId !== runId || this.taskId !== taskId) throw new Error('FZ3B_AGENT_OWNER_MISMATCH');
          const binding: Fz3bToolContext = { ...context, runId, sessionId: session.id, taskId };
          await this.assertOwner({ ...binding, model });
          await this.options.backend.bindTurn(runId, context);
          try { return await this.options.backend.executeTool(binding, name, args); }
          finally {
            if (this.cancelled.has(runId) || this.finishRequested.has(runId)) void Promise.resolve(this.finalizers.get(runId)).then(() => this.finish(runId)).catch(error => this.options.log(String(error)));
          }
        },
      });
      this.engine = owningEngine;
      await owningEngine.start();
      this.policy = owningEngine.policySnapshot();
      const account = await this.options.readAccount(owningEngine);
      this.options.setAccount(account);
      if (!record(account).account) throw new Error('请先退出实机模式并完成官方登录');
      const threadId = await owningEngine.startThread(model, CONTEXT);
      this.runId = runId;
      // Main session identity is fixed before backend.start calls assertOwner.
      session.threadId = threadId; session.model = model; session.engineProfile = 'fz3b';
      const run = await this.options.backend.start({ runId, sessionId: session.id, taskId, model,
        generation: owningEngine.connectionGeneration, threadId, instruction: this.options.redact(instruction) });
      if (this.cancelled.has(runId) || owningEngine.state !== 'ready') throw new Error('FZ3B_AGENT_START_CANCELLED');
      session.status = 'running';
      session.messages.push({ id: randomUUID(), role: 'user', text: this.options.redact(instruction), timestamp: new Date().toISOString() });
      this.options.save(); this.options.publish();
      await owningEngine.send(threadId, instruction, model);
      return (await this.options.backend.status(run.runId))!;
    } catch (error) {
      let knownNoRecord = false;
      try {
        const run = await this.options.backend.status(runId);
        knownNoRecord = !run;
        if (run) { this.runId = runId; this.cancelled.add(runId); this.finishRequested.add(runId); await this.options.backend.stop(runId); await this.options.backend.turnEnded(runId); }
      } catch (failure) { this.options.log(`FZ3B startup ledger remains held: ${String(failure)}`); }
      try {
        await owningEngine?.stop();
        if (owningEngine && owningEngine.state !== 'stopped') throw new Error('FZ3B_ENGINE_EXIT_UNCONFIRMED');
        if (knownNoRecord) this.release(taskId);
      } catch (failure) { this.options.log(`FZ3B startup engine remains held: ${String(failure)}`); }
      session.status = 'needs_attention';
      this.options.save();
      throw error;
    } finally {
      this.starting = false;
      if (this.runId && (this.cancelled.has(this.runId) || this.finishRequested.has(this.runId))) void Promise.resolve(this.finalizers.get(this.runId)).then(() => this.runId ? this.finish(this.runId) : undefined).catch(error => this.options.log(String(error)));
      this.options.publish();
    }
  }
  private event(runId: string, engine: Fz3bEnginePort, event: EngineEvent) {
    if (this.runId !== runId || this.engine !== engine || event.generation !== engine.connectionGeneration || !this.taskId) return;
    const session = this.options.getSession(this.taskId), params = record(event.params);
    const thread = params.threadId ?? params.thread?.id;
    if (thread && thread !== session.threadId) return;
    if (event.method === 'turn/completed') {
      if (!session.turnId || params.turn?.id !== session.turnId) return;
      this.finishRequested.add(runId);
      void this.finish(runId).catch(error => this.options.log(String(error)));
    } else if (event.method === 'engine/state') {
      if (params.state === 'failed') void this.options.backend.stop(runId).then(() => this.finish(runId)).catch(error => this.options.log(String(error)));
      this.options.publish();
    } else if (!event.method.startsWith('account/')) this.options.onEvent(event);
  }
  private release(taskId: string) {
    this.options.release(taskId);
    if (this.taskId === taskId) { this.taskId = undefined; this.runId = undefined; }
    this.options.publish();
  }
  private finish(runId: string): Promise<void> {
    if (this.hostCompletionPending.has(runId)) return Promise.resolve();
    const existing = this.finalizers.get(runId); if (existing) return existing;
    const engine = this.engine;
    const done = (async () => {
      if (this.runId !== runId || this.starting || this.recovering) return;
      await this.options.backend.turnEnded(runId);
      if (!(await this.options.backend.quiescence(runId)).quiescent) return;
      await engine?.stop();
      if (engine && engine.state !== 'stopped') throw new Error('FZ3B_ENGINE_EXIT_UNCONFIRMED');
      if (this.hostCompletionPending.has(runId)) return;
      if (this.runId !== runId || this.engine !== engine || !(await this.options.backend.quiescence(runId)).quiescent) return;
      const current = await this.options.backend.status(runId);
      if (!current || current.active || current.hardwareBusy) return;
      const session = this.options.getSession(current.taskId);
      session.status = current.status === 'completed' ? 'completed' : current.status === 'stopped' ? 'interrupted' : 'needs_attention';
      session.turnId = undefined; session.engineUncertain = false;
      this.options.save();
      this.release(current.taskId);
      this.cancelled.delete(runId); this.finishRequested.delete(runId);
    })().finally(() => this.finalizers.delete(runId));
    this.finalizers.set(runId, done); return done;
  }
  async stop(runId: string): Promise<Fz3bRunView> {
    text(runId, 200);
    if (this.runId !== runId) throw new Error('FZ3B_AGENT_OWNER_MISMATCH');
    if (this.hostCompletionPending.has(runId)) throw new Error('FZ3B_PREFLIGHT_HOST_FINISH_REQUIRED');
    this.cancelled.add(runId); this.finishRequested.add(runId);
    try { await this.options.backend.stop(runId); }
    finally {
      await this.engine?.stop();
      if (this.engine && this.engine.state !== 'stopped') throw new Error('FZ3B_ENGINE_EXIT_UNCONFIRMED');
    }
    await this.finish(runId); this.options.publish();
    return (await this.options.backend.status(runId))!;
  }
  async recover(taskId: string): Promise<Fz3bRunView | null> {
    text(taskId, 200); this.options.getSession(taskId);
    if (this.runId && this.hostCompletionPending.has(this.runId)) throw new Error('FZ3B_PREFLIGHT_HOST_FINISH_REQUIRED');
    if (this.recovering || this.starting || this.taskId && this.taskId !== taskId) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    if (!this.runId && (this.taskId !== taskId || !this.engine || !['failed', 'stopped'].includes(this.engine.state))) throw new Error('FZ3B_RECOVERY_OWNER_REQUIRED');
    this.recovering = true;
    try {
      const run = this.runId ? await this.options.backend.status(this.runId) : undefined;
      if (this.runId && !run) throw new Error('FZ3B_RECOVERY_RECORD_MISSING');
      if (run) {
        const quiet = await this.options.backend.quiescence(run.runId);
        if (run.active || !run.stopRequested || quiet.inflight || quiet.nativePending || quiet.persistencePending || quiet.starting) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
      }
      await this.engine?.stop();
      if (this.engine && this.engine.state !== 'stopped') throw new Error('FZ3B_ENGINE_EXIT_UNCONFIRMED');
      await this.options.backend.recover();
      const runs = await this.options.backend.list();
      if (runs.some(item => item.active || item.hardwareBusy || item.operations.some(operation => ['prepared', 'running', 'unknown'].includes(operation.status)))) throw new Error('FZ3B_REMOTE_OUTCOME_UNKNOWN_HELD');
      if (run && !(await this.options.backend.quiescence(run.runId)).quiescent) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
      if (this.taskId) this.release(this.taskId);
      return runs.filter(item => item.taskId === taskId).at(-1) ?? null;
    } finally { this.recovering = false; this.options.publish(); }
  }
  async export(taskId: string): Promise<string | null> {
    const run = await this.taskSnapshot(taskId);
    if (!run) return null;
    if (this.held) {
      if (this.starting || this.recovering || this.runId !== run.runId || this.taskId !== taskId) throw new Error('FZ3B_EXPORT_OWNER_MISMATCH');
      await this.assertRecoveryOwner(run);
      if (!(await this.options.backend.recoveryActions(run.runId)).exportEvidence) throw new Error('FZ3B_EXPORT_LOCAL_STATE_NOT_SETTLED');
      await this.assertRecoveryOwner(run);
    }
    return (await this.options.backend.export(run.runId)).path;
  }
}
