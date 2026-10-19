import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { AppSnapshot, Approval, Session } from '../../packages/shared/contracts';
import { CONTROL_PHASES, CONTROLS_ENTRIES, ControlsGate, assertControlsHarness, assertFreshRefusal, assertOwnedWaitProcess,
  assertRefusalComplete, assertReleaseDiagnostics, assertRestartSessions, assertControlsSessionBinding, selectControlsProject, selectControlsSession, sanitizeControlsFailure, controlsClosure, type WaitProcess } from './release-1-controls';
import { assertStopObservationTiming, assertWaitCommand } from './second-user-controls';
import { assertControlsStopReceipt } from './controls-stop-observer';
import { assertAcceptanceUnchanged, assertMissingGitResult, assertMissingNodeResult, missingToolsAppEnvironment } from './second-user-missing-tools';
import { armControlsBoundary, installControlsBoundary, readControlsBoundary } from './release-1-controls-observer';

const pin = 'a'.repeat(64), nextPin = 'b'.repeat(64), requestKey = 'qa-request';
test('QA session selection requires the unique fixed project and exact persisted session binding', () => {
  const session = { id: 'qa-session', projectId: 'qa-project', title: 'QA [exact]+(title)' } as Session;
  const state = { projects: [{ id: 'old-project', root: 'E:/old' }, { id: 'qa-project', root: 'E:/qa' }], sessions: [session] } as AppSnapshot;
  assert.doesNotThrow(() => assertControlsSessionBinding(state, 'qa-project', 'E:/qa', session));
  for (const changed of [{ ...state, projects: [state.projects[0]] }, { ...state, projects: [...state.projects, state.projects[1]] }, { ...state, sessions: [{ ...session, projectId: 'old-project' }] }, { ...state, sessions: [...state.sessions, { ...session, id: 'duplicate-title' }] }]) {
    assert.throws(() => assertControlsSessionBinding(changed, 'qa-project', 'E:/qa', session));
  }
  assert.throws(() => assertControlsSessionBinding(state, 'qa-project', 'E:/other', session));
});
test('project and session selectors are scoped exact DOM actions with closed failure checkpoints', async () => {
  const calls: unknown[] = [];
  const locator: any = new Proxy({}, { get(_target, method) { return (...args: unknown[]) => { calls.push([method, ...args]); return method === 'count' ? Promise.resolve(1) : ['click', 'waitFor'].includes(String(method)) ? Promise.resolve() : locator; }; } });
  const page: any = { locator: (...args: unknown[]) => { calls.push(['locator', ...args]); return locator; }, getByText: (...args: unknown[]) => { calls.push(['text', ...args]); return locator; } };
  await selectControlsProject(page, 'E:/qa'); await selectControlsSession(page, 'QA [exact]+(title)');
  assert.ok(calls.some((call: any) => call[0] === 'locator' && call[1] === '.project-list'));
  assert.ok(calls.some((call: any) => call[0] === 'locator' && call[1] === '.session-list'));
  assert.ok(calls.some((call: any) => call[0] === 'getByTitle' && call[1] === 'E:/qa' && call[2].exact === true));
  assert.ok(calls.some((call: any) => call[0] === 'text' && call[1] === 'QA [exact]+(title)' && call[2].exact === true));
  assert.equal(calls.filter((call: any) => call[0] === 'click').length, 2);
  for (const checkpoint of ['session-project-binding', 'session-project-select', 'session-create', 'session-binding', 'session-select']) assert.equal(sanitizeControlsFailure(Error('PRIVATE'), checkpoint).checkpoint, checkpoint);
});
test('controls failure output never serializes raw errors and uses only closed history checkpoints', async () => {
  const source = await readFile(path.resolve('tests/release-1-controls-smoke.ts'), 'utf8');
  assert.doesNotMatch(source, /error\.stack|safeError\(|redact\(e\.message\)/);
  assert.match(source, /failure: sanitizeControlsFailure\(error, checkpoint\)/);
  const { sanitizeControlsFailure } = await import('./release-1-controls');
  const error = Object.assign(Error('PRIVATE_ERROR'), { code: 'ERR_ASSERTION', actual: 'PRIVATE_ACTUAL' });
  assert.deepEqual(sanitizeControlsFailure(error, 'history-extra-inspect'), { reason: 'ASSERTION', checkpoint: 'history-extra-inspect', cause: 'none' });
  assert.deepEqual(sanitizeControlsFailure({ secret: 'PRIVATE' }, 'PRIVATE_CHECKPOINT'), { reason: 'OTHER', checkpoint: 'none', cause: 'none' });
  assert.equal(sanitizeControlsFailure(Error('CONTROLS_BOUNDARY_UNAVAILABLE'), 'launch-boundary-install').cause, 'CONTROLS_BOUNDARY_UNAVAILABLE');
  const wrapped = sanitizeControlsFailure(Error('electronApplication.evaluate: Error: CONTROLS_BOUNDARY_UNAVAILABLE\nPRIVATE_STACK'), 'launch-boundary-install');
  assert.equal(wrapped.cause, 'CONTROLS_BOUNDARY_UNAVAILABLE'); assert.equal(JSON.stringify(wrapped).includes('PRIVATE'), false);
  const hostile = Error(); Object.defineProperty(hostile, 'code', { get() { throw Error('PRIVATE_GETTER'); } });
  assert.deepEqual(sanitizeControlsFailure(hostile, 'none'), { reason: 'OTHER', checkpoint: 'none', cause: 'none' });
});
function fixture() {
  const session = { id: 'session', taskId: 'task', threadId: 'thread', turnId: 'turn', status: 'running', messages: [] } as unknown as Session;
  const approval = { id: 7, generation: 4, method: 'mcpServer/elicitation/request', decisions: ['decline'], params: {
    threadId: 'thread', turnId: 'turn', serverName: 'engineering', mode: 'form', requestedSchema: { type: 'object', properties: {} },
    message: 'Allow the engineering MCP server to run tool "engineering.test"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { taskId: 'task', verifierId: 'qa-controls-verifier', requestKey } },
  } } as Approval;
  const state = { approvals: [approval], sessions: [session], tasks: [{ id: 'task', operations: [] }] } as unknown as AppSnapshot;
  return { session, approval, state };
}
test('startup waits for the real window and header before installing a self-contained serialized boundary', async () => {
  const source = await readFile(new URL('../release-1-controls-smoke.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf('page = await app.firstWindow()') < source.indexOf('app!.evaluate(installControlsBoundary'));
  assert.ok(source.indexOf("page.locator('.app-header').waitFor") < source.indexOf('app!.evaluate(installControlsBoundary'));
  const { tsImport } = await import('tsx/esm/api');
  const actual = await tsImport(pathToFileURL(path.resolve('tests/helpers/release-1-controls-observer.ts')).href,
    { parentURL: pathToFileURL(path.resolve('package.json')).href, tsconfig: false });
  for (const name of ['installControlsBoundary', 'armControlsBoundary', 'readControlsBoundary']) assert.equal(actual[name].toString().includes('__name'), false);
  const context = vm.createContext({ process: { versions: { electron: '44.7.2' } } });
  vm.runInContext('globalThis.surface={ipcMain:{_invokeHandlers:new Map()},dialog:{showMessageBox:async function(){return {response:0}}}}', context);
  assert.throws(() => vm.runInContext(`(${actual.installControlsBoundary.toString()})(surface,"44.7.2")`, context), { message: 'CONTROLS_BOUNDARY_UNAVAILABLE' });
  assert.equal(vm.runInContext('globalThis.__release1ControlsBoundary', context), undefined);
  vm.runInContext('surface.ipcMain._invokeHandlers.set("forgedesk:invoke",async function(){return {original:true}})', context);
  assert.equal(vm.runInContext(`(${actual.installControlsBoundary.toString()})(surface,"44.7.2")`, context).installed, true);
});
test('controlled launch cannot skip leave or use a wrong predecessor, and cannot leave twice', () => {
  for (const line of [`ready ${nextPin}`, `connect ${nextPin}`, `leave-mode ${pin}`]) {
    const gate = new ControlsGate(pin); gate.arm(`launch ${pin}`); gate.complete('launch', nextPin);
    assert.throws(() => gate.arm(line, true)); assert.equal(gate.held, true);
  }
});
test('all three launches require their own separately armed leave only when controlled', () => {
  const gate = new ControlsGate(pin), leave = new Map([['ready', 'leave-mode'], ['restart-verify', 'restart-leave'], ['missing-tools', 'missing-leave']]);
  for (const phase of CONTROL_PHASES) {
    const special = leave.get(phase);
    if (special) {
      assert.equal(gate.expected(true), special); assert.equal(gate.arm(`${special} ${gate.predecessor}`, true), special);
      gate.complete(special as any, nextPin); assert.equal(gate.expected(false), phase);
    }
    assert.equal(gate.arm(`${phase} ${gate.predecessor}`, false), phase); gate.complete(phase, pin);
  }
  assert.equal(gate.done, true);
  const duplicate = new ControlsGate(pin); duplicate.arm(`launch ${pin}`); duplicate.complete('launch', nextPin);
  duplicate.arm(`leave-mode ${nextPin}`, true); duplicate.complete('leave-mode' as any, pin);
  assert.throws(() => duplicate.arm(`leave-mode ${pin}`, false));
});
test('readonly host observation permits controlled mode but ordinary controls remain mode-false only', async () => {
  const { assertControlsHostSnapshot, assertControlsSnapshot } = await import('./release-1-controls');
  assert.equal(typeof assertControlsHostSnapshot, 'function');
  const root = path.resolve('E:/fixed-data'), installed = path.resolve('E:/fixed-install/ForgeDesk.exe');
  const state: any = { version: '1.0.0', dataDir: root, hardware: { enabled: false, modeActive: true }, engine: { state: 'stopped', home: path.join(root, 'engine'), executable: path.join(path.dirname(installed), 'resources/codex/codex.exe') } };
  assertControlsHostSnapshot(state, root, installed); assert.throws(() => assertControlsSnapshot(state, root, installed));
  state.hardware.modeActive = false; assertControlsSnapshot(state, root, installed);
  state.hardware.modeActive = 'false'; assert.throws(() => assertControlsHostSnapshot(state, root, installed));
});
test('mode leave invokes exactly one original zero-argument action and stops on any preflight or original rejection', async () => {
  const { observeControlsModeLeave } = await import('./release-1-controls'); assert.equal(typeof observeControlsModeLeave, 'function');
  let reads = 0, invoked = 0; const calls: any[] = [], checkpoints: string[] = [];
  const read = async () => ({ hardware: { modeActive: ++reads === 1 }, fz3bAgent: { runs: [{ immutable: true }] } }) as any;
  const boundary = async () => ({ calls: [...calls], forbiddenCount: 0, nativePromptCount: 0, remainingArms: 0 });
  const value = await observeControlsModeLeave(read, boundary, async () => { invoked++; calls.push({ method: 'fz3bLeaveMode', phase: 'fulfilled', argumentsValid: true }); }, id => checkpoints.push(id));
  assert.equal(invoked, 1); assert.equal(reads, 2); assert.equal(value.originalCalls, 1); assert.equal(value.ordinaryConnectIsPartOfOriginalProductMethod, true);
  assert.deepEqual(checkpoints, ['mode-leave-preflight', 'mode-leave-ipc', 'mode-leave-receipt', 'mode-leave-postflight']);
  for (const failedBefore of [true, false]) {
    let attempted = 0, snapshots = 0;
    await assert.rejects(observeControlsModeLeave(async () => { snapshots++; if (failedBefore) throw Error('NONTERMINAL_HISTORY'); return { hardware: { modeActive: true } } as any; }, boundary,
      async () => { attempted++; throw Error('ORIGINAL_REJECTED'); }));
    assert.equal(attempted, failedBefore ? 0 : 1); assert.equal(snapshots, 1);
  }
  let earlyCalls = 0; await assert.rejects(observeControlsModeLeave(async () => ({ hardware: { modeActive: false } }) as any, boundary, async () => { earlyCalls++; })); assert.equal(earlyCalls, 0);
  let pendingReads = 0, pendingCalls = 0, release!: () => void; const pendingReceipts: any[] = [];
  const pending = observeControlsModeLeave(async () => ({ hardware: { modeActive: ++pendingReads === 1 } }) as any,
    async () => ({ calls: [...pendingReceipts], forbiddenCount: 0, nativePromptCount: 0, remainingArms: 0 }),
    async () => { pendingCalls++; await new Promise<void>(resolve => { release = resolve; }); pendingReceipts.push({ method: 'fz3bLeaveMode', phase: 'fulfilled', argumentsValid: true }); });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(pendingCalls, 1); assert.equal(pendingReads, 1);
  release(); await pending; assert.equal(pendingReads, 2); assert.equal(pendingCalls, 1);
});
test('leave boundary accepts only a single zero-argument original method and never permits replay', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron'), host = globalThis as any; let calls = 0;
  Object.defineProperty(process.versions, 'electron', { value: '44.7.2', configurable: true });
  const response = { original: true }, ipcMain = { _invokeHandlers: new Map([['forgedesk:invoke', async () => { calls++; return response; }]]) }, dialog = { showMessageBox: async () => ({ response: 0 }) };
  try {
    installControlsBoundary({ ipcMain, dialog }, '44.7.2');
    assert.throws(() => armControlsBoundary({ ipcMain }, [{ method: 'fz3bLeaveMode', args: ['foreign'] }]));
    assert.throws(() => armControlsBoundary({ ipcMain }, [{ method: 'fz3bLeaveMode', args: [] }, { method: 'connect', args: [] }]));
    armControlsBoundary({ ipcMain }, [{ method: 'fz3bLeaveMode', args: [] }]);
    const invoke = ipcMain._invokeHandlers.get('forgedesk:invoke')! as any;
    assert.equal(await invoke({}, 'fz3bLeaveMode', []), response); await assert.rejects(invoke({}, 'fz3bLeaveMode', [])); assert.equal(calls, 1);
  } finally { delete host.__release1ControlsBoundary; if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete (process.versions as any).electron; }
});
test('controls phases require exact current predecessor and stop permanently on mismatch', () => {
  const gate = new ControlsGate(pin); assert.equal(gate.next, 'launch');
  assert.throws(() => gate.arm(`ready ${pin}`)); assert.equal(gate.held, true); assert.throws(() => gate.arm(`launch ${pin}`));
});
test('controls cannot overlap, replay, skip phases or auto advance', () => {
  const gate = new ControlsGate(pin); const phase = gate.arm(`launch ${pin}`); assert.equal(gate.next, 'launch');
  gate.complete(phase, nextPin); assert.equal(gate.next, 'ready'); assert.equal(gate.predecessor, nextPin);
  assert.throws(() => gate.arm(`launch ${pin}`));
  const concurrent = new ControlsGate(pin); concurrent.arm(`launch ${pin}`); assert.throws(() => concurrent.arm(`launch ${pin}`));
});
test('all phases require a separate exact arm through missing-tools normal close', () => {
  const gate = new ControlsGate(pin);
  for (const phase of CONTROL_PHASES) { assert.equal(gate.next, phase); assert.equal(gate.arm(`${phase} ${gate.predecessor}`), phase); gate.complete(phase, nextPin); }
  assert.equal(gate.done, true); assert.throws(() => gate.arm(`launch ${nextPin}`));
});
test('a single optional connect requires its own root arm before ready and cannot replay', () => {
  const gate = new ControlsGate(pin); gate.arm(`launch ${pin}`); gate.complete('launch', nextPin);
  assert.equal(gate.arm(`connect ${nextPin}`), 'connect'); gate.complete('connect', pin); assert.equal(gate.next, 'ready');
  assert.throws(() => gate.arm(`connect ${pin}`));
});
test('source receipt remains a controls-only domain and rejects version/scope/extra fields', () => {
  const value = { schemaVersion: 1, scope: 'release-1-controls-harness-v1', version: '1.0.0', candidateSha256: pin,
    sources: [...CONTROLS_ENTRIES].sort().map(path => ({ path, bytes: 1, sha256: pin })), node: { path: 'C:/Program Files/nodejs/node.exe', bytes: 1, sha256: pin },
    runtimePackages: ['node_modules/@electron/asar', 'node_modules/playwright', 'node_modules/tsx', 'node_modules/typescript'], runtimePins: [{ path: 'node_modules/tsx/index.js', bytes: 1, sha256: pin }] };
  value.scope = 'release-1-controls-harness-v2';
  assert.doesNotThrow(() => assertControlsHarness(value));
  for (const changed of [{ ...value, version: '0.2.1' }, { ...value, scope: 'release-1-independent-harness-v1' }, { ...value, accepted: true }]) assert.throws(() => assertControlsHarness(changed));
});
test('fresh refusal requires one exact bound approval and preserves generation across reload', () => {
  const { state, approval } = fixture(); assert.equal(assertFreshRefusal(state, 'session', requestKey, approval).approval, approval);
  assert.throws(() => assertFreshRefusal({ ...state, approvals: [approval, approval] }, 'session', requestKey));
  assert.throws(() => assertFreshRefusal({ ...state, approvals: [{ ...approval, generation: 5 }] }, 'session', requestKey, approval));
  assert.throws(() => assertFreshRefusal({ ...state, approvals: [{ ...approval, id: 8 }] }, 'session', requestKey, approval));
  assert.throws(() => assertFreshRefusal(state, 'session', 'alternate-request'));
});
test('refusal rejects wrong thread/turn/server/tool and any prior runner operation', () => {
  for (const change of [{ threadId: 'other' }, { turnId: 'other' }, { serverName: 'other' }, { message: 'Allow alternate tool?' }]) {
    const { state, approval } = fixture(); state.approvals = [{ ...approval, params: { ...approval.params as any, ...change } }]; assert.throws(() => assertFreshRefusal(state, 'session', requestKey));
  }
  const { state } = fixture(); state.tasks[0].operations.push({} as any); assert.throws(() => assertFreshRefusal(state, 'session', requestKey));
});
test('completed refusal requires exact protocol error rather than cancellation or prose', () => {
  const { state, session } = fixture(); state.approvals = []; session.status = 'completed'; delete session.turnId;
  const item = { type: 'mcpToolCall', server: 'engineering', tool: 'engineering.test', arguments: { taskId: 'task', verifierId: 'qa-controls-verifier', requestKey }, status: 'failed', error: { message: 'user rejected MCP tool call' }, result: null };
  session.messages = [{ id: 'tool', role: 'tool', text: JSON.stringify(item) }] as any; assert.deepEqual(assertRefusalComplete(state, 'session', requestKey), item);
  session.messages[0].text = JSON.stringify({ ...item, error: { message: 'cancelled' } }); assert.throws(() => assertRefusalComplete(state, 'session', requestKey));
  session.messages[0].text = JSON.stringify(item); session.messages.push({ ...session.messages[0], id: 'retry' }); assert.throws(() => assertRefusalComplete(state, 'session', requestKey));
});
test('1.0 diagnostics require exact public schema and observed synthetic redaction', () => {
  const value = { schemaVersion: 1, version: '1.0.0', engineState: 'ready', engineError: '', platform: 'win32', arch: 'x64', diagnostics: ['qa-diagnostic-example password=[redacted]'] };
  assert.doesNotThrow(() => assertReleaseDiagnostics(value, 'qa-diagnostic-example', 'synthetic-secret'));
  for (const changed of [{ ...value, version: '0.2.1' }, { ...value, credentials: {} }, { ...value, diagnostics: [] }, { ...value, diagnostics: ['qa-diagnostic-example password=synthetic-secret'] }]) assert.throws(() => assertReleaseDiagnostics(changed, 'qa-diagnostic-example', 'synthetic-secret'));
});
test('Stop accepts only one owned QA shell root and exact harmless waiting command', () => {
  const marker = 'qa-controls-wait-snapshot-123';
  const process: WaitProcess = { id: 11, parentId: 10, name: 'powershell.exe', execPath: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', created: '2026-10-19T00:00:04.000Z', sid: 'primary', sessionId: 1, ownerQueryStatus: 0, root: true, commandLine: `powershell.exe -NoProfile -Command "Write-Output '${marker}'; Start-Sleep -Seconds 45"` };
  const installed = path.resolve('E:/test/install/ForgeDesk.exe'), packageRoot = path.dirname(installed);
  const engine: WaitProcess = { ...process, id: 10, parentId: 9, name: 'codex.exe', execPath: path.join(packageRoot, 'resources/codex/codex.exe'), created: '2026-10-19T00:00:03.000Z', root: false };
  const host: WaitProcess = { ...engine, id: 9, parentId: 8, name: 'process-host.exe', execPath: path.join(packageRoot, 'resources/process-host/process-host.exe'), created: '2026-10-19T00:00:02.000Z' };
  const main: WaitProcess = { ...host, id: 8, parentId: 7, name: 'ForgeDesk.exe', execPath: installed, created: '2026-10-19T00:00:01.000Z' };
  const proof = { main, ancestry: [engine, host, main], installed, sampledAt: '2026-10-19T00:00:05.000Z' };
  assert.equal(assertOwnedWaitProcess([process], marker, 'primary', 1, proof), process); assert.doesNotThrow(() => assertWaitCommand(process.commandLine!, marker));
  assert.throws(() => assertOwnedWaitProcess([process, { ...process, id: 12 }], marker, 'primary', 1, proof));
  assert.throws(() => assertOwnedWaitProcess([{ ...process, sid: 'other' }], marker, 'primary', 1, proof));
  assert.throws(() => assertOwnedWaitProcess([{ ...process, sessionId: 2 }], marker, 'primary', 1, proof));
  assert.throws(() => assertOwnedWaitProcess([{ ...process, ownerQueryStatus: 2 }], marker, 'primary', 1, proof));
  assert.throws(() => assertOwnedWaitProcess([{ ...process, parentId: 987654 }], marker, 'primary', 1, proof));
  assert.throws(() => assertOwnedWaitProcess([process], marker, 'primary', 1, { ...proof, ancestry: [host, main] }));
  assert.throws(() => assertOwnedWaitProcess([process], marker, 'primary', 1, { ...proof, ancestry: [{ ...engine, created: '2026-10-19T00:00:06.000Z' }, host, main] }));
  assert.throws(() => assertOwnedWaitProcess([process], marker, 'primary', 1, { ...proof, main: { ...main, created: '2026-10-19T00:00:00.000Z' } }));
  assert.throws(() => assertOwnedWaitProcess([process], marker, 'primary', 1, { ...proof, ancestry: [engine, { ...host, parentId: 1234 }, main] }));
  assert.throws(() => assertOwnedWaitProcess([process], marker, 'primary', 1, { ...proof, ancestry: [{ ...engine, execPath: path.join(packageRoot, 'other/codex.exe') }, host, main] }));
  assert.throws(() => assertWaitCommand(process.commandLine!.replace('45', '1'), marker));
  assert.throws(() => assertWaitCommand(process.commandLine!.replace('Start-Sleep', 'Get-Content secret; Start-Sleep'), marker));
});
test('natural completion and duplicate/rejected/pending interrupt cannot pass Stop', () => {
  const created = '2026-10-19T00:00:00.000Z'; assert.doesNotThrow(() => assertStopObservationTiming(created, '2026-10-19T00:00:01.000Z', '2026-10-19T00:00:02.000Z'));
  assert.throws(() => assertStopObservationTiming(created, '2026-10-19T00:00:01.000Z', '2026-10-19T00:00:40.000Z'));
  const call = { phase: 'fulfilled' as const, startedAt: 1, finishedAt: 2, argumentsValid: true };
  const receipt = { mechanism: 'test-only original IPC handler pass-through observer', electronVersion: '44.7.2', sessionId: 's', calls: [call] };
  assert.doesNotThrow(() => assertControlsStopReceipt(receipt));
  assert.throws(() => assertControlsStopReceipt({ ...receipt, calls: [call, call] }));
  assert.throws(() => assertControlsStopReceipt({ ...receipt, calls: [{ ...call, phase: 'rejected' }] }));
  assert.throws(() => assertControlsStopReceipt({ ...receipt, calls: [{ ...call, phase: 'started' }] }));
});
test('restart verifies full messages and zero runner replay', () => {
  const { state, session } = fixture(); state.approvals = []; session.status = 'completed'; delete session.turnId;
  const expected = structuredClone(session); assert.doesNotThrow(() => assertRestartSessions(state, [expected]));
  session.messages.push({ id: 'new', text: 'replayed', role: 'assistant' } as any); assert.throws(() => assertRestartSessions(state, [expected]));
});
test('missing tools changes only supplied child environment and requires exact missing executable errors', () => {
  const parent = { PATH: 'original', Path: 'mixed', CODEX_HOME: 'private', ELECTRON_RUN_AS_NODE: '1', FORGEDESK_DATA_DIR: 'old', SYSTEMROOT: 'C:/Windows' };
  const child = missingToolsAppEnvironment(parent, 'E:/test/empty', 'E:/test/data');
  assert.equal(parent.PATH, 'original'); assert.equal(child.PATH, 'E:/test/empty'); assert.equal(child.Path, undefined); assert.equal(child.CODEX_HOME, undefined); assert.equal(child.ELECTRON_RUN_AS_NODE, undefined);
  assert.doesNotThrow(() => assertMissingGitResult({ rejected: true, error: '无法读取 Git 差异: spawn git ENOENT' }));
  assert.throws(() => assertMissingGitResult({ rejected: true, error: 'not a git repository' }));
  assert.doesNotThrow(() => assertMissingNodeResult({ rejected: true, error: 'Executable not found: node' }));
  assert.throws(() => assertMissingNodeResult({ rejected: false, error: '' }));
  const before = { acceptance: [], profileRevision: 1, snapshotProfile: undefined, operations: [], evidence: [], status: 'draft', updatedAt: 'old' };
  assert.doesNotThrow(() => assertAcceptanceUnchanged(before, structuredClone(before))); assert.throws(() => assertAcceptanceUnchanged(before, { ...before, updatedAt: 'new' }));
});
test('new entry uses shared release binding and never launches old identity/pin harnesses', async () => {
  const source = await readFile(new URL('../release-1-controls-smoke.ts', import.meta.url), 'utf8');
  assert.match(source, /verifyRelease/); assert.match(source, /verifyControlsHarness/); assert.match(source, /readHostAdmission/); assert.match(source, /assertHistorical/);
  assert.doesNotMatch(source, /prepareSnapshotScope|FORGEDESK_SNAPSHOT_SECOND_USER|0\.2\.1|taskkill|Stop-Process|\.kill\(/);
  assert.match(source, /gate\.arm\(line, controlled\)/); assert.match(source, /protectOnFailure/); assert.match(source, /automaticInterruptOrDecisionAttempted: false/);
});
test('original IPC boundary rejects device calls and argument drift without forwarding or fabricating results', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron'), host = globalThis as any;
  Object.defineProperty(process.versions, 'electron', { value: '44.7.2', configurable: true });
  const forwarded: string[] = [], response = { id: 'p', root: 'E:/qa/workspace' };
  const original = async (_event: unknown, method: string) => { forwarded.push(method); return response; };
  const ipcMain = { _invokeHandlers: new Map([['forgedesk:invoke', original]]) }, dialog = { showMessageBox: async () => ({ response: 1 }) };
  try {
    installControlsBoundary({ ipcMain, dialog }, '44.7.2'); armControlsBoundary({ ipcMain }, [{ method: 'importProject', args: [], projectRoot: 'E:/qa/workspace' }]);
    const invoke = ipcMain._invokeHandlers.get('forgedesk:invoke')! as any;
    assert.equal(await invoke({}, 'importProject', []), response); assert.equal(readControlsBoundary({ ipcMain }).calls[0].phase, 'fulfilled');
    assert.equal(await invoke({}, 'diff', ['p']), response); assert.deepEqual(forwarded, ['importProject', 'diff']);
    await assert.rejects(invoke({}, 'hardwareFlash', ['task', 'key']), /CONTROLS_IPC_NOT_ARMED/); assert.deepEqual(forwarded, ['importProject', 'diff']);
    assert.equal(readControlsBoundary({ ipcMain }).forbiddenCount, 1); assert.throws(() => armControlsBoundary({ ipcMain }, [{ method: 'connect', args: [] }]));
  } finally { delete host.__release1ControlsBoundary; if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete (process.versions as any).electron; }
});
test('boundary records original rejection and leaves native prompt decision to original dialog', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron'), host = globalThis as any;
  Object.defineProperty(process.versions, 'electron', { value: '44.7.2', configurable: true });
  const failure = new Error('original missing executable'); const result = { response: 99 };
  const ipcMain = { _invokeHandlers: new Map([['forgedesk:invoke', async () => { throw failure; }]]) }, dialog = { showMessageBox: async () => result };
  try {
    installControlsBoundary({ ipcMain, dialog }, '44.7.2'); armControlsBoundary({ ipcMain }, [{ method: 'setAcceptance', args: ['task', []], expectedRejection: true }]);
    await assert.rejects((ipcMain._invokeHandlers.get('forgedesk:invoke')! as any)({}, 'setAcceptance', ['task', []]), error => error === failure);
    assert.equal(readControlsBoundary({ ipcMain }).calls[0].phase, 'rejected'); assert.equal(await dialog.showMessageBox(), result);
    assert.equal(readControlsBoundary({ ipcMain }).nativePromptCount, 1); assert.throws(() => armControlsBoundary({ ipcMain }, [{ method: 'connect', args: [] }]));
  } finally { delete host.__release1ControlsBoundary; if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete (process.versions as any).electron; }
});
test('boundary decline arm rejects an accept decision before the original handler', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'electron'), host = globalThis as any; let calls = 0;
  Object.defineProperty(process.versions, 'electron', { value: '44.7.2', configurable: true });
  const ipcMain = { _invokeHandlers: new Map([['forgedesk:invoke', async () => { calls++; }]]) }, dialog = { showMessageBox: async () => ({ response: 0 }) };
  try {
    installControlsBoundary({ ipcMain, dialog }, '44.7.2'); armControlsBoundary({ ipcMain }, [{ method: 'approve', args: [4, 7, 'decline'] }]);
    await assert.rejects((ipcMain._invokeHandlers.get('forgedesk:invoke')! as any)({}, 'approve', [4, 7, 'accept']), /CONTROLS_IPC_NOT_ARMED/);
    assert.equal(calls, 0); assert.equal(readControlsBoundary({ ipcMain }).remainingArms, 1);
  } finally { delete host.__release1ControlsBoundary; if (descriptor) Object.defineProperty(process.versions, 'electron', descriptor); else delete (process.versions as any).electron; }
});
test('runtime receipt binds bare-package seeds, transitive bytes, and added executable files', async () => {
  const source = await readFile(new URL('./release-1-controls-bootstrap.mjs', import.meta.url));
  const module = await import('data:text/javascript;base64,' + source.toString('base64'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'controls-runtime-mock-'));
  try {
    for (const name of [...module.RUNTIME_SEEDS, 'qa-transitive']) {
      const folder = path.join(directory, 'node_modules', name); await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies: name === 'tsx' ? { 'qa-transitive': '1.0.0' } : {} }));
      await writeFile(path.join(folder, 'index.js'), 'export const fixture = 1;\n');
    }
    const runtime = await module.runtimeClosure(directory); assert.equal(runtime.runtimePackages.length, 5);
    assert.ok(runtime.runtimePins.some((p: any) => p.path === 'node_modules/qa-transitive/index.js')); await module.verifyRuntime(directory, runtime);
    await writeFile(path.join(directory, 'node_modules/tsx/index.js'), 'export const fixture = 2;\n'); await assert.rejects(module.verifyRuntime(directory, runtime));
    await writeFile(path.join(directory, 'node_modules/tsx/index.js'), 'export const fixture = 1;\n');
    await writeFile(path.join(directory, 'node_modules/tsx/extra-loader.js'), 'export const unreviewed = true;\n'); await assert.rejects(module.verifyRuntime(directory, runtime));
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true }); }
});
test('direct tsx native run is rejected before any plan read or installed launch', async () => {
  const { main } = await import('../release-1-controls-smoke');
  await assert.rejects(main(['run', 'nonexistent-plan', pin]), /independently pinned builtin bootstrap/);
});
test('builtin pre-import source allowlist exactly covers the independently parsed source closure', async () => {
  const source = await readFile(new URL('./release-1-controls-bootstrap.mjs', import.meta.url));
  const module = await import('data:text/javascript;base64,' + source.toString('base64'));
  assert.deepEqual(module.SOURCE_FILES, (await controlsClosure()).map(p => p.path));
});
test('pre-import package metadata binds the authority manifest and rejects new nested package scopes', async () => {
  const source = await readFile(new URL('./release-1-controls-bootstrap.mjs', import.meta.url));
  const module = await import('data:text/javascript;base64,' + source.toString('base64'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'controls-metadata-mock-')), hash = (value: string) => createHash('sha256').update(value).digest('hex');
  try {
    const pkg = '{"name":"forgedesk-codex","type":"module"}', lock = '{"lockfileVersion":3}';
    await writeFile(path.join(directory, 'package.json'), pkg); await writeFile(path.join(directory, 'package-lock.json'), lock);
    await mkdir(path.join(directory, 'output/release-1.0/package-audit'), { recursive: true });
    const release = JSON.stringify({ schema: 'forgedesk-release-package-audit-v1', version: '1.0.0', sourceFreeze: { packageSha256: hash(pkg), lockSha256: hash(lock) } });
    await writeFile(path.join(directory, 'output/release-1.0/package-audit/RELEASE_MANIFEST.json'), release); await module.verifyResolutionMetadata(directory, hash(release));
    await writeFile(path.join(directory, 'package.json'), '{"name":"typescript","exports":"./unreviewed.js"}'); await assert.rejects(module.verifyResolutionMetadata(directory, hash(release)));
    await writeFile(path.join(directory, 'package.json'), pkg); await mkdir(path.join(directory, 'tests/helpers'), { recursive: true });
    await writeFile(path.join(directory, 'tests/helpers/package.json'), '{"name":"typescript","exports":"./unreviewed.js"}'); await assert.rejects(module.verifyResolutionMetadata(directory, hash(release)), /UNREVIEWED_SOURCE_PACKAGE_SCOPE/);
    await rm(path.join(directory, 'tests/helpers/package.json')); await mkdir(path.join(directory, 'tests/helpers/node_modules/typescript'), { recursive: true });
    await writeFile(path.join(directory, 'tests/helpers/node_modules/typescript/package.json'), '{"name":"typescript","main":"./unreviewed.js"}'); await assert.rejects(module.verifyResolutionMetadata(directory, hash(release)), /UNREVIEWED_SOURCE_NODE_MODULES/);
    await assert.rejects(module.verifyResolutionMetadata(directory, pin));
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true }); }
});
test('builtin stable reads reject an exhausted remaining byte budget before reading a file', async () => {
  const source = await readFile(new URL('./release-1-controls-bootstrap.mjs', import.meta.url));
  const module = await import('data:text/javascript;base64,' + source.toString('base64'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'controls-budget-mock-'));
  try {
    const file = path.join(directory, 'runtime.js'); await writeFile(file, Buffer.alloc(4096, 65));
    assert.equal((await module.stable(file, 4096)).length, 4096);
    await assert.rejects(module.stable(file, 4095)); await assert.rejects(module.stable(file, 0)); await assert.rejects(module.stable(file, -1));
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true }); }
});
