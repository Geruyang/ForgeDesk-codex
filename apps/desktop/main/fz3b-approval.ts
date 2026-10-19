import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { FZ3B_PROFILE, fz3bProfileSha256, validateFz3bFixture, validateFz3bIdentity } from '../../../packages/engineering-runner/fz3b/profile';
import type { Fz3bGrantPreview } from '../../../packages/engineering-runner/fz3b/types';

export interface NativeFz3bApprovalOptions {
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  assertOwner(preview: Fz3bGrantPreview): void | Promise<void>;
  checkRuntime(): Promise<void>;
  now?: () => number;
}

export async function requestNativeFz3bSemantic(preview: Fz3bGrantPreview, signal: AbortSignal, options: NativeFz3bApprovalOptions): Promise<boolean> {
  const now = options.now ?? Date.now;
  validateFz3bFixture(preview.fixture); validateFz3bIdentity(preview.identity);
  if (preview.scope !== 'existing-candidate008-real-text-single-image-once' || preview.profileSha256 !== fz3bProfileSha256(preview.fixture) ||
      JSON.stringify(preview.actions) !== JSON.stringify(FZ3B_PROFILE.actions) || !/^[a-f0-9]{64}$/.test(preview.planSha256) ||
      !/^[a-f0-9]{64}$/.test(preview.artifactId) || ![preview.id, preview.runId, preview.sessionId, preview.taskId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0'))) throw new Error('FZ3B_NATIVE_PREVIEW_MISMATCH');
  const expiry = Date.parse(preview.expiresAt), created = Date.parse(preview.createdAt);
  if (!Number.isFinite(expiry) || !Number.isFinite(created) || expiry <= now() || expiry <= created || expiry - created > 10 * 60_000 || signal.aborted) return false;
  await options.assertOwner(preview);
  await options.checkRuntime();
  if (signal.aborted || now() >= expiry) return false;
  const approval = new AbortController();
  const abort = () => approval.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) approval.abort();
  const timer = setTimeout(abort, Math.max(0, expiry - now()));
  let answer: MessageBoxReturnValue;
  try {
    answer = await options.show({ type: 'warning', title: 'ForgeDesk Zynq 单图语义授权', signal: approval.signal,
      message: '允许在指定 FZ3B 已有运行时执行这一次固定真实文本与图片测试？',
      detail: `任务：${preview.taskId}\n运行：${preview.runId}\n主机公钥 SHA-256：${preview.identity.hostKeySha256}\nBoot ID：${preview.identity.bootId}\n产物：${preview.artifactId}\n计划 SHA-256：${preview.planSha256}\n语义契约：${preview.identity.contractId}\n查询 SHA-256：${preview.fixture.queriesSha256}\n图片 SHA-256：${preview.fixture.imageSha256}\n固定查询：${preview.fixture.queryIds.join(' / ')}\n授权到期：${preview.expiresAt}\n\n将覆盖应用查询状态，创建一次上传并计算固定单图。既有 A0005 prepare 路径可能重新加载同一已批准 candidate008 位流，改变其专用 PL 时钟、loader 租约、R5 和设备状态，并在固定应用目录保存本次审计与排他日志，因此不是只读操作；不授权新位流、其他 candidate、驱动、固件、服务重启或任意 SSH 命令。旧查询无法经此协议恢复。分类结果仍须按回执判断，不代表通用语义准确率或新 PL 验收。`,
      buttons: ['取消', '授权本次固定测试'], defaultId: 0, cancelId: 0, noLink: true,
      checkboxLabel: '我确认目标、查询覆盖和既有运行时准备副作用，仅授权本次单图', checkboxChecked: false });
  } catch (error) {
    if (approval.signal.aborted || signal.aborted || now() >= expiry) return false;
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  if (answer.response !== 1 || !answer.checkboxChecked || signal.aborted || approval.signal.aborted || now() >= expiry) return false;
  await options.assertOwner(preview);
  await options.checkRuntime();
  return !signal.aborted && !approval.signal.aborted && now() < expiry;
}
