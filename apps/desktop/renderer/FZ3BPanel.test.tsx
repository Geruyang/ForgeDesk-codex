import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { AppSnapshot, DesktopAPI } from '../../../packages/shared/contracts';
import FZ3BPanel, { FZ3BArtifacts, FZ3BProgress, FZ3BRecoveryHistory, FZ3BRunSummary, FZ3BSemanticResult, HardwarePlatformTabs, FZ3B_INSTRUCTION_MAX, fz3bAgentLocked, fz3bCanExport, fz3bCanImportKey, fz3bCanMaintenanceExit, fz3bCanReconcileInspect, fz3bCanReconcilePreflightInspect, fz3bCanRecover, fz3bCanStop, fz3bInstructionValid, fz3bOperationProgress, hardwarePlatformFromSaved, selectedFz3bRun } from './FZ3BPanel';
import { fz3bFixtureArtifact, fz3bFixtureMaintenanceExit, fz3bFixtureReconciliation, fz3bFixtureRun, fz3bFixtureSemantic } from './FZ3BPanel.fixture';

type AgentState = NonNullable<AppSnapshot['fz3bAgent']>;
const agentState = (changes: Partial<AgentState> = {}): AgentState => ({ available: true, status: 'available', resourcesVerified: true, keyImportAllowed: true, runs: [], engineState: 'stopped', ...changes });

test('platform tabs retain STM32 and expose only the fixed FZ3B choice', () => {
  assert.equal(hardwarePlatformFromSaved('fz3b'), 'fz3b');
  for (const value of [undefined, null, {}, 'anything', 'STM32']) assert.equal(hardwarePlatformFromSaved(value), 'stm32');
  const html = renderToStaticMarkup(createElement(HardwarePlatformTabs, { platform: 'fz3b', onChange() {} }));
  assert.match(html, /aria-label="设备平台"/); assert.match(html, /STM32/); assert.match(html, /FZ3B/);
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  assert.doesNotMatch(html, /<input|<select|ssh|hostname|command/);
});

test('operation phases without actual counters are indeterminate, never invented percentages', () => {
  const run = fz3bFixtureRun();
  let html = renderToStaticMarkup(createElement(FZ3BProgress, { run, stale: false }));
  assert.match(html, /PS验收包构建/); assert.match(html, /未上报计数/); assert.doesNotMatch(html, /aria-valuenow/);
  const operation = run.operations[0];
  for (const progress of [{ completed: 0, total: 0, unit: 'steps' }, { completed: -1, total: 4, unit: 'steps' }, { completed: 5, total: 4, unit: 'steps' }, { completed: Number.NaN, total: 4, unit: 'bytes' }]) {
    operation.progress = { stage: 'fixture-stage', updatedAt: run.updatedAt, ...progress } as typeof operation.progress;
    assert.equal(fz3bOperationProgress(operation)?.percent, undefined);
  }
  operation.progress = { stage: 'fixture-stage', updatedAt: run.updatedAt, completed: 2, total: 4, unit: 'steps' };
  assert.equal(fz3bOperationProgress(operation)?.percent, 50);
  html = renderToStaticMarkup(createElement(FZ3BProgress, { run, stale: true }));
  assert.match(html, /aria-valuenow="50"/); assert.match(html, /当前阶段 50%/); assert.match(html, /上次记录/);
  operation.progress.updatedAt = 'invalid'; assert.equal(fz3bOperationProgress(operation), undefined);
});

test('PS package build never implies new Vivado, PL deployment or STM32 artifacts', () => {
  const html = renderToStaticMarkup(createElement(FZ3BArtifacts, { run: fz3bFixtureRun({ artifact: fz3bFixtureArtifact }) }));
  assert.match(html, /PS验收包构建/); assert.match(html, /固定 PS 源码包/); assert.match(html, /未构建或部署新 PL/);
  assert.match(html, /验收包摘要/); assert.match(html, /包清单摘要/);
  assert.doesNotMatch(html, /HEX|AXF|Vivado.*成功|新 PL.*已加载/);
});

test('application classification unknown and remote operation unknown are separate facts', () => {
  const html = renderToStaticMarkup(createElement(FZ3BSemanticResult, { result: { ...fz3bFixtureSemantic, classificationUnknown: true, expectedLabelMatched: false } }));
  assert.match(html, /应用分类：未知/); assert.match(html, /未匹配固定预期/);
  assert.doesNotMatch(html, /远端结果未知|设备操作成功|FZ3B.*验收通过/);
  const run = fz3bFixtureRun({ phase: 'needs_attention', active: false, hardwareBusy: true });
  run.operations[0].status = 'unknown';
  const progress = renderToStaticMarkup(createElement(FZ3BProgress, { run, stale: false }));
  assert.match(progress, /远端结果未知/); assert.match(progress, /未自动重试/); assert.match(progress, /尚未确认结束/);
});

test('matching the fixed ranking does not imply hitting the threshold or a known classification', () => {
  const html = renderToStaticMarkup(createElement(FZ3BSemanticResult, { result: { ...fz3bFixtureSemantic, classificationUnknown: true, thresholdHit: false, expectedLabelMatched: true } }));
  assert.match(html, /排名匹配固定预期/); assert.match(html, /应用分类：未知/); assert.match(html, /未达阈值/);
  assert.doesNotMatch(html, /应用已返回分类|FZ3B.*验收通过|设备操作成功/);
});

test('semantic rendering shows real text fixture facts and escapes all returned labels', () => {
  const result = { ...fz3bFixtureSemantic, ranking: [{ ...fz3bFixtureSemantic.ranking[0], label: '<script>unsafe</script>' }] };
  const html = renderToStaticMarkup(createElement(FZ3BSemanticResult, { result }));
  assert.match(html, /真实文本编码/); assert.match(html, /非合成向量/); assert.match(html, /0\.33456/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/); assert.match(html, /未加载新 PL/);
});

test('native approval is read-only and Stop does not attest remote quiescence', () => {
  const run = fz3bFixtureRun({ phase: 'awaiting_native_approval', nativeApproval: 'pending' });
  const props = { run, stopping: false, canStop: true, onStop() {}, canRecover: false, recovering: false, recoveryBlocked: false, onRecover() {} };
  let html = renderToStaticMarkup(createElement(FZ3BRunSummary, props));
  assert.match(html, /本面板不授予设备授权/); assert.equal((html.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(html, />批准<|>允许本次<|confirmGrant|authorize|deploy/);
  run.stopRequested = true; run.hardwareBusy = true; run.active = false; run.phase = 'needs_attention'; run.failure = '<img src=x onerror=unsafe()>';
  html = renderToStaticMarkup(createElement(FZ3BRunSummary, { ...props, canRecover: true }));
  assert.match(html, /再次确认模型停止/); assert.match(html, /设备操作仍未确认结束/);
  assert.match(html, /不会重试计算/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|设备已停止/);
});

test('FZ3B lock, selected run, Stop retry and recovery preserve exact owner binding', () => {
  const mine = fz3bFixtureRun({ active: false, stopRequested: true, hardwareBusy: true, status: 'needs_attention', phase: 'needs_attention' });
  const other = fz3bFixtureRun({ runId: 'other-run', sessionId: 'other-session' });
  const state = agentState({ activeRunId: mine.runId, runs: [mine, other], engineState: 'failed' });
  assert.equal(selectedFz3bRun(state, mine.taskId, mine.sessionId), mine);
  assert.equal(selectedFz3bRun(state, mine.taskId, 'missing'), undefined);
  assert.equal(fz3bAgentLocked(state), true); assert.equal(fz3bCanRecover(state, mine), true); assert.equal(fz3bCanStop(state, mine), true);
  assert.equal(fz3bCanRecover(state, other), false); assert.equal(fz3bCanStop(state, other), false);
  assert.equal(fz3bCanRecover(state, { ...mine, active: true }), false);
  assert.equal(fz3bCanRecover(state, { ...mine, stopRequested: false }), false);
  const noHardware = { ...mine, hardwareBusy: false };
  assert.equal(fz3bCanStop(state, noHardware), true, 'A previous Stop with unconfirmed local exit must be retryable');
  assert.equal(fz3bCanStop({ ...state, engineState: 'stopped' }, noHardware), false);
  assert.equal(fz3bAgentLocked(agentState({ engineState: 'unknown', activeRunId: 'pending-publication' })), true);
  assert.equal(fz3bAgentLocked(agentState()), false);
});

test('verified missing-key setup keeps its native import entry in idle controlled mode', () => {
  const state = agentState({ available: false, status: 'missing-key', keyImportAllowed: true });
  const props = { taskId: 'offline-task', sessionId: 'offline-session', api: {} as DesktopAPI, state, loggedIn: true, fresh: true, modeActive: true, softwareBusy: false, otherHardwareBusy: false, starting: false, onStart: async () => true, onStop() {} };
  const html = renderToStaticMarkup(createElement(FZ3BPanel, props));
  assert.match(html, /aria-label="FZ3B 返回软件模式"/); assert.match(html, /aria-label="导入 FZ3B 设备密钥"/); assert.match(html, /尚未导入本项目设备密钥/);
  assert.doesNotMatch(html, /aria-label="导入 FZ3B 设备密钥" disabled/);
  for (const unavailable of [agentState({ available: false, status: 'invalid-resources', resourcesVerified: false, keyImportAllowed: false, reason: 'FZ3B_PROJECT_KEY_MISSING' }), agentState({ keyImportAllowed: false })]) {
    assert.equal(fz3bCanImportKey(unavailable), false);
    assert.doesNotMatch(renderToStaticMarkup(createElement(FZ3BPanel, { ...props, state: unavailable })), /aria-label="导入 FZ3B 设备密钥"/);
  }
  assert.equal(fz3bCanImportKey({ available: false, reason: 'FZ3B_PROJECT_KEY_MISSING', runs: [], engineState: 'stopped' } as unknown as AgentState), false);
});

test('startup recovery without a backend run requires the explicit owning task, never an engine error guess', () => {
  const state = agentState({ recoveryTaskId: 'offline-task', engineState: 'failed', keyImportAllowed: false });
  assert.equal(fz3bAgentLocked(state), true);
  assert.equal(fz3bCanRecover(state, undefined, 'offline-task'), true);
  assert.equal(fz3bCanRecover(state, undefined, 'other-task'), false);
  assert.equal(fz3bCanRecover(state, undefined), false);
  assert.equal(fz3bCanRecover(agentState({ engineState: 'failed' }), undefined, 'offline-task'), false);
  const props = { taskId: 'offline-task', sessionId: 'offline-session', api: {} as DesktopAPI, state, loggedIn: true, fresh: true, modeActive: true, softwareBusy: false, otherHardwareBusy: false, starting: false, onStart: async () => true, onStop() {} };
  const html = renderToStaticMarkup(createElement(FZ3BPanel, props));
  assert.match(html, /aria-label="核查 FZ3B 退出状态"/); assert.match(html, /不会启动模型或重放设备操作/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(FZ3BPanel, { ...props, taskId: 'other-task' })), /aria-label="核查 FZ3B 退出状态"/);
});

test('inspect reconciliation and maintenance exit require exact host candidates, not unknown text', () => {
  const run = fz3bFixtureRun({ active: false, stopRequested: true, hardwareBusy: true, phase: 'needs_attention', status: 'needs_attention' });
  const actions = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, reconcileInspect: true, maintenanceExit: true, exportEvidence: true };
  const state = agentState({ activeRunId: run.runId, runs: [run], recoveryActions: actions, keyImportAllowed: false });
  assert.equal(fz3bCanReconcileInspect(state, run), true); assert.equal(fz3bCanMaintenanceExit(state, run), true);
  for (const recoveryActions of [undefined, { ...actions, taskId: 'foreign-task' }, { ...actions, sessionId: 'foreign-session' }, { ...actions, runId: 'foreign-run' }]) {
    assert.equal(fz3bCanReconcileInspect({ ...state, recoveryActions }, run), false); assert.equal(fz3bCanMaintenanceExit({ ...state, recoveryActions }, run), false);
  }
  assert.equal(fz3bCanReconcileInspect(state, undefined), false);
  const props = { taskId: run.taskId, sessionId: run.sessionId, api: {} as DesktopAPI, state, loggedIn: true, fresh: false, modeActive: true, softwareBusy: false, otherHardwareBusy: false, starting: false, onStart: async () => true, onStop() {} };
  const html = renderToStaticMarkup(createElement(FZ3BPanel, props));
  assert.match(html, /aria-label="只读核查 FZ3B 检查占用"/); assert.match(html, /aria-label="FZ3B 维护退出应用"/); assert.match(html, /仍需原生确认/);
  assert.match(html, /原检查保持未知/); assert.match(html, /重启后仍持锁/); assert.doesNotMatch(html, />批准<|>确认授权<|远端已安全/);
  const semanticOnly = renderToStaticMarkup(createElement(FZ3BPanel, { ...props, state: { ...state, recoveryActions: { ...actions, reconcileInspect: false } } }));
  assert.doesNotMatch(semanticOnly, /aria-label="只读核查 FZ3B 检查占用"/); assert.match(semanticOnly, /aria-label="FZ3B 维护退出应用"/);
});

test('fresh reconciliation and local maintenance records never rewrite unknown historical operations', () => {
  const run = fz3bFixtureRun({ active: false, stopRequested: true, hardwareBusy: false, status: 'needs_attention', phase: 'needs_attention', reconciliations: [fz3bFixtureReconciliation], maintenanceExit: fz3bFixtureMaintenanceExit });
  run.operations[0].status = 'unknown';
  const before = JSON.stringify(run);
  const html = renderToStaticMarkup(createElement(FZ3BRecoveryHistory, { run }));
  assert.match(html, /当前占用已解除/); assert.match(html, /原检查仍为未知/); assert.match(html, /原模型任务不会续跑/); assert.match(html, /重启后仍需核查/);
  assert.doesNotMatch(html, /原检查.*通过|设备已安全|模型任务已恢复/); assert.equal(JSON.stringify(run), before);
  const progress = renderToStaticMarkup(createElement(FZ3BProgress, { run, stale: false }));
  assert.match(progress, /历史记录不会改为通过/); assert.doesNotMatch(progress, /设备占用仍需核查/);
  const failed = renderToStaticMarkup(createElement(FZ3BRecoveryHistory, { run: { ...run, maintenanceExit: undefined, reconciliations: [{ ...fz3bFixtureReconciliation, status: 'failed', error: '<script>unsafe</script>' }] } }));
  assert.match(failed, /尚未确认解除占用/); assert.match(failed, /&lt;script&gt;/); assert.doesNotMatch(failed, /<script>/);
});

test('preflight refusal recovery is an exact host capability with distinct local-only wording', async () => {
  const run = fz3bFixtureRun({ active: false, stopRequested: true, hardwareBusy: true, phase: 'needs_attention', status: 'needs_attention' });
  run.operations[0].kind = 'inspect'; run.operations[0].status = 'unknown';
  const actions = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, reconcileInspect: false, reconcilePreflightRefusedInspect: true, maintenanceExit: true, exportEvidence: true };
  const state = agentState({ activeRunId: run.runId, runs: [run], recoveryActions: actions });
  assert.equal(fz3bCanReconcilePreflightInspect(state, run), true);
  for (const recoveryActions of [undefined, { ...actions, runId: 'foreign' }, { ...actions, taskId: 'foreign' }, { ...actions, sessionId: 'foreign' }]) assert.equal(fz3bCanReconcilePreflightInspect({ ...state, recoveryActions }, run), false);
  const html = renderToStaticMarkup(createElement(FZ3BPanel, { taskId: run.taskId, sessionId: run.sessionId, api: {} as DesktopAPI, state, loggedIn: true, fresh: false,
    modeActive: true, softwareBusy: false, otherHardwareBusy: false, starting: false, onStart: async () => true, onStop() {} }));
  assert.match(html, /aria-label="本地核查 FZ3B 预检拒绝占用"/); assert.match(html, /不连接 SSH，不授权新 Boot/);
  assert.doesNotMatch(html, /aria-label="只读核查 FZ3B 检查占用"/);
  const calls: unknown[][] = [], assigned: unknown[] = [], errors: string[] = [];
  const context = { api: { fz3bReconcilePreflightRefusedInspect: async (...args: unknown[]) => { calls.push(args); return { ...run, hardwareBusy: false }; } }, taskId: run.taskId, sessionId: run.sessionId, state, run,
    globalHeld: true, activeActions: new Map<string, string>(), starting: false, softwareBusy: false, otherHardwareBusy: false, readFailed: false, stoppingRunId: undefined as string | undefined, modeActive: true,
    mounted: { current: true }, fz3bCanReconcilePreflightInspect, setIntent() {}, setError(value: string) { if (value) errors.push(value); }, setNotice() {},
    setCachedRun(value: unknown) { assigned.push(value); }, errorText: (value: unknown) => String(value), refresh: async () => {} };
  const invoke = runInNewContext(`${rendererFunction('FZ3BPanel', 'runLocalAction')}\ninvoke;`, context) as (kind: string) => Promise<void>;
  await invoke('reconcile-preflight-inspect'); assert.deepEqual(calls, [[run.runId]]); assert.equal(assigned.length, 1);
  assert.equal(run.operations[0].status, 'unknown'); assert.equal(run.hardwareBusy, true);
  context.state.recoveryActions = { ...actions, sessionId: 'foreign' }; await invoke('reconcile-preflight-inspect'); assert.equal(calls.length, 1);
  context.state.recoveryActions = actions; context.stoppingRunId = run.runId; await invoke('reconcile-preflight-inspect'); assert.equal(calls.length, 1); context.stoppingRunId = undefined;
  context.api.fz3bReconcilePreflightRefusedInspect = async () => ({ ...run, runId: 'foreign' });
  await invoke('reconcile-preflight-inspect'); assert.equal(assigned.length, 1); assert.match(errors.at(-1) || '', /其他任务/);
});

test('release_prepared preflight history never reads as released or grants a new Boot', () => {
  const run = fz3bFixtureRun({ active: false, stopRequested: true, hardwareBusy: true, phase: 'needs_attention', status: 'needs_attention' });
  run.preflightRefusalRecoveries = [{ schemaVersion: 1, context: { id: 'pure-preflight-history' }, status: 'release_prepared', createdAt: run.createdAt, updatedAt: run.updatedAt } as NonNullable<typeof run.preflightRefusalRecoveries>[number]];
  const html = renderToStaticMarkup(createElement(FZ3BRecoveryHistory, { run }));
  assert.match(html, /本地释放待确认/); assert.match(html, /本地释放尚未确认/); assert.doesNotMatch(html, /已解除本次检查占用/);
  run.preflightRefusalRecoveries[0].status = 'released';
  const released = renderToStaticMarkup(createElement(FZ3BRecoveryHistory, { run }));
  assert.match(released, /原检查仍为未知/); assert.match(released, /旧 Boot 绑定未更新/); assert.match(released, /模型任务不会续跑/);
});

test('restarted local completion displays a host-only finish instead of generic recovery or new native consent', () => {
  const run = fz3bFixtureRun({ active: false, stopRequested: true, hardwareBusy: false, phase: 'needs_attention', status: 'needs_attention' });
  run.operations[0].kind = 'inspect'; run.operations[0].status = 'unknown';
  const actions = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, reconcileInspect: false, reconcilePreflightRefusedInspect: true,
    finishPreflightRefusal: true, maintenanceExit: false, exportEvidence: false };
  const state = agentState({ activeRunId: run.runId, runs: [run], recoveryActions: actions });
  assert.equal(fz3bAgentLocked(state), true); assert.equal(fz3bCanRecover(state, run, run.taskId), false); assert.equal(fz3bCanStop(state, run), false);
  assert.equal(fz3bCanStop(state, { ...run, hardwareBusy: true }), false);
  assert.equal(fz3bCanExport(state, run), false); assert.equal(fz3bCanReconcilePreflightInspect(state, run), true);
  const html = renderToStaticMarkup(createElement(FZ3BPanel, { taskId: run.taskId, sessionId: run.sessionId, api: {} as DesktopAPI, state, loggedIn: true, fresh: false,
    modeActive: true, softwareBusy: false, otherHardwareBusy: false, starting: false, onStart: async () => true, onStop() {} }));
  assert.match(html, /aria-label="完成 FZ3B 本地恢复收尾"/); assert.match(html, /待本地收尾确认/);
  assert.match(html, /不连接 SSH、不重复设备操作、不申请新授权/); assert.match(html, /每次重启需再次本地确认/);
  assert.doesNotMatch(html, /仍需原生确认|aria-label="只读核查 FZ3B 检查占用"|aria-label="FZ3B 维护退出应用"/);
});

test('settled unknown evidence export needs an explicit exact-owner capability and never releases remote unknown', async () => {
  const run = fz3bFixtureRun({ active: false, hardwareBusy: true, stopRequested: true, status: 'needs_attention', phase: 'needs_attention' });
  run.operations[0].status = 'unknown';
  const actions = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, reconcileInspect: false, maintenanceExit: true, exportEvidence: true };
  const state = agentState({ activeRunId: run.runId, runs: [run], recoveryActions: actions });
  assert.equal(fz3bCanExport(state, run), true);
  assert.equal(fz3bCanExport({ ...state, recoveryActions: undefined }, run), false);
  assert.equal(fz3bCanExport({ ...state, recoveryActions: { ...actions, sessionId: 'foreign' } }, run), false);
  assert.equal(fz3bCanExport({ ...state, engineState: 'failed' }, run), false);
  assert.equal(fz3bCanExport(state, { ...run, active: true }), false);
  assert.equal(fz3bCanExport(state, { ...run, nativeApproval: 'pending' }), false);
  assert.equal(fz3bCanExport(agentState(), { ...run, hardwareBusy: false }), true);
  const calls: unknown[][] = [];
  const context = { api: { fz3bExport: async (...args: unknown[]) => { calls.push(args); return 'E:/offline-fixture/unknown-evidence.json'; } }, taskId: run.taskId, sessionId: run.sessionId, state, run, globalHeld: true, activeActions: new Map<string, string>(), starting: false, softwareBusy: false, otherHardwareBusy: false, readFailed: false, stoppingRunId: undefined, modeActive: true, mounted: { current: true }, fz3bCanExport, setIntent() {}, setError() {}, setNotice() {}, refresh: async () => {} };
  const invoke = runInNewContext(`${rendererFunction('FZ3BPanel', 'runLocalAction')}\ninvoke;`, context) as (kind: string) => Promise<void>;
  await invoke('export'); assert.deepEqual(calls, [[run.taskId]]); assert.equal(run.hardwareBusy, true); assert.equal(run.operations[0].status, 'unknown'); assert.equal(fz3bAgentLocked(state), true);
  context.readFailed = true; await invoke('export'); assert.equal(calls.length, 1); context.readFailed = false;
  context.activeActions.set(run.taskId, 'maintenance-exit'); await invoke('export'); assert.equal(calls.length, 1);
});

test('FZ3B instruction uses the host limit and malformed or overlong restored drafts cannot start', () => {
  assert.equal(FZ3B_INSTRUCTION_MAX, 12000);
  assert.equal(fz3bInstructionValid('a'.repeat(12000)), true);
  assert.equal(fz3bInstructionValid('\ud83d\ude80'.repeat(6000)), true);
  for (const value of ['', ' '.repeat(12000), 'a'.repeat(12001), '\ud83d\ude80'.repeat(6000) + 'a']) assert.equal(fz3bInstructionValid(value), false);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    for (const instruction of [{ unsafe: true }, 'x'.repeat(12001)]) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ instruction, model: 'foreign-model' }) } });
      const html = renderToStaticMarkup(createElement(FZ3BPanel, { taskId: 'offline-task', sessionId: 'offline-session', state: agentState(), loggedIn: true, fresh: true, modeActive: false, softwareBusy: false, otherHardwareBusy: false, starting: false, onStart: async () => true, onStop() {} }));
      assert.match(html, /maxLength="12000"|maxlength="12000"/); assert.doesNotMatch(html, /foreign-model|\[object Object\]/);
      if (typeof instruction === 'string') { assert.match(html, /12001 \/ 12000 UTF-16/); assert.ok(html.includes(instruction)); }
    }
    assert.doesNotThrow(() => renderToStaticMarkup(createElement(FZ3BPanel, { state: undefined, loggedIn: false, fresh: false, modeActive: false, softwareBusy: false, otherHardwareBusy: false, starting: false, onStart: async () => true, onStop() {} })));
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

function rendererFunction(componentName: string, handlerName: string) {
  const source = ts.createSourceFile('FZ3BPanel.tsx', readFileSync(new URL('./FZ3BPanel.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === componentName);
  const handler = component?.body?.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === handlerName);
  assert.ok(handler);
  return ts.transpileModule(`var invoke = ${handler.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

test('local recovery/export/key/leave calls have no command/path inputs and retain original pending ownership', async () => {
  const run = fz3bFixtureRun({ active: false, hardwareBusy: true, stopRequested: true, status: 'needs_attention', phase: 'needs_attention' });
  const calls: unknown[][] = [], assigned: unknown[] = [], errors: string[] = [];
  const context = { api: { fz3bRecover: async (...args: unknown[]) => { calls.push(['recover', ...args]); throw new Error('REMOTE_TERMINAL_UNKNOWN'); }, fz3bExport: async (...args: unknown[]) => { calls.push(['export', ...args]); return null; }, fz3bLeaveMode: async (...args: unknown[]) => { calls.push(['leave', ...args]); }, fz3bImportKey: async (...args: unknown[]) => { calls.push(['import-key', ...args]); } }, taskId: run.taskId, sessionId: run.sessionId, state: agentState({ activeRunId: run.runId, runs: [run] }), run, globalHeld: true, activeActions: new Map<string, string>(), starting: false, softwareBusy: false, otherHardwareBusy: false, readFailed: false, stoppingRunId: undefined as string | undefined, modeActive: true, mounted: { current: true }, fz3bCanRecover, fz3bCanImportKey, fz3bCanExport, errorText: (value: unknown) => value instanceof Error ? value.message : String(value), setCachedRun(value: unknown) { assigned.push(value); }, setIntent() {}, setError(value: string) { if (value) errors.push(value); }, setNotice() {}, refresh: async () => {} };
  const invoke = runInNewContext(`${rendererFunction('FZ3BPanel', 'runLocalAction')}\ninvoke;`, context) as (kind: string) => Promise<void>;
  await invoke('recover'); assert.deepEqual(calls, [['recover', run.taskId]]); assert.equal(errors.at(-1), 'REMOTE_TERMINAL_UNKNOWN'); assert.equal(assigned.length, 0);
  assert.equal(run.hardwareBusy, true); assert.equal(fz3bAgentLocked(context.state), true); assert.equal(context.activeActions.size, 0);
  await invoke('export'); await invoke('leave'); await invoke('import-key'); assert.equal(calls.length, 1);
  context.stoppingRunId = run.runId; await invoke('recover'); assert.equal(calls.length, 1); context.stoppingRunId = undefined;
  context.globalHeld = false; context.state.activeRunId = undefined; run.hardwareBusy = false; context.modeActive = false;
  await invoke('export'); await invoke('import-key'); assert.deepEqual(calls.slice(1), [['export', run.taskId], ['import-key']]);
  context.modeActive = true; await invoke('leave'); assert.deepEqual(calls.at(-1), ['leave']);
  await invoke('import-key'); assert.deepEqual(calls.at(-1), ['import-key'], 'Idle controlled mode does not hide native import');
  context.state.keyImportAllowed = false; const denied = calls.length; await invoke('import-key'); assert.equal(calls.length, denied); context.state.keyImportAllowed = true;
  let release!: () => void;
  context.api.fz3bExport = async (...args) => { (calls as unknown[][]).push(['held-export', ...args]); await new Promise<void>(resolve => { release = resolve; }); return null; };
  const pending = invoke('export'); await Promise.resolve();
  assert.equal(context.activeActions.get(run.taskId), 'export');
  const before = calls.length; await invoke('export'); await invoke('leave'); assert.equal(calls.length, before);
  release(); await pending; assert.equal(context.activeActions.size, 0);
});

test('host-only reconcile and maintenance use exact run IDs, preserve original pending and reject foreign results', async () => {
  const run = fz3bFixtureRun({ active: false, hardwareBusy: true, stopRequested: true, status: 'needs_attention', phase: 'needs_attention' });
  run.operations[0].kind = 'inspect'; run.operations[0].status = 'unknown';
  const actions = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, reconcileInspect: true, maintenanceExit: true, exportEvidence: true };
  const calls: unknown[][] = [], assigned: unknown[] = [], errors: string[] = [], notices: string[] = [];
  const context = { taskId: run.taskId, sessionId: run.sessionId, run, state: agentState({ activeRunId: run.runId, runs: [run], recoveryActions: actions }), globalHeld: true, activeActions: new Map<string, string>(), starting: false, softwareBusy: false, otherHardwareBusy: false, readFailed: false, stoppingRunId: undefined as string | undefined, modeActive: true, mounted: { current: true }, fz3bCanRecover, fz3bCanImportKey, fz3bCanReconcileInspect, fz3bCanMaintenanceExit,
    api: { fz3bReconcileInspect: async (...args: unknown[]) => { calls.push(['reconcile', ...args]); return { ...run, hardwareBusy: false, reconciliations: [fz3bFixtureReconciliation] }; }, fz3bMaintenanceExit: async (...args: unknown[]) => { calls.push(['maintenance', ...args]); } },
    errorText: (value: unknown) => value instanceof Error ? value.message : String(value), setCachedRun(value: unknown) { assigned.push(value); }, setIntent() {}, setError(value: string) { if (value) errors.push(value); }, setNotice(value: string) { if (value) notices.push(value); }, refresh: async () => {} };
  const invoke = runInNewContext(`${rendererFunction('FZ3BPanel', 'runLocalAction')}\ninvoke;`, context) as (kind: string) => Promise<void>;
  await invoke('reconcile-inspect'); assert.deepEqual(calls, [['reconcile', run.runId]]); assert.equal(assigned.length, 1);
  assert.equal(run.operations[0].status, 'unknown'); assert.equal(run.hardwareBusy, true); assert.equal(fz3bAgentLocked(context.state), true);
  await invoke('maintenance-exit'); assert.deepEqual(calls.at(-1), ['maintenance', run.runId]); assert.deepEqual(notices, [], 'A void native result does not prove app exit or remote safety');
  let release!: () => void;
  context.api.fz3bReconcileInspect = async (...args) => { (calls as unknown[][]).push(['held-reconcile', ...args]); await new Promise<void>(resolve => { release = resolve; }); return { ...run, hardwareBusy: false, reconciliations: [fz3bFixtureReconciliation] }; };
  const pending = invoke('reconcile-inspect'); await Promise.resolve();
  assert.equal(context.activeActions.get(run.taskId), 'reconcile-inspect'); const before = calls.length;
  await invoke('maintenance-exit'); await invoke('reconcile-inspect'); assert.equal(calls.length, before);
  release(); await pending; assert.equal(context.activeActions.size, 0);
  context.state.recoveryActions = { ...actions, sessionId: 'foreign-session' };
  await invoke('maintenance-exit'); await invoke('reconcile-inspect'); assert.equal(calls.length, before);
  context.state.recoveryActions = actions;
  context.api.fz3bReconcileInspect = async (...args) => { (calls as unknown[][]).push(['foreign-reconcile', ...args]); return { ...run, runId: 'foreign-run', hardwareBusy: false, reconciliations: [fz3bFixtureReconciliation] }; };
  const assignedBefore = assigned.length; await invoke('reconcile-inspect'); assert.equal(assigned.length, assignedBefore); assert.match(errors.at(-1) || '', /其他任务/);
  assert.doesNotMatch(rendererFunction('FZ3BPanel', 'runLocalAction'), /\.approve\(|\.fz3bAgentStart\(|\.send\(|\.hardwareFlash\(/);
});

test('public App start captures task/session and cannot accept a foreign run or switch UI selection', async () => {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
  const handler = component?.body?.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'startFz3bAgent');
  assert.ok(handler);
  const code = ts.transpileModule(`var invoke = ${handler.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const calls: unknown[][] = [];
  const context = { api: { fz3bAgentStart: async (...args: unknown[]) => { calls.push(args); return fz3bFixtureRun({ taskId: 'foreign-task' }); } }, session: { id: 'offline-session', taskId: 'offline-task' }, agentBusy: false, snapshot: { fz3bAgent: { available: true } }, mounted: { current: true }, action: async (_key: string, operation: () => Promise<void>) => { try { await operation(); return true; } catch { return false; } }, setSnapshot() { throw new Error('Foreign result must not be inserted'); } };
  const invoke = runInNewContext(`${code}\ninvoke;`, context) as (instruction: string, model: string) => Promise<boolean>;
  assert.equal(await invoke('fixture instruction', 'gpt-6.1-sol'), false);
  assert.deepEqual(calls, [['offline-task', 'fixture instruction', 'gpt-6.1-sol']]);
  context.agentBusy = true; assert.equal(await invoke('no concurrent start', 'gpt-6.1-sol'), false); assert.equal(calls.length, 1);
  assert.doesNotMatch(handler.getText(source), /setSessionId|setProjectId|\.send\(|\.approve\(|requestKey/);
});

test('public App only enables a fresh FZ3B task after its task record has arrived', () => {
  const source = ts.createSourceFile('App.tsx', readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
  const declaration = component?.body?.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(source) === 'freshFz3b');
  assert.ok(declaration?.initializer);
  const code = ts.transpileModule(`var result = ${declaration.initializer.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const session = { messages: [], threadId: undefined, turnId: undefined, engineUncertain: false };
  assert.equal(runInNewContext(`${code}\nresult;`, { session, task: undefined }), false);
  assert.equal(runInNewContext(`${code}\nresult;`, { session: undefined, task: { operations: [] } }), false);
  assert.equal(runInNewContext(`${code}\nresult;`, { session, task: { operations: [] } }), true);
  assert.equal(runInNewContext(`${code}\nresult;`, { session, task: { operations: [{}] } }), false);
  assert.equal(runInNewContext(`${code}\nresult;`, { session: { ...session, engineUncertain: true }, task: { operations: [] } }), false);
});
