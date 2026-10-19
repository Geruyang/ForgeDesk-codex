import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { assertFz3bCancelStopReceipt, installFz3bCancelStopObserver, readFz3bCancelStopObserver, restoreFz3bCancelStopObserver } from './helpers/fz3b-cancel-stop-observer';

function fixture(original: (...args: any[]) => any, version = '44.7.2') {
  const map = new Map<string, any>([['forgedesk:invoke', original]]);
  const electron = { ipcMain: { _invokeHandlers: map } }; const options = { runId: 'owned-run' };
  const context = createContext({ electron, options, process: { versions: { electron: version } }, Map, Error });
  const evaluate = (fn: Function) => runInContext(`(${fn.toString()})(electron,options)`, context);
  return { map, original, context, evaluate, options };
}

test('serialized Stop observer preserves original method, args, this, return and error; ignores non-target payloads', async () => {
  const returned = { receipt: 'original-result' }; const rejected = new Error('original failure'); const calls: any[] = [];
  const f = fixture(function (this: unknown, ...args: any[]) { calls.push({ context: this, args }); if (args[1] === 'reject') throw rejected; return returned; });
  f.evaluate(installFz3bCancelStopObserver);
  const wrapper = f.map.get('forgedesk:invoke'); const context = { fixture: 'original-this' }; const event = { sender: 'fixture' }; const args = ['owned-run'];
  assert.equal(await wrapper.call(context, event, 'fz3bAgentStop', args), returned);
  assert.equal(calls[0].context, context); assert.equal(calls[0].args[0], event); assert.equal(calls[0].args[1], 'fz3bAgentStop'); assert.equal(calls[0].args[2], args);
  assert.equal(await wrapper(event, 'fz3bAgentStop', ['foreign-run']), returned); assert.equal(await wrapper(event, 'send', ['owned-run', 'private-payload']), returned);
  await assert.rejects(wrapper(event, 'reject', ['owned-run']), error => error === rejected);
  const receipt = f.evaluate(readFz3bCancelStopObserver); assertFz3bCancelStopReceipt(receipt);
  assert.equal(JSON.stringify(receipt).includes('private-payload'), false); assert.equal(receipt.calls.length, 1);
  assert.equal(f.evaluate(restoreFz3bCancelStopObserver).restored, true); assert.equal(f.map.get('forgedesk:invoke'), f.original);
});

test('serialized Stop observer distinguishes pending original Promise from early public terminal state', async () => {
  let resolve!: (value: object) => void; const result = { original: true };
  const f = fixture(() => new Promise<object>(done => { resolve = done; })); f.evaluate(installFz3bCancelStopObserver);
  const pending = f.map.get('forgedesk:invoke')({}, 'fz3bAgentStop', ['owned-run']);
  assert.equal(f.evaluate(readFz3bCancelStopObserver).calls[0].phase, 'started');
  assert.throws(() => assertFz3bCancelStopReceipt(f.evaluate(readFz3bCancelStopObserver)), /has not fulfilled/);
  assert.throws(() => f.evaluate(restoreFz3bCancelStopObserver), /remains pending/);
  resolve(result); assert.equal(await pending, result); assertFz3bCancelStopReceipt(f.evaluate(readFz3bCancelStopObserver)); f.evaluate(restoreFz3bCancelStopObserver);
});

test('serialized Stop observer rethrows the exact target rejection and rejects duplicate receipts without blocking original calls', async () => {
  const rejected = new Error('real target rejection'); let calls = 0;
  const f = fixture(() => { calls++; throw rejected; }); f.evaluate(installFz3bCancelStopObserver);
  await assert.rejects(f.map.get('forgedesk:invoke')({}, 'fz3bAgentStop', ['owned-run']), error => error === rejected);
  assert.throws(() => assertFz3bCancelStopReceipt(f.evaluate(readFz3bCancelStopObserver)), /real target rejection/);
  await assert.rejects(f.map.get('forgedesk:invoke')({}, 'fz3bAgentStop', ['owned-run']), error => error === rejected);
  assert.equal(calls, 2); assert.throws(() => assertFz3bCancelStopReceipt(f.evaluate(readFz3bCancelStopObserver)), /Exactly one/); f.evaluate(restoreFz3bCancelStopObserver);
});

test('serialized Stop observer fails closed on version, Map, handler, duplicate installation and handler mutation', async () => {
  const badVersion = fixture(() => {}, '44.7.3'); assert.throws(() => badVersion.evaluate(installFz3bCancelStopObserver), /exactly Electron/);
  const missingMap = fixture(() => {}); (missingMap.context.electron as any).ipcMain._invokeHandlers = {}; assert.throws(() => missingMap.evaluate(installFz3bCancelStopObserver), /Map/);
  const missingHandler = fixture(() => {}); missingHandler.map.delete('forgedesk:invoke'); assert.throws(() => missingHandler.evaluate(installFz3bCancelStopObserver), /Original ForgeDesk/);
  const f = fixture(() => {}); f.evaluate(installFz3bCancelStopObserver); assert.throws(() => f.evaluate(installFz3bCancelStopObserver), /already installed/);
  await f.map.get('forgedesk:invoke')({}, 'fz3bAgentStop', ['owned-run', 'extra']); assert.throws(() => assertFz3bCancelStopReceipt(f.evaluate(readFz3bCancelStopObserver)), /only the target run ID/);
  const foreign = () => {}; f.map.set('forgedesk:invoke', foreign);
  assert.throws(() => f.evaluate(readFz3bCancelStopObserver), /handler changed/); assert.throws(() => f.evaluate(restoreFz3bCancelStopObserver), /not restored/); assert.equal(f.map.get('forgedesk:invoke'), foreign);
});
