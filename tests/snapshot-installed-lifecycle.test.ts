import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { ElectronApplication } from 'playwright';
import { primarySid, type DesktopIdentity } from './helpers/snapshot-smoke-scope';
import type { ElectronMainIdentity, InstalledMainProcess } from './helpers/second-user-controls';
import { prepareSnapshotInstalledLifecycle, SnapshotInstalledLifecycle, type SnapshotInstalledLifecycleObservers } from './helpers/snapshot-installed-lifecycle';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = path.join(root, 'install', 'ForgeDesk.exe');
const pause = () => new Promise(resolve => setImmediate(resolve));

function fixture(options: { noNativeExit?: boolean; nativeRemains?: boolean; launcherCode?: number; launcherSignal?: string;
  inspector?: 'pending' | 'rejected'; dispose?: 'pending' | 'rejected' } = {}) {
  const emitter = new EventEmitter(); const calls: string[] = []; let next = 0; let disposed = false;
  let native: InstalledMainProcess | null = null;
  const identity: DesktopIdentity = { sid: primarySid, account: 'HOST\\Primary', sessionId: 7, interactive: true, elevated: false,
    platformSids: [], explorerOwners: [{ sid: primarySid, sessionId: 7 }], applications: [] };
  const hooks: SnapshotInstalledLifecycleObservers = {
    exitEmitter: emitter,
    readIdentity: async () => {
      calls.push('desktop'); return { ...identity, applications: native ? [{ pid: native.id, executable: installed, sessionId: native.sessionId }] : identity.applications };
    },
    readNativeMain: async pid => { calls.push(`cim:${pid}`); return native; },
    inspectInstalled: async value => { calls.push('installed-path'); assert.equal(value, installed); },
  };
  function application() {
    next++; disposed = false;
    const main: ElectronMainIdentity = { pid: 2200 + next, execPath: installed, type: 'browser', platform: 'win32' };
    native = { id: main.pid, parentId: 1100 + next, name: 'ForgeDesk.exe', execPath: installed,
      created: `2026-10-16T04:00:0${next}.0000000Z`, sid: primarySid, sessionId: 7, ownerQueryStatus: 0 };
    const child = Object.assign(new EventEmitter(), { pid: 1100 + next, exitCode: null as number | null, signalCode: null as string | null,
      kill: () => assert.fail('This helper must never kill the product or launcher') });
    const killSet = new Set<() => void>([() => assert.fail('A retained exit hook would kill the product')]);
    const exitHandler = runInNewContext('(function exitHandler() { for (const kill of killSet) kill(); })', { killSet }) as () => void;
    emitter.on('exit', exitHandler);
    let evaluations = 0; let processCalls = 0;
    const app = {
      process: () => { assert.equal(disposed, false, 'Do not query a destroyed dispatcher'); processCalls++; return child as unknown as ChildProcess; },
      evaluate: async () => {
        evaluations++;
        if (evaluations === 1) { calls.push('main-identity'); return main; }
        calls.push('native-window-close');
        if (!options.noNativeExit) {
          if (!options.nativeRemains) native = null;
          child.exitCode = options.launcherCode ?? 0; child.signalCode = options.launcherSignal ?? null;
          child.emit('close', child.exitCode, child.signalCode);
        }
        if (options.inspector === 'pending') return new Promise(() => {});
        if (options.inspector === 'rejected') throw new Error('Inspector disconnected; password=synthetic-only');
      },
      close: async () => {
        calls.push('playwright-close'); assert.equal(native, null, 'Never dispose while the actual main is still present');
        assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
        disposed = true;
        if (options.dispose === 'pending') return new Promise(() => {});
        if (options.dispose === 'rejected') throw new Error('Dispose failed; password=synthetic-only');
        emitter.removeListener('exit', exitHandler);
      },
    } as unknown as ElectronApplication;
    return { app, main, child, exitHandler, processCalls: () => processCalls };
  }
  return { hooks, emitter, identity, calls, application, setNative: (value: InstalledMainProcess | null) => { native = value; } };
}

test('primary gate is checked before installed path inspection; alternate SID and elevated desktop are refused', async () => {
  for (const mutate of [(value: DesktopIdentity) => { value.sid = value.sid.replace(/1002$/, '1006'); },
    (value: DesktopIdentity) => { value.elevated = true; }, (value: DesktopIdentity) => { value.interactive = false; },
    (value: DesktopIdentity) => { value.explorerOwners = []; }]) {
    const f = fixture(); mutate(f.identity);
    await assert.rejects(prepareSnapshotInstalledLifecycle(root, installed, f.hooks));
    assert.deepEqual(f.calls, ['desktop']);
  }
  assert.throws(() => new SnapshotInstalledLifecycle(root, path.join(root, 'other', 'ForgeDesk.exe'), fixture().hooks), /root\/install/);
});

test('any pre-existing ForgeDesk instance blocks launch, including another installation', async () => {
  const f = fixture(); f.identity.applications.push({ pid: 10, executable: path.join(root, 'other', 'ForgeDesk.exe'), sessionId: 7 });
  await assert.rejects(prepareSnapshotInstalledLifecycle(root, installed, f.hooks), /existing ForgeDesk/);
  assert.deepEqual(f.calls, ['desktop']);
});

test('saved launcher and independently sampled actual main remain distinct; normal close precedes disposal', async () => {
  const f = fixture(); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app);
  assert.equal(lifecycle.evidence.observerKind, 'injected-fixture');
  const launch = lifecycle.evidence.launches[0];
  assert.equal(launch.launcherPid, a.child.pid); assert.notEqual(launch.launcherPid, launch.electronMain?.pid);
  assert.equal(launch.nativeMain?.id, a.main.pid); assert.equal(launch.nativeMain?.sid, primarySid);
  const closed = await lifecycle.closeNormally();
  assert.equal(closed.normalClose, true); assert.equal(closed.forcedKill, false); assert.equal(closed.exitCodeScope, 'playwright-launcher');
  assert.equal(closed.nativeElectronIdentityAbsent, true); assert.equal(closed.nativeInstalledProcessesAbsent, true);
  assert.equal(closed.playwrightCloseAfterNativeExit, true); assert.equal(a.processCalls(), 1);
  assert.ok(f.calls.indexOf('playwright-close') > f.calls.lastIndexOf(`cim:${a.main.pid}`));
});

test('the same helper supports two separately identified normal restart cycles', async () => {
  const f = fixture(); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  for (let i = 0; i < 2; i++) { await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app); await lifecycle.closeNormally(); }
  assert.equal(lifecycle.evidence.launches.length, 2);
  assert.notEqual(lifecycle.evidence.launches[0].nativeMain?.created, lifecycle.evidence.launches[1].nativeMain?.created);
  assert.ok(lifecycle.evidence.launches.every(value => value.close?.normalClose && value.close.playwrightCloseAfterNativeExit));
});

test('foreign native owner fails attachment and protects only the introduced Playwright hook', async () => {
  const f = fixture(); const baseline = () => {}; f.emitter.on('exit', baseline);
  const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  await lifecycle.beforeLaunch(); const a = f.application();
  f.setNative({ id: a.main.pid, parentId: a.child.pid, name: 'ForgeDesk.exe', execPath: installed,
    created: '2026-10-16T04:00:01Z', sid: 'S-1-5-21-1-2-3-9999', sessionId: 7, ownerQueryStatus: 0 });
  await assert.rejects(lifecycle.attach(a.app));
  const protection = lifecycle.protectOnFailure();
  assert.equal(protection.safeHarnessExit, true); assert.equal(protection.needsHumanClose, true);
  assert.equal(protection.removedCount, 1); assert.equal(protection.sourceVerified, true);
  assert.deepEqual(f.emitter.listeners('exit'), [baseline]); assert.equal(f.calls.includes('playwright-close'), false);
});

test('launcher success alone cannot dispose a still-present actual main', async () => {
  const f = fixture({ nativeRemains: true }); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app);
  await assert.rejects(lifecycle.closeNormally(), /actual Electron main/);
  assert.equal(f.calls.includes('playwright-close'), false);
  assert.equal(lifecycle.evidence.launches[0].close?.normalClose, false);
  assert.equal(lifecycle.protectOnFailure().safeHarnessExit, true);
  assert.equal(lifecycle.protectOnFailure().needsHumanClose, true);
  assert.equal(a.processCalls(), 1);
});

test('signal or nonzero launcher exit never count as normal close', async () => {
  for (const option of [{ launcherCode: 1 }, { launcherSignal: 'SIGTERM' }]) {
    const f = fixture(option); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
    await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app);
    await assert.rejects(lifecycle.closeNormally(), /launcher|signalled/);
    assert.equal(f.calls.includes('playwright-close'), false); assert.equal(lifecycle.evidence.launches[0].close?.normalClose, false);
  }
});

test('the original 30-second launcher-close deadline remains bounded without kill or disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ noNativeExit: true }); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app);
  const failure = assert.rejects(lifecycle.closeNormally(), /within 30 seconds/); await pause();
  await assert.rejects(lifecycle.closeNormally(), /cached launcher/);
  assert.equal(f.calls.filter(call => call === 'native-window-close').length, 1);
  t.mock.timers.tick(30001); await failure;
  assert.equal(f.calls.includes('playwright-close'), false); assert.equal(lifecycle.evidence.launches[0].close?.forcedKill, false);
  assert.equal(lifecycle.protectOnFailure().needsHumanClose, true);
});

test('native absence does not manufacture inspector acknowledgement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ inspector: 'pending' }); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app);
  const failure = assert.rejects(lifecycle.closeNormally(), /acknowledgement is unconfirmed/); await pause(); t.mock.timers.tick(5001); await failure;
  assert.equal(lifecycle.evidence.launches[0].close?.closeRequest?.state, 'timed-out');
  assert.equal(lifecycle.evidence.launches[0].close?.normalClose, false); assert.equal(f.calls.includes('playwright-close'), false);
});

test('inspector disconnection is retained and redacted after independently confirmed normal exit', async () => {
  const f = fixture({ inspector: 'rejected' }); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app);
  const result = await lifecycle.closeNormally(); assert.equal(result.normalClose, true); assert.equal(result.closeRequest?.state, 'rejected');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-only/);
});

test('dispose failure does not requery a destroyed dispatcher or claim normal close', async () => {
  const f = fixture({ dispose: 'rejected' }); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks);
  await lifecycle.beforeLaunch(); const a = f.application(); await lifecycle.attach(a.app);
  await assert.rejects(lifecycle.closeNormally(), /Dispose failed/);
  const close = lifecycle.evidence.launches[0].close!;
  assert.equal(close.normalClose, false); assert.equal(close.nativeInstalledProcessesAbsent, true); assert.equal(a.processCalls(), 1);
  assert.doesNotMatch(JSON.stringify(lifecycle.evidence), /synthetic-only/);
});

test('launch failure without an introduced hook never claims a handler was detached', async () => {
  const f = fixture(); const baseline = () => {}; f.emitter.on('exit', baseline);
  const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks); await lifecycle.beforeLaunch();
  const result = lifecycle.protectOnFailure();
  assert.equal(result.safeHarnessExit, true); assert.equal(result.noNewExitHandlerObserved, true);
  assert.equal(result.removedCount, 0); assert.equal(result.sourceVerified, false); assert.equal(result.needsHumanClose, true);
  assert.deepEqual(f.emitter.listeners('exit'), [baseline]);
  await assert.rejects(lifecycle.beforeLaunch(), /held or unconfirmed/);
});

test('unknown exitHandler implementation is not removed and cannot authorize harness exit', async () => {
  const f = fixture(); const lifecycle = await prepareSnapshotInstalledLifecycle(root, installed, f.hooks); await lifecycle.beforeLaunch();
  function exitHandler() { throw new Error('Not the verified Playwright implementation'); }
  f.emitter.on('exit', exitHandler);
  const result = lifecycle.protectOnFailure(); assert.equal(result.status, 'failed'); assert.equal(result.safeHarnessExit, false);
  assert.equal(result.removedCount, 0); assert.deepEqual(f.emitter.listeners('exit'), [exitHandler]);
});
