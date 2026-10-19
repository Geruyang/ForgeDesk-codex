import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { AppSnapshot, Approval, Session } from '../../packages/shared/contracts';
import { CONTROL_PHASES, CONTROLS_ENTRIES, CONTROLS_DIAGNOSTICS_ARTIFACT, assertControlsDiagnosticsTargetAbsent, ControlsGate, assertControlsHarness, assertFreshRefusal, assertOwnedWaitProcess,
  assertRefusalComplete, assertReleaseDiagnostics, assertRestartSessions, assertControlsSessionBinding, selectControlsProject, selectControlsSession, sanitizeControlsFailure, controlsStandardEnvironment, CONTROLS_CHILD_PATH, controlsExecutionItems, assertControlsStopItems, controlsNativeEvidence, controlsClosure, type WaitProcess } from './release-1-controls';
import { assertStopObservationTiming, assertWaitCommand } from './second-user-controls';
import { assertControlsStopReceipt } from './controls-stop-observer';
import { assertAcceptanceUnchanged, assertMissingGitResult, assertMissingNodeResult, missingToolsAppEnvironment } from './second-user-missing-tools';
import { armControlsBoundary, installControlsBoundary, readControlsBoundary } from './release-1-controls-observer';
import { writeNew, readStable, sha } from './release-1-files';

const pin = 'a'.repeat(64), nextPin = 'b'.repeat(64), requestKey = 'qa-request', reasoningId = 'rs_' + 'a'.repeat(48);
test('every literal run artifact and diagnostics export is disjoint from all reserved phase records', async () => {
  const ts = (await import('typescript')).default;
  const source = await readFile(new URL('../release-1-controls-smoke.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('controls.ts', source, ts.ScriptTarget.Latest, true), names: string[] = [];
  const reserved = new Set(['plan.json', 'held.json', ...[...CONTROL_PHASES, 'connect', 'leave-mode', 'restart-leave', 'missing-leave'].flatMap(phase => [`${phase}.json`, `${phase}.pending.json`])]);
  const visit = (node: import('typescript').Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'path.join' && node.arguments[0]?.getText(parsed) === 'output' && node.arguments.length === 2) {
      const leaf = node.arguments[1];
      if (ts.isStringLiteral(leaf) && !['plan.json', 'held.json'].includes(leaf.text)) names.push(leaf.text);
      if (ts.isIdentifier(leaf) && leaf.text === 'CONTROLS_DIAGNOSTICS_ARTIFACT') names.push(CONTROLS_DIAGNOSTICS_ARTIFACT);
    }
    ts.forEachChild(node, visit);
  }; visit(parsed);
  assert.ok(names.includes(CONTROLS_DIAGNOSTICS_ARTIFACT)); assert.ok(names.includes('stop-native-sample.json'));
  assert.equal(CONTROLS_DIAGNOSTICS_ARTIFACT, 'diagnostics-export.json');
  for (const name of names) assert.equal(reserved.has(name), false, name);
});
test('diagnostics export and receipt coexist while actual EEXIST stays closed and cannot overwrite either record', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'controls-diagnostics-names-'));
  try {
    const record = path.join(directory, 'old-diagnostics.json'); await writeNew(record, { original: true });
    await assert.rejects(writeNew(record, { overwritten: true }), (error: any) => {
      assert.deepEqual(sanitizeControlsFailure(error, 'phase-record-write'), { reason: 'FILE_EXISTS', checkpoint: 'phase-record-write', cause: 'none' }); return true;
    });
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), { original: true });
    assert.equal(await assertControlsDiagnosticsTargetAbsent(directory), path.join(directory, CONTROLS_DIAGNOSTICS_ARTIFACT));
    await writeNew(path.join(directory, CONTROLS_DIAGNOSTICS_ARTIFACT), { productArtifact: true });
    await assert.rejects(assertControlsDiagnosticsTargetAbsent(directory), (error: any) => error.code === 'EEXIST');
    await writeNew(path.join(directory, 'diagnostics.json'), { phaseReceipt: true });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, CONTROLS_DIAGNOSTICS_ARTIFACT), 'utf8')), { productArtifact: true });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'diagnostics.json'), 'utf8')), { phaseReceipt: true });
    assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), { original: true });
    assert.deepEqual(sanitizeControlsFailure(Object.assign(Error('PRIVATE_PATH'), { code: 'EEXIST', path: 'PRIVATE_PATH' }), 'diagnostics-export'), { reason: 'FILE_EXISTS', checkpoint: 'diagnostics-export', cause: 'none' });
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true }); }
});
test('real diagnostics phase and receipt AST write separate artifacts and hold without overwrite on receipt EEXIST', async () => {
  const ts = (await import('typescript')).default, { plainPath } = await import('./embedded-installed');
  const source = await readFile(new URL('../release-1-controls-smoke.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('controls.ts', source, ts.ScriptTarget.Latest, true);
  let phaseNode: import('typescript').FunctionDeclaration | undefined, receiptNode: import('typescript').ArrowFunction | undefined;
  const visit = (node: import('typescript').Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'phaseAction') phaseNode = node;
    if (ts.isArrowFunction(node) && node.body.getText(parsed).includes('const facts = await phaseAction(phase)') && node.body.getText(parsed).startsWith('{\n      await effect')) receiptNode = node;
    ts.forEachChild(node, visit);
  }; visit(parsed); assert.ok(phaseNode && receiptNode);
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'controls-real-diagnostics-phase-'));
  try {
    for (const collision of [false, true]) {
      const output = path.join(directory, String(collision)), workspace = path.join(output, 'workspace'); await mkdir(workspace, { recursive: true });
      const id = 'release-1-controls-1792441609558-2bb7dd', record = path.join(output, 'diagnostics.json'), original = '{"unchanged":true}\n';
      if (collision) await writeFile(record, original);
      const gate = new ControlsGate(pin);
      for (const phase of CONTROL_PHASES.slice(0, CONTROL_PHASES.indexOf('diagnostics'))) { gate.arm(`${phase} ${gate.predecessor}`); gate.complete(phase, nextPin); }
      gate.arm(`diagnostics ${gate.predecessor}`); const calls: string[] = [];
      const dialog: any = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: '' }) };
      const context: any = { assert, path, output, workspace, plan: { id, candidateSha256: pin }, planSha: pin, phase: 'diagnostics', prior: gate.predecessor, startedAt: new Date().toISOString(),
        checkpoint: 'none', gate, controlled: false, errors: [], CONTROLS_DIAGNOSTICS_ARTIFACT, assertControlsDiagnosticsTargetAbsent, plainPath, readStable, sha, writeNew, assertReleaseDiagnostics,
        live() {}, effect: async (action: () => Promise<unknown>) => action(), verifyPlan: async () => {}, snapshot: async () => ({}), assertNoWork() {}, boundary: async () => ({}),
        console: { log() {} }, app: { evaluate: async (fn: any, arg: unknown) => fn({ dialog }, arg) } };
      context.invoke = async (method: string) => {
        calls.push(method);
        if (method === 'importProject') { await dialog.showOpenDialog(); throw Error('Synthetic expected import rejection'); }
        assert.equal(method, 'exportDiagnostics'); const selected = await dialog.showSaveDialog(); if (!selected.filePath) return null;
        await writeFile(selected.filePath, JSON.stringify({ schemaVersion: 1, version: '1.0.0', engineState: 'ready', engineError: '', platform: 'win32', arch: 'x64', diagnostics: [`qa-diagnostic-${id} password=[redacted]`] })); return selected.filePath;
      };
      vm.createContext(context); vm.runInContext('errors = [];\n' + compile(phaseNode.getText(parsed)), context);
      const run = vm.runInContext(compile('const receipt = ' + receiptNode.getText(parsed) + ';receipt;'), context);
      let failure: ReturnType<typeof sanitizeControlsFailure> | undefined;
      await run().catch((error: unknown) => { if (!collision) throw error; gate.fail(); failure = sanitizeControlsFailure(error, context.checkpoint); });
      assert.deepEqual(calls, ['importProject', 'exportDiagnostics', 'exportDiagnostics']);
      assert.equal(JSON.parse(await readFile(path.join(output, CONTROLS_DIAGNOSTICS_ARTIFACT), 'utf8')).version, '1.0.0');
      if (collision) { assert.equal(await readFile(record, 'utf8'), original); assert.equal(gate.held, true); assert.equal(gate.next, 'diagnostics'); assert.deepEqual(failure, { reason: 'FILE_EXISTS', checkpoint: 'phase-record-write', cause: 'none' }); }
      else { const receipt = JSON.parse(await readFile(record, 'utf8')); assert.equal(receipt.scope, 'release-1-controls-phase-v1'); assert.equal(receipt.result, 'passed'); assert.equal(gate.next, 'close-a'); assert.equal(gate.held, false); }
    }
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true }); }
});
test('standard controls PATH is fixed child-only and never inherits cached PowerShell or alters missing-tools PATH', () => {
  const parent = { PATH: 'C:/unapproved/pwsh;C:/Users/qa/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell', Path: 'mixed', SYSTEMROOT: 'C:/Windows' };
  const child = controlsStandardEnvironment(parent);
  assert.deepEqual(child, { SYSTEMROOT: 'C:/Windows', PATH: 'C:/Windows/System32/WindowsPowerShell/v1.0;C:/Windows/System32;C:/Windows;C:/Program Files/nodejs;C:/Program Files/Git/mingw64/libexec/git-core' });
  assert.equal(child.PATH, CONTROLS_CHILD_PATH); assert.equal(parent.Path, 'mixed'); assert.ok(parent.PATH.includes('.cache'));
  assert.equal(missingToolsAppEnvironment(child, 'E:/empty', 'E:/data').PATH, 'E:/empty');
});
test('only completed ID-bound reasoning with the actual adapter string-array schema is nonexecuting', () => {
  const reasoning = { id: reasoningId, role: 'tool', status: 'completed', text: JSON.stringify({ type: 'reasoning', id: reasoningId, summary: ['summary'], content: [] }) };
  const session = { messages: [reasoning] } as Session;
  assert.deepEqual(controlsExecutionItems(session), []);
  for (const item of [{ type: 'reasoning', id: 'wrong', summary: [], content: [] }, { type: 'reasoning', id: reasoningId, summary: [], content: [], command: 'hidden' }, { type: 'reasoning', id: reasoningId, summary: [{ type: 'commandExecution' }], content: [] }, { type: 'reasoning', id: reasoningId, summary: [], content: 'text' }]) assert.throws(() => controlsExecutionItems({ ...session, messages: [{ ...reasoning, text: JSON.stringify(item) }] } as Session));
  assert.throws(() => controlsExecutionItems({ messages: [{ ...reasoning, id: 'exec-123', text: JSON.stringify({ type: 'reasoning', id: 'exec-123', summary: [], content: [] }) }] } as Session));
  assert.throws(() => controlsExecutionItems({ ...session, messages: [{ ...reasoning, status: 'running' }] } as Session));
  assert.throws(() => controlsExecutionItems({ ...session, messages: [reasoning, reasoning] } as Session));
});
test('Stop preserves exactly one harmless shell execution while rejecting unknown or duplicate execution items', () => {
  const marker = 'qa-controls-wait-snapshot-1792440121109';
  const shell = { id: 'shell', role: 'tool', status: 'completed', text: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Write-Output '${marker}'; Start-Sleep -Seconds 45"${marker}\r\n` };
  const reasoning = { id: reasoningId, role: 'tool', status: 'completed', text: JSON.stringify({ type: 'reasoning', id: reasoningId, summary: [], content: [] }) };
  const session = { messages: [shell, reasoning] } as Session;
  assert.equal(assertControlsStopItems(session, marker).id, 'shell');
  for (const messages of [[shell, { ...shell, id: 'second' }, reasoning], [reasoning], [{ ...shell, text: JSON.stringify({ type: 'webSearch', marker }) }, reasoning], [{ ...shell, text: shell.text.replace('Start-Sleep', 'Get-Content secret; Start-Sleep') }, reasoning]]) assert.throws(() => assertControlsStopItems({ messages } as Session, marker));
});
test('MCP refusal ignores only proven reasoning and retains every exact protocol refusal check', () => {
  const { state, session } = fixture(); state.approvals = []; session.status = 'completed'; delete session.turnId;
  const item = { type: 'mcpToolCall', server: 'engineering', tool: 'engineering.test', arguments: { taskId: 'task', verifierId: 'qa-controls-verifier', requestKey }, status: 'failed', error: { message: 'user rejected MCP tool call' }, result: null };
  const tool = { id: 'tool', role: 'tool', text: JSON.stringify(item), status: 'completed' };
  session.messages = [tool, { id: reasoningId, role: 'tool', status: 'completed', text: JSON.stringify({ type: 'reasoning', id: reasoningId, summary: [], content: [] }) }] as any;
  assert.deepEqual(assertRefusalComplete(state, session.id, requestKey), item);
  session.messages.push({ ...tool, id: 'retry' } as any); assert.throws(() => assertRefusalComplete(state, session.id, requestKey)); session.messages.pop();
  session.messages[0].text = JSON.stringify({ ...item, error: { message: 'cancelled' } }); assert.throws(() => assertRefusalComplete(state, session.id, requestKey));
  session.messages[0].text = JSON.stringify({ type: 'unknown', requestKey }); assert.throws(() => assertRefusalComplete(state, session.id, requestKey));
});
test('pre-validation native evidence is bounded and never exposes command lines unapproved paths or SID payloads', () => {
  const process = { id: 9, parentId: 8, created: '2026-10-20T00:00:00Z', root: true, sid: 'PRIVATE_SID', sessionId: 2, ownerQueryStatus: 0, execPath: 'C:/PRIVATE_PATH/pwsh.exe', commandLine: 'PRIVATE_COMMAND' } as WaitProcess;
  const installed = path.resolve('E:/qa/ForgeDesk.exe');
  const evidence = controlsNativeEvidence({ processes: Array(130).fill(process), ancestry: [process], sampledAt: '2026-10-20T00:00:01Z' }, { installed, main: process, ancestry: [process], sampledAt: '2026-10-20T00:00:01Z' }, 'qa-controls-wait-snapshot-123', 'PRIVATE_SID', 2);
  assert.equal(evidence.processCount, 130); assert.equal(evidence.processes.length, 128); assert.equal(evidence.processes[0].executable, 'unapproved'); assert.equal(evidence.processes[0].exactWaitCommand, false); assert.equal(evidence.processes[0].ownerMatches, true);
  assert.equal(JSON.stringify(evidence).includes('PRIVATE'), false);
});
test('Stop diagnostics distinguish each fixed native and UI stage without disclosing arbitrary causes', async () => {
  const stages = ['stop-arm', 'stop-observer-install', 'stop-send', 'stop-running-state', 'stop-native-sample', 'stop-native-evidence', 'stop-native-ownership', 'stop-command', 'stop-preclick-timing', 'stop-click', 'stop-disappearance', 'stop-interrupt-receipt', 'stop-terminal-state', 'stop-execution-items', 'stop-observer-restore'];
  for (const stage of stages) assert.deepEqual(sanitizeControlsFailure(Object.assign(Error('PRIVATE'), { code: 'ERR_ASSERTION' }), stage), { reason: 'ASSERTION', checkpoint: stage, cause: 'none' });
  const source = await readFile(new URL('../release-1-controls-smoke.ts', import.meta.url), 'utf8');
  assert.ok(source.indexOf("'stop-native-sample.json'") < source.indexOf('const native = assertOwnedWaitProcess'));
  assert.ok(source.indexOf("checkpoint = 'stop-command'") < source.indexOf("checkpoint = 'stop-click'"));
  assert.match(source, /if \(observation\) checkpoint = observation/);
});
test('real adapter projection preserves command prefixes and MCP types so execution output cannot masquerade as reasoning', async () => {
  const ts = (await import('typescript')).default;
  const source = await readFile(new URL('../../apps/desktop/main/index.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const node = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'onEngineEvent'); assert.ok(node);
  const session = { threadId: 'fixture-thread', messages: [] } as unknown as Session;
  const compiled = ts.transpileModule(node.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const onEvent = vm.runInNewContext(compiled + ';onEngineEvent', { store: { sessions: [session], appendEvent() {} }, sanitize: (v: unknown) => v, asRecord: (v: unknown) => v, save() {}, publish() {} });
  const event = (method: string, item: any, more: any = {}) => onEvent({ generation: 1, sequence: 1, method, params: { threadId: session.threadId, item, ...more } });
  const command = { id: 'exec-fixture', type: 'commandExecution', command: 'powershell.exe -Command "Write-Output harmless"', status: 'inProgress' };
  const reason = { id: reasoningId, type: 'reasoning', summary: [], content: [] };
  event('item/started', command); event('item/commandExecution/outputDelta', undefined, { itemId: command.id, delta: JSON.stringify({ ...reason, id: command.id }) }); event('item/completed', { ...command, status: 'completed' });
  event('item/completed', reason); event('item/completed', { id: 'mcp-fixture', type: 'mcpToolCall', status: 'failed' });
  assert.ok(session.messages[0].text.startsWith(command.command)); assert.equal(JSON.parse(session.messages[1].text).type, 'reasoning'); assert.equal(JSON.parse(session.messages[2].text).type, 'mcpToolCall');
  assert.deepEqual(controlsExecutionItems(session).map(item => item.id), ['exec-fixture', 'mcp-fixture']);
});
test('real Stop wait loop reports its waiting stage but preserves a failing snapshot no-work checkpoint', async () => {
  const ts = (await import('typescript')).default;
  const source = await readFile(new URL('../release-1-controls-smoke.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('controls.ts', source, ts.ScriptTarget.Latest, true); let found: import('typescript').FunctionDeclaration | undefined;
  const visit = (node: import('typescript').Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'waitFor') found = node; ts.forEachChild(node, visit); }; visit(parsed); assert.ok(found);
  const compiled = ts.transpileModule(found.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  for (const failSnapshot of [false, true]) {
    let now = 0; const context: any = { checkpoint: 'none', Date: { now: () => now }, pause: async () => { now += 10; } };
    context.snapshot = async () => { context.checkpoint = 'no-work'; if (failSnapshot) throw Object.assign(Error('private snapshot'), { code: 'ERR_ASSERTION' }); return {}; };
    const wait = vm.runInNewContext(compiled + ';waitFor', context);
    await assert.rejects(wait(() => false, 1, 'stop-running-state'));
    assert.equal(context.checkpoint, failSnapshot ? 'no-work' : 'stop-running-state');
  }
});
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
  assert.throws(() => assertOwnedWaitProcess([{ ...process, name: 'pwsh.exe', execPath: 'C:/Users/qa/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe' }], marker, 'primary', 1, proof));
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
