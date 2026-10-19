import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const journal = process.env.FORGEDESK_OFFLINE_JOURNAL;
if (!journal || !process.env.CODEX_HOME) throw new Error('Offline fixture journal and private home are required');
const record = value => appendFileSync(journal, JSON.stringify({ at: new Date().toISOString(), fakeServerPid: process.pid, ...value }) + '\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => emit({ id, result });
const event = (method, params) => emit({ method, params });
const threads = new Map();
const pending = new Map();
const rpcKey = id => `${typeof id}:${id}`;
const config = { approval_policy: 'on-request', approvals_reviewer: 'user', sandbox_mode: 'workspace-write',
  sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } };
record({ kind: 'fixture-start', noModel: true, accountSource: 'synthetic fixture response, no authentication read' });

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (!message.method) {
    const call = pending.get(rpcKey(message.id));
    record({ kind: 'client-response', id: message.id, result: message.result, error: message.error });
    if (!call) throw new Error('Unexpected fixture response ID');
    pending.delete(rpcKey(message.id));
    if (call.kind === 'shell') {
      if (!message.result || Object.keys(message.result).length !== 1 || message.result.decision !== call.expectedDecision) throw new Error('Fixture requires the exact scalar shell decision');
      record({ kind: 'shell-decision-received', id: message.id, threadId: call.threadId, turnId: call.turnId, decision: message.result.decision, marker: call.marker });
      if (message.result.decision === 'cancel') {
        const item = { ...call.item, status: 'declined', processId: null, aggregatedOutput: '', exitCode: null, durationMs: null };
        record({ kind: 'shell-command-cancelled', threadId: call.threadId, turnId: call.turnId, itemId: item.id, marker: call.marker, commandStarted: false });
        event('item/completed', { threadId: call.threadId, turnId: call.turnId, item });
        event('turn/completed', { threadId: call.threadId, turn: { id: call.turnId, status: 'interrupted' } });
        return;
      }
      const startedAt = Date.now();
      const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', call.command], {
        cwd: threads.get(call.threadId).cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
      record({ kind: 'shell-command-started', threadId: call.threadId, turnId: call.turnId, itemId: call.item.id,
        childPid: child.pid, marker: call.marker, command: call.command, approvalId: message.id });
      let stdout = ''; let stderr = ''; let spawnError; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10000);
      child.stdout.on('data', data => {
        stdout += data.toString();
        event('item/commandExecution/outputDelta', { threadId: call.threadId, turnId: call.turnId, itemId: call.item.id, delta: data.toString() });
      });
      child.stderr.on('data', data => { stderr += data.toString(); });
      child.on('error', error => { spawnError = error.code; });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        const item = { ...call.item, status: exitCode === 0 && !timedOut && !spawnError ? 'completed' : 'failed', processId: String(child.pid),
          aggregatedOutput: stdout, exitCode, durationMs: Date.now() - startedAt };
        record({ kind: 'shell-command-completed', threadId: call.threadId, turnId: call.turnId, itemId: item.id,
          childPid: child.pid, marker: call.marker, stdout, stderr, exitCode, signal, timedOut, spawnError });
        event('item/completed', { threadId: call.threadId, turnId: call.turnId, item });
        event('turn/completed', { threadId: call.threadId, turn: { id: call.turnId, status: item.status === 'completed' ? 'completed' : 'failed' } });
      });
      return;
    }
    if (message.result?.action !== 'decline' || message.result.content !== null || message.result._meta !== null) throw new Error('Fixture requires the exact real decline response');
    const item = { ...call.item, status: 'failed', result: null, error: { message: 'user rejected MCP tool call' } };
    record({ kind: 'mcp-refused', threadId: call.threadId, turnId: call.turnId, requestKey: item.arguments.requestKey, invokedRunner: false });
    event('item/completed', { threadId: call.threadId, turnId: call.turnId, item });
    event('turn/completed', { threadId: call.threadId, turn: { id: call.turnId, status: 'completed' } });
    return;
  }
  record({ kind: 'request', id: message.id, method: message.method, threadId: message.params?.threadId, turnId: message.params?.turnId });
  const params = message.params ?? {};
  if (message.method === 'initialized') return;
  if (message.method === 'initialize') return reply(message.id, { codexHome: process.env.CODEX_HOME, userAgent: 'forgedesktop/0.162.0-alpha.17.2 (offline fixture)' });
  if (message.method === 'config/read') return reply(message.id, { config });
  if (message.method === 'configRequirements/read') return reply(message.id, { requirements: null });
  if (message.method === 'windowsSandbox/readiness') return reply(message.id, { status: 'ready' });
  if (message.method === 'account/read') {
    const controlFile = journal + '.controls.json';
    const control = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};
    if (control.phase === 'hold-stop-reconnect-account' && control.released !== true) {
      record({ kind: 'held-stop-account-read' });
      const timer = setInterval(() => {
        const next = JSON.parse(readFileSync(controlFile, 'utf8'));
        if (next.phase === 'hold-stop-reconnect-account' && next.released === true) {
          clearInterval(timer); record({ kind: 'released-stop-account-read' });
          reply(message.id, { account: { type: 'chatgpt', email: 'OFFLINE-FIXTURE-NOT-A-LOGIN@example.invalid' }, requiresOpenaiAuth: false });
        }
      }, 20);
      return;
    }
    if (control.phase === 'explicit-startup-routing-probe' && control.remaining > 0) {
      control.remaining--; writeFileSync(controlFile, JSON.stringify(control));
      record({ kind: 'injected-account-routing-timeout', phase: control.phase, remaining: control.remaining });
      return emit({ id: message.id, error: { code: -32000, message: 'workspace routing discovery timed out' } });
    }
    return reply(message.id, { account: { type: 'chatgpt', email: 'OFFLINE-FIXTURE-NOT-A-LOGIN@example.invalid' }, requiresOpenaiAuth: false });
  }
  if (message.method === 'model/list') return reply(message.id, { data: [{ id: 'offline-fixture-not-a-model', displayName: 'Offline Protocol Fixture' }] });
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    const id = message.method === 'thread/resume' ? params.threadId : randomUUID();
    threads.set(id, { cwd: params.cwd });
    return reply(message.id, { thread: { id, turns: [] }, cwd: params.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: { type: 'workspaceWrite', writableRoots: [params.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
  }
  if (message.method === 'turn/start') {
    if (!threads.has(params.threadId)) throw new Error('Unknown fixture thread');
    const control = JSON.parse(params.input[0].text);
    const threadId = params.threadId; const turnId = randomUUID();
    threads.get(threadId).turnId = turnId;
    reply(message.id, { turn: { id: turnId, status: 'inProgress' } });
    event('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    if (control.kind === 'wait') {
      if (!/^qa-controls-wait-snapshot-\d+$/.test(control.marker)) throw new Error('Invalid fixture wait marker');
      const command = `Write-Output '${control.marker}'; Start-Sleep -Seconds 45`;
      const child = spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd: threads.get(threadId).cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
      const itemId = randomUUID();
      record({ kind: 'wait-started', threadId, turnId, childPid: child.pid, marker: control.marker, command });
      event('item/started', { threadId, turnId, item: { id: itemId, type: 'commandExecution', command, status: 'inProgress' } });
      child.stdout.on('data', data => event('item/commandExecution/outputDelta', { threadId, turnId, itemId, delta: data.toString() }));
      child.stderr.on('data', data => record({ kind: 'fixture-wait-stderr', text: data.toString().slice(0, 2048) }));
      child.on('error', error => { record({ kind: 'fixture-wait-error', code: error.code }); process.exitCode = 1; });
      child.on('close', (code, signal) => {
        record({ kind: 'wait-natural-close', childPid: child.pid, code, signal });
        event('item/completed', { threadId, turnId, item: { id: itemId, type: 'commandExecution', command, status: 'completed' } });
        event('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
      });
      return;
    }
    if (control.kind === 'mcp-refusal') {
      if (typeof control.taskId !== 'string' || typeof control.requestKey !== 'string') throw new Error('Invalid fixture MCP binding');
      const item = { id: randomUUID(), type: 'mcpToolCall', server: 'engineering', tool: 'engineering.test', status: 'inProgress',
        arguments: { taskId: control.taskId, verifierId: 'qa-controls-verifier', requestKey: control.requestKey }, result: null, error: null };
      event('item/started', { threadId, turnId, item });
      pending.set(rpcKey(0), { threadId, turnId, item });
      emit({ id: 0, method: 'mcpServer/elicitation/request', params: { threadId, turnId, serverName: 'engineering', mode: 'form',
        message: 'Allow the engineering MCP server to run tool "engineering.test"?', requestedSchema: { type: 'object', properties: {} },
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: item.arguments } } });
      return;
    }
    if (control.kind === 'shell-accept' || control.kind === 'shell-cancel') {
      const decision = control.kind === 'shell-accept' ? 'accept' : 'cancel';
      if (!new RegExp(`^qa-controls-shell-${decision}-snapshot-\\d+$`).test(control.marker)) throw new Error('Invalid fixture shell marker');
      const command = `Write-Output '${control.marker}'`;
      const approvalId = decision === 'accept' ? 7 : '7';
      const item = { id: randomUUID(), type: 'commandExecution', command, cwd: threads.get(threadId).cwd,
        processId: null, status: 'inProgress', aggregatedOutput: '', exitCode: null, durationMs: null };
      const approval = { threadId, turnId, itemId: item.id, command, cwd: item.cwd, availableDecisions: ['accept', 'cancel'] };
      pending.set(rpcKey(approvalId), { kind: 'shell', threadId, turnId, item, command, marker: control.marker, expectedDecision: decision });
      record({ kind: 'shell-approval-requested', id: approvalId, threadId, turnId, itemId: item.id, marker: control.marker, commandStarted: false });
      event('item/started', { threadId, turnId, item });
      emit({ id: approvalId, method: 'item/commandExecution/requestApproval', params: approval });
      return;
    }
    throw new Error('Unsupported offline turn scenario');
  }
  if (message.method === 'turn/interrupt') {
    const thread = threads.get(params.threadId);
    if (!thread || thread.turnId !== params.turnId) throw new Error('Fixture interrupt binding mismatch');
    reply(message.id, {});
    // Production main must still stop the owning Job Object after this protocol acknowledgement.
    record({ kind: 'interrupt-acknowledged', threadId: params.threadId, turnId: params.turnId, fixtureManuallyKilledWait: false });
    event('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
    return;
  }
  emit({ id: message.id, error: { code: -32601, message: 'Unsupported offline fixture method' } });
}).on('close', () => process.exit(0));
