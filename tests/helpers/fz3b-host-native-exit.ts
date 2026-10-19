import assert from 'node:assert/strict';
import type { ElectronApplication, ConsoleMessage } from 'playwright';
import type { SnapshotInstalledLaunch } from './snapshot-installed-lifecycle';
import type { DesktopIdentity } from './snapshot-smoke-scope';
import { assertElectronMainExited, type InstalledMainProcess } from './second-user-controls';
import { assertFz3bHostFinalizationIpcReceipt, FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX,
  type Fz3bHostFinalizationIpcReceipt } from './fz3b-host-finalization-ipc-observer';
import { observeNormalCloseRequest } from './normal-close-observation';

export function observeFz3bHostMaintenanceExit(app: ElectronApplication, launch: SnapshotInstalledLaunch, runId: string, reads: {
  identity(): Promise<DesktopIdentity>; nativeMain(pid: number): Promise<InstalledMainProcess | null>;
}, timeoutMs = 10 * 60_000) {
  assert.ok(launch.nativeMain && launch.electronMain && launch.launcherPid);
  const child = app.process(); assert.equal(child.pid, launch.launcherPid);
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  const consoleReceipts: Fz3bHostFinalizationIpcReceipt[] = [];
  let receiptFailure: unknown;
  let rejectReceipt!: (error: unknown) => void;
  const invalidReceipt = new Promise<never>((_, reject) => { rejectReceipt = reject; });
  const onConsole = (message: ConsoleMessage) => {
    const text = message.text(); if (!text.startsWith(FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX)) return;
    try {
      assert.ok(text.length <= 16384);
      const receipt = JSON.parse(text.slice(FZ3B_HOST_MAINTENANCE_CONSOLE_PREFIX.length));
      assert.equal(receipt.runId, runId); assert.equal(receipt.purpose, 'maintenance-exit');
      assert.equal(receipt.mechanism, 'test-only exact-run original forgedesk:invoke pass-through observer'); assert.equal(receipt.electronVersion, '44.7.2');
      assert.equal(receipt.calls.length, 1); const call = receipt.calls[0];
      assert.equal(call.argumentsValid, true); assert.equal(call.argumentCount, 1); assert.ok(Number.isFinite(call.startedAt));
      assert.ok(consoleReceipts.length < 2);
      if (consoleReceipts.length) {
        assert.equal(consoleReceipts[0].calls[0].phase, 'started'); assert.equal(call.startedAt, consoleReceipts[0].calls[0].startedAt);
        assert.equal(call.phase, 'fulfilled');
      }
      if (call.phase === 'started') { assert.equal(call.finishedAt, undefined); assert.equal(call.error, undefined); }
      else assertFz3bHostFinalizationIpcReceipt(receipt, 1, 'maintenance-exit');
      consoleReceipts.push(receipt);
    } catch (error) { receiptFailure = error; rejectReceipt(error); }
  };
  app.on('console', onConsole);
  let onClose!: (code: number | null, signal: string | null) => void;
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    onClose = (code, signal) => resolve({ code, signal }); child.once('close', onClose);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Arm before the root-operated visible action, but never invoke that action.
  const result = (async () => {
    try {
      const exit = await Promise.race([
        closed, invalidReceipt,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Original maintenance call and actual native exit were not both observed; no retry or kill')), timeoutMs); }),
      ]);
      assert.equal(exit.code, 0); assert.equal(exit.signal, null);
      if (receiptFailure) throw receiptFailure;
      assert.ok(consoleReceipts.length >= 1, 'An exact original maintenance call must be observed before accepting its local exit');
      const absence = [];
      for (let index = 0; index < 2; index++) {
        const native = await reads.nativeMain(launch.electronMain!.pid); assertElectronMainExited(launch.nativeMain!, native);
        const identity = await reads.identity();
        assert.equal(identity.sid, launch.desktopIdentity.sid); assert.equal(identity.sessionId, launch.desktopIdentity.sessionId);
        assert.equal(identity.applications.length, 0);
        absence.push({ observedAt: new Date().toISOString(), nativeMain: native, identity });
      }
      if (receiptFailure) throw receiptFailure;
      const cleanup = await observeNormalCloseRequest(app.close(), 5000); // Only after actual native absence.
      assert.notEqual(cleanup.state, 'timed-out', 'Post-exit dispatcher cleanup was not acknowledged');
      if (cleanup.state === 'rejected') throw cleanup.error;
      if (receiptFailure) throw receiptFailure;
      const ipc = consoleReceipts.at(-1)!;
      return { originalIpc: ipc, originalIpcTerminalObserved: ipc.calls[0].phase === 'fulfilled',
        originalIpcScope: 'Self-exiting handler may terminate before its fulfillment microtask; started-only never means fulfilled',
        rootOperatedMaintenanceExitObserved: true, nativeAnswerObservedByHarness: false, forcedKill: false, launcherPid: child.pid,
        launcherExitCode: exit.code, launcherSignal: exit.signal, nativeMainBefore: launch.nativeMain, absence,
        normalClose: true, requestScope: 'Root-operated visible local maintenance action, not harness window close or remote recovery' };
    } finally {
      if (timer) clearTimeout(timer); app.removeListener('console', onConsole); child.removeListener('close', onClose);
    }
  })();
  // Prevent an early event rejection becoming unhandled before the caller awaits readiness.
  void result.catch(() => {});
  return { result, consoleReceipts };
}
