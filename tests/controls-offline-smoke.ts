import assert from 'node:assert/strict';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSnapshot, Session } from '../packages/shared/contracts';
import { assertDiagnosticsExport, assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess,
  assertMcpDenialApproval, assertWaitCommand, connectControlsStartup, nativeMainProcessQuery, refusedMcpItem,
  type ElectronMainIdentity, type InstalledMainProcess } from './helpers/second-user-controls';
import { redact } from '../packages/engineering-runner/redaction';
import { installControlsStopObserver, readControlsStopObserver, restoreControlsStopObserver, assertControlsStopReceipt } from './helpers/controls-stop-observer';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { primarySid } from './helpers/snapshot-smoke-scope';

assert.equal(process.platform, 'win32', 'Offline controls use the actual Windows Job Object helper');
const invokingIdentity = await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { shell: false, windowsHide: true, timeout: 10000 });
assert.equal(invokingIdentity.stdout.trim(), primarySid, 'Offline controls must run under the primary SID, never the paused second account');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'output/second-user-selftest'); await mkdir(base, { recursive: true });
const runId = `snapshot-${Date.now()}`;
const output = await mkdtemp(path.join(base, `controls-offline-${Date.now()}-`));
const fixtureApp = path.join(output, 'fixture-app'); const dataDir = path.join(output, 'private-data');
const workspace = path.join(output, 'workspace'); const journal = path.join(output, 'fake-server.jsonl');
const controlFile = journal + '.controls.json';
const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const executable = path.join(root, 'node_modules/electron/dist/electron.exe');
const execute = promisify(execFile); const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const report: Record<string, any> = { schemaVersion: 1, runId, scope: 'Main SID offline development GUI/protocol fixture only',
  command: 'npx tsx tests/controls-offline-smoke.ts',
  invokingSid: invokingIdentity.stdout.trim(),
  realModel: false, realAuthentication: false, secondUser: false, installedAcceptance: false, networkModelRequests: false,
  accountSource: 'Synthetic fake app-server response, explicitly not a user login', output, dataDir, workspace,
  startedAt: new Date().toISOString(), controls: {}, failures: [], pageErrors: [], launches: [], closes: [],
  limitations: ['Does not prove a real model follows the prompts', 'Does not prove remote service availability, real login, installed package hashes or second-SID acceptance',
    'One test-only adapter process factory and a controlled reload IPC timing gate; all other application components are production source',
    'Shell approvals are synthetic app-server requests for a fixed harmless command inside the native Job tree, not proof of real Codex sandbox or model approval behavior'],
  earlierFixtureRuns: [{ run: 'controls-offline-1791996822753-gTZFJZ', result: 'failed', reason: 'First reload gate missed the second React StrictMode snapshot response' },
    { run: 'controls-offline-1791996969316-3eXUdA', result: 'control chain passed but not final isolation screenshots',
      limitation: 'Missing fixture Git HEAD made production diff discover shared parent repository; final fixture has independent repo/config/hooks' }] };
let app: ElectronApplication | undefined; let page: Page | undefined; let launcher: ChildProcess | undefined;
let main: ElectronMainIdentity | undefined; let nativeMain: InstalledMainProcess | undefined;
const ownedSessions: string[] = [];
const waitingIdentities: InstalledMainProcess[] = [];

function sanitized(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:token|secret|password|credential|authorization|api.?key)/i.test(key) ? '[REDACTED]' : sanitized(item)]));
  return value;
}
async function evidence() { await writeFile(path.join(output, 'evidence.json'), JSON.stringify(sanitized(report), null, 2)); }
async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
function session(state: AppSnapshot, id: string): Session { const value = state.sessions.find(item => item.id === id); assert.ok(value); return value; }
async function waitFor(predicate: (state: AppSnapshot) => boolean, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await snapshot(); if (predicate(value)) return value; await pause(100); }
  throw new Error('Offline GUI observation timed out; no completion is fabricated');
}
async function nativeProcess(pid: number) {
  const { stdout } = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { shell: false, windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout.trim()) as InstalledMainProcess | null;
}
async function journalRows() {
  try { return (await readFile(journal, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
async function noAuthenticationFiles() {
  const walk = async (directory: string): Promise<string[]> => {
    const files: string[] = [];
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name); const stat = await lstat(filename);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) files.push(...await walk(filename)); else files.push(path.relative(dataDir, filename));
    }
    return files;
  };
  const files = await walk(dataDir);
  assert.equal(files.some(name => /(?:^|[\\/])(?:auth\.json|credentials|login|tokens?)(?:[\\/.]|$)/i.test(name)), false);
  return files.filter(name => !name.includes('Cache')).slice(0, 100);
}
async function capture(name: string) { await page!.screenshot({ path: path.join(output, `${name}.png`) }); }

async function buildFixture() {
  await mkdir(path.join(fixtureApp, 'dist/main'), { recursive: true }); await mkdir(dataDir); await mkdir(workspace);
  await writeFile(path.join(workspace, 'numbers.mjs'), 'export function average(values){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0;}\n');
  const emptyConfig = path.join(output, 'empty-git-config'); await writeFile(emptyConfig, '');
  const emptyHooks = path.join(output, 'empty-git-hooks'); await mkdir(emptyHooks);
  const gitEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  await execute('git', ['-c', `init.templateDir=${emptyHooks}`, 'init', workspace], { env: gitEnv, windowsHide: true, shell: false });
  await execute('git', ['-C', workspace, '-c', `core.hooksPath=${emptyHooks}`, 'add', 'numbers.mjs'], { env: gitEnv, windowsHide: true, shell: false });
  await execute('git', ['-C', workspace, '-c', `core.hooksPath=${emptyHooks}`, '-c', 'user.name=Offline fixture', '-c', 'user.email=offline@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'Isolated fixture baseline'], { env: gitEnv, windowsHide: true, shell: false });
  const top = await execute('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { env: gitEnv, windowsHide: true, shell: false });
  assert.equal(path.resolve(top.stdout.trim()).toLowerCase(), workspace.toLowerCase());
  report.gitScope = { topLevel: path.resolve(top.stdout.trim()), independentFixtureHead: true, globalAndSystemConfigReplacedByOwnedEmptyFile: true, hooksAndTemplatesDisabled: true };
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  assert.equal(version, '0.2.1', 'Shared diagnostic assertions are intentionally pinned to the current product version');
  await writeFile(path.join(fixtureApp, 'package.json'), JSON.stringify({ name: 'controls-offline-fixture', version, main: 'dist/main/bootstrap.cjs' }));
  const mainSource = path.join(root, 'apps/desktop/main/index.ts');
  const fixtureAdapter = path.join(root, 'tests/fixtures/controls-offline-adapter.ts');
  const built = await build({ entryPoints: [mainSource], outfile: path.join(fixtureApp, 'dist/main/production.cjs'), bundle: true,
    platform: 'node', format: 'cjs', external: ['electron'], metafile: true, plugins: [{ name: 'offline-process-factory-only', setup(builder) {
      builder.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/packages\/engine-adapter$/ }, args => {
        assert.equal(path.resolve(args.importer), mainSource);
        return { path: fixtureAdapter };
      });
    } }] });
  await copyFile(path.join(root, 'tests/fixtures/controls-offline-bootstrap.cjs'), path.join(fixtureApp, 'dist/main/bootstrap.cjs'));
  await build({ entryPoints: [path.join(root, 'apps/desktop/preload/index.ts')], outfile: path.join(fixtureApp, 'dist/preload/index.cjs'),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  await build({ entryPoints: [path.join(root, 'apps/desktop/renderer/index.tsx')], outfile: path.join(fixtureApp, 'dist/renderer/index.js'),
    bundle: true, platform: 'browser', format: 'esm', loader: { '.png': 'file', '.svg': 'file' } });
  await copyFile(path.join(root, 'apps/desktop/renderer/index.html'), path.join(fixtureApp, 'dist/renderer/index.html'));
  await cp(path.join(root, 'apps/desktop/renderer/assets'), path.join(fixtureApp, 'dist/renderer/assets'), { recursive: true });
  await build({ entryPoints: [path.join(root, 'packages/engineering-mcp/index.ts')], outfile: path.join(fixtureApp, 'dist/mcp/index.cjs'),
    bundle: true, platform: 'node', format: 'cjs' });
  await mkdir(path.join(fixtureApp, 'vendor/process-host'), { recursive: true });
  await copyFile(path.join(root, 'vendor/process-host/process-host.exe'), path.join(fixtureApp, 'vendor/process-host/process-host.exe'));
  await cp(path.join(root, 'engineering/templates/node-software-v1'), path.join(fixtureApp, 'engineering/templates/node-software-v1'), { recursive: true });
  report.provenance = { fixtureMainSha256: hash(await readFile(path.join(fixtureApp, 'dist/main/production.cjs'))),
    productionMainSourceSha256: hash(await readFile(mainSource)), adapterFixtureSha256: hash(await readFile(fixtureAdapter)),
    appServerFixtureSha256: hash(await readFile(path.join(root, 'tests/fixtures/controls-offline-app-server.mjs'))),
    processHostSha256: hash(await readFile(path.join(fixtureApp, 'vendor/process-host/process-host.exe'))),
    testScriptSha256: hash(await readFile(fileURLToPath(import.meta.url))), mainInputs: Object.keys(built.metafile.inputs),
    helperSha256: Object.fromEntries(await Promise.all(['tests/helpers/second-user-controls.ts', 'tests/helpers/controls-stop-observer.ts',
      'tests/helpers/normal-close-observation.ts', 'tests/helpers/snapshot-smoke-scope.ts',
      'tests/fixtures/controls-offline-bootstrap.cjs'].map(async filename => [filename, hash(await readFile(path.join(root, filename)))]))) };
  assert.ok(report.provenance.mainInputs.some((name: string) => name.endsWith('packages/engine-adapter/index.ts')));
  assert.ok(report.provenance.mainInputs.some((name: string) => name.endsWith('packages/engineering-runner/index.ts')));
  assert.ok(report.provenance.mainInputs.some((name: string) => name.endsWith('packages/engineering-mcp/index.ts')));
}

async function launch() {
  const env: Record<string, string> = {};
  const sourceEnvironment = { ...process.env, GIT_DIR: path.join(output, 'unused-ambient-git-route'), GIT_WORK_TREE: path.join(output, 'unused-ambient-git-worktree'),
    GIT_INDEX_FILE: path.join(output, 'unused-ambient-index'), GIT_COMMON_DIR: path.join(output, 'unused-ambient-git-common') };
  for (const [key, value] of Object.entries(sourceEnvironment)) if (value !== undefined && !/(?:CODEX|OPENAI|CHATGPT|ANTHROPIC|CLAUDE|TOKEN|SECRET|PASSWORD|API.?KEY|CREDENTIAL)|^(?:FORGEDESK_|ELECTRON_|NODE_OPTIONS|GIT_)/i.test(key)) env[key] = value;
  Object.assign(env, { FORGEDESK_DATA_DIR: dataDir, FORGEDESK_CODEX_PATH: process.execPath,
    GIT_CONFIG_GLOBAL: path.join(output, 'empty-git-config'), GIT_CONFIG_SYSTEM: path.join(output, 'empty-git-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    FORGEDESK_OFFLINE_NODE: process.execPath, FORGEDESK_OFFLINE_SERVER: path.join(root, 'tests/fixtures/controls-offline-app-server.mjs'), FORGEDESK_OFFLINE_JOURNAL: journal });
  app = await electron.launch({ executablePath: executable, args: [fixtureApp], cwd: fixtureApp, env, timeout: 30000 });
  launcher = app.process();
  main = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: process.type, platform: process.platform }));
  report.electronVersion = await app.evaluate(() => process.versions.electron);
  assert.equal(report.electronVersion, '44.7.2');
  assertElectronMainIdentity(main, executable);
  nativeMain = (await nativeProcess(main.pid))!; assert.ok(nativeMain);
  assertInstalledMainProcess(nativeMain, main, executable, nativeMain.sid, nativeMain.sessionId);
  page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.route(/^https?:\/\//, route => { report.failures.push('Unexpected network request in offline fixture: ' + route.request().url()); return route.abort(); });
  await page.locator('.app-header').waitFor(); await page.setViewportSize({ width: 1360, height: 900 });
  const initial = await waitFor(state => state.engine.state === 'ready' && state.account.label.includes('OFFLINE-FIXTURE'));
  assert.equal(initial.dataDir, dataDir); assert.equal(initial.engine.home, path.join(dataDir, 'engine'));
  assert.equal(initial.engine.executable, process.execPath, 'The offline entry must never point to real Codex');
  const gitRouting = await app.evaluate(() => ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].map(key => process.env[key] ?? null));
  assert.deepEqual(gitRouting, [null, null, null, null]);
  report.gitScope.injectedAmbientRoutingRemovedInActualElectron = true;
  assert.equal(initial.hardware.enabled, false); assert.equal(await page.evaluate(() => typeof (window as any).require), 'undefined');
  report.launches.push({ main, nativeMain, launcherPid: launcher.pid, privateHome: initial.engine.home, syntheticAccount: initial.account });
  await noAuthenticationFiles(); await evidence();
  return initial;
}

async function ownedEngineIdentities() {
  const rows = await journalRows(); const pid = rows.filter(row => row.kind === 'fixture-start').at(-1)?.fakeServerPid;
  assert.ok(Number.isInteger(pid)); const server = await nativeProcess(pid); assert.ok(server);
  const host = await nativeProcess(server.parentId); assert.ok(host);
  assert.equal(path.resolve(host.execPath).toLowerCase(), path.join(fixtureApp, 'vendor/process-host/process-host.exe').toLowerCase());
  assert.equal(server.sid, nativeMain!.sid); assert.equal(host.sid, nativeMain!.sid);
  return [server, host];
}

async function closeApp() {
  if (!app) return;
  const current = app; const savedMain = nativeMain!; const savedLauncher = launcher!;
  const engineBefore = await ownedEngineIdentities();
  for (const child of engineBefore) assert.throws(() => assertElectronMainExited(child, child), /creation identity to disappear/);
  assert.equal(savedLauncher.exitCode, null); assert.equal(savedLauncher.signalCode, null);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => savedLauncher.once('close', (code, signal) => resolve({ code, signal })));
  const closeRequest = observeNormalCloseRequest(current.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); }), 5000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Offline native window close exceeded 30 seconds')), 30000); })]);
    assert.equal(exit.code, 0); assert.equal(exit.signal, null);
    assertElectronMainExited(savedMain, await nativeProcess(savedMain.id));
    for (const child of engineBefore) assertElectronMainExited(child, await nativeProcess(child.id));
    const closeRecord: Record<string, any> = { main: savedMain, engineBefore, exit, nativeMainAndOwnedEngineIdentitiesAbsent: true,
      negativeGuardOwnedChildStillAliveRejected: true, forcedKill: false };
    report.closes.push(closeRecord);
    const nativeObservation = await closeRequest;
    closeRecord.nativeWindowCloseObservation = nativeObservation.state === 'rejected'
      ? { state: nativeObservation.state, error: redact(String(nativeObservation.error)) } : nativeObservation;
    await evidence();
    assert.notEqual(nativeObservation.state, 'timed-out', 'An unobserved close request must not be called normal close');
    const playwrightObservation = await observeNormalCloseRequest(current.close(), 5000);
    closeRecord.playwrightCloseObservation = playwrightObservation.state === 'rejected'
      ? { state: playwrightObservation.state, error: redact(String(playwrightObservation.error)) } : playwrightObservation;
    await evidence();
    assert.equal(playwrightObservation.state, 'acknowledged', 'Playwright cleanup must finish within its own bounded observation');
    app = undefined; page = undefined;
  } finally { if (timer) clearTimeout(timer); }
}

async function newSession(projectId: string, title: string) {
  const value = await page!.evaluate(({ projectId, title }) => window.forgeDesk.createSession(projectId, title), { projectId, title });
  ownedSessions.push(value.id); await page!.getByRole('button', { name: new RegExp(title) }).click(); return value;
}
async function sendFixture(input: Record<string, unknown>) {
  await page!.getByRole('textbox', { name: '任务指令', exact: true }).fill(JSON.stringify(input));
  await page!.getByRole('combobox', { name: '模型', exact: true }).selectOption('offline-fixture-not-a-model');
  await page!.getByRole('button', { name: '发送任务', exact: true }).click();
}

async function shellApprovalScenario(projectId: string, decision: 'accept' | 'cancel') {
  const current = await newSession(projectId, `Offline shell ${decision} ${runId}`);
  const marker = `qa-controls-shell-${decision}-${runId}`;
  const sourceBefore = hash(await readFile(path.join(workspace, 'numbers.mjs')));
  await sendFixture({ kind: `shell-${decision}`, marker });
  const pending = await waitFor(state => state.approvals.length === 1);
  const approval = pending.approvals[0]; const params = approval.params as Record<string, any>;
  assert.equal(approval.method, 'item/commandExecution/requestApproval');
  assert.equal(params.threadId, session(pending, current.id).threadId); assert.equal(params.turnId, session(pending, current.id).turnId);
  assert.equal(params.command, `Write-Output '${marker}'`); assert.equal(params.cwd, workspace);
  assert.deepEqual(approval.decisions, ['accept', 'cancel']);
  assert.equal(approval.id, decision === 'accept' ? 7 : '7');
  assert.equal(pending.tasks.find(task => task.id === current.taskId)!.operations.length, 0);
  assert.equal((await journalRows()).some(row => row.kind === 'shell-command-started' && row.marker === marker), false);
  const wrongTypedId = typeof approval.id === 'number' ? String(approval.id) : Number(approval.id);
  await assert.rejects(page!.evaluate(({ generation, id }) => window.forgeDesk.approve(generation, id, 'accept'),
    { generation: approval.generation, id: wrongTypedId }), /no longer pending/);
  await assert.rejects(page!.evaluate(({ generation, id }) => window.forgeDesk.approve(generation - 1, id, 'accept'),
    { generation: approval.generation, id: approval.id }), /expired/);
  await assert.rejects(page!.evaluate(({ generation, id }) => window.forgeDesk.approve(generation, id, 'acceptForSession'),
    { generation: approval.generation, id: approval.id }), /not allowed/);
  assert.equal((await snapshot()).approvals.length, 1);
  await page!.locator('.approval').waitFor({ state: 'visible' }); await capture(`shell-${decision}-before-reload`);
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.arm());
  await page!.reload(); await page!.locator('.app-header').waitFor();
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.captured());
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.allowOneDirectSnapshot());
  const refreshed = await snapshot(); assert.equal(refreshed.approvals.length, 1);
  assert.deepEqual(refreshed.approvals[0], approval);
  assert.equal(await page!.locator('.approval').count(), 0);
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.release());
  const card = page!.locator('.approval'); await card.waitFor({ state: 'visible' }); assert.equal(await card.count(), 1);
  await capture(`shell-${decision}-after-delayed-reload`);
  await card.getByRole('button', { name: decision === 'accept' ? '允许本次' : '取消', exact: true }).click();
  const expectedStatus = decision === 'accept' ? 'completed' : 'interrupted';
  const terminal = await waitFor(state => session(state, current.id).status === expectedStatus && !session(state, current.id).turnId && state.approvals.length === 0);
  const rows = await journalRows();
  const actualResponses = rows.filter(row => row.kind === 'client-response' && typeof row.id === typeof approval.id && row.id === approval.id);
  assert.equal(actualResponses.length, 1); assert.deepEqual(actualResponses[0].result, { decision });
  const received = rows.filter(row => row.kind === 'shell-decision-received' && row.marker === marker);
  assert.equal(received.length, 1); assert.equal(received[0].decision, decision);
  const events = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const resolved = events.filter(item => item.method === 'engine/approvalResolved' && item.generation === approval.generation &&
    typeof item.params.id === typeof approval.id && item.params.id === approval.id && item.params.decision === decision);
  assert.equal(resolved.length, 1);
  const completedItems = events.filter(item => item.method === 'item/completed' && item.params.threadId === params.threadId &&
    item.params.turnId === params.turnId && item.params.item.id === params.itemId).map(item => item.params.item);
  assert.equal(completedItems.length, 1);
  const started = rows.filter(row => row.kind === 'shell-command-started' && row.marker === marker);
  const completed = rows.filter(row => row.kind === 'shell-command-completed' && row.marker === marker);
  if (decision === 'accept') {
    assert.equal(started.length, 1); assert.equal(completed.length, 1);
    assert.ok(Number.isInteger(started[0].childPid) && started[0].childPid > 0);
    assert.equal(completed[0].childPid, started[0].childPid); assert.equal(completed[0].exitCode, 0); assert.equal(completed[0].signal, null);
    assert.equal(completed[0].timedOut, false); assert.equal(completed[0].spawnError, undefined);
    assert.equal(completed[0].stdout.trim(), marker); assert.equal(completed[0].stderr, '');
    assert.equal(completedItems[0].status, 'completed'); assert.equal(completedItems[0].aggregatedOutput.trim(), marker);
    assert.equal(completedItems[0].exitCode, 0);
  } else {
    assert.equal(started.length, 0); assert.equal(completed.length, 0);
    const cancelled = rows.filter(row => row.kind === 'shell-command-cancelled' && row.marker === marker);
    assert.equal(cancelled.length, 1); assert.equal(cancelled[0].commandStarted, false);
    assert.equal(completedItems[0].status, 'declined'); assert.equal(completedItems[0].processId, null);
    assert.equal(completedItems[0].exitCode, null); assert.equal(completedItems[0].aggregatedOutput, '');
  }
  const tools = session(terminal, current.id).messages.filter(message => message.role === 'tool');
  assert.equal(tools.length, 1); assert.equal(tools[0].id, params.itemId); assert.equal(tools[0].status, completedItems[0].status);
  await assert.rejects(page!.evaluate(({ generation, id, decision }) => window.forgeDesk.approve(generation, id, decision),
    { generation: approval.generation, id: approval.id, decision }), /no longer pending/);
  const afterDuplicate = (await journalRows()).filter(row => row.kind === 'client-response' && typeof row.id === typeof approval.id && row.id === approval.id);
  assert.equal(afterDuplicate.length, 1);
  assert.equal(hash(await readFile(path.join(workspace, 'numbers.mjs'))), sourceBefore);
  assert.equal((await page!.evaluate(id => window.forgeDesk.diff(id), projectId)).text, '');
  assert.equal(terminal.tasks.find(task => task.id === current.taskId)!.operations.length, 0); assert.equal(terminal.hardware.enabled, false);
  report.shellApprovals ??= {};
  report.shellApprovals[decision] = { scope: 'Offline synthetic shell protocol, fixed harmless fixture command only', approval,
    exactClientResponse: actualResponses[0], publicApprovalResolved: resolved[0], actualCompletedItem: completedItems[0],
    nativeExecution: completed[0] ?? null, nativeExecutionCount: started.length, sourceUnchanged: true, runnerOperations: 0,
    rendererReloadRetainedBinding: true, wrongTypedIdRejected: true, expiredGenerationRejected: true, unsupportedDecisionRejected: true,
    duplicateDecisionRejectedWithoutResponse: true, finalSession: session(terminal, current.id) };
  report.controls[decision === 'accept' ? 'shellAccept' : 'shellCancel'] = 'passed';
  await capture(`shell-${decision}-completed`); await evidence();
}

async function productionMcpProbe() {
  const config = await readFile(path.join(dataDir, 'engine/config.toml'), 'utf8');
  const setting = (name: string): string => {
    const line = config.split(/\r?\n/).find(value => value.startsWith(`${name} = `)); assert.ok(line);
    const value: unknown = JSON.parse(line.slice(line.indexOf('=') + 1).trim()); assert.equal(typeof value, 'string'); return value as string;
  };
  const child = spawn(process.execPath, [path.join(fixtureApp, 'dist/mcp/index.cjs'), '--mcp-stdio'], {
    cwd: output, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      FORGEDESK_RUNNER_PIPE: setting('FORGEDESK_RUNNER_PIPE'), FORGEDESK_RUNNER_TOKEN: setting('FORGEDESK_RUNNER_TOKEN') },
  });
  try {
    const messages = await new Promise<any[]>((resolve, reject) => {
      let buffer = ''; const messages: any[] = [];
      const timer = setTimeout(() => reject(new Error('Offline production MCP protocol timed out')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', data => {
        buffer += data.toString(); if (buffer.length > 1024 * 1024) { clearTimeout(timer); reject(new Error('MCP output exceeded its bound')); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          try { messages.push(JSON.parse(buffer.slice(0, end))); } catch (error) { clearTimeout(timer); reject(error); return; }
          buffer = buffer.slice(end + 1);
          if (messages.length === 3) { clearTimeout(timer); resolve(messages); return; }
        }
      });
      for (const request of [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engineering.test', arguments: { taskId: 'offline-inactive-task', verifierId: 'qa-controls-verifier', requestKey: 'offline-mcp-inactive' } } },
      ]) child.stdin.write(JSON.stringify(request) + '\n');
    });
    assert.equal(messages[0].result.protocolVersion, '2024-11-05'); assert.equal(messages[1].result.tools.length, 7);
    assert.equal(messages[2].result.isError, true); assert.equal(messages[2].result.content[0].text, 'RUNNER_ERROR');
    report.productionMcpStdio = { scope: 'Real generated MCP stdio and private bridge, inactive-task rejection only', responses: messages, noVerifierExecution: true };
  } finally {
    const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('Owned fixture MCP failed to close')); }, 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
}

try {
  await buildFixture(); await launch(); await productionMcpProbe();
  await writeFile(controlFile, JSON.stringify({ phase: 'explicit-startup-routing-probe', remaining: 1 }));
  const observations: unknown[] = []; const actualErrors: unknown[] = [];
  await connectControlsStartup({ snapshot, connect: async () => {
    try { await page!.evaluate(() => window.forgeDesk.connect()); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const expected = 'Engine account/read: workspace routing discovery timed out';
      actualErrors.push({ message: redact(message), matchesStrictCurrentMatcher: [expected, `page.evaluate: Error: Error invoking remote method 'forgedesk:invoke': Error: ${expected}`].includes(message) });
      report.startupRouting = { observations, actualErrors, syntheticRpcError: true }; await evidence(); throw error;
    }
  }, wait: pause, observe: async value => { observations.push(value); report.startupRouting = { observations, actualErrors, syntheticRpcError: true }; await evidence(); } });
  assert.equal(actualErrors.length, 1); report.controls.startupRoutingRecovery = 'passed';
  await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, workspace);
  await page!.getByRole('button', { name: '导入项目', exact: true }).first().click();
  const imported = await waitFor(state => state.projects.length === 1); const project = imported.projects[0];
  assert.equal((await page!.evaluate(id => window.forgeDesk.diff(id), project.id)).text, '', 'Production diff must stay inside the clean fixture HEAD');
  const stopped = await newSession(project.id, `Offline stop ${runId}`); const marker = `qa-controls-wait-${runId}`;
  await sendFixture({ kind: 'wait', marker });
  await waitFor(state => session(state, stopped.id).status === 'running' && Boolean(session(state, stopped.id).turnId) && session(state, stopped.id).messages.some(message => message.role === 'tool' && message.text.includes(marker)));
  const beforeRows = await journalRows(); const wait = beforeRows.find(row => row.kind === 'wait-started'); assert.ok(wait);
  const waiting = await nativeProcess(wait.childPid); assert.ok(waiting); waitingIdentities.push(waiting);
  const { stdout } = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${waiting.id}').CommandLine`], { shell: false, windowsHide: true, timeout: 10000 });
  assertWaitCommand(stdout.trim(), marker);
  const engineBefore = await ownedEngineIdentities(); assert.equal(waiting.parentId, engineBefore[0].id);
  const deadline = Date.parse(waiting.created) + 40000; assert.ok(Date.now() < deadline - 10000, 'Stop must have a meaningful margin before natural 45-second completion');
  await app!.evaluate(installControlsStopObserver, { sessionId: stopped.id });
  await writeFile(controlFile, JSON.stringify({ phase: 'hold-stop-reconnect-account', released: false }));
  await capture('before-stop'); const clickedAt = new Date().toISOString();
  await page!.getByRole('button', { name: '停止当前回合', exact: true }).click();
  await waitFor(state => session(state, stopped.id).status === 'interrupted' && state.engine.state === 'ready' && !session(state, stopped.id).turnId, Math.max(1000, deadline - Date.now()));
  for (const identity of [waiting, ...engineBefore]) { assert.ok(Date.now() < deadline); assertElectronMainExited(identity, await nativeProcess(identity.id)); }
  assert.ok(Date.now() < deadline, 'Every observed disappearance must precede created+40s, not natural 45s completion');
  const absenceObservedAt = new Date().toISOString();
  const pendingStopReceipt = await app!.evaluate(readControlsStopObserver, { sessionId: stopped.id });
  assert.equal(pendingStopReceipt.calls.length, 1); assert.equal(pendingStopReceipt.calls[0].phase, 'started');
  await assert.rejects(page!.evaluate(id => window.forgeDesk.setAcceptance(id, []), stopped.taskId), /工程执行期间/);
  await writeFile(controlFile, JSON.stringify({ phase: 'hold-stop-reconnect-account', released: true }));
  let stopReceipt = await app!.evaluate(readControlsStopObserver, { sessionId: stopped.id });
  const stopReceiptDeadline = Date.now() + 10000;
  while (stopReceipt.calls[0]?.phase === 'started') {
    assert.ok(Date.now() < stopReceiptDeadline, 'Released Stop handler must finish before proceeding');
    await pause(50); stopReceipt = await app!.evaluate(readControlsStopObserver, { sessionId: stopped.id });
  }
  assertControlsStopReceipt(stopReceipt);
  await app!.evaluate(restoreControlsStopObserver, { sessionId: stopped.id });
  const afterRows = await journalRows(); assert.equal(afterRows.filter(row => row.kind === 'wait-started').length, 1);
  assert.equal(afterRows.some(row => row.kind === 'wait-natural-close'), false);
  report.stop = { waiting, engineBefore, clickedAt, observedAllAbsentAt: absenceObservedAt, deadline: new Date(deadline).toISOString(),
    pendingStopReceipt, stopReceipt, publicTerminalIsNotApiCompletion: true, setAcceptanceBlockedBeforeStopPromise: true,
    actualInterruptPromiseCompleted: true, manuallyKilled: false, naturalCompletionNotAccepted: true, session: session(await snapshot(), stopped.id) };
  report.controls.stop = 'passed'; await capture('after-stop'); await evidence();

  const denied = await newSession(project.id, `Offline refusal ${runId}`); const requestKey = `${runId}-offline-refusal`;
  const verifier = path.join(output, 'controls-verifier.mjs'); const forbiddenExecution = path.join(output, 'verifier-executed.marker');
  await writeFile(verifier, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(forbiddenExecution)},'should-never-run');\n`);
  await page!.evaluate(({ id, executable, verifier }) => window.forgeDesk.setAcceptance(id, [{ id: 'qa-controls-verifier', title: 'Offline refusal only', kind: 'automated',
    command: { executable, args: [verifier], timeoutMs: 10000 }, verifierFiles: [verifier] }]), { id: denied.taskId, executable: process.execPath, verifier });
  await sendFixture({ kind: 'mcp-refusal', taskId: denied.taskId, requestKey });
  const pending = await waitFor(state => state.approvals.length === 1); const approval = pending.approvals[0];
  assertMcpDenialApproval(approval, session(pending, denied.id), requestKey);
  assert.equal(pending.tasks.find(item => item.id === denied.taskId)!.operations.length, 0);
  await page!.locator('.approval').waitFor({ state: 'visible' }); await capture('mcp-before-reload');
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.arm());
  await page!.reload(); await page!.locator('.app-header').waitFor();
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.captured());
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.allowOneDirectSnapshot());
  const directWhileDelayed = await snapshot(); assert.equal(directWhileDelayed.approvals.length, 1);
  assert.equal(directWhileDelayed.approvals[0].generation, approval.generation); assert.equal(directWhileDelayed.approvals[0].id, approval.id);
  assertMcpDenialApproval(directWhileDelayed.approvals[0], session(directWhileDelayed, denied.id), requestKey);
  assert.equal(await page!.locator('.approval').count(), 0, 'Header plus a direct main snapshot is not renderer readiness');
  await app!.evaluate(() => (globalThis as any).__controlsOfflineTiming.release());
  const card = page!.locator('.approval'); await card.waitFor({ state: 'visible' }); assert.equal(await card.count(), 1);
  await capture('mcp-after-delayed-reload'); await card.getByRole('button', { name: '拒绝', exact: true }).click();
  const refused = await waitFor(state => session(state, denied.id).status === 'completed' && state.approvals.length === 0);
  const refusedItem = refusedMcpItem(session(refused, denied.id), requestKey);
  assert.equal(refused.tasks.find(item => item.id === denied.taskId)!.operations.length, 0);
  await assert.rejects(lstat(forbiddenExecution), { code: 'ENOENT' });
  const events = (await readFile(path.join(dataDir, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const resolved = events.filter(item => item.method === 'engine/approvalResolved' && item.generation === approval.generation && item.params.id === approval.id && item.params.decision === 'decline');
  assert.equal(resolved.length, 1);
  const refusalRows = await journalRows(); const responses = refusalRows.filter(row => row.kind === 'client-response');
  assert.equal(responses.length, 1); assert.equal(responses[0].id, 0); assert.deepEqual(responses[0].result, { action: 'decline', content: null, _meta: null });
  assert.equal(refusalRows.filter(row => row.kind === 'mcp-refused').length, 1);
  report.mcpRefusal = { approval, exactClientResponse: responses[0], publicApprovalResolved: resolved[0], refusedItem,
    delayedHeaderCardWasAbsent: true, visibleWaitAfterRelease: true, runnerOperations: 0, verifierNotExecuted: true };
  report.controls.mcpRefusal = 'passed'; report.controls.pendingApprovalReload = 'passed'; await capture('mcp-refused');

  await shellApprovalScenario(project.id, 'accept');
  await shellApprovalScenario(project.id, 'cancel');

  const logMarker = `qa-diagnostic-${runId}`; const syntheticSecret = `synthetic-only-${runId}`;
  const missing = path.join(workspace, `${logMarker}-password=${syntheticSecret}`);
  await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, missing);
  await assert.rejects(page!.evaluate(() => window.forgeDesk.importProject()));
  await app!.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' }); });
  assert.equal(await page!.evaluate(() => window.forgeDesk.exportDiagnostics()), null);
  const diagnostic = path.join(output, 'diagnostics.json');
  await app!.evaluate(({ dialog }, selected) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: selected }); }, diagnostic);
  await page!.getByRole('button', { name: '设置与诊断', exact: true }).click();
  await page!.getByRole('button', { name: '导出诊断', exact: true }).click();
  const diagnosticDeadline = Date.now() + 10000;
  while (true) { try { await lstat(diagnostic); break; } catch { assert.ok(Date.now() < diagnosticDeadline); await pause(50); } }
  const diagnosticText = await readFile(diagnostic, 'utf8'); assertDiagnosticsExport(JSON.parse(diagnosticText), logMarker, syntheticSecret);
  report.diagnostics = { sha256: hash(diagnosticText), actualProductionExport: true, cancelledSaveReturnedNull: true, syntheticValueRedacted: true };
  report.controls.diagnosticExport = 'passed'; await page!.getByRole('button', { name: '关闭设置', exact: true }).click();

  const beforeRestart = await snapshot(); const expected = ownedSessions.map(id => ({ id, status: session(beforeRestart, id).status, messageIds: session(beforeRestart, id).messages.map(item => item.id) }));
  const startsBefore = (await journalRows()).filter(row => row.kind === 'request' && row.method === 'turn/start').length;
  const oldMain = { ...nativeMain! }; await closeApp(); await launch();
  const restored = await snapshot();
  assert.ok(nativeMain!.id !== oldMain.id || nativeMain!.created !== oldMain.created);
  for (const item of expected) {
    assert.equal(session(restored, item.id).status, item.status); assert.deepEqual(session(restored, item.id).messages.map(message => message.id), item.messageIds);
    assert.equal(restored.tasks.find(task => task.id === session(restored, item.id).taskId)!.operations.length, 0);
  }
  assert.equal(restored.approvals.length, 0); assert.equal((await journalRows()).filter(row => row.kind === 'request' && row.method === 'turn/start').length, startsBefore);
  for (const identity of waitingIdentities) assertElectronMainExited(identity, await nativeProcess(identity.id));
  report.restart = { oldMain, newMain: nativeMain, expectedSessions: expected, noTurnReplay: true, noRunnerReplay: true, noPendingApproval: true };
  report.controls.restart = 'passed'; report.privateFixtureFilesNoAuthentication = await noAuthenticationFiles();
  for (const size of [{ width: 1360, height: 900 }, { width: 800, height: 600 }]) {
    await page!.setViewportSize(size); await page!.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
    await capture(`completed-${size.width}x${size.height}`);
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.failures, []); await closeApp();
  report.cleanup = { normalClose: true, fixtureOnly: true, forcedKill: false, nativeCloseCount: report.closes.length, mainAndOwnedEngineProcessesAbsent: true };
  report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(error instanceof Error ? error.stack ?? error.message : String(error))); process.exitCode = 1;
  if (page) try { report.latestSnapshot = await snapshot(); await capture('failure'); } catch {}
} finally {
  if (app) {
    try {
      await writeFile(controlFile, JSON.stringify({ phase: 'hold-stop-reconnect-account', released: true }));
      await app.evaluate(() => (globalThis as any).__controlsOfflineTiming.release());
      const state = await snapshot();
      for (const id of ownedSessions) if (state.sessions.some(item => item.id === id && item.turnId && ['running', 'stopping'].includes(item.status))) await page!.evaluate(id => window.forgeDesk.interrupt(id), id);
      await closeApp(); report.cleanup = { normalClose: true, fixtureOnly: true, forcedKill: false };
    } catch (error) {
      report.result = 'failed'; report.failures.push(redact(String(error))); process.exitCode = 1;
      const observed = main ? await nativeProcess(main.pid) : null;
      if (observed && nativeMain && Date.parse(observed.created) === Date.parse(nativeMain.created)) {
        assert.equal(path.resolve(observed.execPath).toLowerCase(), executable.toLowerCase());
        const command = await execute(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${observed.id}').CommandLine`], { shell: false, windowsHide: true, timeout: 10000 });
        assert.ok(command.stdout.toLowerCase().includes(fixtureApp.toLowerCase()), 'Forced cleanup is limited to the exact fixture main command line');
        process.kill(observed.id);
        const cleanupObservation = await observeNormalCloseRequest(app.close(), 5000);
        report.fixtureForcedCleanupObservation = cleanupObservation.state === 'rejected'
          ? { state: cleanupObservation.state, error: redact(String(cleanupObservation.error)) } : cleanupObservation;
      }
      report.cleanup = { normalClose: false, fixtureOnly: true, forcedKill: Boolean(observed), knownFixtureMainPid: observed?.id };
    }
  }
  report.finishedAt = new Date().toISOString(); await evidence();
  console.log(JSON.stringify({ result: report.result, scope: report.scope, controls: report.controls, failures: report.failures,
    evidence: path.join(output, 'evidence.json') }, null, 2));
}
