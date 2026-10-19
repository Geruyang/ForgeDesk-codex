import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowLeftRight, ChevronDown, CircleAlert, Cpu, Download, Fingerprint, Hammer, LoaderCircle, RefreshCw, ScanLine, Settings2, ShieldCheck, Upload, Usb } from 'lucide-react';
import type { AppSnapshot, DesktopAPI } from '../../../packages/shared/contracts';
import type { EmbeddedOperation, EmbeddedProgress, EmbeddedStatus } from '../../../packages/engineering-runner/embedded/types';
import HardwareAgentPanel, { hardwareAgentLocked, hardwareAgentRecoveryAvailable, selectedHardwareAgentRun } from './HardwareAgentPanel';

type Intent = 'configure' | 'build' | 'inspect' | 'flash' | 'verify' | 'export' | 'recover' | 'leave';
const activeIntents = new Map<string, Intent>();
const activeRequestKeys = new Map<string, string>();
const operationNames: Record<EmbeddedOperation['kind'], string> = { build: '固件构建', inspect: '设备检查', flash: '授权烧录', verify: '实机验证' };
const operationStates: Record<EmbeddedOperation['status'], string> = { prepared: '准备中', running: '执行中', succeeded: '执行成功', failed: '失败', unknown: '结果未知' };
const intentNames: Record<Intent, string> = { configure: '配置工程', build: '固件构建', inspect: '设备检查', flash: '授权并烧录', verify: '实机验证', export: '导出证据', recover: '核查进程退出', leave: '返回软件模式' };
const stageNames: Record<EmbeddedProgress['stage'], string> = { preflight: '烧录前校验', probe_discovery: '查找调试探针', connecting: '连接目标', identifying: '核对设备身份', backup_read_1: '备份读取（第 1 次）', backup_read_2: '备份读取（第 2 次）', backup_saved: '保存备份', preflash_compare: '比对烧录前状态', erase_program: '擦除与写入', readback: '读取回验', reset: '复位目标', cdc_discovery: '查找 CDC 设备', cdc_challenge_1: '实机挑战验证（第 1 次）', cdc_challenge_2: '实机挑战验证（第 2 次）', finalizing: '整理结果' };
const passNames: Record<string, string> = { 'Erasing sectors': '擦除扇区', 'Programming pages': '写入页面' };
function detail(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function date(value: string): string { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN'); }

export function selectFlashOperation(status: EmbeddedStatus | undefined, intent?: Intent, pendingRequestKey?: string) {
  const operations = [...(status?.operations || [])].reverse();
  return operations.find(operation => operation.kind === 'flash' && (intent !== 'flash' || operation.requestKey === pendingRequestKey));
}

export function flashTelemetry(operation: EmbeddedOperation | undefined) {
  const progress = operation?.progress;
  if (!progress || progress.schemaVersion !== 1 || operation?.kind !== 'flash' || progress.action !== 'flash' || progress.operationId !== operation.id || !Object.hasOwn(stageNames, progress.stage) || !Number.isInteger(progress.sequence) || progress.sequence < 0 || !Number.isFinite(Date.parse(progress.updatedAt))) return undefined;
  const { completed, total, unit } = progress;
  const known = typeof completed === 'number' && Number.isFinite(completed) && typeof total === 'number' && Number.isFinite(total) && total > 0 && completed >= 0 && completed <= total && (unit === 'bytes' || unit === 'steps' || (unit === 'fraction' && total === 1));
  const percent = known ? completed === total ? 100 : Math.floor((completed / total) * 1000) / 10 : undefined;
  const pass = progress.stage === 'erase_program' && progress.message && Object.hasOwn(passNames, progress.message) ? passNames[progress.message] : undefined;
  return { progress, stage: pass || stageNames[progress.stage], percent, message: pass || progress.message };
}

export function FlashProgress({ operation, pending, stale, progressRef }: { operation?: EmbeddedOperation; pending: boolean; stale: boolean; progressRef?: RefObject<HTMLElement | null> }) {
  if (!operation && !pending) return null;
  const active = operation?.status === 'prepared' || operation?.status === 'running';
  const telemetry = flashTelemetry(operation);
  const percent = telemetry?.percent;
  const progressText = percent === undefined ? '进度未知' : `${active ? '当前阶段' : '最后上报'} ${percent}%`;
  const outcome = operation?.status === 'unknown' ? '写入结果尚未确认，未自动重试。' : operation?.status === 'failed' ? '烧录失败，未自动重试。' : operation?.status === 'succeeded' ? '烧录操作已成功；实机验证单独记录。' : operation ? '设备操作尚未完成。' : '尚无本次烧录操作记录，未确认开始写入。';
  return <section ref={progressRef} className={`embedded-section embedded-flash-progress ${operation?.status || 'pending'}`} aria-label="烧录状态" data-operation-id={operation?.id || ''}>
    <div className="embedded-section-heading"><h2><Upload size={14} />{active || pending ? '烧录进度' : '最近烧录状态'}</h2><span>{operation ? operationStates[operation.status] : '等待授权或服务受理'}</span></div>
    <div className="embedded-progress-caption"><span>{telemetry?.stage || (operation ? '阶段未上报' : '等待操作记录')}</span><strong>{progressText}</strong></div>
    <div className={`embedded-progress-track${percent === undefined ? ' indeterminate' : ''}`} role="progressbar" aria-label="烧录当前阶段进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${progressText}；${operation ? operationStates[operation.status] : '尚未确认开始写入'}`}>
      {percent !== undefined && <span style={{ width: `${percent}%` }} />}
    </div>
    {telemetry?.message && telemetry.message !== telemetry.stage && <p className="embedded-progress-source">{telemetry.message}</p>}
    {telemetry && <p className="embedded-progress-source">各阶段独立计数，不代表整体烧录进度。</p>}
    <p className="embedded-progress-outcome">{active && <LoaderCircle size={12} className="spin" />}{outcome}</p>
    {operation?.detail && <p className="embedded-progress-error">{operation.detail}</p>}
    {stale && <p className="embedded-progress-stale">最新状态读取失败；以上为上次记录，进度可能已变化。</p>}
    {pending && operation && !active && <p className="embedded-progress-stale">服务已记录终态，正在等待本次调用返回。</p>}
    {telemetry && <p className="embedded-progress-source">worker {percent === undefined ? '阶段记录' : '当前阶段计数'} · {date(telemetry.progress.updatedAt)}</p>}
    {operation && <p className="embedded-progress-source">操作 {operation.id} · 状态更新于 {date(operation.updatedAt)}</p>}
  </section>;
}

export function embeddedAvailability(status: EmbeddedStatus | undefined, modeActive: boolean, busy: boolean, readFailed: boolean, now = Date.now()) {
  const unknown = !!status?.operations.some(operation => operation.status === 'unknown');
  const unresolved = !!status?.operations.some(operation => operation.status === 'unknown' && !operation.recoveredAt);
  const activeOperation = !!status?.operations.some(operation => ['prepared', 'running'].includes(operation.status));
  const locked = busy || activeOperation || readFailed || !status;
  const artifact = status?.artifact;
  const buildConsistent = !!artifact && !!artifact.projectSourceBefore && !!artifact.snapshotSourceBefore && !!artifact.hexSha256 && !!artifact.axfSha256 && !!artifact.sourceSha256 && !!status?.profileSha256 && artifact.projectSourceBefore === artifact.projectSourceAfter && artifact.snapshotSourceBefore === artifact.snapshotSourceAfter && artifact.profileSha256 === status.profileSha256;
  const grant = status?.grant;
  const grantExpiry = grant ? Date.parse(grant.expiresAt) : Number.NaN;
  const grantExpired = !!grant && Number.isFinite(grantExpiry) && grantExpiry <= now;
  const grantMatches = !!grant && !!artifact && grant.taskId === status?.taskId && grant.artifactId === artifact.id && grant.buildId === artifact.buildId && grant.hexSha256 === artifact.hexSha256 && grant.axfSha256 === artifact.axfSha256 && grant.sourceSha256 === artifact.sourceSha256 && grant.profileId === status?.profileId && grant.profileSha256 === status.profileSha256;
  const grantCurrent = grantMatches && !!grant?.approvedAt && Number.isFinite(Date.parse(grant.approvedAt)) && Number.isFinite(grantExpiry) && !grantExpired;
  const flashed = !!artifact && !!status?.operations.some(operation => operation.kind === 'flash' && operation.status === 'succeeded' && operation.artifactId === artifact.id);
  const configured = !!status?.configured;
  const lastFlash = status?.operations.reduce((last, operation, index) => operation.kind === 'flash' || operation.status === 'unknown' ? index : last, -1) ?? -1;
  const lastInspection = status?.operations.reduce((last, operation, index) => operation.kind === 'inspect' && operation.status === 'succeeded' ? index : last, -1) ?? -1;
  const inspected = lastInspection >= 0 && lastInspection > lastFlash;
  const canHardware = !locked && !unresolved && modeActive && configured && !!status?.hardwareAvailable;
  return {
    unknown, unresolved, activeOperation, locked, buildConsistent, grantExpired, grantMatches, grantCurrent,
    configure: !locked && !unresolved,
    build: !locked && !unresolved && modeActive && configured,
    inspect: canHardware,
    flash: canHardware && buildConsistent && inspected,
    verify: canHardware && buildConsistent && grantCurrent && flashed,
    export: !locked && modeActive && configured,
    recover: !locked && unresolved && modeActive,
    leave: !locked && !unresolved && modeActive,
  };
}

export default function EmbeddedPanel({ taskId, sessionId, api, hardware, softwareBusy, agentState, models = [], agentStarting = false, agentStoppingRunId, onAgentStart, onAgentStop }: {
  taskId?: string; sessionId?: string; api?: DesktopAPI; hardware?: AppSnapshot['hardware']; softwareBusy: boolean; agentState?: AppSnapshot['hardwareAgent']; models?: AppSnapshot['models']; agentStarting?: boolean; agentStoppingRunId?: string; onAgentStart?: (instruction: string, model: string) => Promise<boolean>; onAgentStop?: (runId: string) => void;
}) {
  const [status, setStatus] = useState<EmbeddedStatus>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [readFailed, setReadFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [intent, setIntent] = useState<Intent>();
  const [pendingRequestKey, setPendingRequestKey] = useState<string>();
  const [externalBusy, setExternalBusy] = useState(false);
  const mounted = useRef(false);
  const readVersion = useRef(0);
  const modeActive = hardware?.modeActive === true;
  const available = !!api && hardware?.userDriven === true;
  const agentBlocked = hardwareAgentLocked(agentState) || agentStarting;

  const refresh = useCallback(async () => {
    if (!api || !taskId || !available) { if (mounted.current) setLoading(false); return; }
    const version = ++readVersion.current; setLoading(true);
    try {
      const next = await api.hardwareSnapshot(taskId);
      if (next.taskId !== taskId) throw new Error('设备状态不属于当前任务，已阻止操作。');
      if (mounted.current && version === readVersion.current) { setStatus(next); setReadFailed(false); setReadError(''); }
    } catch (failure) { if (mounted.current && version === readVersion.current) { setReadError(detail(failure)); setReadFailed(true); } }
    finally {
      if (mounted.current && version === readVersion.current) {
        setLoading(false); setIntent(activeIntents.get(taskId)); setPendingRequestKey(activeRequestKeys.get(taskId)); setExternalBusy(activeIntents.size > 0 && !activeIntents.has(taskId));
      }
    }
  }, [api, taskId, available]);

  useEffect(() => {
    mounted.current = true; let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => { await refresh(); if (!cancelled) timer = setTimeout(() => { void poll(); }, 2000); };
    void poll();
    return () => { cancelled = true; mounted.current = false; readVersion.current++; if (timer) clearTimeout(timer); };
  }, [refresh]);

  async function run(kind: Intent, heldRecovery = false): Promise<boolean> {
    if (!api || !taskId || !available || activeIntents.size > 0) return false;
    const allowed = embeddedAvailability(status, modeActive, softwareBusy || agentBlocked, readFailed);
    const recoveringHeldAgent = kind === 'recover' && heldRecovery && hardwareAgentRecoveryAvailable(agentState, selectedHardwareAgentRun(agentState, taskId, sessionId)) && modeActive && !!status && !readFailed && !softwareBusy && !agentStarting && !agentStoppingRunId;
    if (!allowed[kind] && !recoveringHeldAgent) return false;
    const requestKey = crypto.randomUUID();
    activeIntents.set(taskId, kind); activeRequestKeys.set(taskId, requestKey); setIntent(kind); setPendingRequestKey(requestKey); setError(''); setNotice(''); setLoading(false); readVersion.current++;
    try {
      let next: EmbeddedStatus | undefined;
      if (kind === 'configure') next = await api.hardwareConfigure(taskId);
      else if (kind === 'build') next = await api.hardwareBuild(taskId, requestKey);
      else if (kind === 'inspect') next = await api.hardwareInspect(taskId, requestKey);
      else if (kind === 'flash') next = await api.hardwareFlash(taskId, requestKey);
      else if (kind === 'verify') next = await api.hardwareVerify(taskId, requestKey);
      else if (kind === 'recover') next = await api.hardwareRecover(taskId);
      else if (kind === 'leave') await api.hardwareLeaveMode();
      else {
        const exported = await api.hardwareExport(taskId);
        if (exported && mounted.current) setNotice(`证据已导出：${exported}`);
      }
      if (next && next.taskId !== taskId) throw new Error('设备操作返回了其他任务的状态。');
      if (next && mounted.current) { readVersion.current++; setStatus(next); setReadFailed(false); }
      return true;
    } catch (failure) {
      if (mounted.current) setError(`${detail(failure)}${kind === 'flash' ? '；未自动重试烧录，请核查操作记录。' : ''}`);
      return false;
    } finally {
      activeIntents.delete(taskId); activeRequestKeys.delete(taskId);
      if (mounted.current) { setIntent(undefined); setPendingRequestKey(undefined); await refresh(); }
    }
  }

  if (!taskId) return <div className="panel-empty"><Cpu size={28} strokeWidth={1.4} /><p>尚未选择工程任务</p></div>;
  const agentPanel = onAgentStart && onAgentStop ? <HardwareAgentPanel key={taskId} taskId={taskId} sessionId={sessionId} state={agentState} models={models} configured={!!status?.configured} fresh={!!status && status.operations.length === 0 && !readFailed && !loading && !intent && !externalBusy} available={available} modeActive={modeActive} softwareBusy={softwareBusy} starting={agentStarting} stoppingRunId={agentStoppingRunId} onStart={onAgentStart} onStop={onAgentStop} onRecover={() => run('recover', true)} recovering={intent === 'recover'} recoveryBlocked={!status || readFailed || !!intent || externalBusy || !!agentStoppingRunId} /> : undefined;
  return <EmbeddedStatusView status={status} loading={loading} readFailed={readFailed} busy={!!intent || externalBusy || softwareBusy || agentBlocked} intent={intent} pendingRequestKey={pendingRequestKey} available={available} modeActive={modeActive} reason={hardware?.reason} error={[readError, error].filter(Boolean).join('；')} notice={notice} agentPanel={agentPanel} refresh={() => void refresh()} run={kind => void run(kind)} />;
}

export function EmbeddedStatusView({ status, loading, readFailed, busy, intent, pendingRequestKey, available, modeActive, reason, error, notice, agentPanel, refresh, run }: {
  status?: EmbeddedStatus; loading: boolean; readFailed: boolean; busy: boolean; intent?: Intent; pendingRequestKey?: string; available: boolean; modeActive: boolean; reason?: string; error: string; notice: string; agentPanel?: ReactNode; refresh: () => void; run: (kind: Intent) => void;
}) {
  const progressRef = useRef<HTMLElement>(null);
  const scrolledFlashRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (intent !== 'flash' || !pendingRequestKey || scrolledFlashRequest.current === pendingRequestKey || !progressRef.current) return;
    scrolledFlashRequest.current = pendingRequestKey;
    progressRef.current.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
  }, [intent, pendingRequestKey]);
  const gates = embeddedAvailability(status, modeActive, busy, readFailed || !available);
  const artifact = status?.artifact;
  const grant = status?.grant;
  const grantText = !grant ? '尚未授权绑定' : gates.grantExpired ? '授权已过期' : !gates.grantMatches ? '授权与当前产物不匹配' : gates.grantCurrent ? '已授权' : '授权未确认';
  const command = (kind: Intent, icon: ReactNode) => <button type="button" className="secondary" disabled={!gates[kind]} onClick={() => run(kind)} aria-label={intentNames[kind]}>{intent === kind ? <LoaderCircle size={14} className="spin" /> : icon}{intentNames[kind]}</button>;
  return <div className="embedded-scroll" aria-busy={busy || gates.activeOperation} data-pending-intent={intent || ''} data-task-id={status?.taskId || ''}>
    <div className="embedded-mode"><div><ShieldCheck size={15} /><strong>{modeActive ? '工程受控模式' : '软件模式'}</strong><button className="icon-button" type="button" title="刷新实机状态" aria-label="刷新实机状态" disabled={!available || loading} onClick={refresh}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button></div><p>{reason || '模型设备工具未开放'}</p>{modeActive && command('leave', <ArrowLeftRight size={14} />)}</div>
    {error && <div className="notice error" role="alert"><CircleAlert size={14} /><span>{error}</span></div>}
    {notice && <div className="notice success" role="status"><Download size={14} /><span>{notice}</span></div>}
    {gates.unknown && <div className="notice warning" role="alert"><CircleAlert size={15} /><span>{gates.unresolved ? '存在结果未知的操作，需人工核查。烧录与返回软件模式已阻止。' : '历史操作结果仍未知；服务已确认进程退出，未重放操作。'}</span></div>}
    {gates.unresolved && <div className="embedded-commands">{command('recover', <RefreshCw size={14} />)}</div>}
    <FlashProgress progressRef={progressRef} operation={selectFlashOperation(status, intent, pendingRequestKey)} pending={intent === 'flash'} stale={readFailed} />
    {agentPanel}
    {loading && !status ? <div className="panel-empty"><LoaderCircle size={22} className="spin" /><p>读取实机状态…</p></div> : <>
      <section className="embedded-section"><div className="embedded-section-heading"><h2><Cpu size={14} />工程配置</h2><span>{status?.configured ? '已配置' : status ? '未配置' : '未读取'}</span></div>
        <dl className="embedded-fields"><dt>配置 ID</dt><dd>{status?.profileId || '未记录'}</dd><dt>工程</dt><dd>{status?.projectRoot || '当前任务工程'}</dd>{status?.profileSha256 && <><dt>配置摘要</dt><dd>{status.profileSha256}</dd></>}</dl>
        <div className="embedded-commands">{command('configure', <Settings2 size={14} />)}{command('build', <Hammer size={14} />)}</div>
      </section>
      <section className="embedded-section"><div className="embedded-section-heading"><h2><Fingerprint size={14} />固件与源码</h2><span>{artifact ? gates.buildConsistent ? '构建前后指纹一致' : '需重新构建' : status ? '尚未构建' : '未读取'}</span></div>
        {artifact ? <><dl className="embedded-fields"><dt>Build ID</dt><dd>{artifact.buildId}</dd><dt>源码摘要</dt><dd>{artifact.sourceSha256}</dd><dt>HEX</dt><dd>{artifact.hexPath}</dd><dt>HEX SHA-256</dt><dd>{artifact.hexSha256}</dd><dt>AXF SHA-256</dt><dd>{artifact.axfSha256}</dd></dl><details className="embedded-details"><summary>构建输入与产物记录</summary><pre>{JSON.stringify(artifact, null, 2)}</pre></details></> : <p className="embedded-empty">尚无本任务固件产物</p>}
      </section>
      <section className="embedded-section"><div className="embedded-section-heading"><h2><Usb size={14} />设备与授权</h2><span className={gates.grantCurrent ? 'good-text' : ''}>{grantText}</span></div>
        <p className="embedded-adapter">{status?.hardwareAvailable ? '本地设备适配器可用' : status ? '本地设备适配器不可用' : '本地设备适配器未读取'} · 通用模型设备工具未开放</p>
        {grant && <><dl className="embedded-fields"><dt>探针序列号</dt><dd>{grant.identity.probeSerial}</dd><dt>设备 UID</dt><dd>{grant.identity.uid}</dd><dt>芯片 ID</dt><dd>{grant.identity.chipId}</dd><dt>Flash</dt><dd>{grant.identity.flashKiB} KiB</dd><dt>CDC 序列号</dt><dd>{grant.identity.cdcSerial}</dd><dt>授权范围</dt><dd>单次烧录与验证 <code>{grant.scope}</code></dd><dt>备份摘要</dt><dd>{grant.backupSha256}</dd><dt>授权到期</dt><dd>{date(grant.expiresAt)}</dd>{grant.consumedBy && <><dt>烧录操作</dt><dd>{grant.consumedBy}</dd></>}</dl><details className="embedded-details"><summary>授权绑定记录</summary><pre>{JSON.stringify(grant, null, 2)}</pre></details></>}
        <div className="embedded-commands">{command('inspect', <ScanLine size={14} />)}{command('flash', <Upload size={14} />)}{command('verify', <ShieldCheck size={14} />)}{command('export', <Download size={14} />)}</div>
      </section>
      <section className="embedded-section"><div className="embedded-section-heading"><h2>操作记录</h2><span>{status?.operations.length ?? '未读取'}</span></div>
        {status?.operations.length ? [...status.operations].reverse().map(operation => <details key={operation.id} className="record embedded-operation"><summary><Cpu size={13} /><span>{operationNames[operation.kind]}</span><span className={`status ${operation.status === 'failed' ? 'bad' : operation.status === 'unknown' ? 'warning' : ''}`}>{['prepared', 'running'].includes(operation.status) && <LoaderCircle className="spin" size={11} />}{operationStates[operation.status]}</span><ChevronDown size={12} /></summary>{operation.detail && <p>{operation.detail}</p>}<pre>{JSON.stringify(operation, null, 2)}</pre></details>) : <p className="embedded-empty">尚无本任务设备操作</p>}
      </section>
      {status?.limitation && <p className="evidence-note">{status.limitation}</p>}
    </>}
  </div>;
}
