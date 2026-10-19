import assert from 'node:assert/strict';
import path from 'node:path';
import type { AppSnapshot, Approval, Session } from '../../packages/shared/contracts';
import { redact } from '../../packages/engineering-runner/redaction';
import { assertSecondDesktop, type DesktopIdentity } from './snapshot-smoke-scope';

export const secondUserSid = 'S-1-5-21-1196670755-766692816-2897134863-1006';
export const diagnosticsFields = ['schemaVersion', 'version', 'engineState', 'engineError', 'platform', 'arch', 'diagnostics'];

export interface ElectronMainIdentity { pid: number; execPath: string; type: string; platform: string }
export interface InstalledMainProcess { id: number; parentId: number; name: string; execPath: string; created: string; sid: string; sessionId: number; ownerQueryStatus: number }

export interface ControlsStartupSummary {
  engineState: string; engineError: string; publicLoggedIn: boolean; modelCount: number; modelIds: string[];
  busy: { uncertainSessions: number; runningSessions: number; stoppingSessions: number; boundTurns: number; pendingApprovals: number; runningTasks: number; busyOperations: number };
}
export interface ControlsStartupObservation { attempt: number; phase: 'before' | 'blocked' | 'failed' | 'completed'; summary?: ControlsStartupSummary; error?: string; observationError?: string }
export interface ControlsStartupCallbacks {
  snapshot(): Promise<AppSnapshot>; connect(): Promise<void>; wait(ms: number): Promise<unknown>; observe(value: ControlsStartupObservation): Promise<void>;
}
function startupSummary(state: AppSnapshot): ControlsStartupSummary {
  return { engineState: state.engine.state, engineError: redact(state.engine.error ?? '').slice(0, 4000), publicLoggedIn: state.account.loggedIn,
    modelCount: state.models.length, modelIds: state.models.slice(0, 20).map(model => redact(model.id).slice(0, 200)),
    busy: { uncertainSessions: state.sessions.filter(session => session.engineUncertain).length,
      runningSessions: state.sessions.filter(session => session.status === 'running').length, stoppingSessions: state.sessions.filter(session => session.status === 'stopping').length,
      boundTurns: state.sessions.filter(session => Boolean(session.turnId)).length, pendingApprovals: state.approvals.length,
      runningTasks: state.tasks.filter(task => task.status === 'running').length,
      busyOperations: state.tasks.flatMap(task => task.operations).filter(operation => ['prepared', 'running', 'stopping'].includes(operation.status)).length } };
}
const startupError = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);
export async function connectControlsStartup(callbacks: ControlsStartupCallbacks): Promise<AppSnapshot> {
  const routingError = 'Engine account/read: workspace routing discovery timed out';
  // Startup observations are not an atomic lock against manual UI actions.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = startupSummary(await callbacks.snapshot()); await callbacks.observe({ attempt, phase: 'before', summary: before });
    try { assert.ok(before.engineState === 'ready' && Object.values(before.busy).every(count => count === 0), 'Startup connect requires a ready, idle engine without uncertain sessions, bound turns, approvals or busy runner tasks'); }
    catch (error) { await callbacks.observe({ attempt, phase: 'blocked', summary: before, error: startupError(error) }); throw error; }
    let failed = false; let error: unknown;
    try { await callbacks.connect(); } catch (failure) { failed = true; error = failure; }
    let after: AppSnapshot;
    try { after = await callbacks.snapshot(); }
    catch (observationError) {
      await callbacks.observe({ attempt, phase: 'failed', error: failed ? startupError(error) : 'Post-connect public snapshot unavailable', observationError: startupError(observationError) });
      throw failed ? error : observationError;
    }
    await callbacks.observe({ attempt, phase: failed ? 'failed' : 'completed', summary: startupSummary(after), ...(failed ? { error: startupError(error) } : {}) });
    if (!failed) return after;
    const message = error instanceof Error ? error.message : String(error);
    if (attempt !== 1 || ![routingError, `page.evaluate: Error: Error invoking remote method 'forgedesk:invoke': Error: ${routingError}`].includes(message)) throw error;
    await callbacks.wait(5000);
  }
  throw new Error('Startup attempts exhausted');
}

export function stopObservationDeadline(created: string): number {
  const timestamp = Date.parse(created);
  assert.ok(Number.isFinite(timestamp) && timestamp > 0, 'Stop timing requires a valid root process creation timestamp');
  return timestamp + 40000;
}
export function assertStopObservationTiming(created: string, clicked: string, observed: string): void {
  const creation = Date.parse(created); const click = Date.parse(clicked); const observation = Date.parse(observed);
  assert.ok(Number.isFinite(creation) && creation > 0 && Number.isFinite(click) && Number.isFinite(observation) && click >= creation && observation >= click, 'Stop timing requires valid chronological timestamps');
  const deadline = stopObservationDeadline(created);
  assert.ok(click < deadline && observation < deadline, 'Stop click and native disappearance must be observed before the conservative 40-second deadline');
}

export function nativeMainProcessQuery(pid: number): string {
  assert.ok(Number.isInteger(pid) && pid > 0);
  return `$ErrorActionPreference='Stop'
$item=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
$result=$null
if($item){$owner=Invoke-CimMethod -InputObject $item -MethodName GetOwnerSid;$result=@{id=[int]$item.ProcessId;parentId=[int]$item.ParentProcessId;name=$item.Name;execPath=$item.ExecutablePath;created=([datetime]$item.CreationDate).ToUniversalTime().ToString('o');sid=$owner.Sid;sessionId=[int]$item.SessionId;ownerQueryStatus=[int]$owner.ReturnValue}}
if($null -eq $result){'null'}else{ConvertTo-Json -InputObject $result -Depth 3 -Compress}`;
}

export function assertElectronMainIdentity(main: ElectronMainIdentity, installed: string): void {
  assert.ok(Number.isInteger(main.pid) && main.pid > 0, 'Electron main PID must be a positive integer obtained from the main-process context');
  assert.equal(main.type, 'browser', 'The identity must be the Electron main process, not a renderer or launcher');
  assert.equal(main.platform, 'win32');
  assert.equal(path.resolve(main.execPath).toLowerCase(), path.resolve(installed).toLowerCase(), 'Electron main must use the verified installed executable');
}

export function assertInstalledMainProcess(observed: InstalledMainProcess | null, main: ElectronMainIdentity, installed: string, sid: string, sessionId: number): asserts observed is InstalledMainProcess {
  assertElectronMainIdentity(main, installed);
  assert.ok(observed, 'The actual Electron main process must be present in the native process sample');
  assert.equal(observed.id, main.pid, 'Native process sampling must bind the actual Electron main PID, not the Playwright launcher PID');
  assert.equal(path.resolve(observed.execPath).toLowerCase(), path.resolve(installed).toLowerCase());
  assert.equal(observed.name.toLowerCase(), path.basename(installed).toLowerCase());
  assert.equal(observed.ownerQueryStatus, 0); assert.equal(observed.sid, sid); assert.equal(observed.sessionId, sessionId);
  assert.ok(Number.isInteger(observed.parentId) && observed.parentId > 0 && Number.isFinite(Date.parse(observed.created)));
}

export function assertElectronMainExited(expected: InstalledMainProcess, observed: InstalledMainProcess | null): void {
  assert.ok(Number.isInteger(expected.id) && expected.id > 0 && Number.isFinite(Date.parse(expected.created)));
  if (observed) { assert.equal(observed.id, expected.id); assert.ok(Number.isFinite(Date.parse(observed.created))); }
  assert.ok(!observed || Date.parse(observed.created) !== Date.parse(expected.created),
    'Normal close requires the actual Electron main PID and creation identity to disappear; launcher exit alone is insufficient');
}

export function assertControlsIdentity(identity: DesktopIdentity): void {
  assertSecondDesktop(identity);
  assert.equal(identity.sid, secondUserSid, 'Controls acceptance is scoped to the actual authorized ForgeDeskTest SID 1006');
}

export function assertMcpDenialApproval(approval: Approval, session: Session, requestKey: string): void {
  const params = approval.params as Record<string, any>;
  assert.ok(session.threadId && session.turnId, 'Refusal must bind a current real model turn');
  assert.ok(typeof approval.id === 'string' || typeof approval.id === 'number');
  assert.equal(approval.method, 'mcpServer/elicitation/request');
  assert.equal(params.threadId, session.threadId); assert.equal(params.turnId, session.turnId);
  assert.equal(params.serverName, 'engineering'); assert.equal(params.mode, 'form');
  assert.deepEqual(params.requestedSchema, { type: 'object', properties: {} });
  assert.equal(params._meta?.codex_approval_kind, 'mcp_tool_call');
  assert.equal(params.message, 'Allow the engineering MCP server to run tool "engineering.test"?');
  assert.deepEqual(params._meta?.tool_params, { taskId: session.taskId, verifierId: 'qa-controls-verifier', requestKey });
  assert.ok(approval.decisions.includes('decline'), 'The real protocol must offer decline; do not substitute accept or session persistence');
}

export function refusedMcpItem(session: Session, requestKey: string) {
  const messages = session.messages.filter(message => message.role === 'tool');
  assert.equal(messages.length, 1, 'Exactly one tool item must remain; retries and alternate tools are not accepted');
  let item: Record<string, any>;
  try { item = JSON.parse(messages[0].text); }
  catch { assert.fail('The sole tool item must be a completed MCP JSON item'); }
  assert.ok(item && typeof item === 'object' && !Array.isArray(item), 'The sole tool item must be an MCP object');
  assert.equal(item.type, 'mcpToolCall'); assert.equal(item.server, 'engineering'); assert.equal(item.tool, 'engineering.test');
  assert.equal(item.arguments?.taskId, session.taskId); assert.equal(item.arguments?.verifierId, 'qa-controls-verifier'); assert.equal(item.arguments?.requestKey, requestKey);
  assert.equal(item.status, 'failed');
  assert.equal(item.error?.message, 'user rejected MCP tool call', 'A cancelled transport, timeout or unrelated failure is not a real user refusal');
  assert.equal(item.result, null);
  return item;
}

export function assertWaitCommand(commandLine: string, marker: string): void {
  assert.match(marker, /^qa-controls-wait-snapshot-\d+$/);
  const quoted = /\s-Command\s+"([^"]*)"\s*$/i.exec(commandLine);
  const plain = /\s-Command\s+(Write-Output\s+.*)$/i.exec(commandLine);
  const body = quoted?.[1] ?? plain?.[1];
  const commandIndex = commandLine.search(/\s-Command\s/i);
  const executableAndFlags = commandLine.slice(0, commandIndex).trim();
  assert.match(executableAndFlags, /^(?:"[^"\r\n]*[\\/](?:powershell|pwsh)\.exe"|(?:[^\s"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?)(?:\s+-(?:NoLogo|NoProfile|NonInteractive))*$/i, 'No file, encoded command, or extra invocation may precede the harmless QA command');
  const waiting = `Write-Output '${marker}'; Start-Sleep -Seconds 45`;
  const utf8Prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}';
  assert.ok(body === waiting || body === `${utf8Prefix}\n${waiting}`,
    'Only the exact single harmless QA waiting command, optionally after the fixed UTF8 prefix once and one LF, may establish the stopped process');
}

export function assertProcessProbe(value: Record<string, any>, installed: string, main: ElectronMainIdentity, observed: InstalledMainProcess, sid: string, sessionId: number): void {
  assertInstalledMainProcess(observed, main, installed, sid, sessionId);
  assert.equal(value.stage, 'ProcessProbe'); assert.equal(value.status, 'CHECKS_OK_NOT_ACCEPTED'); assert.equal(value.sid, sid);
  assert.equal(path.resolve(value.installDirectory).toLowerCase(), path.dirname(installed).toLowerCase());
  assert.deepEqual(value.problems, []);
  for (const role of ['application', 'engine', 'processHost']) {
    assert.ok(Array.isArray(value.processes?.[role]) && value.processes[role].length > 0, `Missing real installed ${role} process owned by the second SID`);
    for (const item of value.processes[role]) assert.ok(Number.isInteger(item.id) && item.id > 0 && Number.isFinite(Date.parse(item.started)));
  }
  assert.ok(value.processes.application.some((item: any) => item.id === main.pid && Date.parse(item.started) === Date.parse(observed.created)),
    'ProcessProbe must include the actual Electron main PID and creation identity of this installed application instance');
}

export function assertDiagnosticsExport(value: Record<string, any>, marker: string, syntheticSecret: string): void {
  assert.deepEqual(Object.keys(value).sort(), [...diagnosticsFields].sort());
  assert.equal(value.schemaVersion, 1); assert.equal(value.version, '0.2.1'); assert.equal(value.platform, 'win32');
  assert.equal(value.engineState, 'ready'); assert.equal(typeof value.engineError, 'string'); assert.equal(typeof value.arch, 'string');
  assert.ok(Array.isArray(value.diagnostics) && value.diagnostics.every((line: unknown) => typeof line === 'string'));
  assert.equal(JSON.stringify(value).includes(syntheticSecret), false, 'Synthetic secret must not be present in the actual diagnostic export');
  assert.ok(value.diagnostics.some((line: string) => line.includes(marker) && /\[redacted\]/i.test(line)), 'The exact synthetic failure log must exist and contain its redaction, not merely be absent');
}
