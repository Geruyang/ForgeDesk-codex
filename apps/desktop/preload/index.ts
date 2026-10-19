import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, AppSnapshot } from '../../../packages/shared/contracts';
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke('forgedesk:invoke', method, args);
const api: DesktopAPI = {
  snapshot: () => invoke('snapshot'), importProject: () => invoke('importProject'),
  createSession: (projectId, title) => invoke('createSession', projectId, title),
  send: (id, text, model) => invoke('send', id, text, model), steer: (id, text) => invoke('steer', id, text),
  interrupt: id => invoke('interrupt', id), approve: (g, id, decision) => invoke('approve', g, id, decision),
  connect: () => invoke('connect'), login: () => invoke('login'), diff: id => invoke('diff', id),
  setAcceptance: (id, items) => invoke('setAcceptance', id, items),
  runAcceptance: (id, aid, key) => invoke('runAcceptance', id, aid, key),
  enableSnapshot: id => invoke('enableSnapshot', id),
  runSnapshotBuild: (id, key) => invoke('runSnapshotBuild', id, key),
  refreshEvidence: id => invoke('refreshEvidence', id), exportTask: id => invoke('exportTask', id),
  readOperationLog: (id, op) => invoke('readOperationLog', id, op), cancelOperation: (id, op) => invoke('cancelOperation', id, op),
  exportDiagnostics: () => invoke('exportDiagnostics'), openProject: id => invoke('openProject', id),
  hardwareSnapshot: id => invoke('hardwareSnapshot', id), hardwareConfigure: id => invoke('hardwareConfigure', id),
  hardwareBuild: (id, key) => invoke('hardwareBuild', id, key), hardwareInspect: (id, key) => invoke('hardwareInspect', id, key),
  hardwareFlash: (id, key) => invoke('hardwareFlash', id, key), hardwareVerify: (id, key) => invoke('hardwareVerify', id, key),
  hardwareExport: id => invoke('hardwareExport', id), hardwareRecover: id => invoke('hardwareRecover', id),
  hardwareLeaveMode: () => invoke('hardwareLeaveMode'),
  hardwareAgentStart: (id, instruction, model) => invoke('hardwareAgentStart', id, instruction, model),
  hardwareAgentStop: id => invoke('hardwareAgentStop', id),
  fz3bSnapshot: id => invoke('fz3bSnapshot', id),
  fz3bAgentStart: (id, instruction, model) => invoke('fz3bAgentStart', id, instruction, model),
  fz3bAgentStop: id => invoke('fz3bAgentStop', id),
  fz3bRecover: id => invoke('fz3bRecover', id), fz3bExport: id => invoke('fz3bExport', id),
  fz3bReconcileInspect: id => invoke('fz3bReconcileInspect', id),
  fz3bReconcilePreflightRefusedInspect: id => invoke('fz3bReconcilePreflightRefusedInspect', id),
  fz3bMaintenanceExit: id => invoke('fz3bMaintenanceExit', id),
  fz3bQuarantineEmptyHostHome: id => invoke('fz3bQuarantineEmptyHostHome', id),
  fz3bIsolateFailedEmptyIntent: id => invoke('fz3bIsolateFailedEmptyIntent', id),
  fz3bLeaveMode: () => invoke('fz3bLeaveMode'),
  fz3bImportKey: () => invoke('fz3bImportKey'),
  subscribe: callback => { const listener = (_event: unknown, snapshot: AppSnapshot) => callback(snapshot); ipcRenderer.on('forgedesk:snapshot', listener); return () => ipcRenderer.removeListener('forgedesk:snapshot', listener); }
};
contextBridge.exposeInMainWorld('forgeDesk', api);
