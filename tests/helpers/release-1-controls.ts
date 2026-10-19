import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import ts from 'typescript';
import type { AppSnapshot, Approval, Session } from '../../packages/shared/contracts';
import { ROOT, SHA, closed, readStable, sha, type Pin } from './release-1-files';
import { inside, samePath } from './embedded-installed';
import { assertMcpDenialApproval, diagnosticsFields, refusedMcpItem } from './second-user-controls';
import type { InstalledMainProcess } from './second-user-controls';

export const CONTROLS_OUTPUT = 'output/release-1.0/controls';
export const CONTROLS_BOOTSTRAP = 'tests/helpers/release-1-controls-bootstrap.mjs';
export const CONTROLS_ENTRIES = ['tests/release-1-controls-smoke.ts', 'tests/helpers/release-1-controls.ts', 'tests/helpers/release-1-controls.test.ts', CONTROLS_BOOTSTRAP];
export const CONTROL_PHASES = ['launch', 'ready', 'stop', 'mcp-request', 'reload', 'refuse', 'diagnostics', 'close-a', 'restart', 'restart-verify', 'close-b', 'missing-launch', 'missing-tools', 'missing-close'] as const;
const FAILURE_CHECKPOINTS = ['none', 'snapshot-contract', 'no-work', 'history-primary-identity', 'history-primary-immutable', 'history-primary-owner', 'history-primary-release', 'history-extra-inspect', 'history-hardware'] as const;
export type ControlsCheckpoint = typeof FAILURE_CHECKPOINTS[number];
export function sanitizeControlsFailure(error: unknown, checkpoint: unknown) {
  let reason: 'ASSERTION' | 'TIMEOUT' | 'OTHER' = 'OTHER';
  try { if (error instanceof Error) { if ((error as NodeJS.ErrnoException).code === 'ERR_ASSERTION') reason = 'ASSERTION'; else if (error.name === 'TimeoutError') reason = 'TIMEOUT'; } } catch { reason = 'OTHER'; }
  return { reason, checkpoint: FAILURE_CHECKPOINTS.includes(checkpoint as ControlsCheckpoint) ? checkpoint as ControlsCheckpoint : 'none' };
}
export type ControlPhase = typeof CONTROL_PHASES[number] | 'connect';
export interface ControlsHarness {
  schemaVersion: 1; scope: 'release-1-controls-harness-v2'; version: '1.0.0'; candidateSha256: string;
  sources: Pin[]; node: Pin; runtimePackages: string[]; runtimePins: Pin[];
}
export interface WaitProcess {
  id: number; parentId: number; name: string; created: string; sid: string; sessionId: number;
  ownerQueryStatus: number; root: boolean; commandLine: string | null; execPath: string;
}
export interface WaitOwnershipProof { main: InstalledMainProcess; ancestry: WaitProcess[]; installed: string; sampledAt: string }

export async function controlsClosure(): Promise<Pin[]> {
  const todo = [...CONTROLS_ENTRIES], found = new Map<string, Pin>(); let total = 0;
  while (todo.length) {
    const relative = todo.pop()!; if (found.has(relative)) continue;
    assert.ok(found.size < 256 && !path.isAbsolute(relative) && !relative.split('/').some(p => p === '..' || p === '.runtime'));
    const file = path.join(ROOT, relative), raw = await readStable(file, Math.min(2 * 1024 * 1024, 24 * 1024 * 1024 - total)); total += raw.length;
    found.set(relative, { path: relative, bytes: raw.length, sha256: sha(raw) });
    for (const item of ts.preProcessFile(raw.toString('utf8'), true).importedFiles) {
      if (!item.fileName.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), item.fileName); let target: string | undefined;
      for (const candidate of [base, base + '.ts', base + '.tsx', base + '.mjs', base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
        try { if ((await lstat(candidate)).isFile()) { target = candidate; break; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      assert.ok(target && inside(ROOT, target)); todo.push(path.relative(ROOT, target).split(path.sep).join('/'));
    }
  }
  return [...found.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function assertControlsHarness(v: any): asserts v is ControlsHarness {
  closed(v, ['schemaVersion', 'scope', 'version', 'candidateSha256', 'sources', 'node', 'runtimePackages', 'runtimePins']);
  assert.equal(v.schemaVersion, 1); assert.equal(v.scope, 'release-1-controls-harness-v2'); assert.equal(v.version, '1.0.0'); assert.match(v.candidateSha256, SHA);
  assert.ok(Array.isArray(v.sources) && v.sources.length >= CONTROLS_ENTRIES.length && v.sources.length <= 256);
  assert.deepEqual(v.sources.map((p: Pin) => p.path), [...new Set(v.sources.map((p: Pin) => p.path))].sort());
  for (const p of [...v.sources, v.node]) { closed(p, ['path', 'bytes', 'sha256']); assert.ok(Number.isSafeInteger(p.bytes) && p.bytes > 0); assert.match(p.sha256, SHA); }
  assert.equal(v.node.path, 'C:/Program Files/nodejs/node.exe');
  assert.ok(Array.isArray(v.runtimePackages) && v.runtimePackages.length >= 4 && v.runtimePackages.length <= 128);
  assert.deepEqual(v.runtimePackages, [...new Set(v.runtimePackages)].sort());
  assert.ok(Array.isArray(v.runtimePins) && v.runtimePins.length > 0 && v.runtimePins.length <= 10000);
  assert.deepEqual(v.runtimePins.map((p: Pin) => p.path), [...new Set(v.runtimePins.map((p: Pin) => p.path))].sort());
  for (const p of v.runtimePins) { closed(p, ['path', 'bytes', 'sha256']); assert.ok(Number.isSafeInteger(p.bytes) && p.bytes >= 0); assert.match(p.sha256, SHA); }
}
export async function controlsRuntimeClosure(): Promise<{ runtimePackages: string[]; runtimePins: Pin[] }> {
  const raw = await readStable(path.join(ROOT, CONTROLS_BOOTSTRAP)); const module = await import('data:text/javascript;base64,' + raw.toString('base64')); return module.runtimeClosure(ROOT);
}
export async function verifyControlsHarness(file: string, pin: string, candidate: string): Promise<ControlsHarness> {
  assert.ok(path.isAbsolute(file) && inside(path.join(ROOT, CONTROLS_OUTPUT, 'manifests'), file)); assert.match(pin, SHA);
  const raw = await readStable(file); assert.equal(sha(raw), pin); const value = JSON.parse(raw.toString()); assertControlsHarness(value); assert.equal(value.candidateSha256, candidate);
  assert.deepEqual(await controlsClosure(), value.sources);
  const bootstrap = await readStable(path.join(ROOT, CONTROLS_BOOTSTRAP)); assert.equal(sha(bootstrap), value.sources.find(p => p.path === CONTROLS_BOOTSTRAP)?.sha256);
  const module = await import('data:text/javascript;base64,' + bootstrap.toString('base64')); await module.verifyRuntime(ROOT, value);
  const node = await readStable(value.node.path, 256 * 1024 * 1024); assert.equal(node.length, value.node.bytes); assert.equal(sha(node), value.node.sha256);
  return value;
}
export class ControlsGate {
  #index = 0; #held = false; #busy = false; #connected = false; #armed?: ControlPhase;
  constructor(private previous: string) { assert.match(previous, SHA); }
  get predecessor() { return this.previous; } get next() { return CONTROL_PHASES[this.#index]; }
  get held() { return this.#held; } get done() { return this.#index === CONTROL_PHASES.length; }
  arm(line: string): ControlPhase {
    try { assert.ok(!this.#held && !this.#busy && !this.done); const phase: ControlPhase = this.next === 'ready' && !this.#connected && line === `connect ${this.previous}` ? 'connect' : this.next;
      assert.equal(line, `${phase} ${this.previous}`); this.#busy = true; return this.#armed = phase; }
    catch { this.fail(); throw new Error('CONTROLS_PHASE_HELD'); }
  }
  complete(phase: ControlPhase, pin: string) {
    assert.ok(this.#busy && !this.#held); assert.equal(phase, this.#armed); assert.match(pin, SHA);
    if (phase === 'connect') { assert.equal(this.next, 'ready'); assert.equal(this.#connected, false); this.#connected = true; } else this.#index++;
    this.previous = pin; this.#busy = false; this.#armed = undefined;
  }
  fail() { this.#held = true; }
}
export function assertFreshRefusal(state: AppSnapshot, sessionId: string, requestKey: string, prior?: Approval) {
  assert.equal(state.approvals.length, 1, 'Only the unique current refusal approval may be acted on');
  const session = state.sessions.find(s => s.id === sessionId); assert.ok(session);
  const approval = state.approvals[0]; assertMcpDenialApproval(approval, session, requestKey);
  assert.ok(Number.isSafeInteger(approval.generation) && approval.generation > 0);
  if (prior) { assert.equal(approval.id, prior.id); assert.equal(approval.generation, prior.generation); assert.deepEqual(approval.params, prior.params); }
  const task = state.tasks.find(t => t.id === session.taskId); assert.ok(task); assert.equal(task.operations.length, 0);
  return { approval, session };
}
export function assertRefusalComplete(state: AppSnapshot, sessionId: string, requestKey: string) {
  assert.equal(state.approvals.length, 0); const session = state.sessions.find(s => s.id === sessionId); assert.ok(session);
  assert.equal(session.status, 'completed'); assert.ok(!session.turnId); const item = refusedMcpItem(session, requestKey);
  assert.equal(state.tasks.find(t => t.id === session.taskId)!.operations.length, 0); return item;
}
export function assertReleaseDiagnostics(value: any, marker: string, synthetic: string) {
  assert.deepEqual(Object.keys(value).sort(), [...diagnosticsFields].sort());
  assert.equal(value.schemaVersion, 1); assert.equal(value.version, '1.0.0'); assert.equal(value.platform, 'win32'); assert.equal(value.engineState, 'ready');
  assert.equal(typeof value.engineError, 'string'); assert.equal(typeof value.arch, 'string');
  assert.ok(Array.isArray(value.diagnostics) && value.diagnostics.every((line: unknown) => typeof line === 'string'));
  assert.equal(JSON.stringify(value).includes(synthetic), false);
  assert.ok(value.diagnostics.some((line: string) => line.includes(marker) && /\[redacted\]/i.test(line)));
}
export function assertOwnedWaitProcess(processes: WaitProcess[], marker: string, sid: string, desktopSession: number, proof: WaitOwnershipProof) {
  assert.ok(proof && Array.isArray(proof.ancestry) && proof.ancestry.length >= 3 && proof.ancestry.length <= 32, 'Native QA ancestry to the verified installed main is required');
  assert.equal(processes.filter(p => p.root).length, 1, 'Exactly one matching native QA shell root is required');
  for (const p of processes) {
    assert.ok(Number.isInteger(p.id) && p.id > 0 && Number.isInteger(p.parentId) && p.parentId > 0 && Number.isFinite(Date.parse(p.created)));
    assert.equal(p.sid, sid); assert.equal(p.sessionId, desktopSession); assert.equal(p.ownerQueryStatus, 0);
  }
  const root = processes.find(p => p.root)!;
  assert.ok(root.commandLine?.includes(marker)); assert.match(root.name, /^(?:powershell|pwsh)\.exe$/i);
  assert.ok(['C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'C:/Program Files/PowerShell/7/pwsh.exe'].some(file => samePath(root.execPath, file)), 'QA shell must use a known system PowerShell executable');
  const main = proof.main; assert.ok(main && samePath(main.execPath, proof.installed)); assert.equal(main.sid, sid); assert.equal(main.sessionId, desktopSession); assert.equal(main.ownerQueryStatus, 0);
  const chain = [root, ...proof.ancestry], ids = new Set<number>();
  const allowed = new Set(['resources/codex/codex.exe', 'resources/codex/codex-command-runner.exe', 'resources/codex/codex-code-mode-host.exe', 'resources/process-host/process-host.exe'].map(file => path.resolve(path.dirname(proof.installed), file).toLowerCase()));
  for (let i = 0; i < chain.length; i++) {
    const current = chain[i]; assert.ok(Number.isInteger(current.id) && current.id > 0 && !ids.has(current.id)); ids.add(current.id);
    assert.equal(current.sid, sid); assert.equal(current.sessionId, desktopSession); assert.equal(current.ownerQueryStatus, 0); assert.ok(Number.isFinite(Date.parse(current.created)));
    assert.equal(current.name.toLowerCase(), path.basename(current.execPath).toLowerCase());
    if (i > 0) { const child = chain[i - 1]; assert.equal(child.parentId, current.id, 'A missing or unrelated native parent cannot establish QA ownership'); assert.ok(Date.parse(current.created) <= Date.parse(child.created), 'Parent creation after child indicates PID reuse'); }
    if (i > 0 && i < chain.length - 1) assert.ok(allowed.has(path.resolve(current.execPath).toLowerCase()), 'Unreviewed executable in the QA process ancestry');
  }
  const observedMain = chain.at(-1)!; assert.equal(observedMain.id, main.id); assert.equal(Date.parse(observedMain.created), Date.parse(main.created)); assert.ok(samePath(observedMain.execPath, main.execPath));
  const host = proof.ancestry.find(p => samePath(p.execPath, path.join(path.dirname(proof.installed), 'resources/process-host/process-host.exe')));
  const engine = proof.ancestry.find(p => samePath(p.execPath, path.join(path.dirname(proof.installed), 'resources/codex/codex.exe')));
  assert.ok(host && engine, 'Both installed engine and process host must be in the same native ancestry sample'); assert.equal(host.parentId, main.id); assert.equal(engine.parentId, host.id);
  assert.ok(Number.isFinite(Date.parse(proof.sampledAt)) && Date.parse(proof.sampledAt) >= Date.parse(root.created)); return root;
}
export function assertRestartSessions(state: AppSnapshot, expected: Session[]) {
  assert.equal(state.approvals.length, 0);
  for (const old of expected) {
    const current = state.sessions.find(s => s.id === old.id); assert.ok(current);
    assert.equal(current.taskId, old.taskId); assert.equal(current.threadId, old.threadId); assert.equal(current.status, old.status); assert.ok(!current.turnId);
    assert.deepEqual(current.messages, old.messages); assert.equal(state.tasks.find(t => t.id === old.taskId)!.operations.length, 0);
  }
}
export function assertControlsSnapshot(state: AppSnapshot, dataDir: string, installed: string) {
  assert.equal(state.version, '1.0.0'); assert.ok(samePath(state.dataDir, dataDir)); assert.equal(state.hardware.enabled, false); assert.equal(state.hardware.modeActive, false);
  assert.ok(samePath(state.engine.home, path.join(dataDir, 'engine')));
  if (state.engine.executable) assert.ok(samePath(state.engine.executable, path.join(path.dirname(installed), 'resources/codex/codex.exe')));
}
