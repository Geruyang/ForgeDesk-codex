import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AppSnapshot, Approval, Session } from '../packages/shared/contracts';
import { assertControlsIdentity, assertDiagnosticsExport, assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, assertMcpDenialApproval, assertProcessProbe, assertStopObservationTiming, assertWaitCommand, connectControlsStartup, nativeMainProcessQuery, refusedMcpItem, secondUserSid, stopObservationDeadline } from './helpers/second-user-controls';

const session = (): Session => ({ id: 'session', taskId: 'task', projectId: 'project', title: 'fixture', threadId: 'thread', turnId: 'turn', status: 'running', messages: [] });
const approval = (): Approval => ({ generation: 1, id: 0, method: 'mcpServer/elicitation/request', decisions: ['accept', 'decline', 'cancel'], params: {
  threadId: 'thread', turnId: 'turn', serverName: 'engineering', mode: 'form', requestedSchema: { type: 'object', properties: {} },
  message: 'Allow the engineering MCP server to run tool "engineering.test"?', _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { taskId: 'task', verifierId: 'qa-controls-verifier', requestKey: 'fixture-key' } } } });

test('controls requires exact real second SID, not another eligible fixture desktop', () => {
  const identity = { sid: secondUserSid, account: 'HOST\\ForgeDeskTest', sessionId: 2, interactive: true, elevated: false, platformSids: [], explorerOwners: [{ sid: secondUserSid, sessionId: 2 }], applications: [] };
  assert.doesNotThrow(() => assertControlsIdentity(identity));
  const other = secondUserSid.replace(/1006$/, '1007');
  assert.throws(() => assertControlsIdentity({ ...identity, sid: other, explorerOwners: [{ sid: other, sessionId: 2 }] }), /SID 1006/);
  assert.throws(() => assertControlsIdentity({ ...identity, elevated: true }), /BLOCKED/);
});

test('MCP refusal guard accepts numeric zero but rejects foreign or broader approval shapes', () => {
  assert.doesNotThrow(() => assertMcpDenialApproval(approval(), session(), 'fixture-key'));
  for (const change of [{ threadId: 'other' }, { turnId: 'other' }, { serverName: 'other' }, { mode: 'url' }, { requestedSchema: { type: 'object', properties: { scope: {} } } }, { message: 'Allow arbitrary shell' }]) {
    const request = approval(); request.params = { ...(request.params as object), ...change };
    assert.throws(() => assertMcpDenialApproval(request, session(), 'fixture-key'));
  }
  const request = approval(); request.decisions = ['accept']; assert.throws(() => assertMcpDenialApproval(request, session(), 'fixture-key'), /offer decline/);
  assert.throws(() => assertMcpDenialApproval(approval(), session(), 'different-key'));
});

test('refusal requires the exact real completed tool error and no retry item', () => {
  const item = { type: 'mcpToolCall', server: 'engineering', tool: 'engineering.test', arguments: { taskId: 'task', verifierId: 'qa-controls-verifier', requestKey: 'fixture-key' }, status: 'failed', result: null, error: { message: 'user rejected MCP tool call' } };
  const current = session(); current.messages = [{ id: 'tool', role: 'tool', text: JSON.stringify(item), timestamp: 'fixture' }];
  assert.deepEqual(refusedMcpItem(current, 'fixture-key'), item);
  current.messages[0].text = JSON.stringify({ ...item, error: { message: 'timeout' } }); assert.throws(() => refusedMcpItem(current, 'fixture-key'), /not a real user refusal/);
  current.messages[0].text = JSON.stringify(item); current.messages.push({ ...current.messages[0], id: 'retry' }); assert.throws(() => refusedMcpItem(current, 'fixture-key'), /Exactly one/);
});

test('waiting process scope permits only the exact harmless command', () => {
  const marker = 'qa-controls-wait-snapshot-123';
  assert.doesNotThrow(() => assertWaitCommand(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Write-Output '${marker}'; Start-Sleep -Seconds 45"`, marker));
  for (const command of [`powershell.exe -Command "Get-Content secret; Write-Output '${marker}'; Start-Sleep -Seconds 45"`, `powershell.exe -Command "Write-Output '${marker}'; Start-Sleep -Seconds 1"`, `powershell.exe -Command "Write-Output '${marker}'; Start-Sleep -Seconds 45; Remove-Item file"`]) assert.throws(() => assertWaitCommand(command, marker), /exact single harmless/);
  assert.throws(() => assertWaitCommand(`powershell.exe -File other.ps1 -Command "Write-Output '${marker}'; Start-Sleep -Seconds 45"`, marker), /No file, encoded command/);
  assert.throws(() => assertWaitCommand(`cmd.exe -Command "Write-Output '${marker}'; Start-Sleep -Seconds 45"`, marker), /No file, encoded command/);
});

test('actual failed control body allows the fixed native UTF8 prefix exactly once', () => {
  const marker = 'qa-controls-wait-snapshot-1791988175683';
  const body = `try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\nWrite-Output '${marker}'; Start-Sleep -Seconds 45`;
  assert.doesNotThrow(() => assertWaitCommand(`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${body}"`, marker));
  assert.throws(() => assertWaitCommand(`powershell.exe -NoProfile -Command "${body.replace('\n', '\r\n')}"`, marker), /exact single harmless/);
});

test('UTF8 allowance does not ignore additional, repeated, modified or encoded commands', () => {
  const marker = 'qa-controls-wait-snapshot-1791988175683';
  const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}';
  const waiting = `Write-Output '${marker}'; Start-Sleep -Seconds 45`;
  const rejected = [
    `Get-Content file\n${prefix}\n${waiting}`,
    `${prefix}\nGet-Content file\n${waiting}`,
    `${prefix}\n${prefix}\n${waiting}`,
    `${prefix.replace('UTF8', 'Unicode')}\n${waiting}`,
    `${prefix.replace('catch {}', 'catch { Write-Output unexpected }')}\n${waiting}`,
    `${prefix.replace('catch {}', 'catch { }')}\n${waiting}`,
    `${prefix.replace('try { ', 'try { Get-Content file; ')}\n${waiting}`,
    `${prefix}; ${waiting}`,
    `${prefix}\n\n${waiting}`,
    `${prefix}\n${waiting}; Remove-Item file`,
    `${prefix}\n${waiting}\nWrite-Output extra`,
  ];
  for (const body of rejected) assert.throws(() => assertWaitCommand(`powershell.exe -Command "${body}"`, marker), /exact single harmless/);
  assert.throws(() => assertWaitCommand(`powershell.exe -EncodedCommand ZmFrZQ== -Command "${prefix}\n${waiting}"`, marker), /No file, encoded command/);
});

test('process owner stage binds actual app PID and requires all three installed roles', () => {
  const installed = path.resolve('fixture/install/ForgeDesk.exe');
  const item = { id: 123, started: '2026-10-14T00:00:00.000Z' };
  const main = { pid: item.id, execPath: installed, type: 'browser', platform: 'win32' };
  const observed = { id: item.id, parentId: 999, name: 'ForgeDesk.exe', execPath: installed, created: item.started, sid: secondUserSid, sessionId: 2, ownerQueryStatus: 0 };
  const probe = { stage: 'ProcessProbe', status: 'CHECKS_OK_NOT_ACCEPTED', sid: secondUserSid, installDirectory: path.dirname(installed), problems: [], processes: { application: [item], engine: [{ ...item, id: 124 }], processHost: [{ ...item, id: 125 }] } };
  assert.doesNotThrow(() => assertProcessProbe(probe, installed, main, observed, secondUserSid, 2));
  assert.throws(() => assertProcessProbe({ ...probe, processes: { ...probe.processes, application: [{ ...item, id: observed.parentId }] } }, installed, main, observed, secondUserSid, 2), /actual Electron main PID/);
  assert.throws(() => assertProcessProbe({ ...probe, processes: { ...probe.processes, application: [{ ...item, started: '2026-10-14T00:00:01.000Z' }] } }, installed, main, observed, secondUserSid, 2), /creation identity/);
  assert.throws(() => assertProcessProbe({ ...probe, processes: { ...probe.processes, processHost: [] } }, installed, main, observed, secondUserSid, 2), /Missing real installed/);
  assert.throws(() => assertProcessProbe({ ...probe, status: 'BLOCKED' }, installed, main, observed, secondUserSid, 2));
});

test('actual Electron main identity is independent of the Windows launcher PID and retains native ownership gates', () => {
  const installed = path.resolve('fixture/install/ForgeDesk.exe');
  const main = { pid: 24596, execPath: installed, type: 'browser', platform: 'win32' };
  const observed = { id: main.pid, parentId: 26932, name: 'ForgeDesk.exe', execPath: installed, created: '2026-10-14T00:00:00.000Z', sid: secondUserSid, sessionId: 2, ownerQueryStatus: 0 };
  assert.notEqual(main.pid, observed.parentId, 'Regression reproduces the independently observed shell wrapper PID difference');
  assert.doesNotThrow(() => assertInstalledMainProcess(observed, main, installed, secondUserSid, 2));
  for (const change of [{ pid: observed.parentId }, { pid: 0 }, { execPath: path.resolve('fixture/other/ForgeDesk.exe') }, { type: 'renderer' }, { type: 'utility' }, { platform: 'linux' }]) {
    assert.throws(() => assertInstalledMainProcess(observed, { ...main, ...change }, installed, secondUserSid, 2));
  }
  for (const change of [{ id: observed.parentId }, { execPath: path.resolve('fixture/other/ForgeDesk.exe') }, { name: 'cmd.exe' }, { sid: secondUserSid.replace(/1006$/, '1002') }, { sessionId: 1 }, { ownerQueryStatus: 5 }, { created: 'invalid' }]) {
    assert.throws(() => assertInstalledMainProcess({ ...observed, ...change }, main, installed, secondUserSid, 2));
  }
  assert.throws(() => assertInstalledMainProcess(null, main, installed, secondUserSid, 2));
  assert.throws(() => assertElectronMainIdentity({ ...main, type: 'renderer' }, installed), /Electron main process/);
});

test('launcher normal exit cannot prove a surviving native main process closed', () => {
  const installed = path.resolve('fixture/install/ForgeDesk.exe');
  const native = { id: 24596, parentId: 26932, name: 'ForgeDesk.exe', execPath: installed, created: '2026-10-14T00:00:00.000Z', sid: secondUserSid, sessionId: 2, ownerQueryStatus: 0 };
  assert.throws(() => assertElectronMainExited(native, { ...native }), /launcher exit alone/);
  assert.throws(() => assertElectronMainExited(native, { ...native, execPath: path.resolve('fixture/other/ForgeDesk.exe') }), /launcher exit alone/);
  assert.throws(() => assertElectronMainExited(native, { ...native, id: native.parentId }));
  assert.throws(() => assertElectronMainExited(native, { ...native, created: 'invalid' }));
  assert.doesNotThrow(() => assertElectronMainExited(native, null));
  assert.doesNotThrow(() => assertElectronMainExited(native, { ...native, created: '2026-10-14T00:01:00.000Z' }));
});

test('native process query rejects invalid PID interpolation', () => {
  for (const pid of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => nativeMainProcessQuery(pid));
  assert.match(nativeMainProcessQuery(123), /if\(\$null -eq \$result\)\{'null'\}else\{ConvertTo-Json/);
});

test('Windows PowerShell 5.1 native query emits JSON for a live PID and literal null for an absent PID', { skip: process.platform !== 'win32' }, async () => {
  const execute = promisify(execFile);
  const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const options = { windowsHide: true, shell: false, timeout: 15000, encoding: 'utf8' as const };
  const version = (await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], options)).stdout.trim();
  assert.match(version, /^5\.1\./, 'This regression must exercise Windows PowerShell 5.1, not a newer JSON serializer');
  const liveText = (await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(process.pid)], options)).stdout.trim();
  const live = JSON.parse(liveText);
  assert.equal(live.id, process.pid); assert.equal(live.execPath.toLowerCase(), process.execPath.toLowerCase());
  assert.equal(live.ownerQueryStatus, 0); assert.ok(Number.isFinite(Date.parse(live.created)));
  const absentPid = 2147483647;
  const absentText = (await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(absentPid)], options)).stdout.trim();
  assert.equal(absentText, 'null'); assert.equal(JSON.parse(absentText), null);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = path.join(root, 'output/second-user-selftest', `native-main-query-${Date.now()}`);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ scope: 'Primary-user native PID query regression; not product or second-user acceptance', productStarted: false, modelInvoked: false, authenticationRead: false, powershellVersion: version, live, absentPid, absentOutput: absentText, result: 'passed' }, null, 2));
});

test('diagnostic export must contain the actual substituted synthetic line and only allowed fields', () => {
  const valid = { schemaVersion: 1, version: '0.2.1', engineState: 'ready', engineError: '', platform: 'win32', arch: 'x64', diagnostics: ['fixture-marker-password=[redacted]'] };
  assert.doesNotThrow(() => assertDiagnosticsExport(valid, 'fixture-marker', 'fixture-synthetic-only'));
  assert.throws(() => assertDiagnosticsExport({ ...valid, diagnostics: [] }, 'fixture-marker', 'fixture-synthetic-only'), /exact synthetic failure log/);
  assert.throws(() => assertDiagnosticsExport({ ...valid, diagnostics: ['fixture-marker-password=fixture-synthetic-only'] }, 'fixture-marker', 'fixture-synthetic-only'), /Synthetic secret/);
  assert.throws(() => assertDiagnosticsExport({ ...valid, auth: {} }, 'fixture-marker', 'fixture-synthetic-only'));
});

const routingTimeout = "page.evaluate: Error: Error invoking remote method 'forgedesk:invoke': Error: Engine account/read: workspace routing discovery timed out";
const startupState = (overrides: Partial<AppSnapshot> = {}): AppSnapshot => ({ schemaVersion: 1, version: '0.2.1', projects: [], sessions: [],
  engine: { state: 'ready', executable: 'fixture/codex.exe', home: 'fixture/engine' }, account: { loggedIn: true, label: 'private-account-label' },
  models: [{ id: 'fixture-model', label: 'private-model-label' }], approvals: [], tasks: [], diagnostics: [], hardware: { enabled: false, reason: 'software only' }, dataDir: 'fixture/data', ...overrides });

test('startup recovers only the exact returned routing timeout once after a sequential five-second delay', async () => {
  let calls = 0; let inFlight = false; let reads = 0; const waits: number[] = []; const observations: any[] = [];
  const result = await connectControlsStartup({
    snapshot: async () => startupState({ account: { loggedIn: reads++ < 3 ? false : true, label: 'private-account-label' } }),
    connect: async () => { assert.equal(inFlight, false); inFlight = true; try { await Promise.resolve(); if (++calls === 1) throw new Error(routingTimeout); } finally { inFlight = false; } },
    wait: async ms => { assert.equal(inFlight, false, 'A pending connect must never overlap the retry'); waits.push(ms); },
    observe: async item => { observations.push(item); },
  });
  assert.equal(result.account.loggedIn, true); assert.equal(calls, 2); assert.deepEqual(waits, [5000]);
  assert.deepEqual(observations.map(item => item.phase), ['before', 'failed', 'before', 'completed']);
  assert.equal(observations[1].error, routingTimeout); assert.deepEqual(observations.map(item => item.attempt), [1, 1, 2, 2]);
});

test('startup exhaustion preserves both failures and throws the actual second error without a third attempt', async () => {
  const first = new Error(routingTimeout); const second = new Error(routingTimeout); let calls = 0; const waits: number[] = []; const observations: any[] = [];
  await assert.rejects(connectControlsStartup({ snapshot: async () => startupState(), connect: async () => { throw ++calls === 1 ? first : second; }, wait: async ms => { waits.push(ms); }, observe: async item => { observations.push(item); } }), error => error === second);
  assert.equal(calls, 2); assert.deepEqual(waits, [5000]); assert.equal(observations.filter(item => item.phase === 'failed').length, 2);
});

test('startup does not retry login, other timeouts, model-list, transport or merely similar routing errors', async () => {
  for (const message of ['Engine account/read: login required', 'Engine account/read timed out', 'Engine models/list: workspace routing discovery timed out', 'transport closed', `${routingTimeout}!`, `prefix ${routingTimeout}`]) {
    const original = new Error(message); let calls = 0; const waits: number[] = [];
    await assert.rejects(connectControlsStartup({ snapshot: async () => startupState(), connect: async () => { calls++; throw original; }, wait: async ms => { waits.push(ms); }, observe: async () => {} }), error => error === original);
    assert.equal(calls, 1, message); assert.deepEqual(waits, [], message);
  }
});

test('startup refuses unsafe engine, any foreign uncertain or busy session, approval and runner operation', async () => {
  const foreign = { ...session(), id: 'foreign-session', status: 'completed', turnId: undefined };
  const blocked: AppSnapshot[] = [startupState({ engine: { state: 'failed', executable: 'fixture', home: 'fixture' } }),
    startupState({ sessions: [{ ...foreign, engineUncertain: true }] }),
    startupState({ sessions: [{ ...foreign, turnId: 'unexpected-live-turn' }] }),
    ...['running', 'stopping'].map(status => startupState({ sessions: [{ ...foreign, status }] })),
    startupState({ approvals: [approval()] }),
    startupState({ tasks: [{ id: 'foreign-task', status: 'running', acceptance: [], evidence: [], operations: [] }] }),
    ...['prepared', 'running', 'stopping'].map(status => startupState({ tasks: [{ id: 'foreign-task', status: 'verifying', acceptance: [], evidence: [], operations: [{ id: 'foreign-operation', status }] }] })),
  ];
  for (const state of blocked) {
    let calls = 0; const observations: any[] = [];
    await assert.rejects(connectControlsStartup({ snapshot: async () => state, connect: async () => { calls++; }, wait: async () => assert.fail('Busy startup must not wait or repair'), observe: async item => { observations.push(item); } }), /Startup connect requires a ready, idle engine/);
    assert.equal(calls, 0); assert.deepEqual(observations.map(item => item.phase), ['before', 'blocked']);
  }
});

test('startup checks all safety gates again after the retry delay and does not fix a newly busy old task', async () => {
  let calls = 0; let delayed = false; const observations: any[] = [];
  await assert.rejects(connectControlsStartup({ snapshot: async () => startupState(delayed ? { sessions: [{ ...session(), id: 'foreign-session', engineUncertain: true }] } : {}),
    connect: async () => { calls++; throw new Error(routingTimeout); }, wait: async ms => { assert.equal(ms, 5000); delayed = true; }, observe: async item => { observations.push(item); } }), /Startup connect requires a ready, idle engine/);
  assert.equal(calls, 1); assert.deepEqual(observations.map(item => item.phase), ['before', 'failed', 'before', 'blocked']);
  assert.equal(observations.at(-1).summary.busy.uncertainSessions, 1);
});

test('startup evidence is a redacted whitelist and successful logged-out state still fails the unchanged final login gate', async () => {
  const privateValue = 'synthetic-private-value'; const observations: any[] = []; let calls = 0;
  const state = startupState({ engine: { state: 'ready', executable: 'fixture', home: 'fixture', error: `password=${privateValue}` },
    account: { loggedIn: false, label: 'private-account-label' }, sessions: [{ ...session(), status: 'completed', turnId: undefined, messages: [{ id: 'private-message', role: 'user', text: privateValue, timestamp: 'fixture' }] }], diagnostics: [privateValue] });
  await assert.rejects(async () => {
    const result = await connectControlsStartup({ snapshot: async () => state, connect: async () => { calls++; }, wait: async () => assert.fail('Successful logged-out result must not trigger a login or retry'), observe: async item => { observations.push(item); } });
    assert.equal(result.account.loggedIn, true);
  });
  assert.equal(calls, 1);
  const exported = JSON.stringify(observations);
  assert.equal(exported.includes(privateValue), false); assert.equal(exported.includes('private-account-label'), false); assert.equal(exported.includes('private-model-label'), false); assert.equal(exported.includes('private-message'), false);
  assert.ok(exported.includes('[REDACTED]')); assert.deepEqual(Object.keys(observations[0].summary).sort(), ['engineError', 'engineState', 'publicLoggedIn', 'modelCount', 'modelIds', 'busy'].sort());
});

const stopCreated = '2026-10-14T00:00:00.000Z';
const stopTime = (offset: number) => new Date(Date.parse(stopCreated) + offset).toISOString();
test('stop observation after the 45-second natural completion cannot pass', () => {
  assert.throws(() => assertStopObservationTiming(stopCreated, stopTime(1000), stopTime(45000)), /before.*40-second/);
});
test('stop observation rejects the conservative 40-second boundary for click or disappearance', () => {
  assert.throws(() => assertStopObservationTiming(stopCreated, stopTime(1000), stopTime(40000)), /before.*40-second/);
  assert.throws(() => assertStopObservationTiming(stopCreated, stopTime(40000), stopTime(40000)), /before.*40-second/);
});
test('stop observation rejects invalid or reversed timestamps', () => {
  for (const [created, clicked, observed] of [['invalid', stopTime(1000), stopTime(2000)], [stopCreated, 'invalid', stopTime(2000)], [stopCreated, stopTime(1000), 'invalid'],
    [stopCreated, stopTime(-1), stopTime(2000)], [stopCreated, stopTime(2000), stopTime(1000)]]) {
    assert.throws(() => assertStopObservationTiming(created, clicked, observed), /valid chronological/);
  }
  assert.throws(() => stopObservationDeadline('invalid'), /valid/);
});
test('stop observation accepts genuine early native disappearance independently of later IPC completion', () => {
  assert.equal(stopObservationDeadline(stopCreated), Date.parse(stopCreated) + 40000);
  assert.doesNotThrow(() => assertStopObservationTiming(stopCreated, stopTime(1000), stopTime(2000)));
  assert.doesNotThrow(() => assertStopObservationTiming(stopCreated, stopTime(1000), stopTime(39999)));
});
