import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { EmbeddedStatus } from '../packages/engineering-runner/embedded/types';
import type { HardwareAgentRunView, HardwareAgentToolName } from '../packages/shared/hardware-agent';
import { assertHardwareAgentCompletion, assertHardwareAgentNoReplay, assertHardwareAgentPolicy, deriveHardwareAgentInstalledScope, hardwareAgentExportDestination, HARDWARE_AGENT_MODEL, type HardwareAgentInstalledPlan } from './helpers/hardware-agent-installed';
import { HARDWARE_AGENT_TOOLS } from '../packages/shared/hardware-agent';

const root = path.resolve('tests/.tmp/hardware-agent-pure-repository');
const hash = 'a'.repeat(64), stamp = '2026-10-15T01:00:00Z';
function plan(): HardwareAgentInstalledPlan {
  const resources = ['app.asar', 'codex/codex.exe', 'codex/codex-code-mode-host.exe', 'codex/codex-command-runner.exe',
    'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe', 'hardware/python/python.exe', 'hardware/manifest.json',
    'hardware-worker.py', 'templates/gesturescreen-v1/overlay-manifest.json', 'templates/gesturescreen-v1/App/Inc/forgedesk_build_id.h',
    'templates/gesturescreen-v1/BSP/Src/gs_usb_capture.c', 'templates/gesturescreen-v1/Modules/UsbCapture/Inc/gs_usb_protocol.h',
    'templates/gesturescreen-v1/Modules/UsbCapture/Src/gs_usb_protocol.c'];
  return { schemaVersion: 1, scope: 'real-model-fixed-target-installed-T2', runId: 'hardware-agent-1792000000000-abcdef', version: '0.4.0',
    runtimeCommit: 'b'.repeat(40), dataDir: path.join(root, '.runtime/app'), installedExe: path.join(root, 'install/ForgeDesk.exe'),
    installerPath: path.join(root, 'release/ForgeDesk-0.4.0-x64-setup.exe'), installerSha256: hash, executableSha256: hash,
    projectRoot: path.join(root, 'output/hardware/trusted-copy'), keilExecutable: 'D:/STSoft/Keil5/UV4/UV4.exe', model: HARDWARE_AGENT_MODEL,
    resourceHashes: Object.fromEntries(resources.map(name => [`resources/${name}`, hash])),
    expectedProfile: { id: 'gesturescreen-challenger-v1', sha256: hash, uid: '0037001b3133510432383236', probeSerial: '594AC1D7613FED24', chipId: 0x419, flashKiB: 1024, cdcSerial: '326F32513133' } };
}

test('offline scope fixture is distinct from manual T2 and pins only the existing primary home', () => {
  const p = plan(), scope = deriveHardwareAgentInstalledScope(root, p, {});
  assert.equal(scope.dataDir, path.join(root, '.runtime/app'));
  assert.equal(scope.output, path.join(root, 'output/hardware-agent', p.runId));
  for (const patch of [{ scope: 'user-driven-fixed-target-installed-T2' }, { version: '0.3.4' }, { dataDir: path.join(root, '.runtime/copied-auth') },
    { model: 'another-model' }, { installedExe: path.join(root, 'dist/ForgeDesk.exe') }, { runtimeCommit: 'HEAD' }])
    assert.throws(() => deriveHardwareAgentInstalledScope(root, { ...p, ...patch }, {}));
});

test('offline scope fixture rejects path containment, resource pin omissions and all unreviewed overrides', () => {
  for (const projectRoot of [root, path.join(root, '.runtime/app'), path.join(root, 'install'), path.join(root, 'output/hardware-agent/project'), path.resolve(root, '../escape')])
    assert.throws(() => deriveHardwareAgentInstalledScope(root, { ...plan(), projectRoot }, {}));
  for (const key of ['CODEX_HOME', 'FORGEDESK_DATA_DIR', 'ELECTRON_RUN_AS_NODE', 'FORGEDESK_T2_NATIVE_OPERATOR', 'FORGEDESK_HARDWARE_AGENT_ALLOW_FLASH'])
    assert.throws(() => deriveHardwareAgentInstalledScope(root, plan(), { [key]: '1' }));
  assert.deepEqual(deriveHardwareAgentInstalledScope(root, plan(), { FORGEDESK_HARDWARE_AGENT_NATIVE_OPERATOR: 'delegated-ui' }), deriveHardwareAgentInstalledScope(root, plan(), {}));
  assert.throws(() => deriveHardwareAgentInstalledScope(root, plan(), { FORGEDESK_HARDWARE_AGENT_NATIVE_OPERATOR: 'delegated-ui ' }));
  for (const pin of Object.keys(plan().resourceHashes)) { const p = plan(); delete p.resourceHashes[pin]; assert.throws(() => deriveHardwareAgentInstalledScope(root, p, {})); }
  assert.throws(() => deriveHardwareAgentInstalledScope(root, { ...plan(), resourceHashes: { ...plan().resourceHashes, 'resources/../escape': hash } }, {}));
});

test('offline policy fixture rejects shell inventory, external MCP, environments and unpinned executables', () => {
  const policy = { schemaVersion: 1, profile: 'restricted-hardware', model: HARDWARE_AGENT_MODEL, tools: [...HARDWARE_AGENT_TOOLS],
    environments: [], externalMcp: 'disabled', freshThreadOnly: true, executableSha256: hash, protocolVersion: 'fixture-protocol',
    bundledCatalogSha256: hash, catalogSha256: hash, effectiveConfigSha256: hash };
  assertHardwareAgentPolicy(policy, hash);
  for (const patch of [{ tools: [...policy.tools, 'shell'] }, { tools: policy.tools.slice(1) }, { environments: ['workspace'] },
    { externalMcp: 'enabled' }, { freshThreadOnly: false }, { executableSha256: 'b'.repeat(64) }, { effectiveConfigSha256: '' }])
    assert.throws(() => assertHardwareAgentPolicy({ ...policy, ...patch }, hash));
});

test('offline export fixture converts the actual nested evidence file to the verifier destination without accepting another run or task', () => {
  const data = plan().dataDir, run = completedFixture().run;
  const destination = path.join(data, 'exports/hardware-agent', run.runId);
  const bundle = `forgedesk-embedded-${run.taskId}-01234567-89ab-cdef-0123-456789abcdef`;
  run.export!.path = path.join(destination, bundle, 'evidence.json');
  assert.equal(hardwareAgentExportDestination(data, run), destination);
  for (const filename of [destination, path.join(destination, 'evidence.json'), path.join(destination, bundle, 'another.json'),
    path.join(destination, 'forgedesk-embedded-foreign-01234567-89ab-cdef-0123-456789abcdef', 'evidence.json'),
    path.join(data, 'exports/hardware-agent/another-run', bundle, 'evidence.json')]) {
    const changed = structuredClone(run); changed.export!.path = filename; assert.throws(() => hardwareAgentExportDestination(data, changed));
  }
});

function completedFixture(): { run: HardwareAgentRunView; hardware: EmbeddedStatus } {
  const profile = plan().expectedProfile;
  const operations = (['build', 'inspect', 'flash', 'verify'] as const).map(kind => ({ id: `${kind}-op`, requestKey: `${kind}-key`, kind,
    argsDigest: hash, nonce: hash, status: 'succeeded' as const, processExited: true, artifactId: 'build-op', createdAt: stamp, updatedAt: stamp }));
  const artifact = { id: 'build-op', buildId: hash, createdAt: stamp, sourceRoot: 'fixture-source', hexPath: 'fixture.hex', axfPath: 'fixture.axf',
    hexSha256: hash, axfSha256: hash, sourceSha256: hash, profileSha256: profile.sha256, projectSourceBefore: hash, projectSourceAfter: hash,
    snapshotSourceBefore: hash, snapshotSourceAfter: hash, files: [{ path: 'main.c', bytes: 1, sha256: hash }], templateSha256: hash,
    toolHashes: { 'fixture-only-compiler': hash }, logPath: 'fixture.log', logSha256: hash, processExit: 0 };
  const hardware: EmbeddedStatus = { taskId: 'task', configured: true, profileId: profile.id, profileSha256: profile.sha256, hardwareAvailable: true,
    limitation: 'Offline evidence fixture; no device accessed', operations, artifact,
    grant: { id: 'grant', taskId: 'task', artifactId: artifact.id, hexSha256: hash, axfSha256: hash, buildId: hash, sourceSha256: hash,
      profileId: profile.id, profileSha256: profile.sha256, backupSha256: hash, identity: { probeSerial: profile.probeSerial, uid: profile.uid,
        chipId: profile.chipId, flashKiB: profile.flashKiB, cdcSerial: profile.cdcSerial }, scope: 'flash-and-verify-once',
      approvedAt: stamp, expiresAt: '2026-10-15T01:05:00Z', consumedBy: 'flash-op' } };
  const run: HardwareAgentRunView = { schemaVersion: 1, runId: 'controller', taskId: 'task', sessionId: 'session', model: HARDWARE_AGENT_MODEL,
    generation: 1, threadId: 'thread', turnId: 'turn', status: 'completed', phase: 'completed', active: false, hardwareBusy: false,
    stopRequested: false, nativeApproval: 'approved', createdAt: stamp, updatedAt: stamp, calls: [], artifact,
    export: { path: 'fixture-export/evidence.json', sha256: hash } };
  const tools: HardwareAgentToolName[] = ['embedded_build', 'embedded_inspect', 'embedded_request_flash', 'embedded_verify', 'embedded_export'];
  run.calls = tools.map((tool, index) => ({ callId: `actual-call-${index}`, tool, receivedAt: stamp, completedAt: stamp, status: 'succeeded',
    ...(operations[index] ? { operationId: operations[index].id, requestKey: operations[index].requestKey } : {}),
    result: { runId: run.runId, callId: `actual-call-${index}`, tool, ok: true, result: 'succeeded', phase: 'completed',
      ...(operations[index] ? { operation: operations[index] } : { export: run.export }) } }));
  run.calls.unshift({ callId: 'actual-status', tool: 'embedded_status', receivedAt: stamp, completedAt: stamp, status: 'succeeded',
    result: { runId: run.runId, callId: 'actual-status', tool: 'embedded_status', ok: true, result: 'status', phase: 'ready' } });
  return { run, hardware };
}

test('offline completion fixture requires actual call IDs linked to exactly four authoritative operations', () => {
  const f = completedFixture(); assertHardwareAgentCompletion(f.run, f.hardware, plan().expectedProfile);
  for (const mutate of [(x: typeof f) => { x.run.calls = []; }, (x: typeof f) => { x.run.calls[2].operationId = 'forged-op'; },
    (x: typeof f) => { x.run.calls[1].callId = x.run.calls[0].callId; }, (x: typeof f) => { x.run.calls[2].requestKey = 'another-key'; },
    (x: typeof f) => { x.run.calls[2].result!.callId = 'another-call'; }, (x: typeof f) => { x.run.calls[1].result!.operation!.processExited = false; },
    (x: typeof f) => { x.run.calls.reverse(); }, (x: typeof f) => { x.run.threadId = ''; }, (x: typeof f) => { x.run.taskId = 'foreign'; }]) {
    const changed = structuredClone(f); mutate(changed); assert.throws(() => assertHardwareAgentCompletion(changed.run, changed.hardware, plan().expectedProfile));
  }
});

test('offline completion fixture never counts unknown, stopped, pending native approval or an assistant success label', () => {
  for (const patch of [{ status: 'needs_attention' }, { active: true }, { hardwareBusy: true }, { nativeApproval: 'pending' },
    { nativeApproval: 'cancelled' }, { stopRequested: true }, { model: 'another-model' }, { failure: 'persist failed' }]) {
    const f = completedFixture(); Object.assign(f.run, patch); assert.throws(() => assertHardwareAgentCompletion(f.run, f.hardware, plan().expectedProfile));
  }
  for (const status of ['unknown', 'running', 'rejected', 'stopped', 'replayed'] as const) {
    const f = completedFixture(); f.run.calls[2].status = status; assert.throws(() => assertHardwareAgentCompletion(f.run, f.hardware, plan().expectedProfile));
  }
  const f = completedFixture(); f.hardware.operations[2].status = 'unknown'; assert.throws(() => assertHardwareAgentCompletion(f.run, f.hardware, plan().expectedProfile));
});

test('offline restart fixture rejects controller resume, fresh calls and authoritative operation changes', () => {
  const f = completedFixture(); assertHardwareAgentNoReplay(f.run, structuredClone(f.run), f.hardware, structuredClone(f.hardware));
  for (const mutate of [(x: typeof f) => { x.run.calls.push({ ...x.run.calls[0], callId: 'replayed' }); },
    (x: typeof f) => { x.run.active = true; }, (x: typeof f) => { x.run.generation++; },
    (x: typeof f) => { x.hardware.operations[2].status = 'unknown'; }, (x: typeof f) => { x.hardware.artifact!.buildId = 'b'.repeat(64); }]) {
    const changed = structuredClone(f); mutate(changed); assert.throws(() => assertHardwareAgentNoReplay(f.run, changed.run, f.hardware, changed.hardware));
  }
});

test('offline restart compares JSON persistence semantics without dropping meaningful evidence', () => {
  const before = completedFixture();
  before.run.calls[0].result!.artifact = undefined;
  before.run.calls[0].result!.message = undefined;
  before.hardware.operations[0].detail = undefined;
  before.run.calls[1].result!.operation!.progress = undefined;
  const after = JSON.parse(JSON.stringify(before)) as typeof before;
  assertHardwareAgentNoReplay(before.run, after.run, before.hardware, after.hardware);
  for (const value of [null, '', false, 0, 'changed']) {
    const changed = structuredClone(after);
    Object.assign(changed.run.calls[0].result!, { message: value });
    assert.throws(() => assertHardwareAgentNoReplay(before.run, changed.run, before.hardware, changed.hardware));
  }
  for (const value of [NaN, Infinity, () => undefined, new Date(), [undefined], Array(1)]) {
    const changed = structuredClone(after);
    Object.assign(changed.run.calls[0].result!, { extra: value });
    assert.throws(() => assertHardwareAgentNoReplay(changed.run, changed.run, changed.hardware, changed.hardware));
  }
});
