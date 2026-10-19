import assert from 'node:assert/strict';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { release, version } from 'node:os';
import { redact } from '../packages/engineering-runner/redaction';
import type { AppSnapshot, Session, TaskView } from '../packages/shared/contracts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `live-${Date.now()}`;
const dataDir = path.join(root, '.runtime/app');
const fixtureRoot = path.join(root, '.runtime/live-model');
const workspace = process.env.FORGEDESK_LIVE_WORKSPACE ? path.resolve(process.env.FORGEDESK_LIVE_WORKSPACE) : path.join(fixtureRoot, runId, 'workspace');
const verifier = path.join(root, 'engineering/fixtures/software/verifiers/verify-numbers.mjs');
const output = path.join(root, 'output/playwright/live-model', runId);
const development = process.env.FORGEDESK_LIVE_DEVELOPMENT === '1';
const executable = development ? path.join(root, 'node_modules/electron/dist/electron.exe') : path.join(root, 'install/ForgeDesk.exe');
const execute = promisify(execFile);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function fileDigest(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const report: Record<string, any> = { runId, phase: process.env.FORGEDESK_LIVE_PHASE || 'repair', scope: `${development ? 'Development' : 'Installed'} real model; no hardware`,
  startedAt: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, release: release(), version: version() },
  workspace, steps: [], failures: [], pageErrors: [] };
let application: ElectronApplication | undefined;
let page: Page | undefined;
let qaSessionId: string | undefined;
const answeredApprovals = new Set<string>();
async function allowStoredVerifier(state: AppSnapshot) {
  const session = state.sessions.find(item => item.id === qaSessionId);
  for (const approval of state.approvals) {
    const key = `${approval.generation}:${typeof approval.id}:${approval.id}`;
    if (answeredApprovals.has(key)) continue;
    const params = approval.params as Record<string, any>;
    const args = params?._meta?.tool_params;
    const schema = params?.requestedSchema;
    const allowed = approval.method === 'mcpServer/elicitation/request' && params.serverName === 'engineering' && params.mode === 'form' &&
      params._meta?.codex_approval_kind === 'mcp_tool_call' && schema?.type === 'object' &&
      Object.keys(schema.properties ?? {}).length === 0 && params.threadId === session?.threadId && params.turnId === session?.turnId &&
      args?.taskId === session?.taskId && args?.verifierId === 'numbers' && typeof args?.requestKey === 'string' &&
      params.message === 'Allow the engineering MCP server to run tool "engineering.test"?' && approval.decisions.includes('accept');
    if (!allowed) throw new Error('Unexpected approval during repair; no permission was granted');
    report.approvalActions ??= [];
    assert.equal(state.approvals.length, 1, 'Only the strictly checked request may be pending for a UI approval');
    report.approvalActions.push({ generation: approval.generation, id: approval.id, method: approval.method, decision: 'accept', via: 'renderer-button',
      scope: { taskId: args.taskId, verifierId: args.verifierId, requestKey: args.requestKey } });
    await capture(`repair-approval-${report.approvalActions.length}`);
    answeredApprovals.add(key);
    const card = page!.locator('.approval'); assert.equal(await card.count(), 1);
    await card.getByRole('button', { name: '允许本次', exact: true }).click();
  }
}
function sanitized(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:token|secret|credential|password|authorization|api.?key)/i.test(key) ? '[REDACTED]' : sanitized(item)]));
  return value;
}
async function evidence(name = report.phase) {
  await writeFile(path.join(output, `${name}-evidence.json`), JSON.stringify(sanitized(report), null, 2));
}
async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
function ownedState(state: AppSnapshot) {
  const session = state.sessions.find(item => item.id === qaSessionId);
  return { engineState: state.engine.state, publicLoggedIn: state.account.loggedIn, session,
    task: state.tasks.find(item => item.id === session?.taskId), approvals: state.approvals.map(approval => ({ generation: approval.generation, id: approval.id, method: approval.method, decisions: approval.decisions, params: sanitized(approval.params) })) };
}
async function capture(name: string) {
  await page!.evaluate(() => { const label = document.querySelector('.sidebar-footer strong'); if (label) label.textContent = 'Authenticated account'; });
  await page!.screenshot({ path: path.join(output, `${name}.png`) });
}
async function restoreSuccessfulDelivery(filename: string) {
  const resolved = path.resolve(filename);
  const relative = path.relative(path.join(root, 'output/playwright/live-model'), resolved);
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Restore evidence must be inside the QA live evidence directory');
  const successful = JSON.parse(await readFile(resolved, 'utf8'));
  assert.equal(successful.phase, 'repair'); assert.equal(successful.result, 'passed');
  assert.equal(successful.scope, 'Installed real model; no hardware');
  const state = await snapshot();
  const session = state.sessions.find(item => item.id === successful.repair?.session?.id);
  assert.ok(session); assert.equal(session.status, 'completed');
  const project = state.projects.find(item => item.id === session.projectId);
  assert.ok(project); assert.equal(project.root, successful.workspace);
  assert.equal(state.tasks.find(item => item.id === session.taskId)?.status, 'passed');
  const events = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  for (const action of successful.approvalActions) {
    assert.equal(action.decision, 'accept'); assert.equal(action.via, 'renderer-button');
    assert.ok(events.some(event => event.generation === action.generation && event.method === 'engine/approvalResolved' && event.params?.id === action.id && event.params?.decision === 'accept'));
  }
  await page!.getByTitle(project.root, { exact: true }).and(page!.getByRole('button')).click();
  await page!.getByRole('button', { name: new RegExp(session.title) }).click();
  await page!.getByRole('tab', { name: '工程交付', exact: true }).click();
  await pause(250); await page!.reload(); await page!.locator('.app-header').waitFor();
  const selection = await page!.evaluate(() => {
    const value = JSON.parse(localStorage.getItem('forgedesk.renderer.v1') || '{}');
    return { projectId: value.projectId, sessionId: value.sessionId, tab: value.tab };
  });
  assert.deepEqual(selection, { projectId: project.id, sessionId: session.id, tab: 'delivery' });
  report.finalSelection = { ...selection, evidence: resolved, restartPreservedPassed: true, repairAcceptsJournalConfirmed: successful.approvalActions.length };
  await application!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, output);
  const exported = await page!.evaluate(id => window.forgeDesk.exportTask(id), session.taskId); assert.ok(exported);
  const exportedRelative = path.relative(output, exported);
  assert.ok(exportedRelative !== '..' && !exportedRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(exportedRelative));
  const manifestPath = path.join(exported, 'manifest.json'); const manifestText = await readFile(manifestPath, 'utf8'); const manifest = JSON.parse(manifestText);
  assert.deepEqual(Object.keys(manifest).sort(), ['schemaVersion', 'exportedAt', 'evidenceLevel', 'limitation', 'task', 'acceptance', 'operations', 'evidence', 'logs'].sort());
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.evidenceLevel, 'A'); assert.equal(manifest.task.status, 'passed');
  assert.deepEqual(Object.keys(manifest.task).sort(), ['schemaVersion', 'id', 'title', 'sessionId', 'status', 'profileRevision'].sort());
  assert.equal(manifest.task.id, session.taskId); assert.ok(manifest.logs.length > 0);
  for (const log of manifest.logs) {
    assert.match(log.file, /^logs\/[a-zA-Z0-9-]+\.log$/);
    assert.equal(digest(await readFile(path.join(exported, log.file), 'utf8')), log.sha256);
  }
  const diagnosticsPath = path.join(output, 'diagnostics.json');
  await application!.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }); }, diagnosticsPath);
  assert.equal(await page!.evaluate(() => window.forgeDesk.exportDiagnostics()), diagnosticsPath);
  const diagnostics = JSON.parse(await readFile(diagnosticsPath, 'utf8'));
  assert.equal(diagnostics.schemaVersion, 1);
  assert.deepEqual(Object.keys(diagnostics).sort(), ['schemaVersion', 'version', 'engineState', 'engineError', 'platform', 'arch', 'diagnostics'].sort());
  report.installedExports = { delivery: exported, evidenceLevel: manifest.evidenceLevel, taskStatus: manifest.task.status,
    manifestSha256: digest(manifestText), logsVerified: manifest.logs.length, diagnostics: diagnosticsPath };
  await capture('restored-successful-delivery');
  report.steps.push('Whole-app restart retained the real repaired task; installed export produced an A-level explicit-field manifest, hash-verified logs and public diagnostics');
}
async function waitFor(predicate: (state: AppSnapshot) => boolean, ms = 60000) {
  const deadline = Date.now() + ms;
  let checkpoint = 0;
  while (Date.now() < deadline) {
    const state = await snapshot();
    if (report.phase === 'repair' && qaSessionId && state.approvals.length) await allowStoredVerifier(state);
    if (predicate(state)) return state;
    if (Date.now() > checkpoint) { report.latest = ownedState(state); await evidence(); checkpoint = Date.now() + 10000; }
    await pause(500);
  }
  throw new Error('Real application state wait timed out');
}
async function createSession(projectId: string, title: string): Promise<Session> {
  const session = await page!.evaluate(({ id, title }) => window.forgeDesk.createSession(id, title), { id: projectId, title });
  qaSessionId = session.id;
  await pause(150);
  await page!.getByRole('button', { name: new RegExp(title) }).click();
  return session;
}
async function terminal(sessionId: string, ms = 300000) {
  return waitFor(state => {
    const session = state.sessions.find(item => item.id === sessionId);
    return !!session && ['completed', 'failed', 'interrupted', 'needs_attention'].includes(session.status);
  }, ms);
}
async function repair(projectId: string, model: string) {
  const session = await createSession(projectId, `Live model repair ${runId}`);
  const sourceFile = path.join(workspace, 'numbers.mjs');
  const sourceBefore = await readFile(sourceFile, 'utf8');
  const verifierBefore = await readFile(verifier, 'utf8');
  const items = [{ id: 'numbers', title: 'Empty input and arithmetic', kind: 'automated' as const,
    command: { executable: process.execPath, args: [verifier, workspace], timeoutMs: 10000 }, verifierFiles: [verifier] }];
  await page!.evaluate(({ id, items }) => window.forgeDesk.setAcceptance(id, items), { id: session.id, items });
  await page!.evaluate(id => window.forgeDesk.runAcceptance(id, 'numbers', `baseline-${Date.now()}`), session.id);
  const baseline = (await snapshot()).tasks.find(task => task.id === session.id)!;
  report.baseline = { sourceSha256: digest(sourceBefore), verifierSha256: digest(verifierBefore), status: baseline.status, operations: baseline.operations };
  assert.equal(baseline.status, 'failed', 'Original defective source must fail before any model action');
  const prompt = [
    'Fix the average(values) defect in numbers.mjs in this workspace. Empty arrays must return 0; preserve correct positive and signed arithmetic.',
    'Modify only numbers.mjs. Do not read product directories, credentials or authentication files. Do not alter trusted verifier files or acceptance definitions.',
    `This task has stored verifierId=numbers and taskId=${session.taskId}.`,
    'Use the engineering.test MCP tool to check the original defect and then verify your actual code repair. Use a new unique requestKey after a source edit; reuse a key only when retrying the identical invocation.',
    'Only runner-authored passed evidence proves acceptance. Keep your final reply concise with what changed and verification result.'
  ].join('\n');
  report.prompt = prompt;
  await page!.evaluate(({ id, text, model }) => window.forgeDesk.send(id, text, model), { id: session.id, text: prompt, model });
  report.steps.push('Real authenticated model turn started'); await evidence(); console.log('LIVE_TURN_STARTED');
  const complete = await terminal(session.id);
  const current = complete.sessions.find(item => item.id === session.id)!;
  const task = complete.tasks.find(item => item.id === session.taskId)!;
  const sourceAfter = await readFile(sourceFile, 'utf8');
  report.repair = { session: current, task, sourceBeforeSha256: digest(sourceBefore), sourceAfterSha256: digest(sourceAfter),
    verifierUnchanged: digest(await readFile(verifier, 'utf8')) === digest(verifierBefore) };
  await capture('repair-terminal');
  assert.equal(current.status, 'completed', `Real model turn did not complete: ${current.status}`);
  assert.notEqual(digest(sourceAfter), digest(sourceBefore), 'Model must change source; QA never supplies the corrected fixture');
  assert.equal(report.repair.verifierUnchanged, true);
  assert.equal(task.status, 'passed'); assert.equal(task.acceptance[0].status, 'passed');
  assert.ok(task.operations.length > baseline.operations.length, 'Model must invoke the authoritative runner');
  assert.ok(current.messages.some(message => message.role === 'tool' && message.text.includes('engineering.test')), 'Actual model MCP engineering.test call must be visible');
  const diff = await page!.evaluate(id => window.forgeDesk.diff(id), projectId);
  report.diff = diff; assert.ok(diff.text.includes('numbers.mjs') && diff.text.includes('+'), 'Actual git code difference required');
  await page!.getByRole('tab', { name: '工程交付', exact: true }).click(); await pause(200); await capture('repair-delivery');
  const logs = await Promise.all(task.operations.map(operation => page!.evaluate(({ id, operationId }) => window.forgeDesk.readOperationLog(id, operationId), { id: session.id, operationId: operation.id })));
  await writeFile(path.join(output, 'repair-logs.json'), JSON.stringify(sanitized(logs), null, 2));
  await page!.reload(); await page!.locator('.app-header').waitFor();
  assert.equal((await snapshot()).tasks.find(item => item.id === session.taskId)!.status, 'passed');
  report.steps.push('Model changed source, called real engineering.test, fixed verifier passed, git diff nonempty, reload retained passed evidence');
}

async function probe(projectId: string, model: string) {
  const session = await createSession(projectId, `Live MCP probe ${runId}`);
  const before = digest(await readFile(path.join(workspace, 'numbers.mjs'), 'utf8'));
  const items = [{ id: 'numbers', title: 'Empty input and arithmetic', kind: 'automated' as const,
    command: { executable: process.execPath, args: [verifier, workspace], timeoutMs: 10000 }, verifierFiles: [verifier] }];
  await page!.evaluate(({ id, items }) => window.forgeDesk.setAcceptance(id, items), { id: session.id, items });
  const prompt = `This is a read-only integration probe. Do not modify any file or inspect product/authentication directories. Make exactly ONE engineering.test MCP call with taskId=${session.taskId}, verifierId=numbers and requestKey=${runId}-probe. Then report its returned error or result briefly. If cancelled or rejected, do not retry and do not repair the source.`;
  report.prompt = prompt;
  await page!.evaluate(({ id, text, model }) => window.forgeDesk.send(id, text, model), { id: session.id, text: prompt, model });
  console.log('LIVE_MCP_PROBE_STARTED');
  const complete = await terminal(session.id, 120000);
  const current = complete.sessions.find(item => item.id === session.id)!;
  const task = complete.tasks.find(item => item.id === session.taskId)!;
  report.probe = { session: current, task, sourceUnchanged: digest(await readFile(path.join(workspace, 'numbers.mjs'), 'utf8')) === before,
    diagnostics: complete.diagnostics.filter(message => /elicitation|MCP.*shape|shape.*MCP/i.test(message)) };
  const publicEvents = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const generation = publicEvents.find(event => event.method === 'turn/started' && event.params?.threadId === current.threadId)?.generation;
  report.probe.safeShapeDetails = publicEvents.filter(event => event.generation === generation && event.method === 'engine/diagnostic' &&
    event.params?.message === 'MCP elicitation request shape; unsupported request cancelled').map(event => event.params.details);
  await writeFile(path.join(output, 'mcp-shape-details.json'), JSON.stringify(sanitized(report.probe.safeShapeDetails), null, 2));
  await writeFile(path.join(output, 'mcp-shape-diagnostics.json'), JSON.stringify(sanitized(report.probe.diagnostics), null, 2));
  await capture('mcp-probe-terminal');
  assert.equal(report.probe.sourceUnchanged, true);
  assert.ok(current.messages.some(message => message.role === 'tool' && message.text.includes('engineering.test')));
  assert.ok(report.probe.safeShapeDetails.length > 0, 'Actual safe elicitation shape diagnostic must be recorded');
  report.steps.push('Real MCP probe invoked engineering.test once without a source edit; diagnostic shape captured. This is not model repair acceptance.');
}

async function scopedItems(threadId: string | undefined) {
  return (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.method === 'item/completed' && event.params?.threadId === threadId).map(event => event.params.item);
}
async function waitingProcessIds(marker: string): Promise<number[]> {
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$qaProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker}*' } | Select-Object -ExpandProperty ProcessId); ConvertTo-Json -Compress -InputObject $qaProcesses`;
  const value = JSON.parse((await execute(powershell, ['-NoProfile', '-Command', script], { windowsHide: true, shell: false, timeout: 10000 })).stdout.trim() || '[]');
  return Array.isArray(value) ? value : [value];
}
async function waitingProcessRecords(marker: string) {
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$qaProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${marker}*' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='CreationDate';Expression={$_.CreationDate.ToString('o')}}); ConvertTo-Json -Depth 4 -Compress -InputObject $qaProcesses`;
  const value = JSON.parse((await execute(powershell, ['-NoProfile', '-Command', script], { windowsHide: true, shell: false, timeout: 10000 })).stdout.trim() || '[]');
  return Array.isArray(value) ? value : [value];
}
async function stopProbe(projectId: string, model: string) {
  const session = await createSession(projectId, `Live stop process probe ${runId}`);
  const marker = `qa-stop-probe-${runId}`;
  const prompt = `Run exactly one harmless shell command: Write-Output '${marker}'; Start-Sleep -Seconds 45. Do not modify any file or read product/authentication directories. Do not retry after interruption.`;
  await page!.evaluate(({ id, text, model }) => window.forgeDesk.send(id, text, model), { id: session.id, text: prompt, model });
  await waitFor(state => state.sessions.find(item => item.id === session.id)?.messages.some(message => message.role === 'tool' && message.text.includes(marker) && message.text.includes('Start-Sleep') && ['running', 'inProgress'].includes(message.status || '')) === true, 90000);
  report.stopProbe = { before: await waitingProcessRecords(marker), samples: [] }; assert.ok(report.stopProbe.before.length > 0);
  await page!.evaluate(id => window.forgeDesk.interrupt(id), session.id);
  const complete = await terminal(session.id, 60000); report.stopProbe.terminalStatus = complete.sessions.find(item => item.id === session.id)?.status;
  const deadline = Date.now() + 65000;
  while (Date.now() < deadline) {
    const records = await waitingProcessRecords(marker); report.stopProbe.samples.push({ at: new Date().toISOString(), records }); await evidence();
    if (!records.length) break;
    if (report.stopProbe.samples.length === 1) console.log(JSON.stringify({ stopTerminal: report.stopProbe.terminalStatus, remainingQaProcesses: sanitized(records) }));
    await pause(1000);
  }
  report.stopProbe.remainedAfterTerminal = report.stopProbe.samples[0]?.records.length > 0;
  report.stopProbe.naturallyGone = report.stopProbe.samples.at(-1)?.records.length === 0;
  await capture('stop-process-probe');
  report.steps.push('Narrow stop probe sampled only the QA marker process before/after real interruption; no manual process kill');
}
async function controls(projectId: string, model: string) {
  report.controls = { steer: 'pending', stop: 'pending', isolation: 'pending', rejection: 'pending', reload: 'pending' };
  const waitSession = await createSession(projectId, `Live steer stop ${runId}`);
  const marker = `qa-wait-${runId}`;
  const prompt = `This is a harmless cancellation test. Use the built-in shell exactly once to execute: Write-Output '${marker}'; Start-Sleep -Seconds 45. Do not change any files, do not read product/authentication directories, and do not retry after interruption. Begin the command now.`;
  await page!.evaluate(({ id, text, model }) => window.forgeDesk.send(id, text, model), { id: waitSession.id, text: prompt, model });
  let state = await waitFor(state => state.approvals.length > 0 || state.sessions.find(session => session.id === waitSession.id)?.messages.some(message =>
    message.role === 'tool' && message.text.includes(marker) && message.text.includes('Start-Sleep') && ['running', 'inProgress'].includes(message.status || '')) === true ||
    ['completed', 'failed', 'interrupted', 'needs_attention'].includes(state.sessions.find(session => session.id === waitSession.id)?.status || ''), 90000);
  const active = state.sessions.find(session => session.id === waitSession.id)!;
  if (active.status === 'running' && !state.approvals.length && await waitingProcessIds(marker).then(ids => ids.length > 0)) {
    report.waitProcessesBeforeInterrupt = await waitingProcessIds(marker);
    const otherRoot = path.join(fixtureRoot, runId, 'other-workspace'); await mkdir(otherRoot, { recursive: true });
    await writeFile(path.join(otherRoot, 'isolation.txt'), 'QA untouched alternate project\n');
    await application!.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, otherRoot);
    const other = await page!.evaluate(() => window.forgeDesk.importProject()); assert.ok(other);
    await pause(150); await page!.getByTitle(otherRoot, { exact: true }).and(page!.getByRole('button')).click();
    const idle = await createSession(other.id, `Live isolation ${runId}`); qaSessionId = waitSession.id;
    const steer = `QA steer ${runId}: no file changes; report this exact marker only after the waiting command finishes.`;
    await page!.evaluate(({ id, text }) => window.forgeDesk.steer(id, text), { id: waitSession.id, text: steer });
    state = await snapshot();
    assert.ok(state.sessions.find(session => session.id === waitSession.id)!.messages.some(message => message.text === steer && message.status === 'steered'));
    assert.equal(state.sessions.find(session => session.id === idle.id)!.messages.length, 0);
    assert.equal(state.tasks.find(task => task.id === idle.taskId)!.operations.length, 0);
    report.controls.steer = 'passed'; report.controls.isolation = 'passed';
    report.isolation = { activeSessionId: waitSession.id, idleSessionId: idle.id, idleProjectId: other.id, idleMessages: 0, idleOperations: 0 };
    await capture('steer-alternate-project');
    await page!.getByTitle(workspace, { exact: true }).and(page!.getByRole('button')).click();
    await page!.getByRole('button', { name: new RegExp(waitSession.title) }).click();
    await page!.evaluate(id => window.forgeDesk.interrupt(id), waitSession.id);
    state = await terminal(waitSession.id, 60000);
    assert.equal(state.sessions.find(session => session.id === waitSession.id)!.status, 'interrupted');
    for (let attempt = 0; attempt < 10 && (await waitingProcessIds(marker)).length; attempt++) await pause(500);
    report.waitProcessesAfterInterrupt = await waitingProcessIds(marker); assert.equal(report.waitProcessesAfterInterrupt.length, 0);
    report.controls.stop = 'passed'; report.stopSession = state.sessions.find(session => session.id === waitSession.id);
    await capture('real-interrupted');
  } else {
    report.stopUnverifiedReason = { status: active.status, approvals: state.approvals.map(approval => ({ id: approval.id, method: approval.method })) };
    if (active.status === 'running' && active.turnId) { await page!.evaluate(id => window.forgeDesk.interrupt(id), waitSession.id); await terminal(waitSession.id, 60000); }
  }

  const denial = await createSession(projectId, `Live approval denial ${runId}`);
  const protectedRoot = path.join(fixtureRoot, runId, 'protected'); await mkdir(protectedRoot, { recursive: true });
  const sentinel = path.join(protectedRoot, 'sentinel.txt'); const original = `unchanged-${runId}\n`; await writeFile(sentinel, original);
  const denialValue = `qa-denial-${runId}`;
  const denialPrompt = `This is a sandbox refusal test for this single disposable QA file: ${sentinel}. Do not read any product/authentication files. Request exactly ONE built-in shell command approval with sandbox_permissions=require_escalated and a justification, to execute [System.IO.File]::WriteAllText('${sentinel}','${denialValue}'). Do not attempt an unapproved write first, do not change cwd, do not use MCP or request_permissions, and do not retry. Wait for the client's decision; after a refusal report it and end. The client will decline this operation.`;
  await page!.evaluate(({ id, text, model }) => window.forgeDesk.send(id, text, model), { id: denial.id, text: denialPrompt, model });
  state = await waitFor(state => state.approvals.length > 0 || ['completed', 'failed', 'interrupted', 'needs_attention'].includes(state.sessions.find(session => session.id === denial.id)?.status || ''), 120000);
  const approval = state.approvals[0];
  if (approval) {
    const current = state.sessions.find(session => session.id === denial.id)!;
    const params = approval.params as Record<string, any>;
    const actionCommands = Array.isArray(params.commandActions) ? params.commandActions.map((action: any) => action.command) : [];
    assert.equal(approval.method, 'item/commandExecution/requestApproval');
    assert.equal(params.threadId, current.threadId); assert.equal(params.turnId, current.turnId);
    assert.deepEqual(actionCommands, [`[System.IO.File]::WriteAllText('${sentinel}','${denialValue}')`], 'Only the exact structured single-target QA command may be acted on');
    const decision = approval.decisions.includes('decline') ? 'decline' : approval.decisions.includes('cancel') ? 'cancel' : undefined;
    assert.ok(decision); assert.equal(await readFile(sentinel, 'utf8'), original);
    report.deniedApproval = { generation: approval.generation, id: approval.id, method: approval.method, target: sentinel, decision };
    await capture('approval-before-reload'); await page!.reload(); await page!.locator('.app-header').waitFor();
    const reloaded = (await snapshot()).approvals.find(item => item.generation === approval.generation && item.id === approval.id);
    assert.ok(reloaded); assert.equal(await readFile(sentinel, 'utf8'), original); report.controls.reload = 'passed';
    await capture('approval-after-reload');
    assert.equal((await snapshot()).approvals.length, 1);
    const card = page!.locator('.approval'); assert.equal(await card.count(), 1);
    await card.getByRole('button', { name: decision === 'decline' ? '拒绝' : '取消', exact: true }).click();
    report.deniedApproval.via = 'renderer-button';
    state = await terminal(denial.id, 60000);
    const items = await scopedItems(current.threadId); report.denialItems = items;
    const declined = items.some(item => item.type === 'commandExecution' && item.status === 'declined' && typeof item.command === 'string' && item.command.includes(denialValue));
    assert.equal(await readFile(sentinel, 'utf8'), original);
    if (decision === 'decline') assert.equal(declined, true);
    else assert.equal(state.sessions.find(session => session.id === denial.id)?.status, 'interrupted', 'Shell cancel must end the real turn');
    const events = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    assert.ok(events.some(event => event.generation === approval.generation && event.method === 'engine/approvalResolved' && event.params?.id === approval.id && event.params?.decision === decision));
    report.deniedApproval.resolvedDecision = decision;
    report.deniedApproval.terminalStatus = state.sessions.find(session => session.id === denial.id)?.status;
    report.controls.rejection = 'passed'; report.sentinelUnchanged = true;
    await capture('approval-declined');
  } else {
    report.approvalUnverifiedReason = { status: state.sessions.find(session => session.id === denial.id)?.status, observedApprovals: 0 };
  }
  report.steps.push('Live control observations recorded; pending fields remain unverified rather than being converted to success');
  report.controlsComplete = Object.values(report.controls).every(value => value === 'passed');
}

async function mcpDenial(projectId: string, model: string) {
  const session = await createSession(projectId, `Live MCP refusal ${runId}`);
  const sourceBefore = digest(await readFile(path.join(workspace, 'numbers.mjs'), 'utf8'));
  const items = [{ id: 'numbers', title: 'Empty input and arithmetic', kind: 'automated' as const,
    command: { executable: process.execPath, args: [verifier, workspace], timeoutMs: 10000 }, verifierFiles: [verifier] }];
  await page!.evaluate(({ id, items }) => window.forgeDesk.setAcceptance(id, items), { id: session.id, items });
  const key = `${runId}-refusal`;
  const prompt = `This is a refusal test. Do not modify any file or read product/authentication directories. Make exactly ONE engineering.test MCP call with taskId=${session.taskId}, verifierId=numbers and requestKey=${key}. Wait for the client decision. The client will decline; then report refusal and end without retry or alternate commands.`;
  await page!.evaluate(({ id, text, model }) => window.forgeDesk.send(id, text, model), { id: session.id, text: prompt, model });
  const pending = await waitFor(state => state.approvals.length > 0, 120000); assert.equal(pending.approvals.length, 1);
  const approval = pending.approvals[0]; const params = approval.params as Record<string, any>;
  const current = pending.sessions.find(item => item.id === session.id)!;
  assert.equal(approval.method, 'mcpServer/elicitation/request'); assert.equal(params.threadId, current.threadId); assert.equal(params.turnId, current.turnId);
  assert.equal(params.serverName, 'engineering'); assert.equal(params._meta?.codex_approval_kind, 'mcp_tool_call');
  assert.equal(params.mode, 'form'); assert.deepEqual(params.requestedSchema, { type: 'object', properties: {} });
  assert.equal(params.message, 'Allow the engineering MCP server to run tool "engineering.test"?');
  assert.deepEqual(params._meta?.tool_params, { taskId: session.taskId, verifierId: 'numbers', requestKey: key }); assert.ok(approval.decisions.includes('decline'));
  assert.equal(pending.tasks.find(task => task.id === session.taskId)!.operations.length, 0);
  report.mcpDenial = { generation: approval.generation, id: approval.id, method: approval.method, decision: 'decline', via: 'renderer-button' };
  await capture('mcp-refusal-before-reload'); await page!.reload(); await page!.locator('.app-header').waitFor();
  const reloaded = await snapshot(); assert.equal(reloaded.approvals.length, 1);
  assert.equal(reloaded.approvals[0].generation, approval.generation); assert.equal(reloaded.approvals[0].id, approval.id);
  assert.equal(reloaded.tasks.find(task => task.id === session.taskId)!.operations.length, 0);
  await capture('mcp-refusal-after-reload');
  const card = page!.locator('.approval'); assert.equal(await card.count(), 1); await card.getByRole('button', { name: '拒绝', exact: true }).click();
  const complete = await terminal(session.id, 60000);
  const task = complete.tasks.find(task => task.id === session.taskId)!; assert.equal(task.operations.length, 0);
  assert.equal(digest(await readFile(path.join(workspace, 'numbers.mjs'), 'utf8')), sourceBefore);
  const events = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.generation === approval.generation && event.method === 'engine/approvalResolved' && event.params?.id === approval.id && event.params?.decision === 'decline'));
  report.mcpDenial = { ...report.mcpDenial, reloadPreservedPending: true, runnerOperations: 0, sourceUnchanged: true, finalSession: complete.sessions.find(item => item.id === session.id) };
  await capture('mcp-refusal-completed'); report.steps.push('Real MCP refusal button after renderer reload resolved decline; no runner operation or source edit occurred');
}

await mkdir(output, { recursive: true });
try {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete environment.ELECTRON_RUN_AS_NODE; environment.FORGEDESK_DATA_DIR = dataDir;
  application = await electron.launch({ executablePath: executable, args: development ? [root] : [], cwd: root, env: environment, timeout: 30000 });
  page = await application.firstWindow({ timeout: 30000 }); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.locator('.app-header').waitFor(); await page.setViewportSize({ width: 1380, height: 900 });
  await waitFor(state => ['ready', 'failed'].includes(state.engine.state));
  await page.evaluate(() => window.forgeDesk.connect());
  const initial = await snapshot();
  report.initial = { appVersion: initial.version, publicLoggedIn: initial.account.loggedIn, engine: initial.engine, modelIds: initial.models.map(model => model.id) };
  assert.equal(initial.account.loggedIn, true, 'User account is not publicly logged in; no model task was sent');
  assert.equal(initial.engine.state, 'ready', initial.engine.error || 'Engine not ready');
  assert.equal(initial.engine.home, path.join(dataDir, 'engine'));
  report.sourceCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, shell: false })).stdout.trim();
  report.sourceDirty = !!(await execute('git', ['status', '--porcelain'], { cwd: root, windowsHide: true, shell: false })).stdout.trim();
  if (development) report.distMainSha256 = createHash('sha256').update(await readFile(path.join(root, 'dist/main/index.cjs'))).digest('hex');
  else { report.installedAsarSha256 = await fileDigest(path.join(root, 'install/resources/app.asar')); report.installerSha256 = await fileDigest(path.join(root, `release/ForgeDesk-${initial.version}-x64-setup.exe`)); }
  const model = process.env.FORGEDESK_LIVE_MODEL || initial.models[0]?.id; assert.ok(model, 'No publicly available model returned');
  report.chosenModel = model; await evidence(); console.log(JSON.stringify({ publicLoggedIn: true, chosenModel: model, modelIds: report.initial.modelIds }));
  await mkdir(workspace, { recursive: true });
  const workspaceRelative = path.relative(fixtureRoot, workspace);
  assert.ok(workspaceRelative !== '..' && !workspaceRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(workspaceRelative), 'Live fixture must stay in its dedicated QA directory');
  const sourceFile = path.join(workspace, 'numbers.mjs');
  try { await access(sourceFile); } catch { await copyFile(path.join(root, 'engineering/fixtures/software/workspace/numbers.mjs'), sourceFile); }
  try { await access(path.join(workspace, '.git')); } catch {
    await execute('git', ['init', workspace], { windowsHide: true, shell: false });
    await execute('git', ['-C', workspace, 'add', 'numbers.mjs'], { windowsHide: true, shell: false });
    await execute('git', ['-C', workspace, '-c', 'user.name=ForgeDesk QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'Live model QA buggy baseline'], { windowsHide: true, shell: false });
  }
  await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, workspace);
  const project = await page.evaluate(() => window.forgeDesk.importProject()); assert.ok(project);
  await pause(150); await page.getByTitle(workspace, { exact: true }).and(page.getByRole('button')).click();
  if (report.phase === 'repair') await repair(project.id, model);
  else if (report.phase === 'probe') await probe(project.id, model);
  else if (report.phase === 'controls') await controls(project.id, model);
  else if (report.phase === 'stop-probe') await stopProbe(project.id, model);
  else if (report.phase === 'mcp-denial') await mcpDenial(project.id, model);
  else throw new Error('Requested live test phase is not implemented');
  if (process.env.FORGEDESK_LIVE_RESTORE_REPAIR) await restoreSuccessfulDelivery(process.env.FORGEDESK_LIVE_RESTORE_REPAIR);
  assert.deepEqual(report.pageErrors, []); report.result = report.phase === 'controls' && !report.controlsComplete ? 'partial' : 'passed';
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(error instanceof Error ? error.stack || error.message : String(error)));
  if (page) { try { report.latest = ownedState(await snapshot()); await capture('failure'); } catch {} }
  process.exitCode = 1;
} finally {
  if (application) { try { await application.close(); } catch (error) { report.failures.push(redact(String(error))); process.exitCode = 1; } }
  report.finishedAt = new Date().toISOString(); await evidence();
  console.log(JSON.stringify({ result: report.result, phase: report.phase, steps: report.steps, failures: report.failures, evidence: path.join(output, `${report.phase}-evidence.json`) }, null, 2));
}
