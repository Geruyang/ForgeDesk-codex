import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { Fz3bRunView } from '../packages/engineering-runner/fz3b/types';
import { redact } from '../packages/engineering-runner/redaction';
import { fileSha256, inside, plainPath, samePath } from './helpers/embedded-installed';
import { primarySid, readDesktopIdentity } from './helpers/snapshot-smoke-scope';
import { assertElectronMainExited, assertElectronMainIdentity, assertInstalledMainProcess, nativeMainProcessQuery,
  type ElectronMainIdentity, type InstalledMainProcess } from './helpers/second-user-controls';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';
import { FZ3B_CONTROLS, FZ3B_INSTRUCTION, FZ3B_PRODUCT_OUTPUT, assertFz3bCloseSafe, assertFz3bCompletion, assertFz3bNoReplay,
  assertFz3bPolicy, fz3bPlanScope, prepareFz3bInstalledPlan, readPinnedFz3bResources, sanitizeFz3bEvidence, verifyFz3bArtifacts } from './helpers/fz3b-installed';
import { assertFz3bNativeReceipt, installFz3bNativeObserver, readFz3bNativeObserver, restoreFz3bNativeObserver } from './helpers/fz3b-native-observer';
import { fz3bInstalledUi } from './helpers/fz3b-installed-ui';
import { connectFz3bInstalledStartup } from './helpers/fz3b-installed-startup';
import { assertFz3bHistoryStable, assertFz3bRunUnheld, verifyFz3bHistoricalReleases } from './helpers/fz3b-installed-history';

// Execution is explicitly coordinator-owned. No app, model, SSH or board is touched by --prepare-only.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, filename, ...extra] = process.argv.slice(2);
assert.ok(['--prepare-only', '--execute-real-model-fz3b'].includes(mode) && filename && !extra.length,
  'Use --prepare-only <absolute-request.json> or --execute-real-model-fz3b <absolute-plan.json>');
assert.ok(path.isAbsolute(filename) && inside(path.join(root, FZ3B_PRODUCT_OUTPUT, 'plans'), filename));
await plainPath(filename); const info = await lstat(filename); assert.ok(info.isFile() && info.nlink === 1 && info.size <= 65536);
const input = JSON.parse(await readFile(filename, 'utf8'));
if (mode === '--prepare-only') {
  assert.ok(filename.endsWith('.request.json'));
  const plan = await prepareFz3bInstalledPlan(root, input), destination = filename.slice(0, -'.request.json'.length) + '.plan.json';
  await writeFile(destination, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ result: 'prepared-only-not-accepted', plan: destination, runId: plan.runId,
    next: `node --import tsx tests/fz3b-installed-smoke.ts --execute-real-model-fz3b "${destination}"`,
    prerequisites: ['Installed resources/version/artifact pins and actual candidate manifest reviewed by coordinator; supplied git base is not exact runtime source',
      'Normally import the exact project and project device key in the product; retain official login',
      'Fresh target inspection and original native warning/checkbox/approval handled visibly by coordinator'] }, null, 2));
} else {
  assert.equal(process.platform, 'win32');
  const scope = fz3bPlanScope(root, input, process.env), { plan } = scope;
  const execute = promisify(execFile), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  let app: ElectronApplication | undefined, page: Page | undefined, launcher: ChildProcess | undefined;
  let main: ElectronMainIdentity | undefined, native: InstalledMainProcess | undefined, exitListeners: readonly Function[] = [];
  let taskId: string | undefined, sessionId: string | undefined, controllerId: string | undefined, observerInstalled = false;
  let historicalRuns: Fz3bRunView[] | undefined;
  let historicalProofs: Awaited<ReturnType<typeof verifyFz3bHistoricalReleases>> | undefined;
  let installedResources: Map<string, Buffer>;
  const report: Record<string, any> = { schemaVersion: 1, runId: plan.runId, scope: plan.scope, realModel: true, secondUser: false,
    startedAt: new Date().toISOString(), runtimeCommit: plan.runtimeCommit, model: plan.model, dataDir: plan.dataDir, projectRoot: plan.projectRoot,
    sourceIdentity: { suppliedGitBase: plan.runtimeCommit, exactRuntimeSourceCommit: false,
      meaning: 'Supplied git base with an uncommitted worktree; not exact installed runtime source. Coordinator must associate the actual capture-candidate manifest and artifact hashes.' },
    controls: Object.fromEntries(FZ3B_CONTROLS.map(name => [name, 'pending'])), launches: [], closes: [], observations: [], startupObservations: [], failures: [], pageErrors: [], uiSubmitCount: 0,
    nativeConfirmation: { synthesizedDialogResponse: false, operator: plan.nativeOperator, mechanism: 'Original native UI; pass-through observation only. Coordinator must verify fresh inspected identity before actual checkbox/approval.' },
    limitations: ['Fixed existing candidate008, deployed PS v2 and predeclared real-text image only; no new deployment or PL construction.',
      'TOFU-derived host-key pin continuity is not independent chip authentication or loaded-image attestation.',
      'Unknown-operation hold/close rejection is offline-fixture coverage only, not real-board fault injection.',
      'runtimeCommit is the supplied Git base only, not an exact runtime source commit; local validator source hashes do not establish installed-source equivalence.',
      'Ranking, thresholdHit and classificationUnknown are distinct; not broad accuracy, throughput, malicious-SID isolation or second-user acceptance.'] };
  async function evidence() { await writeFile(path.join(scope.output, 'evidence.json'), JSON.stringify(sanitizeFz3bEvidence(report), null, 2) + '\n'); }
  async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
  async function verifyHistory(state: AppSnapshot) {
    const all = state.fz3bAgent?.runs; assert.ok(all);
    const old = all.filter(run => run.runId !== controllerId);
    if (historicalRuns) assertFz3bHistoryStable(historicalRuns, all, controllerId);
    const proof = await verifyFz3bHistoricalReleases(plan.dataDir, old, plan.fixture, installedResources);
    if (historicalProofs) assert.deepEqual(proof, historicalProofs, 'Historical public evidence bytes must remain unchanged');
    else { historicalProofs = proof; historicalRuns = structuredClone(old); report.history = { baseline: historicalRuns, publicEvidence: proof,
      scope: 'Original unknown inspect and calls retained; only exact native reconciliation releases occupancy. No original run resumes or becomes passed.' }; }
    report.history.lastVerifiedAt = new Date().toISOString();
  }
  function owned(state: AppSnapshot) { return state.fz3bAgent?.runs.find(run => run.taskId === taskId && (!controllerId || run.runId === controllerId)); }
  async function processIdentity(pid: number): Promise<InstalledMainProcess | null> {
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { windowsHide: true, shell: false, timeout: 20000 });
    return JSON.parse(stdout.trim());
  }
  async function noInstalledApplication() {
    const identity = await readDesktopIdentity(); assert.equal(identity.sid, primarySid); assert.equal(identity.elevated, false); assert.equal(identity.interactive, true);
    assert.ok(identity.explorerOwners.some(owner => owner.sid === identity.sid && owner.sessionId === identity.sessionId));
    assert.equal(identity.applications.filter(item => samePath(item.executable, plan.installedExe)).length, 0, 'Close the installed product normally first'); return identity;
  }
  async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeout: number): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await pause(100); }
    throw new Error(`${label} timed out; no action was retried or remote state inferred from process exit`);
  }
  async function capture(label: string) {
    await page!.evaluate(() => { const node = document.querySelector('.sidebar-footer strong'); if (node) node.textContent = 'Official account (redacted)'; });
    for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) {
      await page!.setViewportSize(size); await pause(150); assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page!.screenshot({ path: path.join(scope.output, `${label}-${size.width}x${size.height}.png`) });
    }
    await page!.setViewportSize({ width: 1380, height: 900 });
  }
  async function launch() {
    await noInstalledApplication(); exitListeners = capturePlaywrightExitListeners(); const { _electron } = await import('playwright');
    const env = Object.fromEntries(Object.entries({ ...process.env, FORGEDESK_DATA_DIR: plan.dataDir }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    app = await _electron.launch({ executablePath: plan.installedExe, args: [], env, timeout: 60000 }); launcher = app.process();
    main = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: process.type, platform: process.platform }));
    assertElectronMainIdentity(main, plan.installedExe); const identity = await readDesktopIdentity(), observed = await processIdentity(main.pid);
    assertInstalledMainProcess(observed, main, plan.installedExe, primarySid, identity.sessionId); native = observed;
    report.launches.push({ launcherPid: launcher.pid, electronMain: main, nativeMain: observed, launcherPidScope: 'Playwright launcher, not Electron main' });
    page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
    await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 30000 }); const state = await snapshot();
    assert.equal(state.version, plan.version); assert.ok(samePath(state.dataDir, plan.dataDir)); assert.equal(state.fz3bAgent?.available, true, state.fz3bAgent?.reason);
    await evidence();
  }
  async function closeApp() {
    assert.ok(app && launcher && main && native); const state = await snapshot();
    assertFz3bCloseSafe(owned(state), state.fz3bAgent?.engineState ?? '', state.fz3bAgent?.activeRunId);
    for (const run of state.fz3bAgent?.runs ?? []) assertFz3bRunUnheld(run, plan.fixture);
    await verifyHistory(state);
    assert.equal(state.hardwareAgent?.activeRunId, undefined);
    const current = app, child = launcher, expected = native; assert.equal(child.exitCode, null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const request = observeNormalCloseRequest(current.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); }), 5000);
    const exit = await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Normal close unconfirmed; no forced termination')), 45000); })]).finally(() => { if (timer) clearTimeout(timer); });
    assert.equal(exit.code, 0); assert.equal(exit.signal, null); const after = await processIdentity(expected.id); assertElectronMainExited(expected, after); await noInstalledApplication();
    report.closes.push({ electronMain: main, nativeAfter: after, normalClose: true, installedGuiAbsent: true, launcherExitCode: exit.code,
      launcherSignal: exit.signal, exitCodeScope: 'Playwright launcher', nativeCloseObservation: await request });
    await current.close(); app = undefined; page = undefined; launcher = undefined; main = undefined; native = undefined; await evidence();
  }
  async function observeActiveClose(run: Fz3bRunView) {
    assert.ok(run.active || run.hardwareBusy); assert.equal(run.nativeApproval, 'not_requested');
    report.activeClose = { requestedAt: new Date().toISOString(), before: run, attempts: 1, scope: 'Graceful close during live model ownership, not crash or physical fault' }; await evidence();
    const request = observeNormalCloseRequest(app!.evaluate(({ BrowserWindow }) => { const windows = BrowserWindow.getAllWindows(); if (windows.length !== 1) throw new Error('Expected one product window'); windows[0].close(); }), 5000);
    console.log('FZ3B NATIVE ACTION: acknowledge the real active-task close warning normally. No response is generated by this harness.');
    await waitFor(() => app!.evaluate(readFz3bNativeObserver, { runId: plan.runId }), value => value.calls.some(call => call.kind === 'close-warning'), 'real close warning', 15000);
    report.activeClose.windowWhileWarning = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id, destroyed: window.isDestroyed() })));
    assert.equal(report.activeClose.windowWhileWarning.length, 1); assert.equal(report.activeClose.windowWhileWarning[0].destroyed, false); await evidence();
    const warning = await waitFor(() => app!.evaluate(readFz3bNativeObserver, { runId: plan.runId }), value => value.calls.some(call => call.kind === 'close-warning' && call.phase === 'fulfilled'), 'coordinator close-warning acknowledgement', 180000);
    assert.equal(warning.calls.filter(call => call.kind === 'close-warning').length, 1); assert.equal((await request).state, 'acknowledged');
    const observed = await processIdentity(main!.pid); assertInstalledMainProcess(observed, main!, plan.installedExe, primarySid, report.desktop.sessionId);
    assert.equal(observed.created, native!.created);
    assert.equal(launcher!.exitCode, null); report.activeClose.warning = warning; report.activeClose.nativeAfterWarning = observed; report.controls.activeCloseGuard = 'passed'; await evidence();
  }

  for (const file of [scope.output, plan.projectRoot, plan.dataDir, plan.installedExe, plan.installerPath]) await plainPath(file);
  installedResources = await readPinnedFz3bResources(plan); assert.equal(await fileSha256(plan.installedExe), plan.executableSha256); assert.equal(await fileSha256(plan.installerPath), plan.installerSha256);
  for (const [relative, hash] of Object.entries(plan.resourceHashes)) { const file = path.join(path.dirname(plan.installedExe), relative); await plainPath(file); assert.equal(await fileSha256(file), hash); }
  const identity = await noInstalledApplication(); await mkdir(path.dirname(scope.output), { recursive: true }); await mkdir(scope.output);
  report.desktop = { sid: identity.sid, sessionId: identity.sessionId, elevated: identity.elevated, explorerMatched: true };
  report.release = { version: plan.version, suppliedRuntimeCommit: plan.runtimeCommit, executableSha256: plan.executableSha256, installerSha256: plan.installerSha256, resourceHashes: plan.resourceHashes };
  report.release.suppliedRuntimeCommitMeaning = 'git-base-only-not-exact-runtime-source';
  report.planSha256 = await fileSha256(filename); report.sourceHashes = {};
  report.sourceHashesScope = 'Local harness/validator files at test startup; not a claim that these are exact installed app.asar source bytes';
  for (const relative of ['tests/fz3b-installed-smoke.ts', 'tests/helpers/fz3b-installed.ts', 'tests/helpers/fz3b-native-observer.ts',
    'tests/helpers/fz3b-installed-ui.ts', 'tests/helpers/fz3b-installed-startup.ts',
    'tests/helpers/fz3b-installed-history.ts', 'packages/engineering-runner/fz3b/backend.ts', 'packages/engineering-runner/fz3b/payload.ts',
    'packages/engineering-runner/fz3b/reconciliation.ts',
    'packages/engineering-runner/fz3b/profile.ts', 'packages/engineering-runner/fz3b/worker.ts']) report.sourceHashes[relative] = await fileSha256(path.join(root, relative));
  await evidence();
  try {
    await launch(); await verifyHistory(await snapshot());
    const initial = await connectFz3bInstalledStartup({ snapshot, fixture: plan.fixture, connect: () => page!.evaluate(() => window.forgeDesk.connect()), wait: pause,
      observe: async value => { report.startupObservations.push(value); await evidence(); } });
    assert.equal(initial.account.loggedIn, true, 'Use actual official login; no credential copying or synthetic account');
    assert.equal(initial.hardware.modeActive, false); assert.equal(initial.fz3bAgent?.activeRunId, undefined);
    assert.ok(initial.fz3bAgent?.runs.every(run => !run.active && !run.hardwareBusy)); report.publicAccount = { loggedIn: true }; report.controls.publicLogin = 'passed';
    const project = initial.projects.find(item => samePath(item.root, plan.projectRoot)); assert.ok(project, 'Import the exact reviewed project normally in the product before this entry; no native chooser is stubbed');
    report.projectIdentity = { id: project.id, expectedRoot: plan.projectRoot, observedRoot: project.root, samePathVerified: true };
    const title = `FZ3B installed ${plan.runId}`, session = await page!.evaluate(({ id, title }) => window.forgeDesk.createSession(id, title), { id: project.id, title });
    taskId = session.taskId; sessionId = session.id; report.taskId = taskId; report.sessionId = sessionId;
    assert.equal(session.threadId, undefined); assert.equal(session.messages.length, 0); assert.equal(await page!.evaluate(id => window.forgeDesk.fz3bSnapshot(id), taskId), null);
    const ui = fz3bInstalledUi(page!);
    await ui.project(project, plan.projectRoot).click(); await ui.session(title).click();
    await ui.taskTab.click(); await ui.platformTab.click();
    await ui.region.waitFor({ state: 'visible' }); await ui.instruction.fill(FZ3B_INSTRUCTION);
    assert.equal(await ui.model.inputValue(), plan.model);
    await ui.start.waitFor({ state: 'visible' });
    await capture('before-model-start');
    report.nativeObserver = await app!.evaluate(installFz3bNativeObserver, { runId: plan.runId }); observerInstalled = true;
    console.log('FZ3B NATIVE ACTION: inspect the fresh identity, then operate the original checkbox and one-shot approval under user delegation. No main/backend approval replacement exists in this test.');
    await ui.start.click(); report.uiSubmitCount++; await evidence();
    let lastObservation = 0; const submittedAt = Date.now();
    const completed = await waitFor(async () => {
      const state = await snapshot(), run = owned(state);
      if (state.fz3bAgent?.policy && !report.policy) { report.policy = assertFz3bPolicy(state.fz3bAgent.policy, plan.resourceHashes['resources/codex/codex.exe']); report.controls.policy = 'passed'; }
      if (!run && state.sessions.find(item => item.id === sessionId)?.status === 'needs_attention') throw new Error('Restricted startup needs attention before model dispatch');
      if (!run && Date.now() - submittedAt > 180000) throw new Error('Restricted startup did not establish a run');
      if (run) {
        controllerId ??= run.runId; report.run = run;
        if (['needs_attention', 'stopped'].includes(run.status) || run.operations.some(op => ['unknown', 'failed'].includes(op.status))) { await evidence(); throw new Error(`FZ3B did not complete: ${run.status}; ${run.failure ?? ''}. No retry or unknown-state clearing attempted`); }
        if (!report.activeClose && run.active && run.nativeApproval === 'not_requested') await observeActiveClose(run);
        if (Date.now() - lastObservation >= 1000) { report.observations.push({ observedAt: new Date().toISOString(), run }); lastObservation = Date.now(); await evidence(); }
      }
      return state;
    }, state => { const run = owned(state), session = state.sessions.find(item => item.id === sessionId); return run?.status === 'completed' && !state.fz3bAgent?.activeRunId && state.fz3bAgent?.engineState === 'stopped' && session?.status === 'completed' && !session.turnId; }, 'real FZ3B workflow and settled model turn', 900000);
    assert.equal(report.uiSubmitCount, 1); assert.ok(report.policy); assert.equal(report.controls.activeCloseGuard, 'passed');
    const run = owned(completed)!; assertFz3bCompletion(run, plan.fixture); report.run = run;
    report.callAssociations = run.calls.map(call => ({ runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, generation: run.generation,
      threadId: run.threadId, turnId: run.turnId, callId: call.callId, tool: call.tool, operationId: call.operationId }));
    report.nativeConfirmation.receipt = await app!.evaluate(readFz3bNativeObserver, { runId: plan.runId });
    assertFz3bNativeReceipt(report.nativeConfirmation.receipt, [run.taskId, run.runId, run.identity!.hostKeySha256, run.identity!.bootId,
      run.artifact!.id, run.grant!.planSha256, plan.fixture.queriesSha256, plan.fixture.imageSha256]);
    report.nativeObserverRestored = await app!.evaluate(restoreFz3bNativeObserver, { runId: plan.runId }); observerInstalled = false;
    report.export = await verifyFz3bArtifacts(plan.dataDir, run, plan);
    for (const name of ['modelCalls', 'build', 'inspect', 'nativeAuthorization', 'semantic', 'export']) report.controls[name] = 'passed';
    await capture('model-completed'); await evidence(); await closeApp(); await launch();
    const after = await snapshot(), restored = after.fz3bAgent?.runs.find(item => item.runId === run.runId); assert.ok(restored); assertFz3bNoReplay(run, restored);
    assertFz3bCloseSafe(restored, after.fz3bAgent?.engineState ?? '', after.fz3bAgent?.activeRunId);
    assert.equal((await verifyFz3bArtifacts(plan.dataDir, restored, plan)).sha256, report.export.sha256);
    report.restart = { before: run, after: restored, newModelTurnsSubmitted: 0, newHardwareActionsSubmitted: 0 }; report.controls.restartNoReplay = 'passed';
    await capture('restored-history'); await closeApp(); report.controls.normalClose = 'passed';
    assert.equal(report.pageErrors.length, 0); assert.ok(Object.values(report.controls).every(value => value === 'passed'));
    report.result = 'passed'; report.completedAt = new Date().toISOString(); await evidence();
  } catch (error) {
    report.result = 'failed'; report.failures.push(redact(String(error)));
    try { if (page) { const state = await snapshot(); report.failureRun = owned(state); report.failureController = { activeRunId: state.fz3bAgent?.activeRunId, engineState: state.fz3bAgent?.engineState }; } } catch (failure) { report.observationError = redact(String(failure)); }
    if (app && observerInstalled) {
      try { const receipt = await app.evaluate(readFz3bNativeObserver, { runId: plan.runId }); report.failureNative = receipt;
        if (receipt.calls.every(call => call.phase !== 'started')) { report.nativeObserverRestored = await app.evaluate(restoreFz3bNativeObserver, { runId: plan.runId }); observerInstalled = false; }
      } catch (failure) { report.observerError = redact(String(failure)); }
    }
    if (!observerInstalled) { try { if (app) await closeApp(); } catch (failure) { report.cleanupError = redact(String(failure)); } }
    report.needsHumanClose = !!app; await evidence();
    if (app && launcher && launcher.exitCode === null) {
      try { report.playwrightNoKill = detachNewPlaywrightExitHandler(exitListeners); await evidence(); process.exit(1); }
      catch (failure) { report.noKillDetachError = redact(String(failure)); await evidence(); console.error('Keep the live product intact; coordinator must resolve ownership and close normally.'); await new Promise<void>(resolve => launcher!.once('close', () => resolve())); }
    }
    process.exitCode = 1;
  }
}
