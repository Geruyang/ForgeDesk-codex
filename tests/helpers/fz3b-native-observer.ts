import assert from 'node:assert/strict';

export interface Fz3bNativeReceipt {
  runId: string; mechanism: string;
  calls: Array<{ kind: 'approval' | 'close-warning'; phase: 'started' | 'fulfilled' | 'rejected'; startedAt: string; finishedAt?: string;
    options: { type: string; title?: string; message: string; detail?: string; buttons?: string[]; checkboxLabel?: string; checkboxChecked?: boolean };
    response?: number; checkboxChecked?: boolean; error?: string }>;
}

// Serialized by Playwright into main. It forwards the actual native API without deciding or closing a dialog.
export function installFz3bNativeObserver({ dialog }: { dialog: unknown }, { runId }: { runId: string }) {
  if (!/^fz3b-installed-\d{13}-[a-f0-9]{6}$/.test(runId)) throw new Error('Invalid FZ3B observer run');
  const target = dialog as any, host = globalThis as any;
  if (typeof target.showMessageBox !== 'function' || host.__forgedeskFz3bObserver) throw new Error('Native message-box observer unavailable or already installed');
  const state: any = { runId, target, original: target.showMessageBox, calls: [] };
  state.wrapper = async function (this: unknown, ...args: any[]) {
    const options = args.length === 1 ? args[0] : args[1];
    const kind = options?.title === 'ForgeDesk Zynq 单图语义授权' ? 'approval' :
      options?.type === 'warning' && ['工程验证正在运行，请等待完成后退出。', '设备进程退出未确认，不能直接退出。请先复核设备操作状态。'].includes(options.message) ? 'close-warning' : undefined;
    const call: any = kind ? { kind, phase: 'started', startedAt: new Date().toISOString(), options: {
      type: options.type, title: options.title, message: options.message, detail: options.detail,
      buttons: options.buttons ? [...options.buttons] : undefined, checkboxLabel: options.checkboxLabel, checkboxChecked: options.checkboxChecked } } : undefined;
    if (call) state.calls.push(call);
    try {
      const result: any = await Reflect.apply(state.original, this, args);
      if (call) { call.phase = 'fulfilled'; call.finishedAt = new Date().toISOString(); call.response = result.response; call.checkboxChecked = result.checkboxChecked; }
      return result;
    } catch (error) {
      if (call) { call.phase = 'rejected'; call.finishedAt = new Date().toISOString(); call.error = String(error).slice(0, 2000); }
      throw error;
    }
  };
  target.showMessageBox = state.wrapper; host.__forgedeskFz3bObserver = state;
  return { runId, mechanism: 'Original native showMessageBox pass-through observer; no generated answer', installed: true };
}
export function readFz3bNativeObserver({ dialog }: { dialog: unknown }, { runId }: { runId: string }): Fz3bNativeReceipt {
  const state = (globalThis as any).__forgedeskFz3bObserver, target = dialog as any;
  if (!state || state.runId !== runId || state.target !== target || target.showMessageBox !== state.wrapper) throw new Error('FZ3B native observer changed');
  return { runId, mechanism: 'Original native showMessageBox pass-through observer; no generated answer',
    calls: state.calls.map((call: any) => ({ ...call, options: { ...call.options } })) };
}
export function restoreFz3bNativeObserver({ dialog }: { dialog: unknown }, { runId }: { runId: string }) {
  const host = globalThis as any, state = host.__forgedeskFz3bObserver, target = dialog as any;
  if (!state || state.runId !== runId || state.target !== target || target.showMessageBox !== state.wrapper) throw new Error('FZ3B native observer changed');
  if (state.calls.some((call: any) => call.phase === 'started')) throw new Error('Native UI still awaits its actual operator');
  target.showMessageBox = state.original; delete host.__forgedeskFz3bObserver; return { restored: true, runId };
}
export function assertFz3bNativeReceipt(receipt: Fz3bNativeReceipt, detailPins: string[]) {
  assert.equal(receipt.calls.length, 2, 'Exactly one real active close warning and one real approval');
  const warnings = receipt.calls.filter(call => call.kind === 'close-warning'), approvals = receipt.calls.filter(call => call.kind === 'approval');
  assert.equal(warnings.length, 1); assert.equal(approvals.length, 1);
  for (const call of receipt.calls) { assert.equal(call.phase, 'fulfilled'); assert.ok(Number.isFinite(Date.parse(call.finishedAt!)) && Date.parse(call.finishedAt!) >= Date.parse(call.startedAt)); assert.ok(Number.isInteger(call.response)); }
  const approval = approvals[0]; assert.equal(approval.response, 1); assert.equal(approval.checkboxChecked, true);
  assert.equal(warnings[0].options.type, 'warning');
  assert.ok(['工程验证正在运行，请等待完成后退出。', '设备进程退出未确认，不能直接退出。请先复核设备操作状态。'].includes(warnings[0].options.message));
  assert.equal(approval.options.type, 'warning'); assert.equal(approval.options.title, 'ForgeDesk Zynq 单图语义授权');
  assert.equal(approval.options.checkboxChecked, false); assert.ok(approval.options.checkboxLabel); assert.deepEqual(approval.options.buttons, ['取消', '授权本次固定测试']);
  assert.ok(Date.parse(warnings[0].finishedAt!) <= Date.parse(approval.startedAt), 'Acknowledge the first real warning before semantic approval opens');
  for (const pin of detailPins) assert.ok(approval.options.detail?.includes(pin), `Native approval did not show ${pin}`);
}
