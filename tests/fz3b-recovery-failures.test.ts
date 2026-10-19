import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { Fz3bBackend, type Fz3bBackendOptions } from '../packages/engineering-runner/fz3b/backend';
import { FZ3B_PROFILE, fz3bProfileSha256 } from '../packages/engineering-runner/fz3b/profile';
import type { Fz3bBinding, Fz3bInspectReconciliationContext, Fz3bMaintenanceExitSeal, Fz3bRunView, Fz3bSemanticFixture } from '../packages/engineering-runner/fz3b/types';
import { desktopHarness, setupSession } from './helpers/desktop-harness';

const fixture: Fz3bSemanticFixture = { id: 'fz3b-pillow-scene-v1', manifestSha256: FZ3B_PROFILE.semanticManifestSha256,
  queriesSha256: FZ3B_PROFILE.queriesSha256, imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256,
  width: 914, height: 512, queryCount: 4, embeddingDimensions: 512, expectedLabel: 'pillow',
  queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: { ...FZ3B_PROFILE.encoderIdentity } };

// These are main/IPC error fixtures, not authenticated backend or remote-proof receipts.
function fixtureBackend(options: Fz3bBackendOptions) {
  const backend = new Fz3bBackend(options);
  let run!: Fz3bRunView, localClosed = true, seals = 0, probes = 0;
  let afterRelease: () => void = () => {};
  backend.start = async (binding: Fz3bBinding) => {
    run = { ...binding, schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: fz3bProfileSha256(fixture),
      status: 'active', phase: 'ready', active: true, hardwareBusy: true, stopRequested: false, nativeApproval: 'not_requested',
      createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', calls: [],
      operations: [{ id: 'inspect-fixture', nonce: 'a'.repeat(64), requestKey: 'inspect-fixture', kind: 'inspect', status: 'unknown',
        dispatchPhase: 'may-have-started', processExited: true, remoteQuiescent: false, evidenceSha256: 'b'.repeat(64),
        createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' }] };
    return structuredClone(run);
  };
  backend.list = async () => run ? [structuredClone(run)] : [];
  backend.status = async id => !id || run?.runId === id ? structuredClone(run) : undefined;
  backend.recover = async () => {};
  backend.stop = async () => {
    run.active = false; run.stopRequested = true; run.status = 'needs_attention'; run.phase = 'needs_attention';
    return structuredClone(run);
  };
  backend.turnEnded = async () => { run.active = false; return structuredClone(run); };
  backend.quiescence = async id => ({ runId: id, taskId: run.taskId, sessionId: run.sessionId, active: run.active,
    stopRequested: run.stopRequested, starting: false, inflight: false, nativePending: false, persistencePending: false,
    hardwareBusy: run.hardwareBusy, quiescent: !run.active && !run.hardwareBusy });
  backend.recoveryActions = async () => ({ reconcileInspect: true, maintenanceExit: localClosed, exportEvidence: localClosed });
  backend.export = async () => ({ path: 'offline-unknown-export', sha256: 'c'.repeat(64) });
  backend.prepareMaintenanceExit = async (): Promise<Fz3bMaintenanceExitSeal> => {
    await options.assertRecoveryOwner!(run);
    if (!localClosed) throw new Error('Fixture original local close is no longer confirmed');
    seals++;
    return { schemaVersion: 1, runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, profileSha256: run.profileSha256,
      createdAt: new Date().toISOString(), unknownPreserved: true, localProcessesClosed: true, operationSnapshotSha256: 'd'.repeat(64),
      processState: { closed: true, liveChildren: 0, operations: [{ operationId: 'inspect-fixture', nonce: 'a'.repeat(64), closeConfirmed: true, evidenceSha256: 'e'.repeat(64) }] },
      sealSha256: 'f'.repeat(64) };
  };
  backend.reconcileInspect = async () => {
    await options.assertRecoveryOwner!(run);
    if (!run.hardwareBusy) return structuredClone(run);
    const context: Fz3bInspectReconciliationContext = { schemaVersion: 1, id: 'new-readonly-fixture', nonce: 'c'.repeat(64), createdAt: new Date().toISOString(),
      original: { runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, operationId: run.operations[0].id,
        requestKey: run.operations[0].requestKey, nonce: run.operations[0].nonce, profileSha256: run.profileSha256, fixture },
      originalEvidenceSha256: 'b'.repeat(64), originalOperationSha256: 'd'.repeat(64), ownerBindingSha256: 'e'.repeat(64) };
    if (!await options.requestInspectReconciliation!(context, new AbortController().signal)) throw new Error('Fixture native readonly confirmation refused');
    await options.assertRecoveryOwner!(run); probes++; run.hardwareBusy = false; afterRelease();
    return structuredClone(run);
  };
  return { backend, get run() { return run; }, get seals() { return seals; }, get probes() { return probes; },
    set localClosed(value: boolean) { localClosed = value; }, set afterRelease(value: () => void) { afterRelease = value; } };
}

async function setup() {
  let state!: ReturnType<typeof fixtureBackend>;
  const h = await desktopHarness({ fixtureRoot: path.resolve('output/qa/2026-10-16-fz3b-051/fixtures'),
    fz3bFixture: fixture, allowFz3bEngine: true, fz3bFactory: options => { state = fixtureBackend(options); return state.backend; } });
  const session = await setupSession(h);
  const run = await h.invoke('fz3bAgentStart', session.taskId, 'Offline recovery fixture only', 'gpt-6.1-sol');
  await h.invoke('fz3bAgentStop', run.runId);
  return { h, session, state, runId: run.runId as string };
}

test('maintenance re-seals local closure after a checked native wait and refuses facts that changed during the wait', async () => {
  const { h, state, runId } = await setup();
  try {
    const original = structuredClone(state.run.operations);
    h.dialog.showMessageBox = async () => { state.localClosed = false; return { response: 1, checkboxChecked: true }; };
    await assert.rejects(h.invoke('fz3bMaintenanceExit', runId), /local close is no longer confirmed/);
    assert.equal(state.seals, 1); assert.equal(h.window.destroyed, false); assert.equal(h.closed().quit, false);
    assert.equal(state.run.hardwareBusy, true); assert.deepEqual(state.run.operations, original);
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, runId);
    await assert.rejects(h.invoke('connect'), /HARDWARE_AGENT_ACTIVE/);
  } finally { await h.cleanup(); }
});

test('embedded or runner shutdown failure cannot turn maintenance consent into quit or an unknown-state release', async () => {
  for (const component of ['embedded', 'runner'] as const) {
    const { h, state, runId } = await setup();
    const target = component === 'embedded' ? h.embedded : h.fixtureRunner;
    const close = target.close.bind(target);
    try {
      const original = structuredClone(state.run.operations);
      h.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true });
      target.close = async () => { throw new Error(`Fixture ${component} shutdown failed`); };
      await assert.rejects(h.invoke('fz3bMaintenanceExit', runId), /shutdown failed/);
      assert.equal(h.window.destroyed, false); assert.equal(h.closed().quit, false);
      assert.equal(state.run.hardwareBusy, true); assert.deepEqual(state.run.operations, original);
      assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, runId);
      assert.equal(state.probes, 0); assert.equal(h.fz3bEngine!.sendCalls, 1);
      await assert.rejects(h.invoke('connect'), /HARDWARE_AGENT_ACTIVE/);
    } finally { target.close = close; await h.cleanup(); }
  }
});

test('failed evidence copy releases only its local host-action guard, not the remote unknown hold', async () => {
  const { h, state, session, runId } = await setup();
  try {
    const original = structuredClone(state.run.operations); let exports = 0;
    state.backend.export = async () => {
      exports++; if (exports === 1) throw new Error('Fixture public evidence copy failed');
      return { path: 'second-explicit-local-export', sha256: 'a'.repeat(64) };
    };
    await assert.rejects(h.invoke('fz3bExport', session.taskId), /evidence copy failed/);
    assert.equal((await h.snapshot()).fz3bAgent!.recoveryActions!.exportEvidence, true);
    assert.equal(await h.invoke('fz3bExport', session.taskId), 'second-explicit-local-export');
    assert.equal(exports, 2); assert.equal(state.probes, 0);
    assert.equal(state.run.hardwareBusy, true); assert.deepEqual(state.run.operations, original);
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, runId);
    h.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: true });
    await h.invoke('fz3bMaintenanceExit', runId);
    assert.equal(h.closed().quit, false); assert.equal(h.window.destroyed, false);
  } finally { await h.cleanup(); }
});

test('post-reconciliation source-owner failure holds main ownership until an explicit local-only completion', async () => {
  const { h, state, session, runId } = await setup();
  try {
    const original = structuredClone(state.run.operations);
    const task = h.tasks.find(task => task.id === session.taskId)!; const projectRoot = task.projectRoot;
    state.afterRelease = () => { task.projectRoot = `${projectRoot}-changed-during-finalization`; };
    h.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true });
    await assert.rejects(h.invoke('fz3bReconcileInspect', runId), /SOURCE_PROJECT_MISMATCH/);
    assert.equal(state.run.hardwareBusy, false); assert.equal(state.probes, 1);
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, runId);
    await assert.rejects(h.invoke('connect'), /HARDWARE_AGENT_ACTIVE/);
    task.projectRoot = projectRoot;
    h.dialog.showMessageBox = async () => { throw new Error('Already-released local completion must not ask for a new probe'); };
    const completed = await h.invoke('fz3bReconcileInspect', runId);
    assert.equal(completed.status, 'needs_attention'); assert.equal(completed.stopRequested, true);
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, undefined);
    assert.equal(state.probes, 1); assert.equal(h.fz3bEngine!.startCalls, 1); assert.equal(h.fz3bEngine!.sendCalls, 1);
    assert.deepEqual(state.run.operations, original); assert.equal(h.closed().quit, false);
  } finally { await h.cleanup(); }
});
