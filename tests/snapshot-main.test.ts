import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { delay, desktopHarness, setupSession, until } from './helpers/desktop-harness';

const profileId = 'forgedesk.node-software.v1';
const receipt = (policyDigest: string) => ({ schemaVersion: 1, policyDigest, fixture: 'not live sandbox evidence' });

test('snapshot enable derives its receipt from the privileged probe, never a renderer upload', async t => {
  const proof = receipt('fixture-policy-enable');
  const h = await desktopHarness({ probeSnapshotIsolation: async () => proof }); t.after(h.cleanup);
  const session = await setupSession(h);
  h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.execPath] });
  const forged = { policyDigest: 'renderer-forged', passed: true };
  await h.invoke('enableSnapshot', session.id, forged, { executable: 'arbitrary-executable' });
  assert.equal(h.probeCalls.length, 1);
  const probe = h.probeCalls[0];
  assert.equal(probe.projectRoot, h.projectRoot);
  assert.equal(probe.protectedRoot, path.join(h.dataDir, 'engineering/snapshots'));
  assert.equal(probe.nodeExecutable, await realpath(process.execPath));
  assert.equal(probe.currentGeneration(), h.engine.connectionGeneration);
  assert.equal(probe.policy.fixture, 'not a live isolation receipt');
  assert.equal(h.fixtureRunner.snapshotSetCalls.length, 1);
  assert.equal(h.fixtureRunner.snapshotSetCalls[0].taskId, session.id);
  assert.deepEqual(structuredClone(h.fixtureRunner.snapshotSetCalls[0].profile), { id: profileId, nodeExecutable: await realpath(process.execPath), isolation: proof });
  assert.equal(h.fixtureRunner.snapshotSetCalls[0].profile.isolation, proof);
  assert.equal(h.fixtureRunner.options.snapshotPolicyDigest(h.projectRoot), proof.policyDigest);
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 0);
});

test('snapshot fixture harness fails closed rather than performing an implicit live probe', async t => {
  const h = await desktopHarness(); t.after(h.cleanup);
  const session = await setupSession(h);
  h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.execPath] });
  await assert.rejects(h.invoke('enableSnapshot', session.id, receipt('forged')), /Live snapshot isolation probe is disabled/);
  assert.equal(h.fixtureRunner.snapshotSetCalls.length, 0);
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 0);
  await h.invoke('setAcceptance', session.id, []);
});

test('a model-writable fake Node is rejected before the sandbox probe can execute it', async t => {
  const h = await desktopHarness({ probeSnapshotIsolation: async () => receipt('must-not-be-issued') }); t.after(h.cleanup);
  const session = await setupSession(h);
  const fakeNode = path.join(h.projectRoot, 'fake-node.exe'); await writeFile(fakeNode, 'not an executable');
  h.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeNode] });
  await assert.rejects(h.invoke('enableSnapshot', session.id), /Node\.js 必须位于模型工程目录之外/);
  assert.equal(h.probeCalls.length, 0);
  assert.equal(h.fixtureRunner.snapshotSetCalls.length, 0);
});

test('same snapshot key shares a deferred probe while other actions remain gated', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = await desktopHarness({ probeSnapshotIsolation: async () => { await gate; return receipt('fixture-delayed-probe'); } }); t.after(h.cleanup);
  const session = await setupSession(h);
  h.tasks.find(task => task.id === session.id)!.snapshotProfile = { id: profileId, revision: 1, nodeExecutable: process.execPath };
  const first = h.invoke('runSnapshotBuild', session.id, 'same-probe-key');
  await until(() => h.probeCalls.length === 1);
  const retry = h.invoke('runSnapshotBuild', session.id, 'same-probe-key');
  try {
    await delay(20);
    assert.equal(h.probeCalls.length, 1);
    assert.equal(h.fixtureRunner.snapshotRunCalls.length, 0);
    await assert.rejects(h.invoke('runSnapshotBuild', session.id, 'different-key'), /工程执行期间不能启动另一轮快照构建/);
    await assert.rejects(h.invoke('setAcceptance', session.id, []), /工程执行期间不能更改验收规则/);
    await assert.rejects(h.invoke('send', session.id, 'must not overlap', 'qa-model'), /同时运行一个任务/);
  } finally { release(); }
  await Promise.all([first, retry]);
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 1);
  assert.equal(h.tasks.find(task => task.id === session.id)!.operations.length, 1);
});

test('model snapshot calls enforce task and profile scope; durable keys skip new probes', async t => {
  let probes = 0;
  const h = await desktopHarness({ probeSnapshotIsolation: async () => receipt(`fixture-build-policy-${++probes}`) }); t.after(h.cleanup);
  const session = await setupSession(h);
  h.tasks.find(task => task.id === session.id)!.snapshotProfile = { id: profileId, revision: 4, nodeExecutable: process.execPath };
  await h.invoke('send', session.id, 'run approved snapshot template', 'qa-model');
  const call = (requestKey: string, profileRevision: unknown = 4, taskId = session.id) => h.bridgeInvoke('engineering.build', { taskId, profileRevision, requestKey });
  await assert.rejects(call('wrong-task', 4, 'foreign-task'), /TASK_SCOPE_MISMATCH/);
  await assert.rejects(call('old-revision', 3), /BUILD_PROFILE_REVISION_MISMATCH/);
  await assert.rejects(call('string-revision', '4'), /BUILD_PROFILE_REVISION_MISMATCH/);
  await assert.rejects(call('   '), /非空 requestKey/);
  assert.equal(h.probeCalls.length, 0);
  const first = await call('first-build') as { id: string };
  const second = await call('second-build') as { id: string };
  assert.notEqual(first.id, second.id);
  assert.equal(h.probeCalls.length, 2);
  h.engine.emit('engine/state', { state: 'failed' });
  assert.equal(h.fixtureRunner.options.snapshotPolicyDigest(h.projectRoot), '');
  await h.invoke('runSnapshotBuild', session.id, 'first-build');
  assert.equal(h.probeCalls.length, 2, 'Recorded retry must not perform a new sandbox probe or execution');
  assert.equal(h.tasks.find(task => task.id === session.id)!.operations.length, 2);
});

test('a failed snapshot probe releases its gates and retry requires a fresh receipt', async t => {
  let failed = true;
  const h = await desktopHarness({ probeSnapshotIsolation: async () => {
    if (failed) throw new Error('fixture isolation verification failed');
    return receipt('fixture-retry-policy');
  } }); t.after(h.cleanup);
  const session = await setupSession(h);
  h.tasks.find(task => task.id === session.id)!.snapshotProfile = { id: profileId, revision: 1, nodeExecutable: process.execPath };
  await assert.rejects(h.invoke('runSnapshotBuild', session.id, 'retry-after-probe-failure'), /fixture isolation verification failed/);
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 0);
  assert.equal(h.fixtureRunner.options.snapshotPolicyDigest(h.projectRoot), '');
  await h.invoke('setAcceptance', session.id, []);
  failed = false;
  await h.invoke('runSnapshotBuild', session.id, 'retry-after-probe-failure');
  assert.equal(h.probeCalls.length, 2);
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 1);
  assert.equal(h.fixtureRunner.options.snapshotPolicyDigest(h.projectRoot), 'fixture-retry-policy');
});
