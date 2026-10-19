import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import type { Fz3bHostFinalizationIpcReceipt } from './fz3b-host-finalization-ipc-observer';
import { observeFz3bHostFinalOriginalCall } from './fz3b-host-finalization-installed';

const directory = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/host-finalization');
function pinnedJson(relative: string, sha256: string) {
  const bytes = readFileSync(path.join(directory, relative));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  return JSON.parse(bytes.toString('utf8'));
}
const source = pinnedJson('resume-existing-10180-P2xDVG/evidence.json',
  'b0872ac4c735aee39e0c80a0c6c1ea2026e462f84576ad5c6a0686d7b5e80df1');
const terminal = pinnedJson('read-existing-terminal-10180-6v0azk/evidence.json',
  '62e1f512577d30529b045fc73da6d38f0384756b8b66ccc5acaa02991e605779');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const original = (): Fz3bRunView => clone(source.initialRun);
function receipt(phase: 'started' | 'fulfilled' = 'fulfilled'): Fz3bHostFinalizationIpcReceipt {
  return { mechanism: 'test-only exact-run original forgedesk:invoke pass-through observer', electronVersion: '44.7.2',
    runId: source.targetRunId, calls: [{ argumentsValid: true, argumentCount: 1, phase, startedAt: 100,
      ...(phase === 'fulfilled' ? { finishedAt: 200 } : {}) }] };
}
function snapshot(run = original()): AppSnapshot {
  return { fz3bAgent: { runs: [{ ...run, active: false, hardwareBusy: false }], engineState: 'stopped' },
    hardwareAgent: { runs: [], engineState: 'stopped' }, engine: { state: 'stopped' }, approvals: [], tasks: [], sessions: [] } as unknown as AppSnapshot;
}
function dom() {
  return { taskId: source.initialRun.taskId, sequence: ['', 'reconcile-preflight-inspect', ''], initialIntent: '',
    connected: true, sameElement: true, currentIntent: '', ariaBusy: 'false', actionErrorCount: 0 };
}
function readers(ipc = receipt(), state = snapshot(), ui = dom()) {
  const order: string[] = [];
  return { order, ipc: async () => { order.push('ipc'); return ipc; },
    snapshot: async () => { order.push('snapshot'); return state; }, dom: async () => { order.push('dom'); return ui; } };
}
function missingProjection() {
  const run = original(), recovery = run.preflightRefusalRecoveries!.at(-1)!;
  delete recovery.ack; delete recovery.acknowledgment; delete recovery.closure;
  return run;
}

test('actual JSON baseline retains full released proof and the actual original IPC rejection', () => {
  assert.ok(original().preflightRefusalRecoveries!.at(-1)!.closure);
  assert.equal(terminal.lastOriginalIpc.calls.length, 1);
  assert.equal(terminal.lastOriginalIpc.calls[0].phase, 'rejected');
  assert.match(terminal.lastOriginalIpc.calls[0].error, /ETIMEDOUT/);
});

test('pending ACK projection may disappear but cannot count as original Promise settlement', async () => {
  const read = readers(receipt('started'), snapshot(missingProjection()));
  assert.equal((await observeFz3bHostFinalOriginalCall(original(), read)).settled, false);
  assert.deepEqual(read.order, ['ipc', 'snapshot', 'dom']);
  assert.equal((await observeFz3bHostFinalOriginalCall(original(), readers(receipt('started')))).settled, false);
});

test('the same absent ACK projection is rejected after the original Promise fulfills', async () => {
  await assert.rejects(observeFz3bHostFinalOriginalCall(original(), readers(receipt(), snapshot(missingProjection()))), /history/);
});

test('a fresh post-fulfillment snapshot is required, never a previously captured pending snapshot', async () => {
  let fulfilled = false;
  const read = readers();
  read.ipc = async () => { read.order.push('ipc'); fulfilled = true; return receipt(); };
  read.snapshot = async () => { read.order.push('snapshot'); assert.equal(fulfilled, true); return snapshot(); };
  assert.equal((await observeFz3bHostFinalOriginalCall(original(), read)).settled, true);
  assert.deepEqual(read.order, ['ipc', 'snapshot', 'dom']);
});

test('actual ETIMEDOUT rejection fails before snapshot, DOM, cleanup, or another call', async () => {
  const read = readers(clone(terminal.lastOriginalIpc));
  await assert.rejects(observeFz3bHostFinalOriginalCall(original(), read), /ETIMEDOUT/);
  assert.deepEqual(read.order, ['ipc']);
});

for (const field of ['taskId', 'sessionId', 'calls', 'operations', 'artifact', 'identity', 'grant', 'semantic', 'maintenanceExit'] as const) {
  test(`pending projection does not hide a changed original ${field}`, async () => {
    const run = missingProjection();
    (run as any)[field] = field === 'taskId' || field === 'sessionId' ? 'foreign-owner' : { corrupted: true };
    await assert.rejects(observeFz3bHostFinalOriginalCall(original(), readers(receipt('started'), snapshot(run))));
  });
}

for (const field of ['status', 'phase'] as const) {
  test(`pending projection does not hide changed original ${field}`, async () => {
    const run = missingProjection(); (run as any)[field] = 'forged-success';
    await assert.rejects(observeFz3bHostFinalOriginalCall(original(), readers(receipt('started'), snapshot(run))));
  });
}

for (const field of ['proof', 'finalization', 'ack', 'acknowledgment', 'closure'] as const) {
  test(`fulfilled original Promise still rejects a changed recovery ${field}`, async () => {
    const run = original();
    (run.preflightRefusalRecoveries!.at(-1)! as any)[field] = { changed: true };
    await assert.rejects(observeFz3bHostFinalOriginalCall(original(), readers(receipt(), snapshot(run))), /history/);
  });
}

test('no original call cannot settle or hide history changes', async () => {
  const ipc = receipt(); ipc.calls = [];
  assert.equal((await observeFz3bHostFinalOriginalCall(original(), readers(ipc))).settled, false);
  await assert.rejects(observeFz3bHostFinalOriginalCall(original(), readers(ipc, snapshot(missingProjection()))), /history/);
});

test('duplicates, wrong owner, wrong args and invalid terminal receipts fail closed', async () => {
  for (const mutate of [
    (value: Fz3bHostFinalizationIpcReceipt) => { value.calls.push(clone(value.calls[0])); },
    (value: Fz3bHostFinalizationIpcReceipt) => { value.runId = 'foreign'; },
    (value: Fz3bHostFinalizationIpcReceipt) => { value.calls[0].argumentsValid = false; },
    (value: Fz3bHostFinalizationIpcReceipt) => { value.calls[0].argumentCount = 2; },
    (value: Fz3bHostFinalizationIpcReceipt) => { value.calls[0].finishedAt = 99; },
  ]) {
    const ipc = receipt(); mutate(ipc);
    const read = readers(ipc); await assert.rejects(observeFz3bHostFinalOriginalCall(original(), read));
    assert.deepEqual(read.order, ['ipc']);
  }
});

test('terminal success still waits for the exact DOM sequence, Promise-finally signal and global quiet', async () => {
  for (const patch of [{ currentIntent: 'reconcile-preflight-inspect' }, { ariaBusy: 'true' }, { sameElement: false },
    { sequence: ['', 'reconcile-preflight-inspect', '', 'reconcile-preflight-inspect', ''] }, { actionErrorCount: 1 }]) {
    assert.equal((await observeFz3bHostFinalOriginalCall(original(), readers(receipt(), snapshot(), { ...dom(), ...patch }))).settled, false);
  }
  const state = snapshot(); state.fz3bAgent!.activeRunId = 'foreign-owner';
  assert.equal((await observeFz3bHostFinalOriginalCall(original(), readers(receipt(), state))).settled, false);
});

test('two successful observations independently re-read original IPC and complete history', async () => {
  const read = readers();
  assert.equal((await observeFz3bHostFinalOriginalCall(original(), read)).settled, true);
  assert.equal((await observeFz3bHostFinalOriginalCall(original(), read)).settled, true);
  assert.deepEqual(read.order, ['ipc', 'snapshot', 'dom', 'ipc', 'snapshot', 'dom']);
  read.snapshot = async () => snapshot(missingProjection());
  await assert.rejects(observeFz3bHostFinalOriginalCall(original(), read), /history/);
});

function isolationReaders() {
  const state = snapshot(); state.fz3bAgent!.activeRunId = source.targetRunId;
  state.fz3bAgent!.recoveryActions = { runId: source.targetRunId, taskId: source.initialRun.taskId, sessionId: source.initialRun.sessionId,
    reconcileInspect: false, reconcilePreflightRefusedInspect: true, finishPreflightRefusal: true, quarantineEmptyHome: false, maintenanceExit: true, exportEvidence: false };
  const ipc = receipt(); ipc.purpose = 'quarantine';
  ipc.calls[0].quarantineReceipt = { schemaVersion: 1, nonce: 'a'.repeat(64), canonicalHomeAbsent: true, preservedEmpty: true, intentSha256: 'b'.repeat(64) };
  return readers(ipc, state, { ...dom(), sequence: ['', 'quarantine-empty-home', ''] });
}

test('quarantine settlement requires its own original IPC, exact public receipt, DOM and retained unknown hold', async () => {
  const read = isolationReaders(), result = await observeFz3bHostFinalOriginalCall(original(), read, 'quarantine');
  assert.equal(result.settled, true); assert.deepEqual(read.order, ['ipc', 'snapshot', 'dom']);
  await assert.rejects(observeFz3bHostFinalOriginalCall(original(), isolationReaders()), /strictly equal/);
});

test('quarantine cannot use cancelled receipt or cap false alone to claim canonical home absent', async () => {
  for (const value of [null, undefined, { canonicalHomeAbsent: true },
    { schemaVersion: 1, nonce: 'a'.repeat(64), canonicalHomeAbsent: false, preservedEmpty: true, intentSha256: 'b'.repeat(64) }]) {
    const read = isolationReaders(), ipc = await read.ipc(); ipc.calls[0].quarantineReceipt = value;
    await assert.rejects(observeFz3bHostFinalOriginalCall(original(), read, 'quarantine'));
  }
});

test('quarantine must not release owner, clear unknown, alter history or silently finish', async () => {
  for (const change of ['owner', 'unknown', 'history', 'finish']) {
    const read = isolationReaders(), state = await read.snapshot();
    if (change === 'owner') state.fz3bAgent!.activeRunId = undefined;
    if (change === 'finish') state.fz3bAgent!.recoveryActions!.finishPreflightRefusal = false;
    if (change === 'unknown') (state.fz3bAgent!.runs[0].operations.find(operation => operation.status === 'unknown') as any).status = 'succeeded';
    if (change === 'history') state.fz3bAgent!.runs[0].preflightRefusalRecoveries = [];
    if (change === 'owner' || change === 'finish') assert.equal((await observeFz3bHostFinalOriginalCall(original(), read, 'quarantine')).settled, false);
    else await assert.rejects(observeFz3bHostFinalOriginalCall(original(), read, 'quarantine'));
  }
});

test('failure cleanup preserves both existing observers when original IPC is pending or unreadable', () => {
  const sourceText = readFileSync('tests/fz3b-host-finalization-installed-smoke.ts', 'utf8');
  const ast = ts.createSourceFile('smoke.ts', sourceText, ts.ScriptTarget.Latest, true);
  const catches: ts.CatchClause[] = [];
  const visit = (node: ts.Node) => { if (ts.isCatchClause(node)) catches.push(node); ts.forEachChild(node, visit); };
  visit(ast);
  const failure = catches.find(node => node.getText(ast).includes('protectBeforeFailurePersistence'))!;
  assert.ok(failure);
  assert.match(failure.getText(ast), /let observerCleanupSafe = !ipcObserverInstalled/);
  assert.match(failure.getText(ast), /\['fulfilled', 'rejected'\]\.includes\(call.phase\)/);
  const restores: ts.CallExpression[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.some(argument =>
      ts.isIdentifier(argument) && ['restoreFz3bHostFinalizationIpcObserver', 'restoreFz3bFinishUiObserver'].includes(argument.text))) restores.push(node);
    ts.forEachChild(node, collect);
  };
  collect(failure);
  assert.equal(restores.length, 2);
  for (const restore of restores) {
    let parent: ts.Node | undefined = restore.parent, guarded = false;
    while (parent && parent !== failure) {
      if (ts.isIfStatement(parent) && parent.expression.getText(ast) === 'observerCleanupSafe') guarded = true;
      parent = parent.parent;
    }
    assert.equal(guarded, true, 'Both observer restores must be dominated by known-terminal cleanup gate');
  }
  assert.match(failure.getText(ast), /report.observersRetained/);
});
