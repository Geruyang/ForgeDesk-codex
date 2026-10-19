import assert from 'node:assert/strict';
import test from 'node:test';
import { Fz3bBackend, type Fz3bBackendOptions } from '../packages/engineering-runner/fz3b/backend';
import { FZ3B_PROFILE, fz3bProfileSha256 } from '../packages/engineering-runner/fz3b/profile';
import type { Fz3bBinding, Fz3bInspectReconciliationContext, Fz3bMaintenanceExitSeal, Fz3bPreflightRefusalRecoveryContext, Fz3bRunView, Fz3bSemanticFixture } from '../packages/engineering-runner/fz3b/types';
import { desktopHarness, setupSession, until } from './helpers/desktop-harness';

const fixture: Fz3bSemanticFixture = { id: 'fz3b-pillow-scene-v1', manifestSha256: FZ3B_PROFILE.semanticManifestSha256, queriesSha256: FZ3B_PROFILE.queriesSha256,
  imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256,
  width: 914, height: 512, queryCount: 4, embeddingDimensions: 512, expectedLabel: 'pillow',
  queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: { ...FZ3B_PROFILE.encoderIdentity } };

/** Main/IPC fixture only: independent backend/worker tests establish the actual signed proof rules. */
function recoveryBackend(options: Fz3bBackendOptions) {
  const backend = new Fz3bBackend(options);
  let run: Fz3bRunView | undefined, localClosed = true, prepared = 0, inspections = 0, preflight = false, localReleases = 0;
  backend.start = async (binding: Fz3bBinding) => {
    run = { ...binding, schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: fz3bProfileSha256(fixture),
      status: 'active', phase: 'ready', active: true, hardwareBusy: true, stopRequested: false,
      nativeApproval: 'not_requested', createdAt: '', updatedAt: '', calls: [],
      operations: [{ id: 'original-inspect', nonce: 'original-nonce', requestKey: 'original-key', kind: 'inspect', status: 'unknown', dispatchPhase: 'may-have-started', processExited: true, createdAt: '', updatedAt: '', evidenceSha256: 'a'.repeat(64) }] };
    return structuredClone(run);
  };
  backend.list = async () => run ? [structuredClone(run)] : [];
  backend.status = async id => run?.runId === id ? structuredClone(run) : undefined;
  backend.recover = async () => {};
  backend.stop = async () => { run!.active = false; run!.stopRequested = true; run!.status = 'needs_attention'; return structuredClone(run!); };
  backend.turnEnded = async () => { run!.active = false; return structuredClone(run!); };
  backend.quiescence = async id => ({ runId: id, taskId: run!.taskId, sessionId: run!.sessionId, active: run!.active, stopRequested: run!.stopRequested,
    starting: false, inflight: false, nativePending: false, persistencePending: false, hardwareBusy: run!.hardwareBusy, quiescent: !run!.active && !run!.hardwareBusy });
  backend.recoveryActions = async () => ({ reconcileInspect: true, reconcilePreflightRefusedInspect: preflight, maintenanceExit: true, exportEvidence: localClosed && run!.operations.every(op => op.processExited === true) });
  backend.export = async () => ({ path: 'local-unknown-evidence-fixture', sha256: 'd'.repeat(64) });
  backend.prepareMaintenanceExit = async (): Promise<Fz3bMaintenanceExitSeal> => {
    await options.assertRecoveryOwner!(run!);
    if (!localClosed) throw new Error('Local child close not confirmed');
    ++prepared;
    const seal: Fz3bMaintenanceExitSeal = { schemaVersion: 1, runId: run!.runId, taskId: run!.taskId, sessionId: run!.sessionId, profileSha256: run!.profileSha256,
      createdAt: new Date().toISOString(), unknownPreserved: true, localProcessesClosed: true, operationSnapshotSha256: 'b'.repeat(64),
      processState: { closed: true, liveChildren: 0, operations: [{ operationId: 'original-inspect', nonce: 'original-nonce', closeConfirmed: true, evidenceSha256: 'a'.repeat(64) }] }, sealSha256: 'c'.repeat(64) };
    run!.maintenanceExit = seal; return structuredClone(seal);
  };
  backend.reconcileInspect = async () => {
    await options.assertRecoveryOwner!(run!);
    const context: Fz3bInspectReconciliationContext = { schemaVersion: 1, id: 'new-reconciliation', nonce: 'new-nonce', createdAt: new Date().toISOString(),
      original: { runId: run!.runId, taskId: run!.taskId, sessionId: run!.sessionId, operationId: 'original-inspect', nonce: 'original-nonce', requestKey: 'original-key', profileSha256: run!.profileSha256, fixture },
      originalOperationSha256: 'a'.repeat(64), originalEvidenceSha256: 'a'.repeat(64), ownerBindingSha256: 'b'.repeat(64) };
    if (!await options.requestInspectReconciliation!(context, new AbortController().signal)) throw new Error('Not natively confirmed');
    await options.assertRecoveryOwner!(run!); ++inspections;
    run!.hardwareBusy = false; return structuredClone(run!);
  };
  backend.reconcilePreflightRefusedInspect = async () => {
    await options.assertRecoveryOwner!(run!);
    if (!preflight || !localClosed) throw new Error('Local preflight refusal is not settled');
    const created = Date.now(), sourceRun = structuredClone(run!);
    // Presentation-only fixture: signed proof admission belongs to independent backend tests.
    const context: Fz3bPreflightRefusalRecoveryContext = {
      schemaVersion: 1, reason: 'boot-preflight-refused-before-device-v1', id: 'local-preflight-recovery', nonce: 'b'.repeat(64),
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString(),
      original: { runId: run!.runId, taskId: run!.taskId, sessionId: run!.sessionId, operationId: 'original-inspect', nonce: 'original-nonce', requestKey: 'original-key', profileSha256: run!.profileSha256, fixture },
      ownerBindingSha256: 'a'.repeat(64), originalOperationSha256: 'a'.repeat(64), originalEvidenceSha256: 'a'.repeat(64),
      sourceRecordSha256: 'a'.repeat(64), sourceProjectionSha256: 'a'.repeat(64), maintenanceExitSha256: null,
      sourceRun, projection: structuredClone(sourceRun), anchor: { owner: { runId: sourceRun.runId, sessionId: sourceRun.sessionId, taskId: sourceRun.taskId, model: sourceRun.model,
        generation: sourceRun.generation, threadId: sourceRun.threadId, turnId: sourceRun.turnId! }, operationId: 'original-inspect', runSha256: 'a'.repeat(64),
        operationSha256: 'a'.repeat(64), evidenceSha256: 'a'.repeat(64), intentSha256: 'a'.repeat(64), transportSha256: 'a'.repeat(64), actualCloseSha256: 'a'.repeat(64) },
    };
    if (!await options.requestPreflightRefusalRecovery!(context, new AbortController().signal)) throw new Error('Local preflight recovery not natively confirmed');
    await options.assertRecoveryOwner!(run!); ++localReleases;
    run!.hardwareBusy = false; return structuredClone(run!);
  };
  return { backend, get run() { return run!; }, get prepared() { return prepared; }, get inspections() { return inspections; }, get localReleases() { return localReleases; },
    set preflight(value: boolean) { preflight = value; }, set localClosed(value: boolean) { localClosed = value; } };
}

async function setup() {
  let state!: ReturnType<typeof recoveryBackend>;
  const h = await desktopHarness({ fz3bFixture: fixture, allowFz3bEngine: true, fz3bFactory: options => { state = recoveryBackend(options); return state.backend; } });
  const session = await setupSession(h), run = await h.invoke('fz3bAgentStart', session.id, 'fixed fixture only', 'gpt-6.1-sol');
  await h.invoke('fz3bAgentStop', run.runId);
  return { h, session, runId: run.runId as string, state };
}

test('unknown ordinary close remains blocked; maintenance requires exact run and native checkbox and preserves the hold', async () => {
  const { h, session, runId, state } = await setup();
  try {
    const actions = (await h.snapshot()).fz3bAgent!.recoveryActions;
    assert.deepEqual({ ...actions }, { runId, taskId: session.taskId, sessionId: session.id, reconcileInspect: true, reconcilePreflightRefusedInspect: false, maintenanceExit: true, exportEvidence: true });
    let warnings = 0;
    h.dialog.showMessageBox = async () => { ++warnings; return { response: 0 }; };
    h.window.callbacks.get('close')!({ preventDefault() {} }); await until(() => warnings === 1);
    assert.equal(h.window.destroyed, false); assert.equal(h.closed().quit, false);
    await assert.rejects(h.invoke('fz3bMaintenanceExit', runId, { approved: true }), /EXACT_RUN_ID_ONLY/);
    await assert.rejects(h.invoke('fz3bMaintenanceExit', 'foreign'), /OWNER_MISMATCH/);
    h.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    await h.invoke('fz3bMaintenanceExit', runId);
    assert.equal(h.closed().quit, false); assert.equal(state.run.hardwareBusy, true); assert.equal(state.run.operations[0].status, 'unknown');
    h.dialog.showMessageBox = async (_window, options) => {
      assert.equal(options!.defaultId, 0); assert.equal(options!.checkboxChecked, false); assert.match(options!.detail, /不证明远端安全/);
      return { response: 1, checkboxChecked: true };
    };
    await h.invoke('fz3bMaintenanceExit', runId);
    assert.equal(state.prepared, 3); assert.equal(state.inspections, 0);
    assert.equal(h.window.destroyed, true); assert.deepEqual(h.closed(), { quit: true, runnerClosed: true, bridgeClosed: true });
    assert.equal(state.run.hardwareBusy, true); assert.equal(state.run.operations[0].status, 'unknown');
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, runId);
    assert.equal(h.fz3bEngine!.startCalls, 1); assert.equal(h.fz3bEngine!.sendCalls, 1);
  } finally { await h.cleanup(); }
});

test('maintenance native wait blocks mutation and ordinary close; changed source binding cannot authorize exit', async () => {
  const { h, session, runId, state } = await setup();
  try {
    let opened = false, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    h.dialog.showMessageBox = async () => { opened = true; await gate; return { response: 1, checkboxChecked: true }; };
    const exit = h.invoke('fz3bMaintenanceExit', runId); await until(() => opened);
    assert.equal((await h.snapshot()).fz3bAgent!.recoveryActions, undefined);
    const cachedDuringNative = await h.invoke('fz3bSnapshot', session.taskId);
    assert.equal(cachedDuringNative.runId, runId); assert.equal(cachedDuringNative.hardwareBusy, true);
    assert.equal(cachedDuringNative.operations[0].status, 'unknown');
    h.standardStreams.stderr.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }));
    assert.equal((await h.invoke('fz3bSnapshot', session.taskId)).operations[0].status, 'unknown');
    assert.equal(state.prepared, 1); assert.equal(state.inspections, 0); assert.equal(h.closed().quit, false);
    for (const [method, ...args] of [['connect'], ['fz3bAgentStop', runId], ['fz3bReconcileInspect', runId], ['fz3bExport', session.taskId], ['fz3bImportKey']]) await assert.rejects(h.invoke(method as string, ...args), /HOST_RECOVERY_PENDING/);
    h.window.callbacks.get('close')!({ preventDefault() {} }); assert.equal(h.window.destroyed, false);
    h.tasks.find(task => task.id === session.taskId)!.projectRoot += '-changed';
    release(); await assert.rejects(exit, /SOURCE_PROJECT_MISMATCH/);
    assert.equal(state.prepared, 1); assert.equal(h.closed().quit, false); assert.equal(state.run.hardwareBusy, true);
  } finally { await h.cleanup(); }
});

test('unconfirmed local worker or engine exit fails maintenance before native confirmation and never releases unknown', async () => {
  const { h, runId, state } = await setup();
  try {
    let shown = 0; h.dialog.showMessageBox = async () => { ++shown; return { response: 1, checkboxChecked: true }; };
    state.localClosed = false;
    await assert.rejects(h.invoke('fz3bMaintenanceExit', runId), /Local child close not confirmed/);
    assert.equal(shown, 0); assert.equal(state.prepared, 0);
    state.localClosed = true; h.fz3bEngine!.stopBehavior = async () => { throw new Error('Engine exit not confirmed'); };
    await assert.rejects(h.invoke('fz3bMaintenanceExit', runId), /Engine exit not confirmed/);
    assert.equal(shown, 0); assert.equal(state.prepared, 0); assert.equal(h.closed().quit, false);
    assert.equal((await h.snapshot()).fz3bAgent!.recoveryActions, undefined);
    assert.equal(state.run.hardwareBusy, true); assert.equal(state.run.operations[0].status, 'unknown');
  } finally { await h.cleanup(); }
});

test('fresh native inspect reconciliation is not a model tool and leaves the original unknown stopped without replay', async () => {
  const { h, session, runId, state } = await setup();
  try {
    const before = structuredClone(state.run.operations);
    h.dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: true });
    await assert.rejects(h.invoke('fz3bReconcileInspect', runId), /Not natively confirmed/);
    assert.equal(state.inspections, 0); assert.equal(state.run.hardwareBusy, true);
    h.dialog.showMessageBox = async (_window, options) => {
      assert.equal(options!.checkboxChecked, false); assert.match(options!.detail, /原 unknown 记录保留/);
      return { response: 1, checkboxChecked: true };
    };
    const result = await h.invoke('fz3bReconcileInspect', runId);
    assert.equal(state.inspections, 1); assert.equal(result.status, 'needs_attention'); assert.equal(result.stopRequested, true);
    assert.deepEqual(result.operations, before); assert.equal(result.hardwareBusy, false);
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, undefined);
    await assert.rejects(h.invoke('fz3bAgentStart', session.taskId, 'replay old run', 'gpt-6.1-sol'), /FRESH_SESSION/);
    assert.equal(h.fz3bEngine!.startCalls, 1); assert.equal(h.fz3bEngine!.sendCalls, 1);
  } finally { await h.cleanup(); }
});

test('stopped unknown evidence export uses a fresh exact-owner local-settled gate and never releases remote uncertainty', async () => {
  const { h, session, runId, state } = await setup();
  try {
    assert.equal((await h.snapshot()).fz3bAgent!.recoveryActions!.exportEvidence, true);
    state.localClosed = false;
    assert.equal((await h.snapshot()).fz3bAgent!.recoveryActions!.exportEvidence, false);
    await assert.rejects(h.invoke('fz3bExport', session.taskId), /LOCAL_STATE_NOT_SETTLED/);
    state.localClosed = true;
    assert.equal(await h.invoke('fz3bExport', session.taskId), 'local-unknown-evidence-fixture');
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, runId);
    assert.equal(state.run.hardwareBusy, true); assert.equal(state.run.operations[0].status, 'unknown');
    assert.equal(state.inspections, 0); assert.equal(h.fz3bEngine!.sendCalls, 1);
  } finally { await h.cleanup(); }
});

test('local evidence copy owns the host action until settled so maintenance cannot exit in the middle of a copy', async () => {
  const { h, session, runId, state } = await setup();
  try {
    let copying = false, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    state.backend.export = async () => { copying = true; await gate; return { path: 'finished-local-copy', sha256: 'e'.repeat(64) }; };
    const exporting = h.invoke('fz3bExport', session.taskId); await until(() => copying);
    await assert.rejects(h.invoke('fz3bMaintenanceExit', runId), /HOST_RECOVERY_PENDING/);
    await assert.rejects(h.invoke('fz3bExport', session.taskId), /HOST_RECOVERY_PENDING/);
    h.window.callbacks.get('close')!({ preventDefault() {} }); assert.equal(h.closed().quit, false);
    release(); assert.equal(await exporting, 'finished-local-copy');
    assert.equal(state.run.hardwareBusy, true); assert.equal(state.run.operations[0].status, 'unknown');
    assert.equal(state.prepared, 0); assert.equal(state.inspections, 0);
  } finally { await h.cleanup(); }
});

test('local preflight recovery accepts only exact run IPC and fresh default-deny native confirmation', async () => {
  const { h, session, runId, state } = await setup();
  try {
    state.preflight = true;
    const before = structuredClone(state.run.operations);
    assert.equal((await h.snapshot()).fz3bAgent!.recoveryActions!.reconcilePreflightRefusedInspect, true);
    let shown = 0;
    h.dialog.showMessageBox = async (_window, options) => {
      ++shown;
      assert.equal(options!.title, 'ForgeDesk FZ3B 本地预检拒绝恢复');
      assert.equal(options!.defaultId, 0); assert.equal(options!.cancelId, 0); assert.equal(options!.checkboxChecked, false);
      assert.match(options!.detail, /不连接 SSH/); assert.match(options!.detail, /不授权新 Boot/);
      return { response: 1, checkboxChecked: false };
    };
    await assert.rejects(h.invoke('fz3bReconcilePreflightRefusedInspect', runId, { approved: true }), /EXACT_RUN_ID_ONLY/);
    await assert.rejects(h.invoke('fz3bReconcilePreflightRefusedInspect', 'foreign'), /OWNER_MISMATCH/);
    assert.equal(shown, 0);
    await assert.rejects(h.invoke('fz3bReconcilePreflightRefusedInspect', runId), /not natively confirmed/);
    assert.equal(shown, 1); assert.equal(state.localReleases, 0); assert.equal(state.run.hardwareBusy, true);
    h.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true });
    const result = await h.invoke('fz3bReconcilePreflightRefusedInspect', runId);
    assert.equal(state.localReleases, 1); assert.equal(state.inspections, 0); assert.equal(state.prepared, 0);
    assert.equal(result.hardwareBusy, false); assert.equal(result.status, 'needs_attention');
    assert.deepEqual(result.operations, before); assert.equal(result.grant, undefined);
    assert.equal((await h.snapshot()).fz3bAgent!.activeRunId, undefined);
    assert.equal(h.fz3bEngine!.startCalls, 1); assert.equal(h.fz3bEngine!.sendCalls, 1);
    assert.equal(h.closed().quit, false); assert.equal(h.engine.state, 'stopped');
    assert.equal(session.id, result.sessionId);
  } finally { await h.cleanup(); }
});

test('local preflight native wait allows only cached reads and changed source cannot release the hold', async () => {
  const { h, session, runId, state } = await setup();
  try {
    state.preflight = true;
    let opened = false, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    h.dialog.showMessageBox = async () => { opened = true; await gate; return { response: 1, checkboxChecked: true }; };
    const recovering = h.invoke('fz3bReconcilePreflightRefusedInspect', runId); await until(() => opened);
    assert.equal((await h.snapshot()).fz3bAgent!.recoveryActions, undefined);
    const before = structuredClone(state.run.operations);
    const cached = await h.invoke('fz3bSnapshot', session.taskId);
    assert.equal(cached.runId, runId); assert.equal(cached.hardwareBusy, true); assert.deepEqual(cached.operations, before);
    for (const [method, ...args] of [['connect'], ['fz3bAgentStop', runId], ['fz3bReconcileInspect', runId], ['fz3bReconcilePreflightRefusedInspect', runId], ['fz3bMaintenanceExit', runId], ['fz3bExport', session.taskId], ['fz3bImportKey']]) {
      await assert.rejects(h.invoke(method as string, ...args), /HOST_RECOVERY_PENDING/);
    }
    h.standardStreams.stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }));
    assert.deepEqual((await h.invoke('fz3bSnapshot', session.taskId)).operations, before);
    h.window.callbacks.get('close')!({ preventDefault() {} }); assert.equal(h.closed().quit, false);
    h.tasks.find(task => task.id === session.taskId)!.projectRoot += '-changed';
    release(); await assert.rejects(recovering, /SOURCE_PROJECT_MISMATCH/);
    assert.equal(state.localReleases, 0); assert.equal(state.inspections, 0); assert.equal(state.prepared, 0);
    assert.equal(state.run.hardwareBusy, true); assert.deepEqual(state.run.operations, before);
  } finally { await h.cleanup(); }
});

test('hidden finish capability during an unresolved original IPC is not completion; ordinary close works after that IPC settles', async () => {
  const { h, session, runId, state } = await setup();
  try {
    state.preflight = true;
    h.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true });
    const original = state.backend.reconcilePreflightRefusedInspect.bind(state.backend);
    let backendCompleted = false, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    state.backend.reconcilePreflightRefusedInspect = async id => {
      const result = await original(id); backendCompleted = true; await gate; return result;
    };
    const action = h.invoke('fz3bReconcilePreflightRefusedInspect', runId); await until(() => backendCompleted);
    const during = await h.snapshot();
    assert.equal(during.fz3bAgent!.recoveryActions, undefined);
    assert.equal(during.fz3bAgent!.activeRunId, runId, 'A hidden action does not imply main owner release');
    assert.equal((await h.invoke('fz3bSnapshot', session.taskId)).hardwareBusy, false, 'A backend terminal view is not the main IPC acknowledgement');
    h.window.callbacks.get('close')!({ preventDefault() {} });
    assert.equal(h.closed().quit, false); assert.equal(h.window.destroyed, false);
    release(); await action;
    const after = await h.snapshot();
    assert.equal(after.fz3bAgent!.activeRunId, undefined); assert.equal(after.fz3bAgent!.recoveryActions, undefined);
    assert.equal(state.localReleases, 1); assert.equal(state.inspections, 0);
    h.window.callbacks.get('close')!({ preventDefault() {} }); await until(() => h.closed().quit);
    assert.equal(h.window.destroyed, true); assert.equal(state.localReleases, 1);
    assert.equal(state.run.operations[0].status, 'unknown'); assert.equal(state.run.grant, undefined);
  } finally { await h.cleanup(); }
});
