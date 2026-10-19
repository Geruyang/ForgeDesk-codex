import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EmbeddedService } from '../packages/engineering-runner/embedded';
import type { EmbeddedGrantPreview, EmbeddedOptions, EmbeddedStatus } from '../packages/engineering-runner/embedded/types';
import { desktopHarness, setupSession } from './helpers/desktop-harness';

// Only the real main source/IPC handler is under test. Runtime validation, service and dialog are explicit fixtures.
class FixtureEmbedded extends EmbeddedService {
  calls: string[] = []; writes = 0; idle = true;
  grantLifetimeMs = 300000;
  value: EmbeddedStatus = { configured: false, taskId: '', profileId: 'fixture', profileSha256: 'a'.repeat(64), limitation: 'Not real hardware', hardwareAvailable: false, operations: [] };
  constructor(options: EmbeddedOptions) { super(options); }
  override async recover() { this.calls.push('recover'); }
  override async assertIdle() { this.calls.push('idle'); if (!this.idle) throw new Error('Fixture hardware still held'); }
  override async revokeGrants() { this.calls.push('revoke'); this.value.grant = undefined; }
  override async status(taskId: string) { this.value.taskId = taskId; return structuredClone(this.value); }
  override async configure(taskId: string, projectRoot: string) { this.calls.push('configure'); this.value.configured = true; this.value.projectRoot = projectRoot; return this.status(taskId); }
  override async prepareGrant(taskId: string): Promise<EmbeddedGrantPreview> {
    this.calls.push('prepare'); const grant: EmbeddedGrantPreview = { id: 'fixture-challenge', taskId, artifactId: 'fixture-artifact', hexSha256: 'b'.repeat(64), axfSha256: 'c'.repeat(64), backupSha256: 'f'.repeat(64), buildId: 'd'.repeat(64), sourceSha256: 'e'.repeat(64), profileId: 'fixture', profileSha256: 'a'.repeat(64),
      identity: { probeSerial: 'TEST', uid: '00', chipId: 0x419, flashKiB: 1024, cdcSerial: 'TEST' }, scope: 'flash-and-verify-once', expiresAt: new Date(Date.now() + this.grantLifetimeMs).toISOString() };
    this.value.grant = grant; return structuredClone(grant);
  }
  override async approveGrant(taskId: string, id: string) { this.calls.push('approve'); assert.equal(id, this.value.grant!.id); this.value.grant!.approvedAt = new Date().toISOString(); return this.status(taskId); }
  override async flash(taskId: string, key: string) {
    this.calls.push('flash');
    if (!this.value.operations.some(item => item.requestKey === key)) { this.writes++; this.value.operations.push({ id: 'fixture-flash', requestKey: key, kind: 'flash', status: 'succeeded', processExited: true, nonce: 'f'.repeat(32), argsDigest: '1'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); }
    return this.status(taskId);
  }
  override async close() { this.calls.push('close'); }
}
async function fixture(initialHardwareMode?: unknown) {
  let service: FixtureEmbedded | undefined;
  const h = await desktopHarness({ initialHardwareMode, verifyHardwareRuntime: async () => {}, embeddedFactory: input => service = new FixtureEmbedded(input) });
  return { h, service: service! };
}
test('real main configure persists controlled mode before stop; model entry is rejected without engine calls', async () => {
  const { h, service } = await fixture();
  try {
    const session = await setupSession(h); const starts = h.engine.startCalls; const sends = h.engine.sendCalls;
    let release!: () => void; h.engine.stopBehavior = () => new Promise<void>(resolve => { release = resolve; });
    const configuring = h.invoke('hardwareConfigure', session.taskId); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.engine.state, 'stopping'); assert.equal((await h.snapshot()).hardware.modeActive, true);
    assert.equal(JSON.parse(await readFile(path.join(h.dataDir, 'hardware-mode.json'), 'utf8')).active, true);
    await assert.rejects(h.invoke('connect'), /HARDWARE_CONTROLLED_MODE/); await assert.rejects(h.invoke('send', session.id, 'must not run'), /HARDWARE_CONTROLLED_MODE/);
    assert.equal(h.engine.startCalls, starts); assert.equal(h.engine.sendCalls, sends); assert.equal(service.calls.includes('configure'), false);
    release(); await configuring; assert.equal(h.engine.state, 'stopped'); assert.equal(service.calls.includes('configure'), true);
    const before = (await h.snapshot()).sessions; await assert.rejects(h.invoke('send', session.id, 'still blocked'), /HARDWARE_CONTROLLED_MODE/); assert.deepEqual((await h.snapshot()).sessions, before);
  } finally { await h.cleanup(); }
});
test('real main bootstrap honors a previously persisted controlled-mode record without engine start', async () => {
  const { h } = await fixture({ schemaVersion: 1, active: true, updatedAt: new Date().toISOString() });
  try { assert.equal((await h.snapshot()).hardware.modeActive, true); assert.equal(h.engine.startCalls, 0); assert.equal(h.engine.state, 'stopped'); await assert.rejects(h.invoke('connect'), /HARDWARE_CONTROLLED_MODE/); assert.equal(h.engine.startCalls, 0); }
  finally { await h.cleanup(); }
});
test('real main connect already awaiting account does not continue to models after configure stops engine', async () => {
  const { h } = await fixture();
  try {
    const session = await setupSession(h); let release!: () => void;
    h.engine.accountBehavior = () => new Promise(resolve => { release = () => resolve({ account: { type: 'chatgpt', email: 'qa@example.invalid' } }); });
    const accounts = h.engine.accountCalls; const models = h.engine.modelsCalls;
    const reconnecting = h.invoke('connect');
    for (let attempt = 0; attempt < 100 && h.engine.accountCalls === accounts; attempt++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(h.engine.accountCalls, accounts + 1); await h.invoke('hardwareConfigure', session.taskId);
    assert.equal(h.engine.state, 'stopped'); release(); await reconnecting;
    assert.equal(h.engine.modelsCalls, models, 'An old connect must not continue model discovery after controlled mode begins');
    assert.equal((await h.snapshot()).hardware.modeActive, true);
  } finally { await h.cleanup(); }
});
test('default VM runtime boundary does not silently approve unpinned hardware resources', async () => {
  const h = await desktopHarness();
  try { const session = await setupSession(h); await assert.rejects(h.invoke('hardwareConfigure', session.taskId), /manifest.*not pinned/i); assert.equal((await h.snapshot()).hardware.modeActive, false); assert.equal(h.engine.stopCalls, 0); }
  finally { await h.cleanup(); }
});
test('real main cancel or unchecked native response revokes grant and never calls flash', async () => {
  for (const answer of [{ response: 0, checkboxChecked: false }, { response: 1, checkboxChecked: false }]) {
    const { h, service } = await fixture();
    try {
      const session = await setupSession(h); await h.invoke('hardwareConfigure', session.taskId); let dialogs = 0;
      h.dialog.showMessageBox = (async (...args: unknown[]) => { dialogs++; const options = args[1] as Record<string, any>; assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.checkboxChecked, false); return answer; }) as typeof h.dialog.showMessageBox;
      const result = await h.invoke('hardwareFlash', session.taskId, 'cancelled'); assert.equal(dialogs, 1); assert.equal(service.writes, 0); assert.equal(service.calls.includes('flash'), false); assert.equal(service.calls.includes('approve'), false); assert.equal(result.grant, undefined);
    } finally { await h.cleanup(); }
  }
});
test('real main serializes native authorization and completed flash key retry bypasses dialog and new write', async () => {
  const { h, service } = await fixture();
  try {
    const session = await setupSession(h); await h.invoke('hardwareConfigure', session.taskId); let dialogs = 0; let accept!: () => void;
    h.dialog.showMessageBox = (async () => { dialogs++; await new Promise<void>(resolve => { accept = resolve; }); return { response: 1, checkboxChecked: true }; }) as typeof h.dialog.showMessageBox;
    const first = h.invoke('hardwareFlash', session.taskId, 'one-intent'); await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(dialogs, 1); await assert.rejects(h.invoke('hardwareFlash', session.taskId, 'one-intent'), /另一个任务/); assert.equal(dialogs, 1); assert.equal(service.writes, 0);
    accept(); const completed = await first; const repeat = await h.invoke('hardwareFlash', session.taskId, 'one-intent');
    assert.equal(dialogs, 1); assert.equal(service.writes, 1); assert.deepEqual(repeat.operations, completed.operations); assert.equal(service.calls.filter(item => item === 'prepare').length, 1);
  } finally { await h.cleanup(); }
});
test('real main expires a pending native grant by aborting its dialog, never approving or flashing', async () => {
  const { h, service } = await fixture();
  try {
    const session = await setupSession(h); await h.invoke('hardwareConfigure', session.taskId); service.grantLifetimeMs = 30; let aborted = 0;
    h.dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args[1] as { signal?: AbortSignal }; assert.ok(options.signal, 'Native dialog must receive the cancellation-only AbortSignal');
      return new Promise(resolve => { const cancel = () => { aborted++; resolve({ response: 0 }); }; if (options.signal!.aborted) cancel(); else options.signal!.addEventListener('abort', cancel, { once: true }); });
    }) as typeof h.dialog.showMessageBox;
    await assert.rejects(h.invoke('hardwareFlash', session.taskId, 'expired-dialog'), /过期|expired/i);
    assert.equal(aborted, 1); assert.equal(service.writes, 0); assert.equal(service.calls.includes('approve'), false); assert.equal(service.calls.includes('flash'), false); assert.equal(service.value.grant, undefined);
  } finally { await h.cleanup(); }
});
test('real main leave mode refuses held fixture and revokes all grants before reconnect when idle', async () => {
  const { h, service } = await fixture();
  try {
    const session = await setupSession(h); await h.invoke('hardwareConfigure', session.taskId); service.idle = false; const starts = h.engine.startCalls;
    await assert.rejects(h.invoke('hardwareLeaveMode'), /held/); assert.equal((await h.snapshot()).hardware.modeActive, true); assert.equal(h.engine.startCalls, starts);
    service.idle = true; await h.invoke('hardwareLeaveMode'); assert.equal((await h.snapshot()).hardware.modeActive, false); assert.equal(h.engine.startCalls, starts + 1); assert.equal(service.calls.at(-1), 'revoke');
  } finally { await h.cleanup(); }
});
