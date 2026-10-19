import assert from 'node:assert/strict';

export interface Fz3bPreflightNativeCall {
  kind: 'preflight-recovery'; phase: 'started' | 'fulfilled' | 'rejected'; startedAt: string; finishedAt?: string;
  options: { type?: string; title?: string; message?: string; detail?: string; buttons?: string[]; defaultId?: number;
    cancelId?: number; checkboxLabel?: string; checkboxChecked?: boolean };
  response?: number; checkboxChecked?: boolean; error?: string;
}
export interface Fz3bPreflightNativeReceipt {
  runId: string; targetRunId: string; targetOperationId: string;
  mechanism: 'Original native showMessageBox pass-through observer; no generated answer'; calls: Fz3bPreflightNativeCall[];
}
const TITLE = 'ForgeDesk FZ3B 本地预检拒绝恢复';
const RUN_ID = /^fz3b-preflight-\d{13}-[a-f0-9]{6}$/;
const IDENTIFIER = /^[A-Za-z0-9._-]{1,200}$/;
const NAME = '__forgedeskFz3bPhase3Observer';

export function installFz3bPreflightNativeObserver({ dialog }: { dialog: unknown }, owner: { runId: string; targetRunId: string; targetOperationId: string }) {
  if (!/^fz3b-preflight-\d{13}-[a-f0-9]{6}$/.test(owner.runId) || !/^[A-Za-z0-9._-]{1,200}$/.test(owner.targetRunId) ||
      !/^[A-Za-z0-9._-]{1,200}$/.test(owner.targetOperationId)) throw new Error('Invalid phase3 native observer owner');
  const target = dialog as any, host = globalThis as any;
  if (!target || typeof target.showMessageBox !== 'function' || host.__forgedeskFz3bPhase3Observer) throw new Error('Phase3 native observer unavailable or already installed');
  const state: any = { ...owner, target, original: target.showMessageBox, calls: [] };
  state.wrapper = async function (this: unknown, ...args: any[]) {
    const options = args.length === 1 ? args[0] : args[1];
    if (options?.title !== 'ForgeDesk FZ3B 本地预检拒绝恢复') return Reflect.apply(state.original, this, args);
    const call: Fz3bPreflightNativeCall = { kind: 'preflight-recovery', phase: 'started', startedAt: new Date().toISOString(), options: {
      type: options.type, title: options.title, message: options.message, detail: options.detail,
      buttons: options.buttons ? [...options.buttons] : undefined, defaultId: options.defaultId, cancelId: options.cancelId,
      checkboxLabel: options.checkboxLabel, checkboxChecked: options.checkboxChecked } };
    state.calls.push(call);
    try {
      const result: any = await Reflect.apply(state.original, this, args);
      call.phase = 'fulfilled'; call.finishedAt = new Date().toISOString(); call.response = result.response; call.checkboxChecked = result.checkboxChecked;
      return result;
    } catch (error) {
      call.phase = 'rejected'; call.finishedAt = new Date().toISOString(); call.error = String(error).slice(0, 2000); throw error;
    }
  };
  target.showMessageBox = state.wrapper; host.__forgedeskFz3bPhase3Observer = state;
  return { ...owner, mechanism: 'Original native showMessageBox pass-through observer; no generated answer' as const, installed: true };
}

export function readFz3bPreflightNativeObserver({ dialog }: { dialog: unknown }, owner: { runId: string; targetRunId: string; targetOperationId: string }): Fz3bPreflightNativeReceipt {
  const state = (globalThis as any).__forgedeskFz3bPhase3Observer, target = dialog as any;
  if (!state || state.runId !== owner.runId || state.targetRunId !== owner.targetRunId || state.targetOperationId !== owner.targetOperationId ||
      state.target !== target || target.showMessageBox !== state.wrapper) throw new Error('Phase3 native observer changed');
  return { runId: state.runId, targetRunId: state.targetRunId, targetOperationId: state.targetOperationId,
    mechanism: 'Original native showMessageBox pass-through observer; no generated answer',
    calls: state.calls.map((call: Fz3bPreflightNativeCall) => ({ ...call, options: { ...call.options, buttons: call.options.buttons && [...call.options.buttons] } })) };
}

export function restoreFz3bPreflightNativeObserver({ dialog }: { dialog: unknown }, owner: { runId: string; targetRunId: string; targetOperationId: string }) {
  const host = globalThis as any, state = host.__forgedeskFz3bPhase3Observer, target = dialog as any;
  if (!state || state.runId !== owner.runId || state.targetRunId !== owner.targetRunId || state.targetOperationId !== owner.targetOperationId ||
      state.target !== target || target.showMessageBox !== state.wrapper) throw new Error('Phase3 native observer changed');
  if (state.calls.some((call: Fz3bPreflightNativeCall) => call.phase === 'started')) throw new Error('Phase3 native dialog still awaits its actual operator');
  target.showMessageBox = state.original; delete host.__forgedeskFz3bPhase3Observer; return { restored: true, runId: owner.runId };
}

export function assertFz3bPreflightNativeReceipt(receipt: Fz3bPreflightNativeReceipt, owner: { runId: string; targetRunId: string; targetOperationId: string }) {
  assert.equal(receipt.mechanism, 'Original native showMessageBox pass-through observer; no generated answer');
  assert.equal(receipt.runId, owner.runId); assert.equal(receipt.targetRunId, owner.targetRunId); assert.equal(receipt.targetOperationId, owner.targetOperationId);
  assert.equal(receipt.calls.length, 1, 'Exactly one real local-preflight recovery dialog is allowed');
  const [call] = receipt.calls; assert.equal(call.kind, 'preflight-recovery'); assert.equal(call.phase, 'fulfilled');
  assert.equal(call.options.type, 'warning'); assert.equal(call.options.title, TITLE);
  assert.equal(call.options.defaultId, 0); assert.equal(call.options.cancelId, 0); assert.equal(call.options.checkboxChecked, false);
  assert.deepEqual(call.options.buttons, ['取消', '校验本地证据并释放本次占用']);
  assert.ok(call.options.checkboxLabel?.includes('原 unknown 保留') && call.options.checkboxLabel.includes('不授权新 Boot'));
  for (const phrase of ['不连接 SSH', '不重试原检查', '不授权新 Boot', '原 unknown 记录', owner.targetRunId, owner.targetOperationId]) {
    assert.ok(call.options.detail?.includes(phrase), `Native dialog omitted disclosure/pin: ${phrase}`);
  }
  assert.equal(call.response, 1); assert.equal(call.checkboxChecked, true);
  assert.ok(Number.isFinite(Date.parse(call.startedAt)) && Number.isFinite(Date.parse(call.finishedAt!)) && Date.parse(call.finishedAt!) >= Date.parse(call.startedAt));
  return { realDialogForwarded: true, synthesizedResponse: false, nativeDialogCount: receipt.calls.length,
    targetRunId: owner.targetRunId, targetOperationId: owner.targetOperationId };
}
