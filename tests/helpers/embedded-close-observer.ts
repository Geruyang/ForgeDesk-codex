import assert from 'node:assert/strict';

export interface EmbeddedCloseWarningReceipt {
  mechanism: string; runId: string; electronVersion: string;
  calls: Array<{ phase: 'started' | 'fulfilled' | 'rejected'; startedAt: number; finishedAt?: number;
    options: { type: string; message: string }; response?: number; error?: string }>;
}

// Serialized into main: public native-dialog API only, with no automatic response or external closure.
export function installEmbeddedCloseObserver({ dialog }: { dialog: unknown }, { runId }: { runId: string }) {
  if (!/^t2-\d{13}-[a-z0-9]{4,12}$/.test(runId)) throw new Error('Invalid T2 close-observer run');
  const target = dialog as any; const host = globalThis as any;
  if (typeof target.showMessageBox !== 'function' || host.__forgedeskT2CloseObserver) throw new Error('Original native message-box function is unavailable or already observed');
  const state: any = { runId, target, original: target.showMessageBox, calls: [] };
  state.wrapper = async function (this: unknown, ...args: any[]) {
    const options = args.length === 1 ? args[0] : args[1];
    const isWarning = options?.type === 'warning' && options?.message === '工程验证正在运行，请等待完成后退出。';
    const call: any = isWarning ? { phase: 'started', startedAt: Date.now(), options: { type: options.type, message: options.message } } : undefined;
    if (call) state.calls.push(call);
    try {
      const result: any = await Reflect.apply(state.original, this, args);
      if (call) { call.phase = 'fulfilled'; call.finishedAt = Date.now(); call.response = result.response; }
      return result;
    } catch (error) {
      if (call) { call.phase = 'rejected'; call.finishedAt = Date.now(); call.error = String(error).slice(0, 4000); }
      throw error;
    }
  };
  target.showMessageBox = state.wrapper; host.__forgedeskT2CloseObserver = state;
  return { mechanism: 'native showMessageBox pass-through close-warning observer; no generated response', runId, electronVersion: process.versions.electron ?? '', installed: true };
}
export function readEmbeddedCloseObserver({ dialog }: { dialog: unknown }, { runId }: { runId: string }): EmbeddedCloseWarningReceipt {
  const state = (globalThis as any).__forgedeskT2CloseObserver; const target = dialog as any;
  if (!state || state.runId !== runId || state.target !== target || target.showMessageBox !== state.wrapper) throw new Error('T2 close observer changed');
  return { mechanism: 'native showMessageBox pass-through close-warning observer; no generated response', runId, electronVersion: process.versions.electron ?? '',
    calls: state.calls.map((call: any) => ({ ...call, options: { ...call.options } })) };
}
export function restoreEmbeddedCloseObserver({ dialog }: { dialog: unknown }, { runId }: { runId: string }) {
  const host = globalThis as any; const state = host.__forgedeskT2CloseObserver; const target = dialog as any;
  if (!state || state.runId !== runId || state.target !== target || target.showMessageBox !== state.wrapper || typeof state.original !== 'function') throw new Error('T2 close observer changed; original was not restored');
  if (state.calls.some((call: any) => call.phase === 'started')) throw new Error('Cannot restore while human native warning response remains pending');
  target.showMessageBox = state.original; delete host.__forgedeskT2CloseObserver;
  return { restored: true, runId };
}
export function assertEmbeddedCloseWarning(receipt: EmbeddedCloseWarningReceipt) {
  assert.equal(receipt.calls.length, 1, 'Exactly one native during-flash close warning must occur');
  const call = receipt.calls[0]; assert.equal(call.phase, 'fulfilled', call.error ?? 'Native warning still needs a human response');
  assert.deepEqual(call.options, { type: 'warning', message: '工程验证正在运行，请等待完成后退出。' });
  assert.ok(Number.isInteger(call.response)); assert.ok(Number.isFinite(call.finishedAt) && call.finishedAt! >= call.startedAt);
}
