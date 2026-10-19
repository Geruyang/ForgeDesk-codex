import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { deriveEmbeddedInstalledScope, assertEmbeddedBuild, assertFlashGrant, assertNoEmbeddedReplay, successfulOperation, type EmbeddedInstalledPlan } from './helpers/embedded-installed';
import type { EmbeddedStatus } from '../packages/engineering-runner/embedded/types';

const root = path.resolve('tests/.tmp/t2-pure-repository');
function plan(): EmbeddedInstalledPlan { return { schemaVersion: 1, scope: 'user-driven-fixed-target-installed-T2', runId: 't2-1792000000000-abcd', version: '0.3.4', runtimeCommit: 'a'.repeat(40),
  installedExe: path.join(root, 'install/ForgeDesk.exe'), installerPath: path.join(root, 'release/setup.exe'), installerSha256: 'b'.repeat(64), executableSha256: 'c'.repeat(64),
  projectRoot: path.join(root, 'output/hardware', 't2-1792000000000-abcd', 'project'), keilExecutable: 'D:/STSoft/Keil5/UV4/UV4.exe', artifactTamperPreflight: false,
  resourceHashes: Object.fromEntries(['resources/app.asar', 'resources/codex/codex.exe', 'resources/codex/codex-code-mode-host.exe', 'resources/codex/codex-command-runner.exe',
    'resources/codex/codex-windows-sandbox-setup.exe', 'resources/process-host/process-host.exe', 'resources/hardware/python/python.exe', 'resources/hardware/manifest.json', 'resources/hardware-worker.py', 'resources/templates/gesturescreen-v1/protocol.c'].map(filename => [filename, 'd'.repeat(64)])),
  expectedProfile: { id: 'gesturescreen-challenger-v1', sha256: 'e'.repeat(64), probeSerial: '594AC1D7613FED24', uid: '0037001b3133510432383236', chipId: 0x419, flashKiB: 1024, cdcSerial: '326F32513133' } }; }
test('T2 scope is installed-only, disjoint and has no credential-home override', () => {
  const value = deriveEmbeddedInstalledScope(root, plan(), {}); assert.equal(value.dataDir, path.join(root, '.runtime/t2', plan().runId, 'data'));
  for (const key of ['FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'FORGEDESK_T2_MODE']) assert.throws(() => deriveEmbeddedInstalledScope(root, plan(), { [key]: 'x' }));
  for (const projectRoot of [root, path.join(root, '.runtime/app/project'), path.join(root, 'install/project'), path.join(root, '.runtime/t2', plan().runId, 'project'), path.resolve(root, '../escape')])
    assert.throws(() => deriveEmbeddedInstalledScope(root, { ...plan(), projectRoot }, {}));
});
test('T2 permits only the exact delegated native-UI operator marker, without changing data scope or grants', () => {
  const baseline = deriveEmbeddedInstalledScope(root, plan(), {});
  assert.deepEqual(deriveEmbeddedInstalledScope(root, plan(), { FORGEDESK_T2_NATIVE_OPERATOR: 'delegated-ui' }), baseline);
  assert.deepEqual(deriveEmbeddedInstalledScope(root, plan(), { FORGEDESK_T2_NATIVE_OPERATOR: '' }), baseline);
  for (const value of ['human', 'yes', 'DELEGATED-UI', 'delegated-ui ', '1']) assert.throws(() => deriveEmbeddedInstalledScope(root, plan(), { FORGEDESK_T2_NATIVE_OPERATOR: value }));
  assert.throws(() => deriveEmbeddedInstalledScope(root, plan(), { FORGEDESK_T2_NATIVE_OPERATOR: 'delegated-ui', FORGEDESK_T2_OTHER: '1' }));
});
test('T2 release pins cannot omit core, worker or firmware resources or escape via relative paths', () => {
  for (const version of ['0.2.1', '0.3.0', '0.3.1', '0.3.2', '0.3.3']) assert.throws(() => deriveEmbeddedInstalledScope(root, { ...plan(), version }, {}), /reviewed T2 release/);
  for (const removed of ['resources/app.asar', 'resources/hardware-worker.py', 'resources/hardware/python/python.exe', 'resources/templates/gesturescreen-v1/protocol.c']) { const value = plan(); delete value.resourceHashes[removed]; assert.throws(() => deriveEmbeddedInstalledScope(root, value, {})); }
  for (const invalid of ['resources/../outside', 'resources//worker', 'resources/C:/worker', '../resources/a']) assert.throws(() => deriveEmbeddedInstalledScope(root, { ...plan(), resourceHashes: { ...plan().resourceHashes, [invalid]: 'f'.repeat(64) } }, {}));
  assert.throws(() => deriveEmbeddedInstalledScope(root, { ...plan(), executableSha256: 'not-a-hash' }, {}));
});
function state(): EmbeddedStatus { return { configured: true, taskId: 'task', profileId: 'gesturescreen-challenger-v1', profileSha256: 'e'.repeat(64), limitation: 'Not OS isolation', hardwareAvailable: true,
  operations: [{ id: 'operation', requestKey: 'flash-one', kind: 'flash', argsDigest: 'a'.repeat(64), nonce: 'b'.repeat(32), status: 'succeeded', createdAt: '2026-10-15T01:00:00Z', updatedAt: '2026-10-15T01:01:00Z', processExited: true }] }; }
test('T2 success rejects unknown/failed/unconfirmed and duplicate operation records', () => {
  successfulOperation(state(), 'flash', 'flash-one');
  for (const patch of [{ status: 'unknown' }, { status: 'failed' }, { processExited: false }]) { const value = state(); Object.assign(value.operations[0], patch); assert.throws(() => successfulOperation(value, 'flash', 'flash-one')); }
  const duplicate = state(); duplicate.operations.push({ ...duplicate.operations[0], id: 'different' }); assert.throws(() => successfulOperation(duplicate, 'flash'));
});
test('T2 dedup assertion rejects new/advanced operations and accepts unchanged unknown history without claiming success', () => {
  const before = state(); before.operations[0].status = 'unknown'; before.operations[0].processExited = false;
  assertNoEmbeddedReplay(before, structuredClone(before)); assert.throws(() => successfulOperation(before, 'flash'));
  const replayed = structuredClone(before); replayed.operations[0].status = 'succeeded'; assert.throws(() => assertNoEmbeddedReplay(before, replayed));
  const appended = structuredClone(before); appended.operations.push({ ...appended.operations[0], id: 'replay' }); assert.throws(() => assertNoEmbeddedReplay(before, appended));
});
test('T2 replay comparison excludes only progress, retaining exact persistent status, receipt and argument bindings', () => {
  const before = state(); before.operations[0].receipt = 'bound receipt'; before.operations[0].progress = { schemaVersion: 1, operationId: 'operation', action: 'flash', stage: 'erase_program', sequence: 1, updatedAt: '2026-10-15T01:00:00Z', completed: 0.5, total: 1, unit: 'fraction' };
  const after = structuredClone(before); after.operations[0].progress = { ...after.operations[0].progress!, stage: 'finalizing', sequence: 20, updatedAt: '2026-10-15T01:01:00Z', completed: 1 }; assertNoEmbeddedReplay(before, after);
  delete after.operations[0].progress; assertNoEmbeddedReplay(before, after);
  for (const patch of [{ receipt: 'changed' }, { argsDigest: 'changed' }, { status: 'unknown' }, { processExited: false }, { nonce: 'changed' }, { requestKey: 'changed' }, { artifactId: 'changed' }]) { const altered = structuredClone(after); Object.assign(altered.operations[0], patch); assert.throws(() => assertNoEmbeddedReplay(before, altered)); }
});
function builtState(): EmbeddedStatus {
  const value = state(); const operation = value.operations[0]; operation.kind = 'build'; operation.artifactId = operation.id;
  value.artifact = { id: operation.id, buildId: '2'.repeat(64), hexPath: 'hex', axfPath: 'axf', hexSha256: '3'.repeat(64), axfSha256: '4'.repeat(64), sourceSha256: '5'.repeat(64), profileSha256: value.profileSha256,
    createdAt: operation.createdAt, sourceRoot: 'source', projectSourceBefore: '6'.repeat(64), projectSourceAfter: '6'.repeat(64), snapshotSourceBefore: '5'.repeat(64), snapshotSourceAfter: '5'.repeat(64),
    files: [{ path: 'main.c', sha256: '7'.repeat(64), bytes: 10 }], toolHashes: { compiler: '8'.repeat(64) }, templateSha256: '9'.repeat(64), logPath: 'build.log', logSha256: 'a'.repeat(64), processExit: 0 };
  return value;
}
test('T2 build assertions require exact operation/artifact and consistent inputs, never merely a succeeded label', () => {
  assertEmbeddedBuild(builtState(), plan().expectedProfile);
  for (const patch of [{ projectSourceAfter: 'changed' }, { snapshotSourceAfter: 'changed' }, { profileSha256: 'f'.repeat(64) }, { id: 'foreign-build' }, { templateSha256: '' }, { toolHashes: {} }, { processExit: null }]) {
    const value = builtState(); Object.assign(value.artifact!, patch); assert.throws(() => assertEmbeddedBuild(value, plan().expectedProfile));
  }
});
test('T2 native grant assertions reject wrong device, stale/unapproved lifetime and unconsumed artifact binding', () => {
  const value = builtState(); const artifact = value.artifact!; const flash = { ...value.operations[0], id: 'flash', kind: 'flash' as const, createdAt: '2026-10-15T01:01:00Z' };
  value.grant = { id: 'grant', taskId: value.taskId, artifactId: artifact.id, hexSha256: artifact.hexSha256, axfSha256: artifact.axfSha256, backupSha256: 'b'.repeat(64), buildId: artifact.buildId, sourceSha256: artifact.sourceSha256,
    profileId: value.profileId, profileSha256: value.profileSha256, identity: { probeSerial: '594AC1D7613FED24', uid: '0037001b3133510432383236', chipId: 0x419, flashKiB: 1024, cdcSerial: '326F32513133' },
    scope: 'flash-and-verify-once', approvedAt: '2026-10-15T01:00:30Z', expiresAt: '2026-10-15T01:05:00Z', consumedBy: flash.id };
  assertFlashGrant(value, plan().expectedProfile, flash);
  for (const patch of [{ approvedAt: undefined }, { consumedBy: 'other' }, { artifactId: 'other' }, { expiresAt: flash.createdAt }, { approvedAt: '2026-10-15T01:02:00Z' }, { profileId: 'other' }]) {
    const altered = structuredClone(value); Object.assign(altered.grant!, patch); assert.throws(() => assertFlashGrant(altered, plan().expectedProfile, flash));
  }
  const wrongDevice = structuredClone(value); wrongDevice.grant!.identity.uid = '0'.repeat(24); assert.throws(() => assertFlashGrant(wrongDevice, plan().expectedProfile, flash));
});
