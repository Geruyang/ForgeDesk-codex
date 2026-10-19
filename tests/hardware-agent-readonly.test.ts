import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { HardwareAgentInstalledPlan } from './helpers/hardware-agent-installed';
import { primarySid } from './helpers/snapshot-smoke-scope';
import { redact } from '../packages/engineering-runner/redaction';
import { assertReadonlyFailureBoundary, assertReadonlyObservation, hexDefinedBytes, MODEL_CONTROL_NAMES,
  READONLY_RUNTIME, READONLY_SOURCE_RUN, type ReadonlySource } from './helpers/hardware-agent-readonly';

// Boundary fixtures only: these deliberately are not physical receipt/build evidence.
const installed = path.resolve('install/ForgeDesk.exe'), expiry = '2026-10-15T15:08:44.400Z';
function fixture() {
  const plan = { runId: READONLY_SOURCE_RUN, runtimeCommit: READONLY_RUNTIME, installedExe: installed } as HardwareAgentInstalledPlan;
  const run = { runId: 'actual-run', sessionId: 'session', taskId: 'task', model: 'gpt-6.1-sol', status: 'completed', phase: 'completed',
    active: false, hardwareBusy: false, stopRequested: false, nativeApproval: 'approved', calls: Array.from({ length: 6 }, (_, index) => ({ callId: `call-${index}` })) };
  const hardware = { configured: true, taskId: 'task', profileId: 'profile', profileSha256: 'a'.repeat(64), artifact: { id: 'artifact' },
    operations: ['build', 'inspect', 'flash', 'verify'].map(kind => ({ id: kind, kind, status: 'succeeded', processExited: true })),
    grant: { approvedAt: '2026-10-15T15:04:37Z', expiresAt: expiry, consumedBy: 'flash' } };
  const source = { schemaVersion: 1, runId: READONLY_SOURCE_RUN, runtimeCommit: READONLY_RUNTIME, scope: 'real-model-fixed-target-installed-T2',
    realModel: true, secondUser: false, result: 'failed', model: 'gpt-6.1-sol', release: { version: '0.4.0' }, publicAccount: { loggedIn: true },
    desktop: { sid: primarySid, elevated: false, explorerMatched: true }, pageErrors: [], uiSubmitCount: 1,
    hostPreparation: { operationCount: 0, ordinaryEngineState: 'stopped' },
    controls: Object.fromEntries(MODEL_CONTROL_NAMES.map((name, index) => [name, index < 9 ? 'passed' : 'pending'])),
    failures: ['AssertionError [ERR_ASSERTION]: Restart must not resume or fabricate controller calls\n+ actual - expected\n- artifact: undefined,\n- message: undefined,\n- detail: undefined,\n- progress: undefined,'],
    run, hardware, failureRun: structuredClone(run), failureHardware: structuredClone(hardware),
    launches: Array.from({ length: 2 }, () => ({ electronMain: { type: 'browser', pid: 123, execPath: installed }, nativeMain: { sid: primarySid, id: 123 } })),
    closes: Array.from({ length: 2 }, () => ({ normalClose: true, installedGuiAbsent: true, nativeAfter: null, launcherExitCode: 0, launcherSignal: null, exitCodeScope: 'playwright-launcher' })),
  } as unknown as ReadonlySource;
  const snapshot = { version: '0.4.0', engine: { state: 'stopped' }, hardwareAgent: { engineState: 'stopped', runs: [structuredClone(run)] },
    sessions: [{ id: 'session', taskId: 'task', status: 'completed', engineUncertain: false }] } as unknown as AppSnapshot;
  return { source, plan, snapshot };
}

test('offline continuation admission accepts only the known source failed at the undefined-omission comparator', () => {
  const { source, plan } = fixture(); assertReadonlyFailureBoundary(source, plan);
  for (const mutate of [(s: ReadonlySource) => { s.result = 'passed'; }, (s: ReadonlySource) => { s.controls.flash = 'pending'; },
    (s: ReadonlySource) => { s.failures.push('another failure'); }, (s: ReadonlySource) => { s.failures[0] += '\n+ status: failed,'; },
    (s: ReadonlySource) => { s.failures[0] = s.failures[0].replace('detail: undefined', 'detail: null'); },
    (s: ReadonlySource) => { s.failureRun.calls.push({ callId: 'new' } as any); },
    (s: ReadonlySource) => { s.failureHardware.operations[0].status = 'unknown'; },
    (s: ReadonlySource) => { s.closes[1].normalClose = false; }, (s: ReadonlySource) => { s.pageErrors.push('error'); },
    (s: ReadonlySource) => { s.desktop.sid = 'wrong-account'; }, (s: ReadonlySource) => { s.uiSubmitCount = 2; }]) {
    const changed = structuredClone(source); mutate(changed); assert.throws(() => assertReadonlyFailureBoundary(changed, plan));
  }
});

test('offline read-only observation accepts unchanged terminal state and either absent or false optional uncertainty', () => {
  const { source, snapshot } = fixture();
  for (const uncertain of [undefined, false]) {
    snapshot.sessions[0].engineUncertain = uncertain;
    const checked = assertReadonlyObservation(source, snapshot, source.hardware, '2026-10-15T15:07:00Z');
    assert.equal(checked.derivedApprovalExpiry, undefined); assert.equal(checked.session.status, 'completed');
  }
  snapshot.sessions[0].engineUncertain = true;
  assert.throws(() => assertReadonlyObservation(source, snapshot, source.hardware, expiry));
});

test('offline continuation discloses only a genuinely elapsed native approval TTL without rewriting actual history', () => {
  const { source, snapshot } = fixture(); snapshot.hardwareAgent!.runs[0].nativeApproval = 'expired';
  const checked = assertReadonlyObservation(source, snapshot, source.hardware, expiry);
  assert.deepEqual(checked.derivedApprovalExpiry, { from: 'approved', to: 'expired', expiresAt: expiry, observedAt: expiry });
  assert.equal(checked.run.nativeApproval, 'expired'); assert.equal(source.run.nativeApproval, 'approved');
  for (const when of ['invalid', '2026-10-15T15:08:44.399Z']) assert.throws(() => assertReadonlyObservation(source, snapshot, source.hardware, when));
  snapshot.hardwareAgent!.runs[0].calls[0].result = { unexpected: 'rewritten history' } as any;
  assert.throws(() => assertReadonlyObservation(source, snapshot, source.hardware, expiry));
});

test('offline continuation refuses busy owners, live turns, changed grants, new operations and non-TTL state changes', () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.snapshot.hardwareAgent!.activeRunId = 'other'; },
    (f: ReturnType<typeof fixture>) => { f.snapshot.hardwareAgent!.engineState = 'ready'; },
    (f: ReturnType<typeof fixture>) => { f.snapshot.sessions[0].turnId = 'live-turn'; },
    (f: ReturnType<typeof fixture>) => { f.snapshot.hardwareAgent!.runs[0].nativeApproval = 'unknown'; },
    (f: ReturnType<typeof fixture>) => { f.snapshot.hardwareAgent!.runs[0].status = 'stopped'; }]) {
    const f = fixture(); change(f); assert.throws(() => assertReadonlyObservation(f.source, f.snapshot, f.source.hardware, expiry));
  }
  for (const change of [(h: ReadonlySource['hardware']) => { h.grant!.consumedBy = 'new-flash'; },
    (h: ReadonlySource['hardware']) => { h.operations.push(structuredClone(h.operations[0])); },
    (h: ReadonlySource['hardware']) => { h.operations[0].updatedAt = 'later'; }]) {
    const f = fixture(), hardware = structuredClone(f.source.hardware); change(hardware);
    assert.throws(() => assertReadonlyObservation(f.source, f.snapshot, hardware, expiry));
  }
});

test('offline HEX checks reject checksum errors, addresses outside fixed Flash and contradictory overlapping bytes', () => {
  const valid = ':020000040800F2\n:0100000001FE\n:00000001FF\n'; assert.equal(hexDefinedBytes(valid), 1);
  for (const value of [valid.replace('01FE', '01FF'), valid.replace('0800F2', '0000FA'), valid.replace(':00000001FF', ':0100000002FD\n:00000001FF'), valid.replace(':00000001FF', '')])
    assert.throws(() => hexDefinedBytes(value));
});

test('offline AST enforces that continuation calls only snapshot and hardwareSnapshot public APIs', async () => {
  const text = await readFile(new URL('./hardware-agent-readonly-continuation.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('continuation.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), methods: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === 'window.forgeDesk') methods.push(node.expression.name.text);
    if (ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)) assert.notEqual(node.expression.expression.getText(ast), 'window.forgeDesk');
    node.forEachChild(visit);
  };
  visit(ast); assert.deepEqual(methods.sort(), ['hardwareSnapshot', 'snapshot']);
  assert.ok(!text.includes('showMessageBox ='), 'No synthesized native decisions');
});

async function nativeReadFixture(outcomes: Array<string | Error>, persistenceError?: Error) {
  const text = await readFile(new URL('./hardware-agent-readonly-continuation.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('continuation.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'nativeProcess'); assert.ok(declaration);
  const code = ts.transpileModule(`${declaration.getText(ast)};globalThis.queryUnderTest=nativeProcess;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const calls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = [], report: Record<string, any> = {};
  const context: Record<string, any> = { report, Date, JSON, Error, redact, windowsPowerShell: 'fixture-powershell', nativeMainProcessQuery: (pid: number) => `readonly-query-${pid}`,
    evidence: async () => { if (persistenceError) throw persistenceError; },
    execute: async (executable: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ executable, args, options }); assert.equal(options.timeout, 45000); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
      const value = outcomes.shift(); assert.notEqual(value, undefined, 'No third or unplanned process query is allowed');
      if (value instanceof Error) throw value; return { stdout: value };
    } };
  runInNewContext(code, context); return { invoke: () => context.queryUnderTest(26708), calls, report };
}

test('offline actual continuation process query records a successful single 45-second-bounded read', async () => {
  const fixture = await nativeReadFixture(['null']); assert.equal(await fixture.invoke(), null); assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.report.nativeProcessQueries[0].outcome, 'read'); assert.equal(fixture.report.nativeProcessQueries[0].pid, 26708);
  assert.ok(fixture.report.nativeProcessQueries[0].elapsedMs >= 0); assert.ok(Number.isFinite(Date.parse(fixture.report.nativeProcessQueries[0].startedAt)));
});

test('offline actual continuation process query retries only an explicit timeout or the execFile timeout kill signature once', async () => {
  for (const error of [Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' }), Object.assign(new Error('query was killed by timeout'), { code: null, killed: true, signal: 'SIGTERM' })]) {
    const fixture = await nativeReadFixture([error, 'null']); assert.equal(await fixture.invoke(), null); assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.report.nativeProcessQueries[0].timedOut, true); assert.equal(fixture.report.nativeProcessQueries[1].outcome, 'read');
    assert.deepEqual(Array.from(fixture.report.nativeProcessQueries, (item: any) => item.attempt), [1, 2]);
  }
  const first = Object.assign(new Error('first timeout'), { code: 'ETIMEDOUT' }), last = Object.assign(new Error('last timeout'), { code: 'ETIMEDOUT' });
  const fixture = await nativeReadFixture([first, last]); await assert.rejects(fixture.invoke(), error => error === last);
  assert.equal(fixture.calls.length, 2); assert.equal(fixture.report.nativeProcessQueries.length, 2);
});

test('offline actual continuation process query never retries syntax, permission, exit or ambiguous killed errors', async () => {
  for (const value of ['not-json', Object.assign(new Error('timeout in a message is not proof'), { code: 1 }),
    Object.assign(new Error('permission'), { code: 'EACCES', killed: true, signal: 'SIGTERM' }),
    Object.assign(new Error('external cancellation'), { code: null, killed: true, signal: 'SIGKILL' })]) {
    const fixture = await nativeReadFixture([value]); await assert.rejects(fixture.invoke()); assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.report.nativeProcessQueries[0].timedOut, false);
  }
});

test('offline process-read retry cannot be triggered by an evidence-persistence timeout', async () => {
  const failure = Object.assign(new Error('evidence storage unavailable'), { code: 'ETIMEDOUT' });
  const fixture = await nativeReadFixture(['null'], failure); await assert.rejects(fixture.invoke(), error => error === failure);
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.report.nativeProcessQueries.length, 1);
  assert.equal(fixture.report.nativeProcessQueries[0].outcome, 'read');
});
