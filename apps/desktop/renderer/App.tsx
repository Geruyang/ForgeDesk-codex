import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronRight, Circle, CircleAlert, Code2, Cpu, Download, FileCheck2, FileDiff, Folder, FolderOpen, GitBranch, Hammer, LoaderCircle, MessageSquare, PanelRightClose, PanelRightOpen, Play, Plus, RefreshCw, Settings, ShieldCheck, Square, Terminal, Trash2, X } from 'lucide-react';
import type { AcceptanceView, AppSnapshot, Approval, DesktopAPI, Message, TaskView } from '../../../packages/shared/contracts';
import { EvidenceRecord, SNAPSHOT_ACCEPTANCE_ID, SnapshotPanel, snapshotBuildRetryKey } from './SnapshotPanel';
import EmbeddedPanel from './EmbeddedPanel';
import { hardwareAgentLocked, hardwareAgentPhaseName, selectedHardwareAgentRun } from './HardwareAgentPanel';
import FZ3BPanel, { HardwarePlatformTabs, fz3bAgentLocked, fz3bPhaseName, hardwarePlatformFromSaved, selectedFz3bRun, type HardwarePlatform } from './FZ3BPanel';

type Notice = { kind: 'error' | 'success'; text: string };
type WorkbenchTab = 'review' | 'delivery' | 'embedded';
type SavedUI = { projectId?: string; sessionId?: string; tab?: WorkbenchTab; hardwarePlatform?: HardwarePlatform; drafts?: Record<string, string>; models?: Record<string, string> };
type AcceptanceDraft = { id: string; title: string; kind: 'automated' | 'manual'; executable: string; args: string; timeout: string; verifierFiles: string };
const STORAGE_KEY = 'forgedesk.renderer.v1';
const labels: Record<string, string> = { idle: '就绪', ready: '就绪', connected: '已连接', disconnected: '未连接', connecting: '连接中', starting: '启动中', running: '执行中', inProgress: '执行中', in_progress: '执行中', pending: '未运行', prepared: '准备中', draft: '待验收', needs_attention: '需要处理', succeeded: '执行成功', stopped: '未启动', queued: '排队中', completed: '已完成', passed: '通过', pass: '通过', success: '通过', failed: '失败', error: '错误', interrupted: '已中断', cancelled: '已取消', canceled: '已取消', stale: '证据过期', unknown: '待核验', awaiting_approval: '等待审批', manual_required: '人工确认', stopping: '停止中', not_run: '未运行', not_started: '未运行', declined: '已拒绝', blocked: '受阻' };
const busyStatus = (status: string) => ['running', 'inProgress', 'in_progress', 'prepared', 'starting', 'queued', 'stopping', 'awaiting_approval'].includes(status);
const statusText = (status: string) => labels[status] || status;
function readSaved(): SavedUI {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const saved = value as Record<string, unknown>;
    const strings = (entries: unknown): Record<string, string> | undefined => entries && typeof entries === 'object' && !Array.isArray(entries)
      ? Object.fromEntries(Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
    return {
      projectId: typeof saved.projectId === 'string' ? saved.projectId : undefined,
      sessionId: typeof saved.sessionId === 'string' ? saved.sessionId : undefined,
      tab: saved.tab === 'review' || saved.tab === 'delivery' || saved.tab === 'embedded' ? saved.tab : undefined,
      hardwarePlatform: saved.hardwarePlatform === 'stm32' || saved.hardwarePlatform === 'fz3b' ? saved.hardwarePlatform : undefined,
      drafts: strings(saved.drafts), models: strings(saved.models),
    };
  } catch { return {}; }
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function json(value: unknown): string { try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); } }
function time(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }

function IconButton({ label, children, onClick, disabled, className = '' }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Status({ value }: { value: string }) {
  const tone = ['passed', 'pass', 'success', 'succeeded', 'ready', 'connected'].includes(value) ? 'good' : ['failed', 'error'].includes(value) ? 'bad' : ['stale', 'unknown', 'needs_attention', 'blocked', 'awaiting_approval'].includes(value) ? 'warning' : '';
  return <span className={`status ${tone}`}>{busyStatus(value) ? <LoaderCircle className="spin" size={12} /> : <Circle size={7} fill="currentColor" />}{statusText(value)}</span>;
}

export default function App() {
  const api: DesktopAPI | undefined = window.forgeDesk;
  const [saved] = useState(readSaved);
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [projectId, setProjectId] = useState(saved.projectId || '');
  const [sessionId, setSessionId] = useState(saved.sessionId || '');
  const selectionRef = useRef({ projectId, sessionId });
  selectionRef.current = { projectId, sessionId };
  const [tab, setTab] = useState<WorkbenchTab>(saved.tab === 'embedded' ? 'embedded' : saved.tab === 'delivery' ? 'delivery' : 'review');
  const [hardwarePlatform, setHardwarePlatform] = useState<HardwarePlatform>(hardwarePlatformFromSaved(saved.hardwarePlatform));
  const [drafts, setDrafts] = useState<Record<string, string>>(saved.drafts || {});
  const [models, setModels] = useState<Record<string, string>>(saved.models || {});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const pendingRef = useRef(new Set<string>());
  const mounted = useRef(true);
  const [notice, setNotice] = useState<Notice>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [diff, setDiff] = useState<{ projectId: string; text: string; truncated: boolean }>();
  const [diffError, setDiffError] = useState('');
  const [diffLoading, setDiffLoading] = useState(false);
  const diffGeneration = useRef(0);
  const [diffRevision, setDiffRevision] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followScroll = useRef(true);
  const runKeys = useRef(new Map<string, string>());
  const project = snapshot?.projects.find(item => item.id === projectId);
  const session = snapshot?.sessions.find(item => item.id === sessionId && item.projectId === projectId);
  const task = snapshot?.tasks.find(item => item.id === session?.taskId);
  const isRunning = !!session && busyStatus(session.status);
  const draft = session ? drafts[session.id] || '' : '';
  const model = session ? models[session.id] || session.model || '' : '';
  const engineReady = snapshot?.engine.state === 'ready' || snapshot?.engine.state === 'connected';
  const controlledMode = snapshot?.hardware.modeActive === true;
  const stm32Run = selectedHardwareAgentRun(snapshot?.hardwareAgent, session?.taskId, session?.id);
  const fz3bRun = selectedFz3bRun(snapshot?.fz3bAgent, session?.taskId, session?.id);
  const agentRun = stm32Run || fz3bRun;
  const stm32Busy = hardwareAgentLocked(snapshot?.hardwareAgent) || !!pending['hardware-agent-start'];
  const fz3bBusy = fz3bAgentLocked(snapshot?.fz3bAgent) || !!pending['fz3b-start'];
  const agentBusy = stm32Busy || fz3bBusy;
  const freshFz3b = !!session && !!task && session.messages.length === 0 && !session.threadId && !session.turnId && !session.engineUncertain && task.operations.length === 0;
  const canSend = !!api && !!session && !!draft.trim() && !!engineReady && !!snapshot?.account.loggedIn && !session.engineUncertain && !controlledMode && !agentRun && !agentBusy;

  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; };
    let cancelled = false;
    let received = false;
    const unsubscribe = api.subscribe(next => { received = true; if (!cancelled && mounted.current) setSnapshot(next); });
    api.snapshot().then(next => { if (!cancelled && mounted.current && !received) setSnapshot(next); }).catch(error => { if (!cancelled && mounted.current) setNotice({ kind: 'error', text: `读取工作台失败：${errorText(error)}` }); });
    return () => { cancelled = true; mounted.current = false; unsubscribe(); };
  }, [api]);

  useEffect(() => {
    if (!snapshot) return;
    if (!snapshot.projects.some(item => item.id === projectId)) {
      const next = snapshot.projects[0]?.id || '';
      setProjectId(next);
      setSessionId(snapshot.sessions.find(item => item.projectId === next)?.id || '');
    } else if (!snapshot.sessions.some(item => item.id === sessionId && item.projectId === projectId)) {
      setSessionId(snapshot.sessions.find(item => item.projectId === projectId)?.id || '');
    }
  }, [snapshot, projectId, sessionId]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ projectId, sessionId, tab, hardwarePlatform, drafts, models })); } catch { /* Storage failure does not prevent an active conversation. */ }
  }, [projectId, sessionId, tab, hardwarePlatform, drafts, models]);

  useEffect(() => {
    const generation = ++diffGeneration.current;
    setDiff(undefined); setDiffError('');
    if (!api || !projectId || tab !== 'review' || !rightOpen) { setDiffLoading(false); return; }
    setDiffLoading(true);
    api.diff(projectId).then(result => { if (mounted.current && diffGeneration.current === generation) setDiff({ ...result, projectId }); }).catch(error => { if (mounted.current && diffGeneration.current === generation) setDiffError(errorText(error)); }).finally(() => { if (mounted.current && diffGeneration.current === generation) setDiffLoading(false); });
    return () => { diffGeneration.current++; };
  }, [api, projectId, sessionId, session?.status, tab, rightOpen, diffRevision]);

  useEffect(() => { followScroll.current = true; scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [sessionId]);
  useEffect(() => { if (followScroll.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [session?.messages]);

  const action = useCallback(async (key: string, operation: () => Promise<unknown>, success?: string) => {
    if (pendingRef.current.has(key)) return false;
    pendingRef.current.add(key); setPending(old => ({ ...old, [key]: true }));
    setNotice(undefined);
    try { await operation(); if (mounted.current && success) setNotice({ kind: 'success', text: success }); return true; }
    catch (error) { if (mounted.current) setNotice({ kind: 'error', text: errorText(error) }); return false; }
    finally { pendingRef.current.delete(key); if (mounted.current) setPending(old => ({ ...old, [key]: false })); }
  }, []);

  async function importProject() {
    if (!api) return;
    await action('import', async () => { const imported = await api.importProject(); if (imported && mounted.current) {
      setSnapshot(old => old && !old.projects.some(item => item.id === imported.id) ? { ...old, projects: [...old.projects, imported] } : old);
      setProjectId(imported.id); setSessionId('');
    } });
  }
  async function newSession() {
    if (!api || !project) return;
    const currentProject = project.id;
    const previousSession = sessionId;
    await action(`new:${currentProject}`, async () => { const created = await api.createSession(currentProject, '新任务'); if (mounted.current) {
      setSnapshot(old => old && !old.sessions.some(item => item.id === created.id) ? { ...old, sessions: [...old.sessions, created] } : old);
      if (selectionRef.current.projectId === currentProject && selectionRef.current.sessionId === previousSession) setSessionId(created.id);
    } });
  }
  async function submit() {
    if (!api || !session || !canSend) return;
    const target = session.id; const text = draft; const running = isRunning;
    const succeeded = await action(`send:${target}`, () => running ? api.steer(target, text) : api.send(target, text, model || undefined), running ? '追加指令已送达当前回合。' : undefined);
    if (succeeded && mounted.current) setDrafts(old => old[target] === text ? { ...old, [target]: '' } : old);
  }
  async function startHardwareAgent(instruction: string, selectedModel: string): Promise<boolean> {
    if (!api || !session || agentBusy) return false;
    const target = session.taskId; const targetSession = session.id;
    return action('hardware-agent-start', async () => {
      const created = await api.hardwareAgentStart(target, instruction, selectedModel);
      if (created.taskId !== target || created.sessionId !== targetSession) throw new Error('专用模型任务返回了其他会话的绑定，已阻止切换。');
      if (mounted.current) setSnapshot(old => {
        if (!old || old.hardwareAgent?.runs.some(run => run.runId === created.runId)) return old;
        return { ...old, hardwareAgent: { ...old.hardwareAgent, engineState: old.hardwareAgent?.engineState || 'unknown', runs: [...(old.hardwareAgent?.runs || []), created], activeRunId: old.hardwareAgent?.activeRunId || (created.active || created.hardwareBusy ? created.runId : undefined) } };
      });
    });
  }
  async function stopHardwareAgent(runId: string) {
    if (!api || !snapshot?.hardwareAgent?.runs.some(run => run.runId === runId)) return;
    await action(`hardware-agent-stop:${runId}`, () => api.hardwareAgentStop(runId));
  }
  async function startFz3bAgent(instruction: string, selectedModel: string): Promise<boolean> {
    if (!api || !session || agentBusy || !snapshot?.fz3bAgent?.available) return false;
    const target = session.taskId; const targetSession = session.id;
    return action('fz3b-start', async () => {
      const created = await api.fz3bAgentStart(target, instruction, selectedModel);
      if (created.taskId !== target || created.sessionId !== targetSession) throw new Error('FZ3B 模型任务返回了其他会话的绑定。');
      if (mounted.current) setSnapshot(old => {
        if (!old?.fz3bAgent || old.fz3bAgent.runs.some(run => run.runId === created.runId)) return old;
        return { ...old, fz3bAgent: { ...old.fz3bAgent, runs: [...old.fz3bAgent.runs, created], activeRunId: old.fz3bAgent.activeRunId || (created.active || created.hardwareBusy ? created.runId : undefined) } };
      });
    });
  }
  async function stopFz3bAgent(runId: string) {
    if (!api || !snapshot?.fz3bAgent?.runs.some(run => run.runId === runId)) return;
    await action(`fz3b-stop:${runId}`, () => api.fz3bAgentStop(runId));
  }
  async function runAcceptance(item: AcceptanceView) {
    if (!api || !task || agentBusy || controlledMode) return;
    if (item.id === SNAPSHOT_ACCEPTANCE_ID) { await runSnapshotBuild(); return; }
    const target = task.id; const key = `${target}:${item.id}`;
    const requestKey = runKeys.current.get(key) || crypto.randomUUID(); runKeys.current.set(key, requestKey);
    const succeeded = await action(`run:${key}`, () => api.runAcceptance(target, item.id, requestKey));
    if (succeeded) runKeys.current.delete(key);
  }
  async function runSnapshotBuild() {
    if (!api || !task || agentBusy || controlledMode) return;
    const target = task.id; const key = snapshotBuildRetryKey(task);
    const requestKey = runKeys.current.get(key) || crypto.randomUUID(); runKeys.current.set(key, requestKey);
    if (await action(`snapshot-build:${target}`, () => api.runSnapshotBuild(target, requestKey))) runKeys.current.delete(key);
  }
  async function exportTask() {
    if (!api || !task || agentBusy) return;
    await action(`export:${task.id}`, async () => { const path = await api.exportTask(task.id); if (path && mounted.current) setNotice({ kind: 'success', text: `交付包已导出：${path}` }); });
  }

  return <div className={`workbench ${rightOpen ? '' : 'review-hidden'}`}>
    <header className="app-header">
      <div className="brand"><img src="./assets/brand.png" alt="" /><strong>ForgeDesk</strong><span className="brand-edition">工程工作台</span></div>
      <div className="header-context"><GitBranch size={14} /><span title={project?.root}>{project?.name || '未选择项目'}</span></div>
      <div className="header-actions"><Status value={snapshot?.engine.state || (api ? 'starting' : 'disconnected')} /><IconButton label="设置与诊断" onClick={() => setSettingsOpen(true)}><Settings size={17} /></IconButton></div>
    </header>

    <aside className="sidebar">
      <div className="section-heading"><span>项目</span><IconButton label="导入项目" onClick={importProject} disabled={!api || pending.import}><Plus size={16} /></IconButton></div>
      <div className="project-list">{snapshot?.projects.map(item => <button className={`project-button ${projectId === item.id ? 'selected' : ''}`} key={item.id} title={item.root} onClick={() => { setProjectId(item.id); setSessionId(snapshot.sessions.find(value => value.projectId === item.id)?.id || ''); }}><Folder size={16} /><span>{item.name}</span>{projectId === item.id && <ChevronDown size={13} />}</button>)}</div>
      {!snapshot?.projects.length && <div className="sidebar-empty">尚未导入项目</div>}
      <div className="section-heading sessions-heading"><span>会话</span><IconButton label="新建任务" onClick={newSession} disabled={!project || pending[`new:${projectId}`]}><Plus size={16} /></IconButton></div>
      <div className="session-list">{snapshot?.sessions.filter(item => item.projectId === projectId).map(item => <button className={`session-button ${sessionId === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setSessionId(item.id)}><MessageSquare size={14} /><span><strong>{item.title}</strong><small>{statusText(item.status)}</small></span>{busyStatus(item.status) && <LoaderCircle className="spin" size={13} />}</button>)}</div>
      {project && !snapshot?.sessions.some(item => item.projectId === projectId) && <div className="sidebar-empty">暂无会话</div>}
      <div className="sidebar-footer"><button onClick={() => setSettingsOpen(true)}><span className={`account-dot ${snapshot?.account.loggedIn ? 'online' : ''}`} /><span><strong>{snapshot?.account.label || '尚未登录'}</strong><small>{snapshot?.account.loggedIn ? '已认证' : '连接引擎与账号'}</small></span><Settings size={15} /></button><small className="app-version">ForgeDesk {snapshot?.version || '0.1.0'}</small></div>
    </aside>

    <main className="conversation">
      <div className="pane-heading"><div><MessageSquare size={16} /><h1>{session?.title || '工作区'}</h1></div><div>{session && <Status value={session.status} />}<IconButton label={rightOpen ? '收起审阅面板' : '展开审阅面板'} onClick={() => setRightOpen(value => !value)}>{rightOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</IconButton></div></div>
      {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><CircleAlert size={15} /><span>{notice.text}</span><IconButton label="关闭提示" onClick={() => setNotice(undefined)}><X size={14} /></IconButton></div>}
      {!api && <div className="notice error" role="alert"><CircleAlert size={15} /><span>当前页面没有桌面连接。请通过 ForgeDesk Windows 应用打开工作台。</span></div>}
      {snapshot?.engine.error && <div className="notice error"><CircleAlert size={15} /><span>{snapshot.engine.error}</span></div>}
      {controlledMode && <div className="notice warning"><ShieldCheck size={15} /><span>工程受控模式：普通聊天已禁用，设备操作仍需独立原生授权。</span></div>}
      {agentRun && <div className={`notice ${agentRun.phase === 'needs_attention' ? 'warning' : ''}`}><Cpu size={15} /><span>{fz3bRun ? 'FZ3B 模型任务' : '模型实机任务'} · {fz3bRun ? fz3bPhaseName(fz3bRun.phase) : stm32Run ? hardwareAgentPhaseName(stm32Run.phase) : ''}{agentRun.nativeApproval === 'pending' ? ' · 等待原生窗口确认' : agentRun.stopRequested && agentRun.hardwareBusy ? ' · 设备操作尚未停止' : ''}</span>{!rightOpen && (!agentRun.stopRequested || !!fz3bRun) && (agentRun.active || agentRun.hardwareBusy || agentRun.nativeApproval === 'pending') && <IconButton label="停止模型实机任务" disabled={!!pending[`${fz3bRun ? 'fz3b-stop' : 'hardware-agent-stop'}:${agentRun.runId}`]} onClick={() => void (fz3bRun ? stopFz3bAgent(agentRun.runId) : stopHardwareAgent(agentRun.runId))}><Square size={13} /></IconButton>}</div>}
      {(session?.historyIncomplete || session?.engineUncertain) && <div className="notice warning"><CircleAlert size={15} /><span>{session.engineUncertain ? '引擎状态仍不确定，已暂停发送。请查看诊断并重新连接；会话历史可能存在缺口。' : '会话历史不完整，缺失记录仍未恢复。可继续当前会话，或创建新任务。'}</span></div>}
      <div className="messages" ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) followScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; }}>
        {!project ? <div className="empty-workspace"><img src="./assets/brand.png" alt="" /><h2>ForgeDesk</h2><p>选择工程，开始新任务</p><button className="primary" onClick={importProject} disabled={!api || pending.import}><FolderOpen size={16} />{pending.import ? '打开中…' : '导入项目'}</button><span className="empty-caption">本地项目 · 真实执行 · 工程交付</span></div> : !session ? <div className="empty-workspace"><FolderOpen size={36} strokeWidth={1.4} /><h2>{project.name}</h2><p className="project-root">{project.root}</p><button className="primary" onClick={newSession} disabled={pending[`new:${projectId}`]}><Plus size={16} />新建任务</button></div> : !session.messages.length ? <div className="empty-session"><MessageSquare size={30} strokeWidth={1.4} /><h2>新任务</h2><p>今天要完成什么工程工作？</p>{!snapshot?.account.loggedIn && !controlledMode && <button className="text-button" onClick={() => setSettingsOpen(true)}>连接引擎与账号<ChevronRight size={14} /></button>}</div> : session.messages.map(message => <MessageItem key={message.id} message={message} />)}
        {!controlledMode && !agentRun && !agentBusy && !!snapshot?.approvals.length && <div className="approvals">{snapshot.approvals.map(approval => <ApprovalItem key={`${approval.generation}:${approval.id}`} approval={approval} pending={!!pending[`approve:${approval.generation}:${approval.id}`]} decide={decision => api && action(`approve:${approval.generation}:${approval.id}`, () => api.approve(approval.generation, approval.id, decision))} />)}</div>}
      </div>
      <div className="composer-area">
        <div className="composer"><textarea aria-label={isRunning ? '追加指令' : '任务指令'} placeholder={session ? (isRunning ? '补充当前任务的指令…' : '描述任务、约束和验收要求…') : '先导入项目并创建任务'} value={draft} disabled={!session || !!agentRun} onChange={event => session && setDrafts(old => ({ ...old, [session.id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className="composer-tools"><div className="model-control"><Code2 size={14} /><select aria-label="模型" value={model} disabled={!session || controlledMode || !!agentRun || isRunning || !!pending[`send:${sessionId}`]} onChange={event => session && setModels(old => ({ ...old, [session.id]: event.target.value }))}><option value="">引擎默认模型</option>{model && !snapshot?.models.some(item => item.id === model) && <option value={model}>{model}</option>}{snapshot?.models.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></div><div className="composer-commands">{isRunning && !agentRun && <IconButton label="停止当前回合" disabled={!api || pending[`stop:${sessionId}`]} onClick={() => api && session && void action(`stop:${session.id}`, () => api.interrupt(session.id))}><Square size={14} fill="currentColor" /></IconButton>}<button className="send-button" title={isRunning ? '追加到当前回合' : '发送任务'} aria-label={isRunning ? '追加指令' : '发送任务'} disabled={!canSend || pending[`send:${sessionId}`]} onClick={submit}>{pending[`send:${sessionId}`] ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={17} />}{isRunning && <span>追加</span>}</button></div></div>
        </div><div className="composer-status"><span><span className={`account-dot ${engineReady && snapshot?.account.loggedIn ? 'online' : ''}`} />{!session ? '等待项目与任务' : agentRun ? '模型实机专用会话' : controlledMode ? '工程受控模式' : !engineReady ? '引擎未就绪' : !snapshot?.account.loggedIn ? '账号未登录' : isRunning ? '当前回合执行中' : '准备就绪'}</span>{session?.turnId && <span title={session.turnId}>回合 {session.turnId.slice(0, 8)}</span>}</div>
      </div>
    </main>

    {rightOpen && <aside className="review-panel"><div className="review-tabs" role="tablist" aria-label="任务面板"><button role="tab" aria-selected={tab === 'review'} className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}><FileDiff size={15} />代码审阅</button><button role="tab" aria-selected={tab === 'delivery'} className={tab === 'delivery' ? 'active' : ''} onClick={() => setTab('delivery')}><FileCheck2 size={15} />工程交付</button><button role="tab" aria-selected={tab === 'embedded'} className={tab === 'embedded' ? 'active' : ''} onClick={() => setTab('embedded')}><Cpu size={15} />实机流程</button></div>
      {tab === 'review' ? <><div className="review-toolbar"><span>{project ? '工作区差异' : '未选择项目'}</span><IconButton label="刷新代码差异" onClick={() => setDiffRevision(value => value + 1)} disabled={!project || diffLoading}><RefreshCw size={15} className={diffLoading ? 'spin' : ''} /></IconButton>{project && <IconButton label="在资源管理器中打开项目" onClick={() => api && void action('open', () => api.openProject(project.id))}><FolderOpen size={15} /></IconButton>}</div><div className="diff-view">{diffLoading ? <div className="panel-empty"><LoaderCircle className="spin" size={22} /><p>读取差异…</p></div> : diffError ? <div className="panel-empty error-text"><CircleAlert size={23} /><p>{diffError}</p></div> : diff?.projectId === projectId && diff.text ? <><div className="diff-code">{diff.text.split('\n').map((line, index) => <div className={line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'diff-file' : line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''} key={index}><span className="line-number">{index + 1}</span><code>{line || ' '}</code></div>)}</div>{diff.truncated && <div className="notice warning">差异已截断，当前显示内容不完整。</div>}</> : <div className="panel-empty"><FileDiff size={28} strokeWidth={1.4} /><p>{project ? '当前没有可显示的差异' : '导入项目后查看代码差异'}</p></div>}</div></> : tab === 'embedded' ? <><HardwarePlatformTabs platform={hardwarePlatform} onChange={setHardwarePlatform} />{hardwarePlatform === 'fz3b' ? <FZ3BPanel key={`fz3b:${session?.taskId || 'empty'}`} taskId={session?.taskId} sessionId={session?.id} api={api} state={snapshot?.fz3bAgent} models={snapshot?.models} loggedIn={snapshot?.account.loggedIn === true} fresh={freshFz3b} modeActive={controlledMode} softwareBusy={isRunning && !agentRun} otherHardwareBusy={stm32Busy || !!stm32Run} starting={!!pending['fz3b-start']} stoppingRunId={snapshot?.fz3bAgent?.runs.find(run => pending[`fz3b-stop:${run.runId}`])?.runId} onStart={startFz3bAgent} onStop={runId => void stopFz3bAgent(runId)} /> : <EmbeddedPanel key={session?.taskId || 'empty'} taskId={session?.taskId} sessionId={session?.id} api={api} hardware={snapshot?.hardware} softwareBusy={(isRunning && !agentRun) || fz3bBusy || !!fz3bRun} agentState={snapshot?.hardwareAgent} models={snapshot?.models} agentStarting={!!pending['hardware-agent-start']} agentStoppingRunId={snapshot?.hardwareAgent?.runs.find(run => pending[`hardware-agent-stop:${run.runId}`])?.runId} onAgentStart={startHardwareAgent} onAgentStop={runId => void stopHardwareAgent(runId)} />}</> : <DeliveryPanel key={task?.id || 'empty'} task={task} api={api} pending={pending} action={action} run={runAcceptance} buildSnapshot={runSnapshotBuild} sessionBusy={isRunning || agentBusy || controlledMode} exportTask={exportTask} hardware={snapshot?.hardware} />}
    </aside>}
    {settingsOpen && <SettingsDialog snapshot={snapshot} api={api} pending={pending} action={action} error={notice?.kind === 'error' ? notice.text : undefined} close={() => setSettingsOpen(false)} />}
  </div>;
}

function MessageItem({ message }: { message: Message }) {
  if (message.role === 'tool') return <details className="tool-message"><summary><Terminal size={15} /><span>{message.text.split('\n')[0]?.slice(0, 110) || '工具活动'}</span>{message.status && <Status value={message.status} />}<ChevronDown size={13} /></summary><pre>{message.text}</pre><small>{time(message.timestamp)}</small></details>;
  return <article className={`message ${message.role}`}><div className="message-meta"><span className="message-avatar">{message.role === 'assistant' ? <Hammer size={13} /> : message.role === 'user' ? <ArrowUp size={13} /> : <CircleAlert size={13} />}</span><strong>{message.role === 'assistant' ? 'ForgeDesk' : message.role === 'user' ? '你' : '系统'}</strong><time dateTime={message.timestamp}>{time(message.timestamp)}</time>{message.status && <Status value={message.status} />}</div><div className="message-text">{message.text}</div></article>;
}
function ApprovalItem({ approval, pending, decide }: { approval: Approval; pending: boolean; decide: (decision: string) => unknown }) {
  const decisionLabels: Record<string, string> = { accept: '允许本次', acceptForSession: '允许本会话', decline: '拒绝', cancel: '取消', approve: '允许本次', reject: '拒绝' };
  const methodLabels: Record<string, string> = {
    'item/commandExecution/requestApproval': '执行命令审批',
    'item/fileChange/requestApproval': '文件修改审批',
    'mcpServer/elicitation/request': 'MCP 请求确认',
  };
  const params = approval.params && typeof approval.params === 'object' ? approval.params as Record<string, unknown> : {};
  const fields = [
    { key: 'serverName', label: '服务器' },
    { key: 'message', label: '说明' },
    { key: 'reason', label: '原因' },
    { key: 'command', label: '命令' },
    { key: 'cwd', label: '目录' },
  ];
  return <section className="approval">
    <header><ShieldCheck size={17} /><strong>{methodLabels[approval.method] || '需要你的审批'}</strong><span>连接 #{approval.generation}</span></header>
    <p>方法：{approval.method}</p>
    {fields.map(field => {
      const value = params[field.key];
      if (value === undefined || value === null || value === '') return null;
      const text = typeof value === 'string' ? value : json(value);
      return <p key={field.key}>{field.label}：{text.length > 400 ? `${text.slice(0, 400)}…` : text}</p>;
    })}
    <details><summary>完整请求参数</summary><pre>{json(approval.params)}</pre></details>
    <div className="approval-actions">{approval.decisions.map(decision => <button key={decision} className={['accept', 'approve'].includes(decision) ? 'primary' : 'secondary'} disabled={pending} onClick={() => decide(decision)}>{decisionLabels[decision] || decision}</button>)}</div>
  </section>;
}

type Action = (key: string, operation: () => Promise<unknown>, success?: string) => Promise<boolean>;
function DeliveryPanel({ task, api, pending, action, run, buildSnapshot, sessionBusy, exportTask, hardware }: { task?: TaskView; api?: DesktopAPI; pending: Record<string, boolean>; action: Action; run: (item: AcceptanceView) => void; buildSnapshot: () => void; sessionBusy: boolean; exportTask: () => void; hardware?: AppSnapshot['hardware'] }) {
  const [editing, setEditing] = useState(false);
  if (!task) return <div className="panel-empty"><FileCheck2 size={28} strokeWidth={1.4} /><p>创建任务后查看验收与证据</p></div>;
  const passed = task.acceptance.filter(item => ['passed', 'pass', 'success'].includes(item.status)).length;
  const operationBusy = sessionBusy || task.operations.some(item => busyStatus(item.status));
  return <div className="delivery-scroll"><div className="delivery-summary"><div><span>任务验收</span><Status value={task.status} /></div><strong>{passed}<span> / {task.acceptance.length}</span></strong><small>已通过验收项</small></div><div className="delivery-actions"><button className="secondary" onClick={() => api && void action(`refresh:${task.id}`, () => api.refreshEvidence(task.id))} disabled={!api || operationBusy || pending[`refresh:${task.id}`]}><RefreshCw size={14} className={pending[`refresh:${task.id}`] ? 'spin' : ''} />核对证据</button><button className="secondary" onClick={exportTask} disabled={!api || operationBusy || pending[`export:${task.id}`]}><Download size={14} />导出交付包</button></div>
    <div className="section-heading"><span>验收单</span><IconButton label={editing ? '关闭验收编辑' : '编辑验收单'} onClick={() => setEditing(value => !value)} disabled={operationBusy}>{editing ? <X size={15} /> : <Plus size={15} />}</IconButton></div>
    {editing ? <AcceptanceEditor task={task} save={async items => { if (!api || operationBusy) return false; return action(`acceptance:${task.id}`, () => api.setAcceptance(task.id, items), '验收单已保存。'); }} pending={pending[`acceptance:${task.id}`] || operationBusy} done={() => setEditing(false)} /> : <div className="acceptance-list">{task.acceptance.length ? task.acceptance.map(item => <div className="acceptance-item" key={item.id}><div><span className="acceptance-icon">{['passed', 'pass', 'success'].includes(item.status) ? <Check size={15} /> : <Circle size={14} />}</span><strong>{item.title}</strong>{item.kind === 'automated' && <IconButton label={`运行验证：${item.title}`} onClick={() => run(item)} disabled={item.id === SNAPSHOT_ACCEPTANCE_ID || !api || pending[`run:${task.id}:${item.id}`] || operationBusy}><Play size={14} /></IconButton>}</div><footer><span>{item.id === SNAPSHOT_ACCEPTANCE_ID ? '固定快照验收' : item.kind === 'manual' ? '人工验收' : '自动验证'}</span><Status value={item.status} /></footer>{item.command && <code className="command-preview" title={`${item.command.executable}\n${json(item.command.args)}`}>{item.command.executable} {item.command.args.join(' ')}</code>}</div>) : <div className="section-empty">尚未设置验收项<button className="text-button" disabled={operationBusy} onClick={() => setEditing(true)}><Plus size={14} />创建验收单</button></div>}</div>}
    <SnapshotPanel task={task} enabling={!!pending[`snapshot-enable:${task.id}`]} building={!!pending[`snapshot-build:${task.id}`]} busy={operationBusy} unavailable={!api} onEnable={() => api && void action(`snapshot-enable:${task.id}`, () => api.enableSnapshot(task.id))} onBuild={buildSnapshot} />
    <div className="section-heading"><span>执行记录</span><span className="count">{task.operations.length}</span></div><div className="record-list">{task.operations.length ? [...task.operations].reverse().map(item => <OperationRecord key={item.id} taskId={task.id} operation={item} api={api} pending={pending} action={action} />) : <p className="section-empty">尚未运行验证</p>}</div>
    <div className="section-heading"><span>交付证据</span><span className="count">{task.evidence.length}</span></div><div className="record-list">{task.evidence.length ? [...task.evidence].reverse().map((item, index) => <EvidenceRecord key={String(item.id || item.operationId || index)} evidence={item} />) : <p className="section-empty">尚无已采集证据</p>}</div><p className="evidence-note">A级绑定工作区状态；B级仅限已启用且通过验证的任务快照模板。不构成防篡改保证。</p>
    <div className="hardware-section"><div><ShieldCheck size={15} /><strong>设备执行</strong><span>{hardware?.userDriven ? '本地手动授权' : '未开放'}</span></div><p>{hardware?.reason || '模型设备工具未开放。'}</p></div>
  </div>;
}

function OperationRecord({ taskId, operation, api, pending, action }: { taskId: string; operation: TaskView['operations'][number]; api?: DesktopAPI; pending: Record<string, boolean>; action: Action }) {
  const [log, setLog] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const generation = useRef(0);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  async function loadLog() {
    if (!api || loading) return;
    const current = ++generation.current; setLoading(true); setError('');
    try { const text = await api.readOperationLog(taskId, operation.id); if (active.current && current === generation.current) setLog(text); }
    catch (issue) { if (active.current && current === generation.current) setError(errorText(issue)); }
    finally { if (active.current && current === generation.current) setLoading(false); }
  }
  const cancelKey = `cancel:${taskId}:${operation.id}`;
  const kindLabels: Record<string, string> = { build: '构建', test: '验证' };
  const kind = operation.kind || operation.type || '验证操作';
  const operationName = `${operation.evidenceLevel === 'B' ? 'B 级任务快照 · ' : ''}${kindLabels[kind] || kind}`;
  const phases: Record<string, string> = { snapshotting: '采集快照', sandbox_probe: '沙箱探测', permission_probe: '权限探测', building: '构建', verifying: '验证', finalizing: '整理证据' };
  const phase = typeof operation.phase === 'string' ? operation.phase : '';
  return <details className="record operation-record" onToggle={event => { if (event.currentTarget.open && log === undefined && !loading) void loadLog(); }}>
    <summary><Terminal size={14} /><span title={operationName}>{operationName}</span>{phase && <span className="operation-phase" title={phase}>{phases[phase] || phase}</span>}<Status value={operation.status} /><ChevronDown size={12} /></summary>
    <div className="operation-toolbar"><span>原始执行日志</span><IconButton label="刷新执行日志" disabled={!api || loading} onClick={() => void loadLog()}><RefreshCw className={loading ? 'spin' : ''} size={14} /></IconButton>{['prepared', 'running', 'stopping'].includes(operation.status) && <IconButton label="停止此验证操作" disabled={!api || pending[cancelKey]} onClick={() => api && void action(cancelKey, () => api.cancelOperation(taskId, operation.id))}><Square size={13} fill="currentColor" /></IconButton>}</div>
    {error && <p className="error-text" role="alert">{error}</p>}
    <pre className="operation-log">{log === undefined ? (loading ? '正在读取日志…' : '尚未读取日志') : log || '当前日志为空'}</pre>
    <details className="operation-metadata"><summary>操作与证据详情</summary><pre>{json(operation)}</pre></details>
  </details>;
}

export function AcceptanceEditor({ task, save, pending, done }: { task: TaskView; save: (items: Parameters<DesktopAPI['setAcceptance']>[1]) => Promise<boolean>; pending?: boolean; done: () => void }) {
  const [rows, setRows] = useState<AcceptanceDraft[]>(() => task.acceptance.filter(item => item.id !== SNAPSHOT_ACCEPTANCE_ID).map(item => ({ id: item.id, title: item.title, kind: item.kind, executable: item.command?.executable || '', args: JSON.stringify(item.command?.args || []), timeout: String(item.command?.timeoutMs || 120000), verifierFiles: JSON.stringify(item.verifierFiles || []) })));
  const [error, setError] = useState('');
  const update = (id: string, patch: Partial<AcceptanceDraft>) => setRows(old => old.map(row => row.id === id ? { ...row, ...patch } : row));
  async function submit() {
    try {
      const items = rows.map(row => {
        if (!row.title.trim()) throw new Error('请填写每项验收的名称。');
        if (row.kind === 'manual') return { id: row.id, title: row.title.trim(), kind: row.kind };
        if (!row.executable.trim()) throw new Error(`“${row.title}”需要可执行文件。`);
        const args: unknown = JSON.parse(row.args);
        if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new Error(`“${row.title}”的参数必须是 JSON 字符串数组。`);
        const verifierFiles: unknown = JSON.parse(row.verifierFiles);
        if (!Array.isArray(verifierFiles) || !verifierFiles.length || !verifierFiles.every(file => typeof file === 'string' && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(file))) throw new Error(`“${row.title}”需要验证脚本的绝对路径 JSON 数组。`);
        const timeoutMs = Number(row.timeout);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('超时须为 100 至 300000 毫秒。');
        return { id: row.id, title: row.title.trim(), kind: row.kind, command: { executable: row.executable.trim(), args: args as string[], timeoutMs }, verifierFiles: verifierFiles as string[] };
      });
      setError(''); if (await save(items)) done();
    } catch (issue) { setError(errorText(issue)); }
  }
  return <form className="acceptance-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <fieldset disabled={pending}>
      {task.acceptance.some(item => item.id === SNAPSHOT_ACCEPTANCE_ID) && <p className="snapshot-fixed-acceptance"><ShieldCheck size={13} />快照验收由 Node 算术示例 v1 固定模板管理，不可编辑或删除。</p>}
      {rows.map((row, index) => <div className="acceptance-row" key={row.id}>
        <div className="editor-row-heading"><span>验收 {index + 1}</span><IconButton label={`删除验收 ${index + 1}`} onClick={() => setRows(old => old.filter(item => item.id !== row.id))}><Trash2 size={14} /></IconButton></div>
        <label>名称<input value={row.title} onChange={event => update(row.id, { title: event.target.value })} /></label>
        <label>验收方式<select value={row.kind} onChange={event => update(row.id, { kind: event.target.value as AcceptanceDraft['kind'] })}><option value="automated">自动验证</option><option value="manual">人工验收</option></select></label>
        {row.kind === 'automated' && <>
          <label>可执行文件<input value={row.executable} placeholder="C:/Program Files/nodejs/node.exe" onChange={event => update(row.id, { executable: event.target.value })} spellCheck={false} /></label>
          <label>参数（JSON 数组）<textarea value={row.args} placeholder={'["--test", "C:/trusted-tests/example.test.js"]'} onChange={event => update(row.id, { args: event.target.value })} spellCheck={false} /></label>
          <label>项目外验证脚本（绝对路径 JSON 数组）<textarea value={row.verifierFiles} placeholder={'["C:/trusted-tests/example.test.js"]'} onChange={event => update(row.id, { verifierFiles: event.target.value })} spellCheck={false} /></label>
          <label>超时（毫秒）<input type="number" min="100" max="300000" step="100" value={row.timeout} onChange={event => update(row.id, { timeout: event.target.value })} /></label>
        </>}
      </div>)}
      <button className="text-button" type="button" onClick={() => setRows(old => [...old, { id: crypto.randomUUID(), title: '', kind: 'automated', executable: '', args: '[]', timeout: '120000', verifierFiles: '[]' }])}><Plus size={14} />添加验收项</button>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="editor-actions"><button className="secondary" type="button" onClick={done}>取消</button><button className="primary" type="submit" disabled={pending}>{pending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}保存验收单</button></div>
    </fieldset>
  </form>;
}

function SettingsDialog({ snapshot, api, pending, action, close, error }: { snapshot?: AppSnapshot; api?: DesktopAPI; pending: Record<string, boolean>; action: Action; close: () => void; error?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [exportedPath, setExportedPath] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => { dialog.current?.close(); }; }, []);
  return <dialog className="settings-dialog" ref={dialog} aria-labelledby="settings-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><Settings size={18} /><h2 id="settings-title">设置与诊断</h2></div><IconButton label="关闭设置" onClick={close}><X size={18} /></IconButton></header>
    {error && <div className="notice error" role="alert"><CircleAlert size={15} /><span>{error}</span></div>}
    <div className="settings-content">
      <section><div className="settings-section-heading"><h3>Codex 引擎</h3><Status value={snapshot?.engine.state || 'disconnected'} /></div><dl><dt>可执行文件</dt><dd>{snapshot?.engine.executable || '尚未读取'}</dd><dt>独立引擎目录</dt><dd>{snapshot?.engine.home || '尚未读取'}</dd></dl>{snapshot?.engine.error && <p className="error-text">{snapshot.engine.error}</p>}<button className="secondary" onClick={() => api && void action('connect', () => api.connect())} disabled={!api || snapshot?.hardware.modeActive || hardwareAgentLocked(snapshot?.hardwareAgent) || fz3bAgentLocked(snapshot?.fz3bAgent) || pending.connect}><RefreshCw className={pending.connect ? 'spin' : ''} size={15} />{pending.connect ? '连接中…' : '连接 / 重连引擎'}</button></section>
      <section><div className="settings-section-heading"><h3>账号认证</h3><span className={`status ${snapshot?.account.loggedIn ? 'good' : ''}`}>{snapshot?.account.loggedIn ? '已登录' : '未登录'}</span></div><p>{snapshot?.account.label || '尚未认证'}</p><button className="primary" disabled={!api || snapshot?.hardware.modeActive || hardwareAgentLocked(snapshot?.hardwareAgent) || fz3bAgentLocked(snapshot?.fz3bAgent) || pending.login || pending.connect} onClick={() => api && void action('login', () => api.login())}><ShieldCheck size={15} />{pending.login ? '正在登录…' : snapshot?.account.loggedIn ? '重新登录' : '登录 Codex'}</button></section>
      <section><h3>本地数据</h3><p className="path-text">{snapshot?.dataDir || '尚未读取'}</p></section>
      <section><div className="settings-section-heading"><h3>运行诊断</h3><button className="secondary" disabled={!api || pending.diagnostics} onClick={() => api && void action('diagnostics', async () => { const path = await api.exportDiagnostics(); if (path) setExportedPath(path); })}><Download size={14} />导出诊断</button></div>{exportedPath && <p className="path-text" role="status">已导出：{exportedPath}</p>}<pre className="diagnostics-log">{snapshot?.diagnostics.length ? snapshot.diagnostics.join('\n') : '暂无诊断记录'}</pre></section>
      <section><div className="settings-section-heading"><h3>设备执行</h3><span className="status warning">{snapshot?.hardware.userDriven ? '本地手动授权' : '未开放'}</span></div><p>{snapshot?.hardware.reason || '模型设备工具未开放。'}</p></section>
    </div>
    <footer><span>ForgeDesk {snapshot?.version || '0.1.0'}</span><span>本地工作区</span></footer>
  </dialog>;
}
