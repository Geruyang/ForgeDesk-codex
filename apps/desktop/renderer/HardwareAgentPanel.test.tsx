import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import HardwareAgentPanel, { HARDWARE_AGENT_INSTRUCTION_MAX, HardwareAgentRunSummary, hardwareAgentInstructionValid, hardwareAgentLocked, hardwareAgentRecoveryAvailable, selectedHardwareAgentRun } from './HardwareAgentPanel';
import { EmbeddedStatusView, embeddedAvailability } from './EmbeddedPanel';
import type { HardwareAgentRunView } from '../../../packages/shared/hardware-agent';

function run(changes: Partial<HardwareAgentRunView> = {}): HardwareAgentRunView {
  return { schemaVersion: 1, runId: 'fixture-run', sessionId: 'fixture-session', taskId: 'fixture-task', model: 'gpt-6.1-sol', generation: 4, threadId: 'fixture-thread', status: 'active', phase: 'ready', active: true, hardwareBusy: false, stopRequested: false, nativeApproval: 'not_requested', createdAt: '2026-10-15T12:00:00Z', updatedAt: '2026-10-15T12:00:00Z', calls: [], ...changes };
}
function panel(changes: Partial<Parameters<typeof HardwareAgentPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(HardwareAgentPanel, { taskId: 'fixture-task', sessionId: 'fixture-session', state: { runs: [], engineState: 'stopped' }, models: [{ id: 'gpt-6.1-sol', label: 'GPT 6.1' }, { id: 'fixture-model', label: 'Fixture only' }], configured: true, fresh: true, available: true, modeActive: true, softwareBusy: false, starting: false, onStart: async () => true, onStop() {}, ...changes }));
}
function button(html: string, label: string) { return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] || ''; }

test('agent start is explicit, fixed-target, fresh configured task only, with its own model selector', () => {
  const html = panel();
  assert.match(html, /GestureScreen/); assert.match(html, /aria-label="模型实机任务指令"/);
  assert.match(html, /aria-label="实机任务模型"/); assert.match(html, /value="gpt-6.1-sol" selected=""/);
  assert.doesNotMatch(html, /value="fixture-model"/);
  assert.doesNotMatch(button(html, '启动模型实机任务'), /disabled/);
  for (const changes of [{ available: false }, { state: undefined }, { configured: false }, { fresh: false }, { modeActive: false }, { softwareBusy: true }, { starting: true }]) assert.match(button(panel(changes), '启动模型实机任务'), /disabled/);
  assert.match(panel({ fresh: false }), /尚无设备操作的新任务/);
});

test('malformed local draft cannot crash the panel or override the pinned hardware model', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ instruction: { unsafe: true }, model: 'another-model' }) } });
    const html = panel();
    assert.match(html, /value="gpt-6.1-sol" selected=""/);
    assert.doesNotMatch(html, /another-model|\[object Object\]/);
    assert.doesNotMatch(button(html, '启动模型实机任务'), /disabled/);
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('instruction limit and canStart use the same 12000 UTF-16 units as checkedText without trimming first', () => {
  assert.equal(HARDWARE_AGENT_INSTRUCTION_MAX, 12000);
  const main = readFileSync(new URL('../main/index.ts', import.meta.url), 'utf8');
  assert.match(main, new RegExp(`instruction = checkedText\\(instruction, ${HARDWARE_AGENT_INSTRUCTION_MAX}\\)`));
  for (const value of ['a'.repeat(12000), '\ud83d\ude80'.repeat(6000)]) {
    assert.equal(value.length, 12000); assert.equal(hardwareAgentInstructionValid(value), true);
  }
  for (const value of ['a'.repeat(12001), '\ud83d\ude80'.repeat(6000) + 'a', ' '.repeat(12000) + 'a', ' '.repeat(12000), '']) assert.equal(hardwareAgentInstructionValid(value), false);
  assert.match(panel(), /maxLength="12000"|maxlength="12000"/);
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    for (const length of [12000, 12001]) {
      const instruction = 'x'.repeat(length);
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ instruction }) } });
      const html = panel();
      assert.ok(html.includes(instruction), 'Restored drafts must not be silently truncated');
      if (length === 12000) assert.doesNotMatch(button(html, '启动模型实机任务'), /disabled/);
      else { assert.match(button(html, '启动模型实机任务'), /disabled/); assert.match(html, /12001 \/ 12000 UTF-16/); }
    }
  } finally { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('only matching held stopped-planning agent exposes recovery, independent of hardwareBusy claims', () => {
  for (const hardwareBusy of [true, false]) {
    const current = run({ active: false, stopRequested: true, hardwareBusy, status: 'needs_attention', phase: 'needs_attention', nativeApproval: 'unknown' });
    const state = { activeRunId: current.runId, runs: [current], engineState: 'unknown' };
    assert.equal(hardwareAgentRecoveryAvailable(state, current), true);
    const html = panel({ state, onRecover: async () => false });
    assert.doesNotMatch(button(html, '核查模型设备进程退出'), /disabled/);
    assert.match(html, /不会重试烧录或把未知结果改为成功/);
    assert.equal(hardwareAgentLocked(state), true);
    for (const changes of [{ recovering: true }, { recoveryBlocked: true }, { starting: true }, { stoppingRunId: current.runId }, { available: false }, { modeActive: false }]) assert.match(button(panel({ state, onRecover: async () => false, ...changes }), '核查模型设备进程退出'), /disabled/);
    assert.equal(button(panel({ state, sessionId: 'other-session', onRecover: async () => false }), '核查模型设备进程退出'), '');
  }
  const held = run({ active: false, stopRequested: true, hardwareBusy: true });
  assert.equal(hardwareAgentRecoveryAvailable({ activeRunId: 'other-run', runs: [held], engineState: 'unknown' }, held), false);
  assert.equal(hardwareAgentRecoveryAvailable({ activeRunId: held.runId, runs: [held], engineState: 'unknown' }, { ...held, active: true }), false);
  assert.equal(hardwareAgentRecoveryAvailable({ activeRunId: held.runId, runs: [held], engineState: 'unknown' }, { ...held, stopRequested: false }), false);
  assert.equal(hardwareAgentRecoveryAvailable(undefined, held), false);
});

test('held recovery uses original hardwareRecover only, retains lock on rejection and never promotes unknown', async () => {
  const source = ts.createSourceFile('EmbeddedPanel.tsx', readFileSync(new URL('./EmbeddedPanel.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'EmbeddedPanel');
  const handler = component?.body?.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'run');
  assert.ok(handler);
  const compiled = ts.transpileModule(`var testRun = ${handler.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const held = run({ active: false, stopRequested: true, hardwareBusy: true, status: 'needs_attention', phase: 'needs_attention', nativeApproval: 'unknown' });
  const state = { activeRunId: held.runId, runs: [held], engineState: 'unknown' };
  const status = { configured: true, taskId: held.taskId, profileId: 'fixture', profileSha256: 'a'.repeat(64), hardwareAvailable: true, limitation: 'Offline fixture; no device', operations: [{ id: 'unknown-operation', kind: 'flash', status: 'unknown', processExited: false }] };
  let recoverCalls = 0, refreshed = 0, error = '', reject = true;
  const statuses: unknown[] = [];
  const context = { api: { hardwareRecover: async (taskId: string) => { assert.equal(taskId, held.taskId); recoverCalls++; if (reject) throw new Error('BACKEND_STILL_HELD'); return { ...status, operations: [{ ...status.operations[0], recoveredAt: '2026-10-16T00:00:00Z' }] }; } }, taskId: held.taskId, sessionId: held.sessionId, available: true, activeIntents: new Map<string, string>(), activeRequestKeys: new Map<string, string>(), modeActive: true, status, softwareBusy: false, agentBlocked: true, readFailed: false, agentState: state, agentStarting: false, agentStoppingRunId: undefined as string | undefined, embeddedAvailability, hardwareAgentRecoveryAvailable, selectedHardwareAgentRun, crypto: { randomUUID: () => 'fixture-recovery-key' }, readVersion: { current: 0 }, mounted: { current: true }, setIntent() {}, setPendingRequestKey() {}, setError(value: string) { error = value; }, setNotice() {}, setLoading() {}, setStatus(value: unknown) { statuses.push(value); }, setReadFailed() {}, detail: (value: unknown) => value instanceof Error ? value.message : String(value), refresh: async () => { refreshed++; } };
  const invoke = runInNewContext(`${compiled}\ntestRun;`, context) as (kind: string, heldRecovery?: boolean) => Promise<boolean>;
  assert.equal(await invoke('recover', true), false);
  assert.equal(recoverCalls, 1); assert.equal(error, 'BACKEND_STILL_HELD'); assert.equal(statuses.length, 0);
  assert.equal(hardwareAgentLocked(state), true); assert.equal(held.hardwareBusy, true); assert.equal(context.activeIntents.size, 0); assert.equal(refreshed, 1);
  context.agentStarting = true; assert.equal(await invoke('recover', true), false); context.agentStarting = false;
  context.agentStoppingRunId = held.runId; assert.equal(await invoke('recover', true), false); context.agentStoppingRunId = undefined;
  assert.equal(await invoke('flash', true), false, 'The held exception may never authorize flash');
  assert.equal(recoverCalls, 1);
  reject = false; assert.equal(await invoke('recover', true), true);
  assert.equal(recoverCalls, 2); assert.equal((statuses[0] as typeof status).operations[0].status, 'unknown');
  assert.equal(hardwareAgentLocked(state), true, 'Only a new authoritative snapshot may release the controller lock');
  assert.equal(held.hardwareBusy, true);
});

test('agent run selection cannot mix another task or session, including late snapshots', () => {
  const mine = run(); const another = run({ runId: 'another', sessionId: 'another-session' });
  const state = { runs: [mine, another], engineState: 'connected' };
  assert.equal(selectedHardwareAgentRun(state, 'fixture-task', 'fixture-session'), mine);
  assert.equal(selectedHardwareAgentRun(state, 'different-task', 'fixture-session'), undefined);
  assert.equal(selectedHardwareAgentRun(state, 'fixture-task', 'missing-session'), undefined);
  assert.equal(selectedHardwareAgentRun(undefined, 'fixture-task', 'fixture-session'), undefined);
  assert.match(button(panel({ state }), '启动模型实机任务'), /^$/);
});

test('global agent lock covers unresolved run id, native authorization, stopping hardware and start IPC', () => {
  for (const state of [{ activeRunId: 'not-arrived-yet', runs: [], engineState: 'unknown' }, { runs: [run()], engineState: 'ready' }, { runs: [run({ active: false, hardwareBusy: true, stopRequested: true })], engineState: 'stopping' }, { runs: [run({ active: false, nativeApproval: 'pending' })], engineState: 'ready' }]) {
    assert.equal(hardwareAgentLocked(state), true);
    const html = panel({ taskId: 'other-task', sessionId: 'other-session', state });
    assert.match(button(html, '启动模型实机任务'), /disabled/);
  }
  assert.equal(hardwareAgentLocked({ runs: [run({ status: 'completed', phase: 'completed', active: false })], engineState: 'stopped' }), false);
  const locked = renderToStaticMarkup(createElement(EmbeddedStatusView, { status: { configured: true, taskId: 'fixture-task', profileId: 'fixture-profile', profileSha256: 'a'.repeat(64), operations: [], hardwareAvailable: true, limitation: 'UI fixture only' }, loading: false, readFailed: false, busy: true, available: true, modeActive: true, error: '', notice: '', refresh() {}, run() {} }));
  for (const name of ['配置工程', '固件构建', '设备检查', '授权并烧录', '实机验证', '导出证据', '返回软件模式']) assert.match(button(locked, name), /disabled/);
  assert.doesNotMatch(button(locked, '刷新实机状态'), /disabled/);
});

test('native approval is read-only and controller stop never claims hardware stopped', () => {
  const pending = run({ phase: 'awaiting_native_approval', nativeApproval: 'pending' });
  let html = renderToStaticMarkup(createElement(HardwareAgentRunSummary, { run: pending, stopping: false, onStop() {} }));
  assert.match(html, /此页面不能批准烧录/); assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(button(html, '停止模型实机任务'), /^<button/);
  assert.doesNotMatch(html, />允许本次<|>批准<|>确认烧录</);
  html = renderToStaticMarkup(createElement(HardwareAgentRunSummary, { run: run({ stopRequested: true, active: false, hardwareBusy: true }), stopping: true, onStop() {} }));
  assert.match(html, /设备操作仍在进行；尚未确认设备停止/);
  assert.match(button(html, '停止模型实机任务'), /disabled/);
  assert.doesNotMatch(html, /设备已停止|实机验证通过/);
});

test('agent phase, failures, calls and evidence are escaped backend records, never injected approvals', () => {
  const current = run({ active: false, status: 'needs_attention', phase: 'needs_attention', nativeApproval: 'unknown', failure: '<script>unknown connection</script>', calls: [{ callId: 'fixture-call', tool: 'embedded_request_flash', receivedAt: '2026-10-15T12:00:00Z', status: 'unknown', operationId: 'fixture-operation', error: '<img src=x onerror=bad()>' }], export: { path: 'E:/fixture/evidence', sha256: 'a'.repeat(64) } });
  const html = renderToStaticMarkup(createElement(HardwareAgentRunSummary, { run: current, stopping: false, onStop() {} }));
  assert.match(html, /需要人工核查|状态不确定/); assert.match(html, /未自动重试设备操作/);
  assert.match(html, /&lt;script&gt;|&lt;img/); assert.doesNotMatch(html, /<script>|<img src=x|T2.*通过/);
  assert.match(html, /fixture-operation/); assert.match(html, /E:\/fixture\/evidence/);
});

test('preload forwards dedicated start and stop without changing normal chat routes', () => {
  const source = ts.createSourceFile('preload.ts', readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = new Map<string, ts.Node>();
  function visit(node: ts.Node) { if (ts.isPropertyAssignment(node) && ts.isArrowFunction(node.initializer)) methods.set(node.name.getText(source), node.initializer); node.forEachChild(visit); }
  visit(source); const calls: unknown[][] = [];
  for (const [name, args] of [['hardwareAgentStart', ['fixture-task', 'fixture-instruction', 'gpt-6.1-sol']], ['hardwareAgentStop', ['fixture-run']], ['send', ['fixture-session', 'software draft', 'fixture-model']]] as const) {
    const expression = methods.get(name); assert.ok(expression);
    const compiled = ts.transpileModule(`const invoke = (...args) => capture(args); const method = ${expression.getText(source)}; method(...args);`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    runInNewContext(compiled, { capture: (value: unknown[]) => calls.push(value), args });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), [name, ...args]);
  }
});

test('ordinary send and interrupt remain separate from bound hardware agent sessions', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const canSend =[^\n]+!controlledMode && !agentRun && !agentBusy/);
  assert.match(app, /isRunning && !agentRun && <IconButton label="停止当前回合"/);
  assert.match(app, /!controlledMode && !agentRun && !agentBusy && !!snapshot\?\.approvals.length/);
  assert.match(app, /api.hardwareAgentStart\(target, instruction, selectedModel\)/);
  assert.match(app, /created.taskId !== target \|\| created.sessionId !== targetSession/);
});
