import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type { ElectronApplication, Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { Fz3bRunView } from '../packages/engineering-runner/fz3b/types';
import { inside, samePath } from './helpers/embedded-installed';
import { primarySid, readDesktopIdentity } from './helpers/snapshot-smoke-scope';
import { prepareSnapshotInstalledLifecycle } from './helpers/snapshot-installed-lifecycle';
import { fz3bPreflightLaunchEnvironment, fz3bPreflightPlanScope, prepareFz3bPreflightPlan,
  createFz3bPreflightRunOutput, readFz3bPreflightInput, serializeFz3bPreflightPlan, verifyFz3bPreflightPlanBytes,
  verifyFz3bPreviousEvidence, type Fz3bPreflightPlan } from './helpers/fz3b-preflight-installed';
import { FZ3B_PREFLIGHT_RECOVERY_CASE, fz3bPreflightDigest } from '../packages/engineering-runner/fz3b/preflight-recovery';
import { redact } from '../packages/engineering-runner/redaction';
import { assertFz3bPreflightFinished, assertFz3bPreflightRestartHeld,
  fz3bPreflightRecoverySettled, fz3bPreflightTarget,
  fz3bFinishUiSettled, installFz3bFinishUiObserver, readFz3bFinishUiObserver, restoreFz3bFinishUiObserver,
  assertFz3bPreflightUnknownSummaryMatches, fz3bPreflightUnknownSummary,
  protectBeforeFailurePersistence } from './helpers/fz3b-preflight-observation';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [mode, filename, ...extra] = process.argv.slice(2);
assert.ok(['--prepare-only', '--observe-resume-finish-only'].includes(mode) && filename && extra.length === 0,
  'Use --prepare-only <absolute-request.json> or --observe-resume-finish-only <absolute-plan.json>');
assert.ok(path.isAbsolute(filename) && inside(path.join(root, 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/revision-0.5.3/plans'), filename));
const input = await readFz3bPreflightInput(filename, mode === '--prepare-only' ? 'request' : 'plan');
if (mode === '--prepare-only') {
  assert.ok(filename.endsWith('.request.json'));
  const plan = await prepareFz3bPreflightPlan(root, input, process.env);
  const output = filename.slice(0, -'.request.json'.length) + '.plan.json';
  await writeFile(output, serializeFz3bPreflightPlan(plan), { flag: 'wx' });
  console.log(JSON.stringify({ result: 'prepared-only-not-accepted', plan: output, candidateSha256: plan.candidateSha256,
    runId: plan.runId, next: `node --import tsx tests/fz3b-preflight-installed-smoke.ts --observe-resume-finish-only "${output}"`,
    prerequisites: ['Root-reviewed candidate SHA and prior evidence SHA are externally pinned', 'Root operates the visible local finish action',
      'This mode performs no native dialog, new Boot, SSH, model, device, or automatic UI/API action'] }, null, 2));
} else {
  assert.equal(process.platform, 'win32');
  const { plan, output } = fz3bPreflightPlanScope(root, input, process.env);
  const verified = await verifyFz3bPreflightPlanBytes(root, plan);
  assert.equal(verified.candidateSha256, plan.candidateSha256);
  assert.equal(await createFz3bPreflightRunOutput(root, plan.runId), output, 'Run output path must match the reviewed plan');
  const previous = await verifyFz3bPreviousEvidence(root, plan.previousEvidencePath, plan.previousEvidenceSha256);
  const report: Record<string, any> = { schemaVersion: 2, scope: plan.scope, flow: plan.flow, runId: plan.runId,
    candidateSha256: plan.candidateSha256, previousEvidence: { path: plan.previousEvidencePath, sha256: previous.sha256 },
    startedAt: new Date().toISOString(), nativeOperator: plan.nativeOperator, harnessActions: { synthesizedNativeAnswer: false,
      directRecoveryIpcOrUiAction: false, remoteOrDeviceCommandIssuedByHarness: false }, runtimeActivityObservation: 'not-yet-performed',
    observations: [], launches: [], closes: [], limitations: [
      'This resume-finish-only smoke observes the fixed prior local preflight-refusal recovery; it does not repeat initial recovery or native confirmation.',
      'The original unknown operation remains unknown and is never replayed or converted to success.',
      'The coordinator performs the visible local finish action; this harness only observes DOM and snapshots.' ] };
  const persist = async () => {
    const destination = path.join(output, 'evidence.json'), temporary = path.join(output, `.evidence-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); await rename(temporary, destination);
  };
  let app: ElectronApplication | undefined, page: Page | undefined, uiObserverInstalled = false, uiObserverTaskId: string | undefined;
  const lifecycle = await prepareSnapshotInstalledLifecycle(root, plan.installedExe);
  const target = (state: AppSnapshot) => fz3bPreflightTarget(state, plan.targetRunId);
  const snapshot = () => page!.evaluate(() => window.forgeDesk.snapshot());
  const launch = async (index: number) => {
    assert.equal((await readDesktopIdentity()).sid, primarySid);
    const { _electron } = await import('playwright');
    await lifecycle.beforeLaunch();
    app = await _electron.launch({ executablePath: plan.installedExe, args: [], env: fz3bPreflightLaunchEnvironment(process.env, plan.dataDir), timeout: 60000 });
    const lifecycleLaunch = await lifecycle.attach(app); report.launches.push({ index, lifecycle: lifecycleLaunch });
    page = await app.firstWindow();
    await page.locator('.sidebar').waitFor({ state: 'visible', timeout: 30000 });
    const state = await snapshot(); assert.equal(state.version, plan.version); assert.ok(samePath(state.dataDir, plan.dataDir));
    assert.equal(state.fz3bAgent?.available, true, state.fz3bAgent?.reason);
    const run = target(state);
    report.launches.at(-1)!.maintenanceExitSha256 = run.maintenanceExit ? fz3bPreflightDigest(run.maintenanceExit) : null;
    await persist();
    return state;
  };
  const waitFor = async (predicate: (state: AppSnapshot) => boolean | Promise<boolean>, label: string, timeoutMs = 10 * 60_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { const state = await snapshot(); if (await predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 250)); }
    throw new Error(`${label} timed out; no action was retried and no state was inferred from process exit`);
  };
  const closeNormally = async (index: number) => {
    assert.ok(app); const record = await lifecycle.closeNormally(); report.closes.push({ index, ...record });
    app = undefined; page = undefined; await persist();
  };
  try {
    const first = await launch(1), original = target(first);
    assert.equal(original.runId, FZ3B_PREFLIGHT_RECOVERY_CASE.runId);
    assert.ok(original.operations.some(operation => operation.id === plan.targetOperationId && operation.status === 'unknown'));
    assert.equal(original.grant, undefined); assert.equal(original.semantic, undefined);
    assertFz3bPreflightRestartHeld(first, plan.targetRunId, original);
    const priorInitial = previous.evidence.initialRecovery;
    assert.equal(original.preflightRefusalRecoveries?.length, 1, 'No extra or replacement recovery history may be introduced');
    const priorAttempt = original.preflightRefusalRecoveries?.find(item => item.status === 'released');
    assert.ok(priorAttempt, 'The exact previous released attempt must still exist on restart');
    assert.equal(createHash('sha256').update(JSON.stringify(priorAttempt)).digest('hex'), priorInitial.completionEvidenceSha256,
      'Current ledger must retain the exact completion checkpoint from the approved prior evidence');
    assert.equal(priorAttempt.context.sourceRun.runId, original.runId);
    assert.equal(priorAttempt.context.sourceRun.taskId, original.taskId);
    assert.equal(priorAttempt.context.sourceRun.sessionId, original.sessionId);
    for (const key of ['model', 'generation', 'threadId', 'turnId', 'profileId', 'profileSha256'] as const) {
      assert.equal(original[key], priorAttempt.context.sourceRun[key], `Current FZ3B owner differs from pinned prior evidence: ${key}`);
    }
    assert.deepEqual(original.calls, priorAttempt.context.sourceRun.calls, 'Current calls differ from the exact source bound by the prior completion digest');
    assert.deepEqual(original.operations, priorAttempt.context.sourceRun.operations, 'Current operations differ from the exact source bound by the prior completion digest');
    assert.deepEqual(original.artifact, priorAttempt.context.sourceRun.artifact);
    assert.deepEqual(original.identity, priorAttempt.context.sourceRun.identity);
    assert.deepEqual(original.grant, priorAttempt.context.sourceRun.grant);
    assert.deepEqual(original.semantic, priorAttempt.context.sourceRun.semantic);
    assert.deepEqual(original.maintenanceExit, priorAttempt.context.sourceRun.maintenanceExit);
    assert.ok(priorAttempt.context.sourceRun.operations.some(operation => operation.id === plan.targetOperationId && operation.status === 'unknown'));
    const beforeUnknown = previous.evidence.originalUnknown;
    assertFz3bPreflightUnknownSummaryMatches(original, beforeUnknown);
    report.originalUnknown = { ...fz3bPreflightUnknownSummary(original), fullViewSha256: createHash('sha256').update(JSON.stringify(original)).digest('hex') };
    report.observations.push({ stage: 'restart-held-ready', recoveryActions: first.fz3bAgent?.recoveryActions,
      previousCompletionEvidenceSha256: priorInitial.completionEvidenceSha256, originalUnknownPreserved: true }); await persist();
    const taskId = original.taskId;
    uiObserverTaskId = taskId;
    await page!.evaluate(installFz3bFinishUiObserver, taskId); uiObserverInstalled = true;
    report.uiSettlementObserver = { installed: true, exactTaskId: taskId, expectedIntent: 'reconcile-preflight-inspect', method: 'read-only-MutationObserver' };
    await persist();
    console.log(`请 root 在 UI 中手动点击“完成本地恢复收尾”；harness 仅观察本次真实 UI pending→settled 序列和快照。run=${plan.targetRunId}`);
    const finishSettled = async (state: AppSnapshot) => {
      if (!fz3bPreflightRecoverySettled(state, plan.targetRunId)) return false;
      const dom = await page!.evaluate(readFz3bFinishUiObserver, taskId);
      return fz3bFinishUiSettled(dom, taskId);
    };
    const finished = await waitFor(finishSettled, 'Visible local finish promise settlement and complete quiet closure');
    for (let sample = 0; sample < 2; sample++) {
      const fresh = await snapshot();
      assertFz3bPreflightFinished(fresh, plan.targetRunId, original);
      const dom = await page!.evaluate(readFz3bFinishUiObserver, taskId);
      assert.ok(fz3bFinishUiSettled(dom, taskId), 'Exact task UI must show the observed finish intent settled with no alert');
      if (sample === 0) await new Promise(resolve => setTimeout(resolve, 250));
    }
    const settledDom = await page!.evaluate(readFz3bFinishUiObserver, taskId);
    report.uiSettlementObserver = { ...settledDom, settled: true };
    const finishedRun = assertFz3bPreflightFinished(finished, plan.targetRunId, original);
    assert.equal(finishedRun.grant, undefined); assert.equal(finishedRun.semantic, undefined);
    const finalRecovery = finishedRun.preflightRefusalRecoveries?.at(-1);
    report.observations.push({ stage: 'human-finish-observed', recoveryStatus: finalRecovery?.status,
      completionEvidenceSha256: finalRecovery ? createHash('sha256').update(JSON.stringify(finalRecovery)).digest('hex') : undefined,
      originalUnknownPreserved: true }); await persist();
    report.runtimeActivityObservation = 'The exact target has complete release proof and worker closure; FZ3B and hardware-agent have no active owner and their engines are stopped, the desktop engine is stopped, no approvals or pending task operations are visible, and no foreign session is running, stopping, or engine-uncertain. Controlled mode may remain active. This does not attest absence of unrelated system activity.';
    await page!.evaluate(restoreFz3bFinishUiObserver, taskId); uiObserverInstalled = false;
    await closeNormally(1);
    report.result = 'observed-only-resume-finish'; report.finishedAt = new Date().toISOString(); await persist();
  } catch (error) {
    report.failure = redact(error instanceof Error ? error.stack || error.message : String(error)); report.failedAt = new Date().toISOString();
    const protectedState = await protectBeforeFailurePersistence(() => lifecycle.protectOnFailure(), async protection => {
      report.lifecycleProtection = protection; await persist();
    });
    report.lifecycleProtection = protectedState.protection;
    if (!protectedState.evidencePersisted) report.evidencePersistenceFailure = redact(protectedState.persistenceError || 'unknown evidence write failure');
    if (uiObserverInstalled && app && page && uiObserverTaskId) {
      try { report.uiSettlementObserver = await page.evaluate(readFz3bFinishUiObserver, uiObserverTaskId); } catch (observerError) {
        report.uiObservationFailure = redact(observerError instanceof Error ? observerError.message : String(observerError)); }
      try { if (uiObserverTaskId) await page.evaluate(restoreFz3bFinishUiObserver, uiObserverTaskId); } catch { /* Observer cleanup cannot authorize closing the app. */ }
    }
    try { await persist(); } catch (persistError) { report.evidencePersistenceFailure = redact(persistError instanceof Error ? persistError.message : String(persistError)); }
    throw error;
  }
}
