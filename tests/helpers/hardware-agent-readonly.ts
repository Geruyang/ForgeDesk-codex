import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { HardwareAgentRunView } from '../../packages/shared/hardware-agent';
import type { EmbeddedStatus } from '../../packages/engineering-runner/embedded/types';
import { parseFixedWorkerReceipt } from '../../packages/engineering-runner/device/real-stm32';
import { primarySid } from './snapshot-smoke-scope';
import { fileSha256, plainPath, samePath } from './embedded-installed';
import { verifyEmbeddedExport } from './embedded-export';
import { assertHardwareAgentCompletion, assertHardwareAgentNoReplay, assertHardwareAgentPolicy, hardwareAgentExportDestination,
  type HardwareAgentInstalledPlan } from './hardware-agent-installed';

export const READONLY_SOURCE_RUN = 'hardware-agent-1792076310974-ba6e7c';
export const READONLY_SOURCE_SHA256 = 'aa521ab556b4ab7f7129da61b797bd21a7e5afff9423da56782d1bba65c8ddd3';
export const READONLY_RUNTIME = 'b9a61615c564ea560604503ff7190ecc5e8620f0';
export const MODEL_CONTROL_NAMES = ['publicLogin', 'policy', 'modelCalls', 'build', 'inspect', 'nativeAuthorization', 'flash', 'verify', 'export', 'restartNoReplay', 'normalClose'];
export interface ReadonlySource extends Record<string, any> {
  run: HardwareAgentRunView; hardware: EmbeddedStatus;
  failureRun: HardwareAgentRunView; failureHardware: EmbeddedStatus;
}

// Admission is only for this observed harness bug, never for an unfinished or failed device workflow.
export function assertReadonlyFailureBoundary(value: unknown, plan: HardwareAgentInstalledPlan): asserts value is ReadonlySource {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); const source = value as ReadonlySource;
  assert.equal(source.schemaVersion, 1); assert.equal(source.runId, READONLY_SOURCE_RUN); assert.equal(plan.runId, READONLY_SOURCE_RUN);
  assert.equal(source.runtimeCommit, READONLY_RUNTIME); assert.equal(plan.runtimeCommit, READONLY_RUNTIME);
  assert.equal(source.scope, 'real-model-fixed-target-installed-T2'); assert.equal(source.realModel, true); assert.equal(source.secondUser, false);
  assert.equal(source.result, 'failed'); assert.equal(source.model, 'gpt-6.1-sol'); assert.equal(source.release?.version, '0.4.0');
  assert.equal(source.publicAccount?.loggedIn, true); assert.equal(source.desktop?.sid, primarySid);
  assert.equal(source.desktop?.elevated, false); assert.equal(source.desktop?.explorerMatched, true);
  assert.equal(source.needsHumanClose, undefined); assert.equal(source.cleanupError, undefined); assert.deepEqual(source.pageErrors, []);
  assert.deepEqual(Object.keys(source.controls).sort(), [...MODEL_CONTROL_NAMES].sort());
  for (const name of MODEL_CONTROL_NAMES.slice(0, 9)) assert.equal(source.controls[name], 'passed');
  for (const name of MODEL_CONTROL_NAMES.slice(9)) assert.equal(source.controls[name], 'pending');
  assert.ok(Array.isArray(source.failures) && source.failures.length === 1);
  assert.ok(typeof source.failures[0] === 'string' && source.failures[0].startsWith('AssertionError [ERR_ASSERTION]: Restart must not resume or fabricate controller calls\n'));
  const diff = source.failures[0].split('\n').filter((line: string) => /^[+-]/.test(line) && line !== '+ actual - expected');
  assert.deepEqual(diff.map((line: string) => {
    const match = /^-\s+(artifact|message|detail|progress): undefined,?$/.exec(line); assert.ok(match, 'Only the observed omitted-undefined diff is eligible'); return match[1];
  }).sort(), ['artifact', 'detail', 'message', 'progress']);
  assert.equal(source.uiSubmitCount, 1); assert.equal(source.hostPreparation?.operationCount, 0); assert.equal(source.hostPreparation?.ordinaryEngineState, 'stopped');
  assert.equal(source.run.calls.length, 6); assert.equal(source.hardware.operations.length, 4);
  assertHardwareAgentNoReplay(source.run, source.failureRun, source.hardware, source.failureHardware);
  assert.equal(source.run.status, 'completed'); assert.equal(source.run.active, false); assert.equal(source.run.hardwareBusy, false);
  assert.equal(source.launches?.length, 2); assert.equal(source.closes?.length, 2);
  for (const launch of source.launches) {
    assert.equal(launch.electronMain.type, 'browser'); assert.ok(Number.isSafeInteger(launch.electronMain.pid) && launch.electronMain.pid > 0);
    assert.ok(samePath(launch.electronMain.execPath, plan.installedExe)); assert.equal(launch.nativeMain.sid, primarySid);
    assert.equal(launch.nativeMain.id, launch.electronMain.pid);
  }
  for (const close of source.closes) {
    assert.equal(close.normalClose, true); assert.equal(close.installedGuiAbsent, true); assert.equal(close.nativeAfter, null);
    assert.equal(close.launcherExitCode, 0); assert.equal(close.launcherSignal, null); assert.equal(close.exitCodeScope, 'playwright-launcher');
  }
}

export function assertReadonlyObservation(source: ReadonlySource, snapshot: AppSnapshot, hardware: EmbeddedStatus, observedAt: string) {
  const run = snapshot.hardwareAgent?.runs.find(item => item.runId === source.run.runId); assert.ok(run);
  assert.equal(snapshot.version, '0.4.0'); assert.equal(snapshot.hardwareAgent?.activeRunId, undefined);
  assert.equal(snapshot.hardwareAgent?.engineState, 'stopped'); assert.equal(snapshot.engine.state, 'stopped');
  assert.equal(snapshot.hardwareAgent?.runs.some(item => item.active || item.hardwareBusy || item.nativeApproval === 'pending'), false);
  const session = snapshot.sessions.find(item => item.id === source.run.sessionId); assert.ok(session);
  assert.equal(session.taskId, source.run.taskId); assert.equal(session.status, 'completed'); assert.equal(session.turnId, undefined);
  assert.ok(session.engineUncertain === false || session.engineUncertain === undefined, 'An uncertain session cannot be read-only accepted');
  const comparison = structuredClone(run);
  let derivedApprovalExpiry: { from: 'approved'; to: 'expired'; expiresAt: string; observedAt: string } | undefined;
  if (source.run.nativeApproval === 'approved' && run.nativeApproval === 'expired') {
    const grant = source.hardware.grant; assert.ok(grant?.approvedAt && grant.consumedBy);
    assert.ok(Number.isFinite(Date.parse(observedAt)) && Date.parse(observedAt) >= Date.parse(grant.expiresAt), 'Only an actually elapsed approval TTL can change this projection');
    derivedApprovalExpiry = { from: 'approved', to: 'expired', expiresAt: grant.expiresAt, observedAt };
    comparison.nativeApproval = 'approved';
  }
  assertHardwareAgentNoReplay(source.run, comparison, source.hardware, hardware);
  assert.deepEqual(hardware.grant, source.hardware.grant);
  assert.equal(hardware.profileId, source.hardware.profileId); assert.equal(hardware.profileSha256, source.hardware.profileSha256);
  return { observedAt, run, hardware, session: { id: session.id, taskId: session.taskId, status: session.status },
    engineState: snapshot.hardwareAgent!.engineState, ...(derivedApprovalExpiry ? { derivedApprovalExpiry } : {}) };
}

export function hexDefinedBytes(text: string): number {
  const addresses = new Map<number, number>(); let high = 0, ended = false;
  for (const line of text.trim().split(/\r?\n/)) {
    assert.ok(!ended && /^:(?:[a-f0-9]{2})+$/i.test(line)); const record = Buffer.from(line.slice(1), 'hex');
    assert.equal(record.length, record[0] + 5); assert.equal([...record].reduce((sum, item) => sum + item, 0) % 256, 0);
    const type = record[3], payload = record.subarray(4, 4 + record[0]);
    if (type === 0) for (let index = 0; index < payload.length; index++) {
      const address = high + record.readUInt16BE(1) + index; assert.ok(address >= 0x08000000 && address < 0x08100000);
      if (addresses.has(address)) assert.equal(addresses.get(address), payload[index]); addresses.set(address, payload[index]);
    }
    else if (type === 4) { assert.equal(payload.length, 2); high = payload.readUInt16BE(0) * 65536; }
    else if (type === 2) { assert.equal(payload.length, 2); high = payload.readUInt16BE(0) * 16; }
    else if (type === 1) { assert.equal(payload.length, 0); ended = true; }
    else { assert.ok([3, 5].includes(type)); assert.equal(payload.length, 4); }
  }
  assert.ok(ended && addresses.size > 0); return addresses.size;
}

export async function verifyReadonlySourceArtifacts(root: string, plan: HardwareAgentInstalledPlan, source: ReadonlySource) {
  assertReadonlyFailureBoundary(source, plan);
  assert.equal(source.release.executableSha256, plan.executableSha256); assert.equal(source.release.installerSha256, plan.installerSha256);
  assert.deepEqual(source.release.resourceHashes, plan.resourceHashes); assert.equal(source.release.suppliedRuntimeCommit, READONLY_RUNTIME);
  assertHardwareAgentPolicy(source.policy, plan.resourceHashes['resources/codex/codex.exe']);
  const { artifact } = assertHardwareAgentCompletion(source.run, source.hardware, plan.expectedProfile);
  for (const filename of [plan.installedExe, plan.installerPath]) await plainPath(filename);
  assert.equal(await fileSha256(plan.installedExe), plan.executableSha256); assert.equal(await fileSha256(plan.installerPath), plan.installerSha256);
  for (const [relative, expected] of Object.entries(plan.resourceHashes)) { const file = path.join(root, 'install', relative); await plainPath(file); assert.equal(await fileSha256(file), expected, relative); }
  for (const [file, expected] of Object.entries(artifact.toolHashes)) { await plainPath(file); assert.equal(await fileSha256(file), expected); }
  assert.equal(await fileSha256(path.join(root, 'packages/engineering-runner/device/real-stm32.ts')), source.receiptParserSha256);
  assert.equal(source.callAssociations.length, source.run.calls.length);
  for (const [index, call] of source.run.calls.entries()) {
    const association = source.callAssociations[index];
    for (const key of ['runId', 'sessionId', 'taskId', 'generation', 'threadId', 'turnId'] as const) assert.equal(association[key], source.run[key]);
    for (const key of ['callId', 'tool', 'requestKey', 'operationId'] as const) assert.equal(association[key], call[key]);
    if (call.tool !== 'embedded_status') assert.equal(call.requestKey, `agent-${createHash('sha256').update(`${source.run.runId}:${call.tool}`).digest('hex')}`);
    if (index > 1) assert.ok(Date.parse(call.receivedAt) >= Date.parse(source.run.calls[index - 1].completedAt!));
  }
  const exported = await verifyEmbeddedExport(hardwareAgentExportDestination(plan.dataDir, source.run), source.hardware);
  assert.ok(samePath(exported.path, source.export.path)); assert.equal(exported.sha256, source.export.sha256); assert.deepEqual(exported.files, source.export.files);
  const bundle = path.dirname(exported.path), exportState = JSON.parse(await readFile(exported.path, 'utf8'));
  assert.deepEqual(exportState.state.grant, source.hardware.grant);
  const operations = Object.fromEntries(source.hardware.operations.map(operation => [operation.kind, operation]));
  const receipts: Record<string, any> = {};
  for (const action of ['inspect', 'flash', 'verify'] as const) {
    const operation = operations[action]; assert.ok(operation.receipt);
    assert.equal(await readFile(path.join(bundle, 'receipts', `${operation.id}.json`), 'utf8'), operation.receipt);
    receipts[action] = JSON.parse(operation.receipt);
    parseFixedWorkerReceipt(`${operation.receipt}\n`, action, operation.id, artifact.buildId);
  }
  const { inspect, flash, verify } = receipts;
  for (const hash of [source.hardware.grant!.backupSha256, flash.backupSha256, flash.preflashReadSha256, flash.precommitReset?.flashSha256]) assert.equal(hash, inspect.backup.sha256);
  assert.equal(inspect.backup.bytes, 1048576); assert.equal(inspect.backup.doubleReadMatch, true);
  assert.deepEqual(flash.precommitReset, { type: 'SYSRESETREQ', halted: true, ipsr: 0, flashSha256: inspect.backup.sha256 });
  assert.equal(flash.artifactSha256, artifact.hexSha256); assert.equal(flash.readbackMismatchBytes, 0); assert.equal(flash.readbackDefinedBytes, flash.definedBytes);
  const definedBytes = hexDefinedBytes(await readFile(path.join(bundle, 'firmware/GestureScreen.hex'), 'utf8')); assert.equal(definedBytes, flash.definedBytes);
  for (const challenge of verify.verify.challenges) assert.ok(Date.parse(challenge.receivedAtUtc) >= Date.parse(operations.verify.createdAt) && Date.parse(challenge.receivedAtUtc) <= Date.parse(operations.verify.updatedAt));
  assert.ok(Date.parse(operations.verify.updatedAt) < Date.parse(source.hardware.grant!.expiresAt));
  return { resourcePinCount: Object.keys(plan.resourceHashes).length, executableSha256: plan.executableSha256, installerSha256: plan.installerSha256,
    toolPinCount: Object.keys(artifact.toolHashes).length, calls: source.run.calls.length, operations: source.hardware.operations.length, export: exported,
    rawReceiptCount: 3, rawCrcFrames: verify.verify.challenges.length, frameDelta: verify.verify.frameDelta, uptimeDeltaMs: verify.verify.uptimeDeltaMs,
    hexDefinedBytes: definedBytes, preflashDifferentBytes: flash.preflashDifferentBytes, backupChainSha256: inspect.backup.sha256, readbackSha256: flash.readbackSha256,
    boundary: 'Revalidated original receipts and exported files only; no new device read, model turn, tool invocation, approval or programming action' };
}
