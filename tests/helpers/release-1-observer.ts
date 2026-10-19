export type Scope = { purpose: 'readonly' | 'leave' | 'setup' | 'model' | 'export' | 'build' | 'dedup' | 'refresh'; workspace: string; node: string; exports: string; taskId?: string; projectId?: string; prompt?: string; model?: string; requestKey?: string };

// Main-context instrumentation only. Every original call/dialog retains this, arguments,
// return value and rejection. It does not invoke, approve, suppress or answer any action.
export function installObserver({ ipcMain, dialog }: { ipcMain: unknown; dialog: unknown }, expectedElectron: string) {
  const map = (ipcMain as any)._invokeHandlers, host = globalThis as any, dialogs = dialog as any;
  if (typeof expectedElectron !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedElectron) || process.versions.electron !== expectedElectron || !(map instanceof Map) || host.__softwareRelease1 || typeof dialogs.showOpenDialog !== 'function' || typeof dialogs.showMessageBox !== 'function') throw Error('SOFTWARE_OBSERVER_SCOPE');
  const original = map.get('forgedesk:invoke'), originalOpen = dialogs.showOpenDialog, originalMessage = dialogs.showMessageBox;
  if (typeof original !== 'function') throw Error('SOFTWARE_OBSERVER_ORIGINAL');
  const state: any = { expectedElectron, map, dialogs, original, originalOpen, originalMessage, scope: { purpose: 'readonly' }, calls: [], approvals: [], forbidden: 0, unexpectedNative: false, pickers: [], wrapper: undefined, openWrapper: undefined, messageWrapper: undefined };
  dialogs.showOpenDialog = async function (this: unknown, ...args: any[]) {
    const purpose = state.scope.purpose;
    const picker: any = { purpose, phase: 'started', startedAt: Date.now() }; state.pickers.push(picker);
    let result: any;
    try { result = await Reflect.apply(originalOpen, this, args); }
    catch (error) { picker.phase = 'rejected'; picker.finishedAt = Date.now(); throw error; }
    const selected = result && result.canceled === false && Array.isArray(result.filePaths) && result.filePaths.length === 1 ? result.filePaths[0] : undefined;
    const normalized = typeof selected === 'string' ? selected.replaceAll('\\', '/').toLowerCase() : '';
    const expected = purpose === 'setup' ? [state.scope.workspace, state.scope.node] : purpose === 'export' ? [state.scope.exports] : [];
    picker.phase = 'fulfilled'; picker.finishedAt = Date.now(); picker.cancelled = result?.canceled !== false; picker.qualified = expected.some((name: string) => typeof name === 'string' && name.replaceAll('\\', '/').toLowerCase() === normalized);
    if (!['setup', 'export'].includes(purpose)) state.unexpectedNative = true;
    return result;
  };
  dialogs.showMessageBox = function (this: unknown, ...args: any[]) { state.unexpectedNative = true; return Reflect.apply(originalMessage, this, args); };
  map.set('forgedesk:invoke', async function (this: unknown, ...args: any[]) {
    const method = args[1], values = args[2], scope = state.scope;
    const allowed = scope.purpose === 'leave' ? ['fz3bLeaveMode'] : scope.purpose === 'setup' ? ['importProject', 'createSession', 'enableSnapshot'] : scope.purpose === 'model' ? ['send', 'approve'] : scope.purpose === 'export' ? ['exportTask'] : ['build', 'dedup'].includes(scope.purpose) ? ['runSnapshotBuild'] : scope.purpose === 'refresh' ? ['refreshEvidence'] : [];
    const readonly = ['snapshot', 'hardwareSnapshot', 'fz3bSnapshot', 'readOperationLog', 'diff'];
    if (!allowed.includes(method) && !readonly.includes(method)) state.forbidden++;
    let call: any;
    if (allowed.includes(method)) {
      if (state.calls.length >= 64) state.forbidden++;
      let valid = Array.isArray(values);
      if (method === 'fz3bLeaveMode' || method === 'importProject') valid &&= values.length === 0;
      else if (method === 'createSession') valid &&= values.length === 2 && values[0] === scope.projectId && values[1] === 'Release 1 software snapshot acceptance';
      else if (method === 'send') valid &&= values.length === 3 && values[0] === scope.taskId && values[1] === scope.prompt && values[2] === scope.model;
      else if (method === 'approve') {
        const approval = state.approvals.find((a: any) => a.generation === values[0] && a.id === values[1] && values[2] === 'accept' && !a.consumed);
        valid &&= values.length === 3 && !!approval; if (approval && valid) approval.consumed = true;
      } else if (method === 'runSnapshotBuild') valid &&= values.length === 2 && values[0] === scope.taskId && typeof values[1] === 'string' && values[1].length > 0 && (scope.purpose !== 'dedup' || values[1] === scope.requestKey);
      else valid &&= values.length === 1 && values[0] === scope.taskId;
      if (state.calls.length < 64) { call = { method, phase: 'started', argumentsValid: valid, startedAt: Date.now() }; state.calls.push(call); }
      if (!valid) state.forbidden++;
    }
    try {
      const result: any = await Reflect.apply(original, this, args);
      if (call) {
        call.phase = 'fulfilled'; call.finishedAt = Date.now();
        if (method === 'importProject') { call.resultValid = typeof result?.id === 'string' && typeof result?.root === 'string' && result.root.replaceAll('\\', '/').toLowerCase() === scope.workspace.replaceAll('\\', '/').toLowerCase(); if (call.resultValid) state.scope.projectId = result.id; }
        else if (method === 'createSession') { call.resultValid = typeof result?.id === 'string' && result.projectId === scope.projectId; if (call.resultValid) state.scope.taskId = result.taskId; }
        else if (method === 'exportTask') call.resultValid = typeof result === 'string' && result.replaceAll('\\', '/').toLowerCase().startsWith(scope.exports.replaceAll('\\', '/').toLowerCase() + '/forgedesk-');
        else call.resultValid = true;
      }
      return result;
    } catch (error) { if (call) { call.phase = 'rejected'; call.finishedAt = Date.now(); call.error = 'ORIGINAL_PRODUCT_IPC_REJECTED'; } throw error; }
  });
  state.wrapper = map.get('forgedesk:invoke'); state.openWrapper = dialogs.showOpenDialog; state.messageWrapper = dialogs.showMessageBox; host.__softwareRelease1 = state; return { installed: true };
}
export function readObserver({ ipcMain, dialog }: { ipcMain: unknown; dialog: unknown }) {
  const state = (globalThis as any).__softwareRelease1;
  if (!state || process.versions.electron !== state.expectedElectron || state.map !== (ipcMain as any)._invokeHandlers || state.wrapper !== state.map.get('forgedesk:invoke') || state.dialogs !== dialog || state.openWrapper !== (dialog as any).showOpenDialog || state.messageWrapper !== (dialog as any).showMessageBox) throw Error('SOFTWARE_OBSERVER_CHANGED');
  return { purpose: state.scope.purpose, forbiddenCount: state.forbidden, unexpectedNativePrompt: state.unexpectedNative,
    calls: state.calls.map((c: any) => ({ method: c.method, phase: c.phase, argumentsValid: c.argumentsValid, startedAt: c.startedAt, ...(c.finishedAt === undefined ? {} : { finishedAt: c.finishedAt }), ...(c.resultValid === undefined ? {} : { resultValid: c.resultValid }), ...(c.error === undefined ? {} : { error: c.error }) })),
    pickers: state.pickers.map((p: any) => ({ purpose: p.purpose, phase: p.phase, startedAt: p.startedAt, ...(p.finishedAt === undefined ? {} : { finishedAt: p.finishedAt }), ...(p.cancelled === undefined ? {} : { cancelled: p.cancelled }), ...(p.qualified === undefined ? {} : { qualified: p.qualified }) })), approvals: state.approvals.map((a: any) => ({ generation: a.generation, id: a.id, requestKey: a.requestKey, consumed: a.consumed })) };
}
export function armObserver({ ipcMain, dialog }: { ipcMain: unknown; dialog: unknown }, scope: Scope) {
  const state = (globalThis as any).__softwareRelease1;
  if (!state || state.map !== (ipcMain as any)._invokeHandlers || state.wrapper !== state.map.get('forgedesk:invoke') || state.dialogs !== dialog || state.openWrapper !== (dialog as any).showOpenDialog || state.messageWrapper !== (dialog as any).showMessageBox || state.calls.some((c: any) => c.phase === 'started') || state.forbidden || state.unexpectedNative || !['readonly', 'leave', 'setup', 'model', 'export', 'build', 'dedup', 'refresh'].includes(scope.purpose)) throw Error('SOFTWARE_OBSERVER_ARM_HELD');
  state.scope = { ...scope }; state.calls = []; state.pickers = []; state.approvals = []; return { armed: scope.purpose };
}
export function registerApproval({ ipcMain }: { ipcMain: unknown }, approval: { generation: number; id: string | number; requestKey: string }) {
  const state = (globalThis as any).__softwareRelease1;
  if (!state || state.wrapper !== (ipcMain as any)._invokeHandlers.get('forgedesk:invoke') || state.scope.purpose !== 'model' || state.approvals.length >= 2 || state.approvals.some((a: any) => a.generation === approval.generation && a.id === approval.id)) throw Error('SOFTWARE_APPROVAL_REGISTRATION');
  state.approvals.push({ generation: approval.generation, id: approval.id, requestKey: approval.requestKey, consumed: false }); return { registered: true };
}
