import { useEffect, useState } from 'react';
import { Bot, CircleAlert, Code2, LoaderCircle, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import type { AppSnapshot } from '../../../packages/shared/contracts';
import type { HardwareAgentPhase, HardwareAgentRunView, HardwareAgentToolName } from '../../../packages/shared/hardware-agent';

type AgentState = AppSnapshot['hardwareAgent'];
const phaseNames: Record<HardwareAgentPhase, string> = { ready: '准备规划', building: '构建固件', inspecting: '检查设备', awaiting_native_approval: '等待原生授权', flashing: '烧录固件', verifying: '实机验证', exporting: '导出证据', completed: '任务完成', stopped: '模型任务已停止', needs_attention: '需要人工核查' };
const toolNames: Record<HardwareAgentToolName, string> = { embedded_status: '读取状态', embedded_build: '构建固件', embedded_inspect: '检查设备', embedded_request_flash: '请求原生授权并烧录', embedded_verify: '实机验证', embedded_export: '导出证据' };
const approvalNames: Record<HardwareAgentRunView['nativeApproval'], string> = { not_requested: '尚未请求', pending: '等待原生窗口确认', approved: '原生授权已批准', cancelled: '原生授权已取消', expired: '原生授权已过期', unknown: '原生授权状态未知' };
const callNames: Record<string, string> = { running: '执行中', succeeded: '成功', failed: '失败', unknown: '结果未知', replayed: '返回已记录结果', rejected: '已拒绝', stopped: '已停止' };
const engineNames: Record<string, string> = { stopped: '未启动', starting: '启动中', connecting: '连接中', connected: '已连接', ready: '就绪', stopping: '停止中', disconnected: '未连接', unknown: '状态未知', error: '错误' };
const storageKey = (taskId: string) => `forgedesk.hardware-agent.v1:${taskId}`;
export const HARDWARE_AGENT_INSTRUCTION_MAX = 12000;
export function hardwareAgentInstructionValid(instruction: string) { return instruction.length <= HARDWARE_AGENT_INSTRUCTION_MAX && !!instruction.trim(); }
export function hardwareAgentPhaseName(phase: HardwareAgentPhase) { return phaseNames[phase] || phase; }
function saved(taskId: string): { instruction?: string } { try { const value: unknown = JSON.parse(localStorage.getItem(storageKey(taskId)) || '{}'); const instruction = value && typeof value === 'object' && 'instruction' in value ? value.instruction : undefined; return typeof instruction === 'string' ? { instruction } : {}; } catch { return {}; } }

export function hardwareAgentLocked(state: AgentState): boolean {
  return !!state?.activeRunId || !!state?.runs.some(run => run.active || run.hardwareBusy || run.nativeApproval === 'pending');
}

export function selectedHardwareAgentRun(state: AgentState, taskId?: string, sessionId?: string) {
  return [...(state?.runs || [])].reverse().find(run => run.taskId === taskId && run.sessionId === sessionId);
}

export function hardwareAgentRecoveryAvailable(state: AgentState, run: HardwareAgentRunView | undefined) {
  return !!run && state?.activeRunId === run.runId && run.stopRequested && !run.active;
}

export function HardwareAgentRunSummary({ run, stopping, onStop, recoveryAvailable = false, recovering = false, recoveryBlocked = false, onRecover }: { run: HardwareAgentRunView; stopping: boolean; onStop: (runId: string) => void; recoveryAvailable?: boolean; recovering?: boolean; recoveryBlocked?: boolean; onRecover?: () => Promise<boolean> }) {
  const canStop = !stopping && !run.stopRequested && (run.active || run.hardwareBusy || run.nativeApproval === 'pending');
  return <div className="hardware-agent-run" data-run-id={run.runId}>
    <div className="hardware-agent-phase"><strong>{phaseNames[run.phase] || run.phase}</strong><span>{run.hardwareBusy ? '设备操作进行中' : run.stopRequested ? '停止请求处理中' : run.active ? '模型规划中' : run.status === 'completed' ? '已完成' : run.status === 'stopped' ? '模型已停止' : '需要核查'}</span></div>
    <dl className="embedded-fields"><dt>Run ID</dt><dd>{run.runId}</dd><dt>专用模型</dt><dd>{run.model}</dd><dt>控制器连接</dt><dd>#{run.generation}</dd><dt>原生授权</dt><dd>{approvalNames[run.nativeApproval] || run.nativeApproval}</dd></dl>
    {run.nativeApproval === 'pending' && <p className="hardware-agent-warning"><ShieldCheck size={13} />请在原生授权窗口核对并决定；此页面不能批准烧录。</p>}
    {(run.stopRequested || run.status === 'stopped') && <p className="hardware-agent-warning">{run.hardwareBusy ? '停止请求已记录，设备操作仍在进行；尚未确认设备停止。' : '模型任务停止状态不代表设备结果已通过。'}</p>}
    {(run.phase === 'needs_attention' || run.nativeApproval === 'unknown') && <p className="hardware-agent-warning"><CircleAlert size={13} />状态不确定，未自动重试设备操作。</p>}
    {run.failure && <p className="embedded-progress-error">{run.failure}</p>}
    {(run.active || run.hardwareBusy || run.nativeApproval === 'pending') && <button type="button" className="secondary" aria-label="停止模型实机任务" disabled={!canStop} onClick={() => onStop(run.runId)}>{stopping ? <LoaderCircle size={13} className="spin" /> : <Square size={13} />}停止模型实机任务</button>}
    {recoveryAvailable && onRecover && <><p className="hardware-agent-warning">退出状态仍需后端核查；核查不会重试烧录或把未知结果改为成功。</p><button type="button" className="secondary" aria-label="核查模型设备进程退出" disabled={stopping || recovering || recoveryBlocked} onClick={() => void onRecover()}>{recovering ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}核查模型设备进程退出</button></>}
    {run.artifact && <dl className="embedded-fields"><dt>Build ID</dt><dd>{run.artifact.buildId}</dd><dt>HEX 摘要</dt><dd>{run.artifact.hexSha256}</dd></dl>}
    {run.calls.length > 0 && <details className="embedded-details"><summary>模型工具调用记录（{run.calls.length}）</summary><ol className="hardware-agent-calls">{run.calls.map((call, index) => <li key={`${call.callId}:${index}`}><strong>{toolNames[call.tool] || call.tool}</strong><span>{callNames[call.status] || call.status}</span>{call.error && <p className="embedded-progress-error">{call.error}</p>}<pre>{JSON.stringify(call, null, 2)}</pre></li>)}</ol></details>}
    {run.export && <p className="embedded-progress-source">导出：{run.export.path}<br />SHA-256：{run.export.sha256}</p>}
  </div>;
}

export default function HardwareAgentPanel({ taskId, sessionId, state, models, configured, fresh, available, modeActive, softwareBusy, starting, stoppingRunId, onStart, onStop, onRecover, recovering = false, recoveryBlocked = false }: {
  taskId: string; sessionId?: string; state: AgentState; models: AppSnapshot['models']; configured: boolean; fresh: boolean; available: boolean; modeActive: boolean; softwareBusy: boolean; starting: boolean; stoppingRunId?: string;
  onStart: (instruction: string, model: string) => Promise<boolean>; onStop: (runId: string) => void; onRecover?: () => Promise<boolean>; recovering?: boolean; recoveryBlocked?: boolean;
}) {
  const [initial] = useState(() => saved(taskId));
  const [instruction, setInstruction] = useState(initial.instruction || '构建固定目标固件，检查设备，在原生授权后烧录并执行实机验证，最后导出证据。');
  const model = 'gpt-6.1-sol';
  useEffect(() => { try { localStorage.setItem(storageKey(taskId), JSON.stringify({ instruction, model })); } catch { /* A storage failure must not start or repeat a device action. */ } }, [taskId, instruction, model]);
  const run = selectedHardwareAgentRun(state, taskId, sessionId);
  const locked = hardwareAgentLocked(state) || starting;
  const canStart = available && !!state && configured && fresh && modeActive && !softwareBusy && !locked && !run && hardwareAgentInstructionValid(instruction) && !!model;
  const reason = !available || !state ? '专用模型控制器尚未就绪' : !configured || !modeActive ? '当前任务尚未配置实机工程' : !fresh && !run ? '仅可在尚无设备操作的新任务启动' : locked && !run ? '已有专用模型任务占用设备流程' : '';
  return <section className="embedded-section hardware-agent-section" aria-label="模型实机任务" aria-busy={starting || !!stoppingRunId || recovering}>
    <div className="embedded-section-heading"><h2><Bot size={14} />模型实机任务</h2><span>控制器：{state ? engineNames[state.engineState] || state.engineState : '未读取'}</span></div>
    <p className="embedded-adapter">固定目标：GestureScreen · 原生授权后方可烧录</p>
    {run ? <HardwareAgentRunSummary run={run} stopping={stoppingRunId === run.runId} onStop={onStop} recoveryAvailable={hardwareAgentRecoveryAvailable(state, run)} recovering={recovering} recoveryBlocked={recoveryBlocked || !available || !modeActive || softwareBusy || starting} onRecover={onRecover} /> : <>
      <label className="hardware-agent-label">专用任务指令<textarea aria-label="模型实机任务指令" maxLength={HARDWARE_AGENT_INSTRUCTION_MAX} value={instruction} disabled={locked} onChange={event => setInstruction(event.target.value)} /></label>
      <label className="hardware-agent-model"><Code2 size={13} /><select aria-label="实机任务模型" value={model} disabled><option value={model}>{models.find(item => item.id === model)?.label || model}</option></select></label>
      {reason && <p className="hardware-agent-warning">{reason}</p>}
      {instruction.length > HARDWARE_AGENT_INSTRUCTION_MAX && <p className="hardware-agent-warning" role="alert">任务指令过长（{instruction.length} / {HARDWARE_AGENT_INSTRUCTION_MAX} UTF-16 单元），请缩短后再启动。</p>}
      <button type="button" className="secondary" aria-label="启动模型实机任务" disabled={!canStart} onClick={() => { if (canStart) void onStart(instruction, model); }}>{starting ? <LoaderCircle className="spin" size={13} /> : <Play size={13} />}启动模型实机任务</button>
    </>}
  </section>;
}
