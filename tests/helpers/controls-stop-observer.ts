import assert from 'node:assert/strict';

export interface ControlsStopCall { phase: 'started' | 'fulfilled' | 'rejected'; startedAt: number; finishedAt?: number; argumentsValid: boolean; error?: string }
export interface ControlsStopReceipt { mechanism: string; electronVersion: string; sessionId: string; calls: ControlsStopCall[] }

// These three functions are serialized into Electron's main context without module closures.
export function installControlsStopObserver({ ipcMain }: { ipcMain: unknown }, { sessionId }: { sessionId: string }) {
  const version = process.versions.electron;
  if (version !== '44.7.2') throw new Error('Controls Stop observer requires exactly Electron 44.7.2');
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('Invalid Stop observer session');
  const map = (ipcMain as any)._invokeHandlers;
  if (!(map instanceof Map)) throw new Error('Electron IPC invoke-handler Map is unavailable');
  const original = map.get('forgedesk:invoke');
  if (typeof original !== 'function') throw new Error('Original ForgeDesk invoke handler is unavailable');
  const host = globalThis as any;
  if (host.__forgedeskQaStopObserver) throw new Error('Controls Stop observer is already installed');
  const state: any = { sessionId, map, original, calls: [], wrapper: undefined };
  host.__forgedeskQaStopObserver = state;
  map.set('forgedesk:invoke', async function (this: unknown, ...args: any[]) {
    const target = args[1] === 'interrupt' && Array.isArray(args[2]) && args[2][0] === sessionId;
    const call: any = target ? { phase: 'started', startedAt: Date.now(), argumentsValid: args[2].length === 1 } : undefined;
    if (call) state.calls.push(call);
    try {
      const result = await Reflect.apply(original, this, args);
      if (call) { call.phase = 'fulfilled'; call.finishedAt = Date.now(); }
      return result;
    } catch (error) {
      if (call) { call.phase = 'rejected'; call.finishedAt = Date.now(); call.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000); }
      throw error;
    }
  });
  state.wrapper = map.get('forgedesk:invoke');
  return { mechanism: 'test-only original IPC handler pass-through observer', electronVersion: version, sessionId, installed: true };
}

export function readControlsStopObserver({ ipcMain }: { ipcMain: unknown }, { sessionId }: { sessionId: string }): ControlsStopReceipt {
  const version = process.versions.electron;
  if (version !== '44.7.2') throw new Error('Controls Stop observer requires exactly Electron 44.7.2');
  const map = (ipcMain as any)._invokeHandlers;
  const state = (globalThis as any).__forgedeskQaStopObserver;
  if (!(map instanceof Map) || !state || state.sessionId !== sessionId || state.map !== map || map.get('forgedesk:invoke') !== state.wrapper) throw new Error('Controls Stop observer identity or handler changed');
  return { mechanism: 'test-only original IPC handler pass-through observer', electronVersion: version, sessionId,
    calls: state.calls.map((call: ControlsStopCall) => ({ phase: call.phase, startedAt: call.startedAt, argumentsValid: call.argumentsValid,
      ...(call.finishedAt === undefined ? {} : { finishedAt: call.finishedAt }), ...(call.error === undefined ? {} : { error: call.error }) })) };
}

export function restoreControlsStopObserver({ ipcMain }: { ipcMain: unknown }, { sessionId }: { sessionId: string }) {
  const version = process.versions.electron;
  if (version !== '44.7.2') throw new Error('Controls Stop observer requires exactly Electron 44.7.2');
  const map = (ipcMain as any)._invokeHandlers;
  const host = globalThis as any; const state = host.__forgedeskQaStopObserver;
  if (!(map instanceof Map) || !state || state.sessionId !== sessionId || state.map !== map || map.get('forgedesk:invoke') !== state.wrapper || typeof state.original !== 'function') throw new Error('Controls Stop observer identity or handler changed; original handler was not restored');
  if (state.calls.some((call: ControlsStopCall) => call.phase === 'started')) throw new Error('Cannot restore Stop observer while its original interrupt call remains pending');
  map.set('forgedesk:invoke', state.original); delete host.__forgedeskQaStopObserver;
  return { mechanism: 'test-only original IPC handler pass-through observer', electronVersion: version, sessionId, restored: true };
}

export function assertControlsStopReceipt(receipt: ControlsStopReceipt): void {
  assert.equal(receipt.electronVersion, '44.7.2');
  assert.equal(receipt.mechanism, 'test-only original IPC handler pass-through observer');
  assert.equal(receipt.calls.length, 1, 'Exactly one actual UI interrupt call must be observed; no duplicate or replay is accepted');
  assert.equal(receipt.calls[0].argumentsValid, true, 'The actual Stop call must contain only the target session ID');
  assert.equal(receipt.calls[0].phase, 'fulfilled', receipt.calls[0].error ? `Original interrupt rejected: ${receipt.calls[0].error}` : 'Original interrupt has not fulfilled; public terminal state alone is insufficient');
  assert.ok(Number.isFinite(receipt.calls[0].startedAt) && Number.isFinite(receipt.calls[0].finishedAt) && receipt.calls[0].finishedAt! >= receipt.calls[0].startedAt);
}
