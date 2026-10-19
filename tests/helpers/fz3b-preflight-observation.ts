import assert from 'node:assert/strict';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';

export async function protectBeforeFailurePersistence<T>(protect: () => T, persist: (protection: T) => Promise<void>): Promise<{
  protection: T; evidencePersisted: boolean; persistenceError?: string;
}> {
  const protection = protect();
  try { await persist(protection); return { protection, evidencePersisted: true }; }
  catch (error) { return { protection, evidencePersisted: false, persistenceError: error instanceof Error ? error.message : String(error) }; }
}

export function fz3bPreflightTarget(state: AppSnapshot, runId: string): Fz3bRunView {
  const run = state.fz3bAgent?.runs.find(item => item.runId === runId);
  assert.ok(run, `Exact historical FZ3B run ${runId} is absent`);
  return run;
}

export function fz3bPreflightUnknownSummary(run: Fz3bRunView) {
  const calls = run.calls.map(call => ({ callId: call.callId, tool: call.tool, status: call.status, operationId: call.operationId }));
  const operations = run.operations.map(operation => ({ id: operation.id, kind: operation.kind, status: operation.status,
    dispatchPhase: operation.dispatchPhase, processExited: operation.processExited, remoteQuiescent: operation.remoteQuiescent }));
  return JSON.parse(JSON.stringify({ runId: run.runId, status: run.status, phase: run.phase, calls, operations })) as {
    runId: string; status: string; phase: string; calls: Array<Record<string, unknown>>; operations: Array<Record<string, unknown>>;
  };
}

export function assertFz3bPreflightUnknownSummaryMatches(run: Fz3bRunView, persisted: unknown): void {
  const actual = fz3bPreflightUnknownSummary(run);
  const saved = persisted as typeof actual;
  assert.deepEqual(actual, { runId: saved.runId, status: saved.status, phase: saved.phase, calls: saved.calls, operations: saved.operations },
    'Current unknown/call/operation summary differs from the JSON-persisted prior report');
}

export function assertFz3bOriginalUnknownPreserved(before: Fz3bRunView, after: Fz3bRunView): void {
  assert.equal(after.runId, before.runId); assert.equal(after.taskId, before.taskId); assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(after.calls, before.calls, 'Original calls must remain unchanged; no replay');
  assert.deepEqual(after.operations, before.operations, 'Original operations, including unknown, must remain unchanged');
  assert.deepEqual(after.artifact, before.artifact); assert.deepEqual(after.identity, before.identity);
  assert.deepEqual(after.grant, before.grant); assert.deepEqual(after.semantic, before.semantic);
  assert.deepEqual(after.preflightRefusalRecoveries, before.preflightRefusalRecoveries, 'Signed recovery history must remain unchanged during finish observation');
  assert.deepEqual(after.maintenanceExit, before.maintenanceExit, 'Prior maintenance seal must remain unchanged');
  assert.equal(after.operations.filter(operation => operation.status === 'unknown').length,
    before.operations.filter(operation => operation.status === 'unknown').length);
}

export function fz3bPreflightRecoverySettled(state: AppSnapshot, runId: string): boolean {
  const run = state.fz3bAgent?.runs.find(item => item.runId === runId), recovery = run?.preflightRefusalRecoveries?.at(-1);
  const taskOpsQuiet = (state.tasks ?? []).every(task => task.operations.every(operation =>
    !['prepared', 'running', 'stopping', 'unknown'].includes(operation.status.toLowerCase()) && operation.cleanup !== 'unknown'));
  const foreignSessionsQuiet = (state.sessions ?? []).every(session => session.taskId === run?.taskId ||
    (!session.engineUncertain && !['running', 'stopping'].includes(session.status.toLowerCase())));
  const allQuiet = state.fz3bAgent?.activeRunId === undefined && state.fz3bAgent?.engineState === 'stopped' &&
    (state.fz3bAgent?.runs ?? []).every(item => !item.active && !item.hardwareBusy && item.nativeApproval !== 'pending') &&
    state.hardwareAgent?.activeRunId === undefined && state.hardwareAgent?.engineState === 'stopped' &&
    (state.hardwareAgent?.runs ?? []).every(item => !item.active && !item.hardwareBusy && item.nativeApproval !== 'pending') &&
    state.engine?.state === 'stopped' && (state.approvals ?? []).length === 0 && taskOpsQuiet && foreignSessionsQuiet;
  return !!run && !!recovery && recovery.status === 'released' && !!recovery.proof && !!recovery.finalization && !!recovery.ack &&
    !!recovery.acknowledgment && !!recovery.closure && !run.active && !run.hardwareBusy && run.nativeApproval !== 'pending' && allQuiet;
}

export function assertFz3bPreflightRecoverySettled(state: AppSnapshot, runId: string, before: Fz3bRunView): Fz3bRunView {
  assert.ok(fz3bPreflightRecoverySettled(state, runId), 'Recovery checkpoint, independent worker-closure certificate, and process quiet must all be visible');
  const run = fz3bPreflightTarget(state, runId); assertFz3bOriginalUnknownPreserved(before, run); return run;
}

export function assertFz3bPreflightRestartHeld(state: AppSnapshot, runId: string, before: Fz3bRunView): Fz3bRunView {
  const run = fz3bPreflightTarget(state, runId); assertFz3bOriginalUnknownPreserved(before, run);
  assert.ok(run.preflightRefusalRecoveries?.some(item => item.status === 'released'), 'Prior proof/release must remain recorded');
  assert.equal(state.fz3bAgent?.recoveryActions?.finishPreflightRefusal, true,
    'Restart must conservatively re-hold until explicit local finish');
  return run;
}

export function assertFz3bPreflightFinished(state: AppSnapshot, runId: string, before: Fz3bRunView): Fz3bRunView {
  assertFz3bPreflightRecoverySettled(state, runId, before);
  const run = fz3bPreflightTarget(state, runId); assertFz3bOriginalUnknownPreserved(before, run);
  assert.notEqual(state.fz3bAgent?.recoveryActions?.finishPreflightRefusal, true);
  assert.equal(run.preflightRefusalRecoveries?.at(-1)?.status, 'released');
  return run;
}

export interface Fz3bFinishUiObservation { taskId: string; sequence: string[]; initialIntent: string; installedAt: string; }

export function installFz3bFinishUiObserver(taskId: string) {
  const key = '__fz3bFinishUiObservationV1';
  const win = window as any;
  if (win[key]) throw new Error('Finish UI observer already installed');
  const panel = document.querySelector<HTMLElement>(`.fz3b-scroll[data-task-id="${CSS.escape(taskId)}"]`);
  if (!panel) throw new Error('Exact FZ3B task panel is absent');
  const initialIntent = panel.getAttribute('data-pending-intent') ?? '';
  if (initialIntent !== '') throw new Error('UI action was already pending before observation');
  const observation: Fz3bFinishUiObservation = { taskId, sequence: [initialIntent], initialIntent, installedAt: new Date().toISOString() };
  const observer = new MutationObserver(records => {
    if (!panel.isConnected || panel.getAttribute('data-task-id') !== taskId) return;
    const intentRecords = records.filter(record => record.target === panel && record.attributeName === 'data-pending-intent');
    if (intentRecords.length) {
      for (const record of intentRecords) {
        const value = record.oldValue ?? '';
        if (observation.sequence.at(-1) !== value) observation.sequence.push(value);
      }
      const current = panel.getAttribute('data-pending-intent') ?? '';
      if (observation.sequence.at(-1) !== current) observation.sequence.push(current);
    }
  });
  observer.observe(panel, { attributes: true, attributeOldValue: true, attributeFilter: ['data-pending-intent', 'aria-busy'] });
  win[key] = { observation, observer, panel };
  return { taskId, initialIntent, installed: true };
}

export function readFz3bFinishUiObserver(taskId: string) {
  const state = (window as any).__fz3bFinishUiObservationV1;
  if (!state || state.observation.taskId !== taskId) throw new Error('Exact finish UI observer is unavailable');
  const panel = document.querySelector<HTMLElement>(`.fz3b-scroll[data-task-id="${CSS.escape(taskId)}"]`);
  return { ...state.observation, sequence: [...state.observation.sequence], connected: !!panel?.isConnected,
    sameElement: panel === state.panel,
    currentIntent: panel?.getAttribute('data-pending-intent') ?? null, ariaBusy: panel?.getAttribute('aria-busy') ?? null,
    actionErrorCount: panel?.querySelectorAll(':scope > .notice.error[role="alert"]').length ?? -1 };
}

export function restoreFz3bFinishUiObserver(taskId: string) {
  const key = '__fz3bFinishUiObservationV1';
  const win = window as any, state = win[key];
  if (!state || state.observation.taskId !== taskId) throw new Error('Exact finish UI observer is unavailable');
  state.observer.disconnect(); delete win[key]; return { taskId, restored: true };
}

export function fz3bFinishUiSettled(value: any, taskId: string): boolean {
  return value?.taskId === taskId && value.connected === true && value.sameElement === true && value.initialIntent === '' &&
    JSON.stringify(value.sequence) === JSON.stringify(['', 'reconcile-preflight-inspect', '']) &&
    value.currentIntent === '' && value.ariaBusy === 'false' && value.actionErrorCount === 0;
}
