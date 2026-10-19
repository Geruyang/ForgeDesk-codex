import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

assert.deepEqual(process.argv.slice(2), ['--offline-ui-only']);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const output = path.join(root, 'output/hardware/2026-10-16-next/product', `renderer-ui-${Date.now()}-${randomUUID().slice(0, 6)}`);
await mkdir(path.join(output, 'temp'), { recursive: true });
const report: Record<string, any> = { scope: 'Offline browser renderer fixture; not Electron IPC, installed, real-model, authentication or device acceptance', startedAt: new Date().toISOString(), output, result: 'failed', pageErrors: [], checks: [], sourceSha256: {} };
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
for (const relative of ['apps/desktop/renderer/App.tsx', 'apps/desktop/renderer/FZ3BPanel.tsx', 'apps/desktop/renderer/FZ3BPanel.fixture.ts', 'apps/desktop/renderer/styles.css', 'apps/desktop/renderer/FZ3BPanel.visual.ts']) report.sourceSha256[relative] = sha(await readFile(path.join(root, relative)));
const entry = `
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from ${JSON.stringify(path.join(root, 'apps/desktop/renderer/App.tsx'))};
import { fz3bFixtureArtifact as artifact, fz3bFixtureRun, fz3bFixtureSemantic as semantic, fz3bFixtureReconciliation as reconciliation, fz3bFixtureMaintenanceExit as maintenanceExit } from ${JSON.stringify(path.join(root, 'apps/desktop/renderer/FZ3BPanel.fixture.ts'))};
const calls = [], listeners = new Set();
let scenario = 'ready', state, releaseReconcile;
const identity = { hostKeySha256:'a'.repeat(64),bootId:'offline-boot',appRoot:'/offline-fixture/app',platform:'A0005',contractId:'a'.repeat(64),deployedManifestSha256:'a'.repeat(64),existingPlSha256:'a'.repeat(64),transport:'pinned-ssh',helloAuthenticated:false };
function makeRun(name){
 let run=fz3bFixtureRun();
 if(name==='pending') Object.assign(run,{phase:'awaiting_native_approval',nativeApproval:'pending',currentTool:'fz3b_request_semantic',hardwareBusy:false});
 if(['completed','classification','error','stale'].includes(name)) Object.assign(run,{active:false,hardwareBusy:false,status:'completed',phase:'completed',nativeApproval:'approved',artifact,identity,operations:run.operations.map(op=>({...op,status:'succeeded',processExited:true})),semantic:{...semantic,jobId:'offline-job-'+name},export:{path:'E:/offline-fixture/export/evidence.json',sha256:'a'.repeat(64)}});
 if(name==='classification') Object.assign(run,{status:'needs_attention',phase:'needs_attention',semantic:{...semantic,jobId:'offline-classification',ranking:semantic.ranking.map(item=>({...item,score:item.score/2})),classificationUnknown:true,thresholdHit:false,expectedLabelMatched:true}});
 if(name==='unknown') Object.assign(run,{active:false,hardwareBusy:true,stopRequested:true,status:'needs_attention',phase:'needs_attention',nativeApproval:'unknown',failure:'OFFLINE_REMOTE_TERMINAL_UNKNOWN',operations:run.operations.map(op=>({...op,kind:'semantic',status:'unknown',processExited:true,remoteQuiescent:false}))});
 if(['inspect-recovery','reconciled','semantic-maintenance'].includes(name)) Object.assign(run,{active:false,hardwareBusy:name!=='reconciled',stopRequested:true,status:'needs_attention',phase:'needs_attention',nativeApproval:'not_requested',currentTool:undefined,failure:'OFFLINE_ORIGINAL_UNKNOWN_PRESERVED',calls:[],operations:run.operations.map(op=>({...op,kind:name==='semantic-maintenance'?'semantic':'inspect',status:'unknown',processExited:true,remoteQuiescent:false,progress:{stage:name==='semantic-maintenance'?'原单图操作':'只读设备环境检查',updatedAt:op.updatedAt}})),...(name==='reconciled'?{reconciliations:[reconciliation]}:{})});
 if(name==='error') Object.assign(run,{status:'needs_attention',phase:'needs_attention',semantic:undefined,failure:'Offline fixture error <script>not executable</script>'});
 return run;
}
function setScenario(name){
 scenario=name; const run=['ready','unavailable','missing-key-controlled','startup-recovery'].includes(name)?null:makeRun(name);
 const missingKey=name==='missing-key-controlled',startupRecovery=name==='startup-recovery';
 state={schemaVersion:1,version:'offline-ui-fixture',dataDir:'E:/offline-fixture/data',projects:[{id:'offline-project',name:'FZ3B offline fixture',root:'E:/offline-fixture/project'}],sessions:[{id:'offline-session',projectId:'offline-project',taskId:'offline-task',title:'FZ3B 离线界面夹具',status:run?.active?'running':'idle',messages:[],...(run?{threadId:'offline-thread'}:{})}],tasks:[{id:'offline-task',status:'draft',acceptance:[],operations:[],evidence:[]}],engine:{state:run?'stopped':'ready',executable:'offline-only',home:'E:/offline-fixture/no-auth'},account:{loggedIn:true,label:'Offline UI fixture, not a login'},models:[{id:'gpt-6.1-sol',label:'gpt-6.1-sol'}],approvals:[],diagnostics:[],hardware:{enabled:false,userDriven:true,modeActive:!!run||missingKey||startupRecovery,reason:'Offline fixture; no device'},hardwareAgent:{runs:[],engineState:'stopped'},fz3bAgent:{available:name!=='unavailable'&&!missingKey,status:missingKey?'missing-key':name==='unavailable'?'invalid-resources':'available',resourcesVerified:name!=='unavailable',keyImportAllowed:!run&&name!=='unavailable'&&!startupRecovery,reason:name==='unavailable'?'固定资源未就绪（离线夹具）':missingKey?'FZ3B_PROJECT_KEY_MISSING':undefined,recoveryTaskId:startupRecovery?'offline-task':undefined,runs:run?[run]:[],activeRunId:run&&(run.active||run.hardwareBusy||run.nativeApproval==='pending')?run.runId:undefined,engineState:startupRecovery?'failed':run?.active?'ready':name==='unknown'?'unknown':'stopped'}};
 if(['inspect-recovery','semantic-maintenance'].includes(name)) state.fz3bAgent.recoveryActions={runId:run.runId,taskId:run.taskId,sessionId:run.sessionId,reconcileInspect:name==='inspect-recovery',maintenanceExit:true,exportEvidence:true};
 listeners.forEach(cb=>cb(structuredClone(state)));
}
function record(method,args){calls.push({method,args:structuredClone(args)});}
const api={snapshot:async()=>structuredClone(state),subscribe(cb){listeners.add(cb);return()=>listeners.delete(cb);},fz3bSnapshot:async(task)=>{record('fz3bSnapshot',[task]);if(scenario==='stale')throw new Error('OFFLINE_LOCAL_READ_FAILED');return structuredClone(state.fz3bAgent.runs.find(run=>run.taskId===task)||null);},hardwareSnapshot:async(task)=>{record('hardwareSnapshot',[task]);return {taskId:task,configured:false,profileId:'offline-stm32',profileSha256:'a'.repeat(64),operations:[],hardwareAvailable:false,limitation:'Offline fixture'};},fz3bAgentStart:async(...args)=>{record('fz3bAgentStart',args);setScenario('building');return structuredClone(state.fz3bAgent.runs[0]);},fz3bAgentStop:async(...args)=>{record('fz3bAgentStop',args);state.fz3bAgent.engineState='stopped';const run=state.fz3bAgent.runs[0];run.active=false;run.stopRequested=true;listeners.forEach(cb=>cb(structuredClone(state)));return structuredClone(run);},fz3bRecover:async(...args)=>{record('fz3bRecover',args);if(scenario==='startup-recovery'){setScenario('ready');return null;}throw new Error('OFFLINE_REMOTE_TERMINAL_UNKNOWN');},fz3bExport:async(...args)=>{record('fz3bExport',args);return 'E:/offline-fixture/export/evidence.json';},fz3bLeaveMode:async(...args)=>{record('fz3bLeaveMode',args);state.hardware.modeActive=false;listeners.forEach(cb=>cb(structuredClone(state)));},fz3bImportKey:async(...args)=>{record('fz3bImportKey',args);},diff:async()=>({text:'',truncated:false})};
api.fz3bReconcileInspect=async(...args)=>{record('fz3bReconcileInspect',args);await new Promise(resolve=>{releaseReconcile=resolve;});setScenario('reconciled');return structuredClone(state.fz3bAgent.runs[0]);};
api.fz3bMaintenanceExit=async(...args)=>{record('fz3bMaintenanceExit',args);state.fz3bAgent.runs[0].maintenanceExit=structuredClone(maintenanceExit);listeners.forEach(cb=>cb(structuredClone(state)));};
window.forgeDesk=new Proxy(api,{get(target,key){if(key in target)return target[key];return async(...args)=>{record(String(key),args);throw new Error('UNEXPECTED_OFFLINE_API:'+String(key));};}});
window.__offlineFz3b={setScenario,calls:()=>structuredClone(calls),state:()=>structuredClone(state),releaseReconcile(){if(!releaseReconcile)throw new Error('NO_PENDING_OFFLINE_RECONCILIATION');const release=releaseReconcile;releaseReconcile=undefined;release();}};
localStorage.setItem('forgedesk.renderer.v1',JSON.stringify({projectId:'offline-project',sessionId:'offline-session',tab:'embedded',hardwarePlatform:'fz3b'}));
setScenario('ready');createRoot(document.getElementById('root')).render(createElement(StrictMode,null,createElement(App)));
`;
await writeFile(path.join(output, 'fixture-entry.tsx'), entry);
const bundled = await build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'offline-fz3b-ui.tsx', loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' } });
const code = bundled.outputFiles[0].text;
await writeFile(path.join(output, 'fixture.js'), code);
const css = await readFile(path.join(root, 'apps/desktop/renderer/styles.css'), 'utf8');
const bitmap = await readFile(path.join(root, 'apps/desktop/renderer/assets/brand.png'));
report.bundleSha256 = sha(code); report.stylesSha256 = sha(css);
const context = await chromium.launchPersistentContext(path.join(output, 'edge-profile'), { channel: 'msedge', headless: true, offline: true, serviceWorkers: 'block', viewport: { width: 1380, height: 900 }, env: { ...process.env, TEMP: path.join(output, 'temp'), TMP: path.join(output, 'temp') }, args: ['--disable-background-networking', '--disable-sync', '--disable-extensions', '--no-first-run'] });
try {
  await context.route('**/*', route => {
    if (route.request().url() === 'https://forgedesk-offline.invalid/') return route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8"><style>${css}</style><div id="root"></div>` });
    if (route.request().url() === 'https://forgedesk-offline.invalid/assets/brand.png') return route.fulfill({ contentType: 'image/png', body: bitmap });
    return route.abort();
  });
  const page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto('https://forgedesk-offline.invalid/');
  await page.addScriptTag({ content: code });
  const fixture = (expression: string) => page.evaluate(value => (window as any).__offlineFz3b.setScenario(value), expression);
  async function capture(name: string, focusRegion?: string) {
    for (const viewport of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) {
      await page.setViewportSize(viewport);
      if (focusRegion) await page.getByRole('region', { name: focusRegion, exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.brand img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
      const overflow = await page.locator('.fz3b-scroll button').evaluateAll(elements => elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.textContent));
      assert.deepEqual(overflow, []);
      await page.screenshot({ path: path.join(output, `${name}-${viewport.width}x${viewport.height}.png`) });
    }
  }
  await page.getByRole('button', { name: '启动 FZ3B 模型任务', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[aria-label="启动 FZ3B 模型任务"]')?.disabled);
  await capture('ready');
  await page.getByRole('button', { name: '导入 FZ3B 设备密钥', exact: true }).click();
  await page.getByLabel('FZ3B 模型任务指令', { exact: true }).fill('Offline fixed semantic task');
  await page.getByRole('button', { name: '启动 FZ3B 模型任务', exact: true }).click();
  await page.getByRole('region', { name: 'FZ3B 构建与操作进度', exact: true }).waitFor();
  const initialCalls = await page.evaluate(() => (window as any).__offlineFz3b.calls());
  assert.deepEqual(initialCalls.filter((call: any) => call.method === 'fz3bAgentStart').map((call: any) => call.args), [['offline-task', 'Offline fixed semantic task', 'gpt-6.1-sol']]);
  assert.deepEqual(initialCalls.filter((call: any) => call.method === 'fz3bImportKey').map((call: any) => call.args), [[]]);
  assert.equal(await page.getByRole('progressbar', { name: 'FZ3B 当前阶段进度' }).getAttribute('aria-valuenow'), null);
  await capture('building');
  await page.getByRole('tab', { name: 'STM32', exact: true }).click();
  await page.getByRole('button', { name: '配置工程', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '配置工程', exact: true }).isDisabled(), true);
  await page.getByRole('tab', { name: 'FZ3B · Zynq', exact: true }).click();
  report.checks.push('Actual App renderer start dispatch binds task/model; native-key API receives no path; STM32 stays blocked by FZ3B ownership');
  for (const name of ['pending', 'completed', 'classification', 'error', 'unknown', 'stale', 'unavailable', 'missing-key-controlled', 'startup-recovery', 'inspect-recovery', 'semantic-maintenance']) {
    await fixture(name);
    await page.getByRole('button', { name: '刷新 FZ3B 本地状态' }).click();
    if (name === 'pending') {
      await page.getByText('等待原生窗口决定；本面板不授予设备授权。', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: /批准|允许本次|授权执行/ }).count(), 0);
    }
    if (name === 'completed') {
      await page.getByRole('region', { name: 'FZ3B 语义结果', exact: true }).waitFor();
      await page.getByRole('button', { name: '导出 FZ3B 证据', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '证据已导出' }).waitFor();
      await page.getByRole('region', { name: 'FZ3B 语义结果', exact: true }).scrollIntoViewIfNeeded();
    }
    if (name === 'classification') { await page.getByText('应用分类：未知', { exact: true }).waitFor(); await page.getByRole('region', { name: 'FZ3B 语义结果', exact: true }).scrollIntoViewIfNeeded(); }
    if (name === 'unknown') {
      await page.getByRole('button', { name: '停止 FZ3B 模型任务', exact: true }).click();
      await page.getByRole('button', { name: '核查 FZ3B 退出状态', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'OFFLINE_REMOTE_TERMINAL_UNKNOWN' }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: '导出 FZ3B 证据' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'FZ3B 返回软件模式' }).isDisabled(), true);
    }
    if (name === 'stale') {
      await page.getByText('状态读取失败，以上为上次记录。', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '导出 FZ3B 证据' }).isDisabled(), true);
    }
    if (name === 'unavailable') {
      assert.equal(await page.getByRole('button', { name: '启动 FZ3B 模型任务' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '导入 FZ3B 设备密钥' }).count(), 0);
    }
    if (name === 'missing-key-controlled') {
      await page.getByText('尚未导入本项目设备密钥。', { exact: true }).waitFor();
      const keyImport = page.getByRole('button', { name: '导入 FZ3B 设备密钥', exact: true });
      assert.equal(await keyImport.isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: 'FZ3B 返回软件模式' }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: '启动 FZ3B 模型任务' }).isDisabled(), true);
      const before = await page.evaluate(() => (window as any).__offlineFz3b.calls().filter((call: any) => call.method === 'fz3bImportKey').length);
      await keyImport.click();
      const imports = await page.evaluate(() => (window as any).__offlineFz3b.calls().filter((call: any) => call.method === 'fz3bImportKey'));
      assert.equal(imports.length, before + 1); assert.deepEqual(imports.at(-1).args, []);
    }
    if (name === 'startup-recovery') {
      await page.getByRole('button', { name: '核查 FZ3B 退出状态', exact: true }).waitFor();
      await capture('startup-held');
      const before = await page.evaluate(() => (window as any).__offlineFz3b.calls().filter((call: any) => call.method === 'fz3bAgentStart').length);
      await page.getByRole('button', { name: '核查 FZ3B 退出状态', exact: true }).click();
      await page.waitForFunction(() => !(window as any).__offlineFz3b.state().fz3bAgent.recoveryTaskId);
      assert.equal(await page.getByRole('button', { name: '核查 FZ3B 退出状态' }).count(), 0);
      const after = await page.evaluate(() => (window as any).__offlineFz3b.calls());
      assert.equal(after.filter((call: any) => call.method === 'fz3bAgentStart').length, before);
      assert.deepEqual(after.filter((call: any) => call.method === 'fz3bRecover').at(-1).args, ['offline-task']);
    }
    if (name === 'inspect-recovery') {
      const inspect = page.getByRole('button', { name: '只读核查 FZ3B 检查占用', exact: true });
      const maintenance = page.getByRole('button', { name: 'FZ3B 维护退出应用', exact: true });
      await inspect.waitFor(); await inspect.scrollIntoViewIfNeeded(); await capture('inspect-held', 'FZ3B 受控恢复操作');
      await inspect.click();
      await page.waitForFunction(() => document.querySelector('.fz3b-scroll')?.getAttribute('data-pending-intent') === 'reconcile-inspect');
      assert.equal(await inspect.isDisabled(), true); assert.equal(await maintenance.isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '停止 FZ3B 模型任务' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '导出 FZ3B 证据' }).isDisabled(), true);
      await page.evaluate(() => (window as any).__offlineFz3b.releaseReconcile());
      await page.getByText('当前占用已解除', { exact: true }).waitFor();
      await page.getByText('新的只读检查核查', { exact: true }).click();
      await page.getByText('新核查确认当前占用可解除；原检查仍为未知，原模型任务不会续跑。', { exact: true }).waitFor();
      const after = await page.evaluate(() => ({ state: (window as any).__offlineFz3b.state(), calls: (window as any).__offlineFz3b.calls() }));
      assert.equal(after.state.fz3bAgent.runs[0].operations[0].status, 'unknown');
      assert.deepEqual(after.calls.filter((call: any) => call.method === 'fz3bReconcileInspect').at(-1).args, ['offline-run']);
      assert.equal(await page.getByRole('button', { name: 'FZ3B 返回软件模式' }).isEnabled(), true);
    }
    if (name === 'semantic-maintenance') {
      assert.equal(await page.getByRole('button', { name: '只读核查 FZ3B 检查占用' }).count(), 0);
      const exported = page.getByRole('button', { name: '导出 FZ3B 证据', exact: true });
      assert.equal(await exported.isEnabled(), true); await exported.click();
      await page.getByRole('status').filter({ hasText: '证据已导出' }).waitFor();
      const maintenance = page.getByRole('button', { name: 'FZ3B 维护退出应用', exact: true });
      await maintenance.waitFor(); await maintenance.scrollIntoViewIfNeeded(); await maintenance.click();
      await page.getByText(/维护退出记录 ·/).waitFor();
      const after = await page.evaluate(() => ({ state: (window as any).__offlineFz3b.state(), calls: (window as any).__offlineFz3b.calls() }));
      assert.equal(after.state.fz3bAgent.runs[0].operations[0].status, 'unknown'); assert.equal(after.state.fz3bAgent.runs[0].hardwareBusy, true);
      assert.deepEqual(after.calls.filter((call: any) => call.method === 'fz3bMaintenanceExit').at(-1).args, ['offline-run']);
      assert.deepEqual(after.calls.filter((call: any) => call.method === 'fz3bExport').at(-1).args, ['offline-task']);
      assert.equal(await page.getByRole('button', { name: 'FZ3B 返回软件模式' }).isDisabled(), true);
    }
    await capture(name, name === 'semantic-maintenance' ? 'FZ3B 受控恢复操作' : name === 'inspect-recovery' ? 'FZ3B 恢复与维护记录' : undefined); report.checks.push(`Offline scenario ${name} rendered at 1380x900 and 800x600`);
  }
  report.apiCalls = await page.evaluate(() => (window as any).__offlineFz3b.calls());
  assert.equal(report.apiCalls.some((call: any) => /approve|hardwareBuild|hardwareFlash|send|steer|connect|login|semantic|deploy/i.test(call.method)), false);
  assert.deepEqual(report.pageErrors, []); report.result = 'passed';
} catch (error) { report.failure = error instanceof Error ? error.stack : String(error); throw error; }
finally { await context.close(); report.finishedAt = new Date().toISOString(); await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ result: report.result, evidence: path.join(output, 'evidence.json'), checks: report.checks.length })); }
