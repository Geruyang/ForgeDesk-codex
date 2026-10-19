import type { Fz3bBinding, Fz3bInspectReconciliationContext, Fz3bMaintenanceExitSeal, Fz3bPreflightRefusalRecoveryContext } from '../../../packages/engineering-runner/fz3b/types';
import { fz3bCanonicalJson } from '../../../packages/engineering-runner/fz3b/profile';
import { assertFz3bPreflightHostCompletionBinding } from '../../../packages/engineering-runner/fz3b/host-finalization';
import type { Fz3bHostLocalProof } from './host-finalization-store';

type RecoveryOwner = Pick<Fz3bBinding, 'runId' | 'taskId' | 'sessionId'>;
interface ConfirmationOptions {
  assertOwner(binding: RecoveryOwner): void | Promise<void>;
  show(options: { type: 'warning'; title?: string; signal?: AbortSignal; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; checkboxLabel: string; checkboxChecked: boolean; noLink: boolean }): Promise<{ response: number; checkboxChecked?: boolean }>;
}
export interface Fz3bHostLocalConfirmation {
  schemaVersion: 1; action: 'maintenance-exit' | 'quarantine-empty-home'; nonce: string;
  createdAt: string; expiresAt: string; proof: Fz3bHostLocalProof; emptyDirectorySha256?: string;
}
export async function requestNativeFz3bHostLocalAction(context: Fz3bHostLocalConfirmation, options: ConfirmationOptions & { now?: () => number }): Promise<boolean> {
  assertFz3bPreflightHostCompletionBinding(context?.proof?.completion);
  const now = options.now ?? Date.now, created = Date.parse(context.createdAt), expiry = Date.parse(context.expiresAt);
  const quarantine = context.action === 'quarantine-empty-home';
  const keys = quarantine ? 'action,createdAt,emptyDirectorySha256,expiresAt,nonce,proof,schemaVersion' : 'action,createdAt,expiresAt,nonce,proof,schemaVersion';
  if (Object.keys(context).sort().join(',') !== keys || Object.keys(context.proof).sort().join(',') !== 'completion,targetSha256' || context.schemaVersion !== 1 || !['maintenance-exit', 'quarantine-empty-home'].includes(context.action) ||
      !digest(context.nonce) || !digest(context.proof.targetSha256) || quarantine !== digest(context.emptyDirectorySha256) ||
      !Number.isFinite(created) || expiry - created !== 300000) throw new Error('FZ3B_HOST_LOCAL_PREVIEW_INVALID');
  const original = fz3bCanonicalJson(context), owner = context.proof.completion.owner;
  const fresh = () => { const time = now(); return created <= time && time < expiry && fz3bCanonicalJson(context) === original; };
  if (!fresh()) return false;
  await options.assertOwner(owner); if (!fresh()) return false;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), Math.max(0, expiry - now()));
  try {
    const answer = await options.show({ type: 'warning', title: quarantine ? 'ForgeDesk 主机空目录隔离' : 'ForgeDesk 本地主机维护退出', signal: abort.signal,
      message: quarantine ? '保留旧空目录并隔离，允许后续独立主机收尾？' : '保留主机收尾占用并维护退出应用？',
      detail: `任务 ${owner.taskId}\n运行 ${owner.runId}\n本地完整证据链 SHA-256 ${context.proof.completion.completeChainSha256}\n当前任务摘要 ${context.proof.targetSha256}\n本次意图 ${context.nonce}\n授权到期 ${context.expiresAt}\n${quarantine ? `空目录身份摘要 ${context.emptyDirectorySha256}\n旧目录仅重命名保留，不删除、不迁移已签数据；本次不创建证书。后续需另行显式收尾并重新验证实际证据。` : '仅关闭本地应用，不保存或签发主机收尾证书，不清除任务占用。'}\n不连接 SSH、不操作设备、不采用新 Boot、不重放任务。原 unknown 与证据保留；这不是远端静止或设备成功证明。`,
      buttons: ['取消', quarantine ? '保留并隔离旧空目录' : '保留记录并退出'], defaultId: 0, cancelId: 0, checkboxChecked: false, noLink: true,
      checkboxLabel: quarantine ? '我理解旧空目录不受信任，本次仅隔离保留，不授权设备或签发证书' : '我理解主机收尾仍持有，原未知与锁保留，本次仅退出本地应用' });
    if (answer.response !== 1 || answer.checkboxChecked !== true || abort.signal.aborted || !fresh()) return false;
    await options.assertOwner(owner);
    return !abort.signal.aborted && fresh();
  } catch (error) { if (abort.signal.aborted || !fresh()) return false; throw error; }
  finally { clearTimeout(timer); }
}

export async function requestNativeFz3bPreflightRefusalRecovery(context: Fz3bPreflightRefusalRecoveryContext, signal: AbortSignal, options: ConfirmationOptions & { now?: () => number }): Promise<boolean> {
  const now = options.now ?? Date.now;
  const owner = context?.original;
  const ids = [context?.id, context?.nonce, owner?.runId, owner?.sessionId, owner?.taskId, owner?.operationId];
  if (context?.schemaVersion !== 1 || context.reason !== 'boot-preflight-refused-before-device-v1' ||
      ids.some(value => typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value)) ||
      !digest(context.nonce) || typeof context.createdAt !== 'string' || typeof context.expiresAt !== 'string' ||
      ![context.ownerBindingSha256, context.originalOperationSha256, context.originalEvidenceSha256, context.sourceRecordSha256, context.sourceProjectionSha256].every(digest) ||
      context.maintenanceExitSha256 !== null && !digest(context.maintenanceExitSha256)) throw new Error('FZ3B_PREFLIGHT_RECOVERY_PREVIEW_INVALID');
  const created = Date.parse(context.createdAt), expiry = Date.parse(context.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expiry) || expiry - created !== 300000 || created > now()) throw new Error('FZ3B_PREFLIGHT_RECOVERY_PREVIEW_INVALID');
  const snapshot = () => fz3bCanonicalJson(context);
  const shownContext = snapshot();
  const fresh = () => { const time = now(); return created <= time && time < expiry; };
  if (signal.aborted || !fresh()) return false;
  await options.assertOwner(owner);
  if (signal.aborted || !fresh()) return false;
  if (snapshot() !== shownContext) throw new Error('FZ3B_PREFLIGHT_RECOVERY_PREVIEW_CHANGED');
  const approval = new AbortController();
  const abort = () => approval.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) approval.abort();
  const timer = setTimeout(abort, Math.max(0, expiry - now()));
  let answer: { response: number; checkboxChecked?: boolean };
  try {
    answer = await options.show({ type: 'warning', title: 'ForgeDesk FZ3B 本地预检拒绝恢复', signal: approval.signal,
      message: '仅用已封存的本地证据释放这一次预检拒绝的检查占用？',
      detail: `任务 ${owner.taskId}\n运行 ${owner.runId}\n原检查 ${owner.operationId}\n本地核查 ${context.id}\n原证据 SHA-256 ${context.originalEvidenceSha256}\n来源记录 SHA-256 ${context.sourceRecordSha256}\n显式投影 SHA-256 ${context.sourceProjectionSha256}\n维护退出摘要 ${context.maintenanceExitSha256 ?? '无'}\n授权到期 ${context.expiresAt}\n\n本次不连接 SSH、不扫描设备、不重试原检查，不授权新 Boot。原 unknown 记录、旧 Boot 绑定、模型任务与原始证据均保留；仅在原检查被证明于设备动作前拒绝且本地进程/回调均退出后，释放该检查占用。不是远端安全、语义推理成功或目标重新准入证明。`,
      buttons: ['取消', '校验本地证据并释放本次占用'], defaultId: 0, cancelId: 0, noLink: true,
      checkboxLabel: '我理解仅释放本次预检拒绝的检查占用，原 unknown 保留且不授权新 Boot', checkboxChecked: false });
  } catch (error) {
    if (signal.aborted || approval.signal.aborted || !fresh()) return false;
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  if (answer.response !== 1 || answer.checkboxChecked !== true || signal.aborted || approval.signal.aborted || !fresh()) return false;
  if (snapshot() !== shownContext) throw new Error('FZ3B_PREFLIGHT_RECOVERY_PREVIEW_CHANGED');
  await options.assertOwner(owner);
  return !signal.aborted && !approval.signal.aborted && fresh() && snapshot() === shownContext;
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
function binding(value: Fz3bBinding) {
  if (!value || ['runId', 'taskId', 'sessionId', 'threadId'].some(key => typeof value[key as keyof Fz3bBinding] !== 'string' || !String(value[key as keyof Fz3bBinding]).trim()) || value.model !== 'gpt-6.1-sol') throw new Error('FZ3B_RECOVERY_PREVIEW_INVALID');
}

export async function requestNativeFz3bInspectReconciliation(context: Fz3bInspectReconciliationContext, signal: AbortSignal, options: ConfirmationOptions): Promise<boolean> {
  if (context.schemaVersion !== 1 || !context.id || !context.nonce || !digest(context.originalOperationSha256) || !digest(context.originalEvidenceSha256) || !digest(context.ownerBindingSha256)) throw new Error('FZ3B_RECOVERY_PREVIEW_INVALID');
  const owner: RecoveryOwner = context.original;
  if (['runId', 'taskId', 'sessionId', 'operationId'].some(key => typeof context.original[key as keyof typeof context.original] !== 'string' || !String(context.original[key as keyof typeof context.original]).trim())) throw new Error('FZ3B_RECOVERY_PREVIEW_INVALID');
  if (signal.aborted) return false;
  await options.assertOwner(owner);
  if (signal.aborted) return false;
  const answer = await options.show({ type: 'warning', message: '只读核查 FZ3B 检查占用',
    detail: `任务 ${owner.taskId}\n运行 ${owner.runId}\n原检查 ${context.original.operationId}\n仅运行固定的只读 SSH 核查。新的独立证明必须确认设备与连接均空闲，才能释放本次检查占用。原 unknown 记录保留，不把原检查改成通过，不继续原模型运行，不执行语义动作、部署或服务操作。`,
    buttons: ['取消', '执行只读核查'], defaultId: 0, cancelId: 0, checkboxLabel: '我理解这是新的只读核查，不是原检查成功，也不会重放原任务', checkboxChecked: false, noLink: true });
  if (signal.aborted || answer.response !== 1 || answer.checkboxChecked !== true) return false;
  await options.assertOwner(owner);
  return !signal.aborted;
}

export async function requestNativeFz3bMaintenanceExit(seal: Fz3bMaintenanceExitSeal, owner: Fz3bBinding, options: ConfirmationOptions): Promise<boolean> {
  binding(owner);
  if (seal.schemaVersion !== 1 || seal.runId !== owner.runId || seal.taskId !== owner.taskId || seal.sessionId !== owner.sessionId || seal.unknownPreserved !== true || seal.localProcessesClosed !== true || !digest(seal.sealSha256) || !digest(seal.operationSnapshotSha256) || seal.processState.closed !== true || seal.processState.liveChildren !== 0) throw new Error('FZ3B_MAINTENANCE_PREVIEW_INVALID');
  await options.assertOwner(owner);
  const answer = await options.show({ type: 'warning', message: '保留未知状态并维护退出应用',
    detail: `任务 ${owner.taskId}\n运行 ${owner.runId}\n已确认本地引擎、工作进程及回调退出。此记录不证明远端安全或停止。退出不会清除 unknown、设备占用记录或任务锁；下次启动仍保持受控状态。仅用于维护或升级，不会重试或重放设备操作。`,
    buttons: ['取消', '保留记录并退出'], defaultId: 0, cancelId: 0, checkboxLabel: '我理解远端结果仍未知，下次启动仍持锁，本次仅退出本地应用', checkboxChecked: false, noLink: true });
  if (answer.response !== 1 || answer.checkboxChecked !== true) return false;
  await options.assertOwner(owner);
  return true;
}
