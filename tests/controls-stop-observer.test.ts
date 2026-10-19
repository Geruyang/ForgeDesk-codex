import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { assertControlsStopReceipt, installControlsStopObserver, readControlsStopObserver, restoreControlsStopObserver } from './helpers/controls-stop-observer';

function fixture(original: (...args: any[]) => any, version = '44.7.2') {
  const map = new Map<string, any>([['forgedesk:invoke', original]]);
  const electron = { ipcMain: { _invokeHandlers: map } }; const options = { sessionId: 'owned-session' };
  const context = createContext({ electron, options, process: { versions: { electron: version } }, Map, Error });
  const evaluate = (fn: Function) => runInContext(`(${fn.toString()})(electron,options)`, context);
  return { map, original, context, evaluate, options };
}

test('serialized Stop observer preserves original method, args, this, return and error; ignores non-target payloads', async () => {
  const returned = { receipt: 'original-result' }; const rejected = new Error('original failure'); const calls: any[] = [];
  const f = fixture(function (this: unknown, ...args: any[]) { calls.push({ context: this, args }); if (args[1] === 'reject') throw rejected; return returned; });
  f.evaluate(installControlsStopObserver);
  const wrapper = f.map.get('forgedesk:invoke'); const context = { fixture: 'original-this' }; const event = { sender: 'fixture' }; const args = ['owned-session'];
  assert.equal(await wrapper.call(context, event, 'interrupt', args), returned);
  assert.equal(calls[0].context, context); assert.equal(calls[0].args[0], event); assert.equal(calls[0].args[1], 'interrupt'); assert.equal(calls[0].args[2], args);
  assert.equal(await wrapper(event, 'interrupt', ['foreign-session']), returned); assert.equal(await wrapper(event, 'send', ['owned-session', 'private-payload']), returned);
  await assert.rejects(wrapper(event, 'reject', ['owned-session']), error => error === rejected);
  const receipt = f.evaluate(readControlsStopObserver); assertControlsStopReceipt(receipt);
  assert.equal(JSON.stringify(receipt).includes('private-payload'), false); assert.equal(receipt.calls.length, 1);
  assert.equal(f.evaluate(restoreControlsStopObserver).restored, true); assert.equal(f.map.get('forgedesk:invoke'), f.original);
});

test('serialized Stop observer distinguishes pending original Promise from early public terminal state', async () => {
  let resolve!: (value: object) => void; const result = { original: true };
  const f = fixture(() => new Promise<object>(done => { resolve = done; })); f.evaluate(installControlsStopObserver);
  const pending = f.map.get('forgedesk:invoke')({}, 'interrupt', ['owned-session']);
  assert.equal(f.evaluate(readControlsStopObserver).calls[0].phase, 'started');
  assert.throws(() => assertControlsStopReceipt(f.evaluate(readControlsStopObserver)), /has not fulfilled/);
  assert.throws(() => f.evaluate(restoreControlsStopObserver), /remains pending/);
  resolve(result); assert.equal(await pending, result); assertControlsStopReceipt(f.evaluate(readControlsStopObserver)); f.evaluate(restoreControlsStopObserver);
});

test('serialized Stop observer rethrows the exact target rejection and rejects duplicate receipts without blocking original calls', async () => {
  const rejected = new Error('real target rejection'); let calls = 0;
  const f = fixture(() => { calls++; throw rejected; }); f.evaluate(installControlsStopObserver);
  await assert.rejects(f.map.get('forgedesk:invoke')({}, 'interrupt', ['owned-session']), error => error === rejected);
  assert.throws(() => assertControlsStopReceipt(f.evaluate(readControlsStopObserver)), /real target rejection/);
  await assert.rejects(f.map.get('forgedesk:invoke')({}, 'interrupt', ['owned-session']), error => error === rejected);
  assert.equal(calls, 2); assert.throws(() => assertControlsStopReceipt(f.evaluate(readControlsStopObserver)), /Exactly one/); f.evaluate(restoreControlsStopObserver);
});

test('serialized Stop observer fails closed on version, Map, handler, duplicate installation and handler mutation', async () => {
  const badVersion = fixture(() => {}, '44.7.3'); assert.throws(() => badVersion.evaluate(installControlsStopObserver), /exactly Electron/);
  const missingMap = fixture(() => {}); (missingMap.context.electron as any).ipcMain._invokeHandlers = {}; assert.throws(() => missingMap.evaluate(installControlsStopObserver), /Map/);
  const missingHandler = fixture(() => {}); missingHandler.map.delete('forgedesk:invoke'); assert.throws(() => missingHandler.evaluate(installControlsStopObserver), /Original ForgeDesk/);
  const f = fixture(() => {}); f.evaluate(installControlsStopObserver); assert.throws(() => f.evaluate(installControlsStopObserver), /already installed/);
  await f.map.get('forgedesk:invoke')({}, 'interrupt', ['owned-session', 'extra']); assert.throws(() => assertControlsStopReceipt(f.evaluate(readControlsStopObserver)), /only the target session ID/);
  const foreign = () => {}; f.map.set('forgedesk:invoke', foreign);
  assert.throws(() => f.evaluate(readControlsStopObserver), /handler changed/); assert.throws(() => f.evaluate(restoreControlsStopObserver), /not restored/); assert.equal(f.map.get('forgedesk:invoke'), foreign);
});
