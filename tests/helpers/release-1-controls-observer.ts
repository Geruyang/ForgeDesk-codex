// These functions run in Electron's main context and retain the original IPC result.
export function installControlsBoundary({ ipcMain, dialog }: { ipcMain: any; dialog: any }, expectedVersion: string) {
  if (process.versions.electron !== expectedVersion || expectedVersion !== '44.7.2') throw Error('CONTROLS_ELECTRON_MISMATCH');
  const host = globalThis as any, map = ipcMain._invokeHandlers, original = map?.get('forgedesk:invoke');
  if (!(map instanceof Map) || typeof original !== 'function' || host.__release1ControlsBoundary) throw Error('CONTROLS_BOUNDARY_UNAVAILABLE');
  const state: any = { map, original, queue: [], calls: [], projects: [], forbidden: 0, nativePrompts: 0, wrapper: undefined };
  host.__release1ControlsBoundary = state;
  const prompt = dialog.showMessageBox;
  dialog.showMessageBox = function (this: unknown, ...args: any[]) { state.nativePrompts++; return Reflect.apply(prompt, this, args); };
  map.set('forgedesk:invoke', async function (this: unknown, ...args: any[]) {
    const method = args[1], params = args[2];
    if (method === 'snapshot' && Array.isArray(params) && params.length === 0) return Reflect.apply(original, this, args);
    if (method === 'diff' && Array.isArray(params) && params.length === 1 && state.projects.includes(params[0])) return Reflect.apply(original, this, args);
    const expected = state.queue[0];
    if (!expected || method !== expected.method || JSON.stringify(params) !== JSON.stringify(expected.args)) { state.forbidden++; throw Error('CONTROLS_IPC_NOT_ARMED'); }
    state.queue.shift(); const call: any = { method, phase: 'started', argumentsValid: true, startedAt: Date.now(), expectedRejection: expected.expectedRejection === true }; state.calls.push(call);
    try {
      const result: any = await Reflect.apply(original, this, args);
      if (method === 'importProject' && expected.projectRoot) {
        if (!result || typeof result.id !== 'string' || String(result.root).replace(/\\/g, '/').toLowerCase() !== expected.projectRoot.replace(/\\/g, '/').toLowerCase()) throw Error('CONTROLS_PROJECT_ROOT_MISMATCH');
        state.projects.push(result.id);
      }
      call.phase = 'fulfilled'; call.finishedAt = Date.now(); return result;
    } catch (error) { call.phase = 'rejected'; call.finishedAt = Date.now(); throw error; }
  });
  state.wrapper = map.get('forgedesk:invoke');
  return { installed: true, expectedVersion, originalResultsPreserved: true, nativePromptAnswersSynthesized: false };
}
export function armControlsBoundary({ ipcMain }: { ipcMain: any }, queue: { method: string; args: unknown[]; expectedRejection?: boolean; projectRoot?: string }[]) {
  const state = (globalThis as any).__release1ControlsBoundary;
  if (!state || state.map !== ipcMain._invokeHandlers || state.map.get('forgedesk:invoke') !== state.wrapper || state.queue.length || state.forbidden || state.nativePrompts || state.calls.some((c: any) => c.phase === 'started')) throw Error('CONTROLS_BOUNDARY_NOT_QUIET');
  const allowed = ['importProject', 'createSession', 'send', 'interrupt', 'approve', 'setAcceptance', 'exportDiagnostics', 'connect', 'fz3bLeaveMode'];
  if (!Array.isArray(queue) || queue.length < 1 || queue.length > 2 || queue.some(q => !allowed.includes(q.method) || !Array.isArray(q.args))) throw Error('CONTROLS_BOUNDARY_BAD_ARM');
  if (queue.some(q => q.method === 'fz3bLeaveMode' && (queue.length !== 1 || q.args.length !== 0 || q.expectedRejection === true))) throw Error('CONTROLS_BOUNDARY_BAD_ARM');
  state.queue = queue;
}
export function readControlsBoundary({ ipcMain }: { ipcMain: any }) {
  const state = (globalThis as any).__release1ControlsBoundary;
  if (!state || state.map !== ipcMain._invokeHandlers || state.map.get('forgedesk:invoke') !== state.wrapper) throw Error('CONTROLS_BOUNDARY_CHANGED');
  return { mechanism: 'original IPC exact arguments pass-through', forbiddenCount: state.forbidden, nativePromptCount: state.nativePrompts,
    remainingArms: state.queue.length, calls: state.calls.map((c: any) => ({ ...c })), protectedAfterInstallOnly: true };
}
