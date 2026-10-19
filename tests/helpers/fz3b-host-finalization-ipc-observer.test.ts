import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { assertFz3bHostFinalizationIpcReceipt, installFz3bHostFinalizationIpcObserver,
  readFz3bHostFinalizationIpcObserver, restoreFz3bHostFinalizationIpcObserver, assertFz3bEmptyHomeReceipt,
  FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX, type Fz3bHostIpcPurpose } from './fz3b-host-finalization-ipc-observer';

const RUN = '07427a29-0eae-44c7-ac35-34d6650eebee';
const METHOD = 'fz3bReconcilePreflightRefusedInspect';
function fixture(original: (...args: any[]) => any, version = '44.7.2', purpose?: Fz3bHostIpcPurpose) {
  const map = new Map<string, any>([['forgedesk:invoke', original]]), electron = { ipcMain: { _invokeHandlers: map } };
  const consoleMessages: string[] = [];
  const options = { runId: RUN, ...(purpose ? { purpose } : {}) }, context = createContext({ electron, options,
    console: { log: (message: string) => consoleMessages.push(message) }, process: { versions: { electron: version } }, Map, Error });
  const evaluate = (fn: Function) => runInContext(`(${fn.toString()})(electron,options)`, context);
  return { map, original, context, evaluate, consoleMessages };
}

test('serialized observer passes through the exact public method unchanged and records only settled call metadata', async () => {
  const result = { runId: RUN, sentinel: 'opaque result is not copied into receipt' }, calls: any[] = [];
  const f = fixture(function (this: unknown, ...args: any[]) { calls.push({ context: this, args }); return result; });
  f.evaluate(installFz3bHostFinalizationIpcObserver);
  const wrapper = f.map.get('forgedesk:invoke'), context = { original: true }, event = { sender: 'fixture' }, args = [RUN];
  assert.equal(await wrapper.call(context, event, METHOD, args), result);
  assert.equal(calls.length, 1); assert.equal(calls[0].context, context); assert.equal(calls[0].args[0], event);
  assert.equal(calls[0].args[1], METHOD); assert.equal(calls[0].args[2], args);
  const receipt = f.evaluate(readFz3bHostFinalizationIpcObserver);
  assertFz3bHostFinalizationIpcReceipt(receipt, 1); assert.equal(JSON.stringify(receipt).includes('sentinel'), false);
  assert.equal(f.evaluate(restoreFz3bHostFinalizationIpcObserver).restored, true); assert.equal(f.map.get('forgedesk:invoke'), f.original);
});

test('quarantine observes only the fixed original API and copies only exact public transaction metadata', async () => {
  const receipt = { schemaVersion: 1, nonce: 'a'.repeat(64), canonicalHomeAbsent: true, preservedEmpty: true, intentSha256: 'b'.repeat(64) };
  const f = fixture(() => receipt, '44.7.2', 'quarantine'); f.evaluate(installFz3bHostFinalizationIpcObserver);
  assert.equal(await f.map.get('forgedesk:invoke')({}, 'fz3bQuarantineEmptyHostHome', [RUN]), receipt);
  const observed = f.evaluate(readFz3bHostFinalizationIpcObserver);
  assertFz3bHostFinalizationIpcReceipt(observed, 1, 'quarantine');
  assert.deepEqual(JSON.parse(JSON.stringify(observed.calls[0].quarantineReceipt)), receipt);
  assert.throws(() => assertFz3bHostFinalizationIpcReceipt(observed, 1), /strictly equal/);
  assert.equal(f.consoleMessages.length, 0);
  f.evaluate(restoreFz3bHostFinalizationIpcObserver);
  for (const value of [null, undefined, { ...receipt, key: 'must-not-be-exported' }, { ...receipt, canonicalHomeAbsent: false }]) {
    const invalid = fixture(() => value, '44.7.2', 'quarantine'); invalid.evaluate(installFz3bHostFinalizationIpcObserver);
    assert.equal(await invalid.map.get('forgedesk:invoke')({}, 'fz3bQuarantineEmptyHostHome', [RUN]), value);
    assert.throws(() => assertFz3bHostFinalizationIpcReceipt(invalid.evaluate(readFz3bHostFinalizationIpcObserver), 1, 'quarantine'));
    assert.equal(JSON.stringify(invalid.evaluate(readFz3bHostFinalizationIpcObserver)).includes('must-not-be-exported'), false);
    invalid.evaluate(restoreFz3bHostFinalizationIpcObserver);
  }
});

test('maintenance emits one real original terminal receipt, never a pending or inferred success', async () => {
  let finish!: () => void;
  const f = fixture(() => new Promise<void>(resolve => { finish = resolve; }), '44.7.2', 'maintenance-exit');
  f.evaluate(installFz3bHostFinalizationIpcObserver);
  const pending = f.map.get('forgedesk:invoke')({}, 'fz3bMaintenanceExit', [RUN]);
  assert.equal(f.consoleMessages.length, 1);
  assert.equal(JSON.parse(f.consoleMessages[0].slice(FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX.length)).calls[0].phase, 'started');
  finish(); await pending;
  assert.equal(f.consoleMessages.length, 2);
  const observed = JSON.parse(f.consoleMessages[1].slice(FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX.length));
  assertFz3bHostFinalizationIpcReceipt(observed, 1, 'maintenance-exit');
  const rejected = new Error('original maintenance failure');
  const g = fixture(() => { throw rejected; }, '44.7.2', 'maintenance-exit'); g.evaluate(installFz3bHostFinalizationIpcObserver);
  await assert.rejects(g.map.get('forgedesk:invoke')({}, 'fz3bMaintenanceExit', [RUN]), error => error === rejected);
  const failed = JSON.parse(g.consoleMessages[1].slice(FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX.length));
  assert.equal(failed.calls[0].phase, 'rejected'); assert.throws(() => assertFz3bHostFinalizationIpcReceipt(failed, 1, 'maintenance-exit'));
});

test('public empty-home receipt is closed and fixed purposes cannot be widened or read as another purpose', () => {
  for (const value of [null, {}, { schemaVersion: 1, nonce: 'a'.repeat(64), canonicalHomeAbsent: true, preservedEmpty: false, intentSha256: 'b'.repeat(64) }]) {
    assert.throws(() => assertFz3bEmptyHomeReceipt(value));
  }
  const f = fixture(() => {}, '44.7.2', 'quarantine'); f.evaluate(installFz3bHostFinalizationIpcObserver);
  (f.context.options as any).purpose = 'finish'; assert.throws(() => f.evaluate(readFz3bHostFinalizationIpcObserver), /identity/);
  (f.context.options as any).purpose = 'arbitrary-method'; assert.throws(() => f.evaluate(restoreFz3bHostFinalizationIpcObserver));
  const bad = fixture(() => {}); (bad.context.options as any).purpose = 'arbitrary-method';
  assert.throws(() => bad.evaluate(installFz3bHostFinalizationIpcObserver), /Unsupported fixed/);
  for (const fn of [installFz3bHostFinalizationIpcObserver, readFz3bHostFinalizationIpcObserver, restoreFz3bHostFinalizationIpcObserver]) {
    assert.equal(fn.toString().includes('__name'), false, 'Serialized observer must not capture tsx module helpers');
  }
});

test('observer preserves pending, rejected, duplicate, foreign-run and extra-argument distinctions', async () => {
  let resolve!: (value: object) => void; const pendingResult = { ok: true };
  const f = fixture(() => new Promise<object>(done => { resolve = done; })); f.evaluate(installFz3bHostFinalizationIpcObserver);
  const pending = f.map.get('forgedesk:invoke')({}, METHOD, [RUN]);
  assert.equal(f.evaluate(readFz3bHostFinalizationIpcObserver).calls[0].phase, 'started');
  assert.throws(() => assertFz3bHostFinalizationIpcReceipt(f.evaluate(readFz3bHostFinalizationIpcObserver), 1), /has not fulfilled/);
  assert.throws(() => f.evaluate(restoreFz3bHostFinalizationIpcObserver), /remains pending/);
  resolve(pendingResult); assert.equal(await pending, pendingResult);
  assertFz3bHostFinalizationIpcReceipt(f.evaluate(readFz3bHostFinalizationIpcObserver), 1);
  f.evaluate(restoreFz3bHostFinalizationIpcObserver);

  const foreign = fixture(() => undefined); foreign.evaluate(installFz3bHostFinalizationIpcObserver);
  await foreign.map.get('forgedesk:invoke')({}, METHOD, ['foreign-run']);
  const foreignReceipt = foreign.evaluate(readFz3bHostFinalizationIpcObserver);
  assert.equal(foreignReceipt.calls.length, 1); assert.equal(foreignReceipt.calls[0].argumentsValid, false);
  assert.throws(() => assertFz3bHostFinalizationIpcReceipt(foreignReceipt, 1), /exact target run ID/);
  foreign.evaluate(restoreFz3bHostFinalizationIpcObserver);

  const rejected = new Error('original rejection');
  const g = fixture(() => { throw rejected; }); g.evaluate(installFz3bHostFinalizationIpcObserver);
  await assert.rejects(g.map.get('forgedesk:invoke')({}, METHOD, [RUN]), error => error === rejected);
  assert.throws(() => assertFz3bHostFinalizationIpcReceipt(g.evaluate(readFz3bHostFinalizationIpcObserver), 1), /Original public finish IPC rejected/);
  await assert.rejects(g.map.get('forgedesk:invoke')({}, METHOD, [RUN, 'extra']), error => error === rejected);
  const invalid = g.evaluate(readFz3bHostFinalizationIpcObserver);
  assert.equal(invalid.calls[1].argumentsValid, false); assert.equal(invalid.calls[1].argumentCount, 2);
  assert.throws(() => assertFz3bHostFinalizationIpcReceipt(invalid, 1), /expected number/);
  g.evaluate(restoreFz3bHostFinalizationIpcObserver);
});

test('observer installation/read/restore fail closed on unsupported Electron or handler mutation', () => {
  const badVersion = fixture(() => {}, '44.7.3'); assert.throws(() => badVersion.evaluate(installFz3bHostFinalizationIpcObserver), /exactly Electron/);
  const missingMap = fixture(() => {}); (missingMap.context.electron as any).ipcMain._invokeHandlers = {};
  assert.throws(() => missingMap.evaluate(installFz3bHostFinalizationIpcObserver), /Map/);
  const missingHandler = fixture(() => {}); missingHandler.map.delete('forgedesk:invoke');
  assert.throws(() => missingHandler.evaluate(installFz3bHostFinalizationIpcObserver), /Original ForgeDesk/);
  const f = fixture(() => {}); f.evaluate(installFz3bHostFinalizationIpcObserver); const foreign = () => {};
  f.map.set('forgedesk:invoke', foreign); assert.throws(() => f.evaluate(readFz3bHostFinalizationIpcObserver), /handler changed/);
  assert.throws(() => f.evaluate(restoreFz3bHostFinalizationIpcObserver), /not restored/); assert.equal(f.map.get('forgedesk:invoke'), foreign);
});
