import assert from 'node:assert/strict';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { release, version } from 'node:os';
import { spawn } from 'node:child_process';
import type { AppSnapshot } from '../packages/shared/contracts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = process.env.FORGEDESK_QA_LABEL || 'development';
const output = path.join(root, 'output/playwright', suffix);
const dataDir = path.join(root, '.runtime', suffix === 'development' ? 'qa' : `qa-${suffix}`);
const projectRoot = path.join(root, '.runtime', `qa-source-${suffix}`);
const verifier = path.join(root, 'engineering/fixtures/software/verifiers/verify-numbers.mjs');
const report: Record<string, unknown> = { scope: 'Real Electron; no model login or hardware acceptance', label: suffix,
  command: 'tsx tests/electron-smoke.ts', host: { platform: process.platform, arch: process.arch, release: release(), version: version() },
  startedAt: new Date().toISOString(), steps: [], pageErrors: [], failures: [] };
const steps = report.steps as string[];
const pageErrors = report.pageErrors as string[];
const failures = report.failures as string[];
let application: ElectronApplication | undefined;
await mkdir(output, { recursive: true });
await mkdir(projectRoot, { recursive: true });
await copyFile(path.join(root, 'engineering/fixtures/software/workspace/numbers.mjs'), path.join(projectRoot, 'numbers.mjs'));
const environment: NodeJS.ProcessEnv = { ...process.env, FORGEDESK_DATA_DIR: dataDir };
delete environment.ELECTRON_RUN_AS_NODE;

async function launch() {
  const executablePath = process.env.FORGEDESK_INSTALLED_EXE || path.join(root, 'node_modules/electron/dist/electron.exe');
  const launchEnvironment = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  application = await electron.launch({ executablePath, args: process.env.FORGEDESK_INSTALLED_EXE ? [] : [root], cwd: root, env: launchEnvironment, timeout: 30000 });
  const page = await application.firstWindow({ timeout: 30000 });
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('.app-header').waitFor();
  await waitForSnapshot(page, state => ['ready', 'failed'].includes(state.engine.state));
  return page;
}
async function snapshot(page: Page): Promise<AppSnapshot> { return page.evaluate(() => window.forgeDesk.snapshot()); }
async function waitForSnapshot(page: Page, predicate: (state: AppSnapshot) => boolean) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const state = await snapshot(page);
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for production application state');
}
async function capture(page: Page, name: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.screenshot({ path: path.join(output, `${name}-${width}x${height}.png`) });
  const layout = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    brandRendered: [...document.images].filter(image => image.src.includes('brand.png')).every(image => image.complete && image.naturalWidth > 0),
    text: document.body.innerText }));
  assert.equal(layout.scrollWidth <= layout.clientWidth + 1, true, `Horizontal document overflow at ${width}x${height}`);
  assert.equal(layout.brandRendered, true, 'Brand bitmap did not load');
  await writeFile(path.join(output, `${name}-${width}x${height}.txt`), layout.text);
}

async function packagedMcp(home: string, appPath: string) {
  const config = await readFile(path.join(home, 'config.toml'), 'utf8');
  const value = (key: string) => {
    const line = config.split(/\r?\n/).find(line => line.startsWith(`${key} = `));
    if (!line) throw new Error('Packaged MCP connection setting missing');
    try { const parsed: unknown = JSON.parse(line.slice(line.indexOf('=') + 1).trim()); if (typeof parsed === 'string') return parsed; } catch {}
    throw new Error('Packaged MCP connection setting invalid');
  };
  const child = spawn(process.env.FORGEDESK_INSTALLED_EXE!, [path.join(appPath, 'dist/mcp/index.cjs'), '--mcp-stdio'], {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1', FORGEDESK_RUNNER_PIPE: value('FORGEDESK_RUNNER_PIPE'), FORGEDESK_RUNNER_TOKEN: value('FORGEDESK_RUNNER_TOKEN') }
  });
  try {
    const responses = await new Promise<any[]>((resolve, reject) => {
      let buffer = ''; const messages: any[] = [];
      const timer = setTimeout(() => reject(new Error('Packaged MCP protocol timed out')), 15000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Packaged MCP process failed to launch')); });
      child.once('exit', () => { if (messages.length < 3) { clearTimeout(timer); reject(new Error('Packaged MCP exited before protocol responses')); } });
      child.stdout.on('data', chunk => {
        buffer += chunk.toString(); if (buffer.length > 1024 * 1024) { clearTimeout(timer); reject(new Error('Packaged MCP protocol exceeded bounds')); return; }
        let end = buffer.indexOf('\n');
        while (end >= 0) {
          try { messages.push(JSON.parse(buffer.slice(0, end))); } catch { clearTimeout(timer); reject(new Error('Packaged MCP returned invalid JSON')); return; }
          buffer = buffer.slice(end + 1); if (messages.length === 3) { clearTimeout(timer); resolve(messages); return; } end = buffer.indexOf('\n');
        }
      });
      for (const message of [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engineering.test', arguments: { taskId: 'qa-not-active', verifierId: 'check', requestKey: 'qa-inactive-check' } } }
      ]) child.stdin.write(JSON.stringify(message) + '\n');
    });
    assert.equal(responses[0].id, 1); assert.ok(responses[0].result);
    assert.deepEqual(responses[1].result.tools.map((tool: { name: string }) => tool.name), ['engineering.inspect', 'engineering.build', 'engineering.test', 'device.bind', 'device.flash', 'device.verify', 'engineering.export']);
    assert.equal(responses[2].id, 3); assert.equal(responses[2].result.isError, true);
    steps.push('Installed executable ran packaged app.asar MCP entry: initialize, seven tools, inactive-task call returned explicit error');
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      await new Promise<void>(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  }
}

try {
  let page = await launch();
  const initial = await snapshot(page);
  report.initial = { appVersion: initial.version, engine: initial.engine, account: initial.account, dataDir: initial.dataDir, hardware: initial.hardware };
  assert.equal(initial.account.loggedIn, false, 'QA data must not have inherited another client login');
  assert.equal(initial.engine.home, path.join(dataDir, 'engine'));
  assert.equal(initial.hardware.enabled, false);
  assert.equal(initial.engine.state, 'ready', initial.engine.error || 'Engine not ready');
  assert.equal(await page.evaluate(() => typeof (window as unknown as { require: unknown }).require), 'undefined');
  steps.push('Real isolated engine initialized without inherited authentication; renderer Node access absent');
  if (process.env.FORGEDESK_INSTALLED_EXE) await packagedMcp(initial.engine.home, await application!.evaluate(({ app }) => app.getAppPath()));
  await capture(page, 'empty', 1380, 900); await capture(page, 'empty', 800, 600);
  await page.getByRole('button', { name: '设置与诊断', exact: true }).click();
  await capture(page, 'settings', 800, 600);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await application!.evaluate(({ dialog }, selectedRoot) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedRoot] }); }, projectRoot);
  await page.getByRole('button', { name: '导入项目', exact: true }).first().click();
  await waitForSnapshot(page, state => state.projects.length > 0);
  await page.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await waitForSnapshot(page, state => state.sessions.length > 0);
  const session = (await snapshot(page)).sessions.at(-1)!;
  await page.getByRole('textbox', { name: '任务指令', exact: true }).fill('QA prompt retained while login is pending');
  assert.equal(await page.getByRole('button', { name: '发送任务', exact: true }).isDisabled(), true);
  steps.push('UI imported project and created session; unauthenticated send stays disabled');
  await page.getByRole('tab', { name: '工程交付', exact: true }).click();
  const acceptance = [{ id: 'numbers', title: 'Empty input and arithmetic', kind: 'automated' as const,
    command: { executable: process.execPath, args: [verifier, projectRoot], timeoutMs: 10000 }, verifierFiles: [verifier] }];
  await page.evaluate(async ({ id, items }) => { await window.forgeDesk.setAcceptance(id, items); }, { id: session.id, items: acceptance });
  await page.evaluate(async id => { await window.forgeDesk.runAcceptance(id, 'numbers', `qa-failed-${Date.now()}`); }, session.id);
  const failed = (await snapshot(page)).tasks.find(task => task.id === session.id)!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.acceptance[0].status, 'failed');
  assert.equal(failed.operations.at(-1)!.status, 'failed');
  const failureLog = await page.evaluate(async ({ id, operationId }) => window.forgeDesk.readOperationLog(id, operationId), { id: session.id, operationId: failed.operations.at(-1)!.id });
  assert.match(failureLog, /AssertionError|Reduce of empty array|Empty input/);
  steps.push('Production bridge/runner executed fixed trusted verifier; original defect failed with persisted evidence');
  await copyFile(path.join(root, 'tests/fixtures/numbers-corrected.mjs'), path.join(projectRoot, 'numbers.mjs'));
  await page.evaluate(async id => { await window.forgeDesk.runAcceptance(id, 'numbers', `qa-passed-${Date.now()}`); }, session.id);
  const passed = (await snapshot(page)).tasks.find(task => task.id === session.id)!;
  assert.equal(passed.status, 'passed'); assert.equal(passed.acceptance[0].status, 'passed');
  steps.push('Corrected test fixture passed three trusted arithmetic checks through production process supervisor');
  await capture(page, 'delivery', 1380, 900); await capture(page, 'delivery', 800, 600);
  await page.reload(); await page.locator('.app-header').waitFor();
  await waitForSnapshot(page, state => state.sessions.some(item => item.id === session.id));
  assert.equal((await snapshot(page)).tasks.find(task => task.id === session.id)!.status, 'passed');
  assert.equal(await page.getByRole('textbox', { name: '任务指令', exact: true }).inputValue(), 'QA prompt retained while login is pending');
  steps.push('Renderer reload preserved session, verifier evidence and unsent draft');
  await application!.close(); application = undefined;
  page = await launch();
  const restarted = (await snapshot(page)).tasks.find(task => task.id === session.id)!;
  assert.equal(restarted.status, 'passed'); assert.equal(restarted.operations.length, 2);
  steps.push('Whole app restart preserved task and both operations without replay');
  await writeFile(path.join(projectRoot, 'configuration.json'), JSON.stringify({ changed: true, revision: Date.now() }) + '\n');
  await page.evaluate(async id => { await window.forgeDesk.refreshEvidence(id); }, session.id);
  const stale = (await snapshot(page)).tasks.find(task => task.id === session.id)!;
  assert.equal(stale.acceptance[0].status, 'stale'); assert.notEqual(stale.status, 'passed');
  steps.push('New untracked input invalidated prior passed evidence after restart');
  await application!.evaluate(({ dialog }, destination) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination }); }, path.join(output, 'diagnostics.json'));
  const diagnosticPath = await page.evaluate(() => window.forgeDesk.exportDiagnostics());
  JSON.parse(await readFile(diagnosticPath!, 'utf8'));
  steps.push('Production diagnostic export produced readable JSON');
  await capture(page, 'stale', 1380, 900);
  assert.deepEqual(pageErrors, []);
  report.result = 'passed';
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error)); report.result = 'failed';
  if (application) { try { await (await application.firstWindow()).screenshot({ path: path.join(output, 'failure.png') }); } catch {} }
  process.exitCode = 1;
} finally {
  if (application) { try { await application.close(); } catch (error) { failures.push(String(error)); process.exitCode = 1; } }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ result: report.result, steps, pageErrors, failures, evidence: path.join(output, 'evidence.json') }, null, 2));
}
