import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertFz3bPreflightNativeReceipt, installFz3bPreflightNativeObserver, readFz3bPreflightNativeObserver,
  restoreFz3bPreflightNativeObserver,
} from './fz3b-preflight-native-observer';

const owner = { runId: 'fz3b-preflight-1792222993309-abcdef', targetRunId: '07427a29-0eae-44c7-ac35-34d6650eebee',
  targetOperationId: 'c6a3e027-abd8-40f7-b64e-d1b8e1a4620b' };
const options = { type: 'warning', title: 'ForgeDesk FZ3B 本地预检拒绝恢复', message: '仅用已封存的本地证据释放这一次预检拒绝的检查占用？',
  detail: `任务 task\n原检查 ${owner.targetOperationId}\n不连接 SSH，不重试原检查，不授权新 Boot。原 unknown 记录保留。运行 ${owner.targetRunId}`,
  buttons: ['取消', '校验本地证据并释放本次占用'], defaultId: 0, cancelId: 0,
  checkboxLabel: '原 unknown 保留且不授权新 Boot', checkboxChecked: false };

test('phase3 observer forwards original native call and only records exact local-recovery confirmation', async () => {
  const expected = { response: 1, checkboxChecked: true }; const calls: unknown[][] = [];
  const dialog = { async showMessageBox(...args: unknown[]) { calls.push(args); return expected; } };
  const original = dialog.showMessageBox;
  assert.deepEqual(installFz3bPreflightNativeObserver({ dialog }, owner), { ...owner,
    mechanism: 'Original native showMessageBox pass-through observer; no generated answer', installed: true });
  const actual = await dialog.showMessageBox({ id: 'window' }, options);
  assert.equal(actual, expected); assert.equal(calls.length, 1); assert.deepEqual(calls[0], [{ id: 'window' }, options]);
  const receipt = readFz3bPreflightNativeObserver({ dialog }, owner);
  assert.deepEqual(assertFz3bPreflightNativeReceipt(receipt, owner), { realDialogForwarded: true, synthesizedResponse: false,
    nativeDialogCount: 1, targetRunId: owner.targetRunId, targetOperationId: owner.targetOperationId });
  assert.deepEqual(restoreFz3bPreflightNativeObserver({ dialog }, owner), { restored: true, runId: owner.runId });
  assert.equal(dialog.showMessageBox, original);
});

test('phase3 observer refuses replacement, changed ownership and restoration while real native dialog is pending', async () => {
  let finish!: (value: { response: number; checkboxChecked: boolean }) => void;
  const dialog = { showMessageBox: async (..._args: unknown[]) => new Promise<{ response: number; checkboxChecked: boolean }>(resolve => { finish = resolve; }) };
  installFz3bPreflightNativeObserver({ dialog }, owner);
  assert.throws(() => installFz3bPreflightNativeObserver({ dialog }, owner), /already installed/);
  assert.throws(() => readFz3bPreflightNativeObserver({ dialog }, { ...owner, targetRunId: 'foreign' }), /changed/);
  const pending = dialog.showMessageBox({ id: 'window' }, options);
  assert.throws(() => restoreFz3bPreflightNativeObserver({ dialog }, owner), /still awaits/);
  finish({ response: 0, checkboxChecked: false }); await pending;
  assert.throws(() => assertFz3bPreflightNativeReceipt(readFz3bPreflightNativeObserver({ dialog }, owner), owner));
  assert.deepEqual(restoreFz3bPreflightNativeObserver({ dialog }, owner), { restored: true, runId: owner.runId });
});

test('phase3 observer propagates failures and never converts rejection to a successful receipt', async () => {
  const expected = new Error('native API failed'); const dialog = { showMessageBox: async (..._args: unknown[]) => { throw expected; } };
  installFz3bPreflightNativeObserver({ dialog }, owner);
  await assert.rejects(dialog.showMessageBox({ id: 'window' }, options), error => error === expected);
  const receipt = readFz3bPreflightNativeObserver({ dialog }, owner);
  assert.equal(receipt.calls[0].phase, 'rejected'); assert.throws(() => assertFz3bPreflightNativeReceipt(receipt, owner));
  assert.deepEqual(restoreFz3bPreflightNativeObserver({ dialog }, owner), { restored: true, runId: owner.runId });
});
