import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { FZ3B_HOST_FINAL_CANDIDATE, FZ3B_HOST_FINAL_SUPERSEDES } from './fz3b-host-finalization-installed';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(installError?: Error) {
  const source = ts.createSourceFile('smoke.ts', readFileSync('tests/fz3b-host-finalization-installed-smoke.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  let declaration: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'launch') declaration = node; ts.forEachChild(node, find); };
  find(source); assert.ok(declaration?.initializer);
  const transformed = ts.transform(declaration.initializer, [context => {
    const visit: ts.Visitor = node => ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      ? context.factory.createCallExpression(context.factory.createPropertyAccessExpression(context.factory.createIdentifier('Promise'), 'resolve'), undefined,
        [context.factory.createObjectLiteralExpression([context.factory.createPropertyAssignment('_electron', context.factory.createIdentifier('fakeElectron'))])])
      : ts.visitEachChild(node, visit, context);
    return node => ts.visitNode(node, visit) as ts.Expression;
  }]);
  const body = ts.createPrinter().printNode(ts.EmitHint.Expression, transformed.transformed[0], source); transformed.dispose();
  const compiled = ts.transpileModule(`const launch = ${body}; launch;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls: string[] = [], window = deferred<any>(), sidebar = deferred<void>(), sidebarEntered = deferred<void>();
  const marker = () => {}, state = { version: '0.5.5', dataDir: 'fixed-data', fz3bAgent: { available: true } };
  const page = { locator: (selector: string) => { assert.equal(selector, '.sidebar'); return { waitFor: async (options: unknown) => {
    assert.deepEqual(JSON.parse(JSON.stringify(options)), { state: 'visible', timeout: 30000 }); calls.push('sidebar-wait'); sidebarEntered.resolve(); await sidebar.promise; calls.push('sidebar-visible');
  } }; } };
  const app = {
    firstWindow: async () => { calls.push('first-window'); return window.promise; },
    evaluate: async (fn: unknown, args: unknown) => {
      assert.equal(fn, marker); assert.deepEqual(JSON.parse(JSON.stringify(args)), { runId: 'fixed-controller-run', purpose: 'finish' });
      assert.ok(calls.includes('sidebar-visible'), 'No observer install before actual renderer readiness');
      calls.push('observer'); if (installError) throw installError;
    },
  };
  const lifecycle = () => ({ beforeLaunch: async () => { calls.push('before-launch'); },
    attach: async (value: unknown) => { assert.equal(value, app); calls.push('identity-attached'); return { nativeMain: { created: 'synthetic-created' } }; } });
  const initialLifecycle = lifecycle();
  const context: Record<string, any> = {
    assert, process: { env: {} }, app: undefined, page: undefined, ipcObserverInstalled: false, ipcPurpose: 'finish',
    root: 'fixed-root',
    readDesktopIdentity: async () => ({ sid: 'fixed-sid' }), primarySid: 'fixed-sid',
    lifecycle: initialLifecycle,
    prepareSnapshotInstalledLifecycle: async (root: string, executable: string) => {
      assert.equal(root, 'fixed-root'); assert.equal(executable, 'fixed-installed'); calls.push('prepare-fresh-lifecycle'); return lifecycle();
    },
    fakeElectron: { launch: async () => { calls.push('launch'); return app; } },
    plan: { installedExe: 'fixed-installed', dataDir: 'fixed-data', targetRunId: 'fixed-controller-run', version: '0.5.5' }, report: { launches: [] },
    fz3bHostFinalLaunchEnvironment: () => ({}), installFz3bHostFinalizationIpcObserver: marker,
    snapshot: async () => { assert.equal(context.ipcObserverInstalled, true); calls.push('snapshot'); return state; }, samePath: (a: string, b: string) => a === b,
  };
  const launch = runInNewContext(compiled, context) as (index: number) => Promise<unknown>;
  return { launch, calls, context, page, window, sidebar, sidebarEntered, state, initialLifecycle };
}

test('actual smoke launch waits first window and visible sidebar before observer, then reads its first snapshot', async () => {
  const f = fixture(), request = f.launch(1);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.includes('observer'), false); assert.equal(f.calls.includes('snapshot'), false);
  f.window.resolve(f.page); await f.sidebarEntered.promise;
  assert.equal(f.calls.includes('observer'), false); assert.equal(f.calls.includes('snapshot'), false);
  f.sidebar.resolve(); assert.deepEqual(await request, f.state);
  assert.equal(f.context.ipcPurpose, 'finish');
  assert.deepEqual(f.calls, ['before-launch', 'launch', 'identity-attached', 'first-window', 'sidebar-wait', 'sidebar-visible', 'observer', 'snapshot']);
});

test('renderer readiness rejection never installs an observer or reads a snapshot', async () => {
  const f = fixture(), request = f.launch(1), failure = new Error('Synthetic sidebar wait failed');
  f.window.resolve(f.page); await f.sidebarEntered.promise; f.sidebar.reject(failure);
  await assert.rejects(request, error => error === failure);
  assert.equal(f.calls.includes('observer'), false); assert.equal(f.calls.includes('snapshot'), false); assert.equal(f.context.ipcObserverInstalled, false);
});

test('missing original handler after renderer readiness still fails closed without retry or synthetic registration', async () => {
  const failure = new Error('Original ForgeDesk invoke handler is unavailable'), f = fixture(failure), request = f.launch(2);
  f.window.resolve(f.page); await f.sidebarEntered.promise; f.sidebar.resolve(); await assert.rejects(request, error => error === failure);
  assert.equal(f.calls.filter(call => call === 'prepare-fresh-lifecycle').length, 1);
  assert.notEqual(f.context.lifecycle, f.initialLifecycle);
  assert.equal(f.calls.filter(call => call === 'observer').length, 1); assert.equal(f.calls.includes('snapshot'), false); assert.equal(f.context.ipcObserverInstalled, false);
});

test('0.5.5 three-launch fixture pins its dedicated immutable manifest and exact reviewed predecessor', () => {
  assert.equal(FZ3B_HOST_FINAL_CANDIDATE, 'output/qa/2026-10-17-fz3b-recovery/nextphase-qa/revision-0.5.5/release-candidate-0.5.5.json');
  assert.equal(FZ3B_HOST_FINAL_SUPERSEDES, '669aa82bbaf8df5bab12f84f5baaf026a9b67010ebb1e0365da749f9973c1f79');
});
