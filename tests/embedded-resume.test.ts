import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertEmbeddedExportResume } from './helpers/embedded-resume';
import type { EmbeddedInstalledScope } from './helpers/embedded-installed';

function fixture() {
  const root = path.resolve('tests/.tmp/resume-pure'); const runId = 't2-1792000000000-abcd'; const hash = 'a'.repeat(64);
  const profile = { id: 'gesturescreen-challenger-v1', sha256: hash, probeSerial: '594AC1D7613FED24', uid: '0037001b3133510432383236', chipId: 0x419, flashKiB: 1024, cdcSerial: '326F32513133' };
  const scope = { root, runtime: path.join(root, '.runtime/t2', runId), dataDir: path.join(root, '.runtime/t2', runId, 'data'), output: path.join(root, 'output/t2', runId),
    plan: { runId, scope: 'user-driven-fixed-target-installed-T2', runtimeCommit: 'a'.repeat(40), version: '0.3.1', projectRoot: path.join(root, 'output/hardware', runId, 'project'), resourceHashes: {}, executableSha256: hash, installerSha256: hash, expectedProfile: profile } } as EmbeddedInstalledScope;
  const artifact = { id: 'build', buildId: '1'.repeat(64), hexSha256: hash, axfSha256: hash, sourceSha256: hash, profileSha256: hash,
    templateSha256: hash, logSha256: hash, toolHashes: { compiler: hash }, projectSourceBefore: hash, projectSourceAfter: hash, snapshotSourceBefore: hash, snapshotSourceAfter: hash,
    processExit: 0, files: [{ path: 'main.c', sha256: hash, bytes: 1 }] };
  const timestamp = '2026-10-15T01:01:00Z';
  const op = (kind: string, receipt?: object) => ({ id: kind, kind, requestKey: kind, artifactId: kind === 'inspect' ? undefined : artifact.id, status: 'succeeded', processExited: true,
    nonce: '01'.repeat(16), argsDigest: hash, createdAt: timestamp, updatedAt: timestamp, ...(receipt ? { receipt: JSON.stringify({ schemaVersion: 1, operationId: kind, action: kind, status: 'succeeded', ...receipt }) } : {}) });
  function challenge(nonceHex: string, frames: number, uptimeMs: number) {
    const frame = Buffer.alloc(100); frame.write('FDR1'); Buffer.from(nonceHex, 'hex').copy(frame, 4); Buffer.from(artifact.buildId, 'hex').copy(frame, 20); Buffer.from('1b0037000451333136323832', 'hex').copy(frame, 52);
    [31, frames, 0, 0, 0, 168000000, 48000000, uptimeMs].forEach((value, index) => frame.writeUInt32LE(value, 64 + index * 4));
    let crc = 0xffffffff; for (const byte of frame.subarray(0, 96)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } frame.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 96);
    return { nonceHex, responseHex: frame.toString('hex'), receivedAtUtc: timestamp, decoded: { flags: 31, cameraFrames: frames, cameraErrors: 0, cameraTimeouts: 0, displayErrors: 0, sysclkHz: 168000000, pll48Hz: 48000000, uptimeMs } };
  }
  const state = { configured: true, taskId: 'task', profileId: profile.id, profileSha256: hash, limitation: 'Pure fixture only', hardwareAvailable: false, artifact,
    operations: [op('build'), op('inspect', { stage: 'inspected', backup: { path: 'fixture-backup', bytes: 1048576, sha256: hash, doubleReadMatch: true } }),
      op('flash', { stage: 'reset_and_exited', artifactSha256: hash, backupSha256: hash, preflashReadSha256: hash, definedBytes: 10, preflashDifferentBytes: 1, readbackSha256: hash, readbackDefinedBytes: 10, readbackMismatchBytes: 0 }),
      op('verify', { stage: 'cdc_verified', verify: { expectedBuildId: artifact.buildId, expectedUid96: profile.uid, frameDelta: 2, uptimeDeltaMs: 300, challenges: [challenge('01'.repeat(16), 10, 100), challenge('02'.repeat(16), 12, 400)] } })],
    grant: { id: 'grant', taskId: 'task', artifactId: artifact.id, hexSha256: hash, axfSha256: hash, backupSha256: hash, buildId: artifact.buildId, sourceSha256: hash, profileId: profile.id, profileSha256: hash,
      identity: { probeSerial: profile.probeSerial, uid: profile.uid, chipId: profile.chipId, flashKiB: profile.flashKiB, cdcSerial: profile.cdcSerial }, scope: 'flash-and-verify-once', approvedAt: '2026-10-15T01:00:00Z', expiresAt: '2026-10-15T01:05:00Z', consumedBy: 'flash' } };
  const report: Record<string, any> = { schemaVersion: 1, scope: scope.plan.scope, runId, result: 'failed', realModel: false, secondUser: false, planSha256: hash, runtimeCommit: scope.plan.runtimeCommit, dataDir: scope.dataDir, projectRoot: scope.plan.projectRoot,
    release: { version: scope.plan.version, executableSha256: hash, installerSha256: hash, resourceHashes: {}, suppliedRuntimeCommit: scope.plan.runtimeCommit }, desktop: { sid: 'S-1-5-21-1196670755-766692816-2897134863-1002', elevated: false, explorerMatched: true },
    failures: ['AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 1\n'], pageErrors: [], controls: { modeGate: 'passed', build: 'passed', inspect: 'passed', flash: 'passed', verify: 'passed', concurrentTask: 'passed', duringFlashClose: 'passed', export: 'pending', restartDedup: 'pending', tamper: 'not-requested' },
    chooserActions: [{ path: scope.plan.projectRoot, calls: 1 }, { path: scope.output, calls: 1 }], closes: [{ normalClose: true, launcherExitCode: 0, launcherSignal: null, nativeAfter: null, installedGuiAbsent: true, electronMain: { pid: 10 } }],
    launches: [{ electronMain: { pid: 10 } }], closeWarningObserverRestored: { restored: true }, duringFlashClose: { closeAttempts: 1, warning: { calls: [{ phase: 'fulfilled' }] } }, concurrentInspect: { otherTaskAfter: { operations: [] }, rejection: '另一个任务仍在运行' },
    taskId: 'task', sessionId: 'session', verify: state, failureHardware: structuredClone(state), testScriptSha256: hash, helperSha256: hash, receiptParserSha256: hash, closeWarningObserverSha256: hash };
  return { scope, report, hash };
}
test('export-only resume admits a fully proven historical flash and verify with the diagnosed outer-layout assertion', () => { const { scope, report, hash } = fixture(); assert.equal(assertEmbeddedExportResume(report, scope, hash).flash.id, 'flash'); });
test('resume never bypasses unapproved/expired-before-flash/incomplete/unknown hardware or a different failure', () => {
  for (const change of [(report: any) => { report.controls.flash = 'pending'; }, (report: any) => { report.controls.verify = 'pending'; }, (report: any) => { report.failures = ['Grant challenge is stale']; },
    (report: any) => { report.failures.push('another failure'); }, (report: any) => { report.verify.operations[2].status = 'unknown'; }, (report: any) => { report.verify.grant.expiresAt = '2026-10-15T00:00:00Z'; },
    (report: any) => { report.verify.grant.approvedAt = undefined; }, (report: any) => { report.controls.concurrentTask = 'pending'; }, (report: any) => { report.closes[0].normalClose = false; }]) {
    const { scope, report, hash } = fixture(); change(report); assert.throws(() => assertEmbeddedExportResume(report, scope, hash));
  }
});
test('resume rejects changed plan/home/release/SID, extra operations and stale verify frames', () => {
  for (const change of [(report: any) => { report.planSha256 = 'b'.repeat(64); }, (report: any) => { report.dataDir = path.resolve('wrong-home'); }, (report: any) => { report.release.version = '0.2.1'; },
    (report: any) => { report.desktop.sid = 'different-SID'; }, (report: any) => { report.verify.operations.push(report.verify.operations[0]); }, (report: any) => { const receipt = JSON.parse(report.verify.operations[3].receipt); receipt.verify.challenges[1].nonceHex = receipt.verify.challenges[0].nonceHex; report.verify.operations[3].receipt = JSON.stringify(receipt); }]) {
    const { scope, report, hash } = fixture(); change(report); assert.throws(() => assertEmbeddedExportResume(report, scope, hash));
  }
});
