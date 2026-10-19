import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import path from 'node:path';
import { Fz3bAgentMain, type Fz3bAgentMainOptions } from '../apps/desktop/main/fz3b-agent';
import { Fz3bHostFinalizationStore, type HostFinalizationStage } from '../apps/desktop/main/host-finalization-store';
import { DesktopStore } from '../apps/desktop/main/store';
import { Fz3bBackend } from '../packages/engineering-runner/fz3b/backend';
import { fz3bHostProductionFixture } from './helpers/fz3b-host-production-fixture';

const sid = 'S-1-5-21-1-2-3-1001';
type Fixture = Awaited<ReturnType<typeof fz3bHostProductionFixture>>;
function mainFor(f: Fixture, options: { store?: DesktopStore; backend?: Fz3bBackend; fault?: HostFinalizationStage } = {}) {
  const store = options.store ?? f.store, backend = options.backend ?? f.backend, holds = new Set<string>();
  const state = { releases: 0, engineCreates: 0, saves: 0, ownerValid: true, signing: 0 };
  let main!: Fz3bAgentMain;
  const host = new Fz3bHostFinalizationStore(store, backend, binding => main.assertSynchronousHostCommitOwner(binding.owner), sid, { onStage: stage => {
    if (stage === 'signing') state.signing++;
    if (stage === options.fault) throw new Error(`Synthetic ${stage} failure`);
  }, privateAcl: () => {}, privateAclBatch: () => {}, dependencyAcl: () => {} });
  const configuration: Fz3bAgentMainOptions = { backend, hostFinalization: host,
    createEngine: () => { state.engineCreates++; throw new Error('No model/engine may launch in a host completion test'); },
    getSession: taskId => { const session = store.sessions.find(item => item.taskId === taskId); assert.ok(session); return session; },
    assertCanStart() { throw new Error('No new model task'); }, assertBeforeClaim() { throw new Error('No new model task'); },
    enterControlledMode: async () => {}, assertGlobalOwner() { throw new Error('No ordinary model owner'); },
    assertGlobalRecoveryOwner: () => { assert.equal(state.ownerValid, true); assert.equal(holds.size, 1); },
    assertHostCommitOwner: () => { assert.equal(state.ownerValid, true); assert.equal(holds.size, 1); },
    checkRuntime: async () => {}, readAccount: async () => { throw new Error('No account query'); }, setAccount() {},
    hold: taskId => { holds.add(taskId); }, release: taskId => { holds.delete(taskId); state.releases++; },
    save: () => { state.saves++; store.save(); }, publish() {}, log() {}, onEvent() {}, redact: value => value,
  };
  main = new Fz3bAgentMain(configuration); return { main, state, store, backend, host, holds };
}

test('first explicit host finish saves/signs once; a new main authenticates certificate without a save or replay', async () => {
  const f = await fz3bHostProductionFixture(), original = fs.readFileSync(f.ledgerPath), first = mainFor(f);
  await first.main.recoverStartup(); await first.main.restoreCertifiedHostCompletion();
  assert.equal(first.main.held, true); assert.equal(first.state.signing, 0);
  await first.main.reconcilePreflightRefusedInspect(f.owner.runId);
  assert.equal(first.main.held, false); assert.equal(first.state.releases, 1); assert.equal(first.state.signing, 1); assert.equal(first.state.saves, 0);
  const restarted = mainFor(f, { store: new DesktopStore(f.home), backend: new Fz3bBackend(f.options) });
  await restarted.main.recoverStartup(); assert.equal(restarted.main.held, true);
  await restarted.main.restoreCertifiedHostCompletion();
  assert.equal(restarted.main.held, false); assert.equal(restarted.state.releases, 1); assert.equal(restarted.state.signing, 0); assert.equal(restarted.state.saves, 0);
  assert.equal(restarted.state.engineCreates, 0); assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
  assert.deepEqual(fs.readFileSync(f.ledgerPath), original);
});

for (const fault of ['desktop-written', 'desktop-renamed', 'desktop-readback'] as const) {
  test(`main ${fault} failure holds the current and new owner without any certificate`, async () => {
    const f = await fz3bHostProductionFixture(), failed = mainFor(f, { fault });
    await failed.main.recoverStartup();
    await assert.rejects(failed.main.reconcilePreflightRefusedInspect(f.owner.runId), /Synthetic/);
    assert.equal(failed.main.held, true); assert.equal(failed.state.releases, 0); assert.equal(failed.state.signing, 0);
    const restarted = mainFor(f, { store: new DesktopStore(f.home), backend: new Fz3bBackend(f.options) });
    await restarted.main.recoverStartup(); await restarted.main.restoreCertifiedHostCompletion();
    assert.equal(restarted.main.held, true); assert.equal(restarted.state.releases, 0); assert.equal(restarted.state.signing, 0);
    await assert.rejects(restarted.main.stop(f.owner.runId), /HOST_FINISH_REQUIRED/);
    await assert.rejects(restarted.main.recover(f.owner.taskId), /HOST_FINISH_REQUIRED/);
    assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
  });
}

test('certificate publication failure holds current owner; new main verifies only the already-successful upstream save', async () => {
  const f = await fz3bHostProductionFixture(), failed = mainFor(f, { fault: 'certificate-written' });
  await failed.main.recoverStartup(); await assert.rejects(failed.main.reconcilePreflightRefusedInspect(f.owner.runId), /Synthetic/);
  assert.equal(failed.main.held, true); assert.equal(failed.state.releases, 0); assert.equal(failed.state.signing, 1);
  const restarted = mainFor(f, { store: new DesktopStore(f.home), backend: new Fz3bBackend(f.options) });
  await restarted.main.recoverStartup(); await restarted.main.restoreCertifiedHostCompletion();
  assert.equal(restarted.main.held, false); assert.equal(restarted.state.releases, 1); assert.equal(restarted.state.signing, 0);
  assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
});

test('startup certificate cannot override changed owner, target history or backend source', async () => {
  for (const mode of ['owner', 'history', 'backend'] as const) {
    const f = await fz3bHostProductionFixture(), first = mainFor(f); await first.main.recoverStartup(); await first.main.reconcilePreflightRefusedInspect(f.owner.runId);
    const restarted = mainFor(f, { store: new DesktopStore(f.home), backend: new Fz3bBackend(f.options) }); await restarted.main.recoverStartup();
    if (mode === 'owner') restarted.state.ownerValid = false;
    if (mode === 'history') { restarted.store.sessions[0].messages.push({ id: 'changed', role: 'user', text: 'Changed target history', timestamp: '2026-10-17T12:00:00.000Z' }); restarted.store.save(); }
    if (mode === 'backend') fs.appendFileSync(f.ledgerPath, '\n');
    await restarted.main.restoreCertifiedHostCompletion(); assert.equal(restarted.main.held, true); assert.equal(restarted.state.releases, 0); assert.equal(restarted.state.signing, 0);
    if (mode !== 'owner') await assert.rejects(restarted.main.reconcilePreflightRefusedInspect(f.owner.runId));
    assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
  }
});

test('production main wiring restores certificates only after actual engine construction and before IPC activation', () => {
  const source = fs.readFileSync(path.resolve('apps/desktop/main/index.ts'), 'utf8');
  const engine = source.indexOf('engine = new CodexAdapter'), restore = source.indexOf('await fz3bAgent?.restoreCertifiedHostCompletion()'), ipc = source.indexOf("ipcMain.handle('forgedesk:invoke'");
  assert.ok(engine >= 0 && engine < restore && restore < ipc);
  assert.ok(source.includes('const hostSid = await currentSid();'));
  assert.ok(source.includes('const hostFinalization = createFz3bHostFinalizationStore(store, backend, binding => fz3bAgent!.assertSynchronousHostCommitOwner(binding.owner), hostSid);'));
  const compositionStart = source.indexOf('try { composeIncidentFailedIntentRecovery(');
  const compositionEnd = source.indexOf('fz3bAgent = new Fz3bAgentMain', compositionStart);
  assert.ok(compositionStart >= 0 && compositionEnd > compositionStart);
  const composition = source.slice(compositionStart, compositionEnd);
  assert.ok(composition.includes('root: dataDir, sid: hostSid, packaged: app.isPackaged, resourcesPath: process.resourcesPath, store: hostFinalization'));
  assert.ok(composition.includes("fz3bHostActionRunId !== '07427a29-0eae-44c7-ac35-34d6650eebee'"));
  assert.ok(composition.includes('protectedTasks.size !== 1'));
  assert.ok(composition.includes('assertRunnerLifecycleOwner(dataDir);'));
  const hostSource = fs.readFileSync(path.resolve('apps/desktop/main/host-finalization-store.ts'), 'utf8');
  assert.ok(hostSource.includes('const recovery = this.#failedIntentRecovery ?? configuredFailedEmptyIntentRecovery();'));
  assert.ok(hostSource.includes('validateFailedEmptyIntentIsolation(recovery, { completion: binding, targetSha256 });'));
  assert.match(hostSource, /else if \(failedNamespace\.length \|\| incidentFailedIntentRequired\(this\.#root, binding\.owner\.runId\)\) \{\s*fail\('FAILED_INTENT_NATIVE_GATE_REQUIRED'\);/);
  assert.doesNotMatch(source, /async fz3bSign|saved:\s*true|commit\(binding\)/);
});
