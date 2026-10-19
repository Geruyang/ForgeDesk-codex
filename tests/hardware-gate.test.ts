import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AppSnapshot } from '../packages/shared/contracts';
import { ENGINEERING_TOOLS, handleMcpMessage } from '../packages/engineering-mcp';
import { EngineeringRunner } from '../packages/engineering-runner';
import { createProfile, profileConfiguration, SNAPSHOT_PROFILE_ID } from '../packages/engineering-runner/snapshots';
import { desktopHarness, root, setupSession } from './helpers/desktop-harness';

const deviceCalls = [
  { name: 'device.bind', args: { profileId: 'software', deviceIdentityId: 'offline-fixture-no-device' } },
  { name: 'device.flash', args: { artifactId: 'offline-artifact', deviceBindingId: 'offline-binding', requestKey: 'offline-no-flash' } },
  { name: 'device.verify', args: { verifierId: 'offline-verifier', deviceBindingId: 'offline-binding' } },
];

test('actual main source publishes hardware disabled and exposes no renderer hardware-enable or flash IPC', async t => {
  const h = await desktopHarness(); t.after(h.cleanup);
  const state = await h.snapshot(); assert.equal(state.hardware.enabled, false); assert.ok(state.hardware.reason);
  const contractFlag: AppSnapshot['hardware']['enabled'] = false; assert.equal(contractFlag, false);
  // @ts-expect-error The public contract cannot represent enabled product hardware in this release.
  const invalidFlag: AppSnapshot['hardware']['enabled'] = true; void invalidFlag;
  (state.hardware as { enabled: boolean }).enabled = true;
  assert.equal((await h.snapshot()).hardware.enabled, false, 'Renderer-side snapshot mutation cannot authorize hardware');
  for (const method of ['enableHardware', 'device.bind', 'device.flash', 'device.verify']) {
    await assert.rejects(h.invoke(method, { authorized: true, confirmed: true }), /不支持的 IPC 请求/);
  }
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 0); assert.equal(h.probeCalls.length, 0);
});

test('actual main bridge denies all device tools even with an active task and caller-supplied authorization claims', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const s = await setupSession(h);
  await h.invoke('send', s.id, 'Offline mocked turn; no real model or hardware');
  let attemptedExecution = 0;
  h.fixtureRunner.run = async () => { attemptedExecution++; throw new Error('Hardware gate must reject before runner execution'); };
  for (const call of deviceCalls) {
    await assert.rejects(h.bridgeInvoke(call.name, { ...call.args, ...(call.name === 'device.bind' ? {} : { taskId: s.taskId }) }), /HARDWARE_NOT_ENABLED/);
    await assert.rejects(h.bridgeInvoke(call.name, { ...call.args, taskId: s.taskId, hardwareEnabled: true, authorized: true, confirmed: true }), /HARDWARE_NOT_ENABLED/);
  }
  const inspected = await h.bridgeInvoke('engineering.inspect', { projectId: s.projectId, profileId: 'software' }) as { hardwareEnabled: boolean };
  assert.equal(inspected.hardwareEnabled, false); assert.equal(attemptedExecution, 0);
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 0); assert.equal(h.probeCalls.length, 0);
  assert.deepEqual(h.tasks[0].operations, []); assert.deepEqual(h.tasks[0].evidence, []);
});

test('device rejection retains main task-scope admission and software build approval gates', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const s = await setupSession(h);
  await assert.rejects(h.bridgeInvoke('device.flash', { taskId: s.taskId }), /NO_UNIQUE_ACTIVE_TASK/);
  await h.invoke('send', s.id, 'Offline mocked turn');
  await assert.rejects(h.bridgeInvoke('device.flash', { taskId: 'foreign-task' }), /TASK_SCOPE_MISMATCH/);
  await assert.rejects(h.bridgeInvoke('engineering.build', { taskId: s.taskId, profileRevision: 1, requestKey: 'offline-no-approved-profile' }), /NO_APPROVED_BUILD_PROFILE/);
  assert.equal(h.fixtureRunner.snapshotRunCalls.length, 0); assert.equal(h.probeCalls.length, 0);
});

test('real MCP protocol handler reports advertised device calls as errors after actual main-source policy rejection', async t => {
  const h = await desktopHarness(); t.after(h.cleanup); const s = await setupSession(h); await h.invoke('send', s.id, 'Offline mocked turn');
  assert.deepEqual(ENGINEERING_TOOLS.filter(tool => tool.name.startsWith('device.')).map(tool => tool.name), deviceCalls.map(call => call.name));
  const hostErrors: string[] = [];
  for (const [id, call] of deviceCalls.entries()) {
    const result: any = await handleMcpMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: call.name,
      arguments: { ...call.args, ...(call.name === 'device.bind' ? {} : { taskId: s.taskId }) } } }, async (name, args) => {
      try { return await h.bridgeInvoke(name, args); }
      catch (error) { hostErrors.push((error as Error).message); throw new Error('RUNNER_ERROR'); } // The real bridge also masks handler exceptions.
    });
    assert.equal(result.id, id); assert.equal(result.result.isError, true); assert.equal(result.result.content[0].text, 'RUNNER_ERROR');
  }
  assert.deepEqual(hostErrors, ['HARDWARE_NOT_ENABLED', 'HARDWARE_NOT_ENABLED', 'HARDWARE_NOT_ENABLED']);
});

test('real MCP schemas reject fabricated approval flags, arbitrary port identity and unregistered device methods before dispatch', async () => {
  let dispatched = 0;
  for (const params of [
    { name: 'device.flash', arguments: { taskId: 'task', artifactId: 'artifact', deviceBindingId: 'binding', requestKey: 'request', confirmed: true } },
    { name: 'device.bind', arguments: { profileId: 'software', portName: 'offline-not-a-real-port' } },
    { name: 'device.verify', arguments: { taskId: 'task', verifierId: 'check' } },
    { name: 'device.read_flash', arguments: {} },
  ]) {
    const result: any = await handleMcpMessage({ jsonrpc: '2.0', id: 0, method: 'tools/call', params }, async () => { dispatched++; return {}; });
    assert.equal(result.error.code, -32602);
  }
  assert.equal(dispatched, 0);
});

test('real runner rejects hardware operation kinds before command access or execution', async t => {
  const parent = path.join(root, 'tests/.tmp'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, 'hardware-gate-')); const runner = new EngineeringRunner({ dataDir: directory });
  t.after(async () => { await runner.close(); assert.equal(path.dirname(directory), parent); await rm(directory, { recursive: true, force: true }); });
  for (const kind of ['flash', 'verify', 'device.bind', 'device.flash', 'device.verify', 'read_flash']) {
    let commandRead = false;
    await assert.rejects(runner.run({ taskId: 'unregistered-offline-task', requestKey: `reject-${kind}`, kind: kind as 'build',
      get command(): never { commandRead = true; throw new Error('A rejected hardware request must never access a command'); } }), /Unsupported operation kind; device operations are unavailable/);
    assert.equal(commandRead, false);
  }
  assert.deepEqual(await runner.listTasks(), []);
});

test('real snapshot profile admission remains fixed Node software and rejects hardware profiles before filesystem or tool access', async () => {
  assert.equal(SNAPSHOT_PROFILE_ID, 'forgedesk.node-software.v1');
  const inaccessible: any = new Proxy({}, { get() { throw new Error('Unsupported profile reached filesystem/tool configuration'); } });
  for (const id of ['forgedesk.hardware.v1', 'stm32.flash', 'forgedesk.node-software.v1-flash']) {
    await assert.rejects(createProfile({ id } as any, inaccessible, 'offline-unused', inaccessible), /Only the packaged trusted Node software snapshot template/);
    await assert.rejects(profileConfiguration({ id } as any, inaccessible, 'offline-unused', inaccessible), /Snapshot profile\/sandbox is unavailable/);
  }
});
