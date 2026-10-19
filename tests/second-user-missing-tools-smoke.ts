import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import { redact } from '../packages/engineering-runner/redaction';
import { assertSecondUserAppClosed, installerSha256, prepareSnapshotScope, readDesktopIdentity, type SnapshotSmokeScope } from './helpers/snapshot-smoke-scope';
import { approvedMissingToolsSid, assertAcceptanceUnchanged, assertMissingGitResult, assertMissingNodeResult,
  assertMissingToolsDesktop, assertMissingToolsPlainPath, missingToolsAppEnvironment, missingToolsGateEnvironment, missingToolsPaths } from './helpers/second-user-missing-tools';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';
import { observeNormalCloseRequest } from './helpers/normal-close-observation';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `snapshot-${Date.now()}${randomInt(100000, 1000000)}`;
const report: Record<string, any> = { schemaVersion: 1, scenario: 'second-user-missing-tools', method: 'process-PATH-fault-injection',
  runId, startedAt: new Date().toISOString(), approvedSid: approvedMissingToolsSid, expectedInstalledVersion: '0.2.1',
  expectedInstallerSha256: installerSha256, realModelTurnInvoked: false, testReadAuthenticationFiles: false, systemConfigurationChanged: false,
  limitation: 'Only this child process receives an empty PATH. This is not evidence that Node or Git is uninstalled; configured absolute Node commands and B profiles are not covered.',
  phase: 'entry-gate', steps: [], failures: [], pageErrors: [], cleanup: { appStarted: false, normalClose: false, forcedKill: false } };
let scope: SnapshotSmokeScope | undefined;
let app: ElectronApplication | undefined;
let launcherChild: ChildProcess | undefined;
let page: Page | undefined;
let output: string | undefined;
let taskId: string | undefined;
let launchExitListeners: readonly Function[] | undefined;
let safeHarnessExit = false;
const parentPath = process.env.PATH;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error));

async function evidence() {
  assert.ok(output);
  await assertMissingToolsPlainPath(root, path.join(output, 'evidence.json'));
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(report, null, 2));
}
async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
function ownTask(state: AppSnapshot) {
  const task = state.tasks.find(item => item.id === taskId); assert.ok(task, 'The newly imported task must exist');
  return task as unknown as Record<string, unknown>;
}
async function normallyClose(application: ElectronApplication) {
  assert.ok(scope, 'Normal close requires the verified second-user scope');
  const child = launcherChild;
  assert.ok(child, 'The launcher must be cached before application close');
  assert.equal(child.exitCode, null, 'Playwright launcher exited before the normal-close request');
  assert.equal(child.signalCode, null, 'Playwright launcher was terminated before the normal-close request');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
    child.once('close', (code, signal) => resolveExit({ code, signal }));
    timer = setTimeout(() => reject(new Error('Normal application close exceeded 30 seconds; no process was killed')), 30000);
  });
  try {
    const rememberObservation = (field: 'closeRequestObservation' | 'playwrightCloseObservation', observation: Awaited<ReturnType<typeof observeNormalCloseRequest>>) => {
      report.cleanup[field] = observation.state === 'rejected' ? { state: observation.state, message: errorText(observation.error) } : observation;
      if (observation.state === 'timed-out') throw new Error(`${field} exceeded ${observation.timeoutMs} milliseconds; acknowledgement is unconfirmed and no process was killed`);
    };
    const closeRequest = observeNormalCloseRequest(application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
      if (!window) throw new Error('No application window available for normal close');
      window.close();
    }), 5000).then(observation => {
      report.cleanup.closeRequestObservation = observation.state === 'rejected' ? { state: observation.state, message: errorText(observation.error) } : observation;
      return observation;
    });
    const result = await exited;
    report.cleanup = { ...report.cleanup, appStarted: true, normalClose: false, forcedKill: false, exitCodeScope: 'playwright-launcher', exitCode: result.code, signal: result.signal };
    rememberObservation('closeRequestObservation', await closeRequest);
    assert.equal(result.code, 0, 'Normal close must produce launcher exit zero'); assert.equal(result.signal, null, 'Normal close must not use a launcher termination signal');
    await assertSecondUserAppClosed(scope);
    report.cleanup.nativeInstalledProcessesAbsent = true;
    rememberObservation('playwrightCloseObservation', await observeNormalCloseRequest(application.close(), 5000));
    report.cleanup.normalClose = true; report.cleanup.needsHumanClose = false;
  } finally { if (timer) clearTimeout(timer); }
}

try {
  report.testScriptSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  report.normalCloseObservationSha256 = hash(await readFile(path.join(root, 'tests/helpers/normal-close-observation.ts')));
  const environment = missingToolsGateEnvironment(process.env, process.argv);
  report.phase = 'identity-gate';
  const identity = await readDesktopIdentity();
  report.observedSid = identity.sid;
  assertMissingToolsDesktop(identity);
  report.phase = 'installed-kit-gate';
  scope = await prepareSnapshotScope(root, environment, runId);
  assert.equal(scope.identity?.sid, identity.sid); assert.equal(scope.identity?.sessionId, identity.sessionId);
  report.installedKitGatePassed = true;
  const paths = missingToolsPaths(scope);
  for (const filename of [paths.runtime, paths.workspace, paths.emptyPath, paths.verifier, paths.output]) await assertMissingToolsPlainPath(root, filename);
  await mkdir(paths.runtime, { recursive: true }); await mkdir(paths.workspace); await mkdir(paths.emptyPath); await mkdir(paths.output, { recursive: true });
  output = paths.output;
  const source = 'export function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }\n';
  const verifier = 'throw new Error("This missing-tool fixture must never execute");\n';
  await writeFile(path.join(paths.workspace, 'numbers.mjs'), source, { flag: 'wx' });
  await writeFile(paths.verifier, verifier, { flag: 'wx' });
  assert.deepEqual(await readdir(paths.emptyPath), []);
  report.desktop = { sid: identity.sid, sessionId: identity.sessionId, standard: !identity.elevated, interactive: identity.interactive, explorerOwnerVerified: true };
  report.installedExecutable = scope.installed; report.dataDir = scope.dataDir; report.workspace = paths.workspace;
  report.dependenciesBeforeInjection = scope.dependencies;
  report.pathFault = { emptyDirectory: paths.emptyPath, inheritedByChildOnly: true, parentPathUnchanged: process.env.PATH === parentPath };
  report.phase = 'launch'; await evidence();
  await assertSecondUserAppClosed(scope);
  launchExitListeners = capturePlaywrightExitListeners();
  const { _electron: electron } = await import('playwright');
  report.cleanup.launchAttempted = true;
  app = await electron.launch({ executablePath: scope.installed!, args: [], cwd: paths.emptyPath,
    env: missingToolsAppEnvironment(process.env, paths.emptyPath, scope.dataDir), timeout: 60000 });
  launcherChild = app.process();
  report.cleanup.appStarted = true; report.launcherPid = launcherChild.pid;
  const electronMain = await app.evaluate(() => ({ pid: process.pid, execPath: process.execPath, type: (process as NodeJS.Process & { type?: string }).type }));
  assert.ok(Number.isInteger(electronMain.pid) && electronMain.pid > 0, 'Electron main must have a real process ID');
  assert.equal(electronMain.type, 'browser', 'The inspector identity must be the Electron main process');
  assert.equal(path.resolve(electronMain.execPath).toLowerCase(), path.resolve(scope.installed!).toLowerCase(), 'Electron main executable must match the verified installed product');
  report.electronMain = electronMain;
  page = await app.firstWindow();
  page.on('pageerror', error => report.pageErrors.push(errorText(error)));
  await page.waitForFunction(() => Boolean(window.forgeDesk), undefined, { timeout: 30000 });
  const initial = await snapshot(); assert.equal(initial.version, '0.2.1'); assert.equal(path.resolve(initial.dataDir).toLowerCase(), path.resolve(scope.dataDir).toLowerCase());
  assert.equal(initial.hardware.enabled, false, 'Hardware must remain disabled throughout this software-only smoke');
  report.initial = { version: initial.version, hardwareEnabled: initial.hardware.enabled };
  report.installedVersion = initial.version;
  const observedPath = await app.evaluate(() => process.env.PATH);
  assert.equal(observedPath, paths.emptyPath); report.pathFault.appObservedExact = true;
  await app.evaluate(({ dialog }, folder) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => { dialog.showOpenDialog = original; return { canceled: false, filePaths: [folder] }; };
  }, paths.workspace);
  const project = await page.evaluate(() => window.forgeDesk.importProject()); assert.ok(project);
  assert.equal(path.resolve(project.root).toLowerCase(), path.resolve(paths.workspace).toLowerCase());
  const session = await page.evaluate(id => window.forgeDesk.createSession(id, 'QA process-PATH missing tools'), project.id);
  taskId = session.taskId; report.taskId = taskId; report.projectId = project.id;
  assert.equal(session.threadId, undefined); assert.equal(session.turnId, undefined);
  report.phase = 'missing-git';
  const git = await page.evaluate(async id => {
    try { await window.forgeDesk.diff(id); return { rejected: false, error: '' }; }
    catch (error) { return { rejected: true, error: error instanceof Error ? error.message : String(error) }; }
  }, project.id);
  assertMissingGitResult(git); report.git = { ...git, error: redact(git.error), missingExecutable: 'git', observedCode: 'ENOENT' };
  await page.evaluate(id => window.forgeDesk.setAcceptance(id, [{ id: 'missing-tools-baseline', title: 'QA baseline retained', kind: 'manual' }]), taskId);
  const before = ownTask(await snapshot());
  report.phase = 'missing-node';
  const node = await page.evaluate(async ({ id, verifier }) => {
    try {
      await window.forgeDesk.setAcceptance(id, [{ id: 'missing-node', title: 'QA missing Node must reject', kind: 'automated',
        command: { executable: 'node', args: [verifier] }, verifierFiles: [verifier] }]);
      return { rejected: false, error: '' };
    } catch (error) { return { rejected: true, error: error instanceof Error ? error.message : String(error) }; }
  }, { id: taskId, verifier: paths.verifier });
  assertMissingNodeResult(node);
  const after = ownTask(await snapshot()); assertAcceptanceUnchanged(before, after);
  assert.equal((after.operations as unknown[]).length, 0); assert.equal((after.evidence as unknown[]).length, 0);
  assert.equal(await readFile(path.join(paths.workspace, 'numbers.mjs'), 'utf8'), source);
  assert.equal(await readFile(paths.verifier, 'utf8'), verifier);
  assert.deepEqual(await readdir(paths.workspace), ['numbers.mjs']); assert.deepEqual(await readdir(paths.emptyPath), []);
  const finalSession = (await snapshot()).sessions.find(item => item.id === session.id); assert.ok(finalSession);
  assert.equal(finalSession.threadId, undefined); assert.equal(finalSession.turnId, undefined); assert.equal(finalSession.messages.length, 0);
  report.node = { ...node, error: redact(node.error), failureStage: 'acceptance-command-resolution', verifierExecuted: false };
  report.noSideEffects = { acceptanceUnchanged: true, profileRevisionUnchanged: true, operationsUnchanged: true, evidenceUnchanged: true,
    sourceSha256: hash(source), verifierSha256: hash(verifier), workspaceUntouched: true, noModelThreadOrTurn: true };
  report.steps.push('Real installed public diff API rejected missing Git with ENOENT', 'Real installed public acceptance API rejected missing Node before persistence or execution');
  assert.deepEqual(report.pageErrors, []); report.result = 'passed';
} catch (error) {
  report.result = report.cleanup.launchAttempted ? 'failed' : 'blocked'; report.failures.push(errorText(error)); process.exitCode = 1;
  if (report.cleanup.launchAttempted && !app) {
    report.cleanup.libraryLaunchCleanup = 'not-observed'; report.cleanup.forcedKill = null;
  }
} finally {
  if (app) {
    try { await normallyClose(app); }
    catch (error) {
      report.result = 'failed'; report.cleanup.normalClose = false; report.cleanup.forcedKill = false; report.cleanup.needsHumanClose = true;
      report.failures.push(errorText(error)); process.exitCode = 1;
      const launcherExited = Boolean(launcherChild && (launcherChild.exitCode !== null || launcherChild.signalCode !== null));
      report.cleanup.launcherProcessAlreadyExited = launcherExited;
      let nativeAbsent = false;
      if (scope) try {
        await assertSecondUserAppClosed(scope); nativeAbsent = true;
        report.cleanup.nativeInstalledProcessesAbsent = true;
      } catch (nativeError) {
        report.cleanup.nativeAbsenceCheck = 'unconfirmed'; report.failures.push(errorText(nativeError));
      }
      if (nativeAbsent && launcherExited) {
        safeHarnessExit = true; report.cleanup.needsHumanClose = false;
      } else try {
        assert.ok(launchExitListeners);
        report.cleanup.playwrightExitHookDetachment = detachNewPlaywrightExitHandler(launchExitListeners);
        safeHarnessExit = true;
      } catch (detachError) {
        report.cleanup.exitHookDetachmentConfirmed = false; report.failures.push(errorText(detachError));
      }
    }
  }
  report.pathFault ??= { injectionStarted: false };
  report.pathFault.parentPathUnchanged = process.env.PATH === parentPath;
  report.finishedAt = new Date().toISOString();
  if (!output) {
    output = path.join(root, 'output', 'second-user-selftest', `${runId}-missing-tools-gate`);
    await assertMissingToolsPlainPath(root, output); await mkdir(output, { recursive: true });
  }
  await evidence();
  console.log(JSON.stringify({ result: report.result, scenario: report.scenario, phase: report.phase, observedSid: report.observedSid,
    normalClose: report.cleanup.normalClose, forcedKill: report.cleanup.forcedKill, needsHumanClose: report.cleanup.needsHumanClose ?? false,
    evidence: path.join(output, 'evidence.json'), failures: report.failures }, null, 2));
  if (safeHarnessExit) process.exit(1);
  if (report.cleanup.needsHumanClose && launcherChild && launcherChild.exitCode === null && launcherChild.signalCode === null) {
    launcherChild.once('close', () => {
      if (scope) void assertSecondUserAppClosed(scope).then(() => process.exit(1)).catch(() => {});
    });
  }
}
