import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createPackage, extractFile } from '@electron/asar';
import ts from 'typescript';
import { Gate, PHASES, INCIDENT, MODEL, NODE, GIT, OUTPUT, FILES, ROOT, readStable, sha, fullHistory, assertHistorical, assertPersistedQuiet, launchEnvironment, harnessClosure, assertHistory, assertHostProjection, assertHostRecords, assertNoWork, assertApproval, assertModelBuilds, assertManifest, assertPlan } from './release-1-policy';
import { assertReleaseShape, assertExactInventory, assertInstalledInventory, BUNDLES } from './release-1-binding';
import { hashStable, assertFilePin, assertInstallerPin, APPROVED_LARGE_CODEX } from './release-1-files';
import { installObserver, armObserver, readObserver, registerApproval } from './release-1-observer';
import { SoftwareFlow, assertObserver, sanitizeFailure } from './release-1-workflow';
import { assertEnvironment, main } from '../release-1-software-smoke';
import { primarySid } from './snapshot-smoke-scope';
import { REVIEWED_INSPECT_PINS, assertReviewedHistoricalInspect, assertReviewedInspectEvidence } from './release-1-historical-inspect';

const PIN = 'a'.repeat(64), NEXT = 'b'.repeat(64), DATE = '2026-10-18T02:00:00.000Z';
const clone = <T>(value: T): T => structuredClone(value);
function history() {
  return { owner: { runId: INCIDENT.runId, taskId: INCIDENT.taskId, sessionId: INCIDENT.taskId, threadId: 'old-thread', turnId: 'old-turn', generation: 4, model: MODEL },
    runSummary: { status: 'needs_attention', phase: 'needs_attention', profileId: 'fixed-profile', profileSha256: PIN, createdAt: DATE, updatedAt: DATE, currentTool: 'fz3b_inspect', stopRequested: true, active: false, hardwareBusy: false, nativeApproval: 'not_requested', fullPublicRunSha256: PIN },
    fingerprint: { runId: INCIDENT.runId, taskId: INCIDENT.taskId, sessionId: INCIDENT.taskId, unknown: { status: 'needs_attention', phase: 'needs_attention' }, hashes: { operations: PIN } } };
}
function projection(released = true) {
  return { schemaVersion: 1, scope: 'fz3b-057-public-local-quiet-observation-v1', sampledAt: DATE, version: '0.5.7', held: !released,
    run: { runId: INCIDENT.runId, taskId: INCIDENT.taskId, sessionId: INCIDENT.taskId, status: 'needs_attention', phase: 'needs_attention', active: false, hardwareBusy: false, nativeApproval: 'not_requested' },
    engines: { ordinary: 'stopped', hardware: 'stopped', fz3b: 'stopped' }, owner: { fz3bActiveRunId: released ? null : INCIDENT.runId, hardwareActiveRunId: null, recoveryActionsPresent: !released, finishPreflightRefusal: !released, quarantineEmptyHome: false },
    quiet: { approvalCount: 0, sessionCount: 1, allSessionsQuiet: true, softwareOperationCount: 0, allSoftwareOperationsQuiet: true, allAgentRunsQuiet: true }, history: history() };
}
function ipc(purpose: string, count: number) {
  return { purpose, electronVersion: '44.7.2', runId: INCIDENT.runId, forbiddenCount: 0, unexpectedNativePrompt: false, nativePromptCount: purpose === 'quarantine' ? 1 : 0, nativePromptQualified: purpose === 'quarantine',
    calls: count ? [{ phase: 'fulfilled', argumentsValid: true, startedAt: 1, finishedAt: 2, resultValid: true, ...(purpose === 'quarantine' ? { receipt: { schemaVersion: 1, nonce: PIN, canonicalHomeAbsent: true, preservedEmpty: true, intentSha256: PIN } } : {}) }] : [] };
}
function close(id: number, created: string) { return { normalClose: true, forcedKill: false, launcherExitCode: 0, launcherSignal: null, nativeElectronIdentityAbsent: true, nativeInstalledProcessesAbsent: true, nativeMainBefore: { id, created } }; }
function hostRecords(): any[] {
  const launch = (id: number, created: string) => ({ desktopIdentity: { sid: primarySid, sessionId: 1, elevated: false, interactive: true }, nativeMain: { id, created, sid: primarySid, sessionId: 1, execPath: 'E:/AiProject/agent-design/ForgeDesk-codex/install/ForgeDesk.exe' } });
  const action = (purpose: string, released: boolean) => ({ samples: [0, 1].map(() => ({ ipc: ipc(purpose, 1), dom: { currentIntent: '', ariaBusy: 'false', actionErrorCount: 0, sequence: ['', purpose === 'quarantine' ? 'quarantine-empty-home' : 'reconcile-preflight-inspect', ''] }, snapshot: projection(released) })) });
  return [
    { phase: 'held-preflight', facts: { launch: launch(10, DATE), samples: [projection(false), projection(false)], ipc: ipc('readonly', 0) } },
    { phase: 'quarantine', facts: action('quarantine', false) }, { phase: 'finish', facts: action('finish', true) },
    { phase: 'close-a', facts: { beforeClose: projection(), close: close(10, DATE), noMaintenanceSubstitution: true } },
    { phase: 'restart-no-rehold', facts: { launch: launch(11, '2026-10-18T02:01:00.000Z'), samples: [projection(), projection()], ipc: ipc('readonly', 0) } },
    { phase: 'close-b', facts: { beforeClose: projection(), close: close(11, '2026-10-18T02:01:00.000Z'), noMaintenanceSubstitution: true } },
  ];
}
function noWork(): any { return { hardwareAgent: { engineState: 'stopped', runs: [], activeRunId: undefined }, fz3bAgent: { engineState: 'stopped', runs: [{ active: false, hardwareBusy: false, nativeApproval: 'not_requested', operations: [{ status: 'unknown' }] }] }, sessions: [{ taskId: 'old', status: 'completed' }], tasks: [], approvals: [] }; }
function approvalFixture(): { state: any; task: any } {
  const task = { id: 'new-task', snapshotProfile: { revision: 'revision-1' } };
  return { task, state: { sessions: [{ taskId: task.id, threadId: 'new-thread', turnId: 'new-turn' }], approvals: [{ generation: 9, id: 42, decisions: ['accept', 'decline'], method: 'mcpServer/elicitation/request', params: { serverName: 'engineering', mode: 'form', requestedSchema: { type: 'object', properties: {} }, message: 'Allow the engineering MCP server to run tool "engineering.build"?', threadId: 'new-thread', turnId: 'new-turn', _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { taskId: task.id, profileRevision: 'revision-1', requestKey: 'fresh-key' } } } }] } };
}
function originalFailure(): any {
  const sandboxProbe = Object.fromEntries(['passed', 'inputWriteDenied', 'privateWriteDenied', 'templateWriteDenied', 'sqliteInputWriteDenied', 'outputWriteAllowed', 'sqliteOutputWriteAllowed', 'hostMarkersAbsent'].map(k => [k, true]));
  const permissionProbe = Object.fromEntries(['build', 'verify'].map(stage => [stage, { stage, ...Object.fromEntries(['passed', 'inputWriteDenied', 'childProcessDenied', 'workerDenied', 'addonDenied', 'wasiDenied', 'inspectorDenied'].map(k => [k, true])), outputWriteAllowed: stage === 'build', outputWriteDenied: stage === 'verify' }]));
  return { id: 'failed-original', status: 'failed', evidenceLevel: 'B', exitCode: 1, failureReason: 'Snapshot verifying failed: exit 1', requestKey: 'original-key', snapshot: { verificationResult: 'failed', sandboxProbe, permissionProbe } };
}
function builds() {
  const task: any = { id: 'task', status: 'passed', snapshotProfile: { revision: 'r1' }, operations: [originalFailure(), { id: 'passing', status: 'succeeded', requestKey: 'passing-key' }] };
  const approvals = task.operations.map((o: any) => ({ requestKey: o.requestKey }));
  const messages = task.operations.map((o: any) => ({ role: 'tool', text: JSON.stringify({ type: 'mcpToolCall', server: 'engineering', tool: 'engineering.build', arguments: { taskId: task.id, profileRevision: 'r1', requestKey: o.requestKey } }) }));
  return { task, approvals, messages };
}
function instrumentation(original: (...args: any[]) => any = async () => undefined, selected = 'E:/synthetic/workspace', open?: (...args: any[]) => any) {
  const map = new Map([['forgedesk:invoke', original]]), dialogs = { showOpenDialog: open ?? async function (..._args: any[]) { return { canceled: false, filePaths: [selected] }; }, showMessageBox: function (..._args: any[]) { return Promise.resolve({ response: 0 }); } };
  const surface = { ipcMain: { _invokeHandlers: map }, dialog: dialogs }, context = vm.createContext({ process: { versions: { electron: '44.7.2' } }, Map, surface });
  const invoke = (fn: Function, value?: unknown) => { (context as any).argument = value; return vm.runInContext(`(${fn.toString()})(surface, argument)`, context); };
  invoke(installObserver, '44.7.2');
  return { surface, map, dialogs, context, invoke, read: () => invoke(readObserver), arm: (purpose: string, extra: any = {}) => invoke(armObserver, { purpose, workspace: 'E:/synthetic/workspace', node: NODE, exports: 'E:/synthetic/exports', taskId: 'task', projectId: 'project', ...extra }) };
}

test('all eight required phases require exact new predecessor arming; no auto-next', () => {
  const gate = new Gate(PIN); for (const phase of PHASES) { assert.equal(gate.next, phase); assert.equal(gate.busy, false); assert.equal(gate.arm(`${phase} ${gate.predecessor}`, false), phase); assert.equal(gate.busy, true); gate.complete(phase, NEXT); } assert.equal(gate.done, true); assert.throws(() => gate.arm(`launch ${NEXT}`, false));
});
test('same tick second line cannot queue behind an in-flight phase', () => { const gate = new Gate(PIN); gate.arm(`launch ${PIN}`, false); assert.throws(() => gate.arm(`software-ready ${PIN}`, false)); assert.equal(gate.held, true); assert.throws(() => gate.complete('launch', NEXT)); });
test('wrong SHA/EOF failure cannot be recovered or replayed', () => { const gate = new Gate(PIN); assert.throws(() => gate.arm(`launch ${NEXT}`, false)); assert.throws(() => gate.arm(`launch ${PIN}`, false)); const eof = new Gate(PIN); eof.fail(); assert.throws(() => eof.arm(`launch ${PIN}`, false)); });
test('controlled leave-mode is separately armed exactly once', () => { const gate = new Gate(PIN); gate.arm(`launch ${PIN}`, false); gate.complete('launch', NEXT); assert.equal(gate.arm(`leave-mode ${NEXT}`, true), 'leave-mode'); gate.complete('leave-mode', PIN); assert.equal(gate.next, 'software-ready'); assert.equal(gate.arm(`software-ready ${PIN}`, false), 'software-ready'); const refused = new Gate(PIN); refused.arm(`launch ${PIN}`, false); refused.complete('launch', NEXT); assert.throws(() => refused.arm(`software-ready ${NEXT}`, true)); });
test('full original owner and summary, not run ID alone, remain fixed', () => { const before = projection(); assertHostProjection(before); for (const mutate of [(v: any) => v.history.owner.generation++, (v: any) => v.history.owner.threadId = 'different', (v: any) => v.history.runSummary.fullPublicRunSha256 = NEXT, (v: any) => v.history.runSummary.status = 'passed']) { const changed = clone(before); mutate(changed); assert.throws(() => assertHostProjection(changed, before.history)); } const malformed = history(); (malformed.owner as any).token = 'not-public'; assert.throws(() => assertHistory(malformed)); });
test('actual host six-phase completion and fresh no-rehold are mandatory', () => { const records = hostRecords(); assert.equal(assertHostRecords(records).lastNativeCreation, '2026-10-18T02:01:00.000Z'); for (const mutate of [(v: any[]) => v.splice(2, 1), (v: any[]) => v[4].facts.samples[1].held = true, (v: any[]) => v[4].facts.launch.nativeMain.created = DATE, (v: any[]) => v[2].facts.samples[1].ipc.calls[0].phase = 'started', (v: any[]) => v[5].facts.close.launcherSignal = 'SIGTERM', (v: any[]) => v[5].facts.noMaintenanceSubstitution = false, (v: any[]) => v[5].facts.close.nativeMainBefore.id = 10]) { const bad = clone(records); mutate(bad); assert.throws(() => assertHostRecords(bad)); } });
test('fixed historical FZ3B unknown does not permit a software unknown', () => { const state = noWork(); assertNoWork(state); state.tasks = [{ id: 'software', operations: [{ status: 'unknown', cleanup: 'confirmed' }] }]; assert.throws(() => assertNoWork(state)); });
test('foreign work, uncertain sessions, active devices and cleanup ambiguity hold', () => { for (const mutate of [(v: any) => v.sessions[0].engineUncertain = true, (v: any) => v.sessions[0].turnId = 'pending', (v: any) => v.hardwareAgent.activeRunId = 'device', (v: any) => v.fz3bAgent.runs[0].active = true, (v: any) => v.tasks = [{ id: 'foreign', operations: [{ status: 'succeeded', cleanup: 'unconfirmed' }] }]]) { const state = noWork(); mutate(state); assert.throws(() => assertNoWork(state, 'task', true)); } });
test('approval matches engineering build generation/thread/turn/task/profile/key only', () => { const valid = approvalFixture(); assert.equal(assertApproval(valid.state, valid.task).generation, 9); for (const mutate of [(v: any) => v.state.approvals[0].generation = 0, (v: any) => v.state.approvals[0].params.threadId = 'old-thread', (v: any) => v.state.approvals[0].params.turnId = 'old-turn', (v: any) => v.state.approvals[0].params._meta.tool_params.taskId = INCIDENT.taskId, (v: any) => v.state.approvals[0].params._meta.tool_params.profileRevision = 'old-revision', (v: any) => v.state.approvals[0].params._meta.tool_params.extra = true]) { const bad = approvalFixture(); mutate(bad); assert.throws(() => assertApproval(bad.state, bad.task)); } });
test('original defect needs real verifier exit1 plus affirmative isolation receipts', () => { const good = builds(); assertModelBuilds(good.task, good.approvals, good.messages); for (const mutate of [(v: any) => v.task.operations[0].status = 'unknown', (v: any) => v.task.operations[0].failureReason = 'Snapshot sandbox_probe failed: exit 1', (v: any) => v.task.operations[0].snapshot.sandboxProbe.inputWriteDenied = false, (v: any) => v.task.operations[0].snapshot.permissionProbe.verify.workerDenied = false, (v: any) => v.task.operations[0].snapshot.verifierReceipt = { passed: true }, (v: any) => v.task.operations[1].requestKey = 'original-key', (v: any) => v.messages.pop()]) { const bad = builds(); mutate(bad); assert.throws(() => assertModelBuilds(bad.task, bad.approvals, bad.messages)); } });
test('observer preserves original this/arguments/result and redacts errors', async () => { const receiver = {}, error = Error('PRIVATE_TOKEN_MUST_NOT_PERSIST'); let seen: any[] = []; const observer = instrumentation(async function (this: any, ...args: any[]) { assert.equal(this, receiver); seen = args; if (args[1] === 'fz3bLeaveMode') throw error; return { identity: true }; }); const wrapper = observer.map.get('forgedesk:invoke')!; const event = {}; const value = await wrapper.call(receiver, event, 'snapshot', []); assert.deepEqual(value, { identity: true }); assert.equal(seen[0], event); observer.arm('leave'); await assert.rejects(wrapper.call(receiver, event, 'fz3bLeaveMode', []), e => e === error); assert.equal(JSON.stringify(observer.read()).includes('PRIVATE_TOKEN'), false); assert.equal(observer.read().calls[0].phase, 'rejected'); });
test('observer only observes forbidden mutations; it never substitutes a product reply', async () => { let calls = 0; const observer = instrumentation(async () => { calls++; return 'original'; }); const wrapper = observer.map.get('forgedesk:invoke')!; for (const method of ['fz3bFinishPreflightRefusal', 'fz3bQuarantineEmptyHome', 'fz3bRecover', 'stop', 'cancelOperation', 'connect']) assert.equal(await wrapper({}, method, []), 'original'); assert.equal(calls, 6); assert.equal(observer.read().forbiddenCount, 6); assert.throws(() => observer.arm('readonly')); });
test('native picker result is real pass-through, never synthetic accept', async () => { const observer = instrumentation(); observer.arm('setup'); const result = await observer.dialogs.showOpenDialog({ title: 'real picker' }); assert.deepEqual(result.filePaths, ['E:/synthetic/workspace']); assert.equal(observer.read().pickers[0].qualified, true); const wrong = instrumentation(undefined, 'E:/elsewhere'); wrong.arm('setup'); await wrong.dialogs.showOpenDialog(); assert.equal(wrong.read().pickers[0].qualified, false); });
test('unexpected native message remains untouched but blocks receipt', async () => { const observer = instrumentation(); const answer = await observer.dialogs.showMessageBox({ message: 'original' }); assert.equal(answer.response, 0); assert.equal(observer.read().unexpectedNativePrompt, true); assert.throws(() => assertObserver(observer.read())); });
test('pending original IPC cannot be reset; actual completion required', async () => { let release!: () => void; const observer = instrumentation(() => new Promise<void>(r => { release = r; })); observer.arm('leave'); const pending = observer.map.get('forgedesk:invoke')!({}, 'fz3bLeaveMode', []); assert.equal(observer.read().calls[0].phase, 'started'); assert.throws(() => observer.arm('readonly')); release(); await pending; assertObserver(observer.read(), { fz3bLeaveMode: 1 }); observer.arm('readonly'); });
test('real renderer approval only accepts registered exact generation/id once', async () => { const observer = instrumentation(); observer.arm('model'); observer.invoke(registerApproval, { generation: 3, id: 'approval', requestKey: 'key' }); assert.equal(observer.read().approvals[0].consumed, false); const wrapper = observer.map.get('forgedesk:invoke')!; await wrapper({}, 'approve', [2, 'approval', 'accept']); assert.equal(observer.read().forbiddenCount, 1); const valid = instrumentation(); valid.arm('model'); valid.invoke(registerApproval, { generation: 3, id: 'approval', requestKey: 'key' }); await valid.map.get('forgedesk:invoke')!({}, 'approve', [3, 'approval', 'accept']); assert.equal(valid.read().approvals[0].consumed, true); await valid.map.get('forgedesk:invoke')!({}, 'approve', [3, 'approval', 'accept']); assert.equal(valid.read().forbiddenCount, 1); });
test('late original promise after hold cannot start the next normal action', async () => { const flow = new SoftwareFlow({ acceptanceId: 'synthetic' } as any, 'E:/synthetic'); let release!: (value: string) => void, calls = 0; const pending = flow.original(() => { calls++; return new Promise<string>(r => { release = r; }); }); flow.stop(); release('late-original-result'); await assert.rejects(pending, /SOFTWARE_FLOW_HELD/); await assert.rejects(flow.effect(async () => { calls++; }), /SOFTWARE_FLOW_HELD/); assert.equal(calls, 1); });
test('ambient override and old/unclosed manifest schemas fail before launch', () => { assertEnvironment({ PATH: 'ordinary' }); for (const key of ['FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'FORGEDESK_SNAPSHOT_TEST', 'FORGEDESK_FZ3B_FAKE']) assert.throws(() => assertEnvironment({ [key]: '1' })); const manifest: any = { schemaVersion: 1, scope: 'release-1-independent-harness-v2', version: '1.0.0', candidateSha256: PIN, sources: FILES.map(path => ({ path, bytes: 1, sha256: PIN })).sort((a, b) => a.path.localeCompare(b.path)), node: { path: NODE, bytes: 1, sha256: PIN }, git: { path: GIT, bytes: 1, sha256: PIN }, runtimePackages: ['node_modules/@electron/asar','node_modules/playwright','node_modules/tsx','node_modules/typescript'], runtimePins: [{path:'node_modules/tsx/package.json',bytes:1,sha256:PIN}] }; assertManifest(manifest); const old: any = clone(manifest); old.version = '0.5.1'; assert.throws(() => assertManifest(old)); const extra: any = clone(manifest); extra.authorized = true; assert.throws(() => assertManifest(extra)); assert.throws(() => assertPlan({ version: '0.5.6', authorized: true })); });
test('source closure binds the new entry, actual validator and helpers, not an old smoke', async () => { const rows = await harnessClosure(); for (const file of FILES) assert.ok(rows.some(r => r.path === file)); assert.equal(rows.some(r => r.path === 'tests/snapshot-electron-smoke.ts'), false); assert.equal(rows.some(r => r.path.split('/').includes('.runtime')), false); });
test('failure telemetry uses only closed stages/reasons, never raw messages or stacks', () => { const privateError = Error('PRIVATE_TOKEN_DO_NOT_PUBLISH'); privateError.stack = 'PRIVATE_STACK'; assert.deepEqual(sanitizeFailure(privateError, 'setup-profile-wait'), { stage: 'setup-profile-wait', reason: 'OTHER', checkpoint: 'none' }); assert.deepEqual(sanitizeFailure({ secret: 'PRIVATE_TOKEN' }, 'PRIVATE_STAGE'), { stage: 'unknown', reason: 'OTHER', checkpoint: 'none' }); const hostile = Error(); Object.defineProperty(hostile, 'message', { get() { throw Error('PRIVATE_GETTER'); } }); assert.deepEqual(sanitizeFailure(hostile, 'idle'), { stage: 'idle', reason: 'OTHER', checkpoint: 'none' }); assert.equal(JSON.stringify(sanitizeFailure(privateError, privateError)).includes('PRIVATE'), false); });
test('fixed failure classes are diagnostic only and do not stringify unknown errors', () => { for (const [message, reason] of [['SOFTWARE_ORIGINAL_WAIT_TIMEOUT', 'WAIT_TIMEOUT'], ['SOFTWARE_ORIGINAL_IPC_PENDING', 'ORIGINAL_IPC_PENDING'], ['SOFTWARE_PRODUCT_IPC_REJECTED', 'PRODUCT_REJECTED'], ['SOFTWARE_ROOT_INPUT_OR_SIGNAL', 'ROOT_INPUT_OR_SIGNAL']]) assert.equal(sanitizeFailure(Error(message), 'ready').reason, reason); const timeout = Error('PRIVATE_TIMEOUT_DETAILS'); timeout.name = 'TimeoutError'; assert.equal(sanitizeFailure(timeout, 'setup-node-picker').reason, 'PLAYWRIGHT_ACTION_TIMEOUT'); const assertion = Object.assign(Error('PRIVATE_ACTUAL_EXPECTED'), { code: 'ERR_ASSERTION' }); assert.equal(sanitizeFailure(assertion, 'verify-snapshots').reason, 'ASSERTION'); });
test('failure checkpoints are a closed diagnostic label, never caller error data', () => {
  const error = Object.assign(Error('PRIVATE_ERROR'), { code: 'ERR_ASSERTION', actual: 'PRIVATE_ACTUAL', expected: 'PRIVATE_EXPECTED' });
  assert.deepEqual(sanitizeFailure(error, 'launch', 'launch-native-attach'), { stage: 'launch', reason: 'ASSERTION', checkpoint: 'launch-native-attach' });
  for (const value of ['PRIVATE_CHECKPOINT', { secret: 'PRIVATE_CHECKPOINT' }, error]) assert.equal(sanitizeFailure(error, 'launch', value).checkpoint, 'none');
  const result = sanitizeFailure(error, 'launch', 'history-extra-inspect'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('first software hold closes only stdin once and preserves unsafe lifecycle keepalive', async () => {
  const raw = await readStable(path.join(ROOT, 'tests/release-1-software-smoke.ts'));
  const source = ts.createSourceFile('entry.ts', raw.toString(), ts.ScriptTarget.Latest, true);
  let holdText = '', closeText = '';
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'hold') holdText = node.initializer!.getText(source);
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'input.on' && node.arguments[0]?.getText(source) === "'close'") closeText = node.arguments[1].getText(source);
    ts.forEachChild(node, visit);
  }; visit(source); assert.ok(holdText && closeText);
  for (const safeHarnessExit of [true, false]) {
    const stream = new PassThrough(), input = createInterface({ input: stream });
    const counters = { failed: 0, stopped: 0, protected: 0, writes: 0, resolved: 0, keepalive: 0, closed: 0 };
    input.on('close', () => counters.closed++);
    const context = vm.createContext({ input, counters, safeHarnessExit, Error, path, directory: 'E:/in-memory', console: { log() {}, error() {} }, process: { exitCode: 0 }, setInterval: () => { counters.keepalive++; return {}; } });
    const setup = `let failed=false,done=false,failureWritten=false,unsafeKeepAlive;
      const gate={fail(){counters.failed++},next:'launch',predecessor:'fixed'};
      const flow={stop(){counters.stopped++},protect(){counters.protected++;return {safeHarnessExit}},failure(){return {reason:'OTHER',checkpoint:'none'}}};
      const stamp=()=>({}),writeNew=async()=>{counters.writes++;return 'fixed'},resolve=()=>{counters.resolved++};
      const hold=${holdText};input.on('close',${closeText});globalThis.invokeHold=hold;`;
    vm.runInContext(ts.transpileModule(setup, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
    await (context as any).invokeHold(Error('PRIVATE_ERROR')); await (context as any).invokeHold(Error('PRIVATE_ERROR'));
    assert.equal(stream.isPaused(), true); assert.equal(counters.closed, 1); assert.equal(counters.failed, 1); assert.equal(counters.stopped, 1);
    assert.equal(counters.protected, 1); assert.equal(counters.writes, 1); assert.equal(counters.resolved, 1); assert.equal(counters.keepalive, safeHarnessExit ? 0 : 1);
    stream.destroy();
  }
});
test('picker timing records real started and settled metadata without answering the original', async () => { let release!: (value: any) => void; const receiver = {}, args = { private: 'PRIVATE_PICKER_OPTIONS' }; const observer = instrumentation(undefined, undefined, function (this: any, value: any) { assert.equal(this, receiver); assert.equal(value, args); return new Promise(resolve => { release = resolve; }); }); observer.arm('setup'); const pending = observer.dialogs.showOpenDialog.call(receiver, args); const started = observer.read(); assert.equal(started.pickers[0].phase, 'started'); assert.ok(Number.isFinite(started.pickers[0].startedAt)); assert.equal(started.pickers[0].finishedAt, undefined); const actual = { canceled: false, filePaths: ['E:/synthetic/workspace'] }; release(actual); assert.equal(await pending, actual); const settled = observer.read(); assert.equal(settled.pickers[0].phase, 'fulfilled'); assert.ok(settled.pickers[0].finishedAt >= settled.pickers[0].startedAt); assert.equal(settled.pickers[0].qualified, true); assert.equal(started.pickers[0].phase, 'started'); assert.equal(JSON.stringify(settled).includes('PRIVATE'), false); const rejection = Error('PRIVATE_PICKER_FAILURE'); const failed = instrumentation(undefined, undefined, async () => { throw rejection; }); failed.arm('setup'); await assert.rejects(failed.dialogs.showOpenDialog(), error => error === rejection); assert.equal(failed.read().pickers[0].phase, 'rejected'); assert.equal(JSON.stringify(failed.read()).includes('PRIVATE'), false); });
test('held telemetry uses only the latest cached picker sample, without an App call', async () => { const flow = new SoftwareFlow({ acceptanceId: 'synthetic' } as any, 'E:/synthetic'); let reads = 0; flow.app = { evaluate: async () => { reads++; return { pickers: [{ purpose: 'setup', phase: 'started', startedAt: 100, secret: 'PRIVATE_TOKEN' }] }; } } as any; await flow.observe(); flow.stage = 'setup-profile-wait'; flow.stop(); const receipt = flow.failure(Error('SOFTWARE_ORIGINAL_WAIT_TIMEOUT')); assert.equal(reads, 1); assert.equal(receipt.reason, 'WAIT_TIMEOUT'); assert.equal(receipt.pickers[0].phase, 'started'); assert.equal(receipt.pickers[0].finishedAt, null); assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false); assert.ok(Number.isFinite(receipt.pickerObservationAt)); });
function restartGate(initialControlled = false) { const gate = new Gate(PIN); gate.arm(`launch ${PIN}`, false); gate.complete('launch', NEXT); if (initialControlled) { gate.arm(`leave-mode ${NEXT}`, true); gate.complete('leave-mode', PIN); } for (const phase of ['software-ready', 'snapshot', 'close-a', 'restart'] as const) { gate.arm(`${phase} ${gate.predecessor}`, false); gate.complete(phase, NEXT); } return gate; }
test('each launch has its own single optional leave followed by separately armed readiness', () => { const gate = restartGate(true); assert.equal(gate.expected(true), 'restart-leave'); gate.arm(`restart-leave ${gate.predecessor}`, true); gate.complete('restart-leave', PIN); assert.equal(gate.next, 'restart-ready'); assert.equal(gate.expected(false), 'restart-ready'); gate.arm(`restart-ready ${PIN}`, false); gate.complete('restart-ready', NEXT); assert.equal(gate.next, 'dedup-stale'); const noLeave = restartGate(); assert.equal(noLeave.expected(false), 'restart-ready'); noLeave.arm(`restart-ready ${NEXT}`, false); noLeave.complete('restart-ready', PIN); assert.equal(noLeave.next, 'dedup-stale'); });
test('restart cannot skip readiness, reuse the initial leave, use stale SHA or leave twice', () => { for (const [line, controlled] of [[`restart-ready ${NEXT}`, true], [`dedup-stale ${NEXT}`, false], [`leave-mode ${NEXT}`, true], [`restart-leave ${PIN}`, true], [`restart-leave ${NEXT}`, false]] as const) { const gate = restartGate(); assert.throws(() => gate.arm(line, controlled)); assert.equal(gate.held, true); } const twice = restartGate(); twice.arm(`restart-leave ${NEXT}`, true); twice.complete('restart-leave', PIN); assert.throws(() => twice.arm(`restart-leave ${PIN}`, true)); const exact = restartGate(); exact.arm(`restart-leave ${NEXT}`, true); assert.throws(() => exact.complete('restart-ready', PIN)); assert.equal(exact.next, 'restart-ready'); });
function restartFlow() { const flow = new SoftwareFlow({ acceptanceId: 'synthetic', host: { history: history() } } as any, 'E:/synthetic'); flow.taskId = 'task'; flow.operationIds = ['op']; const state: any = { ...noWork(), version: '0.5.7', engine: { state: 'stopped' }, hardware: { modeActive: true }, tasks: [{ id: 'task', status: 'needs_attention', acceptance: [{ status: 'stale' }], evidence: [{ snapshot: { verificationResult: 'passed' } }], operations: [{ id: 'op', status: 'succeeded', cleanup: 'confirmed' }] }] }; flow.historical = async () => { assertNoWork(state); return { state, run: {} as any }; }; flow.observe = async () => ({ purpose: 'readonly', forbiddenCount: 0, unexpectedNativePrompt: false, calls: [], pickers: [], approvals: [] }); flow.rendererSnapshotQuiet = async () => { throw Error('UNAUTHORIZED_SOFTWARE_DOM_READY_CHECK'); }; flow.ready = async () => { throw Error('UNARMED_READY'); }; return { flow, state }; }
test('controlled restart observation remains readonly host quiet, not software-ready', async () => { const { flow, state } = restartFlow(); const sample = await flow.restartObservation(); assert.equal(sample.public.controlledModeActive, true); assert.equal(sample.public.softwareReadyClaimed, false); assert.equal(sample.public.ipc.calls.length, 0); state.sessions[0].engineUncertain = true; await assert.rejects(flow.restartObservation()); state.sessions[0].engineUncertain = false; state.tasks[0].operations.push({ id: 'foreign', status: 'unknown' }); await assert.rejects(flow.restartObservation()); });
test('restart-leave makes exactly one original call and never auto-runs restart-ready', async () => { const { flow, state } = restartFlow(); const arms: string[] = []; let calls = 0; flow.arm = async purpose => { arms.push(purpose); }; flow.receipt = async counts => { assert.deepEqual(counts, { fz3bLeaveMode: 1 }); return { actualFixtureOnly: true } as any; }; flow.page = { evaluate: async () => { calls++; state.hardware.modeActive = false; state.engine.state = 'ready'; } } as any; const value = await flow.restartLeave(); assert.equal(calls, 1); assert.deepEqual(arms, ['leave', 'readonly']); assert.equal(value.readinessDeferredToRootArmedRestartReady, true); assert.equal(value.after.softwareReadyClaimed, false); await assert.rejects(flow.restartLeave()); assert.equal(calls, 1); let ready = 0; flow.ready = async stage => { ready++; assert.equal(stage, 'restart-ready'); return { state, public: { independentlyArmedReady: true } } as any; }; assert.deepEqual(await flow.restartReady(), { independentlyArmedReady: true }); assert.equal(ready, 1); });

function releaseFixture(): any {
  const row = (path: string) => ({ path, bytes: 1, sha256: PIN });
  const resources = ['resources/app.asar', 'resources/codex/codex.exe', 'resources/codex/manifest.json', 'resources/templates/node-software-v1/verify.mjs'].map(row);
  return { schema: 'forgedesk-release-package-audit-v1', version: '1.0.0', appId: 'dev.forgedesk.codex',
    sourceFreeze: { packageSha256: PIN, lockSha256: PIN, auditSourceSha256: PIN, buildSourceSha256: PIN, assetApproval: {path:'output/release-1.0/ASSET_DISTRIBUTION_APPROVAL.json',sha256:PIN}, resourceManifestPins: [], resourceTransforms: [{ path: 'resources/codex/manifest.json', sourceSha256: PIN, packagedSha256: PIN, method: 'codex-public-source-only-v1' }] },
    artifacts: [row('release/ForgeDesk-1.0.0-x64-setup.exe')], unpacked: { path: 'release/win-unpacked', files: [row('ForgeDesk.exe'), ...resources] }, resources,
    bundles: BUNDLES.map(row), qualification: { packageInventoryVerified: true, installationVerified: false, softwareAccepted: false, deviceQualified: false, releaseAuthorized: false } };
}
test('release identity and every inventory relationship are checked; package flags never grant acceptance', () => {
  assertReleaseShape(releaseFixture());
  for (const change of [(v: any) => v.version = '0.5.7', (v: any) => v.appId = 'foreign', (v: any) => v.validatorPath = 'caller.mjs',
    (v: any) => v.qualification.softwareAccepted = true, (v: any) => v.resources.pop(), (v: any) => v.bundles.shift(),
    (v: any) => v.unpacked.files.push({ path: 'resources/unknown.exe', bytes: 1, sha256: PIN }),
    (v: any) => v.artifacts[0].path = '../old-installer.exe', (v: any) => v.sourceFreeze.resourceTransforms = [],
    (v: any) => v.sourceFreeze.resourceTransforms[0].packagedSha256 = NEXT, (v: any) => v.sourceFreeze.resourceTransforms[0].method = 'ambient-copy']) {
    const value = releaseFixture(); change(value); assert.throws(() => assertReleaseShape(value));
  }
});
test('installed generated extras require a separate externally pinned closed receipt, never a wildcard', () => {
  const receipt: any = { schemaVersion: 1, scope: 'release-1-installed-inventory-v1', releaseManifestSha256: PIN, extras: [{ path: 'Uninstall ForgeDesk.exe', bytes: 1, sha256: PIN }] };
  assertInstalledInventory(receipt, PIN); assert.throws(() => assertInstalledInventory(receipt, NEXT));
  for (const change of [(v: any) => v.extras[0].path = 'arbitrary.dll', (v: any) => v.extras[0].path = 'resources/auth.json', (v: any) => v.extras.push(v.extras[0]), (v: any) => v.authorized = true]) { const value = clone(receipt); change(value); assert.throws(() => assertInstalledInventory(value, PIN)); }
});
test('exact installed/unpacked inventory cannot drop, add, case-alias or substitute bytes', () => {
  const rows = releaseFixture().unpacked.files; assertExactInventory(rows, clone(rows));
  for (const change of [(v: any[]) => v.pop(), (v: any[]) => v.push({ path: 'foreign.exe', bytes: 1, sha256: PIN }),
    (v: any[]) => v[0].sha256 = NEXT, (v: any[]) => v[0].bytes++, (v: any[]) => v.push({ ...v[0], path: v[0].path.toUpperCase() })]) { const v = clone<any[]>(rows); change(v); assert.throws(() => assertExactInventory(rows, v)); }
});
function currentHistoryFixture() {
  const run: any = { schemaVersion: 1, runId: INCIDENT.runId, taskId: INCIDENT.taskId, sessionId: INCIDENT.taskId, threadId: 'old-thread', turnId: undefined, generation: 4, model: MODEL,
    status: 'needs_attention', phase: 'needs_attention', profileId: 'old-profile', profileSha256: PIN, createdAt: DATE, updatedAt: DATE, stopRequested: true,
    active: false, hardwareBusy: false, nativeApproval: 'not_requested', calls: [], operations: [{ id: INCIDENT.operationId, status: 'unknown' }],
    preflightRefusalRecoveries: [{ status: 'released', proof: { sha: PIN }, finalization: { sha: PIN }, ack: { sha: PIN }, acknowledgment: { sha: PIN }, closure: { sha: PIN } }] };
  const admission: any = { descriptorPath: 'root-pinned-public-chain', descriptorSha256: PIN, history: fullHistory(run), lastNativeCreation: DATE };
  const state: any = { ...noWork(), version: '1.0.0', dataDir: ROOT + '/.runtime/app', engine: { state: 'stopped' },
    hardware: { enabled: false, modeActive: true, reason: '工程受控模式：普通模型命令已停止，实机操作须单独授权' },
    fz3bAgent: { engineState: 'stopped', runs: [run] } };
  return { run, admission, state };
}
test('exact previously reviewed released inspect history permits software-only qualification', async () => {
  const raw = await readStable(path.join(ROOT, 'output/hardware/2026-10-16-next/product/installed-reconciliation-result.json'));
  assert.equal(sha(raw), '77d5b3e3be88ff0a246a5f637638c5f78033b42bd12f514c44e99ce5d48dabd1');
  const extra = JSON.parse(raw.toString()).fz3bAgent.runs.find((r: any) => r.runId === '8b065e0a-c1ef-4848-8329-b18c19dda45c');
  const { state, admission } = currentHistoryFixture(); state.fz3bAgent.runs.push(extra);
  assertHistorical(state, admission); assertNoWork(state);
  assert.equal(extra.operations.at(-1).status, 'unknown'); assert.equal(extra.operations.at(-1).remoteQuiescent, false);
});
test('reviewed inspect requires all seven exact public evidence files and their production bindings', async () => {
  const files = new Map<string, Buffer>();
  for (const pin of REVIEWED_INSPECT_PINS) files.set(pin.path, await readStable(path.join(ROOT, pin.path), pin.bytes));
  const run = assertReviewedInspectEvidence(files); assertReviewedHistoricalInspect(run);
  for (const pin of REVIEWED_INSPECT_PINS) {
    const changed = new Map(files), raw = Buffer.from(changed.get(pin.path)!); raw[0] ^= 1; changed.set(pin.path, raw);
    assert.throws(() => assertReviewedInspectEvidence(changed));
    const missing = new Map(files); missing.delete(pin.path); assert.throws(() => assertReviewedInspectEvidence(missing));
  }
  const extra = new Map(files); extra.set('foreign.json', Buffer.from('{}')); assert.throws(() => assertReviewedInspectEvidence(extra));
});
test('a release label, false busy flag or structurally edited history never substitutes for the exact reviewed inspect', async () => {
  const raw = await readStable(path.join(ROOT, REVIEWED_INSPECT_PINS[0].path));
  const run = JSON.parse(raw.toString()).fz3bAgent.runs.find((r: any) => r.runId === '8b065e0a-c1ef-4848-8329-b18c19dda45c');
  for (const change of [(r: any) => r.runId = 'foreign', (r: any) => r.threadId = 'foreign', (r: any) => r.active = true,
    (r: any) => r.hardwareBusy = true, (r: any) => r.operations.at(-1).status = 'prepared', (r: any) => r.operations.at(-1).remoteQuiescent = true,
    (r: any) => r.reconciliations.at(-1).proof.remote.procScanComplete = false, (r: any) => delete r.reconciliations.at(-1).finalization,
    (r: any) => r.reconciliations.at(-1).context.original.fixture.imageSha256 = PIN, (r: any) => r.reconciliations.at(-1).finalization.lockReleased = false,
    (r: any) => r.reconciliations.at(-1).proof.evidenceSha256 = PIN, (r: any) => r.operations.push({ id: 'foreign', status: 'unknown' })]) {
    const bad = clone(run); change(bad); assert.throws(() => assertReviewedHistoricalInspect(bad));
    const { state, admission } = currentHistoryFixture(); state.fz3bAgent.runs.push(bad); assert.throws(() => assertHistorical(state, admission));
  }
});
test('extra agent status and call uncertainty cannot hide behind false activity flags or duplicate exact history', async () => {
  for (const extra of [{ status: 'active', calls: [] }, { status: 'completed', calls: [{ status: 'running' }] },
    { status: 'needs_attention', calls: [{ status: 'unknown' }] }, { status: 'completed', calls: [], nativeApproval: 'unknown' },
    { status: 'completed', calls: [{ status: 'succeeded', result: { operation: { status: 'unknown' } } }] }]) {
    const { state, admission } = currentHistoryFixture();
    state.fz3bAgent.runs.push({ runId: 'foreign', active: false, hardwareBusy: false, nativeApproval: 'not_requested', operations: [], ...extra });
    assert.throws(() => assertHistorical(state, admission));
  }
  const raw = await readStable(path.join(ROOT, REVIEWED_INSPECT_PINS[0].path));
  const run = JSON.parse(raw.toString()).fz3bAgent.runs.find((r: any) => r.runId === '8b065e0a-c1ef-4848-8329-b18c19dda45c');
  const { state, admission } = currentHistoryFixture(); state.fz3bAgent.runs.push(run, clone(run));
  assert.throws(() => assertHistorical(state, admission));
});
test('primary host completion still requires every original public release-chain field', () => {
  for (const field of ['proof', 'finalization', 'ack', 'acknowledgment', 'closure']) {
    const { state, admission, run } = currentHistoryFixture(); delete run.preflightRefusalRecoveries[0][field];
    admission.history = fullHistory(run); assert.throws(() => assertHistorical(state, admission));
  }
  const { state, admission, run } = currentHistoryFixture(); run.preflightRefusalRecoveries[0].status = 'prepared';
  admission.history = fullHistory(run); assert.throws(() => assertHistorical(state, admission));
});
test('historical failure checkpoints distinguish immutable, release-chain, extra history and current work', async () => {
  for (const checkpoint of ['history-primary-immutable', 'history-primary-release', 'history-extra-inspect', 'history-no-work']) {
    const { state, admission, run } = currentHistoryFixture();
    if (checkpoint === 'history-primary-immutable') run.threadId = 'foreign';
    if (checkpoint === 'history-primary-release') { delete run.preflightRefusalRecoveries[0].closure; admission.history = fullHistory(run); }
    if (checkpoint === 'history-extra-inspect') state.fz3bAgent.runs.push({ ...run, runId: 'foreign' });
    if (checkpoint === 'history-no-work') state.sessions[0].engineUncertain = true;
    const flow = new SoftwareFlow({ host: admission } as any, 'E:/synthetic'); flow.stage = 'launch'; flow.snapshot = async () => state;
    try { await flow.historical(); assert.fail('Expected historical qualification rejection'); }
    catch (error) { const failure = flow.failure(error); assert.equal(failure.checkpoint, checkpoint); assert.equal(failure.reason, 'ASSERTION'); assert.equal(JSON.stringify(failure).includes('foreign'), false); }
  }
});
test('known immutable unknown is preserved only with exact prior history and current production no-held gates', () => {
  const { state, admission, run } = currentHistoryFixture(); assert.equal(assertHistorical(state, admission), run); assertNoWork(state);
  assert.equal(run.operations[0].status, 'unknown');
  for (const change of [(v: any) => v.fz3bAgent.activeRunId = INCIDENT.runId, (v: any) => v.fz3bAgent.recoveryActions = { finishPreflightRefusal: true },
    (v: any) => v.hardware.reason = 'FZ3B held', (v: any) => v.fz3bAgent.runs[0].threadId = 'new-owner',
    (v: any) => v.fz3bAgent.runs[0].status = 'completed', (v: any) => v.fz3bAgent.runs[0].phase = 'completed',
    (v: any) => delete v.fz3bAgent.runs[0].preflightRefusalRecoveries[0].closure,
    (v: any) => v.fz3bAgent.runs.push({ ...run, runId: 'foreign' })]) { const v = clone(state); change(v); assert.throws(() => assertHistorical(v, admission)); }
});
test('new software unknown, uncertain sessions, foreign turns and cleanup uncertainty remain blocked', () => {
  for (const change of [(v: any) => v.sessions[0].engineUncertain = true, (v: any) => v.sessions[0].turnId = 'foreign',
    (v: any) => v.tasks = [{ id: 'foreign', operations: [{ status: 'unknown' }] }], (v: any) => v.tasks = [{ id: 'foreign', operations: [{ status: 'succeeded', cleanup: 'unconfirmed' }] }],
    (v: any) => v.hardwareAgent.runs.push({ active: true }), (v: any) => v.approvals.push({ id: 'old' })]) { const v = noWork(); change(v); assert.throws(() => assertNoWork(v)); }
});
test('prelaunch persisted session check does not repair or reconnect an uncertain/active owner', () => {
  const v = { schemaVersion: 1, sessions: [{ status: 'needs_attention', engineUncertain: false }] }; assertPersistedQuiet(v);
  for (const extra of [{ status: 'running' }, { status: 'stopping' }, { status: 'unknown' }, { status: 'inProgress' }, { turnId: 'foreign' }, { engineUncertain: true }, { engineUncertain: 'false' }]) assert.throws(() => assertPersistedQuiet({ schemaVersion: 1, sessions: [{ ...v.sessions[0], ...extra }] }));
});
test('new launch environment does not copy authentication overrides, Node hooks or injected runtime flags', () => {
  const env = launchEnvironment({ PATH: 'system', APPDATA: 'account', NODE_OPTIONS: '--require attacker', CODEX_HOME: 'foreign', TOKEN: 'PRIVATE', ELECTRON_RUN_AS_NODE: '1' }, 'fixed-data');
  assert.equal(env.PATH, 'system'); assert.equal(env.APPDATA, 'account'); assert.equal(env.FORGEDESK_DATA_DIR, 'fixed-data');
  for (const key of ['NODE_OPTIONS', 'CODEX_HOME', 'TOKEN', 'ELECTRON_RUN_AS_NODE']) assert.equal(env[key], undefined);
});
test('current captured package validator and installed adapter agree on the complete synthetic 1.0 contract', async () => {
  const source = await readStable(ROOT + '/scripts/release-package-audit.mjs');
  const audit = await import('data:text/javascript;base64,' + source.toString('base64'));
  const row = (path: string) => ({ path, bytes: 1, sha256: PIN });
  const resources = [row('resources/app.asar'), ...audit.RESOURCE_SPECS.map((spec: any) => row('resources/' + spec.to + (spec.single ? '' : '/' + (spec.manifest ?? spec.files[0].path))))];
  const codex = resources.find(p => p.path === 'resources/codex/manifest.json')!;
  codex.bytes = audit.CODEX_PACKAGED_MANIFEST_BYTES; codex.sha256 = audit.CODEX_PACKAGED_MANIFEST_SHA256;
  const value = releaseFixture(); value.sourceFreeze.auditSourceSha256 = sha(source);
  value.sourceFreeze.assetApproval = { ...audit.ASSET_APPROVAL };
  value.sourceFreeze.resourceManifestPins = audit.RESOURCE_SPECS.filter((s: any) => s.manifest).map((s: any) => ({ path: s.from + '/' + s.manifest, sha256: s.pin ?? PIN }));
  value.sourceFreeze.resourceTransforms = [{ path: codex.path, method: 'codex-public-source-only-v1', sourceSha256: value.sourceFreeze.resourceManifestPins.find((p: any) => p.path === 'vendor/codex/manifest.json').sha256, packagedSha256: codex.sha256 }];
  value.resources = resources; value.unpacked.files = [...audit.RUNTIME_FILES.map(row), ...resources]; value.bundles = audit.PACKAGED_FILES.filter((p: string) => p !== 'package.json').map(row);
  assert.equal(audit.validateReleaseManifest(value), value); assertReleaseShape(value);
  for (const change of [(v: any) => v.unpacked.files.pop(), (v: any) => v.bundles.pop(), (v: any) => v.sourceFreeze.resourceTransforms[0].packagedSha256 = NEXT]) {
    const v = clone(value); change(v); assert.throws(() => audit.validateReleaseManifest(v)); assert.throws(() => assertReleaseShape(v));
  }
});
test('real prepare acceptance ID template satisfies the release-1 plan contract without executing prepare', async () => {
  const raw = await readStable(ROOT + '/tests/release-1-software-smoke.ts');
  const source = ts.createSourceFile('release-1-software-smoke.ts', raw.toString(), ts.ScriptTarget.Latest, true);
  const expressions: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'plan' && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const p of node.initializer.properties) if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'acceptanceId') expressions.push(p.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.equal(expressions.length, 1);
  const acceptanceId = vm.runInNewContext('(' + expressions[0].getText(source) + ')', { Date: { now: () => 1792377600000 }, randomUUID: () => 'abcdef00-0000-4000-8000-000000000000' });
  assert.equal(acceptanceId, 'release-1-1792377600000-abcdef');
  assertPlan({ schemaVersion: 1, scope: 'release-1-root-phased-snapshot-v1', version: '1.0.0', acceptanceId, preparedAt: DATE,
    candidateSha256: PIN, manifestPath: 'synthetic-only', manifestSha256: PIN, release: { version: '1.0.0', candidateSha256: PIN }, host: currentHistoryFixture().admission });
});
test('direct TS capture, prepare and observe reject without the before-import bootstrap', async () => {
  for (const mode of ['--capture-manifest', '--prepare-only', '--observe']) await assert.rejects(main([mode]), /externally SHA-verified builtins-only/);
});

test('approved actual Codex resource size is accepted only as its exact path size and body hash tuple', async () => {
  const value = releaseFixture(), row = value.resources.find((p: any) => p.path === 'resources/codex/codex.exe');
  row.bytes = 334121776; row.sha256 = 'e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e';
  assertReleaseShape(value);
  for (const change of [(p: any) => p.path = 'resources/foreign.exe', (p: any) => p.bytes++, (p: any) => p.sha256 = PIN]) {
    const v = clone(value), changed = v.resources.find((p: any) => p.path === row.path); change(changed);
    assert.throws(() => assertReleaseShape(v));
  }
  const f = streamFixture(Buffer.alloc(0), APPROVED_LARGE_CODEX.bytes); f.openError = Error('CONTROLLED_LARGE_BODY_NOT_READ');
  await assert.rejects(hashStable(f.file, { ...APPROVED_LARGE_CODEX }, f.io), /CONTROLLED_LARGE_BODY_NOT_READ/); assert.equal(f.opens, 1); assert.equal(f.reads, 0);
  for (const change of [(p: any) => p.path = 'resources/foreign.exe', (p: any) => p.bytes++, (p: any) => p.sha256 = PIN]) { const p = { ...APPROVED_LARGE_CODEX }; change(p); assert.throws(() => assertFilePin(p)); }
});

function streamFixture(body: Buffer, size = body.length) {
  const file = ROOT + '/install/resources/synthetic.bin';
  const f = { file, opens: 0, reads: 0, closes: 0, maximumBuffer: 0, offset: 0, openError: undefined as Error | undefined, closeError: false, changed: false, grow: false,
    io: undefined as any };
  const stat = (leaf: boolean) => ({ dev: 1, ino: leaf ? 2 : 1, nlink: 1, size: leaf ? size : 0, ctimeMs: f.changed ? 2 : 1, mtimeMs: 1, isFile: () => leaf, isSymbolicLink: () => false });
  f.io = { lstat: async (named: string) => stat(named.replaceAll('\\', '/').toLowerCase() === file.replaceAll('\\', '/').toLowerCase()), open: async () => {
    f.opens++; if (f.openError) throw f.openError;
    return { stat: async () => stat(true), read: async (buffer: Buffer, start: number, count: number) => { f.reads++; f.maximumBuffer = Math.max(f.maximumBuffer, buffer.length); const raw = f.grow ? Buffer.concat([body, Buffer.from('!')]) : body; const n = Math.min(count, raw.length - f.offset); raw.copy(buffer, start, f.offset, f.offset + n); f.offset += n; return { bytesRead: n }; }, close: async () => { f.closes++; if (f.closeError) throw Error('CLOSE_UNKNOWN'); } };
  } };
  return f;
}
test('exact-row hashing streams bounded chunks and retains EOF identity digest and close refusals', async () => {
  const body = Buffer.alloc(200000, 7), row = { path: 'resources/synthetic.bin', bytes: body.length, sha256: sha(body) }, f = streamFixture(body);
  assert.deepEqual(await hashStable(f.file, row, f.io), row); assert.ok(f.maximumBuffer <= 65536); assert.ok(f.reads > 2); assert.equal(f.closes, 1);
  for (const mode of ['size', 'hash', 'growth', 'close'] as const) {
    const g = streamFixture(body, mode === 'size' ? body.length + 1 : body.length); if (mode === 'growth') g.grow = true; if (mode === 'close') g.closeError = true;
    await assert.rejects(hashStable(g.file, { ...row, ...(mode === 'hash' ? { sha256: PIN } : {}) }, g.io));
    if (mode === 'size') assert.equal(g.opens, 0); else assert.equal(g.closes, 1);
  }
  const g = streamFixture(body); await assert.rejects(hashStable(g.file, row, g.io, { dev: 1, ino: 999, nlink: 1, size: body.length, ctimeMs: 1, mtimeMs: 1 } as any)); assert.equal(g.opens, 0);
});
test('installer hashing uses its externally pinned exact row independently of resource exceptions', async () => {
  const value = releaseFixture(); value.artifacts[0].bytes = 300 * 1024 * 1024; assertReleaseShape(value);
  for (const p of [{ ...value.artifacts[0], path: 'release/other.exe' }, { ...value.artifacts[0], bytes: 512 * 1024 * 1024 + 1 }, { ...value.artifacts[0], bytes: 0 }]) assert.throws(() => assertInstallerPin(p));
  assert.throws(() => assertFilePin({ path: 'resources/arbitrary.exe', bytes: 300 * 1024 * 1024, sha256: PIN }));
  const f = streamFixture(Buffer.from('tiny')); await assert.rejects(hashStable(f.file, value.artifacts[0], f.io)); assert.equal(f.opens, 0);
});
test('real nested ASAR bytes use native API separators without changing canonical release inventory paths', async () => {
  const base = path.join(ROOT, OUTPUT, 'asar-path-fixtures'); await mkdir(base, { recursive: true }); const directory = await mkdtemp(path.join(base, 'binding-'));
  const sourceRoot = path.join(directory, 'source'), archive = path.join(directory, 'fixture.asar'), canonical = 'dist/main/index.cjs', content = 'release fixture only; never executed\n';
  await mkdir(path.join(sourceRoot, 'dist/main'), { recursive: true }); await writeFile(path.join(sourceRoot, canonical), content, { flag: 'wx' }); await createPackage(sourceRoot, archive);
  if (process.platform === 'win32') assert.throws(() => extractFile(archive, canonical), /not found/);
  const raw = await readStable(path.join(ROOT, 'tests/helpers/release-1-binding.ts')), source = ts.createSourceFile('binding.ts', raw.toString(), ts.ScriptTarget.Latest, true), calls: ts.CallExpression[] = [];
  const collect = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'extractFile' && node.arguments.length === 2 && !ts.isStringLiteral(node.arguments[1])) calls.push(node); ts.forEachChild(node, collect); };
  for (const node of source.statements) if (ts.isFunctionDeclaration(node) && node.name?.text === 'verifyRelease') collect(node);
  assert.equal(calls.length, 1); const row = { path: canonical, bytes: Buffer.byteLength(content), sha256: sha(content) };
  const captured = vm.runInNewContext(calls[0].getText(source), { extractFile, archive, p: row, path });
  assert.equal(Buffer.from(captured).toString(), content); assert.deepEqual(row, { path: 'dist/main/index.cjs', bytes: Buffer.byteLength(content), sha256: sha(content) });
});
