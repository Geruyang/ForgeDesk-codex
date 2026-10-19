import assert from 'node:assert/strict';

export interface Fz3bHostFinalizationIpcCall {
  phase: 'started' | 'fulfilled' | 'rejected';
  argumentsValid: boolean;
  argumentCount: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  quarantineReceipt?: unknown;
}

export type Fz3bHostIpcPurpose = 'finish' | 'quarantine' | 'maintenance-exit';
export const FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX = '__FORGEDESK_QA_LOCAL_HOST_MAINTENANCE__';

export interface Fz3bHostFinalizationIpcReceipt {
  mechanism: string;
  electronVersion: string;
  runId: string;
  calls: Fz3bHostFinalizationIpcCall[];
  purpose?: 'quarantine' | 'maintenance-exit';
}

// These functions are serialized into Electron's main context without module closures.
export function installFz3bHostFinalizationIpcObserver({ ipcMain }: { ipcMain: unknown }, { runId, purpose = 'finish' }: { runId: string; purpose?: Fz3bHostIpcPurpose }) {
  const mechanism = 'test-only exact-run original forgedesk:invoke pass-through observer';
  const expectedVersion = '44.7.2';
  const method = purpose === 'quarantine' ? 'fz3bQuarantineEmptyHostHome' : purpose === 'maintenance-exit' ? 'fz3bMaintenanceExit' : 'fz3bReconcilePreflightRefusedInspect';
  const version = process.versions.electron;
  if (version !== expectedVersion) throw new Error('Host finalization observer requires exactly Electron 44.7.2');
  if (typeof runId !== 'string' || !runId || runId.length > 200) throw new Error('Invalid host finalization run');
  if (!['finish', 'quarantine', 'maintenance-exit'].includes(purpose)) throw new Error('Unsupported fixed host IPC purpose');
  const map = (ipcMain as any)._invokeHandlers;
  if (!(map instanceof Map)) throw new Error('Electron IPC invoke-handler Map is unavailable');
  const original = map.get('forgedesk:invoke');
  if (typeof original !== 'function') throw new Error('Original ForgeDesk invoke handler is unavailable');
  const host = globalThis as any;
  if (host.__forgedeskQaHostFinalizationObserver) throw new Error('Host finalization observer is already installed');
  const state: any = { runId, purpose, map, original, calls: [], wrapper: undefined };
  host.__forgedeskQaHostFinalizationObserver = state;
  map.set('forgedesk:invoke', async function (this: unknown, ...args: any[]) {
    const targetMethod = args[1] === method;
    const call: any = targetMethod ? { phase: 'started', startedAt: Date.now(), argumentCount: Array.isArray(args[2]) ? args[2].length : -1,
      argumentsValid: Array.isArray(args[2]) && args[2].length === 1 && args[2][0] === runId } : undefined;
    if (call) state.calls.push(call);
    if (call && purpose === 'maintenance-exit') {
      try { console.log('__FORGEDESK_QA_LOCAL_HOST_MAINTENANCE__' + JSON.stringify({ mechanism, electronVersion: version, runId, purpose,
        calls: state.calls.map((item: Fz3bHostFinalizationIpcCall) => ({ ...item })) })); } catch { /* Logging cannot admit or block the original action. */ }
    }
    try {
      const result = await Reflect.apply(original, this, args);
      if (call) {
        call.phase = 'fulfilled'; call.finishedAt = Date.now();
        if (purpose === 'quarantine') {
          const publicResult: any = result;
          const keys = publicResult && typeof publicResult === 'object' ? Object.keys(publicResult).sort().join(',') : '';
          call.quarantineReceipt = result === null ? null : keys === 'canonicalHomeAbsent,intentSha256,nonce,preservedEmpty,schemaVersion'
            ? { schemaVersion: publicResult.schemaVersion, nonce: publicResult.nonce, canonicalHomeAbsent: publicResult.canonicalHomeAbsent,
              preservedEmpty: publicResult.preservedEmpty, intentSha256: publicResult.intentSha256 } : { invalidPublicResult: true };
        }
        if (purpose === 'maintenance-exit') {
          try { console.log('__FORGEDESK_QA_LOCAL_HOST_MAINTENANCE__' + JSON.stringify({ mechanism, electronVersion: version, runId, purpose,
            calls: state.calls.map((item: Fz3bHostFinalizationIpcCall) => ({ ...item })) })); } catch { /* Logging cannot change the original result. */ }
        }
      }
      return result;
    } catch (error) {
      if (call) {
        call.phase = 'rejected'; call.finishedAt = Date.now(); call.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
        if (purpose === 'maintenance-exit') {
          try { console.log('__FORGEDESK_QA_LOCAL_HOST_MAINTENANCE__' + JSON.stringify({ mechanism, electronVersion: version, runId, purpose,
            calls: state.calls.map((item: Fz3bHostFinalizationIpcCall) => ({ ...item })) })); } catch { /* Logging cannot change the original rejection. */ }
        }
      }
      throw error;
    }
  });
  state.wrapper = map.get('forgedesk:invoke');
  return { mechanism, electronVersion: version, runId, installed: true };
}

export function readFz3bHostFinalizationIpcObserver({ ipcMain }: { ipcMain: unknown }, { runId, purpose = 'finish' }: { runId: string; purpose?: Fz3bHostIpcPurpose }): Fz3bHostFinalizationIpcReceipt {
  const mechanism = 'test-only exact-run original forgedesk:invoke pass-through observer';
  const expectedVersion = '44.7.2';
  const version = process.versions.electron;
  if (version !== expectedVersion) throw new Error('Host finalization observer requires exactly Electron 44.7.2');
  const map = (ipcMain as any)._invokeHandlers;
  const state = (globalThis as any).__forgedeskQaHostFinalizationObserver;
  if (!(map instanceof Map) || !state || state.runId !== runId || state.purpose !== purpose || state.map !== map || map.get('forgedesk:invoke') !== state.wrapper) {
    throw new Error('Host finalization observer identity or handler changed');
  }
  return { mechanism, electronVersion: version, runId, ...(purpose === 'finish' ? {} : { purpose }),
    calls: state.calls.map((call: Fz3bHostFinalizationIpcCall) => ({ phase: call.phase, argumentsValid: call.argumentsValid,
      argumentCount: call.argumentCount, startedAt: call.startedAt,
      ...(call.finishedAt === undefined ? {} : { finishedAt: call.finishedAt }), ...(call.error === undefined ? {} : { error: call.error }),
      ...(call.quarantineReceipt === undefined ? {} : { quarantineReceipt: call.quarantineReceipt }) })) };
}

export function restoreFz3bHostFinalizationIpcObserver({ ipcMain }: { ipcMain: unknown }, { runId, purpose = 'finish' }: { runId: string; purpose?: Fz3bHostIpcPurpose }) {
  const mechanism = 'test-only exact-run original forgedesk:invoke pass-through observer';
  const expectedVersion = '44.7.2';
  const version = process.versions.electron;
  if (version !== expectedVersion) throw new Error('Host finalization observer requires exactly Electron 44.7.2');
  const map = (ipcMain as any)._invokeHandlers;
  const host = globalThis as any, state = host.__forgedeskQaHostFinalizationObserver;
  if (!(map instanceof Map) || !state || state.runId !== runId || state.purpose !== purpose || state.map !== map || map.get('forgedesk:invoke') !== state.wrapper || typeof state.original !== 'function') {
    throw new Error('Host finalization observer identity or handler changed; original handler was not restored');
  }
  if (state.calls.some((call: Fz3bHostFinalizationIpcCall) => call.phase === 'started')) throw new Error('Cannot restore observer while its original call remains pending');
  map.set('forgedesk:invoke', state.original); delete host.__forgedeskQaHostFinalizationObserver;
  return { mechanism, electronVersion: version, runId, restored: true };
}

export function assertFz3bHostFinalizationIpcReceipt(receipt: Fz3bHostFinalizationIpcReceipt, expectedCalls: 1 | 0, purpose: Fz3bHostIpcPurpose = 'finish'): void {
  assert.equal(receipt.electronVersion, '44.7.2'); assert.equal(receipt.mechanism, 'test-only exact-run original forgedesk:invoke pass-through observer');
  assert.equal(receipt.calls.length, expectedCalls, 'Only the expected number of exact public finish IPC calls is accepted');
  assert.equal(receipt.purpose, purpose === 'finish' ? undefined : purpose);
  for (const call of receipt.calls) {
    assert.equal(call.argumentsValid, true, 'The original UI call must pass only the exact target run ID');
    assert.equal(call.argumentCount, 1);
    assert.equal(call.phase, 'fulfilled', call.error ? `Original public finish IPC rejected: ${call.error}` : 'Original finish IPC has not fulfilled');
    assert.ok(Number.isFinite(call.startedAt) && Number.isFinite(call.finishedAt) && call.finishedAt! >= call.startedAt);
    if (purpose === 'quarantine') assertFz3bEmptyHomeReceipt(call.quarantineReceipt);
  }
}

export function assertFz3bEmptyHomeReceipt(value: unknown): asserts value is {
  schemaVersion: 1; nonce: string; canonicalHomeAbsent: true; preservedEmpty: true; intentSha256: string;
} {
  const receipt = value as any;
  assert.ok(receipt && typeof receipt === 'object', 'Native isolation was cancelled or returned no factual receipt');
  assert.deepEqual(Object.keys(receipt).sort(), ['canonicalHomeAbsent', 'intentSha256', 'nonce', 'preservedEmpty', 'schemaVersion']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.canonicalHomeAbsent, true); assert.equal(receipt.preservedEmpty, true);
  assert.match(receipt.nonce, /^[a-f0-9]{64}$/); assert.match(receipt.intentSha256, /^[a-f0-9]{64}$/);
}
