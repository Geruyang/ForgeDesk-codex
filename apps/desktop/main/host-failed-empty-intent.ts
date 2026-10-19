import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export const FAILED_INTENT_PROTOCOL = 'fz3b-failed-empty-intent-v1';
export const FAILED_INTENT_PURPOSE = 'isolate-failed-empty-intent-only';
const digestPattern = /^[a-f0-9]{64}$/;
const sourcePattern = /^fz3b-host-empty-[a-f0-9]{64}\.intent\.json$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function fail(code: string): never { throw new Error(`FZ3B_FAILED_EMPTY_INTENT_${code}`); }
function requireThat(value: unknown, code: string): asserts value { if (!value) fail(code); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') { const result = JSON.stringify(value); requireThat(result !== undefined, 'JSON_REQUIRED'); return result; }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
const hash = (value: unknown) => sha(canonical(value));
export async function runFreshIsolationCheck(created: number, expires: number, revalidate: () => Promise<void>): Promise<void> {
  const fresh = () => { const now = Date.now(); return now >= created && now < expires; };
  requireThat(fresh(), 'EXPIRED'); await revalidate(); requireThat(fresh(), 'EXPIRED');
}
export function startOwnedIsolationChild(started: number, own: () => void, write: () => void, arm: (remaining: number) => void, now: () => number = performance.now.bind(performance)): void {
  own(); const elapsed = now() - started;
  requireThat(elapsed >= 0 && elapsed < 5000, 'NATIVE_STARTUP_BUDGET'); arm(5000 - elapsed); write();
}
type JsonObject = Record<string, any>;
export interface RequiredIsolation { runId: string; sourceName: string; failureEvidenceSha256: string }
export interface IsolationAudit extends RequiredIsolation { recoveryId: string; observationSha256: string; nativeSealSha256: string; proofSha256: string; targetSha256: string; completeChainSha256: string; candidateSourceSha256: string }
export interface CurrentOwnedOperations { capture: object; sha256: string }
export interface FailedIntentDeployment { executable: string; executableSha256: string; candidateSourceSha256: string; approvedIsolationSourceSha256s: readonly string[] }
export interface FailedIntentProof {
  completion: { owner: { runId: string; taskId: string; sessionId: string }; completeChainSha256: string };
  targetSha256: string;
}
export interface FailedIntentOptions {
  root: string;
  deployment: FailedIntentDeployment;
  // All callbacks are main composition dependencies, never IPC/renderer values.
  readProof(runId: string): Promise<FailedIntentProof>;
  assertProof(proof: FailedIntentProof): void;
  assertOwner(owner: FailedIntentProof['completion']['owner']): void | Promise<void>;
  captureCurrentOwnedIdle(): CurrentOwnedOperations;
  assertCurrentOwnedIdle(proof: CurrentOwnedOperations): void;
  assertPrivateDeployment(deployment: FailedIntentDeployment): void;
  // Persisted, trusted recovery holds must survive restart. No inference from missing files.
  requirements(): readonly RequiredIsolation[];
  ownChild(child: ChildProcessWithoutNullStreams): void;
  recordChildClose(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void;
}
const components = new WeakMap<object, { validate(proof: FailedIntentProof): readonly IsolationAudit[]; isolate(runId: string): Promise<IsolationAudit | null> }>();
function assertRequired(item: RequiredIsolation): void {
  requireThat(item && uuidPattern.test(item.runId) && sourcePattern.test(item.sourceName) && digestPattern.test(item.failureEvidenceSha256), 'REQUIREMENT_INVALID');
}
function assertAudit(item: IsolationAudit): void {
  assertRequired(item); requireThat(uuidPattern.test(item.recoveryId) && [item.observationSha256, item.nativeSealSha256, item.proofSha256, item.targetSha256, item.completeChainSha256, item.candidateSourceSha256].every(value => digestPattern.test(value)), 'AUDIT_INVALID');
  requireThat(Object.keys(item).sort().join(',') === 'candidateSourceSha256,completeChainSha256,failureEvidenceSha256,nativeSealSha256,observationSha256,proofSha256,recoveryId,runId,sourceName,targetSha256', 'AUDIT_FIELDS');
}
export function assertIsolationAuditBindings(audits: readonly IsolationAudit[], requirements: readonly RequiredIsolation[], proof: FailedIntentProof, approvedSources: readonly string[]): void {
  requireThat(approvedSources.length > 0 && approvedSources.length <= 8 && approvedSources.every(value => digestPattern.test(value)) && new Set(approvedSources).size === approvedSources.length, 'SOURCE_POLICY_REQUIRED');
  const seen = new Set<string>();
  for (const audit of audits) {
    assertAudit(audit); requireThat(!seen.has(audit.sourceName) && approvedSources.includes(audit.candidateSourceSha256), 'AUDIT_DUPLICATE_OR_SOURCE_POLICY'); seen.add(audit.sourceName);
    if (audit.runId === proof.completion.owner.runId) requireThat(audit.proofSha256 === hash(proof) && audit.targetSha256 === proof.targetSha256 && audit.completeChainSha256 === proof.completion.completeChainSha256, 'AUDIT_CURRENT_PROOF_MISMATCH');
  }
  for (const required of requirements) {
    assertRequired(required); requireThat(audits.filter(audit => audit.runId === required.runId && audit.sourceName === required.sourceName && audit.failureEvidenceSha256 === required.failureEvidenceSha256).length === 1, 'REQUIRED_ISOLATION_MISSING');
  }
}
function assertDeployment(options: FailedIntentOptions): void {
  const deployment = options.deployment;
  requireThat(process.platform === 'win32' && path.isAbsolute(deployment.executable) && digestPattern.test(deployment.executableSha256) && digestPattern.test(deployment.candidateSourceSha256), 'PINNED_DEPLOYMENT_REQUIRED');
  requireThat(Array.isArray(deployment.approvedIsolationSourceSha256s) && deployment.approvedIsolationSourceSha256s.length > 0 && deployment.approvedIsolationSourceSha256s.length <= 8 && deployment.approvedIsolationSourceSha256s.every(value => digestPattern.test(value)) && deployment.approvedIsolationSourceSha256s.includes(deployment.candidateSourceSha256), 'SOURCE_POLICY_REQUIRED');
  options.assertPrivateDeployment(deployment);
  const file = path.resolve(deployment.executable); let current = path.dirname(file);
  for (;;) {
    const info = fs.lstatSync(current); requireThat(info.isDirectory() && !info.isSymbolicLink(), 'HELPER_ANCESTOR');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  const named = fs.lstatSync(file); requireThat(named.isFile() && !named.isSymbolicLink() && named.nlink === 1 && named.size > 0 && named.size < 1048576, 'HELPER_FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), final = fs.lstatSync(file);
    const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.size, stat.ctimeMs, stat.mtimeMs, stat.nlink];
    requireThat([before, after, final].every(info => canonical(identity(info)) === canonical(identity(named))) && sha(bytes) === deployment.executableSha256, 'HELPER_PIN_CHANGED');
  } finally { fs.closeSync(fd); }
}
function parseLine(line: string): JsonObject {
  requireThat(Buffer.byteLength(line) <= 131072, 'OUTPUT_BUDGET');
  let value: JsonObject;
  try { value = JSON.parse(line); } catch { fail('JSON_INVALID'); }
  requireThat(value && !Array.isArray(value) && value.protocol === FAILED_INTENT_PROTOCOL, 'PROTOCOL'); return value;
}
function nativeEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot;
  requireThat(systemRoot && path.isAbsolute(systemRoot), 'WINDOWS_ROOT_REQUIRED');
  // Do not inherit CLR profiler/startup-hook or assembly-probing environment variables.
  return { SystemRoot: systemRoot, WINDIR: systemRoot };
}

/** Main-only state machine. A terminal response is provisional until the owned native child closes. */
export class IsolationProtocolSession {
  #state: 'observing' | 'dialog' | 'moving' | 'terminal' = 'observing';
  #observation?: JsonObject;
  #provisional?: IsolationAudit | null;
  constructor(private readonly request: JsonObject, private readonly fresh: () => Promise<void>, private readonly send: (line: string) => void, private readonly captureTerminal: (message: JsonObject) => void = () => {}) {}
  async receive(message: JsonObject): Promise<void> {
    requireThat(message.protocol === FAILED_INTENT_PROTOCOL && this.#state !== 'terminal', 'PROTOCOL_ORDER');
    if (message.status === 'held') fail('NATIVE_HELD');
    if (this.#state === 'observing') {
      requireThat(Object.keys(message).sort().join(',') === 'challenge,observation,observationSha256,protocol,status' && message.status === 'observed', 'OBSERVATION_REQUIRED');
      const observed = message.observation;
      requireThat(observed && observed.protocol === FAILED_INTENT_PROTOCOL && observed.purpose === FAILED_INTENT_PURPOSE && observed.origin === 'unproven-origin-zero-byte-orphan' &&
        observed.root === this.request.root && observed.runId === this.request.runId && observed.proofSha256 === this.request.proofSha256 &&
        observed.targetSha256 === this.request.targetSha256 && observed.completeChainSha256 === this.request.completeChainSha256 &&
        observed.failureEvidenceSha256 === this.request.failureEvidenceSha256 && observed.candidateSourceSha256 === this.request.candidateSourceSha256 &&
        observed.currentOwnedOperationsSha256 === this.request.currentOwnedOperationsSha256 && observed.expiresAt === this.request.expiresAt && observed.sourceName === this.request.expectedSourceName &&
        observed.primaryExecutableSha256 === this.request.primaryExecutableSha256 && observed.primaryNativePid === this.request.primaryNativePid &&
        uuidPattern.test(observed.recoveryId) && uuidPattern.test(message.challenge) && observed.challenge === message.challenge &&
        digestPattern.test(message.observationSha256) && hash(observed) === message.observationSha256 &&
        observed.sourceMetadata?.size === 0 && observed.sourceMetadata?.links === 1 && observed.sourceMetadata?.dataStreams === 'unnamed-data-only' && digestPattern.test(observed.sourceMetadataSha256) &&
        hash(observed.sourceMetadata) === observed.sourceMetadataSha256, 'OBSERVATION_BINDING');
      this.#observation = message; await this.fresh(); this.#state = 'dialog'; this.#commit(); return;
    }
    if (message.status === 'declined' && this.#state === 'dialog') { this.#provisional = null; this.#state = 'terminal'; return; }
    if (message.status === 'consent-captured' && this.#state === 'dialog') {
      requireThat(Object.keys(message).sort().join(',') === 'challenge,observationSha256,protocol,status' && message.challenge === this.#observation!.challenge && message.observationSha256 === this.#observation!.observationSha256, 'CONSENT_BINDING');
      await this.fresh(); this.#state = 'moving'; this.#commit(); return;
    }
    requireThat(message.status === 'isolated' && this.#state === 'moving' && Object.keys(message).sort().join(',') === 'audit,closeToken,protocol,status' && digestPattern.test(message.closeToken), 'COMPLETION_ORDER');
    const audit = message.audit as IsolationAudit; assertAudit(audit);
    requireThat(audit.runId === this.request.runId && audit.sourceName === this.request.expectedSourceName && audit.failureEvidenceSha256 === this.request.failureEvidenceSha256 &&
      audit.proofSha256 === this.request.proofSha256 && audit.targetSha256 === this.request.targetSha256 && audit.completeChainSha256 === this.request.completeChainSha256 && audit.candidateSourceSha256 === this.request.candidateSourceSha256 &&
      audit.recoveryId === this.#observation!.observation.recoveryId && audit.observationSha256 === this.#observation!.observationSha256, 'COMPLETION_BINDING');
    this.captureTerminal(message); this.#provisional = audit; this.#state = 'terminal';
  }
  #commit(): void {
    this.send(JSON.stringify({ protocol: FAILED_INTENT_PROTOCOL, purpose: FAILED_INTENT_PURPOSE, challenge: this.#observation!.challenge,
      observationSha256: this.#observation!.observationSha256, proofSha256: this.request.proofSha256, currentOwnedOperationsSha256: this.request.currentOwnedOperationsSha256 }) + '\n');
  }
  closed(code: number | null, signal: NodeJS.Signals | null): IsolationAudit | null {
    requireThat(code === 0 && signal === null && this.#state === 'terminal' && this.#provisional !== undefined, 'CHILD_CLOSE_UNCONFIRMED'); return this.#provisional;
  }
}

export class FailedEmptyIntentRecovery {
  #busy = false;
  #closeCapabilities = new WeakMap<object, { child: ChildProcessWithoutNullStreams; audit: IsolationAudit; closeToken: string; primary: JsonObject }>();
  constructor(private readonly options: FailedIntentOptions) {
    requireThat(options && path.isAbsolute(options.root) && typeof options.readProof === 'function' && typeof options.assertProof === 'function' &&
      typeof options.assertOwner === 'function' && typeof options.captureCurrentOwnedIdle === 'function' && typeof options.assertCurrentOwnedIdle === 'function' &&
      typeof options.assertPrivateDeployment === 'function' && typeof options.requirements === 'function' && typeof options.ownChild === 'function' && typeof options.recordChildClose === 'function', 'MAIN_COMPOSITION_REQUIRED');
    components.set(this, { validate: proof => originalValidate.call(this, proof), isolate: runId => originalIsolate.call(this, runId) });
  }
  canIsolate(runId: string): boolean {
    try { const required = this.options.requirements().filter(item => item.runId === runId); return !this.#busy && required.length === 1 && (assertRequired(required[0]), true); }
    catch { return false; }
  }
  /** Validates every failed container before the unchanged successful-triplet validator runs. */
  validateIsolations(proof: FailedIntentProof): readonly IsolationAudit[] {
    const started = performance.now();
    const idle = this.options.captureCurrentOwnedIdle(); this.options.assertCurrentOwnedIdle(idle);
    assertDeployment(this.options);
    const result = spawnSync(this.options.deployment.executable, [], { cwd: path.dirname(this.options.deployment.executable), windowsHide: true, env: nativeEnvironment(),
      input: JSON.stringify({ protocol: FAILED_INTENT_PROTOCOL, purpose: 'validate-failed-empty-intent-isolation-only', root: path.resolve(this.options.root), approvedIsolationSourceSha256s: this.options.deployment.approvedIsolationSourceSha256s }) + '\n', encoding: 'utf8', timeout: 5000, maxBuffer: 131072 });
    requireThat(!result.error && result.status === 0 && result.signal === null && !result.stderr && performance.now() - started <= 5000, 'AUDIT_NATIVE_VALIDATION');
    const lines = result.stdout.trim().split(/\r?\n/); requireThat(lines.length === 1, 'AUDIT_PROTOCOL'); const report = parseLine(lines[0]);
    requireThat(Object.keys(report).sort().join(',') === 'audits,protocol,status' && report.status === 'validated' && Array.isArray(report.audits) && report.audits.length <= 8, 'AUDIT_PROTOCOL');
    assertIsolationAuditBindings(report.audits, this.options.requirements(), proof, this.options.deployment.approvedIsolationSourceSha256s);
    assertDeployment(this.options); this.options.assertCurrentOwnedIdle(idle); requireThat(performance.now() - started <= 5000, 'AUDIT_NATIVE_VALIDATION_BUDGET'); return report.audits;
  }
  async isolate(runId: string): Promise<IsolationAudit | null> {
    requireThat(uuidPattern.test(runId) && !this.#busy, 'EXACT_IDLE_RUN_REQUIRED'); this.#busy = true;
    try {
      assertDeployment(this.options);
      const requirements = structuredClone(this.options.requirements());
      const requirementCanonical = canonical(requirements);
      const required = requirements.filter(item => item.runId === runId); requireThat(required.length === 1, 'EXACT_REQUIREMENT_REQUIRED'); assertRequired(required[0]);
      const proof = await this.options.readProof(runId); this.options.assertProof(proof); requireThat(proof.completion.owner.runId === runId, 'PROOF_OWNER');
      await this.options.assertOwner(proof.completion.owner);
      const proofCanonical = canonical(proof), idle = this.options.captureCurrentOwnedIdle();
      requireThat(idle.capture && digestPattern.test(idle.sha256), 'CURRENT_OWNED_IDLE_REQUIRED'); this.options.assertCurrentOwnedIdle(idle);
      const created = Date.now(), expiresAt = new Date(created + 300000).toISOString();
      const request = { protocol: FAILED_INTENT_PROTOCOL, purpose: FAILED_INTENT_PURPOSE, root: path.resolve(this.options.root), runId,
        proofSha256: sha(proofCanonical), targetSha256: proof.targetSha256, completeChainSha256: proof.completion.completeChainSha256,
        failureEvidenceSha256: required[0].failureEvidenceSha256, candidateSourceSha256: this.options.deployment.candidateSourceSha256,
        currentOwnedOperationsSha256: idle.sha256, primaryExecutableSha256: this.options.deployment.executableSha256, expiresAt };
      requireThat([request.proofSha256, request.targetSha256, request.completeChainSha256].every(value => digestPattern.test(value)), 'PROOF_DIGEST');
      const fresh = () => runFreshIsolationCheck(created, created + 300000, async () => {
        requireThat(Date.now() >= created && Date.now() < created + 300000 && canonical(this.options.requirements()) === requirementCanonical, 'EXPIRED_OR_REQUIREMENT_CHANGED');
        this.options.assertCurrentOwnedIdle(idle); const current = await this.options.readProof(runId); this.options.assertProof(current);
        requireThat(canonical(current) === proofCanonical, 'LOCAL_PROOF_CHANGED'); await this.options.assertOwner(current.completion.owner);
        this.options.assertProof(current); this.options.assertCurrentOwnedIdle(idle);
        requireThat(canonical(this.options.requirements()) === requirementCanonical, 'REQUIREMENT_CHANGED'); assertDeployment(this.options);
      });
      const capability = await this.#invoke(request, required[0].sourceName, fresh);
      if (!capability) return null;
      await fresh();
      const result = await this.#appendPrimaryClose(capability);
      await fresh();
      requireThat(this.validateIsolations(proof).some(audit => canonical(audit) === canonical(result)), 'POST_CLOSE_AUDIT_REQUIRED');
      return result;
    } finally { this.#busy = false; }
  }
  #invoke(request: JsonObject, expectedSourceName: string, fresh: () => Promise<void>): Promise<object | null> {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const spawnObservedAt = new Date().toISOString();
      const child = spawn(this.options.deployment.executable, [], { cwd: path.dirname(this.options.deployment.executable), windowsHide: false, env: nativeEnvironment(), stdio: 'pipe' });
      let terminal: JsonObject | undefined;
      let buffer = '', bytes = 0, stderr = '', failure: unknown, chain = Promise.resolve(), timedOut = false;
      let timer: ReturnType<typeof setTimeout>, phaseDeadline = 0;
      const stop = (error: unknown) => { failure ??= error; child.stdin.destroy(); child.kill(); };
      const budget = (milliseconds: number) => { clearTimeout(timer); phaseDeadline = performance.now() + milliseconds; timer = setTimeout(() => { timedOut = true; stop(new Error('FZ3B_FAILED_EMPTY_INTENT_NATIVE_TIMEOUT')); }, milliseconds); };
      const session = new IsolationProtocolSession({ ...request, expectedSourceName, primaryNativePid: child.pid }, fresh, line => {
        if (failure || timedOut || performance.now() >= phaseDeadline || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) fail('CHILD_NOT_LIVE');
        child.stdin.write(line); budget(5000);
      }, value => { terminal = value; });
      child.on('error', stop); child.stdin.on('error', stop);
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 4096) stop(new Error('FZ3B_FAILED_EMPTY_INTENT_STDERR_BUDGET')); });
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk); buffer += chunk;
        if (bytes > 262144 || buffer.length > 131072) { stop(new Error('FZ3B_FAILED_EMPTY_INTENT_OUTPUT_BUDGET')); return; }
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          chain = chain.then(async () => {
            if (failure) throw failure; const message = parseLine(line);
            // The native dialog has its original five-minute intent expiry; native work stays within five seconds.
            if (message.status === 'consent-captured') budget(5000);
            await session.receive(message);
            if (message.status === 'observed') budget(Math.max(1, Date.parse(request.expiresAt) - Date.now()));
          }).catch(stop);
        }
      });
      child.once('close', (code, signal) => {
        const closeObservedAt = new Date().toISOString();
        clearTimeout(timer);
        try { this.options.recordChildClose(child, code, signal); } catch (error) { failure ??= error; }
        void chain.then(() => {
          if (failure) throw failure; requireThat(performance.now() <= phaseDeadline && !buffer.trim() && !stderr, 'NATIVE_TRAILING_OUTPUT_OR_BUDGET'); assertDeployment(this.options);
          requireThat(performance.now() <= phaseDeadline, 'NATIVE_BUDGET');
          const audit = session.closed(code, signal); if (!audit) { resolve(null); return; }
          requireThat(terminal && Number.isInteger(child.pid) && child.pid! > 0 && Date.parse(closeObservedAt) >= Date.parse(spawnObservedAt), 'PRIMARY_CLOSE_IDENTITY');
          const capability = Object.freeze({});
          this.#closeCapabilities.set(capability, { child, audit, closeToken: terminal.closeToken, primary: {
            candidateSourceSha256: audit.candidateSourceSha256, closeObservedAt, executableSha256: this.options.deployment.executableSha256,
            exitCode: 0, mainPid: process.pid, nativeSealSha256: audit.nativeSealSha256, observationSha256: audit.observationSha256,
            primaryPid: child.pid, primaryTerminalSha256: hash(terminal), recoveryId: audit.recoveryId, runId: audit.runId,
            signal: null, sourceName: audit.sourceName, spawnObservedAt,
          } }); terminal = undefined; resolve(capability);
        }).catch(reject);
      });
      try { startOwnedIsolationChild(started, () => this.options.ownChild(child), () => { child.stdin.write(JSON.stringify(request) + '\n'); }, budget); }
      catch (error) { stop(error); }
    });
  }
  #appendPrimaryClose(capability: object): Promise<IsolationAudit> {
    const captured = this.#closeCapabilities.get(capability);
    requireThat(captured, 'PRIVATE_PRIMARY_CLOSE_CAPABILITY_REQUIRED');
    this.#closeCapabilities.delete(capability);
    requireThat(captured.child.exitCode === 0 && captured.child.signalCode === null && captured.child.pid === captured.primary.primaryPid && captured.primary.executableSha256 === this.options.deployment.executableSha256, 'PRIMARY_CLOSE_CAPABILITY_CHANGED');
    assertDeployment(this.options);
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const child = spawn(this.options.deployment.executable, [], { cwd: path.dirname(this.options.deployment.executable), windowsHide: true, env: nativeEnvironment(), stdio: 'pipe' });
      let stdout = '', stderr = '', failure: unknown;
      let timer: ReturnType<typeof setTimeout>;
      const stop = (error: unknown) => { failure ??= error; child.stdin.destroy(); child.kill(); };
      child.on('error', stop); child.stdin.on('error', stop);
      child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 131072) stop(new Error('FZ3B_FAILED_EMPTY_INTENT_OUTPUT_BUDGET')); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); if (stderr.length > 4096) stop(new Error('FZ3B_FAILED_EMPTY_INTENT_STDERR_BUDGET')); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        try {
          this.options.recordChildClose(child, code, signal);
          if (failure) throw failure;
          requireThat(code === 0 && signal === null && !stderr && performance.now() - started < 5000, 'PRIMARY_CLOSE_WRITER_UNCONFIRMED');
          const lines = stdout.trim().split(/\r?\n/); requireThat(lines.length === 1, 'PRIMARY_CLOSE_WRITER_PROTOCOL');
          const message = parseLine(lines[0]);
          requireThat(Object.keys(message).sort().join(',') === 'audit,protocol,status' && message.status === 'primary-close-recorded' && canonical(message.audit) === canonical(captured.audit), 'PRIMARY_CLOSE_WRITER_BINDING');
          assertDeployment(this.options); requireThat(performance.now() - started < 5000, 'PRIMARY_CLOSE_WRITER_BUDGET'); resolve(captured.audit);
        } catch (error) { reject(error); }
      });
      try {
        startOwnedIsolationChild(started, () => this.options.ownChild(child), () => {
          child.stdin.end(JSON.stringify({ protocol: FAILED_INTENT_PROTOCOL, purpose: 'append-main-observed-primary-close-only', root: path.resolve(this.options.root), recoveryId: captured.audit.recoveryId, closeToken: captured.closeToken, primary: captured.primary }) + '\n');
        }, remaining => { timer = setTimeout(() => stop(new Error('FZ3B_FAILED_EMPTY_INTENT_PRIMARY_CLOSE_WRITER_TIMEOUT')), remaining); });
      } catch (error) { stop(error); }
    });
  }
}
const originalValidate = FailedEmptyIntentRecovery.prototype.validateIsolations;
const originalIsolate = FailedEmptyIntentRecovery.prototype.isolate;
export function validateFailedEmptyIntentIsolation(component: FailedEmptyIntentRecovery, proof: FailedIntentProof): readonly IsolationAudit[] {
  const value = components.get(component); requireThat(value, 'REAL_COMPONENT_REQUIRED'); return value.validate(proof);
}
export function isolateFailedEmptyIntent(component: FailedEmptyIntentRecovery, runId: string): Promise<IsolationAudit | null> {
  const value = components.get(component); requireThat(value, 'REAL_COMPONENT_REQUIRED'); return value.isolate(runId);
}

let installedComponent: FailedEmptyIntentRecovery | undefined;
/** One main-only composition point. No IPC method accepts dependencies, pins or proof JSON. */
export function installFailedEmptyIntentRecovery(options: FailedIntentOptions): FailedEmptyIntentRecovery {
  requireThat(!installedComponent, 'ALREADY_COMPOSED'); assertDeployment(options);
  installedComponent = new FailedEmptyIntentRecovery(options); return installedComponent;
}
export function configuredFailedEmptyIntentRecovery(): FailedEmptyIntentRecovery | undefined { return installedComponent; }
