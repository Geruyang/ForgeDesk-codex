import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import ts from 'typescript';
import { inside, samePath } from './embedded-installed';
import { assertFz3bOriginalUnknownPreserved, fz3bPreflightUnknownSummary } from './fz3b-preflight-observation';
import { assertOriginalSnapshotDefect } from './snapshot-failure-diagnostics';
import { primarySid } from './snapshot-smoke-scope';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import type { EngineeringTask } from '../../packages/engineering-runner';
import { ROOT, SHA, sha, closed, readStable, writeNew, type Pin } from './release-1-files';
import { verifyRelease, VALIDATOR_PATH, type Release } from './release-1-binding';
import { SOURCE_FILES, assertRuntimeShape, verifyRuntime, type RuntimeInventory } from './release-1-software-bootstrap.mjs';
import { assertReviewedHistoricalInspect, verifyReviewedInspectEvidence } from './release-1-historical-inspect';
export { ROOT, SHA, sha, closed, readStable, writeNew, verifyRelease };
export type { Pin, Release };

export const OUTPUT = 'output/release-1.0/software-acceptance';
export const NODE = 'C:/Program Files/nodejs/node.exe', GIT = 'C:/Program Files/Git/mingw64/libexec/git-core/git.exe', MODEL = 'gpt-6.1-sol';
export const INCIDENT = { runId: '07427a29-0eae-44c7-ac35-34d6650eebee', taskId: '9309dc73-fb48-4d29-9226-c5496ca2640d', operationId: 'c6a3e027-abd8-40f7-b64e-d1b8e1a4620b' } as const;
const HOST_PHASES = ['held-preflight', 'quarantine', 'finish', 'close-a', 'restart-no-rehold', 'close-b'] as const;
export interface Manifest extends RuntimeInventory { schemaVersion: 1; scope: 'release-1-independent-harness-v2'; version: '1.0.0'; candidateSha256: string; sources: Pin[]; node: Pin; git: Pin }
export interface HostAdmission { descriptorPath: string; descriptorSha256: string; history: any; lastNativeCreation: string }
export interface Plan { schemaVersion: 1; scope: 'release-1-root-phased-snapshot-v1'; version: '1.0.0'; acceptanceId: string; preparedAt: string; candidateSha256: string; manifestPath: string; manifestSha256: string; release: Release; host: HostAdmission }
export const FILES = ['tests/release-1-software-smoke.ts', 'tests/helpers/release-1-files.ts', 'tests/helpers/release-1-binding.ts', 'tests/helpers/release-1-policy.ts', 'tests/helpers/release-1-observer.ts', 'tests/helpers/release-1-snapshot-checks.ts', 'tests/helpers/release-1-workflow.ts', 'tests/helpers/release-1-software.test.ts', 'tests/helpers/release-1-software-bootstrap.mjs', 'tests/helpers/release-1-software-bootstrap.d.mts', 'tests/helpers/release-1-software-bootstrap.test.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', VALIDATOR_PATH];
export function launchEnvironment(source: NodeJS.ProcessEnv, dataDir: string): Record<string, string> {
  const names = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMW6432', 'PROGRAMFILES(X86)', 'USERNAME', 'USERDOMAIN', 'SESSIONNAME', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP']);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === 'string' && names.has(key.toUpperCase())) env[key] = value;
  return { ...env, FORGEDESK_DATA_DIR: dataDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' };
}
export function assertPersistedQuiet(value: any) {
  assert.equal(value?.schemaVersion, 1); assert.ok(Array.isArray(value.sessions));
  for (const session of value.sessions) {
    assert.ok(session && typeof session.status === 'string'); assert.ok(session.engineUncertain === undefined || session.engineUncertain === false); assert.ok(!session.turnId); assert.ok(!['running', 'stopping', 'unknown', 'active', 'inProgress'].includes(session.status));
  }
}
export async function readPersistedQuiet() {
  const value = JSON.parse((await readStable(path.join(ROOT, '.runtime/app/desktop.json'), 16 * 1024 * 1024)).toString());
  assertPersistedQuiet(value); return { sessions: value.sessions.length, noUncertainOrActiveTurns: true };
}
export async function harnessClosure(): Promise<Pin[]> {
  const todo = [...FILES], found = new Map<string, Pin>(); let total = 0;
  while (todo.length) {
    const file = todo.pop()!; if (found.has(file)) continue;
    assert.ok(found.size < 256 && !path.isAbsolute(file) && !file.split('/').some(v => v === '..' || v === '.runtime'));
    const bytes = await readStable(path.join(ROOT, file)); total += bytes.length; assert.ok(total <= 24 * 1024 * 1024);
    found.set(file, { path: file, bytes: bytes.length, sha256: sha(bytes) });
    for (const item of ts.preProcessFile(bytes.toString('utf8'), true).importedFiles) {
      if (!item.fileName.startsWith('.')) continue; const stem = path.resolve(ROOT, path.dirname(file), item.fileName); let resolved: string | undefined;
      for (const name of [stem, stem + '.ts', stem + '.tsx', stem + '.mjs', stem.replace(/\.js$/, '.ts'), path.join(stem, 'index.ts'), path.join(stem, 'index.tsx')]) {
        try { if ((await lstat(name)).isFile()) { resolved = name; break; } } catch {}
      }
      assert.ok(resolved && inside(ROOT, resolved)); todo.push(path.relative(ROOT, resolved).split(path.sep).join('/'));
    }
  }
  const rows = [...found.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(rows.map(p => p.path), [...SOURCE_FILES]); return rows;
}
export function assertManifest(v: any): asserts v is Manifest {
  closed(v, ['schemaVersion', 'scope', 'version', 'candidateSha256', 'sources', 'node', 'git', 'runtimePackages', 'runtimePins']); assert.equal(v.schemaVersion, 1); assert.equal(v.scope, 'release-1-independent-harness-v2'); assert.equal(v.version, '1.0.0'); assert.match(v.candidateSha256, SHA);
  assert.ok(Array.isArray(v.sources) && v.sources.length >= FILES.length && v.sources.length <= 256);
  assert.deepEqual(v.sources.map((p: Pin) => p.path), [...new Set(v.sources.map((p: Pin) => p.path))].sort());
  for (const p of [...v.sources, v.node, v.git]) { closed(p, ['path', 'bytes', 'sha256']); assert.ok(Number.isSafeInteger(p.bytes) && p.bytes > 0); assert.match(p.sha256, SHA); }
  assert.equal(v.node.path, NODE); assert.equal(v.git.path, GIT); assertRuntimeShape(v);
}
export async function verifyManifest(file: string, pin: string, candidate: string) {
  assert.ok(path.isAbsolute(file) && inside(path.join(ROOT, OUTPUT, 'manifests'), file)); assert.match(pin, SHA);
  const bytes = await readStable(file); assert.equal(sha(bytes), pin); const value = JSON.parse(bytes.toString()); assertManifest(value); assert.equal(value.candidateSha256, candidate);
  assert.deepEqual(await harnessClosure(), value.sources);
  await verifyRuntime(ROOT, value);
  for (const p of [value.node, value.git]) { const bytes = await readStable(p.path, 256 * 1024 * 1024); assert.equal(bytes.length, p.bytes); assert.equal(sha(bytes), p.sha256); } return value;
}
export function assertPlan(v: any): asserts v is Plan {
  closed(v, ['schemaVersion', 'scope', 'version', 'acceptanceId', 'preparedAt', 'candidateSha256', 'manifestPath', 'manifestSha256', 'release', 'host']);
  assert.equal(v.schemaVersion, 1); assert.equal(v.scope, 'release-1-root-phased-snapshot-v1'); assert.equal(v.version, '1.0.0'); assert.match(v.acceptanceId, /^release-1-\d{13}-[a-f0-9]{6}$/);
  assert.ok(Number.isFinite(Date.parse(v.preparedAt))); assert.match(v.candidateSha256, SHA); assert.match(v.manifestSha256, SHA); assert.equal(v.release.candidateSha256, v.candidateSha256); assert.equal(v.release.version, v.version);
  closed(v.host, ['descriptorPath', 'descriptorSha256', 'history', 'lastNativeCreation']); assert.match(v.host.descriptorSha256, SHA); assertHistory(v.host.history); assert.ok(Number.isFinite(Date.parse(v.host.lastNativeCreation)));
}
export async function verifyPlan(v: Plan) {
  assertPlan(v); await verifyManifest(v.manifestPath, v.manifestSha256, v.candidateSha256);
  assert.deepEqual(await verifyRelease(v.candidateSha256, v.release.installedInventoryPath, v.release.installedInventorySha256), v.release);
  assert.deepEqual(await readHostAdmission(v.host.descriptorPath, v.host.descriptorSha256), v.host);
}
export async function readHostAdmission(descriptorPath: string, descriptorSha256: string): Promise<HostAdmission> {
  assert.match(descriptorSha256, SHA); assert.ok(path.isAbsolute(descriptorPath) && inside(path.join(ROOT, OUTPUT), descriptorPath));
  const raw = await readStable(descriptorPath); assert.equal(sha(raw), descriptorSha256); const v = JSON.parse(raw.toString());
  closed(v, ['schemaVersion', 'scope', 'hostPlan', 'records']); assert.equal(v.schemaVersion, 1); assert.equal(v.scope, 'release-1-prior-host-admission-v1');
  closed(v.hostPlan, ['path', 'bytes', 'sha256']); assert.match(v.hostPlan.sha256, SHA); assert.ok(inside(path.join(ROOT, 'output/revision-0.5.7/host-finalization-acceptance/runs'), path.join(ROOT, v.hostPlan.path)));
  const planRaw = await readStable(path.join(ROOT, v.hostPlan.path)); assert.equal(planRaw.length, v.hostPlan.bytes); assert.equal(sha(planRaw), v.hostPlan.sha256); const old = JSON.parse(planRaw.toString());
  assert.equal(old.version, '0.5.7'); assert.equal(old.scope, 'fz3b-057-root-phased-host-finalization-v1'); assert.match(old.candidateSha256, SHA);
  try { await lstat(path.join(ROOT, path.dirname(v.hostPlan.path), 'held.json')); throw Error('RELEASE_1_PRIOR_HOST_HELD'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  assert.ok(Array.isArray(v.records) && v.records.length === HOST_PHASES.length); const records: any[] = []; let prior = v.hostPlan.sha256;
  for (let i = 0; i < HOST_PHASES.length; i++) {
    const p = v.records[i]; closed(p, ['path', 'bytes', 'sha256']); assert.match(p.sha256, SHA);
    assert.ok(samePath(path.join(ROOT, p.path), path.join(ROOT, path.dirname(v.hostPlan.path), HOST_PHASES[i] + '.json')));
    const bytes = await readStable(path.join(ROOT, p.path)); assert.equal(bytes.length, p.bytes); assert.equal(sha(bytes), p.sha256); const record = JSON.parse(bytes.toString());
    closed(record, ['schemaVersion', 'scope', 'acceptanceId', 'candidateSha256', 'planSha256', 'phase', 'predecessorSha256', 'result', 'facts', 'noAutomaticNextPhase', 'finishedAt']);
    assert.equal(record.schemaVersion, 1); assert.equal(record.scope, old.scope); assert.equal(record.acceptanceId, old.acceptanceId); assert.equal(record.candidateSha256, old.candidateSha256);
    assert.equal(record.planSha256, v.hostPlan.sha256); assert.equal(record.phase, HOST_PHASES[i]); assert.equal(record.predecessorSha256, prior); assert.equal(record.result, 'passed'); assert.equal(record.noAutomaticNextPhase, true); assert.ok(Number.isFinite(Date.parse(record.finishedAt)));
    prior = sha(bytes); records.push(record);
  }
  const result = assertHostRecords(records); await verifyReviewedInspectEvidence(); return { descriptorPath, descriptorSha256, ...result };
}

export function assertHistory(v: any) {
  closed(v, ['owner', 'runSummary', 'fingerprint']); const owner = v.owner, summary = v.runSummary;
  closed(owner, ['runId', 'taskId', 'sessionId', 'threadId', 'turnId', 'generation', 'model']); assert.equal(owner.runId, INCIDENT.runId); assert.equal(owner.taskId, INCIDENT.taskId); assert.equal(owner.sessionId, INCIDENT.taskId); assert.equal(owner.model, MODEL);
  assert.ok(typeof owner.threadId === 'string' && owner.threadId.length > 0); assert.ok(owner.turnId === null || (typeof owner.turnId === 'string' && owner.turnId.length > 0)); assert.ok(Number.isSafeInteger(owner.generation) && owner.generation > 0);
  closed(summary, ['status', 'phase', 'profileId', 'profileSha256', 'createdAt', 'updatedAt', 'currentTool', 'stopRequested', 'active', 'hardwareBusy', 'nativeApproval', 'fullPublicRunSha256']);
  assert.equal(summary.status, 'needs_attention'); assert.equal(summary.phase, 'needs_attention'); assert.equal(summary.active, false); assert.equal(summary.hardwareBusy, false); assert.equal(summary.stopRequested, true); assert.equal(summary.nativeApproval, 'not_requested'); assert.match(summary.profileSha256, SHA); assert.match(summary.fullPublicRunSha256, SHA);
  assert.ok(Number.isFinite(Date.parse(summary.createdAt)) && Number.isFinite(Date.parse(summary.updatedAt))); assert.equal(typeof summary.profileId, 'string'); assert.ok(summary.currentTool === null || summary.currentTool === 'fz3b_inspect');
  assert.equal(v.fingerprint.runId, INCIDENT.runId); assert.equal(v.fingerprint.taskId, INCIDENT.taskId); assert.equal(v.fingerprint.sessionId, INCIDENT.taskId); assert.equal(v.fingerprint.unknown.status, summary.status); assert.equal(v.fingerprint.unknown.phase, summary.phase);
}

export function assertHostProjection(v: any, history?: any, released = true) {
  closed(v, ['schemaVersion', 'scope', 'sampledAt', 'version', 'held', 'run', 'engines', 'owner', 'quiet', 'history']);
  assert.equal(v.schemaVersion, 1); assert.equal(v.scope, 'fz3b-057-public-local-quiet-observation-v1'); assert.equal(v.version, '0.5.7'); assert.equal(v.held, !released); assert.ok(Number.isFinite(Date.parse(v.sampledAt)));
  assertHistory(v.history); if (history) assert.deepEqual(v.history, history);
  closed(v.run, ['runId', 'taskId', 'sessionId', 'status', 'phase', 'active', 'hardwareBusy', 'nativeApproval']);
  assert.deepEqual(v.run, { runId: INCIDENT.runId, taskId: INCIDENT.taskId, sessionId: INCIDENT.taskId, status: v.history.runSummary.status, phase: v.history.runSummary.phase, active: false, hardwareBusy: false, nativeApproval: 'not_requested' });
  closed(v.owner, ['fz3bActiveRunId', 'hardwareActiveRunId', 'recoveryActionsPresent', 'finishPreflightRefusal', 'quarantineEmptyHome']);
  closed(v.quiet, ['approvalCount', 'sessionCount', 'allSessionsQuiet', 'softwareOperationCount', 'allSoftwareOperationsQuiet', 'allAgentRunsQuiet']);
  for (const key of ['sessionCount', 'softwareOperationCount']) assert.ok(Number.isSafeInteger(v.quiet[key]) && v.quiet[key] >= 0);
  assert.deepEqual(v.engines, { ordinary: 'stopped', fz3b: 'stopped', hardware: 'stopped' });
  assert.equal(v.owner.fz3bActiveRunId, released ? null : INCIDENT.runId); assert.equal(v.owner.hardwareActiveRunId, null); assert.equal(v.owner.recoveryActionsPresent, !released);
  assert.equal(v.owner.finishPreflightRefusal, !released);
  if (released) assert.equal(v.owner.quarantineEmptyHome, false);
  assert.equal(v.quiet.approvalCount, 0); assert.equal(v.quiet.allSessionsQuiet, true); assert.equal(v.quiet.allSoftwareOperationsQuiet, true); assert.equal(v.quiet.allAgentRunsQuiet, true);
}

export function assertClose(v: any) { assert.equal(v.normalClose, true); assert.equal(v.forcedKill, false); assert.equal(v.launcherExitCode, 0); assert.equal(v.launcherSignal, null); assert.equal(v.nativeElectronIdentityAbsent, true); assert.equal(v.nativeInstalledProcessesAbsent, true); }

export function assertHostRecords(records: any[]) {
  assert.equal(records.length, HOST_PHASES.length); assert.deepEqual(records.map(v => v.phase), [...HOST_PHASES]);
  const [held, quarantine, finish, closeA, restart, closeB] = records;
  for (const record of [held, restart]) {
    const identity = record.facts.launch; assert.equal(identity.desktopIdentity.sid, primarySid); assert.equal(identity.desktopIdentity.elevated, false); assert.equal(identity.desktopIdentity.interactive, true); assert.equal(identity.nativeMain.sid, primarySid); assert.equal(identity.nativeMain.sessionId, identity.desktopIdentity.sessionId); assert.ok(Number.isSafeInteger(identity.nativeMain.id) && identity.nativeMain.id > 0); assert.ok(samePath(identity.nativeMain.execPath, path.join(ROOT, 'install/ForgeDesk.exe'))); assertHostIpc(record.facts.ipc, 'readonly', 0);
  }
  assert.equal(held.facts.launch.desktopIdentity.sessionId, restart.facts.launch.desktopIdentity.sessionId);
  assert.equal(held.facts.samples.length, 2); const history = held.facts.samples[0].history; assertHistory(history);
  for (const v of held.facts.samples) assertHostProjection(v, history, false);
  for (const [record, purpose] of [[quarantine, 'quarantine'], [finish, 'finish']] as const) {
    assert.equal(record.facts.samples.length, 2);
    for (const s of record.facts.samples) {
      assertHostIpc(s.ipc, purpose, 1); assert.equal(s.dom.currentIntent, ''); assert.equal(s.dom.ariaBusy, 'false'); assert.equal(s.dom.actionErrorCount, 0); assert.deepEqual(s.dom.sequence, ['', purpose === 'quarantine' ? 'quarantine-empty-home' : 'reconcile-preflight-inspect', '']); assertHostProjection(s.snapshot, history, purpose === 'finish');
    }
  }
  for (const record of [closeA, closeB]) { assertClose(record.facts.close); assertHostProjection(record.facts.beforeClose, history); assert.equal(record.facts.noMaintenanceSubstitution, true); }
  assert.equal(closeA.facts.close.nativeMainBefore.id, held.facts.launch.nativeMain.id); assert.equal(closeA.facts.close.nativeMainBefore.created, held.facts.launch.nativeMain.created); assert.equal(closeB.facts.close.nativeMainBefore.id, restart.facts.launch.nativeMain.id); assert.equal(closeB.facts.close.nativeMainBefore.created, restart.facts.launch.nativeMain.created);
  assert.equal(restart.facts.samples.length, 2); for (const sample of restart.facts.samples) assertHostProjection(sample, history);
  assert.notEqual(restart.facts.launch.nativeMain.created, held.facts.launch.nativeMain.created); assert.equal(restart.facts.ipc.calls.length, 0); assert.equal(restart.facts.ipc.forbiddenCount, 0);
  assert.ok(Number.isFinite(Date.parse(held.facts.launch.nativeMain.created))); assert.ok(Number.isFinite(Date.parse(restart.facts.launch.nativeMain.created)));
  return { history, lastNativeCreation: restart.facts.launch.nativeMain.created };
}

export function fullHistory(run: Fz3bRunView) {
  return { owner: { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, threadId: run.threadId, turnId: run.turnId ?? null, generation: run.generation, model: run.model },
    runSummary: { status: run.status, phase: run.phase, profileId: run.profileId, profileSha256: run.profileSha256, createdAt: run.createdAt, updatedAt: run.updatedAt, currentTool: run.currentTool ?? null, stopRequested: run.stopRequested, active: run.active, hardwareBusy: run.hardwareBusy, nativeApproval: run.nativeApproval, fullPublicRunSha256: sha(JSON.stringify(run)) },
    fingerprint: { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, unknown: fz3bPreflightUnknownSummary(run), hashes: Object.fromEntries(['calls', 'operations', 'artifact', 'identity', 'grant', 'semantic', 'preflightRefusalRecoveries', 'maintenanceExit'].map(key => [key, sha(JSON.stringify({ value: (run as any)[key] }))])) } };
}

export function assertApproval(state: AppSnapshot, task: EngineeringTask) {
  assert.equal(state.approvals.length, 1); const approval = state.approvals[0], p = approval.params as any, args = p?._meta?.tool_params, session = state.sessions.find(s => s.taskId === task.id);
  assert.ok(Number.isSafeInteger(approval.generation) && approval.generation > 0); assert.ok(typeof approval.id === 'string' || (Number.isSafeInteger(approval.id) && approval.id >= 0));
  assert.ok(session && session.threadId && session.turnId); assert.equal(approval.method, 'mcpServer/elicitation/request'); assert.equal(p.serverName, 'engineering'); assert.equal(p.mode, 'form'); assert.deepEqual(p.requestedSchema, { type: 'object', properties: {} }); assert.equal(p._meta.codex_approval_kind, 'mcp_tool_call'); assert.equal(p.message, 'Allow the engineering MCP server to run tool "engineering.build"?'); assert.equal(p.threadId, session.threadId); assert.equal(p.turnId, session.turnId);
  closed(args, ['taskId', 'profileRevision', 'requestKey']); assert.equal(args.taskId, task.id); assert.equal(args.profileRevision, task.snapshotProfile?.revision); assert.ok(typeof args.requestKey === 'string' && args.requestKey.length > 0 && args.requestKey.length <= 200); assert.ok(approval.decisions.includes('accept'));
  return { generation: approval.generation, id: approval.id, decision: 'accept', taskId: task.id, profileRevision: args.profileRevision, requestKey: args.requestKey };
}

export function assertModelBuilds(task: EngineeringTask, approvals: any[], messages: any[]) {
  assert.equal(task.operations.length, 2); assertOriginalSnapshotDefect(task.operations[0]); assert.equal(task.status, 'passed'); assert.equal(task.operations[1].status, 'succeeded'); assert.notEqual(task.operations[0].requestKey, task.operations[1].requestKey); assert.equal(approvals.length, 2);
  const items = messages.filter(m => m.role === 'tool').flatMap(m => { try { return [JSON.parse(m.text)]; } catch { return []; } }).filter(m => m.type === 'mcpToolCall' && m.server === 'engineering' && m.tool === 'engineering.build'); assert.equal(items.length, 2);
  for (const op of task.operations) { assert.equal(approvals.filter(a => a.requestKey === op.requestKey).length, 1); const entry = items.filter(m => m.arguments?.requestKey === op.requestKey); assert.equal(entry.length, 1); assert.equal(entry[0].arguments.taskId, task.id); assert.equal(entry[0].arguments.profileRevision, task.snapshotProfile?.revision); }
}
function assertHostIpc(v: any, purpose: 'readonly' | 'quarantine' | 'finish', count: 0 | 1) {
  assert.equal(v.purpose, purpose); assert.equal(v.electronVersion, '44.7.2'); assert.equal(v.runId, INCIDENT.runId); assert.equal(v.forbiddenCount, 0); assert.equal(v.unexpectedNativePrompt, false); assert.equal(v.calls.length, count);
  assert.equal(v.nativePromptCount, purpose === 'quarantine' && count === 1 ? 1 : 0); if (purpose === 'quarantine' && count === 1) assert.equal(v.nativePromptQualified, true);
  for (const c of v.calls) { assert.equal(c.phase, 'fulfilled'); assert.equal(c.argumentsValid, true); assert.ok(Number.isFinite(c.startedAt) && Number.isFinite(c.finishedAt) && c.finishedAt >= c.startedAt); assert.equal(c.error, undefined);
    if (purpose === 'quarantine') { closed(c.receipt, ['schemaVersion', 'nonce', 'canonicalHomeAbsent', 'preservedEmpty', 'intentSha256']); assert.equal(c.receipt.schemaVersion, 1); assert.equal(c.receipt.canonicalHomeAbsent, true); assert.equal(c.receipt.preservedEmpty, true); assert.match(c.receipt.nonce, SHA); assert.match(c.receipt.intentSha256, SHA); }
    else assert.equal(c.resultValid, true);
  }
}
export const PHASES = ['launch', 'software-ready', 'snapshot', 'close-a', 'restart', 'restart-ready', 'dedup-stale', 'close-b'] as const;
export type Phase = typeof PHASES[number] | 'leave-mode' | 'restart-leave';
export class Gate {
  #index = 0; #busy = false; #held = false; #left = false; #restartLeft = false; #armed?: Phase;
  constructor(private prior: string) { assert.match(prior, SHA); }
  get predecessor() { return this.prior; } get next() { return PHASES[this.#index]; } get busy() { return this.#busy; } get held() { return this.#held; } get done() { return this.#index === PHASES.length; }
  expected(controlled: boolean): Phase { if (this.next === 'software-ready' && controlled && !this.#left) return 'leave-mode'; if (this.next === 'restart-ready' && controlled && !this.#restartLeft) return 'restart-leave'; return this.next; }
  arm(line: string, controlled: boolean): Phase {
    try { assert.ok(!this.#busy && !this.#held && !this.done); const phase = this.expected(controlled); assert.equal(line, `${phase} ${this.prior}`); if (phase === 'software-ready' || phase === 'restart-ready') assert.equal(controlled, false); this.#busy = true; this.#armed = phase; return phase; }
    catch { this.fail(); throw Error('SOFTWARE_ARM_HELD'); }
  }
  complete(phase: Phase, pin: string) { assert.ok(this.#busy && !this.#held); assert.equal(phase, this.#armed); assert.match(pin, SHA); if (phase === 'leave-mode') { assert.equal(this.next, 'software-ready'); assert.equal(this.#left, false); this.#left = true; } else if (phase === 'restart-leave') { assert.equal(this.next, 'restart-ready'); assert.equal(this.#restartLeft, false); this.#restartLeft = true; } else { assert.equal(phase, this.next); this.#index++; } this.prior = pin; this.#busy = false; this.#armed = undefined; }
  fail() { this.#held = true; }
}


export type HistoryCheckpoint = 'history-primary-identity' | 'history-primary-immutable' | 'history-primary-owner' | 'history-primary-release' | 'history-extra-inspect' | 'history-hardware';
export function assertHistorical(state: AppSnapshot, admission: HostAdmission, before?: Fz3bRunView, checkpoint: (id: HistoryCheckpoint) => void = () => {}) {
  checkpoint('history-primary-identity');
  assert.equal(state.version, '1.0.0'); assert.ok(samePath(state.dataDir, path.join(ROOT, '.runtime/app')));
  const run = state.fz3bAgent?.runs.find(r => r.runId === INCIDENT.runId); assert.ok(run);
  checkpoint('history-primary-immutable');
  assertHistory(fullHistory(run)); assert.deepEqual(fullHistory(run), admission.history); if (before) assertFz3bOriginalUnknownPreserved(before, run);
  checkpoint('history-primary-owner');
  assert.equal(new Set(state.fz3bAgent!.runs.map(r => r.runId)).size, state.fz3bAgent!.runs.length);
  assert.equal(state.fz3bAgent?.activeRunId, undefined); assert.equal(state.fz3bAgent?.recoveryActions, undefined);
  assert.equal(state.hardware.enabled, false); assert.equal(typeof state.hardware.modeActive, 'boolean');
  assert.equal(state.hardware.reason, state.hardware.modeActive ? '工程受控模式：普通模型命令已停止，实机操作须单独授权' : '普通模型设备工具未开放；固定板型可进入本地实机流程');
  assert.equal(run.grant, undefined); assert.equal(run.semantic, undefined);
  checkpoint('history-primary-release');
  const released = run.preflightRefusalRecoveries?.at(-1);
  assert.ok(released?.status === 'released' && released.proof && released.finalization && released.ack && released.acknowledgment && released.closure);
  assert.ok(run.operations.some(o => o.id === INCIDENT.operationId && o.status === 'unknown'));
  checkpoint('history-extra-inspect');
  for (const other of state.fz3bAgent!.runs.filter(r => r.runId !== INCIDENT.runId)) {
    if (other.status === 'active' || other.active || other.hardwareBusy || ['pending', 'unknown'].includes(other.nativeApproval) ||
        other.operations.some(o => ['unknown', 'prepared', 'running', 'stopping'].includes(o.status)) ||
        other.calls.some(c => ['running', 'unknown'].includes(c.status) || c.result?.operation && ['unknown', 'prepared', 'running', 'stopping'].includes(c.result.operation.status))) assertReviewedHistoricalInspect(other);
  }
  checkpoint('history-hardware');
  for (const other of state.hardwareAgent?.runs ?? []) assert.ok(other.calls.every(c => !['unknown', 'running'].includes(c.status) && (!c.result?.operation || !['unknown', 'prepared', 'running'].includes(c.result.operation.status))));
  return run;
}
export function assertNoWork(state: AppSnapshot, currentTaskId?: string, allowCurrent = false) {
  assert.equal(state.hardwareAgent?.activeRunId, undefined); assert.equal(state.fz3bAgent?.activeRunId, undefined); assert.equal(state.fz3bAgent?.recoveryActions, undefined);
  for (const agent of [state.hardwareAgent, state.fz3bAgent]) {
    assert.ok(agent); assert.equal(agent.engineState, 'stopped'); assert.ok(agent.runs.every(r => !r.active && !r.hardwareBusy && r.nativeApproval !== 'pending'));
  }
  for (const s of state.sessions) { assert.ok(s.engineUncertain === undefined || s.engineUncertain === false); if (!allowCurrent || s.taskId !== currentTaskId) assert.ok(!s.turnId && !['running', 'stopping', 'unknown', 'active', 'inProgress'].includes(s.status)); }
  for (const t of state.tasks) for (const o of t.operations) { assert.notEqual(o.status, 'unknown'); if (!allowCurrent || t.id !== currentTaskId) assert.ok(!['prepared', 'running', 'stopping'].includes(o.status) && o.cleanup !== 'unknown' && o.cleanup !== 'unconfirmed'); }
  if (!allowCurrent) assert.equal(state.approvals.length, 0);
}
