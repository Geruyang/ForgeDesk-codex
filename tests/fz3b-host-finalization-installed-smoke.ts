import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { Fz3bRunView } from '../packages/engineering-runner/fz3b/types';
import { inside, samePath } from './helpers/embedded-installed';
import { primarySid, readDesktopIdentity } from './helpers/snapshot-smoke-scope';
import { prepareSnapshotInstalledLifecycle } from './helpers/snapshot-installed-lifecycle';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from '../packages/engineering-runner/fz3b/preflight-recovery';
import { redact } from '../packages/engineering-runner/redaction';
import { assertFz3bOriginalUnknownPreserved, assertFz3bPreflightFinished, assertFz3bPreflightRestartHeld,
  fz3bPreflightRecoverySettled, fz3bPreflightTarget, installFz3bFinishUiObserver,
  readFz3bFinishUiObserver, restoreFz3bFinishUiObserver, assertFz3bPreflightUnknownSummaryMatches,
  fz3bPreflightUnknownSummary, protectBeforeFailurePersistence } from './helpers/fz3b-preflight-observation';
import { assertFz3bHostFinalizationIpcReceipt, installFz3bHostFinalizationIpcObserver,
  readFz3bHostFinalizationIpcObserver, restoreFz3bHostFinalizationIpcObserver,
  type Fz3bHostIpcPurpose } from './helpers/fz3b-host-finalization-ipc-observer';
import { observeFz3bHostMaintenanceExit } from './helpers/fz3b-host-native-exit';
import { nativeMainProcessQuery } from './helpers/second-user-controls';
import { FZ3B_HOST_FINAL_COMPLETION_SHA256, FZ3B_HOST_FINAL_FAILURE_EVIDENCE, FZ3B_HOST_FINAL_FAILURE_SHA256,
  FZ3B_HOST_FINAL_OUTPUT, FZ3B_HOST_FINAL_SUCCESS_EVIDENCE, FZ3B_HOST_FINAL_SUCCESS_SHA256,
  fz3bHostFinalFirstLaunchQuietExceptHeldOwner,
  observeFz3bHostFinalOriginalCall,
  assertFz3bHostFinalRequest, createFz3bHostFinalRunOutput, fz3bHostFinalLaunchEnvironment,
  fz3bHostFinalPlanScope, prepareFz3bHostFinalPlan, readFz3bHostFinalEvidence, readFz3bHostFinalInput,
  serializeFz3bHostFinalPlan, verifyFz3bHostFinalPlanBytes, type Fz3bHostFinalPlan } from './helpers/fz3b-host-finalization-installed';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, filename, ...extra] = process.argv.slice(2);
assert.ok(['--prepare-only', '--observe-three-launches'].includes(mode) && filename && extra.length === 0,
  'Use --prepare-only <absolute-request.json> or --observe-three-launches <absolute-plan.json>');
const planDirectory = path.join(root, FZ3B_HOST_FINAL_OUTPUT, 'plans');
assert.ok(path.isAbsolute(filename) && inside(planDirectory, filename));

if (mode === '--prepare-only') {
  assert.ok(filename.endsWith('.request.json'));
  const input = await readFz3bHostFinalInput(filename, 'request'); assertFz3bHostFinalRequest(root, input);
  const plan = await prepareFz3bHostFinalPlan(root, input, process.env);
  const output = filename.slice(0, -'.request.json'.length) + '.plan.json';
  await writeFile(output, serializeFz3bHostFinalPlan(plan), { flag: 'wx' });
  console.log(JSON.stringify({ result: 'prepared-only-not-accepted', plan: output, candidateSha256: plan.candidateSha256,
    runId: plan.runId, next: `node --import tsx tests/fz3b-host-finalization-installed-smoke.ts --observe-three-launches "${output}"`,
    prerequisites: ['Root-reviewed candidate and both fixed 0.5.3 evidence hashes are checked',
      'Root operates fresh native local maintenance exit on launch 1; fresh native empty-home isolation and independent visible finish on launch 2; launch 3 is read-only',
      'No native action, model, remote command, device command, or synthesized IPC is issued by this harness'] }, null, 2));
} else {
  assert.equal(process.platform, 'win32');
  const { plan, output } = fz3bHostFinalPlanScope(root, await readFz3bHostFinalInput(filename, 'plan'), process.env);
  const verified = await verifyFz3bHostFinalPlanBytes(root, plan); assert.equal(verified.candidateSha256, plan.candidateSha256);
  assert.equal(await createFz3bHostFinalRunOutput(root, plan.runId), output);
  const priorSuccess = await readFz3bHostFinalEvidence(root, plan.priorSuccessEvidencePath, plan.priorSuccessEvidenceSha256, 'success');
  const priorFailure = await readFz3bHostFinalEvidence(root, plan.priorFailureEvidencePath, plan.priorFailureEvidenceSha256, 'failure');
  const report: Record<string, any> = { schemaVersion: 1, scope: plan.scope, flow: plan.flow, runId: plan.runId,
    candidateSha256: plan.candidateSha256,
    priorEvidence: { success: { path: plan.priorSuccessEvidencePath, sha256: priorSuccess.sha256 },
      failure: { path: plan.priorFailureEvidencePath, sha256: priorFailure.sha256 },
      priorCompletionEvidenceSha256: FZ3B_HOST_FINAL_COMPLETION_SHA256 },
    startedAt: new Date().toISOString(), nativeOperator: plan.nativeOperator,
    harnessActions: { synthesizedNativeAnswer: false, directRecoveryIpcOrUiAction: false, remoteOrDeviceCommandIssuedByHarness: false },
    certificateMetadata: 'not-observed-no-public-certificate-projection-and-no-private-file-read', launches: [], closes: [], observations: [],
    limitations: ['Installed three-launch local behavior acceptance only; this harness does not inspect or verify a private certificate or MAC.',
      'Root alone clicks the reviewed local controls and answers fresh native dialogs; the harness only observes each original IPC Promise.',
      'Empty-home receipt is post-transaction factual metadata, not an independent filesystem proof, certificate or remote authorization.',
      'Installed lifecycle verifies ForgeDesk.exe absence only; root must separately perform the no-old-worker/SSH process preflight. This report makes no independent worker/SSH absence claim.',
      'Third launch must remain unheld without action; maintenance exit and isolation are not remote recovery, new Boot admission or semantic acceptance.'] };
  const persist = async () => {
    const destination = path.join(output, 'evidence.json'), temporary = path.join(output, `.evidence-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, destination);
  };
  let app: ElectronApplication | undefined, page: Page | undefined;
  let uiObserverInstalled = false, ipcObserverInstalled = false, uiTaskId: string | undefined;
  let ipcPurpose: Fz3bHostIpcPurpose = 'finish';
  let lifecycle = await prepareSnapshotInstalledLifecycle(root, plan.installedExe);
  const execute = promisify(execFile);
  const readNative = async (pid: number) => {
    const result = await execute('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', nativeMainProcessQuery(pid)], { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  };
  const snapshot = () => page!.evaluate(() => window.forgeDesk.snapshot());
  const target = (state: AppSnapshot): Fz3bRunView => fz3bPreflightTarget(state, plan.targetRunId);
  const launch = async (index: number, purpose: Fz3bHostIpcPurpose = 'finish') => {
    assert.equal(app, undefined, 'The previous installed process must have an independently verified exit');
    if (index > 1) lifecycle = await prepareSnapshotInstalledLifecycle(root, plan.installedExe);
    assert.equal((await readDesktopIdentity()).sid, primarySid);
    const { _electron } = await import('playwright'); await lifecycle.beforeLaunch();
    app = await _electron.launch({ executablePath: plan.installedExe, args: [], env: fz3bHostFinalLaunchEnvironment(process.env, plan.dataDir), timeout: 60000 });
    const identity = await lifecycle.attach(app);
    for (const previous of report.launches) assert.notEqual(identity.nativeMain?.created, previous.lifecycle.nativeMain?.created,
      'Every launch must have a freshly observed native process creation identity');
    report.launches.push({ index, lifecycle: identity });
    page = await app.firstWindow();
    await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 30000 });
    ipcPurpose = purpose;
    await app.evaluate(installFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId, purpose }); ipcObserverInstalled = true;
    const state = await snapshot(); assert.equal(state.version, plan.version); assert.ok(samePath(state.dataDir, plan.dataDir));
    assert.equal(state.fz3bAgent?.available, true, state.fz3bAgent?.reason); return state;
  };
  const closeNormally = async (index: number) => {
    assert.ok(app); const close = await lifecycle.closeNormally(); report.closes.push({ index, ...close });
    app = undefined; page = undefined; await persist();
  };
  try {
    const first = await launch(1, 'maintenance-exit'), initial = target(first);
    assert.equal(initial.runId, plan.targetRunId); assert.equal(initial.taskId, '9309dc73-fb48-4d29-9226-c5496ca2640d');
    assert.equal(initial.sessionId, '9309dc73-fb48-4d29-9226-c5496ca2640d');
    assert.ok(initial.operations.some(operation => operation.id === plan.targetOperationId && operation.status === 'unknown'));
    assert.equal(initial.grant, undefined); assert.equal(initial.semantic, undefined);
    assertFz3bPreflightRestartHeld(first, plan.targetRunId, initial);
    assert.equal(first.fz3bAgent?.activeRunId, plan.targetRunId, 'First launch must begin held by the exact historical owner');
    assert.deepEqual(first.fz3bAgent?.recoveryActions, { runId: plan.targetRunId, taskId: initial.taskId, sessionId: initial.sessionId,
      reconcileInspect: false, reconcilePreflightRefusedInspect: true, finishPreflightRefusal: true, quarantineEmptyHome: true, maintenanceExit: true, exportEvidence: false });
    assert.equal(fz3bHostFinalFirstLaunchQuietExceptHeldOwner(first, plan.targetRunId), true,
      'Before visible finish, the exact held owner must be the only FZ3B owner and all engines/tasks/approvals/sessions must be quiet');
    const priorUnknown = priorSuccess.evidence.originalUnknown;
    assertFz3bPreflightUnknownSummaryMatches(initial, priorUnknown);
    const priorAttempt = initial.preflightRefusalRecoveries?.filter(item => item.status === 'released');
    assert.equal(priorAttempt?.length, 1, 'The original released history must be retained exactly once');
    assert.equal(createHash('sha256').update(JSON.stringify(priorAttempt![0])).digest('hex'), FZ3B_HOST_FINAL_COMPLETION_SHA256);
    const beforeUnknown = fz3bPreflightUnknownSummary(initial);
    report.observations.push({ stage: 'first-launch-held', activeRunId: first.fz3bAgent?.activeRunId,
      recoveryActions: first.fz3bAgent?.recoveryActions, originalUnknown: beforeUnknown,
      recoveryHistorySha256: createHash('sha256').update(JSON.stringify(initial.preflightRefusalRecoveries)).digest('hex') }); await persist();
    const maintenanceButton = page!.getByRole('button', { name: 'FZ3B 维护退出应用', exact: true });
    assert.equal(await maintenanceButton.count(), 1); assert.equal(await maintenanceButton.isVisible(), true); assert.equal(await maintenanceButton.isEnabled(), true);
    const maintenance = observeFz3bHostMaintenanceExit(app!, report.launches.at(-1).lifecycle, plan.targetRunId,
      { identity: readDesktopIdentity, nativeMain: readNative });
    console.log(`ROOT_MAINTENANCE_READY: 请点击“FZ3B 维护退出应用”并在新鲜原生框确认仅本地退出；不清 unknown/锁，不重放。run=${plan.targetRunId}`);
    const maintenanceClose = await maintenance.result;
    report.closes.push({ index: 1, ...maintenanceClose });
    report.observations.push({ stage: 'maintenance-local-exit', originalIpc: maintenanceClose.originalIpc,
      localOnly: true, oldUnknownAndLocksNotClearedByExit: 'must-be-rechecked-on-next-launch', noRemoteRecoveryAuthorization: true });
    app = undefined; page = undefined; ipcObserverInstalled = false; await persist();

    const afterMaintenance = await launch(2, 'quarantine');
    assertFz3bPreflightRestartHeld(afterMaintenance, plan.targetRunId, initial);
    assertFz3bPreflightUnknownSummaryMatches(target(afterMaintenance), beforeUnknown);
    assert.equal(fz3bHostFinalFirstLaunchQuietExceptHeldOwner(afterMaintenance, plan.targetRunId), true);
    assert.equal(afterMaintenance.fz3bAgent?.recoveryActions?.quarantineEmptyHome, true);
    report.observations.push({ stage: 'after-maintenance-still-held', originalUnknownPreserved: true,
      originalHistoryUnchanged: true, finishRequired: true, emptyHomeIsolationRequired: true }); await persist();
    uiTaskId = initial.taskId;
    await page!.evaluate(installFz3bFinishUiObserver, uiTaskId!); uiObserverInstalled = true;
    const isolateButton = page!.getByRole('button', { name: '隔离 FZ3B 主机旧空目录', exact: true });
    assert.equal(await isolateButton.count(), 1); assert.equal(await isolateButton.isVisible(), true); assert.equal(await isolateButton.isEnabled(), true);
    const sampleIsolation = () => observeFz3bHostFinalOriginalCall(initial, {
      ipc: () => app!.evaluate(readFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId, purpose: 'quarantine' as const }),
      snapshot, dom: () => page!.evaluate(readFz3bFinishUiObserver, uiTaskId!),
    }, 'quarantine');
    console.log(`ROOT_QUARANTINE_READY: 请点击“隔离 FZ3B 主机旧空目录”并在新鲜原生框确认仅隔离；之后必须另行显式finish。run=${plan.targetRunId}`);
    const isolationDeadline = Date.now() + 10 * 60_000;
    let isolation: Awaited<ReturnType<typeof sampleIsolation>> | undefined;
    while (Date.now() < isolationDeadline) {
      const sample = await sampleIsolation(); if (sample.settled) { isolation = sample; break; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(isolation, 'Fresh native isolation and original IPC/DOM settlement timed out; no retry');
    for (let index = 0; index < 2; index++) { assert.equal((await sampleIsolation()).settled, true); if (!index) await new Promise(resolve => setTimeout(resolve, 250)); }
    report.observations.push({ stage: 'empty-home-isolated-still-held', originalIpc: isolation.ipc, dom: isolation.dom,
      receipt: isolation.ipc.calls[0].quarantineReceipt, receiptScope: 'Actual transaction post-rename verification; not independent filesystem proof or certificate',
      originalUnknownPreserved: true, originalHistoryUnchanged: true, finishRequired: true }); await persist();
    await page!.evaluate(restoreFz3bFinishUiObserver, uiTaskId!); uiObserverInstalled = false;
    await app!.evaluate(restoreFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId, purpose: 'quarantine' as const }); ipcObserverInstalled = false;
    ipcPurpose = 'finish';
    await app!.evaluate(installFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId }); ipcObserverInstalled = true;
    await page!.evaluate(installFz3bFinishUiObserver, uiTaskId!); uiObserverInstalled = true;
    report.finishObservers = { dom: 'read-only exact-task MutationObserver', ipc: 'read-only original IPC Promise pass-through observer',
      electronVersion: '44.7.2', channel: 'forgedesk:invoke', method: 'fz3bReconcilePreflightRefusedInspect', targetRunId: plan.targetRunId };
    const finishButton = page!.getByRole('button', { name: '完成 FZ3B 本地恢复收尾', exact: true });
    assert.equal(await finishButton.count(), 1, 'The exact reviewed visible finish control must exist once');
    assert.equal(await finishButton.isVisible(), true); assert.equal(await finishButton.isEnabled(), true);
    await persist();
    console.log(`请 root 在 UI 中手动点击“完成 FZ3B 本地恢复收尾”；harness 只观察真实 DOM、IPC Promise 与快照。run=${plan.targetRunId}`);
    const sampleOriginal = () => observeFz3bHostFinalOriginalCall(initial, {
      ipc: () => app!.evaluate(readFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId }),
      snapshot, dom: () => page!.evaluate(readFz3bFinishUiObserver, uiTaskId!),
    });
    const deadline = Date.now() + 10 * 60_000;
    let firstFinished: AppSnapshot | undefined;
    while (Date.now() < deadline) {
      const sample = await sampleOriginal();
      if (sample.settled) { firstFinished = sample.state; break; }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(firstFinished, 'First-launch original IPC/DOM/full-history settlement timed out; no action was retried');
    for (let sample = 0; sample < 2; sample++) {
      const fresh = await sampleOriginal();
      assert.equal(fresh.settled, true, 'Fresh post-terminal original IPC/DOM/full-history checks must remain settled');
      if (sample === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const finishedRun = assertFz3bPreflightFinished(firstFinished, plan.targetRunId, initial);
    assertFz3bOriginalUnknownPreserved(initial, finishedRun); assert.deepEqual(fz3bPreflightUnknownSummary(finishedRun), beforeUnknown);
    const firstHistorySha = createHash('sha256').update(JSON.stringify(finishedRun.preflightRefusalRecoveries)).digest('hex');
    report.observations.push({ stage: 'second-launch-independent-finish-settled', originalPromiseFulfilled: true, originalUnknownPreserved: true,
      recoveryHistorySha256: firstHistorySha, ipc: await app!.evaluate(readFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId }),
      dom: await page!.evaluate(readFz3bFinishUiObserver, uiTaskId) }); await persist();
    await page!.evaluate(restoreFz3bFinishUiObserver, uiTaskId); uiObserverInstalled = false;
    await app!.evaluate(restoreFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId }); ipcObserverInstalled = false;
    await closeNormally(2);

    const second = await launch(3), secondRun = target(second);
    assert.equal(second.fz3bAgent?.activeRunId, undefined, 'Third launch must not re-hold after persisted host finalization');
    assert.equal(second.fz3bAgent?.recoveryActions, undefined, 'Third launch must expose no recovery action capability');
    assert.equal(secondRun.active, false); assert.equal(secondRun.hardwareBusy, false); assert.equal(secondRun.nativeApproval, 'not_requested');
    assertFz3bOriginalUnknownPreserved(initial, secondRun); assert.deepEqual(fz3bPreflightUnknownSummary(secondRun), beforeUnknown);
    assert.equal(createHash('sha256').update(JSON.stringify(secondRun.preflightRefusalRecoveries)).digest('hex'), firstHistorySha,
      'Third launch must retain the exact prior public recovery history');
    assert.equal(fz3bPreflightRecoverySettled(second, plan.targetRunId), true, 'Third launch must be globally quiet with complete retained history');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const noAction = await snapshot(); assert.equal(noAction.fz3bAgent?.activeRunId, undefined); assert.equal(noAction.fz3bAgent?.recoveryActions, undefined);
    assertFz3bPreflightFinished(noAction, plan.targetRunId, initial);
    const noActionIpc = await app!.evaluate(readFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId });
    assertFz3bHostFinalizationIpcReceipt(noActionIpc, 0);
    report.observations.push({ stage: 'third-launch-no-rehold', activeRunIdAbsent: true, recoveryActionsAbsent: true,
      originalUnknownPreserved: true, recoveryHistorySha256: firstHistorySha, observedFinishIpcCalls: noActionIpc.calls.length,
      ipcObservationScope: 'Exact public finish method only; harness sends no mutating IPC or UI action',
      completeQuietObserved: true, publicCertificateProjectionAvailable: false }); await persist();
    await app!.evaluate(restoreFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId }); ipcObserverInstalled = false;
    await closeNormally(3);
    report.result = 'observed-three-launch-local-maintenance-quarantine-host-finalization-behavior'; report.finishedAt = new Date().toISOString(); await persist();
  } catch (error) {
    report.failure = redact(error instanceof Error ? error.stack || error.message : String(error)); report.failedAt = new Date().toISOString();
    const protectedState = await protectBeforeFailurePersistence(() => lifecycle.protectOnFailure(), async protection => {
      report.lifecycleProtection = protection; await persist();
    });
    report.lifecycleProtection = protectedState.protection;
    if (!protectedState.evidencePersisted) report.evidencePersistenceFailure = redact(protectedState.persistenceError || 'unknown evidence write failure');
    let observerCleanupSafe = !ipcObserverInstalled;
    if (ipcObserverInstalled && app) {
      try {
        report.ipcObserver = await app.evaluate(readFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId, purpose: ipcPurpose });
        observerCleanupSafe = report.ipcObserver.calls.every((call: { phase: string }) => ['fulfilled', 'rejected'].includes(call.phase));
      }
      catch (observationError) { report.ipcObservationFailure = redact(observationError instanceof Error ? observationError.message : String(observationError)); }
      if (observerCleanupSafe) {
        try { await app.evaluate(restoreFz3bHostFinalizationIpcObserver, { runId: plan.targetRunId, purpose: ipcPurpose }); } catch { /* Never close the protected product on observer cleanup failure. */ }
      } else report.observersRetained = 'Original IPC is pending or unreadable; preserve both original observers without retry';
    }
    if (uiObserverInstalled && page && uiTaskId) {
      try { report.domObserver = await page.evaluate(readFz3bFinishUiObserver, uiTaskId); }
      catch (observationError) { report.domObservationFailure = redact(observationError instanceof Error ? observationError.message : String(observationError)); }
      if (observerCleanupSafe) {
        try { await page.evaluate(restoreFz3bFinishUiObserver, uiTaskId); } catch { /* Observer cleanup does not authorize closing. */ }
      }
    }
    try { await persist(); } catch (persistError) { report.evidencePersistenceFailure = redact(persistError instanceof Error ? persistError.message : String(persistError)); }
    throw error;
  }
}
