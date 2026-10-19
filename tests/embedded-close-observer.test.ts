import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { assertEmbeddedCloseWarning, installEmbeddedCloseObserver, readEmbeddedCloseObserver, restoreEmbeddedCloseObserver } from './helpers/embedded-close-observer';

const run = { runId: 't2-1792000000000-abcd' };
function fixture(original: (...args: any[]) => Promise<any>) {
  const dialog = { showMessageBox: original };
  const context = vm.createContext({ process: { versions: { electron: 'fixture-only' } } });
  return { dialog, install: (input = run) => vm.runInContext(`(${installEmbeddedCloseObserver.toString()})`, context)({ dialog }, input),
    read: () => vm.runInContext(`(${readEmbeddedCloseObserver.toString()})`, context)({ dialog }, run),
    restore: () => vm.runInContext(`(${restoreEmbeddedCloseObserver.toString()})`, context)({ dialog }, run) };
}
const warning = { type: 'warning', message: '工程验证正在运行，请等待完成后退出。' };
test('T2 close observer is self-contained, preserves original native arguments/this/result and never decides authorization', async () => {
  const received: any[] = []; const response = { response: 0, checkboxChecked: false }; let receiver: unknown;
  const original = async function (this: unknown, ...args: any[]) { receiver = this; received.push(args); return response; };
  const h = fixture(original); h.install(); const window = { fixture: 'window' };
  const approval = { type: 'warning', message: '允许将这份固件写入指定挑战者 V1 板卡？', detail: 'not recorded', checkboxChecked: false };
  assert.equal(await h.dialog.showMessageBox(window, approval), response); assert.equal(h.read().calls.length, 0);
  assert.equal(await h.dialog.showMessageBox(window, warning), response); assert.equal(receiver, h.dialog); assert.equal(received[1][0], window); assert.equal(received[1][1], warning);
  const receipt = JSON.parse(JSON.stringify(h.read())); assertEmbeddedCloseWarning(receipt); assert.equal(JSON.stringify(receipt).includes('not recorded'), false);
  h.restore(); assert.equal(h.dialog.showMessageBox, original);
});
test('T2 observer preserves a pending human decision and rethrows original native failure without fabricating success', async () => {
  let release!: () => void; const error = new Error('fixture native dialog error');
  const h = fixture(async () => { await new Promise<void>(resolve => { release = resolve; }); throw error; }); h.install();
  const pending = h.dialog.showMessageBox(warning); assert.equal(h.read().calls[0].phase, 'started'); assert.throws(() => h.restore(), /pending/); release();
  await assert.rejects(pending, value => value === error); assert.equal(h.read().calls[0].phase, 'rejected'); assert.throws(() => assertEmbeddedCloseWarning(h.read())); h.restore();
});
test('T2 close observer rejects duplicate warnings, changed hook and duplicate installation', async () => {
  const h = fixture(async () => ({ response: 0 })); h.install(); assert.throws(() => h.install(), /already/);
  await h.dialog.showMessageBox(warning); await h.dialog.showMessageBox(warning); assert.throws(() => assertEmbeddedCloseWarning(h.read()), /Exactly one/);
  h.dialog.showMessageBox = async () => ({ response: 1 }); assert.throws(() => h.restore(), /changed/);
});
