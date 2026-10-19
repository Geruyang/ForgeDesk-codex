import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Bot, Check, ChevronDown, CircleAlert, Code2, Cpu, Download, FileCheck2, Fingerprint, Hammer, KeyRound, Layers, LoaderCircle, LogOut, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import type { AppSnapshot, DesktopAPI } from '../../../packages/shared/contracts';
import type { Fz3bOperation, Fz3bPhase, Fz3bRunView, Fz3bSemanticResult, Fz3bToolName } from '../../../packages/engineering-runner/fz3b/types';

export type HardwarePlatform = 'stm32' | 'fz3b';
type AgentState = AppSnapshot['fz3bAgent'];
type Intent = 'recover' | 'export' | 'leave' | 'import-key' | 'reconcile-inspect' | 'reconcile-preflight-inspect' | 'maintenance-exit' | 'quarantine-empty-home' | 'isolate-failed-empty-intent';
const activeActions = new Map<string, Intent>();
export const FZ3B_INSTRUCTION_MAX = 12000;
const storageKey = (taskId: string) => `forgedesk.fz3b-agent.v1:${taskId}`;
const phases: Record<Fz3bPhase, string> = { ready: '准备任务', building: 'PS验收包构建', inspecting: '检查既有运行环境', awaiting_native_approval: '等待原生授权', semantic: '执行单图语义任务', exporting: '导出证据', completed: '任务完成', stopped: '模型规划已停止', needs_attention: '需要人工核查' };
const tools: Record<Fz3bToolName, string> = { fz3b_status: '读取缓存状态', fz3b_build: 'PS验收包构建', fz3b_inspect: '检查设备', fz3b_request_semantic: '请求原生授权', fz3b_semantic: '单图语义任务', fz3b_export: '导出证据' };
const approvals: Record<Fz3bRunView['nativeApproval'], string> = { not_requested: '尚未请求', pending: '等待原生窗口确认', approved: '已获原生授权', cancelled: '原生授权已取消', expired: '原生授权已过期', unknown: '授权状态未知' };
const operations: Record<Fz3bOperation['kind'], string> = { build: 'PS验收包构建', inspect: '设备检查', semantic: '单图语义任务' };
const outcomes: Record<Fz3bOperation['status'], string> = { prepared: '准备中', running: '执行中', succeeded: '操作成功', failed: '操作失败', unknown: '操作结果未知' };
const calls: Record<string, string> = { running: '执行中', succeeded: '成功', failed: '失败', unknown: '结果未知', replayed: '已记录结果', rejected: '已拒绝', stopped: '已停止' };
const engineNames: Record<string, string> = { stopped: '未启动', starting: '启动中', connecting: '连接中', connected: '已连接', ready: '就绪', stopping: '停止中', disconnected: '未连接', unknown: '状态未知', error: '错误', failed: '失败' };
const queryNames = { pillow: '枕头', cup: '杯子', 'mobile-phone': '手机', bottle: '瓶子' };
function date(value: string) { const time = new Date(value); return Number.isNaN(time.getTime()) ? value : time.toLocaleString('zh-CN'); }
function errorText(value: unknown) { return value instanceof Error ? value.message : String(value); }
function storedInstruction(taskId: string): string { try { const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(taskId)) || '{}'); return parsed && typeof parsed === 'object' && 'instruction' in parsed && typeof parsed.instruction === 'string' ? parsed.instruction : ''; } catch { return ''; } }
export function fz3bInstructionValid(value: string) { return value.length <= FZ3B_INSTRUCTION_MAX && !!value.trim(); }
export function fz3bPhaseName(phase: Fz3bPhase) { return phases[phase] || phase; }
export function hardwarePlatformFromSaved(value: unknown): HardwarePlatform { return value === 'fz3b' ? 'fz3b' : 'stm32'; }
export function fz3bAgentLocked(state: AgentState) { return !!state?.activeRunId || !!state?.recoveryTaskId || !!state?.runs.some(run => run.active || run.hardwareBusy || run.nativeApproval === 'pending'); }
export function selectedFz3bRun(state: AgentState, taskId?: string, sessionId?: string) { return [...(state?.runs || [])].reverse().find(run => run.taskId === taskId && run.sessionId === sessionId); }
export function fz3bCanStop(state: AgentState, run: Fz3bRunView | undefined) { return !!run && state?.activeRunId === run.runId && recoveryActions(state, run)?.finishPreflightRefusal !== true && (run.active || run.hardwareBusy || run.nativeApproval === 'pending' || state.engineState !== 'stopped'); }
export function fz3bCanRecover(state: AgentState, run: Fz3bRunView | undefined, taskId?: string) { return run ? state?.activeRunId === run.runId && run.stopRequested && !run.active && recoveryActions(state, run)?.finishPreflightRefusal !== true : !!taskId && state?.recoveryTaskId === taskId; }
export function fz3bCanImportKey(state: AgentState) { return state?.keyImportAllowed === true; }
function recoveryActions(state: AgentState, run: Fz3bRunView | undefined) {
  const actions = state?.recoveryActions;
  return run && actions?.runId === run.runId && actions.taskId === run.taskId && actions.sessionId === run.sessionId ? actions : undefined;
}
export function fz3bCanReconcileInspect(state: AgentState, run: Fz3bRunView | undefined) { return recoveryActions(state, run)?.reconcileInspect === true; }
export function fz3bCanReconcilePreflightInspect(state: AgentState, run: Fz3bRunView | undefined) { return recoveryActions(state, run)?.reconcilePreflightRefusedInspect === true; }
export function fz3bCanFinishPreflight(state: AgentState, run: Fz3bRunView | undefined) { return recoveryActions(state, run)?.finishPreflightRefusal === true; }
export function fz3bCanMaintenanceExit(state: AgentState, run: Fz3bRunView | undefined) { return recoveryActions(state, run)?.maintenanceExit === true; }
export function fz3bCanQuarantineEmptyHome(state: AgentState, run: Fz3bRunView | undefined) { return recoveryActions(state, run)?.quarantineEmptyHome === true; }
export function fz3bCanIsolateFailedIntent(state: AgentState, run: Fz3bRunView | undefined) { return recoveryActions(state, run)?.isolateFailedEmptyIntent === true; }
export function fz3bCanExport(state: AgentState, run: Fz3bRunView | undefined) {
  if (!state || !run || run.active || run.nativeApproval === 'pending') return false;
  return !fz3bAgentLocked(state) && !run.hardwareBusy || state.engineState === 'stopped' && recoveryActions(state, run)?.exportEvidence === true;
}

export function HardwarePlatformTabs({ platform, onChange }: { platform: HardwarePlatform; onChange: (platform: HardwarePlatform) => void }) {
  return <div className="hardware-platforms" role="tablist" aria-label="设备平台">
    <button type="button" role="tab" aria-selected={platform === 'stm32'} className={platform === 'stm32' ? 'active' : ''} onClick={() => onChange('stm32')}><Cpu size={14} />STM32</button>
    <button type="button" role="tab" aria-selected={platform === 'fz3b'} className={platform === 'fz3b' ? 'active' : ''} onClick={() => onChange('fz3b')}><Layers size={14} />FZ3B · Zynq</button>
  </div>;
}

export function fz3bOperationProgress(operation: Fz3bOperation | undefined) {
  const progress = operation?.progress;
  if (!progress || !Number.isFinite(Date.parse(progress.updatedAt)) || !progress.stage.trim()) return undefined;
  const { completed, total, unit } = progress;
  const measured = typeof completed === 'number' && Number.isFinite(completed) && typeof total === 'number' && Number.isFinite(total) && total > 0 && completed >= 0 && completed <= total && (unit === 'steps' || unit === 'bytes');
  return { progress, percent: measured ? Math.floor(completed / total * 1000) / 10 : undefined };
}

export function FZ3BProgress({ run, stale }: { run: Fz3bRunView; stale: boolean }) {
  const operation = [...run.operations].reverse().find(item => item.status === 'running' || item.status === 'prepared') || run.operations.at(-1);
  const active = run.active || run.hardwareBusy;
  if (!operation && !active) return null;
  const telemetry = fz3bOperationProgress(operation);
  const percent = telemetry?.percent;
  const state = operation ? outcomes[operation.status] : '等待操作记录';
  const text = percent === undefined ? '未上报计数' : `${operation?.status === 'running' ? '当前阶段' : '最后上报'} ${percent}%`;
  return <section className={`embedded-section fz3b-progress ${operation?.status || ''}`} aria-label="FZ3B 构建与操作进度" data-operation-id={operation?.id || ''}>
    <div className="embedded-section-heading"><h2><Hammer size={14} />{operation ? operations[operation.kind] : fz3bPhaseName(run.phase)}</h2><span>{state}</span></div>
    <div className="embedded-progress-caption"><span>{telemetry?.progress.stage || fz3bPhaseName(run.phase)}</span><strong>{text}</strong></div>
    <div className={`embedded-progress-track${percent === undefined ? ' indeterminate' : ''}`} role="progressbar" aria-label="FZ3B 当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${text}；${state}`}>
      {percent !== undefined && <span style={{ width: `${percent}%` }} />}
    </div>
    {active && <p className="embedded-progress-outcome"><LoaderCircle size={12} className="spin" />{run.hardwareBusy ? '设备操作尚未确认结束' : '模型任务进行中'}</p>}
    {operation?.status === 'unknown' && <p className="embedded-progress-error" role="alert">原操作远端结果未知，未自动重试。{run.hardwareBusy ? '设备占用仍需核查。' : '历史记录不会改为通过。'}</p>}
    {operation?.detail && <p className="embedded-progress-source">{operation.detail}</p>}
    {telemetry?.progress.message && <p className="embedded-progress-source">{telemetry.progress.message}</p>}
    {telemetry && <p className="embedded-progress-source">阶段记录 · {date(telemetry.progress.updatedAt)}</p>}
    {stale && <p className="embedded-progress-stale">状态读取失败，以上为上次记录。</p>}
  </section>;
}

export function FZ3BSemanticResult({ result }: { result: Fz3bSemanticResult }) {
  return <section className="embedded-section fz3b-semantic" aria-label="FZ3B 语义结果">
    <div className="embedded-section-heading"><h2><FileCheck2 size={14} />单图语义结果</h2><span className={result.expectedLabelMatched ? 'good-text' : ''}>{result.expectedLabelMatched ? '排名匹配固定预期' : '排名未匹配固定预期'}</span></div>
    <div className="fz3b-result-summary"><strong>{queryNames[result.bestId] || result.bestId}</strong><span>{result.classificationUnknown ? '应用分类：未知' : '应用已返回分类'}</span></div>
    <table className="fz3b-ranking"><caption>真实文本编码 · 候选评分</caption><thead><tr><th scope="col">候选</th><th scope="col">评分</th></tr></thead><tbody>{result.ranking.map((item, index) => <tr key={`${item.id}:${index}`} className={item.id === result.bestId ? 'best' : ''}><th scope="row">{item.id === result.bestId && <Check size={11} />}{item.label || queryNames[item.id]}</th><td title={String(item.score)}>{Number.isFinite(item.score) ? item.score.toFixed(5) : '无效评分'}</td></tr>)}</tbody></table>
    <dl className="embedded-fields"><dt>输入类型</dt><dd>真实文本编码 · 非合成向量</dd><dt>已完成图像</dt><dd>{result.completedFrames}</dd><dt>预期标签</dt><dd>{queryNames[result.expectedLabel]}</dd><dt>阈值判断</dt><dd>{result.thresholdHit ? '达到阈值' : '未达阈值'} · {result.threshold}</dd><dt>任务 / 帧</dt><dd>{result.jobId} / {result.frameId}</dd><dt>查询版本</dt><dd>{result.queryRevision}</dd><dt>结束状态</dt><dd>{result.inferenceStopped ? '推理已停止' : '尚未确认停止'}</dd><dt>PL 范围</dt><dd>既有 candidate008 · 未加载新 PL</dd></dl>
    <details className="embedded-details"><summary>语义结果与输入摘要</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
  </section>;
}

export function FZ3BRunSummary({ run, stopping, canStop, onStop, canRecover, recovering, recoveryBlocked, onRecover, localActionPending = false }: {
  run: Fz3bRunView; stopping: boolean; canStop: boolean; onStop: (runId: string) => void;
  canRecover: boolean; recovering: boolean; recoveryBlocked: boolean; onRecover: () => void;
  localActionPending?: boolean;
}) {
  return <section className="embedded-section fz3b-run" aria-label="FZ3B 模型实机任务" data-run-id={run.runId}>
    <div className="embedded-section-heading"><h2><Bot size={14} />FZ3B 模型任务</h2><span>{fz3bPhaseName(run.phase)}</span></div>
    <dl className="embedded-fields"><dt>模型</dt><dd>{run.model}</dd><dt>Run ID</dt><dd>{run.runId}</dd><dt>原生授权</dt><dd>{approvals[run.nativeApproval]}</dd></dl>
    {run.nativeApproval === 'pending' && <p className="hardware-agent-warning"><ShieldCheck size={13} />等待原生窗口决定；本面板不授予设备授权。</p>}
    {run.stopRequested && <p className="hardware-agent-warning">模型停止请求已记录；{run.hardwareBusy ? '设备操作仍未确认结束。' : '不代表设备结果通过。'}</p>}
    {(run.phase === 'needs_attention' || run.nativeApproval === 'unknown') && <p className="hardware-agent-warning" role="alert"><CircleAlert size={13} />存在不确定状态，未自动重试远端操作。</p>}
    {run.failure && <p className="embedded-progress-error" role="alert">{run.failure}</p>}
    <div className="embedded-commands">
      {canStop && <button type="button" className="secondary" aria-label="停止 FZ3B 模型任务" disabled={stopping || localActionPending} onClick={() => onStop(run.runId)}>{stopping ? <LoaderCircle size={13} className="spin" /> : <Square size={13} />}{run.stopRequested ? '再次确认模型停止' : '停止模型任务'}</button>}
      {canRecover && <button type="button" className="secondary" aria-label="核查 FZ3B 退出状态" disabled={recovering || recoveryBlocked || stopping} onClick={onRecover}>{recovering ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}核查退出状态</button>}
    </div>
    {canRecover && <p className="hardware-agent-warning">仅核查退出与远端终态；不会重试计算或把未知结果改为成功。</p>}
    {run.calls.length > 0 && <details className="embedded-details"><summary>模型工具调用（{run.calls.length}）</summary><ol className="hardware-agent-calls">{run.calls.map((call, index) => <li key={`${call.callId}:${index}`}><strong>{tools[call.tool]}</strong><span>{calls[call.status] || call.status}</span>{call.error && <p className="embedded-progress-error">{call.error}</p>}<pre>{JSON.stringify(call, null, 2)}</pre></li>)}</ol></details>}
    {run.export && <p className="embedded-progress-source"><Download size={12} /> 导出：{run.export.path}<br />SHA-256：{run.export.sha256}</p>}
  </section>;
}

export function FZ3BRecoveryHistory({ run }: { run: Fz3bRunView }) {
  if (!run.reconciliations?.length && !run.preflightRefusalRecoveries?.length && !run.maintenanceExit) return null;
  const names = { preparing: '准备只读核查', prepared: '等待最终确认', released: '当前占用已解除', failed: '核查未完成' };
  return <section className="embedded-section" aria-label="FZ3B 恢复与维护记录">
    <div className="embedded-section-heading"><h2><FileCheck2 size={14} />恢复与维护记录</h2><span>不改写原操作结果</span></div>
    {run.reconciliations?.map(item => <details className="record embedded-operation" key={item.context.id}><summary><RefreshCw size={13} /><span>新的只读检查核查</span><span className={`status ${item.status === 'failed' ? 'bad' : item.status === 'released' ? '' : 'warning'}`}>{names[item.status]}</span><ChevronDown size={12} /></summary><p>{item.status === 'released' ? '新核查确认当前占用可解除；原检查仍为未知，原模型任务不会续跑。' : '尚未确认解除占用；原检查仍为未知，未重试原操作。'}</p>{item.error && <p className="embedded-progress-error" role="alert">{item.error}</p>}<pre>{JSON.stringify(item, null, 2)}</pre></details>)}
    {run.preflightRefusalRecoveries?.map(item => <details className="record embedded-operation" key={`preflight:${item.context.id}`}><summary><FileCheck2 size={13} /><span>本地预检拒绝核查</span><span className={`status ${item.status === 'failed' ? 'bad' : item.status === 'released' ? '' : 'warning'}`}>{item.status === 'release_prepared' ? '本地释放待确认' : names[item.status]}</span><ChevronDown size={12} /></summary><p>{item.status === 'released' ? '本地证据核查已解除本次检查占用；原检查仍为未知，旧 Boot 绑定未更新，模型任务不会续跑。' : '本地释放尚未确认；原检查仍为未知，未授权 SSH 或设备重试。'}</p>{item.error && <p className="embedded-progress-error" role="alert">{item.error}</p>}<pre>{JSON.stringify(item, null, 2)}</pre></details>)}
    {run.maintenanceExit && <details className="embedded-details"><summary>维护退出记录 · {date(run.maintenanceExit.createdAt)}</summary><p>仅记录本地进程已收束；远端未知与持锁状态保留，重启后仍需核查。</p><pre>{JSON.stringify(run.maintenanceExit, null, 2)}</pre></details>}
  </section>;
}

export function FZ3BArtifacts({ run }: { run: Fz3bRunView }) {
  return <>
    {run.artifact && <section className="embedded-section"><div className="embedded-section-heading"><h2><Hammer size={14} />PS验收包构建</h2><span>未构建或部署新 PL</span></div><dl className="embedded-fields"><dt>构建类型</dt><dd>固定 PS 源码包与语义输入校验</dd><dt>Build ID</dt><dd>{run.artifact.buildId}</dd><dt>验收包摘要</dt><dd>{run.artifact.packageSha256}</dd><dt>包清单摘要</dt><dd>{run.artifact.packageManifestSha256}</dd><dt>配置摘要</dt><dd>{run.artifact.profileSha256}</dd><dt>源码清单</dt><dd>{run.artifact.sourceManifestSha256}</dd><dt>固定图像</dt><dd>{run.artifact.imageSha256}</dd><dt>文本输入</dt><dd>{run.artifact.queriesSha256}</dd></dl><details className="embedded-details"><summary>产物完整记录</summary><pre>{JSON.stringify(run.artifact, null, 2)}</pre></details></section>}
    {run.identity && <section className="embedded-section"><div className="embedded-section-heading"><h2><Fingerprint size={14} />设备与运行环境</h2><span>固定 SSH 传输</span></div><dl className="embedded-fields"><dt>平台</dt><dd>{run.identity.platform}</dd><dt>SSH 主机键</dt><dd>{run.identity.hostKeySha256}</dd><dt>Boot ID</dt><dd>{run.identity.bootId}</dd><dt>应用合同</dt><dd>{run.identity.contractId}</dd><dt>已部署清单</dt><dd>{run.identity.deployedManifestSha256}</dd><dt>既有 PL 摘要</dt><dd>{run.identity.existingPlSha256}</dd></dl></section>}
    {run.grant && <section className="embedded-section"><div className="embedded-section-heading"><h2><ShieldCheck size={14} />单次语义授权记录</h2><span>{approvals[run.nativeApproval]}</span></div><dl className="embedded-fields"><dt>授权范围</dt><dd>既有 candidate008 · 真实文本 · 单图一次</dd><dt>到期时间</dt><dd>{date(run.grant.expiresAt)}</dd><dt>批准时间</dt><dd>{run.grant.approvedAt ? date(run.grant.approvedAt) : '尚未批准'}</dd><dt>绑定计划</dt><dd>{run.grant.planSha256}</dd>{run.grant.consumedBy && <><dt>已消费操作</dt><dd>{run.grant.consumedBy}</dd></>}</dl><details className="embedded-details"><summary>授权绑定与实际影响</summary><ul>{run.grant.actions.map((item, index) => <li key={index}>{item}</li>)}</ul><pre>{JSON.stringify(run.grant, null, 2)}</pre></details></section>}
    {run.operations.length > 0 && <section className="embedded-section"><div className="embedded-section-heading"><h2>操作记录</h2><span>{run.operations.length}</span></div>{[...run.operations].reverse().map(operation => <details className="record embedded-operation" key={operation.id}><summary><Cpu size={13} /><span>{operations[operation.kind]}</span><span className={`status ${operation.status === 'unknown' ? 'warning' : operation.status === 'failed' ? 'bad' : ''}`}>{outcomes[operation.status]}</span><ChevronDown size={12} /></summary><pre>{JSON.stringify(operation, null, 2)}</pre></details>)}</section>}
  </>;
}

export default function FZ3BPanel({ taskId, sessionId, api, state, models = [], loggedIn, fresh, modeActive, softwareBusy, otherHardwareBusy, starting, stoppingRunId, onStart, onStop }: {
  taskId?: string; sessionId?: string; api?: DesktopAPI; state: AgentState; models?: AppSnapshot['models']; loggedIn: boolean;
  fresh: boolean; modeActive: boolean; softwareBusy: boolean; otherHardwareBusy: boolean; starting: boolean; stoppingRunId?: string;
  onStart: (instruction: string, model: string) => Promise<boolean>; onStop: (runId: string) => void;
}) {
  const [instruction, setInstruction] = useState(() => taskId ? storedInstruction(taskId) || '构建固定 PS 验收包，检查 FZ3B 既有运行环境，在原生授权后执行固定图像与真实文本的单次语义任务，最后导出证据。' : '');
  const [cachedRun, setCachedRun] = useState<Fz3bRunView>();
  const [loading, setLoading] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [readError, setReadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [intent, setIntent] = useState<Intent>();
  const [externalBusy, setExternalBusy] = useState(false);
  const mounted = useRef(false);
  const readVersion = useRef(0);
  const semanticElement = useRef<HTMLDivElement>(null);
  const scrolledSemanticJob = useRef<string | undefined>(undefined);
  const model = 'gpt-6.1-sol';
  const available = !!api && state?.available === true;
  const run = selectedFz3bRun(state, taskId, sessionId) || (cachedRun && cachedRun.taskId === taskId && cachedRun.sessionId === sessionId ? cachedRun : undefined);
  const globalHeld = fz3bAgentLocked(state);
  const busy = starting || !!intent || externalBusy || softwareBusy || otherHardwareBusy;
  const startAllowed = available && !!taskId && !!sessionId && loggedIn && fresh && !run && !modeActive && !globalHeld && !busy && !loading && !readFailed && fz3bInstructionValid(instruction);

  const refresh = useCallback(async () => {
    if (!api || !taskId || !sessionId || !state) { if (mounted.current) setLoading(false); return; }
    const version = ++readVersion.current; setLoading(true);
    try {
      const next = await api.fz3bSnapshot(taskId);
      if (next && (next.taskId !== taskId || next.sessionId !== sessionId)) throw new Error('FZ3B 状态不属于当前任务，已阻止操作。');
      if (mounted.current && version === readVersion.current) { setCachedRun(next || undefined); setReadFailed(false); setReadError(''); }
    } catch (failure) { if (mounted.current && version === readVersion.current) { setReadFailed(true); setReadError(errorText(failure)); } }
    finally { if (mounted.current && version === readVersion.current) { setLoading(false); setIntent(activeActions.get(taskId)); setExternalBusy(activeActions.size > 0 && !activeActions.has(taskId)); } }
  }, [api, taskId, sessionId, !!state]);

  useEffect(() => {
    mounted.current = true; let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { await refresh(); if (!cancelled) timer = setTimeout(() => { void poll(); }, 2000); };
    void poll();
    return () => { cancelled = true; mounted.current = false; readVersion.current++; if (timer) clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => { if (!taskId) return; try { localStorage.setItem(storageKey(taskId), JSON.stringify({ instruction })); } catch { /* Draft persistence cannot authorize or replay an action. */ } }, [taskId, instruction]);
  useEffect(() => {
    const job = run?.semantic?.jobId;
    if (!job || job === scrolledSemanticJob.current || !semanticElement.current) return;
    semanticElement.current.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
    scrolledSemanticJob.current = job;
  }, [run?.semantic?.jobId]);

  async function runLocalAction(kind: Intent) {
    if (!api || !taskId || !state || activeActions.size > 0 || starting || softwareBusy || otherHardwareBusy) return;
    if (kind !== 'import-key' && readFailed) return;
    if (kind === 'recover' && (!fz3bCanRecover(state, run, taskId) || !!stoppingRunId)) return;
    if (kind === 'reconcile-inspect' && (!fz3bCanReconcileInspect(state, run) || !!stoppingRunId)) return;
    if (kind === 'reconcile-preflight-inspect' && (!fz3bCanReconcilePreflightInspect(state, run) || !!stoppingRunId)) return;
    if (kind === 'maintenance-exit' && (!fz3bCanMaintenanceExit(state, run) || !!stoppingRunId)) return;
    if (kind === 'quarantine-empty-home' && (!fz3bCanQuarantineEmptyHome(state, run) || !!stoppingRunId)) return;
    if (kind === 'isolate-failed-empty-intent' && (!fz3bCanIsolateFailedIntent(state, run) || !!stoppingRunId)) return;
    if (kind === 'export' && !fz3bCanExport(state, run)) return;
    if (!['recover', 'reconcile-inspect', 'reconcile-preflight-inspect', 'maintenance-exit', 'quarantine-empty-home', 'isolate-failed-empty-intent', 'export'].includes(kind) && globalHeld) return;
    if (kind === 'leave' && !modeActive || kind === 'import-key' && !fz3bCanImportKey(state)) return;
    activeActions.set(taskId, kind); setIntent(kind); setError(''); setNotice('');
    try {
      if (kind === 'recover') {
        const next = await api.fz3bRecover(taskId);
        if (next && (next.taskId !== taskId || next.sessionId !== sessionId)) throw new Error('FZ3B 核查返回了其他任务的状态。');
        if (next && mounted.current) setCachedRun(next);
      } else if (kind === 'reconcile-inspect') {
        const next = await api.fz3bReconcileInspect(run!.runId);
        if (next.runId !== run!.runId || next.taskId !== taskId || next.sessionId !== sessionId) throw new Error('FZ3B 只读核查返回了其他任务的状态。');
        if (mounted.current) setCachedRun(next);
      } else if (kind === 'reconcile-preflight-inspect') {
        const next = await api.fz3bReconcilePreflightRefusedInspect(run!.runId);
        if (next.runId !== run!.runId || next.taskId !== taskId || next.sessionId !== sessionId) throw new Error('FZ3B 本地核查返回了其他任务的状态。');
        if (mounted.current) setCachedRun(next);
      } else if (kind === 'quarantine-empty-home') await api.fz3bQuarantineEmptyHostHome(run!.runId);
      else if (kind === 'isolate-failed-empty-intent') await api.fz3bIsolateFailedEmptyIntent(run!.runId);
      else if (kind === 'maintenance-exit') await api.fz3bMaintenanceExit(run!.runId);
      else if (kind === 'export') {
        const destination = await api.fz3bExport(taskId);
        if (destination && mounted.current) setNotice(`证据已导出：${destination}`);
      } else if (kind === 'import-key') await api.fz3bImportKey();
      else await api.fz3bLeaveMode();
    } catch (failure) { if (mounted.current) setError(errorText(failure)); }
    finally { activeActions.delete(taskId); if (mounted.current) { setIntent(undefined); await refresh(); } }
  }

  if (!taskId || !sessionId) return <div className="panel-empty"><Layers size={28} strokeWidth={1.4} /><p>尚未选择工程任务</p></div>;
  const startupRecovery = !run && fz3bCanRecover(state, run, taskId);
  const reason = startupRecovery ? '任务启动未完成，需核查本地控制器退出状态。' : !available ? state?.status === 'missing-key' ? '尚未导入本项目设备密钥。' : state?.reason || 'FZ3B 固定资源尚未就绪' : !loggedIn ? '官方账号尚未登录' : !fresh && !run ? '当前会话已有记录，不能启动新的实机链' : otherHardwareBusy ? '另一实机流程仍占用设备' : softwareBusy ? '软件任务尚未结束' : globalHeld && !run ? '其他 FZ3B 任务仍占用流程' : modeActive && !run ? '工程仍处于受控模式' : '';
  return <div className="embedded-scroll fz3b-scroll" aria-busy={busy || !!run?.active || !!run?.hardwareBusy} data-task-id={taskId} data-pending-intent={intent || ''}>
    <div className="embedded-mode"><div><Layers size={15} /><strong>FZ3B · Zynq</strong><button type="button" className="icon-button" title="刷新 FZ3B 本地状态" aria-label="刷新 FZ3B 本地状态" disabled={!api || loading} onClick={() => void refresh()}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div><p>既有 candidate008 · PS验收包 · 真实文本单图任务</p><p>控制器：{state ? engineNames[state.engineState] || state.engineState : '未读取'}</p><div className="embedded-commands">{modeActive && <button type="button" className="secondary" aria-label="FZ3B 返回软件模式" disabled={globalHeld || busy || readFailed} onClick={() => void runLocalAction('leave')}><ArrowLeftRight size={13} />返回软件模式</button>}{(fz3bCanImportKey(state) || intent === 'import-key') && <button type="button" className="secondary" aria-label="导入 FZ3B 设备密钥" disabled={!api || !fz3bCanImportKey(state) || globalHeld || busy} onClick={() => void runLocalAction('import-key')}>{intent === 'import-key' ? <LoaderCircle size={13} className="spin" /> : <KeyRound size={13} />}导入设备密钥</button>}</div></div>
    {(readError || error) && <div className="notice error" role="alert"><CircleAlert size={14} /><span>{[readError, error].filter(Boolean).join('；')}</span></div>}
    {notice && <div className="notice success" role="status"><Download size={14} /><span>{notice}</span></div>}
    {run ? <>
      <FZ3BProgress run={run} stale={readFailed} />
      {(fz3bCanReconcileInspect(state, run) || fz3bCanReconcilePreflightInspect(state, run) || fz3bCanMaintenanceExit(state, run)) && <section className="embedded-section" aria-label="FZ3B 受控恢复操作"><div className="embedded-section-heading"><h2><ShieldCheck size={14} />受控恢复</h2><span>{fz3bCanFinishPreflight(state, run) ? '待本地收尾确认' : '仍需原生确认'}</span></div><div className="embedded-commands">
        {fz3bCanReconcileInspect(state, run) && <button type="button" className="secondary" aria-label="只读核查 FZ3B 检查占用" disabled={busy || readFailed || !!stoppingRunId} onClick={() => void runLocalAction('reconcile-inspect')}>{intent === 'reconcile-inspect' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}只读核查占用</button>}
        {fz3bCanReconcilePreflightInspect(state, run) && <button type="button" className="secondary" aria-label={fz3bCanFinishPreflight(state, run) ? '完成 FZ3B 本地恢复收尾' : '本地核查 FZ3B 预检拒绝占用'} disabled={busy || readFailed || !!stoppingRunId} onClick={() => void runLocalAction('reconcile-preflight-inspect')}>{intent === 'reconcile-preflight-inspect' ? <LoaderCircle size={13} className="spin" /> : <FileCheck2 size={13} />}{fz3bCanFinishPreflight(state, run) ? '完成本地恢复收尾' : '本地核查预检拒绝'}</button>}
        {fz3bCanMaintenanceExit(state, run) && <button type="button" className="secondary" aria-label="FZ3B 维护退出应用" disabled={busy || readFailed || !!stoppingRunId} onClick={() => void runLocalAction('maintenance-exit')}>{intent === 'maintenance-exit' ? <LoaderCircle size={13} className="spin" /> : <LogOut size={13} />}维护退出应用</button>}
        {fz3bCanQuarantineEmptyHome(state, run) && <button type="button" className="secondary" aria-label="隔离 FZ3B 主机旧空目录" disabled={busy || readFailed || !!stoppingRunId} onClick={() => void runLocalAction('quarantine-empty-home')}>{intent === 'quarantine-empty-home' ? <LoaderCircle size={13} className="spin" /> : <ShieldCheck size={13} />}隔离主机旧空目录</button>}
        {fz3bCanIsolateFailedIntent(state, run) && <button type="button" className="secondary" aria-label="Isolate failed zero-byte host intent" disabled={busy || readFailed || !!stoppingRunId} onClick={() => void runLocalAction('isolate-failed-empty-intent')}>{intent === 'isolate-failed-empty-intent' ? <LoaderCircle size={13} className="spin" /> : <ShieldCheck size={13} />}Isolate failed empty intent</button>}
      </div>{fz3bCanReconcileInspect(state, run) && <p className="hardware-agent-warning">新核查仅检查当前占用；原检查保持未知，不续跑原模型任务。</p>}{fz3bCanFinishPreflight(state, run) ? <p className="hardware-agent-warning">已封存本地释放证明，需显式保存主机收尾；不连接 SSH、不重复设备操作、不申请新授权。原检查仍未知，每次重启需再次本地确认。</p> : fz3bCanReconcilePreflightInspect(state, run) && <p className="hardware-agent-warning">仅校验已封存的本地预检拒绝证据；不连接 SSH，不授权新 Boot，不重试原操作。原检查保持未知。</p>}{fz3bCanMaintenanceExit(state, run) && <p className="hardware-agent-warning">维护退出不代表远端安全；未知与锁保留，重启后仍持锁。</p>}</section>}
      <FZ3BRunSummary run={run} stopping={stoppingRunId === run.runId} localActionPending={!!intent || externalBusy} canStop={fz3bCanStop(state, run)} onStop={onStop} canRecover={fz3bCanRecover(state, run, taskId)} recovering={intent === 'recover'} recoveryBlocked={busy || readFailed || !!stoppingRunId} onRecover={() => void runLocalAction('recover')} />
      <FZ3BRecoveryHistory run={run} />
      {run.semantic && <div ref={semanticElement}><FZ3BSemanticResult result={run.semantic} /></div>}
      <FZ3BArtifacts run={run} />
      <section className="embedded-section"><div className="embedded-commands"><button type="button" className="secondary" aria-label="导出 FZ3B 证据" disabled={!api || !fz3bCanExport(state, run) || busy || readFailed} onClick={() => void runLocalAction('export')}>{intent === 'export' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}导出证据</button></div></section>
    </> : <section className="embedded-section hardware-agent-section" aria-label="FZ3B 模型实机任务">
      <div className="embedded-section-heading"><h2><Bot size={14} />FZ3B 模型任务</h2><span>{loading ? '读取本地记录' : '尚未启动'}</span></div>
      <label className="hardware-agent-label">任务指令<textarea aria-label="FZ3B 模型任务指令" maxLength={FZ3B_INSTRUCTION_MAX} value={instruction} disabled={globalHeld || busy} onChange={event => setInstruction(event.target.value)} /></label>
      <label className="hardware-agent-model"><Code2 size={13} /><select aria-label="FZ3B 实机任务模型" value={model} disabled><option value={model}>{models.find(item => item.id === model)?.label || model}</option></select></label>
      {instruction.length > FZ3B_INSTRUCTION_MAX && <p className="hardware-agent-warning" role="alert">任务指令过长（{instruction.length} / {FZ3B_INSTRUCTION_MAX} UTF-16 单元）。</p>}
      {reason && <p className="hardware-agent-warning">{reason}</p>}
      {startupRecovery && <><button type="button" className="secondary" aria-label="核查 FZ3B 退出状态" disabled={busy || readFailed || !!stoppingRunId} onClick={() => void runLocalAction('recover')}>{intent === 'recover' ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}核查退出状态</button><p className="hardware-agent-warning">仅确认本地控制器退出，不会启动模型或重放设备操作。</p></>}
      <button type="button" className="secondary" aria-label="启动 FZ3B 模型任务" disabled={!startAllowed} onClick={() => { if (startAllowed) void onStart(instruction, model); }}>{starting ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}启动模型任务</button>
    </section>}
  </div>;
}
