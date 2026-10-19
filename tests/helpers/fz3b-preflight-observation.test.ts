import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ElectronApplication } from 'playwright';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { Fz3bRunView } from '../../packages/engineering-runner/fz3b/types';
import { assertFz3bOriginalUnknownPreserved, assertFz3bPreflightFinished, assertFz3bPreflightRecoverySettled,
  assertFz3bPreflightRestartHeld, fz3bFinishUiSettled, fz3bPreflightRecoverySettled, installFz3bFinishUiObserver,
  readFz3bFinishUiObserver, restoreFz3bFinishUiObserver, protectBeforeFailurePersistence } from './fz3b-preflight-observation';
const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;

async function browserFixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'fz3b-finish-dom-'));
  await writeFile(path.join(temporary, 'package.json'), JSON.stringify({ name: 'fz3b-dom-fixture', version: '1.0.0', main: 'main.cjs' }));
  await writeFile(path.join(temporary, 'index.html'), '<div class="fz3b-scroll" data-task-id="task-a" data-pending-intent="" aria-busy="false"><section><div role="alert">历史 unknown</div><div role="alert">历史 needs_attention</div></section></div><div class="fz3b-scroll" data-task-id="task-b" data-pending-intent="" aria-busy="false"></div>');
  await writeFile(path.join(temporary, 'main.cjs'), `const { app, BrowserWindow } = require('electron'); app.commandLine.appendSwitch('headless'); app.commandLine.appendSwitch('disable-gpu'); app.whenReady().then(() => { const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } }); window.loadFile(${JSON.stringify(path.join(temporary, 'index.html'))}); });`);
  try {
    const { _electron } = await import('playwright');
    const app = await _electron.launch({ executablePath: electronPath, args: [temporary, '--no-sandbox'], timeout: 30000 });
    const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
    return { app, page, temporary };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

async function closeBrowserFixture(app: ElectronApplication, temporary: string) {
  try { await app.close(); } finally { await rm(temporary, { recursive: true, force: true }); }
}

const run = (patch: Partial<Fz3bRunView> = {}) => ({ runId: 'preflight-refusal-case', taskId: 'task', sessionId: 'session', active: false, hardwareBusy: false,
  nativeApproval: 'not_requested', calls: [], operations: [
  { id: 'op-unknown', status: 'unknown', kind: 'inspect', requestKey: 'key', nonce: 'nonce', dispatchPhase: 'may-have-started', createdAt: 'x', updatedAt: 'x' }
], artifact: undefined, identity: undefined, grant: undefined, semantic: undefined,
preflightRefusalRecoveries: [{ status: 'released' }], ...patch } as unknown as Fz3bRunView);
const state = (target: Fz3bRunView, finish: boolean): AppSnapshot => ({ engine: { state: 'stopped' }, hardware: { modeActive: false }, approvals: [], tasks: [],
  hardwareAgent: { runs: [], engineState: 'stopped' }, fz3bAgent: { runs: [target], engineState: 'stopped', recoveryActions: { finishPreflightRefusal: finish } } } as unknown as AppSnapshot);

test('restart requires explicit local finish and keeps released proof plus original unknown unchanged', () => {
  const history = [{ status: 'released', proof: {}, finalization: {}, ack: {}, acknowledgment: {}, closure: {} }] as any;
  const original = run({ preflightRefusalRecoveries: history }), restarted = run({ preflightRefusalRecoveries: structuredClone(history) });
  assert.equal(assertFz3bPreflightRestartHeld(state(restarted, true), original.runId, original), restarted);
  assert.equal(assertFz3bPreflightFinished(state(restarted, false), original.runId, original), restarted);
});

test('finish predicate requires full quiet closure and rejects a foreign active owner', () => {
  const original = run(), complete = run({ preflightRefusalRecoveries: [{ status: 'released', proof: {}, finalization: {}, ack: {}, acknowledgment: {}, closure: {} }] as any });
  assert.equal(fz3bPreflightRecoverySettled(state(complete, false), original.runId), true);
  assert.throws(() => assertFz3bPreflightFinished({ ...state(complete, false), fz3bAgent: { ...state(complete, false).fz3bAgent!,
    activeRunId: 'foreign-active-run' } }, original.runId, original));
  assert.throws(() => assertFz3bPreflightFinished({ ...state(complete, false), fz3bAgent: { ...state(complete, false).fz3bAgent!,
    runs: [complete, run({ runId: 'foreign', active: true })] } }, original.runId, original));
  assert.equal(fz3bPreflightRecoverySettled({ ...state(complete, false), hardwareAgent: { runs: [], engineState: 'starting' } }, original.runId), false);
  assert.equal(fz3bPreflightRecoverySettled({ ...state(complete, false), approvals: [{ id: 'pending', generation: 1, method: 'fixture', params: {}, decisions: [] }] }, original.runId), false);
  assert.equal(fz3bPreflightRecoverySettled({ ...state(complete, false), engine: { state: 'running', executable: 'fixture', home: 'fixture' } }, original.runId), false);
  for (const operation of [{ status: 'prepared' }, { status: 'stopping' }, { status: 'unknown' }, { status: 'completed', cleanup: 'unknown' }]) {
    assert.equal(fz3bPreflightRecoverySettled({ ...state(complete, false), tasks: [{ status: 'completed', operations: [operation] }] as any }, original.runId), false);
  }
  assert.equal(fz3bPreflightRecoverySettled({ ...state(complete, false), sessions: [{ taskId: 'foreign-task', status: 'stopping' }] as any }, original.runId), false);
  assert.equal(fz3bPreflightRecoverySettled({ ...state(complete, false), sessions: [{ taskId: 'foreign-task', status: 'idle', engineUncertain: true }] as any }, original.runId), false);
});

test('read-only DOM observer captures a synchronous exact-task pending-to-settled transition', async () => {
  const fixture = await browserFixture();
  try {
    const { page } = fixture;
    await page.evaluate(installFz3bFinishUiObserver, 'task-a');
    await page.evaluate(() => {
      const target = document.querySelector('[data-task-id="task-a"]')!;
      target.setAttribute('data-pending-intent', 'reconcile-preflight-inspect');
      target.setAttribute('aria-busy', 'true');
      target.setAttribute('data-pending-intent', '');
      target.setAttribute('aria-busy', 'false');
    });
    const observation = await page.evaluate(readFz3bFinishUiObserver, 'task-a');
    assert.equal(fz3bFinishUiSettled(observation, 'task-a'), true);
    assert.deepEqual(observation.sequence, ['', 'reconcile-preflight-inspect', '']);
    assert.equal(observation.sequence.includes('reconcile-preflight-inspect'), true);
    assert.equal(fz3bFinishUiSettled(observation, 'task-b'), false);
    await page.evaluate(() => document.querySelector('[data-task-id="task-b"]')!.setAttribute('data-pending-intent', 'reconcile-preflight-inspect'));
    assert.equal((await page.evaluate(readFz3bFinishUiObserver, 'task-a')).sequence.includes('reconcile-preflight-inspect'), true);
    await page.evaluate(restoreFz3bFinishUiObserver, 'task-a');
    await page.evaluate(installFz3bFinishUiObserver, 'task-a');
    await page.evaluate(() => {
      const target = document.querySelector('[data-task-id="task-a"]')!;
      target.setAttribute('data-pending-intent', 'other-action'); target.setAttribute('data-pending-intent', '');
    });
    assert.equal(fz3bFinishUiSettled(await page.evaluate(readFz3bFinishUiObserver, 'task-a'), 'task-a'), false,
      'A duplicate or wrong action sequence cannot substitute for the one expected finish action');
    await page.evaluate(restoreFz3bFinishUiObserver, 'task-a');
    await page.evaluate(installFz3bFinishUiObserver, 'task-a');
    await page.evaluate(() => {
      const target = document.querySelector('[data-task-id="task-a"]')!;
      target.setAttribute('data-pending-intent', 'reconcile-preflight-inspect'); target.setAttribute('data-pending-intent', '');
    });
    assert.equal(fz3bFinishUiSettled(await page.evaluate(readFz3bFinishUiObserver, 'task-a'), 'task-a'), true);
    await page.evaluate(() => document.querySelector('[data-task-id="task-a"]')!.insertAdjacentHTML('afterbegin', '<div class="notice error" role="alert">failed</div>'));
    assert.equal(fz3bFinishUiSettled(await page.evaluate(readFz3bFinishUiObserver, 'task-a'), 'task-a'), false);
    await page.evaluate(() => document.querySelector('[data-task-id="task-a"] > .notice.error')!.remove());
    assert.equal(fz3bFinishUiSettled(await page.evaluate(readFz3bFinishUiObserver, 'task-a'), 'task-a'), true,
      'Nested historical unknown alerts do not masquerade as this action failing');
    await page.evaluate(() => {
      const oldPanel = document.querySelector('[data-task-id="task-a"]')!;
      oldPanel.replaceWith(oldPanel.cloneNode(true));
    });
    assert.equal(fz3bFinishUiSettled(await page.evaluate(readFz3bFinishUiObserver, 'task-a'), 'task-a'), false,
      'A remounted panel with the same task id is not the observed original UI promise');
    await page.evaluate(restoreFz3bFinishUiObserver, 'task-a');
    await assert.rejects(page.evaluate(readFz3bFinishUiObserver, 'task-a'));
    await page.evaluate(() => document.querySelector('[data-task-id="task-b"]')!.setAttribute('data-pending-intent', 'reconcile-preflight-inspect'));
    await assert.rejects(page.evaluate(installFz3bFinishUiObserver, 'task-b'), /already pending/);
    await assert.rejects(page.evaluate(installFz3bFinishUiObserver, 'task-missing'), /panel is absent/);
  } finally { await closeBrowserFixture(fixture.app, fixture.temporary); }
});

test('does not treat a saved released checkpoint alone as completed worker recovery', () => {
  const original = run(), incomplete = run({ preflightRefusalRecoveries: [{ status: 'released', proof: {}, finalization: {} }] as any });
  assert.equal(fz3bPreflightRecoverySettled(state(incomplete, false), original.runId), false);
  assert.throws(() => assertFz3bPreflightRecoverySettled(state(incomplete, false), original.runId, incomplete));
  const complete = run({ preflightRefusalRecoveries: [{ status: 'released', proof: {}, finalization: {}, ack: {}, acknowledgment: {}, closure: {} }] as any });
  assert.equal(fz3bPreflightRecoverySettled(state(complete, false), original.runId), true);
  assert.equal(assertFz3bPreflightRecoverySettled(state(complete, false), complete.runId, complete), complete);
  assert.equal(fz3bPreflightRecoverySettled({ ...state(complete, false), fz3bAgent: { ...state(complete, false).fz3bAgent!, engineState: 'reconciling' } }, original.runId), false);
});

test('rejects replay, success conversion, lost release, and automatic restart clearing', () => {
  const original = run();
  assert.throws(() => assertFz3bOriginalUnknownPreserved(original, run({ operations: [{ ...original.operations[0], status: 'succeeded' } as any] })));
  assert.throws(() => assertFz3bOriginalUnknownPreserved(original, run({ calls: [{ callId: 'replay' } as any] })));
  assert.throws(() => assertFz3bPreflightRestartHeld(state(run({ preflightRefusalRecoveries: [] }), true), original.runId, original));
  assert.throws(() => assertFz3bPreflightRestartHeld(state(run(), false), original.runId, original));
});

test('failure cleanup protects the installed lifecycle before evidence persistence can fail', async () => {
  const events: string[] = [];
  const result = await protectBeforeFailurePersistence(() => { events.push('protect'); return { needsHumanClose: true }; }, async protection => {
    assert.equal(protection.needsHumanClose, true); events.push('persist'); throw new Error('evidence disk unavailable');
  });
  assert.deepEqual(events, ['protect', 'persist']); assert.equal(result.protection.needsHumanClose, true);
  assert.equal(result.evidencePersisted, false); assert.equal(result.persistenceError, 'evidence disk unavailable');
});
