import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopHarness, setupSession, until, delay, type DesktopHarnessOptions } from './helpers/desktop-harness';
import { FZ3B_PROFILE } from '../packages/engineering-runner/fz3b/profile';
import type { Fz3bSemanticFixture } from '../packages/engineering-runner/fz3b/types';

const fixture: Fz3bSemanticFixture = { id: 'fz3b-pillow-scene-v1', manifestSha256: FZ3B_PROFILE.semanticManifestSha256, queriesSha256: FZ3B_PROFILE.queriesSha256,
  imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256,
  width: 914, height: 512, queryCount: 4, embeddingDimensions: 512, expectedLabel: 'pillow',
  queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: { ...FZ3B_PROFILE.encoderIdentity } };

test('desktop FZ3B is failclosed by default and an explicit missing-key fixture dispatches no engine or device', async () => {
  const h = await desktopHarness({ fz3bFixture: fixture, allowFz3bEngine: true, fz3bAvailable: false });
  try {
    const session = await setupSession(h);
    assert.equal((await h.snapshot()).fz3bAgent?.available, false);
    assert.equal((await h.snapshot()).fz3bAgent?.status, 'missing-key');
    assert.equal((await h.snapshot()).fz3bAgent?.resourcesVerified, true);
    assert.equal((await h.snapshot()).fz3bAgent?.keyImportAllowed, true);
    await assert.rejects(h.invoke('fz3bAgentStart', session.id, 'fixed task', 'gpt-6.1-sol'), /key missing/);
    assert.equal(h.fz3bEngine, undefined); assert.equal((await h.fz3bBackend!.list()).length, 0);
    assert.equal(await h.invoke('fz3bSnapshot', session.id), null);
    assert.equal(h.engine.sendCalls, 0);
  } finally { await h.cleanup(); }
});
test('verified missing-key onboarding works in idle controlled mode and uses only the native selected path', async () => {
  const options: DesktopHarnessOptions = { fz3bFixture: fixture, fz3bAvailable: false, initialHardwareMode: { schemaVersion: 1, active: true } };
  let selected = '';
  options.fz3bImportKey = async path => { selected = path; options.fz3bAvailable = true; };
  const h = await desktopHarness(options);
  try {
    assert.equal((await h.snapshot()).hardware.modeActive, true); assert.equal(h.engine.state, 'stopped');
    assert.equal((await h.snapshot()).fz3bAgent?.keyImportAllowed, true);
    const nativePath = `${h.directory}/operator-selected-fixture.key`;
    h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nativePath] });
    await h.invoke('fz3bImportKey');
    assert.equal(selected, nativePath); assert.equal(h.fz3bImportCalls, 1);
    const state = await h.snapshot();
    assert.equal(state.fz3bAgent?.status, 'available'); assert.equal(state.fz3bAgent?.available, true);
    assert.equal(state.hardware.modeActive, true); assert.equal(state.fz3bAgent?.keyImportAllowed, true);
    assert.equal(h.fz3bEngine, undefined); assert.equal(h.engine.sendCalls, 0);
    assert.equal((await h.fz3bBackend!.list()).length, 0);
  } finally { await h.cleanup(); }
});
test('typed invalid availability never opens key import even when the reason text says missing key', async () => {
  for (const [status, resourcesVerified] of [['invalid-key', true], ['invalid-resources', false], ['missing-ssh', true], ['unsupported-host', true], ['missing-key', false]] as const) {
    const h = await desktopHarness({ fz3bFixture: fixture, fz3bAvailability: { available: false, status, resourcesVerified, reason: 'FZ3B_PROJECT_KEY_MISSING' } });
    try {
      let opened = 0; h.dialog.showOpenDialog = async () => { ++opened; return { canceled: true, filePaths: [] }; };
      assert.equal((await h.snapshot()).fz3bAgent?.keyImportAllowed, false);
      await assert.rejects(h.invoke('fz3bImportKey'), /KEY_IMPORT_NOT_ALLOWED/);
      assert.equal(opened, 0); assert.equal(h.fz3bImportCalls, 0); assert.equal(h.fz3bEngine, undefined);
    } finally { await h.cleanup(); }
  }
});
test('pending normal approvals and unknown software operations disable typed key import', async () => {
  const h = await desktopHarness({ fz3bFixture: fixture, fz3bAvailable: false });
  try {
    const session = await setupSession(h);
    Reflect.set(h.engine, 'pendingApprovals', () => [{}]);
    assert.equal((await h.snapshot()).fz3bAgent?.keyImportAllowed, false);
    await assert.rejects(h.invoke('fz3bImportKey'), /KEY_IMPORT_NOT_ALLOWED/);
    Reflect.set(h.engine, 'pendingApprovals', () => []);
    const task = h.tasks.find(task => task.id === session.taskId);
    task.operations.push({ id: 'uncertain-software', status: 'unknown' });
    assert.equal((await h.snapshot()).fz3bAgent?.keyImportAllowed, false);
    await assert.rejects(h.invoke('fz3bImportKey'), /KEY_IMPORT_NOT_ALLOWED/);
    assert.equal(h.fz3bImportCalls, 0);
  } finally { await h.cleanup(); }
});
test('no-run startup recovery publishes only its proven idle task and cannot clear another task or uncertainty', async () => {
  let failExit = true;
  const h = await desktopHarness({ fz3bFixture: fixture, allowFz3bEngine: true,
    fz3bAccountBehavior: async () => { throw new Error('Fixture account lookup failed'); },
    fz3bStopBehavior: async () => { if (failExit) throw new Error('Fixture exit not observed'); } });
  try {
    const session = await setupSession(h), other = await h.invoke('createSession', session.projectId, 'Other task');
    await assert.rejects(h.invoke('fz3bAgentStart', session.id, 'fixed task', 'gpt-6.1-sol'), /account lookup failed/);
    const state = await h.snapshot();
    assert.equal(state.fz3bAgent?.activeRunId, undefined); assert.equal(state.fz3bAgent?.runs.length, 0);
    assert.equal(state.fz3bAgent?.recoveryTaskId, session.taskId); assert.equal(state.fz3bAgent?.keyImportAllowed, false);
    await assert.rejects(h.invoke('fz3bRecover', other.taskId), /RECOVERY_NOT_IDLE/);
    const task = h.tasks.find(task => task.id === other.taskId);
    task.operations.push({ id: 'unknown-software', status: 'unknown' });
    assert.equal((await h.snapshot()).fz3bAgent?.recoveryTaskId, undefined);
    await assert.rejects(h.invoke('fz3bRecover', session.taskId), /OWNER_REQUIRED/);
    task.operations = [];
    await assert.rejects(h.invoke('fz3bRecover', session.taskId), /exit not observed/);
    failExit = false;
    assert.equal(await h.invoke('fz3bRecover', session.taskId), null);
    const after = await h.snapshot(); assert.equal(after.fz3bAgent?.recoveryTaskId, undefined);
    assert.equal(after.fz3bAgent?.keyImportAllowed, true); assert.equal(h.fz3bEngine!.startCalls, 1); assert.equal(h.fz3bEngine!.sendCalls, 0);
  } finally { await h.cleanup(); }
});
test('actual desktop IPC gate rejects software STM32 shell and generic MCP while FZ3B owns the task', async () => {
  const h = await desktopHarness({ fz3bFixture: fixture, allowFz3bEngine: true });
  try {
    const session = await setupSession(h);
    const run = await h.invoke('fz3bAgentStart', session.id, 'fixed task', 'gpt-6.1-sol');
    assert.equal(h.engine.state, 'stopped'); assert.equal(h.fz3bEngine!.sendCalls, 1);
    const runtimeCalls = h.hardwareRuntimeCalls.length;
    for (const [method, ...args] of [
      ['connect'], ['send', session.id, 'bad', 'gpt-6.1-sol'], ['steer', session.id, 'bad'], ['approve', 1, 1, 'accept'],
      ['runAcceptance', session.id, 'verifier', 'key'], ['enableSnapshot', session.id], ['runSnapshotBuild', session.id, 'key'],
      ['hardwareConfigure', session.id], ['hardwareBuild', session.id, 'key'], ['hardwareInspect', session.id, 'key'],
      ['hardwareFlash', session.id, 'key'], ['hardwareVerify', session.id, 'key'], ['hardwareAgentStart', session.id, 'bad', 'gpt-6.1-sol'],
      ['fz3bAgentStart', session.id, 'again', 'gpt-6.1-sol'], ['fz3bImportKey'], ['fz3bLeaveMode'],
    ]) await assert.rejects(h.invoke(method as string, ...args), /HARDWARE_AGENT_ACTIVE/);
    await assert.rejects(h.bridgeInvoke('engineering.test', { taskId: session.taskId, verifierId: 'fake' }), /HARDWARE_CONTROLLED_MODE/);
    await assert.rejects(h.bridgeInvoke('device.flash', { taskId: session.taskId }), /HARDWARE_NOT_ENABLED/);
    assert.equal(h.engine.sendCalls, 0); assert.equal(h.engine.steerCalls.length, 0);
    assert.equal(h.hardwareRuntimeCalls.length, runtimeCalls);
    assert.equal((await h.fz3bBackend!.status(run.runId))!.operations.length, 0);
    assert.equal((await h.invoke('fz3bSnapshot', session.id)).runId, run.runId);
    await h.invoke('fz3bAgentStop', run.runId);
  } finally { await h.cleanup(); }
});
test('desktop FZ3B callback binds host task and rejects foreign generation thread turn before any worker', async () => {
  const h = await desktopHarness({ fz3bFixture: fixture, allowFz3bEngine: true });
  try {
    const session = await setupSession(h), run = await h.invoke('fz3bAgentStart', session.id, 'fixed task', 'gpt-6.1-sol');
    for (const changed of [{ generation: 999 }, { threadId: 'foreign' }, { turnId: 'foreign' }]) await assert.rejects(h.fz3bEngine!.toolCall('fz3b_status', {}, changed), /MISMATCH/);
    const result = await h.fz3bEngine!.toolCall('fz3b_status');
    assert.equal(result.runId, run.runId); assert.equal(result.result, 'status');
    const snapshot = await h.invoke('fz3bSnapshot', session.id);
    assert.equal(snapshot.operations.length, 0); assert.equal(snapshot.calls.length, 1);
    await h.invoke('fz3bAgentStop', run.runId);
  } finally { await h.cleanup(); }
});
test('software verification already awaiting task lookup is rechecked before dispatch after FZ3B claims', async () => {
  const h = await desktopHarness({ fz3bFixture: fixture, allowFz3bEngine: true });
  try {
    const fz = await setupSession(h), software = await h.invoke('createSession', fz.projectId, 'Software contender');
    await h.invoke('setAcceptance', software.id, [{ id: 'verify', title: 'Fixed fixture', kind: 'automated', command: { executable: process.execPath, args: ['-e', 'process.exit(0)'] } }]);
    let entered = false, release!: () => void, executions = 0;
    const gate = new Promise<void>(done => { release = done; }), original = h.fixtureRunner.getTask.bind(h.fixtureRunner);
    h.fixtureRunner.getTask = async id => { if (id === software.id) { entered = true; await gate; } return original(id); };
    h.fixtureRunner.run = async () => { ++executions; return { status: 'succeeded' }; };
    const verifying = h.invoke('runAcceptance', software.id, 'verify', 'key');
    await until(() => entered); const run = await h.invoke('fz3bAgentStart', fz.id, 'fixed task', 'gpt-6.1-sol');
    release(); await assert.rejects(verifying, /HARDWARE_AGENT_ACTIVE/); assert.equal(executions, 0);
    await h.invoke('fz3bAgentStop', run.runId);
  } finally { await h.cleanup(); }
});
test('restricted sessions cannot resume through ordinary software send or steer, including legacy missing profile', async () => {
  const h = await desktopHarness({ fz3bFixture: fixture, allowFz3bEngine: true });
  try {
    const session = await setupSession(h), run = await h.invoke('fz3bAgentStart', session.id, 'fixed task', 'gpt-6.1-sol');
    await h.invoke('fz3bAgentStop', run.runId); await h.invoke('fz3bLeaveMode');
    await assert.rejects(h.invoke('send', session.id, 'ordinary resume', 'qa-model'), /RESTRICTED_SESSION_SOFTWARE_RESUME_DENIED/);
    await assert.rejects(h.invoke('steer', session.id, 'ordinary steer'), /RESTRICTED_SESSION_SOFTWARE_RESUME_DENIED/);
    const view = await h.snapshot(); delete view.sessions.find(item => item.id === session.id)!.engineProfile;
    await assert.rejects(h.invoke('send', session.id, 'legacy resume', 'qa-model'), /RESTRICTED_SESSION_SOFTWARE_RESUME_DENIED/);
    assert.equal((await h.snapshot()).sessions.find(item => item.id === session.id)!.engineProfile, 'fz3b');
    assert.equal(h.engine.sendCalls, 0); assert.equal(h.engine.steerCalls.length, 0);
    const software = await h.invoke('createSession', session.projectId, 'Ordinary software');
    await h.invoke('send', software.id, 'ordinary task', 'qa-model'); assert.equal(h.engine.sendCalls, 1);
  } finally { await h.cleanup(); }
});
test('native key picker has no renderer path argument, blocks mutation and normal close while pending', async () => {
  const h = await desktopHarness({ fz3bFixture: fixture });
  try {
    const session = await setupSession(h);
    await assert.rejects(h.invoke('fz3bImportKey', '/renderer-selected-key'), /NATIVE_KEY_PICKER_ONLY/);
    let opened = false, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    h.dialog.showOpenDialog = async () => { opened = true; await gate; return { canceled: true, filePaths: [] }; };
    const importing = h.invoke('fz3bImportKey'); await until(() => opened);
    for (const [method, ...args] of [['connect'], ['send', session.id, 'bad'], ['fz3bAgentStart', session.id, 'task', 'gpt-6.1-sol'], ['hardwareConfigure', session.id]]) await assert.rejects(h.invoke(method as string, ...args), /KEY_IMPORT_PENDING/);
    h.window.callbacks.get('close')!({ preventDefault() {} }); await delay();
    assert.equal(h.window.destroyed, false); assert.equal(h.closed().quit, false); assert.equal(h.fz3bImportCalls, 0);
    release(); await importing; assert.equal(h.fz3bImportCalls, 0);
    await h.invoke('connect'); assert.equal(h.engine.state, 'ready');
  } finally { await h.cleanup(); }
});
