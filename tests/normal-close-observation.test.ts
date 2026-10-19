import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { redact } from '../packages/engineering-runner/redaction';

const productionSource = new URL('./second-user-missing-tools-smoke.ts', import.meta.url);

async function closeHarness(options: { inspector?: 'acknowledged' | 'rejected' | 'pending'; playwright?: 'acknowledged' | 'rejected' | 'pending'; nativeAbsent?: boolean; nativeExit?: boolean } = {}) {
  const sourceText = await readFile(productionSource, 'utf8');
  const sourceFile = ts.createSourceFile(productionSource.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'normallyClose');
  assert.ok(declaration, 'Use the actual normallyClose implementation without executing its installed-user entry gate');
  const code = ts.transpileModule(`${declaration.getText(sourceFile)}\nglobalThis.closeUnderTest = normallyClose;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null });
  const report = { cleanup: { appStarted: true, normalClose: false, forcedKill: false, needsHumanClose: true, retainedMarker: 'keep-original-cleanup' } } as { cleanup: Record<string, unknown> };
  const calls: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inspectorError = new Error('Inspector target closed during normal exit');
  const playwrightError = new Error('Playwright target already closed');
  const context: Record<string, any> = {
    assert, scope: { fixture: true }, launcherChild: child, report,
    errorText: (error: unknown) => error instanceof Error ? error.message : String(error),
    setTimeout: (callback: () => void, milliseconds: number) => { const timer = setTimeout(callback, Math.min(milliseconds, 15)); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); },
    observeNormalCloseRequest: (request: PromiseLike<unknown>, milliseconds: number) => observeNormalCloseRequest(request, Math.min(milliseconds, 15)),
    assertSecondUserAppClosed: async () => { calls.push('native-absence'); if (options.nativeAbsent === false) throw new Error('Native application still present'); },
  };
  runInNewContext(code, context);
  const application = {
    evaluate: () => {
      calls.push('native-close-request'); if (options.nativeExit !== false) { child.exitCode = 0; child.emit('close', 0, null); }
      if (options.inspector === 'pending') return new Promise(() => {});
      if (options.inspector === 'rejected') return Promise.reject(inspectorError);
      return Promise.resolve();
    },
    close: () => {
      calls.push('playwright-close');
      assert.equal(child.exitCode, 0, 'Never request Playwright cleanup before the observed native launcher exit');
      assert.ok(calls.includes('native-absence'), 'Never request Playwright cleanup before native absence confirmation');
      if (options.playwright === 'pending') return new Promise(() => {});
      if (options.playwright === 'rejected') return Promise.reject(playwrightError);
      return Promise.resolve();
    },
  };
  return { invoke: () => context.closeUnderTest(application) as Promise<void>, report, calls, cleanup: () => { for (const timer of timers) clearTimeout(timer); } };
}

async function outcomeWithin(request: Promise<unknown>, milliseconds = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request.then(() => ({ state: 'resolved' as const }), error => ({ state: 'rejected' as const, error })),
      new Promise<{ state: 'still-pending' }>(resolve => { timer = setTimeout(() => resolve({ state: 'still-pending' }), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function controlsCloseHarness(options: { inspector?: 'acknowledged' | 'rejected' | 'pending'; playwright?: 'acknowledged' | 'rejected' | 'pending'; nativeAbsent?: boolean; nativeExit?: boolean } = {}) {
  const filename = new URL('./second-user-controls-smoke.ts', import.meta.url);
  const sourceText = await readFile(filename, 'utf8');
  const sourceFile = ts.createSourceFile(filename.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement) && statement.name?.text === 'closeApp');
  assert.ok(declaration);
  const code = ts.transpileModule(`${declaration.getText(sourceFile)}\nglobalThis.closeUnderTest = closeApp;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null as string | null });
  const calls: string[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const report: { nativeCloses: Array<Record<string, any>>; closeRequestObservations?: Array<Record<string, any>> } = { nativeCloses: [] };
  const application = {
    evaluate: () => {
      calls.push('native-close-request'); if (options.nativeExit !== false) { child.exitCode = 0; child.emit('close', 0, null); }
      if (options.inspector === 'pending') return new Promise(() => {});
      if (options.inspector === 'rejected') return Promise.reject(new Error('Inspector closed; password=synthetic-test-only'));
      return Promise.resolve();
    },
    close: () => {
      calls.push('playwright-close');
      assert.equal(child.exitCode, 0); assert.ok(calls.includes('native-application-absence'));
      if (options.playwright === 'pending') return new Promise(() => {});
      if (options.playwright === 'rejected') return Promise.reject(new Error('Playwright closed; password=synthetic-test-only'));
      return Promise.resolve();
    },
  };
  const context: Record<string, any> = {
    assert, redact, app: application, launcher: child, electronMain: { pid: 456 }, nativeMain: { id: 456 }, scope: { fixture: true }, page: { fixture: true }, report,
    evidence: async () => {},
    mainProcess: async () => { calls.push('native-main-query'); return options.nativeAbsent === false ? { id: 456 } : null; },
    assertElectronMainExited: (_before: unknown, after: unknown) => { if (after) throw new Error('Native main still present'); calls.push('native-main-absence'); },
    assertSecondUserAppClosed: async () => { calls.push('native-application-absence'); },
    setTimeout: (callback: () => void, milliseconds: number) => { const timer = setTimeout(callback, Math.min(milliseconds, 15)); timers.add(timer); return timer; },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); },
    observeNormalCloseRequest: (request: PromiseLike<unknown>, milliseconds: number) => observeNormalCloseRequest(request, Math.min(milliseconds, 15)),
  };
  runInNewContext(code, context);
  return { invoke: () => context.closeUnderTest() as Promise<void>, report, calls, context, cleanup: () => { for (const timer of timers) clearTimeout(timer); } };
}

test('acknowledgement and rejection remain distinguishable and preserve the original error', async () => {
  assert.deepEqual(await observeNormalCloseRequest(Promise.resolve(), 15), { state: 'acknowledged' });
  const failure = new Error('Original close failure');
  const rejected = await observeNormalCloseRequest(Promise.reject(failure), 15);
  assert.equal(rejected.state, 'rejected'); if (rejected.state === 'rejected') assert.equal(rejected.error, failure);
});

test('an unresolved request times out without manufacturing acknowledgement', async () => {
  assert.deepEqual(await observeNormalCloseRequest(new Promise(() => {}), 5), { state: 'timed-out', timeoutMs: 5 });
});

test('a late rejection after timeout stays observed rather than becoming unhandled', async () => {
  let rejectLate!: (error: Error) => void;
  const request = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
  const result = await observeNormalCloseRequest(request, 5);
  rejectLate(new Error('Late inspector disconnection')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { state: 'timed-out', timeoutMs: 5 });
});

test('invalid observation deadlines are rejected', () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => observeNormalCloseRequest(Promise.resolve(), timeout), /positive finite timeout/);
});

test('normallyClose is bounded even after native exit if inspector acknowledgement never arrives', async t => {
  const h = await closeHarness({ inspector: 'pending' }); t.after(h.cleanup);
  const result = await outcomeWithin(h.invoke());
  assert.equal(result.state, 'rejected', 'The old unbounded await closeRequest must not survive the observation deadline');
  assert.equal(h.report.cleanup.normalClose, false); assert.equal(h.report.cleanup.forcedKill, false);
  assert.equal((h.report.cleanup.closeRequestObservation as { state?: string } | undefined)?.state, 'timed-out');
  assert.equal(h.report.cleanup.needsHumanClose, true);
  assert.equal(h.calls.includes('playwright-close'), false);
});

test('inspector rejection is retained alongside existing cleanup metadata and native proof', async t => {
  const h = await closeHarness({ inspector: 'rejected' }); t.after(h.cleanup);
  await h.invoke();
  assert.equal(h.report.cleanup.retainedMarker, 'keep-original-cleanup');
  assert.deepEqual(JSON.parse(JSON.stringify(h.report.cleanup.closeRequestObservation)), { state: 'rejected', message: 'Inspector target closed during normal exit' });
  assert.equal(h.report.cleanup.normalClose, true);
  assert.deepEqual(h.calls, ['native-close-request', 'native-absence', 'playwright-close']);
});

test('Playwright cleanup acknowledgement is also bounded after native absence', async t => {
  const h = await closeHarness({ playwright: 'pending' }); t.after(h.cleanup);
  const result = await outcomeWithin(h.invoke());
  assert.equal(result.state, 'rejected'); assert.equal(h.report.cleanup.normalClose, false);
  assert.equal((h.report.cleanup.playwrightCloseObservation as { state?: string } | undefined)?.state, 'timed-out');
  assert.deepEqual(h.calls, ['native-close-request', 'native-absence', 'playwright-close']);
});

test('Playwright rejection is retained without losing inspector acknowledgement', async t => {
  const h = await closeHarness({ playwright: 'rejected' }); t.after(h.cleanup);
  await h.invoke();
  assert.deepEqual(h.report.cleanup.closeRequestObservation, { state: 'acknowledged' });
  assert.deepEqual(JSON.parse(JSON.stringify(h.report.cleanup.playwrightCloseObservation)), { state: 'rejected', message: 'Playwright target already closed' });
  assert.equal(h.report.cleanup.forcedKill, false);
});

test('native presence prevents Playwright close from being called', async t => {
  const h = await closeHarness({ nativeAbsent: false }); t.after(h.cleanup);
  await assert.rejects(h.invoke(), /Native application still present/);
  assert.equal(h.report.cleanup.normalClose, false); assert.equal(h.calls.includes('playwright-close'), false);
});

test('controls close fails boundedly rather than treating an unacknowledged inspector request as success', async t => {
  const h = await controlsCloseHarness({ inspector: 'pending' }); t.after(h.cleanup);
  assert.equal((await outcomeWithin(h.invoke())).state, 'rejected');
  const record = h.report.nativeCloses[0]; assert.equal(record.closeRequest?.state, 'timed-out'); assert.equal(record.normalClose, false);
  assert.equal(h.calls.includes('playwright-close'), false);
});

test('controls close retains redacted inspector rejection only after native proof', async t => {
  const h = await controlsCloseHarness({ inspector: 'rejected' }); t.after(h.cleanup);
  await h.invoke();
  const record = h.report.nativeCloses[0];
  assert.equal(record.closeRequest?.state, 'rejected'); assert.match(record.closeRequest?.message, /\[REDACTED\]/);
  assert.doesNotMatch(record.closeRequest?.message, /synthetic-test-only/); assert.equal(record.normalClose, true);
  assert.equal(h.context.app, undefined);
  assert.ok(h.calls.indexOf('playwright-close') > h.calls.indexOf('native-application-absence'));
});

test('controls Playwright cleanup has its own deadline after confirmed native absence', async t => {
  const h = await controlsCloseHarness({ playwright: 'pending' }); t.after(h.cleanup);
  assert.equal((await outcomeWithin(h.invoke())).state, 'rejected');
  const record = h.report.nativeCloses[0]; assert.equal(record.playwrightCloseObservation?.state, 'timed-out'); assert.equal(record.normalClose, false);
  assert.ok(h.calls.indexOf('playwright-close') > h.calls.indexOf('native-application-absence'));
});

test('controls preserves failure semantics and redacted evidence for Playwright cleanup rejection', async t => {
  const h = await controlsCloseHarness({ playwright: 'rejected' }); t.after(h.cleanup);
  await assert.rejects(h.invoke(), /Playwright closed/);
  const record = h.report.nativeCloses[0]; assert.equal(record.playwrightCloseObservation?.state, 'rejected'); assert.equal(record.normalClose, false);
  assert.match(record.playwrightCloseObservation?.message, /\[REDACTED\]/); assert.doesNotMatch(record.playwrightCloseObservation?.message, /synthetic-test-only/);
});

test('controls cannot call Playwright cleanup while native main absence is unconfirmed', async t => {
  const h = await controlsCloseHarness({ nativeAbsent: false }); t.after(h.cleanup);
  await assert.rejects(h.invoke(), /Native main still present/);
  assert.equal(h.calls.includes('playwright-close'), false);
});

test('missing-tools retains inspector rejection even if the native exit wait subsequently times out', async t => {
  const h = await closeHarness({ nativeExit: false, inspector: 'rejected' }); t.after(h.cleanup);
  await assert.rejects(h.invoke(), /Normal application close exceeded/);
  assert.equal((h.report.cleanup.closeRequestObservation as { state?: string } | undefined)?.state, 'rejected');
  assert.equal(h.report.cleanup.normalClose, false); assert.equal(h.report.cleanup.needsHumanClose, true);
  assert.equal(h.calls.includes('playwright-close'), false);
});

test('controls retains inspector rejection even without a native exit record', async t => {
  const h = await controlsCloseHarness({ nativeExit: false, inspector: 'rejected' }); t.after(h.cleanup);
  await assert.rejects(h.invoke(), /confirmed launcher exit within/);
  assert.equal(h.report.closeRequestObservations?.[0]?.observation?.state, 'rejected');
  assert.doesNotMatch(h.report.closeRequestObservations?.[0]?.observation?.message ?? '', /synthetic-test-only/);
  assert.equal(h.calls.includes('playwright-close'), false);
});
