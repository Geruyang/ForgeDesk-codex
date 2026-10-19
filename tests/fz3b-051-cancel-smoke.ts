import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { Fz3bRunView } from '../packages/engineering-runner/fz3b/types';
import { redact } from '../packages/engineering-runner/redaction';
import { fileSha256, inside, plainPath, samePath } from './helpers/embedded-installed';
import { FZ3B_INSTRUCTION, assertFz3bCloseSafe, assertFz3bNoReplay,
  assertFz3bPolicy, readPinnedFz3bResources, sanitizeFz3bEvidence, verifyFz3bArtifacts } from './helpers/fz3b-installed';
import { assertFz3bHistoryStable, assertFz3bRunUnheld, verifyFz3bHistoricalReleases } from './helpers/fz3b-installed-history';
import { connectFz3bInstalledStartup, assertFz3bStartupIdle } from './helpers/fz3b-installed-startup';
import { fz3bInstalledUi } from './helpers/fz3b-installed-ui';
import { installFz3bNativeObserver, readFz3bNativeObserver, restoreFz3bNativeObserver } from './helpers/fz3b-native-observer';
import { prepareSnapshotInstalledLifecycle } from './helpers/snapshot-installed-lifecycle';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { assertInstalledMainProcess, nativeMainProcessQuery, type InstalledMainProcess } from './helpers/second-user-controls';
import { prepareFz3b051Plan, verifyFz3b051PlanBytes, fz3b051LaunchEnvironment,
  assertFz3b051NativeGrant, type Fz3b051GrantObservation } from './helpers/fz3b-051-installed';

import { CANCEL_OUTPUT, cancelPlanScope, assertCancelDispatch, assertCancelDrained, verifyCancelExport } from './helpers/fz3b-cancel-installed';
import { installFz3bCancelStopObserver, readFz3bCancelStopObserver, restoreFz3bCancelStopObserver, assertFz3bCancelStopReceipt } from './helpers/fz3b-cancel-stop-observer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, filename, ...extra] = process.argv.slice(2);
assert.ok(['--prepare-only', '--preflight-only', '--execute-real-model-fz3b-cancel'].includes(mode) && filename && !extra.length,
  'Use --prepare-only <absolute-request.json> or --execute-real-model-fz3b-cancel <absolute-plan.json>');
assert.ok(path.isAbsolute(filename) && inside(path.join(root, CANCEL_OUTPUT, 'plans'), filename));
await plainPath(filename); const inputInfo = await lstat(filename);
assert.ok(inputInfo.isFile() && inputInfo.nlink === 1 && inputInfo.size <= 262144);
const input = JSON.parse(await readFile(filename, 'utf8'));

if (mode === '--prepare-only') {
  assert.ok(filename.endsWith('.request.json'));
  const plan = await prepareFz3b051Plan(root, input); cancelPlanScope(root, plan, {});
  const destination = filename.slice(0, -'.request.json'.length) + '.plan.json';
  await writeFile(destination, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: 'prepared-only-not-accepted', plan: destination, runId: plan.runId, version: plan.version,
    planSha256: await fileSha256(destination), next: `node --import tsx tests/fz3b-051-cancel-smoke.ts --execute-real-model-fz3b-cancel "${destination}"`,
    scope: 'Six model tools on existing deployed candidate008; no model deployment; independent PS maintenance evidence remains separate',
    prerequisites: ['Coordinator-reviewed immutable release candidate, ASAR bundles and all FZ3B resource pins',
      'Existing official login and normally imported exact project/key; no authentication copying',
      'No held or unknown owner; original native warning/checkbox operated visibly under coordinator delegation'] }, null, 2));
} else if (mode === '--preflight-only') {
  const { plan, output } = cancelPlanScope(root, input, process.env);
  const release = await verifyFz3b051PlanBytes(root, plan); await readPinnedFz3bResources(plan);
  await plainPath(plan.projectRoot); await plainPath(plan.dataDir); await plainPath(output);
  console.log(JSON.stringify({ result: 'preflight-only-not-accepted', output, planSha256: await fileSha256(filename), release,
    appStarted: false, nativeInvoked: false, modelStarted: false, deviceContacted: false,
    intendedScope: 'Stop planner after durable semantic dispatch observation; allow the original worker to drain, not hardware interruption' }, null, 2));
} else {
  assert.equal(process.platform, 'win32');
  const { plan, output } = cancelPlanScope(root, input, process.env);
  const release = await verifyFz3b051PlanBytes(root, plan); const resources = await readPinnedFz3bResources(plan);
  await plainPath(plan.projectRoot); await plainPath(plan.dataDir); await plainPath(output);
  await mkdir(output, { recursive: false });
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)); const execute = promisify(execFile);
  let app: ElectronApplication | undefined, page: Page | undefined;
  let lifecycle: Awaited<ReturnType<typeof prepareSnapshotInstalledLifecycle>> | undefined;
  let taskId: string | undefined, sessionId: string | undefined, controllerId: string | undefined, observerInstalled = false, stopObserverInstalled = false;
  let dispatchBeforeStop: Fz3bRunView | undefined;
  let historicalRuns: Fz3bRunView[] | undefined;
  let historicalProofs: Awaited<ReturnType<typeof verifyFz3bHistoricalReleases>> | undefined;
  let historicalExports: Array<{ runId: string; sha256: string }> | undefined;
  const grantTimeline: Fz3b051GrantObservation[] = [];
  const report: Record<string, any> = { schemaVersion: 1, version: plan.version, runId: plan.runId, scope: plan.scope,
    scenario: 'planner-stop-original-worker-drain', realModel: true, secondUser: false, startedAt: new Date().toISOString(), model: plan.model, dataDir: plan.dataDir, projectRoot: plan.projectRoot,
    planFile: filename, planSha256: await fileSha256(filename), release: { version: plan.version, executableSha256: plan.executableSha256,
      installerSha256: plan.installerSha256, resourceHashes: plan.resourceHashes, releaseCandidateSha256: plan.releaseBinding.candidateSha256, verification: release },
    sourceIdentity: plan.releaseBinding, controls: Object.fromEntries(['publicLogin', 'policy', 'build', 'inspect', 'nativeAuthorization', 'dispatchObserved', 'uiStop', 'workerDrained', 'noModelExport', 'localExport', 'restartNoReplay', 'normalClose'].map(name => [name, 'pending'])),
    supplementalControls: { releaseBinding: 'passed', nativeFixedTtl: 'pending', idleModeExit: 'pending' },
    launches: [], closes: [], observations: [], startupObservations: [], failures: [], pageErrors: [], uiSubmitCount: 0, uiStopCount: 0, grantTimeline,
    nativeConfirmation: { synthesizedDialogResponse: false, operator: plan.nativeOperator,
      mechanism: 'Original native UI, pass-through observation only; external exact-identity UIA belongs to coordinator' },
    limitations: ['Existing PS v2/candidate008 package and one real-text image only; no new model deployment or PL construction.',
      'Independent host PS maintenance reinstall evidence is not this model tool run and must be reported separately.',
      'TOFU-derived host-key continuity is not independent chip authentication or loaded-image attestation.',
      'Positive active-close rejection and no-replay are not a full physical-fault/recovery matrix; no semantic-unknown is released.',
      'Captured source hashes and pinned ASAR bytes are not an exact release commit or proof of source-to-binary correspondence.',
      'Ranking, threshold and classification unknown are separate facts; no general accuracy, throughput or second-SID claim.',
      'running/may-have-started is a durable dispatch marker, not proof that PS/R5 is computing at the instant of the UI click.',
      'UI Stop stops model planning only; no upload_cancel, SSH kill or physical inference interruption is tested.'] };
  async function evidence() { await writeFile(path.join(output, 'evidence.json'), JSON.stringify(sanitizeFz3bEvidence(report), null, 2) + '\n'); }
  const snapshot = (): Promise<AppSnapshot> => bounded(page!.evaluate(() => window.forgeDesk.snapshot()), 'snapshot');
  const owned = (state: AppSnapshot) => state.fz3bAgent?.runs.find(run => run.taskId === taskId && (!controllerId || run.runId === controllerId));
  async function observe(state: AppSnapshot) {
    const run = owned(state);
    if (run) {
      controllerId ??= run.runId; report.controllerId = controllerId; report.run = run;
      if (run.grant) {
        const value = { observedAt: new Date().toISOString(), id: run.grant.id, planSha256: run.grant.planSha256,
          createdAt: run.grant.createdAt, expiresAt: run.grant.expiresAt };
        const prior = grantTimeline.at(-1);
        if (!prior || ['id', 'planSha256', 'createdAt', 'expiresAt'].some(key => prior[key as keyof typeof prior] !== value[key as keyof typeof value])) grantTimeline.push(value);
      }
    }
    if (observerInstalled) report.nativeLive = await bounded(app!.evaluate(readFz3bNativeObserver, { runId: plan.runId }), 'native observation');
  }
  async function verifyHistory(state: AppSnapshot) {
    const all = state.fz3bAgent?.runs; assert.ok(all); const old = all.filter(run => run.runId !== controllerId);
    if (historicalRuns) assertFz3bHistoryStable(historicalRuns, all, controllerId);
    const proof = await verifyFz3bHistoricalReleases(plan.dataDir, old, plan.fixture, resources);
    const exports = [];
    for (const run of old.filter(run => run.status === 'completed')) exports.push({ runId: run.runId, sha256: (await verifyFz3bArtifacts(plan.dataDir, run, plan)).sha256 });
    if (historicalProofs) { assert.deepEqual(proof, historicalProofs); assert.deepEqual(exports, historicalExports); }
    else { historicalRuns = structuredClone(old); historicalProofs = proof; historicalExports = exports;
      report.history = { baseline: historicalRuns, publicEvidence: proof, completedExports: exports,
        scope: 'Original unknown inspect/calls unchanged; only exact native reconciliation releases occupancy. No original run resumes or becomes passed.' }; }
    report.history.lastVerifiedAt = new Date().toISOString();
  }
  async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const value = await read(); if (accept(value)) return value; await pause(100); }
    throw new Error(`${label} timed out; no action retried and no remote quiescence inferred from local exit`);
  }
  async function bounded<T>(operation: Promise<T>, label: string, timeoutMs = 30000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} response timed out; original operation was not cancelled or retried`)), timeoutMs); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function stopOnce(run: Fz3bRunView) {
    assert.equal(report.uiStopCount, 0); assert.ok(controllerId); assertCancelDispatch(run, plan);
    dispatchBeforeStop = structuredClone(run); report.dispatchBeforeStop = dispatchBeforeStop;
    report.dispatchObservation = { observedAt: new Date().toISOString(), stage: 'durable-running-may-have-started', deviceComputingProven: false };
    report.stopObserver = await bounded(app!.evaluate(installFz3bCancelStopObserver, { runId: controllerId }), 'Stop observer installation'); stopObserverInstalled = true;
    // Run summary itself carries the run binding; do not select the toolbar fallback.
    const stop = page!.locator('.fz3b-run').filter({ has: page!.getByText(controllerId, { exact: true }) }).getByRole('button', { name: '停止 FZ3B 模型任务', exact: true });
    assert.equal(await stop.count(), 1); assert.equal(await stop.isEnabled(), true);
    const current = owned(await bounded(snapshot(), 'pre-click snapshot'))!; assertCancelDispatch(current, plan);
    assert.equal(current.operations[2].id, run.operations[2].id); report.uiStopCount++;
    report.stopClickRequestedAt = new Date().toISOString(); await stop.click({ timeout: 10000 }); report.stopClickReturnedAt = new Date().toISOString();
    report.controls.dispatchObserved = 'passed'; await evidence();
  }
  async function launch() {
    await verifyFz3b051PlanBytes(root, plan);
    lifecycle ??= await prepareSnapshotInstalledLifecycle(root, plan.installedExe);
    report.lifecycle = lifecycle.evidence; report.launches = lifecycle.evidence.launches;
    report.processLifecycleScope = 'Shared installed-main identity and no-kill lifecycle; not a software-snapshot acceptance claim';
    const launch = await lifecycle.beforeLaunch();
    const { _electron } = await import('playwright');
    app = await _electron.launch({ executablePath: plan.installedExe, args: [], cwd: root, env: fz3b051LaunchEnvironment(process.env, plan.dataDir), timeout: 60000 });
    await lifecycle.attach(app);
    const identity = launch.desktopIdentity; report.desktop = { sid: identity.sid, sessionId: identity.sessionId, elevated: identity.elevated, explorerMatched: true };
    page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
    await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 30000 });
    const state = await snapshot(); assert.equal(state.version, plan.version); assert.ok(samePath(state.dataDir, plan.dataDir));
    assert.equal(state.fz3bAgent?.available, true, state.fz3bAgent?.reason); await evidence();
  }
  async function capture(label: string) {
    await page!.evaluate(() => { const node = document.querySelector('.sidebar-footer strong'); if (node) node.textContent = 'Official account (redacted)'; });
    for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) {
      await page!.setViewportSize(size); await pause(150); assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page!.screenshot({ path: path.join(output, `${label}-${size.width}x${size.height}.png`) });
    }
    await page!.setViewportSize({ width: 1380, height: 900 });
  }
  async function closeApp() {
    assert.ok(app && lifecycle); const state = await snapshot();
    assertFz3bCloseSafe(owned(state), state.fz3bAgent?.engineState ?? '', state.fz3bAgent?.activeRunId);
    for (const run of state.fz3bAgent?.runs ?? []) assertFz3bRunUnheld(run, plan.fixture);
    assert.equal(state.hardwareAgent?.activeRunId, undefined); await verifyHistory(state);
    const close = await lifecycle.closeNormally(); report.closes.push(close); app = undefined; page = undefined; await evidence();
  }
  async function observeActiveClose(run: Fz3bRunView) {
    assert.ok(run.active || run.hardwareBusy); assert.equal(run.nativeApproval, 'not_requested');
    report.activeClose = { requestedAt: new Date().toISOString(), before: run, attempts: 1, scope: 'Real active model close guard, not crash or physical fault' }; await evidence();
    const request = observeNormalCloseRequest(app!.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows(); if (windows.length !== 1) throw new Error('Expected one real product window'); windows[0].close();
    }), 5000);
    const read = async () => { const state = await snapshot(); await observe(state); report.activeClose.pendingRun = owned(state);
      await evidence(); return report.nativeLive as Awaited<ReturnType<typeof readFz3bNativeObserver>>; };
    await waitFor(read, value => value.calls.some(call => call.kind === 'close-warning'), 'original native close warning', 15000);
    report.activeClose.windowWhileWarning = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, destroyed: window.isDestroyed() })));
    assert.equal(report.activeClose.windowWhileWarning.length, 1); assert.equal(report.activeClose.windowWhileWarning[0].destroyed, false); await evidence();
    console.log('FZ3B051 NATIVE ACTION: acknowledge only the exact real active-close warning under coordinator review; no response is generated here.');
    const warning = await waitFor(read, value => value.calls.some(call => call.kind === 'close-warning' && call.phase === 'fulfilled'), 'coordinator warning acknowledgement', 180000);
    assert.equal(warning.calls.filter(call => call.kind === 'close-warning').length, 1); assert.equal((await request).state, 'acknowledged');
    const launch = lifecycle!.evidence.launches.at(-1)!; const expected = launch.nativeMain!; const main = launch.electronMain!;
    const { stdout } = await execute('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(main.pid)], { windowsHide: true, shell: false, timeout: 20000 });
    const native = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as InstalledMainProcess | null;
    assertInstalledMainProcess(native, main, plan.installedExe, report.desktop.sid, report.desktop.sessionId);
    assert.equal(Date.parse(native.created), Date.parse(expected.created));
    report.activeClose.warning = warning; report.activeClose.nativeAfterWarning = native; report.controls.activeCloseGuard = 'passed'; await evidence();
  }
  try {
    report.sourceHashes = {};
    report.sourceHashesScope = 'Exact local harness/validator files; release candidate and pinned ASAR establish separate installed-byte identity';
    for (const relative of ['tests/fz3b-051-cancel-smoke.ts', 'tests/helpers/fz3b-cancel-installed.ts', 'tests/helpers/fz3b-cancel-stop-observer.ts', 'tests/helpers/fz3b-051-installed.ts', 'tests/helpers/fz3b-installed.ts',
      'tests/helpers/fz3b-installed-history.ts', 'tests/helpers/fz3b-installed-ui.ts', 'tests/helpers/fz3b-installed-startup.ts',
      'tests/helpers/fz3b-native-observer.ts', 'tests/helpers/snapshot-installed-lifecycle.ts', 'tests/helpers/snapshot-installed-release.ts',
      'tests/helpers/normal-close-observation.ts', 'tests/helpers/playwright-no-kill.ts', 'tests/helpers/second-user-controls.ts']) report.sourceHashes[relative] = await fileSha256(path.join(root, relative));
    await evidence(); await launch(); await verifyHistory(await snapshot());
    const initial = await connectFz3bInstalledStartup({ snapshot, fixture: plan.fixture, connect: () => page!.evaluate(() => window.forgeDesk.connect()), wait: pause,
      observe: async value => { report.startupObservations.push(value); await evidence(); } });
    assert.equal(initial.account.loggedIn, true, 'Retain the genuine official product login; no credential copy or synthetic account');
    report.publicAccount = { loggedIn: true }; report.controls.publicLogin = 'passed';
    const project = initial.projects.find(item => samePath(item.root, plan.projectRoot)); assert.ok(project, 'Import the exact reviewed project normally first; no chooser is stubbed');
    const title = `FZ3B 0.5.1 planner-stop ${plan.runId}`;
    const session = await page!.evaluate(({ id, title }) => window.forgeDesk.createSession(id, title), { id: project.id, title });
    taskId = session.taskId; sessionId = session.id; report.taskId = taskId; report.sessionId = sessionId;
    assert.equal(session.threadId, undefined); assert.equal(session.messages.length, 0); assert.equal(await page!.evaluate(id => window.forgeDesk.fz3bSnapshot(id), taskId), null);
    const ui = fz3bInstalledUi(page!); await ui.project(project, plan.projectRoot).click(); await ui.session(title).click();
    await ui.taskTab.click(); await ui.platformTab.click(); await ui.region.waitFor({ state: 'visible' });
    await ui.instruction.fill(FZ3B_INSTRUCTION); assert.equal(await ui.model.inputValue(), plan.model); await ui.start.waitFor({ state: 'visible' });
    await capture('before-model-start'); report.nativeObserver = await app!.evaluate(installFz3bNativeObserver, { runId: plan.runId }); observerInstalled = true;
    console.log('FZ3B051 NATIVE ACTION: review fresh target, original expiry, plan/query/image pins and disclosed side effects, then operate the real checkbox once. No automatic consent exists in this entry.');
    await ui.start.click(); report.uiSubmitCount++; await evidence(); const submittedAt = Date.now(); let lastObservation = 0;
    const completed = await waitFor(async () => {
      const state = await bounded(snapshot(), 'run snapshot'); await observe(state); const run = owned(state);
      if (state.fz3bAgent?.policy && !report.policy) { report.policy = assertFz3bPolicy(state.fz3bAgent.policy, plan.resourceHashes['resources/codex/codex.exe']); report.controls.policy = 'passed'; }
      if (!run && state.sessions.find(item => item.id === sessionId)?.status === 'needs_attention') throw new Error('Restricted startup needs attention before model dispatch');
      if (!run && Date.now() - submittedAt > 180000) throw new Error('Restricted startup did not establish a run');
      if (run) {
        if (run.status === 'needs_attention' || run.operations.some(op => ['unknown', 'failed'].includes(op.status)) || run.calls.some(call => ['unknown', 'failed', 'replayed', 'rejected'].includes(call.status))) { await evidence(); throw new Error(`FZ3B051 failed/unknown: ${run.status}; ${run.failure ?? ''}; no automatic retry, reconciliation or unlock`); }
        if (run.calls.some(call => call.tool === 'fz3b_export') || run.export) throw new Error('Model exported before the one-stop observation; cancellation window was not covered');
        if (!dispatchBeforeStop && run.operations.some(op => op.kind === 'semantic' && op.status === 'running')) await stopOnce(run);
        else if (!dispatchBeforeStop && (run.status === 'stopped' || run.operations.some(op => op.kind === 'semantic' && op.status === 'succeeded'))) throw new Error('Durable semantic running window was missed; no late Stop or retry accepted');
        if (!report.activeClose && run.active && run.nativeApproval === 'not_requested') await observeActiveClose(run);
        if (stopObserverInstalled) {
          report.stopReceipt = await bounded(app!.evaluate(readFz3bCancelStopObserver, { runId: controllerId! }), 'Stop receipt');
          if (report.stopReceipt.calls.length > 1 || report.stopReceipt.calls.some((call: { phase: string }) => call.phase === 'rejected')) throw new Error('The original Stop IPC rejected or was duplicated; no retry accepted');
        }
        if (run.stopRequested && !report.plannerStopObserved) report.plannerStopObserved = { observedAt: new Date().toISOString(), active: run.active,
          engineState: state.fz3bAgent?.engineState, hardwareBusy: run.hardwareBusy, operation: run.operations.find(op => op.kind === 'semantic'),
          workerDrainedClaim: false };
        if (Date.now() - lastObservation >= 1000) { report.observations.push({ observedAt: new Date().toISOString(), run }); lastObservation = Date.now(); }
      }
      await evidence(); return state;
    }, state => { const run = owned(state), session = state.sessions.find(item => item.id === sessionId); return !!dispatchBeforeStop && run?.status === 'stopped' && run.stopRequested && !run.hardwareBusy && !state.fz3bAgent?.activeRunId && state.fz3bAgent?.engineState === 'stopped' && session?.status === 'interrupted' && !session.turnId && report.stopReceipt?.calls.length === 1 && report.stopReceipt.calls[0].phase === 'fulfilled'; }, 'one UI Stop, original worker drain and owner release', 900000);
    assert.equal(report.uiSubmitCount, 1); assert.ok(report.policy); assert.equal(report.controls.activeCloseGuard, 'passed');
    assert.equal(report.uiStopCount, 1); assert.ok(dispatchBeforeStop); assertFz3bCancelStopReceipt(report.stopReceipt);
    const run = owned(completed)!; report.drain = assertCancelDrained(dispatchBeforeStop, run, completed, report.stopReceipt.calls[0].startedAt); report.run = run;
    report.stopObserverRestored = await bounded(app!.evaluate(restoreFz3bCancelStopObserver, { runId: controllerId! }), 'Stop observer restoration'); stopObserverInstalled = false;
    report.nativeConfirmation.receipt = await app!.evaluate(readFz3bNativeObserver, { runId: plan.runId });
    report.nativeFixedTtl = assertFz3b051NativeGrant(run, report.nativeConfirmation.receipt, grantTimeline); report.supplementalControls.nativeFixedTtl = 'passed';
    report.callAssociations = run.calls.map(call => ({ runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, generation: run.generation,
      threadId: run.threadId, turnId: run.turnId, callId: call.callId, tool: call.tool, operationId: call.operationId }));
    report.nativeObserverRestored = await app!.evaluate(restoreFz3bNativeObserver, { runId: plan.runId }); observerInstalled = false;
    report.localExportInvoked = { taskId, via: 'original public fz3bExport after owner release; no model export tool', invokedAt: new Date().toISOString() }; await evidence();
    const directory = await bounded(page!.evaluate(id => window.forgeDesk.fz3bExport(id), taskId!), 'local evidence export', 60000); assert.ok(directory);
    report.export = await verifyCancelExport(plan.dataDir, directory, run, plan);
    assertFz3bNoReplay(run, owned(await snapshot())!);
    for (const name of ['build', 'inspect', 'nativeAuthorization', 'uiStop', 'workerDrained', 'noModelExport', 'localExport']) report.controls[name] = 'passed';
    await capture('planner-stopped-worker-drained'); await evidence(); await closeApp(); await launch();
    const after = await snapshot(), restored = after.fz3bAgent?.runs.find(item => item.runId === run.runId); assert.ok(restored);
    assertFz3bNoReplay(run, restored); assertFz3bCloseSafe(restored, after.fz3bAgent?.engineState ?? '', after.fz3bAgent?.activeRunId);
    assert.equal((await verifyCancelExport(plan.dataDir, report.export.path, restored, plan)).sha256, report.export.sha256); await verifyHistory(after);
    report.restart = { before: run, after: restored, newModelTurnsSubmitted: 0, newHardwareActionsSubmitted: 0 }; report.controls.restartNoReplay = 'passed';
    await capture('restored-history');
    assert.equal(after.approvals.length, 0); assert.equal(after.hardwareAgent?.activeRunId, undefined);
    for (const history of after.fz3bAgent?.runs ?? []) assertFz3bRunUnheld(history, plan.fixture);
    report.idleModeExit = { before: after.hardware.modeActive, via: 'public fz3bLeaveMode with original main/backend idle gates', invoked: false };
    if (after.hardware.modeActive) { report.idleModeExit.invoked = true; await evidence(); await page!.evaluate(() => window.forgeDesk.fz3bLeaveMode()); }
    const softwareMode = await snapshot(); assert.equal(softwareMode.hardware.modeActive, false); assertFz3bStartupIdle(softwareMode, plan.fixture);
    assertFz3bNoReplay(run, softwareMode.fz3bAgent!.runs.find(item => item.runId === run.runId)!);
    report.idleModeExit.after = false; report.supplementalControls.idleModeExit = 'passed';
    await closeApp(); report.controls.normalClose = 'passed';
    assert.equal(report.pageErrors.length, 0); assert.ok(Object.values(report.controls).every(value => value === 'passed'));
    assert.ok(Object.values(report.supplementalControls).every(value => value === 'passed'));
    report.result = 'passed'; report.completedAt = new Date().toISOString(); await evidence();
    console.log(JSON.stringify({ result: report.result, version: plan.version, output, evidenceSha256: await fileSha256(path.join(output, 'evidence.json')) }));
  } catch (error) {
    report.result = 'failed'; report.failures.push(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    try { if (page) { const state = await snapshot(); await observe(state); report.failureRun = owned(state); report.failureController = { activeRunId: state.fz3bAgent?.activeRunId, engineState: state.fz3bAgent?.engineState }; await page.screenshot({ path: path.join(output, 'failure.png') }); } }
    catch (failure) { report.observationError = redact(String(failure)); }
    if (app && observerInstalled) try {
      const receipt = await app.evaluate(readFz3bNativeObserver, { runId: plan.runId }); report.failureNative = receipt;
      if (receipt.calls.every(call => call.phase !== 'started')) { report.nativeObserverRestored = await app.evaluate(restoreFz3bNativeObserver, { runId: plan.runId }); observerInstalled = false; }
    } catch (failure) { report.observerError = redact(String(failure)); }
    if (app && stopObserverInstalled) try {
      report.stopReceipt = await bounded(app.evaluate(readFz3bCancelStopObserver, { runId: controllerId! }), 'failed Stop receipt');
      if (report.stopReceipt.calls.every((call: { phase: string }) => call.phase !== 'started')) { report.stopObserverRestored = await bounded(app.evaluate(restoreFz3bCancelStopObserver, { runId: controllerId! }), 'failed Stop observer restoration'); stopObserverInstalled = false; }
    } catch (failure) { report.stopObserverError = redact(String(failure)); }
    if (app && !observerInstalled && !stopObserverInstalled) try { await closeApp(); } catch (failure) { report.cleanupError = redact(String(failure)); }
    const protection = lifecycle?.protectOnFailure(); report.protection = protection; report.needsHumanClose = protection?.needsHumanClose ?? !!app;
    report.completedAt = new Date().toISOString(); await evidence();
    console.error(JSON.stringify({ result: 'failed', output, needsHumanClose: report.needsHumanClose, productKillAttempted: false }));
    if (protection?.safeHarnessExit === false) { setInterval(() => {}, 1000); await new Promise<never>(() => {}); }
    process.exit(1);
  }
}
