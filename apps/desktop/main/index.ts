import { initializeFz3bHostAclHelper } from '../../../packages/engineering-runner/fz3b/host-acl';
import { app, BrowserWindow, dialog, ipcMain, shell, session as electronSession } from 'electron';
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { existsSync, mkdirSync, writeFileSync, realpathSync, readFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexAdapter } from '../../../packages/engine-adapter';
import { RestrictedHardwareAdapter } from '../../../packages/engine-adapter/restricted-hardware';
import { RestrictedFz3bAdapter } from '../../../packages/engine-adapter/restricted-fz3b';
import { Fz3bBackend } from '../../../packages/engineering-runner/fz3b/backend';
import { ProductionFz3bAdapter, checkFz3bAvailability, importFz3bProjectKey, loadFz3bFixture, verifyFz3bResources } from '../../../packages/engineering-runner/fz3b/worker';
import { Fz3bAgentMain } from './fz3b-agent';
import { createFz3bHostFinalizationStore } from './host-finalization-store';
import { configuredFailedEmptyIntentRecovery } from './host-failed-empty-intent';
import { composeIncidentFailedIntentRecovery } from './host-failed-empty-intent-main';
import { currentSid } from '../../../packages/engineering-runner/fz3b/credentials';
import { requestNativeFz3bSemantic } from './fz3b-approval';
import { requestNativeFz3bInspectReconciliation, requestNativeFz3bMaintenanceExit, requestNativeFz3bPreflightRefusalRecovery, requestNativeFz3bHostLocalAction, type Fz3bHostLocalConfirmation } from './fz3b-recovery-approval';
import { fz3bCanonicalJson } from '../../../packages/engineering-runner/fz3b/profile';
import { NativeDialogArbiter, NativeDialogCancelledError } from './native-dialogs';
import { installConsolePipeGuard } from './console-pipe-guard';
import { assertRunnerLifecycleOwner } from './runner-lifecycle-ownership';
import { restrictedSessionProfile } from './restricted-session';
import type { Fz3bAvailability, Fz3bAvailabilityStatus } from '../../../packages/engineering-runner/fz3b/availability';
import type { Fz3bBinding } from '../../../packages/engineering-runner/fz3b/types';
import { HardwareAgentController } from '../../../packages/engineering-runner/embedded/model-controller';
import { probeSnapshotIsolation } from '../../../packages/engine-adapter/snapshot-isolation';
import { EngineeringRunner } from '../../../packages/engineering-runner';
import { redact } from '../../../packages/engineering-runner/redaction';
import { startRunnerBridge, ENGINEERING_TOOLS } from '../../../packages/engineering-mcp';
import { DesktopStore } from './store';
import { EmbeddedService } from '../../../packages/engineering-runner/embedded';
import { FixedStm32HardwareService } from '../../../packages/engineering-runner/device/real-stm32';
import { verifyHardwareRuntime } from './hardware-runtime';
import { createNativeStartupHistoryOwner } from './release-recovery-history-launch';
import type { AppSnapshot, Session, TaskView } from '../../../packages/shared/contracts';

const exec = promisify(execFile);
let window: BrowserWindow | null = null;
let store: DesktopStore;
let runner: EngineeringRunner;
let engine: CodexAdapter;
let engineError: string | undefined;
let enginePath = '';
let processHostPath = '';
let dataDir = '';
let startupHistoryOwner: ReturnType<typeof createNativeStartupHistoryOwner> | undefined;
let embedded: EmbeddedService;
let hardwareRoot = '';
let hardwareWorker = '';
let hardwareMode = false;
let hardwareAgent: HardwareAgentController;
let hardwareEngine: RestrictedHardwareAdapter | undefined;
let hardwareAgentRunId: string | undefined;
let hardwareAgentTaskId: string | undefined;
let hardwareAgentStarting = false;
let hardwareAgentRecovering: string | undefined;
let hardwareAgentPolicy: unknown;
let fz3bAgent: Fz3bAgentMain | undefined;
let fz3bResourceRoot = '';
type Fz3bMainAvailability = Omit<Fz3bAvailability, 'status'> & { status: Fz3bAvailabilityStatus | 'unchecked' | 'invalid-state' };
let fz3bAvailability: Fz3bMainAvailability = { available: false, status: 'unchecked', resourcesVerified: false, reason: 'FZ3B 资源尚未校验' };
let fz3bUnavailableHold = false;
let fz3bKeyImporting = false;
let fz3bHostActionRunId: string | undefined;
let fz3bHostStartupReadOnly = false;
let fz3bHostIpcRegistered = false;
const nativeDialogs = new NativeDialogArbiter();
const hardwareFinalizers = new Map<string, Promise<void>>();
const hardwareFinishRequested = new Set<string>();
const cancelledHardwareStarts = new Set<string>();
const snapshotPolicies = new Map<string, string>();
const snapshotBuilds = new Map<string, Promise<unknown>>();
let account = { loggedIn: false, label: '未登录' };
let models: AppSnapshot['models'] = [];
let diagnostics: string[] = [];
let persistenceFailed = false;
let publishing: ReturnType<typeof setTimeout> | undefined;
let closing = false;
let shutdownPending = false;
let shutdownFailed = false;
const pendingMainWork = new Set<Promise<unknown>>();
let bridge: Awaited<ReturnType<typeof startRunnerBridge>> | undefined;
let evidenceTimer: ReturnType<typeof setTimeout> | undefined;
const protectedTasks = new Set<string>();
const sendingSessions = new Set<string>();
const stoppingSessions = new Set<string>();
const asRecord = (v: unknown): Record<string, any> => v && typeof v === 'object' ? v as Record<string, any> : {};
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 30) return '[depth limit]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /(?:api.?key|access.?token|refresh.?token|id.?token|password|secret|authorization|credential)/i.test(key) ? '[REDACTED]' : sanitize(item, depth + 1)]));
  return value;
}
function log(text: string) { diagnostics.push(`${new Date().toISOString()} ${redact(text).slice(0, 4000)}`); diagnostics = diagnostics.slice(-100); publish(); }
installConsolePipeGuard({ console, stdout: process.stdout, stderr: process.stderr,
  onPipeClosed: stream => log(`标准日志管道已关闭 (${stream})；设备退出状态仍须由原始回执确认。`) });
function getSession(id: string): Session { const s = store.sessions.find(s => s.id === id); if (!s) throw new Error('会话不存在'); return s; }
function assertProjectDataSeparation(selected: string) {
  const root = realpathSync(selected), privateRoot = realpathSync(dataDir);
  const contains = (parent: string, child: string) => {
    const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  if (contains(root, privateRoot) || contains(privateRoot, root)) throw new Error('项目不能与 ForgeDesk 运行数据目录重叠');
  return root;
}
function getProject(id: string) { const p = store.projects.find(p => p.id === id); if (!p) throw new Error('项目不存在'); assertProjectDataSeparation(p.root); return p; }
function save() { try { store.save(); } catch (e) { persistenceFailed = true; engineError = `历史保存失败，已停止接受新任务: ${e}`; throw e; } }
async function snapshot(): Promise<AppSnapshot> {
  const hardwareRuns = hardwareAgent ? await hardwareAgent.list() : [];
  const fz3bState = fz3bAgent ? await fz3bAgent.snapshot() : { runs: [], engineState: 'stopped' };
  const tasks = (await runner.listTasks()) as unknown as TaskView[];
  const keyImportAllowed = await mayImportFz3bKey(tasks);
  const candidateRecovery = 'recoveryTaskId' in fz3bState ? fz3bState.recoveryTaskId : undefined;
  const recoveryTaskId = typeof candidateRecovery === 'string' && fz3bNoRunRecoveryIdle(candidateRecovery, tasks) ? candidateRecovery : undefined;
  const candidateActions = 'recoveryActions' in fz3bState ? fz3bState.recoveryActions : undefined;
  let recoveryActions = candidateActions && !fz3bHostActionRunId && fz3bNoRunRecoveryIdle(candidateActions.taskId, tasks) ? candidateActions : undefined;
  if (recoveryActions) { try { await embedded.assertIdle(); } catch { recoveryActions = undefined; } }
  return { schemaVersion: 1, version: app.getVersion(), projects: store.projects, sessions: store.sessions,
    engine: { state: engine?.state ?? 'stopped', executable: enginePath, home: path.join(dataDir, 'engine'), error: engineError },
    account, models, approvals: engine?.pendingApprovals() ?? [], tasks,
    diagnostics, hardware: { enabled: false, userDriven: true, modeActive: hardwareMode,
      reason: fz3bAgent?.held || fz3bUnavailableHold ? 'FZ3B 受限模型任务：固定 PS 包与已有运行时单图，副作用须原生授权，未知状态仍持锁' : hardwareAgentRunId ? '受限模型实机任务：固定工具，烧录仍需原生授权' : hardwareMode ? '工程受控模式：普通模型命令已停止，实机操作须单独授权' : '普通模型设备工具未开放；固定板型可进入本地实机流程' },
    hardwareAgent: { activeRunId: hardwareAgentRunId, runs: hardwareRuns, engineState: hardwareEngine?.state ?? 'stopped', policy: hardwareAgentPolicy },
    fz3bAgent: { ...fz3bState, ...fz3bAvailability, keyImportAllowed, recoveryTaskId, recoveryActions }, dataDir };
}
function fz3bKeyImportIdle(ignoreOwnImport = false) {
  return !persistenceFailed && !closing && (ignoreOwnImport || !fz3bKeyImporting) && !fz3bUnavailableHold && !fz3bAgent?.held &&
    !hardwareAgentStarting && !hardwareAgentRunId && !hardwareAgentRecovering && (!hardwareEngine || hardwareEngine.state === 'stopped') &&
    !!engine && ['ready', 'stopped'].includes(engine.state) && engine.pendingApprovals().length === 0 &&
    protectedTasks.size === 0 && sendingSessions.size === 0 && stoppingSessions.size === 0 &&
    !store.sessions.some(s => s.engineUncertain || ['running', 'stopping'].includes(s.status));
}
async function mayImportFz3bKey(tasks?: TaskView[], ignoreOwnImport = false): Promise<boolean> {
  if (!fz3bAvailability.resourcesVerified || !['missing-key', 'available'].includes(fz3bAvailability.status) || !fz3bKeyImportIdle(ignoreOwnImport)) return false;
  const current = tasks ?? (await runner.listTasks()) as unknown as TaskView[];
  if (current.some(task => task.operations.some(operation => ['prepared', 'running', 'stopping', 'unknown'].includes(operation.status) || operation.cleanup === 'unknown'))) return false;
  try { await embedded.assertIdle(); await fz3bAgent?.assertIdle(); }
  catch { return false; }
  return fz3bKeyImportIdle(ignoreOwnImport);
}
function fz3bNoRunRecoveryIdle(taskId: string, tasks: TaskView[]) {
  return !persistenceFailed && !closing && !closeWarningOpen && !fz3bKeyImporting && !fz3bUnavailableHold && hardwareMode && engine?.state === 'stopped' &&
    !hardwareAgentStarting && !hardwareAgentRunId && !hardwareAgentRecovering && (!hardwareEngine || hardwareEngine.state === 'stopped') &&
    protectedTasks.size === 1 && protectedTasks.has(taskId) && sendingSessions.size === 0 && stoppingSessions.size === 0 && engine.pendingApprovals().length === 0 &&
    !tasks.some(task => task.operations.some(operation => ['prepared', 'running', 'stopping', 'unknown'].includes(operation.status) || operation.cleanup === 'unknown')) &&
    !store.sessions.some(s => s.taskId !== taskId && (s.engineUncertain || ['running', 'stopping'].includes(s.status)));
}
async function assertFz3bRecoveryScope(binding: Fz3bBinding) {
  ensureWritable();
  const session = getSession(binding.sessionId), project = getProject(session.projectId);
  const check = (tasks: TaskView[]) => {
    if (!fz3bNoRunRecoveryIdle(binding.taskId, tasks) || session.taskId !== binding.taskId || session.engineProfile !== 'fz3b' ||
        session.threadId !== binding.threadId || session.model !== binding.model || fz3bAgent?.activeRunId !== binding.runId ||
        fz3bHostActionRunId && fz3bHostActionRunId !== binding.runId) throw new Error('FZ3B_RECOVERY_GLOBAL_OWNER_MISMATCH');
  };
  check((await runner.listTasks()) as unknown as TaskView[]);
  const task = await runner.getTask(binding.taskId);
  if (task.sessionId !== session.id || task.projectRoot !== project.root) throw new Error('FZ3B_RECOVERY_SOURCE_PROJECT_MISMATCH');
  await embedded.assertIdle();
  check((await runner.listTasks()) as unknown as TaskView[]);
}
function publish() {
  if (publishing) return;
  publishing = setTimeout(() => { publishing = undefined; if (window && !window.isDestroyed()) void snapshot().then(s => window?.webContents.send('forgedesk:snapshot', s)).catch(e => { engineError = String(e); }); }, 60);
}
function onEngineEvent(event: { generation: number; sequence: number; method: string; params: unknown }) {
  const p = asRecord(sanitize(event.params));
  try { store.appendEvent({ ...event, params: sanitize(event.params ?? null) }); }
  catch (e) { persistenceFailed = true; engineError = `事件记录失败: ${e}`; for (const s of store.sessions) s.historyIncomplete = true; }
  const s = store.sessions.find(s => s.threadId === (p.threadId ?? p.thread?.id));
  if (event.method === 'engine/diagnostic') log(typeof p.message === 'string' ? p.message : JSON.stringify(p));
  if (event.method === 'engine/state' && ['failed', 'stopped'].includes(p.state)) {
    snapshotPolicies.clear();
    for (const session of store.sessions) if (['running', 'stopping'].includes(session.status)) { session.status = 'needs_attention'; session.historyIncomplete = true; session.engineUncertain = true; session.turnId = undefined; }
  }
  if (s) {
    const item = asRecord(p.item);
    const itemId = p.itemId ?? item.id;
    if (event.method === 'turn/started') { s.turnId = p.turn?.id; s.status = 'running'; }
    if (event.method === 'item/agentMessage/delta') {
      let message = s.messages.find(m => m.id === itemId);
      if (!message) { message = { id: itemId, role: 'assistant', text: '', timestamp: new Date().toISOString() }; s.messages.push(message); }
      if (message.text.length < 1_000_000) message.text += String(p.delta ?? ''); else s.historyIncomplete = true;
    }
    if (event.method === 'item/commandExecution/outputDelta') {
      let message = s.messages.find(m => m.id === itemId);
      if (!message) { message = { id: itemId, role: 'tool', text: '', timestamp: new Date().toISOString() }; s.messages.push(message); }
      if (message.text.length < 200_000) message.text += String(p.delta ?? '');
    }
    if (event.method === 'item/started' || event.method === 'item/completed') {
      if (item.type !== 'userMessage') {
        let message = s.messages.find(m => m.id === itemId);
        const text = item.type === 'agentMessage' ? item.text : item.command ?? JSON.stringify(item);
        if (!message) { message = { id: itemId, role: item.type === 'agentMessage' ? 'assistant' : 'tool', text: String(text ?? ''), timestamp: new Date().toISOString() }; s.messages.push(message); }
        else if (item.type === 'agentMessage' && item.text) message.text = item.text;
        else if (item.type === 'mcpToolCall' && event.method === 'item/completed') message.text = JSON.stringify(item);
        message.status = item.status ?? (event.method === 'item/completed' ? 'completed' : 'running');
      }
    }
    if (event.method === 'turn/completed') { s.status = p.turn?.status ?? 'needs_attention'; s.engineUncertain = false; s.turnId = undefined; if (p.turn?.error) s.messages.push({ id: randomUUID(), role: 'system', text: redact(JSON.stringify(p.turn.error)), timestamp: new Date().toISOString() }); }
    if (s.messages.length > 3000) { s.messages = s.messages.slice(-3000); s.historyIncomplete = true; }
  }
  if (event.method === 'account/login/completed' || event.method === 'account/updated') void refreshAccount().catch(e => log(`账号状态读取失败: ${e}`));
  try { save(); } catch {}
  publish();
}
async function refreshAccount() {
  if (hardwareMode) return;
  const result = asRecord(await engine.account());
  if (hardwareMode) return;
  account = { loggedIn: Boolean(result.account), label: result.account ? result.account.email ?? result.account.type ?? '已登录' : '未登录' };
  publish();
}
async function connect() {
  assertMainWorkAllowed();
  if (hardwareMode) throw new Error('HARDWARE_CONTROLLED_MODE: 实机模式中禁止启动模型命令');
  const work = (async () => {
  try { engineError = undefined;
    if (store.sessions.some(s => s.engineUncertain)) { await engine.stop(); assertMainWorkAllowed(); for (const s of store.sessions) if (s.engineUncertain) { s.engineUncertain = false; s.status = 'interrupted'; s.turnId = undefined; } save(); }
    assertMainWorkAllowed();
    if (hardwareMode) return;
    await engine.start();
    assertMainWorkAllowed();
    if (hardwareMode) return;
    await refreshAccount();
    assertMainWorkAllowed();
    if (hardwareMode) return;
    const result = asRecord(await engine.models());
    assertMainWorkAllowed();
    if (hardwareMode) return;
    models = (result.data ?? []).map((m: any) => ({ id: m.id ?? m.model, label: m.displayName ?? m.model ?? m.id }));
  } catch (e) { engineError = String(e); log(String(e)); throw e; } finally { publish(); }
  })();
  pendingMainWork.add(work);
  try { await work; } finally { pendingMainWork.delete(work); }
}
function assertMainWorkAllowed() { if (closing || shutdownPending || shutdownFailed || closeWarningOpen) throw new Error('MAIN_SHUTDOWN_HELD: 退出处理期间禁止新任务，请复核状态后手动关闭或维护退出'); }
function ensureWritable() { if (closing || shutdownPending) throw new Error('MAIN_SHUTDOWN_PENDING'); if (persistenceFailed) throw new Error('历史保存失败，必须先恢复存储'); }
function nativeWindow(): BrowserWindow {
  if (closing || !window || window.isDestroyed()) throw new Error('NATIVE_DIALOG_WINDOW_UNAVAILABLE');
  return window;
}
const nativeMessageBox = (options: MessageBoxOptions) => nativeDialogs.run({ kind: 'notice', signal: options.signal }, () => dialog.showMessageBox(nativeWindow(), options));
const nativeOpenDialog = (options: OpenDialogOptions) => nativeDialogs.run({ kind: 'picker' }, () => dialog.showOpenDialog(nativeWindow(), options));
const nativeSaveDialog = (options: SaveDialogOptions) => nativeDialogs.run({ kind: 'picker' }, () => dialog.showSaveDialog(nativeWindow(), options));
async function nativeApproval(signal: AbortSignal | undefined, deadline: number | undefined, body: () => Promise<boolean>): Promise<boolean> {
  try { return await nativeDialogs.run({ kind: 'approval', signal, deadline }, async () => { nativeWindow(); return body(); }); }
  catch (error) { if (error instanceof NativeDialogCancelledError) return false; throw error; }
}
async function assertSoftwareSession(s: Session) {
  const profile = restrictedSessionProfile(s, await hardwareAgent.list(), (await fz3bAgent?.snapshot())?.runs ?? []);
  if (profile) { s.engineProfile = profile; save(); throw new Error('RESTRICTED_SESSION_SOFTWARE_RESUME_DENIED: 请新建软件会话，不重放受限实机线程'); }
}
function assertFz3bAdmission() {
  ensureWritable(); assertNoHardwareAgent();
  if (protectedTasks.size || sendingSessions.size || stoppingSessions.size || store.sessions.some(s => s.engineUncertain || ['running', 'stopping'].includes(s.status))) throw new Error('另一个任务仍在运行');
}
function assertNoHardwareAgent() {
  if (hardwareAgentStarting || hardwareAgentRunId || (hardwareEngine && hardwareEngine.state !== 'stopped') || fz3bAgent?.held || fz3bUnavailableHold || fz3bKeyImporting) throw new Error('HARDWARE_AGENT_ACTIVE');
}
async function readHardwareAccount(adapter: { readonly state: string; account(): Promise<unknown> }) {
  for (let attempt = 0; ; attempt++) {
    try { return asRecord(await adapter.account()); }
    catch (error) {
      if (attempt >= 2 || adapter.state !== 'ready' || !/workspace routing discovery timed out/i.test(String(error))) throw error;
      log('官方账号路由暂时超时，正在重试只读账号检查；尚未发送模型任务或设备操作。');
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
async function requestNativeFlash(taskId: string, key: string, signal?: AbortSignal) {
  const state = await embedded.status(taskId);
  if (state.operations.some(o => o.kind === 'flash' && o.requestKey === key)) return embedded.flash(taskId, key);
  if (signal?.aborted) throw new Error('HARDWARE_AGENT_STOPPED');
  const grant = await embedded.prepareGrant(taskId);
  const approval = new AbortController();
  const abort = () => approval.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) approval.abort();
  const remaining = Date.parse(grant.expiresAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) { signal?.removeEventListener('abort', abort); await embedded.revokeGrants(); throw new Error('设备授权已过期，请重新发起授权'); }
  const timer = setTimeout(abort, remaining);
  let answer: Awaited<ReturnType<typeof dialog.showMessageBox>>;
  try { answer = await nativeDialogs.run({ kind: 'approval', signal: approval.signal, deadline: Date.parse(grant.expiresAt) }, async () => {
    ensureWritable();
    const current = await embedded.status(taskId);
    if (!hardwareMode || engine.state !== 'stopped' || !protectedTasks.has(taskId) || protectedTasks.size !== 1 ||
        getSession(taskId).taskId !== taskId || current.grant?.id !== grant.id || current.grant.hexSha256 !== grant.hexSha256 || current.grant.artifactId !== grant.artifactId || current.grant.consumedBy) throw new Error('HARDWARE_NATIVE_OWNER_CHANGED');
    await verifyHardwareRuntime(hardwareRoot, hardwareWorker);
    if (approval.signal.aborted || signal?.aborted || Date.now() >= Date.parse(grant.expiresAt)) throw new NativeDialogCancelledError('expired');
    return dialog.showMessageBox(nativeWindow(), { type: 'warning', title: 'ForgeDesk 实机烧录授权', signal: approval.signal,
    message: '允许将这份固件写入指定挑战者 V1 板卡？',
    detail: `任务：${getSession(taskId).title}\n探针：${grant.identity.probeSerial}\n芯片 UID：${grant.identity.uid}\n固件 SHA-256：${grant.hexSha256}\nBuild ID：${grant.buildId}\n授权到期：${grant.expiresAt}\n仅本次产物和设备；按需扇区擦写、读回校验、复位运行。不修改选项字节或外部存储。`,
    buttons: ['取消', '授权并烧录'], defaultId: 0, cancelId: 0, noLink: true,
    checkboxLabel: '我已确认目标为当前连接的野火 STM32F429IGT6 挑战者 V1', checkboxChecked: false }); }); }
  catch (error) { await embedded.revokeGrants(); if (error instanceof NativeDialogCancelledError) throw new Error('设备授权已取消或过期，未启动烧录'); throw error; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  if (approval.signal.aborted || signal?.aborted || Date.now() >= Date.parse(grant.expiresAt)) { await embedded.revokeGrants(); throw new Error('设备授权已取消或过期，未启动烧录'); }
  if (answer.response !== 1 || !answer.checkboxChecked) { await embedded.revokeGrants(); return embedded.status(taskId); }
  // Recheck the packaged runtime after the human wait, before accepting the grant.
  await verifyHardwareRuntime(hardwareRoot, hardwareWorker);
  if (signal?.aborted) { await embedded.revokeGrants(); throw new Error('HARDWARE_AGENT_STOPPED'); }
  await embedded.approveGrant(taskId, grant.id);
  if (signal?.aborted) { await embedded.revokeGrants(); throw new Error('HARDWARE_AGENT_STOPPED'); }
  return embedded.flash(taskId, key);
}
function finishHardwareAgent(runId: string): Promise<void> {
  if (hardwareAgentRunId === runId) hardwareFinishRequested.add(runId);
  const pending = hardwareFinalizers.get(runId);
  if (pending) return pending;
  const owningEngine = hardwareEngine;
  const finish = (async () => {
    if (hardwareAgentRunId !== runId || !owningEngine || hardwareAgentRecovering === runId) return;
    const run = await hardwareAgent.turnEnded(runId);
    if (run.hardwareBusy || !(await hardwareAgent.quiescence(runId)).quiescent) { publish(); return; }
    if (hardwareAgentRunId !== runId || hardwareEngine !== owningEngine || hardwareAgentRecovering === runId) return;
    await owningEngine.stop();
    if (owningEngine.state !== 'stopped') throw new Error('HARDWARE_ENGINE_EXIT_UNCONFIRMED');
    if (hardwareAgentRunId !== runId || hardwareEngine !== owningEngine || hardwareAgentRecovering === runId) return;
    const current = await hardwareAgent.status(runId);
    if (!current || current.hardwareBusy || !(await hardwareAgent.quiescence(runId)).quiescent) { publish(); return; }
    const s = getSession(run.sessionId);
    s.status = current.status === 'completed' ? 'completed' : current.status === 'stopped' ? 'interrupted' : 'needs_attention';
    s.turnId = undefined; s.engineUncertain = false;
    save();
    protectedTasks.delete(run.taskId);
    hardwareAgentRunId = undefined; hardwareAgentTaskId = undefined;
    cancelledHardwareStarts.delete(runId);
    hardwareFinishRequested.delete(runId);
    publish();
  })().finally(() => hardwareFinalizers.delete(runId));
  hardwareFinalizers.set(runId, finish);
  return finish;
}
function onHardwareEngineEvent(runId: string, owningEngine: RestrictedHardwareAdapter, event: { generation: number; sequence: number; method: string; params: unknown }) {
  if (hardwareAgentRunId !== runId || hardwareEngine !== owningEngine || event.generation !== owningEngine.connectionGeneration) return;
  const p = asRecord(event.params);
  const s = store.sessions.find(item => item.taskId === hardwareAgentTaskId);
  const threadId = p.threadId ?? p.thread?.id;
  if (threadId && s?.threadId && threadId !== s.threadId) return;
  if (event.method === 'turn/completed' && s?.turnId && p.turn?.id !== s.turnId) return;
  if (event.method === 'turn/completed') {
    try { store.appendEvent({ ...event, params: sanitize(event.params) }); } catch (error) { persistenceFailed = true; log(String(error)); }
    if (p.turn?.error && s) s.messages.push({ id: randomUUID(), role: 'system', text: redact(JSON.stringify(p.turn.error)), timestamp: new Date().toISOString() });
    void finishHardwareAgent(runId).catch(error => log(`实机模型结束状态待复核: ${error}`));
  } else if (event.method === 'engine/state') {
    const state = asRecord(event.params).state;
    if (state === 'failed') void hardwareAgent.turnEnded(runId).then(() => hardwareAgent.stop(runId)).finally(() => owningEngine.stop()).then(() => finishHardwareAgent(runId)).catch(error => log(String(error)));
    publish();
  } else if (!event.method.startsWith('account/')) onEngineEvent(event);
}
function setHardwareMode(active: boolean) {
  const target = path.join(dataDir, 'hardware-mode.json');
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ schemaVersion: 1, active, updatedAt: new Date().toISOString() }));
  const fd = openSync(temp, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, target);
  hardwareMode = active;
  publish();
}
async function hardwareTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  assertNoHardwareAgent();
  ensureWritable(); getSession(taskId);
  if (!hardwareMode || engine.state !== 'stopped') throw new Error('HARDWARE_CONTROLLED_MODE_REQUIRED');
  if (protectedTasks.size || sendingSessions.size || stoppingSessions.size || store.sessions.some(s => s.engineUncertain || ['running', 'stopping'].includes(s.status))) throw new Error('另一个任务仍在运行');
  protectedTasks.add(taskId);
  try { await verifyHardwareRuntime(hardwareRoot, hardwareWorker); return await operation(); }
  finally { protectedTasks.delete(taskId); publish(); }
}
function projectBusy(projectId: string) { return store.sessions.some(s => s.projectId === projectId && (s.engineUncertain || protectedTasks.has(s.taskId) || sendingSessions.has(s.id) || stoppingSessions.has(s.id) || ['running', 'stopping'].includes(s.status))); }
async function refreshPassedEvidence() {
  for (const task of await runner.listTasks()) if (task.evidence.some(e => e.result === 'passed') && !protectedTasks.has(task.id)) await runner.refresh(task.id);
}
function scheduleEvidenceRefresh() {
  evidenceTimer = setTimeout(() => { if (!closing) void refreshPassedEvidence().catch(e => log(`证据复核失败: ${e}`)).finally(scheduleEvidenceRefresh); }, 5000);
  evidenceTimer.unref?.();
}

async function probeTaskSnapshot(taskId: string, nodeExecutable: string) {
  const s = getSession(taskId);
  const project = getProject(s.projectId);
  if (engine.state !== 'ready') await connect();
  const protectedRoot = path.join(dataDir, 'engineering', 'snapshots');
  mkdirSync(protectedRoot, { recursive: true });
  const policy = await engine.snapshotPolicy(project.root);
  const receipt = await probeSnapshotIsolation({ projectRoot: project.root, protectedRoot, dataDir,
    home: path.join(dataDir, 'engine'), executable: enginePath, processHost: processHostPath,
    nodeExecutable, policy, currentGeneration: () => engine.connectionGeneration });
  snapshotPolicies.set(project.root.toLowerCase(), receipt.policyDigest);
  return receipt;
}

async function runSnapshotBuild(taskId: string, requestKey: string, fromModel = false) {
  ensureWritable();
  const s = getSession(taskId);
  requestKey = checkedText(requestKey, 200);
  if (!requestKey.trim()) throw new Error('快照构建需要非空 requestKey');
  const task = await runner.getTask(taskId);
  assertNoHardwareAgent();
  const pendingKey = `${taskId}\0${requestKey}`;
  const pending = snapshotBuilds.get(pendingKey);
  if (pending) return pending;
  const profile = task.snapshotProfile;
  if (!profile) throw new Error('NO_APPROVED_BUILD_PROFILE');
  // Durable retries return the recorded operation before any new probe or filesystem work.
  if (task.operations.some(operation => operation.requestKey === requestKey)) return runner.runSnapshotBuild(taskId, requestKey);
  if (protectedTasks.has(taskId) || stoppingSessions.size || (!fromModel && projectBusy(s.projectId))) throw new Error('工程执行期间不能启动另一轮快照构建');
  protectedTasks.add(taskId);
  const operation = (async () => {
    const isolation = await probeTaskSnapshot(taskId, profile.nodeExecutable);
    return await runner.runSnapshotBuild(taskId, requestKey, isolation);
  })().finally(() => { protectedTasks.delete(taskId); snapshotBuilds.delete(pendingKey); publish(); });
  snapshotBuilds.set(pendingKey, operation);
  return operation;
}

const handlers: Record<string, (...args: any[]) => Promise<unknown>> = {
  snapshot,
  connect,
  async login() { if (engine.state !== 'ready') await connect(); const result = asRecord(await engine.login()); if (!result.authUrl) throw new Error('登录服务未返回授权地址'); const url = new URL(result.authUrl); if (url.protocol !== 'https:' || !['auth.openai.com', 'auth0.openai.com', 'chatgpt.com'].includes(url.hostname)) throw new Error('拒绝未知登录地址'); await shell.openExternal(url.toString()); log('官方登录已打开，等待账号授权'); },
  async importProject() { ensureWritable(); const result = await nativeOpenDialog({ properties: ['openDirectory'] }); if (result.canceled) return null; ensureWritable(); assertNoHardwareAgent(); const root = assertProjectDataSeparation(result.filePaths[0]); const existing = store.projects.find(p => p.root.toLowerCase() === root.toLowerCase()); if (existing) return existing; const project = { id: randomUUID(), name: path.basename(root), root }; store.projects.push(project); save(); publish(); return project; },
  async createSession(projectId, title) { ensureWritable(); const project = getProject(projectId); const id = randomUUID(); const s: Session = { id, projectId, title: checkedText(title, 160) || '新任务', status: 'draft', messages: [], taskId: id }; await runner.createTask({ id, projectRoot: project.root, sessionId: id, title: s.title }); store.sessions.push(s); save(); publish(); return s; },
  async send(sessionId, text, model) {
    if (hardwareMode) throw new Error('HARDWARE_CONTROLLED_MODE: 实机模式中禁止模型 shell/工具执行');
    ensureWritable(); text = checkedText(text, 100000); if (!text.trim()) throw new Error('请输入任务'); const s = getSession(sessionId); await assertSoftwareSession(s);
    if (hardwareMode) throw new Error('HARDWARE_CONTROLLED_MODE');
    assertNoHardwareAgent();
    const project = getProject(s.projectId); if (store.sessions.some(s => s.engineUncertain)) throw new Error('上次回合结果未知，请在设置中重新连接引擎以确认进程已停止'); if (sendingSessions.size || stoppingSessions.size || protectedTasks.size || store.sessions.some(s => ['running', 'stopping'].includes(s.status))) throw new Error('首版同时运行一个任务，请等待当前任务完成'); sendingSessions.add(s.id);
    let attemptedTurn = false;
    try {
      if (engine.state !== 'ready') await connect();
      if (!account.loggedIn) throw new Error('请先登录 ForgeDesk 的独立账号');
      const task = await runner.getTask(s.taskId);
      assertMainWorkAllowed(); assertProjectDataSeparation(project.root);
      const snapshotContext = task.snapshotProfile ? `engineering.build uses only the approved ${task.snapshotProfile.id} template, snapshot profileRevision=${task.snapshotProfile.revision}, taskId and a unique requestKey; it builds and verifies numbers.mjs from a task-owned snapshot. The snapshot-software verifier must use engineering.build, not engineering.test.` : 'engineering.build has no configured profile yet.';
      const context = `ForgeDesk engineering context: projectId=${s.projectId}; taskId=${s.taskId}; profileId=software; profileRevision=${task.profileRevision}. Stored verifier IDs: ${task.acceptance.filter(a => a.kind === 'automated' && a.id !== 'snapshot-software').map(a => a.id).join(', ') || '(none)'}. Only runner evidence determines acceptance. Hardware is unavailable. Never alter verifier definitions or product data. Use engineering.test with this taskId, a stored verifierId, and a new requestKey for each intended check after edits; reuse that key only to retry the same invocation. ${snapshotContext}`;
      if (!s.threadId) { const result = asRecord(await engine.startThread(project.root, model, context)); s.threadId = result.thread?.id; if (!s.threadId) throw new Error('引擎未返回会话 ID'); }
      else await engine.resumeThread(s.threadId, project.root, context);
      s.model = model; s.status = 'running';
      s.messages.push({ id: randomUUID(), role: 'user', text: redact(text), timestamp: new Date().toISOString() }); save(); publish();
      attemptedTurn = true;
      const result = asRecord(await engine.send(s.threadId!, text, model));
      if (s.status === 'running') { s.turnId = result.turn?.id; s.status = result.turn?.status === 'inProgress' ? 'running' : result.turn?.status ?? 'running'; }
      save();
    } catch (e) { if (attemptedTurn && !['completed', 'failed', 'interrupted'].includes(s.status)) { s.status = 'needs_attention'; s.engineUncertain = true; s.historyIncomplete = true; } else if (!attemptedTurn) s.status = 'failed'; save(); throw e; } finally { sendingSessions.delete(s.id); publish(); }
  },
  async steer(sessionId, text) { if (hardwareMode) throw new Error('HARDWARE_CONTROLLED_MODE'); const s = getSession(sessionId); await assertSoftwareSession(s); if (hardwareMode) throw new Error('HARDWARE_CONTROLLED_MODE'); assertNoHardwareAgent(); if (stoppingSessions.size || !s.threadId || !s.turnId || s.status !== 'running') throw new Error('当前没有可追加的回合，输入尚未送达'); await engine.steer(s.threadId, s.turnId, checkedText(text, 100000)); s.messages.push({ id: randomUUID(), role: 'user', text: redact(text), status: 'steered', timestamp: new Date().toISOString() }); save(); publish(); },
  async interrupt(sessionId) {
    const s = getSession(sessionId);
    if (stoppingSessions.size || !s.threadId || !s.turnId) throw new Error('当前没有活动回合，或停止操作尚未结束');
    stoppingSessions.add(s.id); s.status = 'stopping'; publish();
    let cleanupConfirmed = false;
    try {
      await engine.interrupt(s.threadId, s.turnId);
      // The pinned engine can report interruption before its shell exits. Close the owning Job Object.
      await engine.stop(); cleanupConfirmed = true;
      if (!['completed', 'failed', 'interrupted'].includes(s.status)) { s.status = 'interrupted'; s.historyIncomplete = true; }
      for (const message of s.messages) if (message.role === 'tool' && ['running', 'inProgress', 'stopping'].includes(message.status ?? '')) {
        message.status = 'interrupted'; s.historyIncomplete = true;
      }
      s.engineUncertain = false; s.turnId = undefined; save();
      log('停止回合后已回收引擎进程树；重连不会重放原操作。独立验证操作仍需单独停止。');
      if (!closing && !shutdownPending && !shutdownFailed) await connect();
    } catch (e) {
      if (!cleanupConfirmed) { s.status = 'needs_attention'; s.engineUncertain = true; s.historyIncomplete = true; }
      throw e;
    } finally { stoppingSessions.delete(s.id); save(); publish(); }
  },
  async approve(generation, id, decision) { if (stoppingSessions.size) throw new Error('引擎正在停止，审批已暂停'); await engine.approve(generation, id, decision); publish(); },
  async diff(projectId) { const project = getProject(projectId); try { const tracked = await exec('git', ['-C', project.root, 'diff', 'HEAD', '--no-ext-diff', '--no-textconv'], { windowsHide: true, maxBuffer: 2_000_000, timeout: 15000 }); const untracked = await exec('git', ['-C', project.root, 'ls-files', '--others', '--exclude-standard'], { windowsHide: true, maxBuffer: 200000, timeout: 15000 }); return { text: (tracked.stdout + (untracked.stdout ? '\nUntracked files:\n' + untracked.stdout : '')).slice(0, 500000), truncated: tracked.stdout.length > 500000 }; } catch (e) { throw new Error(`无法读取 Git 差异: ${redact(String(e))}`); } },
  async setAcceptance(taskId, items) { ensureWritable(); const s = getSession(taskId); if (projectBusy(s.projectId)) throw new Error('工程执行期间不能更改验收规则'); if (!Array.isArray(items) || items.length > 10) throw new Error('验收项须为不超过10项的列表'); await runner.setAcceptance(taskId, items); publish(); },
  async enableSnapshot(taskId) {
    ensureWritable(); const s = getSession(taskId);
    if (projectBusy(s.projectId)) throw new Error('工程执行期间不能更改快照模板');
    protectedTasks.add(taskId);
    try {
      const result = await nativeOpenDialog({ title: '选择 Node.js 24 的 node.exe', properties: ['openFile'], filters: [{ name: 'Node.js executable', extensions: ['exe'] }] });
      if (result.canceled) return;
      ensureWritable(); assertNoHardwareAgent();
      const nodeExecutable = realpathSync(result.filePaths[0]);
      const relativeNode = path.relative(getProject(s.projectId).root, nodeExecutable);
      if (!relativeNode.startsWith(`..${path.sep}`) && relativeNode !== '..' && !path.isAbsolute(relativeNode)) throw new Error('Node.js 必须位于模型工程目录之外');
      const isolation = await probeTaskSnapshot(taskId, nodeExecutable);
      await runner.setSnapshotProfile(taskId, { id: 'forgedesk.node-software.v1', nodeExecutable, isolation });
    } finally { protectedTasks.delete(taskId); publish(); }
  },
  async runSnapshotBuild(taskId, requestKey) { await runSnapshotBuild(taskId, requestKey); },
  async runAcceptance(taskId, acceptanceId, requestKey) { ensureWritable(); const s = getSession(taskId); if (projectBusy(s.projectId)) throw new Error('工程执行期间不能启动另一轮验证'); const task = await runner.getTask(taskId); const item = task?.acceptance.find((a: any) => a.id === acceptanceId); if (!item?.command || item.kind !== 'automated') throw new Error('该验收项没有固定自动验证命令'); assertNoHardwareAgent(); protectedTasks.add(taskId); try { await runner.run({ taskId, requestKey: checkedText(requestKey, 200), command: item.command, kind: 'test', acceptanceId }); } finally { protectedTasks.delete(taskId); publish(); } },
  async refreshEvidence(taskId) { getSession(taskId); await runner.refresh(taskId); publish(); },
  async readOperationLog(taskId, operationId) { getSession(taskId); const task = await runner.getTask(taskId); const operation = task.operations.find(o => o.id === operationId); if (!operation) throw new Error('操作不属于当前任务'); if (!operation.logRef || !existsSync(operation.logRef)) return '日志将在执行结束后保存。'; const allowed = path.join(dataDir, 'engineering', 'logs'); const actual = realpathSync(operation.logRef); const rel = path.relative(allowed, actual); if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('日志路径超出允许范围'); return redact(readFileSync(actual, 'utf8').slice(0, 262144)); },
  async cancelOperation(taskId, operationId) { getSession(taskId); const task = await runner.getTask(taskId); if (!task.operations.some(o => o.id === operationId)) throw new Error('操作不属于当前任务'); await runner.cancel(operationId); publish(); },
  async exportTask(taskId) { getSession(taskId); await runner.refresh(taskId); const result = await nativeOpenDialog({ defaultPath: path.join(dataDir, 'exports'), properties: ['openDirectory', 'createDirectory'] }); if (result.canceled) return null; ensureWritable(); assertNoHardwareAgent(); const destination = path.join(result.filePaths[0], `ForgeDesk-${taskId}-${Date.now()}`); await runner.exportTask(taskId, destination); return destination; },
  async exportDiagnostics() { const result = await nativeSaveDialog({ defaultPath: path.join(dataDir, 'forgedesk-diagnostics.json'), filters: [{ name: 'JSON', extensions: ['json'] }] }); if (!result.filePath) return null; ensureWritable(); assertNoHardwareAgent(); writeFileSync(result.filePath, JSON.stringify({ schemaVersion: 1, version: app.getVersion(), engineState: engine.state, engineError: redact(engineError ?? ''), platform: process.platform, arch: process.arch, diagnostics }, null, 2)); return result.filePath; },
  async openProject(projectId) { const result = await shell.openPath(getProject(projectId).root); if (result) throw new Error(result); }
  ,async hardwareSnapshot(taskId) { getSession(taskId); return embedded.status(taskId); }
  ,async hardwareConfigure(taskId) {
    assertNoHardwareAgent();
    ensureWritable(); const s = getSession(taskId);
    if (protectedTasks.size || sendingSessions.size || stoppingSessions.size || store.sessions.some(s => s.engineUncertain || ['running', 'stopping'].includes(s.status))) throw new Error('请先结束当前任务再进入实机模式');
    protectedTasks.add(taskId);
    try {
      await verifyHardwareRuntime(hardwareRoot, hardwareWorker);
      await embedded.assertIdle();
      // Persist the shell gate before stopping the engine; a failed stop stays closed.
      setHardwareMode(true);
      await engine.stop();
      if (engine.state !== 'stopped') throw new Error('引擎退出未确认，不能连接设备');
      await embedded.revokeGrants();
      return await embedded.configure(taskId, getProject(s.projectId).root, { keilExecutable: 'D:/STSoft/Keil5/UV4/UV4.exe' });
    } finally { protectedTasks.delete(taskId); publish(); }
  }
  ,async hardwareBuild(taskId, key) { return hardwareTask(taskId, () => embedded.build(taskId, checkedText(key, 200))); }
  ,async hardwareInspect(taskId, key) { return hardwareTask(taskId, () => embedded.inspect(taskId, checkedText(key, 200))); }
  ,async hardwareFlash(taskId, key) {
    key = checkedText(key, 200);
    return hardwareTask(taskId, () => requestNativeFlash(taskId, key));
  }
  ,async hardwareVerify(taskId, key) { return hardwareTask(taskId, () => embedded.verify(taskId, checkedText(key, 200))); }
  ,async hardwareRecover(taskId) {
    ensureWritable(); const s = getSession(checkedText(taskId, 200));
    const runId = hardwareAgentRunId;
    if (runId) {
      const owningEngine = hardwareEngine;
      if (hardwareAgentRecovering) throw new Error('HARDWARE_AGENT_RECOVERY_PENDING');
      const assertOwner = () => {
        if (hardwareAgentStarting || !hardwareMode || engine.state !== 'stopped' || !owningEngine ||
            hardwareAgentRunId !== runId || hardwareAgentTaskId !== taskId || hardwareEngine !== owningEngine ||
            protectedTasks.size !== 1 || !protectedTasks.has(taskId) || sendingSessions.size || stoppingSessions.size ||
            store.sessions.some(item => item.id !== s.id && (item.engineUncertain || ['running', 'stopping'].includes(item.status)))) throw new Error('HARDWARE_AGENT_RECOVERY_OWNER_MISMATCH');
      };
      const assertQuiet = async () => {
        assertOwner();
        const quiet = await hardwareAgent.quiescence(runId);
        assertOwner();
        if (quiet.taskId !== taskId || quiet.sessionId !== s.id || quiet.active || !quiet.stopRequested || !quiet.quiescent) throw new Error('HARDWARE_AGENT_RECOVERY_NOT_QUIESCENT');
      };
      hardwareAgentRecovering = runId;
      try {
        await assertQuiet();
        // A retry confirms only the captured engine's exit; it never starts a model or replays a tool.
        await owningEngine!.stop();
        if (owningEngine!.state !== 'stopped') throw new Error('HARDWARE_ENGINE_EXIT_UNCONFIRMED');
        await assertQuiet();
        await verifyHardwareRuntime(hardwareRoot, hardwareWorker);
        await assertQuiet();
        if (owningEngine!.state !== 'stopped') throw new Error('HARDWARE_ENGINE_EXIT_UNCONFIRMED');
        await embedded.recover();
        await embedded.assertIdle();
        await assertQuiet();
        await hardwareAgent.checkpointRecovery(runId);
        await assertQuiet();
        if ((await hardwareAgent.status(runId))?.hardwareBusy !== false) throw new Error('HARDWARE_AGENT_RECOVERY_STILL_HELD');
        const recovered = await embedded.status(taskId);
        hardwareAgentRecovering = undefined;
        await finishHardwareAgent(runId);
        if (hardwareAgentRunId === runId) throw new Error('HARDWARE_AGENT_RECOVERY_STILL_HELD');
        return recovered;
      } finally { if (hardwareAgentRecovering === runId) hardwareAgentRecovering = undefined; publish(); }
    }
    assertNoHardwareAgent();
    if (!hardwareMode || protectedTasks.size) throw new Error('恢复检查需要空闲的工程受控模式');
    protectedTasks.add(taskId);
    try { await verifyHardwareRuntime(hardwareRoot, hardwareWorker); await embedded.recover(); return await embedded.status(taskId); }
    finally { protectedTasks.delete(taskId); publish(); }
  }
  ,async hardwareExport(taskId) {
    assertNoHardwareAgent();
    getSession(taskId);
    const result = await nativeOpenDialog({ defaultPath: path.join(dataDir, 'exports'), properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return null;
    ensureWritable(); assertNoHardwareAgent();
    const destination = path.join(result.filePaths[0], `ForgeDesk-T2-${taskId}-${Date.now()}`);
    await embedded.export(taskId, destination); return destination;
  }
  ,async hardwareLeaveMode() {
    assertNoHardwareAgent();
    if (protectedTasks.size || sendingSessions.size || stoppingSessions.size) throw new Error('仍有操作未结束');
    await embedded.assertIdle(); await fz3bAgent?.assertIdle(); await embedded.revokeGrants(); setHardwareMode(false); await connect();
  }
  ,async hardwareAgentStart(taskId, instruction, model) {
    ensureWritable(); assertNoHardwareAgent();
    instruction = checkedText(instruction, 12000);
    if (!instruction.trim()) throw new Error('请输入实机任务');
    if (model !== 'gpt-6.1-sol') throw new Error('HARDWARE_MODEL_NOT_PINNED');
    const s = getSession(checkedText(taskId, 200));
    if (s.threadId || s.messages.length || (await hardwareAgent.list()).some(run => run.taskId === taskId)) throw new Error('实机模型任务需要新的空白会话，不能重放历史任务');
    if (protectedTasks.size || sendingSessions.size || stoppingSessions.size || store.sessions.some(item => item.engineUncertain || ['running', 'stopping'].includes(item.status))) throw new Error('另一个任务仍在运行');
    hardwareAgentStarting = true;
    hardwareAgentPolicy = undefined;
    protectedTasks.add(taskId);
    let started = false;
    try {
      await verifyHardwareRuntime(hardwareRoot, hardwareWorker);
      await embedded.assertIdle();
      setHardwareMode(true);
      await engine.stop();
      if (engine.state !== 'stopped') throw new Error('普通引擎退出未确认');
      await embedded.revokeGrants();
      const configured = await embedded.configure(taskId, getProject(s.projectId).root, { keilExecutable: 'D:/STSoft/Keil5/UV4/UV4.exe' });
      if (configured.operations.length) throw new Error('实机模型任务必须使用尚无设备操作的新任务');
      const runId = randomUUID();
      const owningEngine: RestrictedHardwareAdapter = new RestrictedHardwareAdapter({ executable: enginePath, home: path.join(dataDir, 'engine'), processHost: processHostPath,
        onEvent: event => onHardwareEngineEvent(runId, owningEngine, event),
        onToolCall: async (context, name, args) => {
          if (hardwareAgentRunId !== runId || hardwareAgentTaskId !== taskId) throw new Error('HARDWARE_AGENT_OWNER_MISMATCH');
          await hardwareAgent.bindTurn(runId, context);
          try { return await hardwareAgent.executeTool({ ...context, runId, sessionId: s.id, taskId }, name, args); }
          finally {
            const current = await hardwareAgent.status(runId);
            if (current && (current.stopRequested || hardwareFinishRequested.has(runId)) && !current.hardwareBusy) {
              // A prior finalizer may have returned while this tool was still settling.
              void Promise.resolve(hardwareFinalizers.get(runId)).then(() => {
                if (hardwareAgentRunId === runId) return finishHardwareAgent(runId);
              }).catch(error => log(String(error)));
            }
          }
        } });
      hardwareEngine = owningEngine;
      await hardwareEngine.start();
      hardwareAgentPolicy = hardwareEngine.policySnapshot();
      const publicAccount = await readHardwareAccount(hardwareEngine);
      account = { loggedIn: Boolean(publicAccount.account), label: publicAccount.account ? publicAccount.account.email ?? publicAccount.account.type ?? '已登录' : '未登录' };
      if (!account.loggedIn) throw new Error('请先退出实机模式，在设置中完成官方登录');
      const context = 'You are the ForgeDesk fixed-board hardware agent. Use only the provided embedded tools. Call embedded_status, embedded_build, embedded_inspect, embedded_request_flash, embedded_verify, then embedded_export, in that order. Each accepts only {}. Build uses the approved Keil background profile. Flash requires separate native operator authorization; never claim or fabricate authorization. Stop after any failure, cancellation, unknown outcome or refusal. Do not retry a write. Only host receipts establish success. Do not claim visual, gesture accuracy, or peripheral tests beyond the fixed verifier.';
      const threadId = await hardwareEngine.startThread(model, context);
      s.engineProfile = 'stm32';
      hardwareAgentRunId = runId; hardwareAgentTaskId = taskId;
      const run = await hardwareAgent.start({ runId, sessionId: s.id, taskId, model, generation: hardwareEngine.connectionGeneration, threadId, instruction: redact(instruction) });
      started = true;
      if (cancelledHardwareStarts.has(runId) || owningEngine.state !== 'ready') throw new Error('HARDWARE_AGENT_START_CANCELLED');
      s.threadId = threadId; s.model = model; s.status = 'running';
      s.messages.push({ id: randomUUID(), role: 'user', text: redact(instruction), timestamp: new Date().toISOString() });
      save(); publish();
      await hardwareEngine.send(threadId, instruction, model);
      return (await hardwareAgent.status(runId))!;
    } catch (error) {
      if (started && hardwareAgentRunId) {
        const failedRun = hardwareAgentRunId;
        try { await hardwareAgent.turnEnded(failedRun); await hardwareAgent.stop(failedRun); } finally { await hardwareEngine?.stop(); }
        await finishHardwareAgent(failedRun);
      }
      else { await hardwareEngine?.stop(); protectedTasks.delete(taskId); hardwareAgentRunId = undefined; hardwareAgentTaskId = undefined; }
      s.status = 'needs_attention'; save(); throw error;
    } finally { hardwareAgentStarting = false; publish(); }
  }
  ,async hardwareAgentStop(runId) {
    if (runId !== hardwareAgentRunId) throw new Error('HARDWARE_AGENT_OWNER_MISMATCH');
    cancelledHardwareStarts.add(runId);
    const owningEngine = hardwareEngine;
    let run;
    try { run = await hardwareAgent.stop(runId); } finally { await owningEngine?.stop(); }
    if (!run.hardwareBusy) await finishHardwareAgent(runId);
    else log('模型规划已停止；设备操作仍由宿主持锁运行，请等待回执。');
    return (await hardwareAgent.status(runId))!;
  }
  ,async fz3bSnapshot(taskId) { getSession(checkedText(taskId, 200)); return fz3bAgent ? fz3bAgent.taskSnapshot(taskId) : null; }
  ,async fz3bAgentStart(taskId, instruction, model) {
    ensureWritable();
    if (!fz3bAgent) throw new Error(fz3bAvailability.reason ?? 'FZ3B_RUNTIME_UNAVAILABLE');
    fz3bAvailability = await checkFz3bAvailability(fz3bResourceRoot, dataDir);
    if (!fz3bAvailability.available) { publish(); throw new Error(fz3bAvailability.reason ?? 'FZ3B_RUNTIME_UNAVAILABLE'); }
    return fz3bAgent.start(taskId, instruction, model);
  }
  ,async fz3bAgentStop(runId) {
    ensureWritable(); if (!fz3bAgent) throw new Error('FZ3B_RUNTIME_UNAVAILABLE');
    return fz3bAgent.stop(runId);
  }
  ,async fz3bRecover(taskId) {
    ensureWritable(); getSession(checkedText(taskId, 200));
    if (hardwareAgentStarting || hardwareAgentRunId || hardwareEngine && hardwareEngine.state !== 'stopped' || sendingSessions.size || stoppingSessions.size) throw new Error('HARDWARE_AGENT_ACTIVE');
    if (!hardwareMode || engine.state !== 'stopped' || protectedTasks.size && !protectedTasks.has(taskId) || store.sessions.some(s => s.taskId !== taskId && (s.engineUncertain || ['running', 'stopping'].includes(s.status)))) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    if (!fz3bAgent || fz3bUnavailableHold) throw new Error(fz3bAvailability.reason ?? 'FZ3B_RUNTIME_UNAVAILABLE_HELD');
    if (!fz3bAgent.activeRunId) {
      const current = await fz3bAgent.snapshot();
      if (current.recoveryTaskId !== taskId || !fz3bNoRunRecoveryIdle(taskId, (await runner.listTasks()) as unknown as TaskView[])) throw new Error('FZ3B_RECOVERY_OWNER_REQUIRED');
    }
    const result = await fz3bAgent.recover(taskId); publish(); return result;
  }
  ,async fz3bReconcileInspect(runId) {
    ensureWritable(); checkedText(runId, 200);
    if (!fz3bAgent || fz3bUnavailableHold || fz3bHostActionRunId) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    fz3bHostActionRunId = runId; publish();
    try { return await fz3bAgent.reconcileInspect(runId); }
    finally { fz3bHostActionRunId = undefined; publish(); }
  }
  ,async fz3bMaintenanceExit(runId) {
    if (fz3bHostStartupReadOnly) throw new Error('FZ3B_STARTUP_READONLY');
    ensureWritable(); checkedText(runId, 200);
    if (!fz3bAgent || fz3bUnavailableHold || fz3bHostActionRunId) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    fz3bHostActionRunId = runId; publish();
    try {
      if (fz3bAgent.requiresHostCompletion(runId)) {
        const proof = await fz3bAgent.prepareHostMaintenanceExit(runId);
        const created = Date.now();
        const context: Fz3bHostLocalConfirmation = { schemaVersion: 1, action: 'maintenance-exit', nonce: randomBytes(32).toString('hex'),
          createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString(), proof };
        const sameProof = fz3bCanonicalJson(proof);
        const confirmOwner = () => fz3bAgent!.assertRecoveryOwner(proof.completion.owner);
        const freshProof = async () => {
          const current = await fz3bAgent!.prepareHostMaintenanceExit(runId);
          if (fz3bCanonicalJson(current) !== sameProof || Date.now() < created || Date.now() >= created + 300000) throw new Error('FZ3B_HOST_LOCAL_EXIT_PROOF_CHANGED_OR_EXPIRED');
          fz3bAgent!.assertHostLocalProof(current);
        };
        const confirmed = await nativeApproval(undefined, Date.parse(context.expiresAt), () => requestNativeFz3bHostLocalAction(context, {
          show: options => dialog.showMessageBox(nativeWindow(), options), assertOwner: confirmOwner,
        }));
        if (!confirmed) return;
        await freshProof();
        if (nativeDialogs.busy) throw new Error('NATIVE_DIALOG_PENDING');
        // No save, terminalization, certificate write, backend seal or ownership release here.
        await bridge?.close(); await embedded.close();
        assertRunnerLifecycleOwner(dataDir); await runner.close();
        await freshProof();
        if (engine.state !== 'stopped' || hardwareEngine && hardwareEngine.state !== 'stopped' || fz3bAgent.engineState !== 'stopped') throw new Error('FZ3B_MAINTENANCE_ENGINE_EXIT_UNCONFIRMED');
        closing = true;
        if (evidenceTimer) clearTimeout(evidenceTimer);
        nativeDialogs.close(); window?.destroy(); app.quit();
        return;
      }
      const seal = await fz3bAgent.prepareMaintenanceExit(runId);
      const owner = (await fz3bAgent.snapshot()).runs.find(run => run.runId === runId);
      if (!owner) throw new Error('FZ3B_RECOVERY_RECORD_MISSING');
      const confirmed = await nativeApproval(undefined, undefined, async () => { await verifyFz3bResources(fz3bResourceRoot); return requestNativeFz3bMaintenanceExit(seal, owner, {
        show: options => dialog.showMessageBox(nativeWindow(), options),
        assertOwner: async value => {
          if (value.runId !== owner.runId || value.taskId !== owner.taskId || value.sessionId !== owner.sessionId) throw new Error('FZ3B_RECOVERY_OWNER_MISMATCH');
          await fz3bAgent!.assertRecoveryOwner(owner);
        },
      }); });
      if (!confirmed) return;
      // Re-seal actual local close facts after the human wait; the old unknown remains held.
      await fz3bAgent.prepareMaintenanceExit(runId);
      await fz3bAgent.assertRecoveryOwner(owner);
      if (nativeDialogs.busy) throw new Error('NATIVE_DIALOG_PENDING');
      save(); closing = true;
      try {
        await bridge?.close(); await embedded.close(); await runner.close();
        if (engine.state !== 'stopped' || hardwareEngine && hardwareEngine.state !== 'stopped' || fz3bAgent.engineState !== 'stopped') throw new Error('FZ3B_MAINTENANCE_ENGINE_EXIT_UNCONFIRMED');
        save();
      } catch (error) { closing = false; throw error; }
      if (evidenceTimer) clearTimeout(evidenceTimer);
      nativeDialogs.close(); window?.destroy(); app.quit();
    } finally { fz3bHostActionRunId = undefined; publish(); }
  }
  ,async fz3bReconcilePreflightRefusedInspect(runId) {
    if (fz3bHostStartupReadOnly) throw new Error('FZ3B_STARTUP_READONLY');
    ensureWritable(); checkedText(runId, 200);
    if (!fz3bAgent || fz3bUnavailableHold || fz3bHostActionRunId) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    fz3bHostActionRunId = runId; publish();
    try { return await fz3bAgent.reconcilePreflightRefusedInspect(runId); }
    finally { fz3bHostActionRunId = undefined; publish(); }
  }
  ,async fz3bQuarantineEmptyHostHome(runId) {
    if (fz3bHostStartupReadOnly) throw new Error('FZ3B_STARTUP_READONLY');
    ensureWritable(); checkedText(runId, 200);
    if (!fz3bAgent || fz3bUnavailableHold || fz3bHostActionRunId) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    fz3bHostActionRunId = runId; publish();
    try {
      const intent = await fz3bAgent.prepareEmptyHostHome(runId);
      const confirmed = await nativeApproval(undefined, Date.parse(intent.expiresAt), () => requestNativeFz3bHostLocalAction(intent, {
        show: options => dialog.showMessageBox(nativeWindow(), options),
        assertOwner: () => fz3bAgent!.assertRecoveryOwner(intent.proof.completion.owner),
      }));
      return confirmed ? await fz3bAgent.quarantineEmptyHostHome(intent) : null;
    } finally { fz3bHostActionRunId = undefined; publish(); }
  }
  ,async fz3bIsolateFailedEmptyIntent(runId) {
    if (fz3bHostStartupReadOnly) throw new Error('FZ3B_STARTUP_READONLY');
    ensureWritable(); checkedText(runId, 200);
    if (!fz3bAgent || fz3bUnavailableHold || fz3bHostActionRunId || nativeDialogs.busy) throw new Error('FZ3B_RECOVERY_NOT_IDLE');
    fz3bHostActionRunId = runId; publish();
    try { return await fz3bAgent.isolateFailedEmptyHostIntent(runId); }
    finally { fz3bHostActionRunId = undefined; publish(); }
  }
  ,async fz3bExport(taskId) {
    ensureWritable(); getSession(checkedText(taskId, 200));
    if (!fz3bAgent) return null;
    const run = await fz3bAgent.taskSnapshot(taskId);
    if (!run) return null;
    if (fz3bHostActionRunId) throw new Error('FZ3B_HOST_RECOVERY_PENDING');
    fz3bHostActionRunId = run.runId; publish();
    try { return await fz3bAgent.export(taskId); }
    finally { fz3bHostActionRunId = undefined; publish(); }
  }
  ,async fz3bLeaveMode() {
    ensureWritable(); assertNoHardwareAgent();
    if (protectedTasks.size || sendingSessions.size || stoppingSessions.size) throw new Error('仍有操作未结束');
    await embedded.assertIdle(); await fz3bAgent?.assertIdle(); await embedded.revokeGrants();
    setHardwareMode(false); await connect();
  }
  ,async fz3bImportKey() {
    ensureWritable(); assertNoHardwareAgent();
    if (protectedTasks.size || sendingSessions.size || stoppingSessions.size || store.sessions.some(s => s.engineUncertain || ['running', 'stopping'].includes(s.status))) throw new Error('仍有操作未结束');
    fz3bAvailability = await checkFz3bAvailability(fz3bResourceRoot, dataDir);
    if (!(await mayImportFz3bKey()) || !fz3bKeyImportIdle()) throw new Error('FZ3B_KEY_IMPORT_NOT_ALLOWED');
    fz3bKeyImporting = true;
    try {
      await embedded.assertIdle(); await fz3bAgent?.assertIdle(); await verifyFz3bResources(fz3bResourceRoot);
      const result = await nativeOpenDialog({ title: '导入本项目已授权的 FZ3B SSH 私钥（不上传、不打包）', properties: ['openFile'] });
      if (result.canceled) return;
      if (result.filePaths.length !== 1) throw new Error('请选择唯一的项目私钥');
      await verifyFz3bResources(fz3bResourceRoot);
      if (!(await mayImportFz3bKey(undefined, true))) throw new Error('FZ3B_KEY_IMPORT_NOT_ALLOWED');
      await importFz3bProjectKey(result.filePaths[0], dataDir);
      fz3bAvailability = await checkFz3bAvailability(fz3bResourceRoot, dataDir);
      if (!fz3bAvailability.available) throw new Error(fz3bAvailability.reason ?? 'FZ3B_KEY_IMPORT_FAILED');
    } finally { fz3bKeyImporting = false; publish(); }
  }
};
function checkedText(value: unknown, max: number): string { if (typeof value !== 'string' || value.length > max) throw new Error('输入格式或长度不正确'); return value; }

app.setName('ForgeDesk');
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else void app.whenReady().then(async () => {
  initializeFz3bHostAclHelper(app.isPackaged);
  dataDir = process.env.FORGEDESK_DATA_DIR || path.join(app.getPath('userData'), 'forgedesk');
  mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
  store = new DesktopStore(dataDir);
  const processHost = app.isPackaged ? path.join(process.resourcesPath, 'process-host', 'process-host.exe') : path.join(app.getAppPath(), 'vendor', 'process-host', 'process-host.exe');
  processHostPath = processHost;
  hardwareRoot = app.isPackaged ? path.join(process.resourcesPath, 'hardware') : path.join(app.getAppPath(), 'vendor', 'hardware');
  hardwareWorker = app.isPackaged ? path.join(process.resourcesPath, 'hardware-worker.py') : path.join(app.getAppPath(), 'engineering', 'hardware-worker.py');
  fz3bResourceRoot = app.isPackaged ? path.join(process.resourcesPath, 'fz3b') : path.join(app.getAppPath(), 'engineering', 'fz3b', 'product', 'resources');
  embedded = new EmbeddedService({ dataDir, processHost, onChange: publish,
    templateRoot: app.isPackaged ? path.join(process.resourcesPath, 'templates', 'gesturescreen-v1') : path.join(app.getAppPath(), 'engineering', 'templates', 'gesturescreen-v1'),
    hardware: new FixedStm32HardwareService({ processHost, pythonExecutable: path.join(hardwareRoot, 'python', 'python.exe'), workerScript: hardwareWorker }) });
  hardwareAgent = new HardwareAgentController({ dataDir, embedded, exportDirectory: path.join(dataDir, 'exports', 'hardware-agent'),
    requestFlash: requestNativeFlash, onChange: publish,
    checkRuntime: () => verifyHardwareRuntime(hardwareRoot, hardwareWorker),
    assertOwner: binding => {
      ensureWritable();
      if (!hardwareMode || engine.state !== 'stopped' || !hardwareEngine || hardwareEngine.state !== 'ready' ||
          hardwareAgentRunId !== binding.runId || hardwareAgentTaskId !== binding.taskId ||
          hardwareEngine.connectionGeneration !== binding.generation || !protectedTasks.has(binding.taskId) ||
          protectedTasks.size !== 1 || sendingSessions.size || stoppingSessions.size ||
          store.sessions.some(s => s.id !== binding.sessionId && (s.engineUncertain || ['running', 'stopping'].includes(s.status)))) throw new Error('HARDWARE_AGENT_OWNER_MISMATCH');
    } });
  const modeFile = path.join(dataDir, 'hardware-mode.json');
  if (existsSync(modeFile)) { try { const mode = JSON.parse(readFileSync(modeFile, 'utf8')); hardwareMode = mode.schemaVersion !== 1 || mode.active !== false; } catch { hardwareMode = true; } }
  try { await verifyHardwareRuntime(hardwareRoot, hardwareWorker); await embedded.recover(); }
  catch (error) { setHardwareMode(true); diagnostics.push(`Hardware recovery unavailable: ${redact(String(error))}`); }
  try { await embedded.assertIdle(); } catch { setHardwareMode(true); }
  try { await hardwareAgent.recover(); }
  catch (error) { persistenceFailed = true; setHardwareMode(true); diagnostics.push(`Hardware-agent recovery unavailable: ${redact(String(error))}`); }
  try {
    const fixture = await loadFz3bFixture(fz3bResourceRoot);
    const checkRuntime = async () => {
      await verifyFz3bResources(fz3bResourceRoot);
      const availability = await checkFz3bAvailability(fz3bResourceRoot, dataDir);
      fz3bAvailability = availability;
      if (!availability.available) throw new Error(availability.reason ?? 'FZ3B_RUNTIME_UNAVAILABLE');
    };
    const backend: Fz3bBackend = new Fz3bBackend({ dataDir, fixture,
      adapter: new ProductionFz3bAdapter({ dataDir, resourceRoot: fz3bResourceRoot, processHost }),
      checkRuntime, onChange: publish,
      assertOwner: binding => fz3bAgent!.assertOwner(binding),
      assertRecoveryOwner: binding => fz3bAgent!.assertRecoveryOwner(binding),
      requestInspectReconciliation: (context, signal) => nativeApproval(signal, undefined, async () => { await checkRuntime(); return requestNativeFz3bInspectReconciliation(context, signal, {
        show: options => dialog.showMessageBox(nativeWindow(), options),
        assertOwner: async value => {
          const run = await backend.status(value.runId);
          if (!run || run.taskId !== value.taskId || run.sessionId !== value.sessionId) throw new Error('FZ3B_RECOVERY_OWNER_MISMATCH');
          await fz3bAgent!.assertRecoveryOwner(run);
        },
      }); }),
      requestSemantic: (preview, signal) => nativeApproval(signal, Date.parse(preview.expiresAt), () => requestNativeFz3bSemantic(preview, signal, {
        show: options => dialog.showMessageBox(nativeWindow(), options), checkRuntime,
        assertOwner: async value => {
          const run = await backend.status(value.runId);
          if (!run || run.taskId !== value.taskId || run.sessionId !== value.sessionId) throw new Error('FZ3B_NATIVE_OWNER_MISMATCH');
          await fz3bAgent!.assertOwner(run);
        },
      })),
      requestPreflightRefusalRecovery: (context, signal) => nativeApproval(signal, Date.parse(context.expiresAt), async () => {
        await verifyFz3bResources(fz3bResourceRoot);
        return requestNativeFz3bPreflightRefusalRecovery(context, signal, {
          show: options => dialog.showMessageBox(nativeWindow(), options),
          assertOwner: async value => {
            const run = await backend.status(value.runId);
            if (!run || run.taskId !== value.taskId || run.sessionId !== value.sessionId) throw new Error('FZ3B_PREFLIGHT_RECOVERY_OWNER_MISMATCH');
            await fz3bAgent!.assertRecoveryOwner(run);
          },
        });
      }),
    });
    const hostSid = await currentSid();
    const hostFinalization = createFz3bHostFinalizationStore(store, backend, binding => fz3bAgent!.assertSynchronousHostCommitOwner(binding.owner), hostSid);
    try { composeIncidentFailedIntentRecovery({ root: dataDir, sid: hostSid, packaged: app.isPackaged, resourcesPath: process.resourcesPath, store: hostFinalization,
      assertCurrentScope: () => {
        ensureWritable();
        const startupReadOnly = fz3bHostStartupReadOnly && !fz3bHostIpcRegistered && fz3bHostActionRunId === undefined;
        if (fz3bHostStartupReadOnly && !startupReadOnly ||
            fz3bHostActionRunId !== '07427a29-0eae-44c7-ac35-34d6650eebee' && !startupReadOnly ||
            nativeDialogs.busy || !hardwareMode || engine?.state !== 'stopped' ||
            fz3bAgent?.engineState !== 'stopped' || hardwareAgentStarting || hardwareAgentRunId || hardwareAgentRecovering || hardwareEngine && hardwareEngine.state !== 'stopped' ||
            fz3bKeyImporting || sendingSessions.size || stoppingSessions.size || protectedTasks.size !== 1 || !protectedTasks.has('9309dc73-fb48-4d29-9226-c5496ca2640d') || engine.pendingApprovals().length)
          throw new Error('FZ3B_FAILED_EMPTY_INTENT_CURRENT_OWNED_SCOPE');
        assertRunnerLifecycleOwner(dataDir);
      },
      assertOwner: async owner => {
        const run = await backend.status(owner.runId);
        if (!run || run.taskId !== owner.taskId || run.sessionId !== owner.sessionId) throw new Error('FZ3B_FAILED_EMPTY_INTENT_OWNER');
        await fz3bAgent!.assertRecoveryOwner(run);
      },
    }); } catch (error) { log(`Failed-intent isolation unavailable; maintenance exit remains independent: ${String(error)}`); }
    fz3bAgent = new Fz3bAgentMain({ backend,
      hostFinalization,
      createEngine: callbacks => new RestrictedFz3bAdapter({ executable: enginePath, home: path.join(dataDir, 'engine'), processHost, ...callbacks }),
      getSession,
      assertCanStart: assertFz3bAdmission, assertBeforeClaim: assertFz3bAdmission,
      enterControlledMode: async () => {
        await embedded.assertIdle(); await embedded.revokeGrants(); setHardwareMode(true);
        await engine.stop(); if (engine.state !== 'stopped') throw new Error('普通引擎退出未确认');
      },
      assertGlobalOwner: binding => {
        ensureWritable();
        if (!hardwareMode || engine.state !== 'stopped' || hardwareAgentStarting || hardwareAgentRunId || hardwareEngine && hardwareEngine.state !== 'stopped' ||
            !protectedTasks.has(binding.taskId) || protectedTasks.size !== 1 || sendingSessions.size || stoppingSessions.size ||
            store.sessions.some(s => s.id !== binding.sessionId && (s.engineUncertain || ['running', 'stopping'].includes(s.status)))) throw new Error('FZ3B_GLOBAL_OWNER_MISMATCH');
      },
      assertGlobalRecoveryOwner: assertFz3bRecoveryScope,
      assertHostCommitOwner: binding => {
        ensureWritable();
        if (!hardwareMode || !engine || engine.state !== 'stopped' || hardwareAgentStarting || hardwareAgentRunId || hardwareAgentRecovering || hardwareEngine && hardwareEngine.state !== 'stopped' ||
            protectedTasks.size !== 1 || !protectedTasks.has(binding.taskId) || sendingSessions.size || stoppingSessions.size || engine.pendingApprovals().length ||
            store.sessions.some(session => session.taskId !== binding.taskId && (session.engineUncertain || ['running', 'stopping'].includes(session.status)))) throw new Error('FZ3B_HOST_COMMIT_GLOBAL_OWNER_MISMATCH');
      },
      checkRuntime, readAccount: readHardwareAccount,
      setAccount: value => { const result = asRecord(value); account = { loggedIn: Boolean(result.account), label: result.account ? result.account.email ?? result.account.type ?? '已登录' : '未登录' }; },
      hold: taskId => protectedTasks.add(taskId), release: taskId => protectedTasks.delete(taskId),
      save, publish, log, onEvent: onEngineEvent, redact,
    });
    await fz3bAgent.recoverStartup();
    if (fz3bAgent.held) setHardwareMode(true);
    fz3bAvailability = await checkFz3bAvailability(fz3bResourceRoot, dataDir);
  } catch (error) {
    fz3bAgent = undefined;
    fz3bUnavailableHold = existsSync(path.join(dataDir, 'fz3b-agent'));
    const availability = await checkFz3bAvailability(fz3bResourceRoot, dataDir);
    fz3bAvailability = { ...availability, available: false, status: availability.resourcesVerified ? 'invalid-state' : availability.status,
      reason: `FZ3B 资源或持久记录校验失败: ${redact(String(error))}` };
    if (fz3bUnavailableHold) setHardwareMode(true);
    diagnostics.push(fz3bAvailability.reason!);
  }
  enginePath = app.isPackaged ? path.join(process.resourcesPath, 'codex', 'codex.exe') : path.join(app.getAppPath(), 'vendor', 'codex', 'codex.exe');
  if (!existsSync(enginePath) && process.env.FORGEDESK_CODEX_PATH && !app.isPackaged) enginePath = process.env.FORGEDESK_CODEX_PATH;
  if (!existsSync(processHost)) throw new Error('缺少 Windows 进程管理组件，请重新构建或安装');
  runner = new EngineeringRunner({ dataDir, onChange: publish, processHost,
    snapshotTemplateDirectory: app.isPackaged ? path.join(process.resourcesPath, 'templates', 'node-software-v1') : path.join(app.getAppPath(), 'engineering', 'templates', 'node-software-v1'),
    snapshotPolicyDigest: projectRoot => snapshotPolicies.get(projectRoot.toLowerCase()) ?? '',
    snapshotExecutionPolicy: cwd => engine.snapshotPolicy(cwd),
    snapshotSandbox: { executable: enginePath, codexHome: path.join(dataDir, 'engine'), mode: 'unelevated' } });
  await runner.recover();
  await refreshPassedEvidence();
  const pipeName = `\\\\.\\pipe\\forgedesk-${randomUUID()}`;
  const token = randomUUID() + randomUUID();
  bridge = await startRunnerBridge({ pipeName, token, handle: async (name, args) => {
    if (fz3bHostStartupReadOnly) throw new Error('FZ3B_STARTUP_READONLY');
    ensureWritable();
    if (stoppingSessions.size) throw new Error('ENGINE_STOPPING');
    const active = store.sessions.filter(s => s.status === 'running');
    if (active.length !== 1) throw new Error('NO_UNIQUE_ACTIVE_TASK');
    const s = active[0];
    if (args.taskId !== undefined && args.taskId !== s.taskId) throw new Error('TASK_SCOPE_MISMATCH');
    if (name.startsWith('device.')) throw new Error('HARDWARE_NOT_ENABLED');
    if (hardwareMode || fz3bKeyImporting) throw new Error('HARDWARE_CONTROLLED_MODE: 普通 MCP 在实机受控模式中不可执行');
    if (name === 'engineering.inspect') {
      if (args.projectId !== s.projectId) throw new Error('PROJECT_SCOPE_MISMATCH');
      return { taskId: s.taskId, task: await runner.refresh(s.taskId), hardwareEnabled: false };
    }
    if (name === 'engineering.build') {
      const task = await runner.getTask(s.taskId);
      if (!task.snapshotProfile) throw new Error('NO_APPROVED_BUILD_PROFILE');
      if (args.profileRevision !== task.snapshotProfile.revision) throw new Error('BUILD_PROFILE_REVISION_MISMATCH');
      return runSnapshotBuild(s.taskId, checkedText(args.requestKey, 200), true);
    }
    if (name === 'engineering.export') {
      const destination = path.join(dataDir, 'exports', `${s.taskId}-${Date.now()}`);
      return runner.exportTask(s.taskId, destination);
    }
    const task = await runner.getTask(s.taskId);
    assertNoHardwareAgent();
    const item = task?.acceptance.find(a => a.id === args.verifierId);
    if (!item?.command || item.kind !== 'automated') throw new Error('UNKNOWN_VERIFIER');
    if (protectedTasks.has(s.taskId)) throw new Error('VERIFICATION_BUSY');
    protectedTasks.add(s.taskId);
    try { return await runner.run({ taskId: s.taskId, requestKey: checkedText(args.requestKey, 200), command: item.command, kind: 'test', acceptanceId: item.id }); }
    finally { protectedTasks.delete(s.taskId); publish(); }
  } });
  const engineHome = path.join(dataDir, 'engine');
  mkdirSync(engineHome, { recursive: true });
  const quote = (value: string) => JSON.stringify(value);
  const mcpScript = path.join(app.getAppPath(), 'dist', 'mcp', 'index.cjs');
  writeFileSync(path.join(engineHome, 'config.toml'), [
    '# ForgeDesk-managed product configuration. Authentication is stored separately by Codex.',
    '[mcp_servers.engineering]', `command = ${quote(process.execPath)}`, `args = [${quote(mcpScript)}, "--mcp-stdio"]`,
    'startup_timeout_sec = 20', 'tool_timeout_sec = 360', 'required = false',
    `enabled_tools = ${JSON.stringify(ENGINEERING_TOOLS.map(t => t.name))}`,
    '[mcp_servers.engineering.env]', 'ELECTRON_RUN_AS_NODE = "1"', `FORGEDESK_RUNNER_PIPE = ${quote(pipeName)}`, `FORGEDESK_RUNNER_TOKEN = ${quote(token)}`, ''
  ].join('\n'));
  engine = new CodexAdapter({ executable: enginePath, home: path.join(dataDir, 'engine'), onEvent: onEngineEvent, processHost });
  if (fz3bHostStartupReadOnly || fz3bHostIpcRegistered || fz3bHostActionRunId !== undefined) throw new Error('FZ3B_STARTUP_READONLY_SCOPE');
  fz3bHostStartupReadOnly = true;
  try { await fz3bAgent?.restoreCertifiedHostCompletion(); }
  finally { fz3bHostStartupReadOnly = false; }
  if (fz3bHostIpcRegistered) throw new Error('FZ3B_STARTUP_READONLY_SCOPE');
  ipcMain.handle('forgedesk:invoke', async (event, method, args) => {
    if (fz3bHostStartupReadOnly) throw new Error('FZ3B_STARTUP_READONLY');
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不可信的 IPC 来源');
    if (typeof method !== 'string' || !Object.hasOwn(handlers, method) || !Array.isArray(args) || args.length > 5) throw new Error('不支持的 IPC 请求');
    const readOnly = ['snapshot', 'hardwareSnapshot', 'fz3bSnapshot', 'readOperationLog', 'diff'].includes(method);
    const recovery = ['interrupt', 'hardwareAgentStop', 'hardwareRecover', 'fz3bAgentStop', 'fz3bRecover', 'fz3bReconcileInspect', 'fz3bReconcilePreflightRefusedInspect', 'fz3bQuarantineEmptyHostHome', 'fz3bIsolateFailedEmptyIntent', 'fz3bMaintenanceExit', 'fz3bExport'].includes(method);
    if ((closing || shutdownPending || closeWarningOpen || shutdownFailed && !recovery) && !readOnly) throw new Error('MAIN_SHUTDOWN_HELD');
    if (method === 'fz3bImportKey' && args.length) throw new Error('FZ3B_NATIVE_KEY_PICKER_ONLY');
    if (['fz3bReconcileInspect', 'fz3bReconcilePreflightRefusedInspect', 'fz3bQuarantineEmptyHostHome', 'fz3bIsolateFailedEmptyIntent', 'fz3bMaintenanceExit'].includes(method) && args.length !== 1) throw new Error('FZ3B_EXACT_RUN_ID_ONLY');
    if (fz3bHostActionRunId && !['snapshot', 'fz3bSnapshot', 'readOperationLog', 'diff'].includes(method)) throw new Error('FZ3B_HOST_RECOVERY_PENDING');
    if (fz3bKeyImporting && !['snapshot', 'readOperationLog', 'diff'].includes(method)) throw new Error('FZ3B_KEY_IMPORT_PENDING');
    if ((hardwareAgentStarting || hardwareAgentRunId || fz3bAgent?.held || fz3bUnavailableHold) && !['snapshot', 'hardwareSnapshot', 'hardwareAgentStop', 'hardwareRecover', 'fz3bSnapshot', 'fz3bAgentStop', 'fz3bRecover', 'fz3bReconcileInspect', 'fz3bReconcilePreflightRefusedInspect', 'fz3bQuarantineEmptyHostHome', 'fz3bIsolateFailedEmptyIntent', 'fz3bMaintenanceExit', 'fz3bExport', 'readOperationLog', 'diff'].includes(method)) throw new Error('HARDWARE_AGENT_ACTIVE');
    const work = Promise.resolve().then(() => {
      if ((closing || shutdownPending || closeWarningOpen || shutdownFailed && !recovery) && !readOnly) throw new Error('MAIN_SHUTDOWN_HELD');
      return handlers[method](...args);
    });
    if (!readOnly) pendingMainWork.add(work);
    try { return await work; } catch (e) { log(`${method}: ${e}`); throw new Error(redact(e instanceof Error ? e.message : String(e))); }
    finally { pendingMainWork.delete(work); }
  });
  fz3bHostIpcRegistered = true;
  scheduleEvidenceRefresh();
  electronSession.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 800, minHeight: 600, title: 'ForgeDesk', icon: path.join(__dirname, '../renderer/assets/brand.ico'), backgroundColor: '#f6f7f8', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  await window.loadFile(path.join(__dirname, '../renderer/index.html'));
  window.on('close', event => { event.preventDefault(); void shutdown(); });
  const startReadonlyHistoryDiagnostic = () => {
    if (startupHistoryOwner || closing || shutdownPending || !window?.isVisible()) return;
    try {
      startupHistoryOwner = createNativeStartupHistoryOwner({ dataDir, packaged: app.isPackaged, mainDirectory: __dirname,
        resourcesPath: process.resourcesPath, appPath: app.getAppPath(), executable: process.execPath });
    } catch { log('Startup history diagnostic configuration refused; no worker was launched.'); return; }
    void startupHistoryOwner.read().then(result => {
      log(`Startup history diagnostic: ${result.status}; owned close ${result.closeConfirmed ? 'confirmed' : 'unconfirmed'}; historical rows ${result.projection?.rows.length ?? 'unavailable'}; admission and release not granted.`);
    });
  };
  if (window.isVisible()) setImmediate(startReadonlyHistoryDiagnostic);
  else window.once('show', startReadonlyHistoryDiagnostic);
  if (!hardwareMode) void connect().catch(() => undefined);
}).catch(error => { dialog.showErrorBox('ForgeDesk 启动失败', redact(String(error))); app.quit(); });
let closeWarningOpen = false;
async function showCloseWarning(options: MessageBoxOptions) {
  if (closeWarningOpen || nativeDialogs.busy) return;
  closeWarningOpen = true;
  try { await nativeMessageBox(options); }
  catch (error) { log(String(error)); }
  finally { closeWarningOpen = false; }
}
async function shutdown() {
  if (closing || shutdownPending) return;
  // An existing native dialog already owns the operator's attention; never queue a late close warning.
  if (fz3bHostActionRunId || nativeDialogs.busy) return;
  shutdownPending = true;
  try {
    if (protectedTasks.size || fz3bKeyImporting) {
      await showCloseWarning({ type: 'warning', message: '工程验证正在运行，请等待完成后退出。' });
      return;
    }
    // Already admitted asynchronous work must settle before any owner is torn down.
    await Promise.allSettled([...pendingMainWork]);
    if (startupHistoryOwner && !(await startupHistoryOwner.read()).closeConfirmed) {
      shutdownFailed = true; publish();
      await showCloseWarning({ type: 'warning', message: '只读历史诊断进程退出未确认，窗口已保留。请先复核状态。' });
      return;
    }
    try { await embedded.assertIdle(); await fz3bAgent?.assertIdle(); if (fz3bUnavailableHold) throw new Error('FZ3B_UNKNOWN_STATE_HELD'); }
    catch (error) { shutdownFailed = true; publish(); await showCloseWarning({ type: 'warning', message: '设备进程退出未确认，不能直接退出。请先复核设备操作状态。', detail: String(error) }); return; }
    if (nativeDialogs.busy || fz3bHostActionRunId || protectedTasks.size || fz3bKeyImporting) return;
    closing = true;
    if (evidenceTimer) clearTimeout(evidenceTimer);
    const interruptedSessions = store.sessions.filter(s => ['running', 'stopping'].includes(s.status));
    for (const s of interruptedSessions) { s.status = 'needs_attention'; s.historyIncomplete = true; s.engineUncertain = true; s.turnId = undefined; }
    const failures: unknown[] = [];
    for (const cleanup of [() => hardwareEngine?.stop(), async () => {
      await engine.stop();
      for (const s of interruptedSessions) if (!s.engineProfile) s.engineUncertain = false;
    }, () => bridge?.close(), () => embedded.close(), () => runner.close(), () => save()]) {
      try { await cleanup(); } catch (error) { failures.push(error); log(String(error)); }
    }
    if (failures.length) {
      shutdownFailed = true; closing = false;
      engineError = '退出清理或历史保存未确认，窗口已保留且新任务已暂停。请复核状态后手动再次关闭或使用维护退出。';
      publish(); return;
    }
    nativeDialogs.close(); window?.destroy(); app.quit();
  } finally { shutdownPending = false; }
}
app.on('second-instance', () => { window?.show(); window?.focus(); });
app.on('window-all-closed', () => app.quit());
