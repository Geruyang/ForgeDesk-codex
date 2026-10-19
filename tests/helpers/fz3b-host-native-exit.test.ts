import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import type { ElectronApplication } from 'playwright';
import type { SnapshotInstalledLaunch } from './snapshot-installed-lifecycle';
import type { DesktopIdentity } from './snapshot-smoke-scope';
import { observeFz3bHostMaintenanceExit } from './fz3b-host-native-exit';
import { FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX, installFz3bHostFinalizationIpcObserver } from './fz3b-host-finalization-ipc-observer';

const RUN = 'original-run';
function fixture(timeout = 50) {
  const emitter = new EventEmitter(), child = Object.assign(new EventEmitter(), { pid: 10, exitCode: null, signalCode: null });
  let cleanup = 0, samples = 0;
  const native = { id: 20, created: '2026-10-17T00:00:00Z' };
  const identity = { sid: 'synthetic-SID', sessionId: 1, applications: [] } as unknown as DesktopIdentity;
  const app = Object.assign(emitter, { process: () => child, close: async () => { assert.equal(samples, 2); cleanup++; } }) as unknown as ElectronApplication;
  const launch = { launcherPid: 10, nativeMain: native, electronMain: { pid: 20 }, desktopIdentity: identity } as SnapshotInstalledLaunch;
  const reads = { identity: async () => identity, nativeMain: async () => { samples++; return null; } };
  const observer = observeFz3bHostMaintenanceExit(app, launch, RUN, reads, timeout);
  const receipt = { mechanism: 'test-only exact-run original forgedesk:invoke pass-through observer', electronVersion: '44.7.2',
    purpose: 'maintenance-exit', runId: RUN, calls: [{ phase: 'fulfilled', argumentsValid: true, argumentCount: 1, startedAt: 1, finishedAt: 2 }] };
  const emit = (value = receipt) => emitter.emit('console', { text: () => FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX + JSON.stringify(value) });
  return { child, emitter, observer, receipt, emit, counts: () => ({ cleanup, samples }), reads, native, identity };
}

test('maintenance needs actual original terminal plus launcher close and two independent native absence reads', async () => {
  const f = fixture(); f.emit(); f.child.emit('close', 0, null);
  const result = await f.observer.result;
  assert.equal(result.launcherExitCode, 0); assert.equal(result.normalClose, true); assert.equal(result.forcedKill, false);
  assert.deepEqual(f.counts(), { cleanup: 1, samples: 2 });
});

test('launcher close alone cannot manufacture the original IPC terminal receipt', async () => {
  const f = fixture(5); f.child.emit('close', 0, null);
  await assert.rejects(f.observer.result, /exact original maintenance call must be observed/); assert.equal(f.counts().cleanup, 0);
});

test('self-exit after an exact original started receipt records terminal unobserved, never invented fulfilled', async () => {
  const f = fixture(), receipt = structuredClone(f.receipt);
  receipt.calls[0].phase = 'started'; delete (receipt.calls[0] as any).finishedAt;
  f.emit(receipt); f.child.emit('close', 0, null);
  const result = await f.observer.result;
  assert.equal(result.originalIpcTerminalObserved, false); assert.equal(result.originalIpc.calls[0].phase, 'started');
  assert.equal(result.normalClose, true);
});

test('cancelled local action may fulfill but without actual native exit remains failed and protected', async () => {
  const f = fixture(5); f.emit();
  await assert.rejects(f.observer.result, /not both observed/); assert.deepEqual(f.counts(), { cleanup: 0, samples: 0 });
});

test('pending/rejected/foreign/duplicate console receipts never count as maintenance success', async () => {
  for (const mode of ['pending', 'rejected', 'foreign', 'duplicate']) {
    const f = fixture(5), receipt = structuredClone(f.receipt);
    if (mode === 'pending') { receipt.calls[0].phase = 'started'; }
    if (mode === 'rejected') { receipt.calls[0].phase = 'rejected'; }
    if (mode === 'foreign') receipt.runId = 'foreign';
    f.emit(receipt); if (mode === 'duplicate') f.emit(receipt); f.child.emit('close', 0, null);
    await assert.rejects(f.observer.result); assert.equal(f.counts().cleanup, 0);
  }
});

test('signal/nonzero exit or a surviving original native PID cannot pass dispatcher cleanup', async () => {
  for (const mode of ['signal', 'nonzero', 'surviving']) {
    const f = fixture(); f.emit();
    if (mode === 'surviving') f.reads.nativeMain = async () => f.native as any;
    f.child.emit('close', mode === 'nonzero' ? 1 : 0, mode === 'signal' ? 'SIGTERM' : null);
    await assert.rejects(f.observer.result); assert.equal(f.counts().cleanup, 0);
  }
});

test('actual maintenance handler source covers synchronous quit, quit microtask and later exit without requiring destroyed renderer reads', async () => {
  const source = readFileSync('apps/desktop/main/index.ts', 'utf8'), ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let method: ts.MethodDeclaration | undefined;
  const find = (node: ts.Node) => { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'fz3bMaintenanceExit') method = node; ts.forEachChild(node, find); };
  find(ast); assert.ok(method);
  const code = ts.transpileModule(`globalThis.maintenanceHandler = ${method.getText(ast).replace(/^async fz3bMaintenanceExit/, 'async function')};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const timing of ['sync', 'microtask', 'later'] as const) {
    const f = fixture(1000), events: string[] = []; let exited = false;
    const proof = { completion: { owner: { runId: RUN } }, targetSha256: 'b'.repeat(64) };
    const context = createContext({
      ensureWritable() {}, checkedText: (value: unknown) => value, fz3bUnavailableHold: false, fz3bHostStartupReadOnly: false, fz3bHostActionRunId: undefined,
      fz3bAgent: { requiresHostCompletion: () => true, prepareHostMaintenanceExit: async () => proof,
        assertRecoveryOwner: async () => {}, assertHostLocalProof() {}, engineState: 'stopped' },
      publish() {}, randomBytes: () => Buffer.alloc(32, 1), fz3bCanonicalJson: JSON.stringify,
      nativeApproval: async (_signal: unknown, _expiry: unknown, show: () => Promise<boolean>) => show(),
      requestNativeFz3bHostLocalAction: async (value: any) => { assert.equal(Date.parse(value.expiresAt) - Date.parse(value.createdAt), 300000); return true; },
      nativeWindow() {}, dialog: {}, nativeDialogs: { busy: false, close: () => events.push('dialogs-close') },
      bridge: { close: async () => {} }, embedded: { close: async () => {} }, runner: { close: async () => {} },
      assertRunnerLifecycleOwner() {}, dataDir: 'synthetic-only', engine: { state: 'stopped' }, hardwareEngine: undefined,
      closing: false, evidenceTimer: undefined, window: { destroy: () => events.push('destroy') },
      app: { quit: () => {
        events.push('quit'); const exit = () => { exited = true; f.child.emit('close', 0, null); };
        if (timing === 'sync') exit(); else if (timing === 'microtask') queueMicrotask(exit); else setImmediate(exit);
      } },
      process: { versions: { electron: '44.7.2' } }, Map, Error,
      console: { log: (text: string) => { if (!exited) f.emitter.emit('console', { text: () => text }); } },
    });
    runInContext(code, context);
    const map = new Map([['forgedesk:invoke', (_event: unknown, _method: string, args: string[]) => (context as any).maintenanceHandler(args[0])]]);
    (context as any).electron = { ipcMain: { _invokeHandlers: map } }; (context as any).options = { runId: RUN, purpose: 'maintenance-exit' };
    runInContext(`(${installFz3bHostFinalizationIpcObserver.toString()})(electron,options)`, context);
    await map.get('forgedesk:invoke')!({}, 'fz3bMaintenanceExit', [RUN]);
    const result = await f.observer.result;
    assert.deepEqual(events, ['dialogs-close', 'destroy', 'quit']);
    assert.equal(result.originalIpcTerminalObserved, timing === 'later');
    assert.equal(result.originalIpc.calls[0].phase, timing === 'later' ? 'fulfilled' : 'started');
    assert.equal(result.normalClose, true);
  }
});
