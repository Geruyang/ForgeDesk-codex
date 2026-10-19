import assert from 'node:assert/strict';
import test from 'node:test';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Fz3bBackend, type Fz3bBackendOptions } from '../packages/engineering-runner/fz3b/backend';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bProfileSha256 } from '../packages/engineering-runner/fz3b/profile';
import type { Fz3bGrantPreview, Fz3bRunView, Fz3bSemanticFixture } from '../packages/engineering-runner/fz3b/types';
import { desktopHarness, setupSession, until, type DesktopHarnessOptions } from './helpers/desktop-harness';

const fixture: Fz3bSemanticFixture = { id: 'fz3b-pillow-scene-v1', manifestSha256: FZ3B_PROFILE.semanticManifestSha256, queriesSha256: FZ3B_PROFILE.queriesSha256,
  imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256, width: 914, height: 512, queryCount: 4, embeddingDimensions: 512,
  expectedLabel: 'pillow', queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: { ...FZ3B_PROFILE.encoderIdentity } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function preview(run: Fz3bRunView): Fz3bGrantPreview {
  const now = Date.now(); return { id: 'offline-native-grant', runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, artifactId: 'c'.repeat(64),
    profileSha256: fz3bProfileSha256(fixture), identity: { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot,
      platform: 'A0005', contractId: FZ3B_PROFILE.encoderIdentity.contractId, deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
      existingPlSha256: FZ3B_PROFILE.existingPlSha256, transport: 'pinned-ssh', helloAuthenticated: false }, fixture,
    scope: 'existing-candidate008-real-text-single-image-once', actions: FZ3B_PROFILE.actions, planSha256: 'd'.repeat(64),
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
}
async function setup() {
  let callbacks!: Fz3bBackendOptions;
  const options: DesktopHarnessOptions = { fz3bFixture: fixture, allowFz3bEngine: true, fz3bFactory: input => { callbacks = input; return new Fz3bBackend(input); } };
  const h = await desktopHarness(options), session = await setupSession(h);
  return { h, session, callbacks, options };
}

test('main queues the entire FZ3B approval behind a close warning and creates no late warning on repeated close', async () => {
  const { h, session, callbacks } = await setup();
  try {
    const run = await h.invoke('fz3bAgentStart', session.taskId, 'offline presentation fixture', 'gpt-6.1-sol');
    const warning = deferred<{ response: number }>(), approval = deferred<{ response: number; checkboxChecked: boolean }>();
    const calls: string[] = []; let active = 0, maximum = 0;
    h.dialog.showMessageBox = async (_window, options) => {
      ++active; maximum = Math.max(maximum, active);
      try {
        if (options!.title === 'ForgeDesk Zynq 单图语义授权') { calls.push('approval'); assert.equal(options!.checkboxChecked, false); return await approval.promise; }
        calls.push('warning'); return await warning.promise;
      } finally { --active; }
    };
    h.window.callbacks.get('close')!({ preventDefault() {} }); await until(() => calls.length === 1);
    const granting = callbacks.requestSemantic(preview(run), new AbortController().signal);
    await h.snapshot(); assert.deepEqual(calls, ['warning']);
    warning.resolve({ response: 0 }); await until(() => calls.length === 2);
    h.window.callbacks.get('close')!({ preventDefault() {} }); h.window.callbacks.get('close')!({ preventDefault() {} });
    await h.snapshot(); assert.deepEqual(calls, ['warning', 'approval']); assert.equal(h.window.destroyed, false);
    approval.resolve({ response: 1, checkboxChecked: true }); assert.equal(await granting, true);
    await h.snapshot(); assert.deepEqual(calls, ['warning', 'approval']); assert.equal(maximum, 1);
    assert.equal((await h.fz3bBackend!.status(run.runId))!.operations.length, 0);
    await h.invoke('fz3bAgentStop', run.runId);
  } finally { await h.cleanup(); }
});

test('queued FZ3B approval abort or changed owner/runtime cannot show a stale native authorization', async () => {
  for (const failure of ['abort', 'owner', 'runtime'] as const) {
    const { h, session, callbacks, options } = await setup();
    try {
      const run = await h.invoke('fz3bAgentStart', session.taskId, 'offline presentation fixture', 'gpt-6.1-sol');
      const warning = deferred<{ response: number }>(); let warnings = 0, approvals = 0;
      h.dialog.showMessageBox = async (_window, value) => { if (value!.title) { ++approvals; return { response: 1, checkboxChecked: true }; } ++warnings; return warning.promise; };
      h.window.callbacks.get('close')!({ preventDefault() {} }); await until(() => warnings === 1);
      const abort = new AbortController(), granting = callbacks.requestSemantic(preview(run), abort.signal);
      if (failure === 'abort') abort.abort();
      if (failure === 'owner') ++h.fz3bEngine!.connectionGeneration;
      if (failure === 'runtime') options.fz3bAvailable = false;
      const result = failure === 'abort' ? granting.then(value => assert.equal(value, false)) : assert.rejects(granting, /MISMATCH|key missing/);
      warning.resolve({ response: 0 }); await result;
      assert.equal(approvals, 0); assert.equal((await h.fz3bBackend!.status(run.runId))!.operations.length, 0);
      h.fz3bEngine!.connectionGeneration = 1; options.fz3bAvailable = true;
      await h.invoke('fz3bAgentStop', run.runId);
    } finally { await h.cleanup(); }
  }
});

test('ordinary pickers share the slot and recheck hardware ownership before post-picker writes', async () => {
  const { h, session, callbacks } = await setup();
  try {
    const picker = deferred<{ filePath: string }>(), approval = deferred<{ response: number; checkboxChecked: boolean }>();
    const output = path.join(h.directory, 'must-not-export-during-hardware.json');
    let pickerOpened = false, approvalOpened = false;
    h.dialog.showSaveDialog = async () => { pickerOpened = true; return picker.promise; };
    h.dialog.showMessageBox = async () => { approvalOpened = true; return approval.promise; };
    const exporting = h.invoke('exportDiagnostics'); await until(() => pickerOpened);
    const run = await h.invoke('fz3bAgentStart', session.taskId, 'offline presentation fixture', 'gpt-6.1-sol');
    const granting = callbacks.requestSemantic(preview(run), new AbortController().signal);
    const refusedExport = assert.rejects(exporting, /HARDWARE_AGENT_ACTIVE/);
    await h.snapshot(); assert.equal(approvalOpened, false);
    picker.resolve({ filePath: output }); await refusedExport; await until(() => approvalOpened);
    await assert.rejects(stat(output), { code: 'ENOENT' });
    approval.resolve({ response: 0, checkboxChecked: false }); assert.equal(await granting, false);
    assert.equal((await h.fz3bBackend!.status(run.runId))!.operations.length, 0);
    await h.invoke('fz3bAgentStop', run.runId);
  } finally { await h.cleanup(); }
});
