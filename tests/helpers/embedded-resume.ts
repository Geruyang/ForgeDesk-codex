import assert from 'node:assert/strict';
import path from 'node:path';
import type { EmbeddedStatus } from '../../packages/engineering-runner/embedded/types';
import { parseFixedWorkerReceipt } from '../../packages/engineering-runner/device/real-stm32';
import { assertEmbeddedBuild, assertFlashGrant, samePath, successfulOperation, type EmbeddedInstalledScope } from './embedded-installed';

// This admits one diagnosed harness-export assertion, not a general failed-run retry.
export function assertEmbeddedExportResume(report: Record<string, any>, scope: EmbeddedInstalledScope, planSha256: string) {
  assert.equal(report.schemaVersion, 1); assert.equal(report.scope, scope.plan.scope); assert.equal(report.runId, scope.plan.runId);
  assert.equal(report.result, 'failed'); assert.equal(report.realModel, false); assert.equal(report.secondUser, false);
  assert.equal(report.planSha256, planSha256); assert.equal(report.runtimeCommit, scope.plan.runtimeCommit);
  assert.equal(samePath(report.dataDir, scope.dataDir), true); assert.equal(samePath(report.projectRoot, scope.plan.projectRoot), true);
  assert.deepEqual(report.release, { version: scope.plan.version, executableSha256: scope.plan.executableSha256, installerSha256: scope.plan.installerSha256,
    resourceHashes: scope.plan.resourceHashes, suppliedRuntimeCommit: scope.plan.runtimeCommit });
  assert.equal(report.desktop?.sid, 'S-1-5-21-1196670755-766692816-2897134863-1002'); assert.equal(report.desktop.elevated, false); assert.equal(report.desktop.explorerMatched, true);
  assert.equal(report.pageErrors?.length, 0); assert.equal(report.failures?.length, 1);
  assert.match(report.failures[0], /^AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal:\s+0 !== 1\s*$/);
  for (const key of ['modeGate', 'build', 'inspect', 'flash', 'verify', 'concurrentTask', 'duringFlashClose']) assert.equal(report.controls?.[key], 'passed', `Cannot resume an incomplete ${key}`);
  for (const key of ['export', 'restartDedup']) assert.equal(report.controls[key], 'pending');
  assert.equal(report.export, undefined); assert.equal(report.restart, undefined); assert.equal(report.tamper, undefined);
  assert.equal(report.controls.tamper, 'not-requested'); assert.equal(report.needsHumanClose, undefined);
  assert.equal(report.chooserActions?.length, 2); assert.equal(report.chooserActions[0].calls, 1); assert.equal(report.chooserActions[1].calls, 1);
  assert.equal(samePath(report.chooserActions[0].path, scope.plan.projectRoot), true); assert.equal(samePath(report.chooserActions[1].path, scope.output), true);
  assert.equal(report.closes?.length, 1); assert.equal(report.closes[0].normalClose, true); assert.equal(report.closes[0].launcherExitCode, 0);
  assert.equal(report.closes[0].launcherSignal, null); assert.equal(report.closes[0].nativeAfter, null); assert.equal(report.closes[0].installedGuiAbsent, true);
  assert.equal(report.closeWarningObserverRestored?.restored, true); assert.equal(report.duringFlashClose?.closeAttempts, 1);
  assert.equal(report.duringFlashClose.warning?.calls?.length, 1); assert.equal(report.duringFlashClose.warning.calls[0].phase, 'fulfilled');
  assert.equal(report.concurrentInspect?.otherTaskAfter?.operations?.length, 0); assert.match(report.concurrentInspect.rejection, /另一个任务仍在运行/);
  assert.match(report.taskId, /^[a-zA-Z0-9_-]+$/); assert.match(report.sessionId, /^[a-zA-Z0-9_-]+$/);
  const state = report.verify as EmbeddedStatus; assert.equal(state?.taskId, report.taskId); assert.equal(state.operations.length, 4);
  const artifact = assertEmbeddedBuild(state, scope.plan.expectedProfile);
  const flash = successfulOperation(state, 'flash'); const verify = successfulOperation(state, 'verify'); const inspect = successfulOperation(state, 'inspect');
  assertFlashGrant(state, scope.plan.expectedProfile, flash); assert.equal(flash.artifactId, artifact.id); assert.equal(verify.artifactId, artifact.id);
  assert.ok(flash.receipt && verify.receipt && inspect.receipt);
  const flashReceipt = parseFixedWorkerReceipt(`${flash.receipt}\n`, 'flash', flash.id, artifact.buildId);
  parseFixedWorkerReceipt(`${verify.receipt}\n`, 'verify', verify.id, artifact.buildId);
  const inspectReceipt = parseFixedWorkerReceipt(`${inspect.receipt}\n`, 'inspect', inspect.id);
  assert.equal(flashReceipt.artifactSha256, artifact.hexSha256); assert.equal(flashReceipt.backupSha256, inspectReceipt.backup!.sha256);
  assert.equal(flashReceipt.preflashReadSha256, inspectReceipt.backup!.sha256); assert.equal(state.grant!.backupSha256, inspectReceipt.backup!.sha256);
  assert.deepEqual(report.failureHardware, state); assert.equal(report.launches?.length, 1);
  assert.equal(report.closes[0].electronMain.pid, report.launches[0].electronMain.pid);
  for (const key of ['testScriptSha256', 'helperSha256', 'receiptParserSha256', 'closeWarningObserverSha256']) assert.match(report[key], /^[a-f0-9]{64}$/);
  return { state, artifact, flash, verify, inspect, originalExportParent: report.chooserActions[1].path as string,
    originalEvidence: path.join(scope.output, 'evidence.json') };
}
