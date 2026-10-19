import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { FlashOutcome } from '../packages/engineering-runner/device/types';
import { EmbeddedService } from '../packages/engineering-runner/embedded';
import { digest, durableJson, fileHash } from '../packages/engineering-runner/embedded/files';
import type { EmbeddedHardwareContext } from '../packages/engineering-runner/embedded/types';
import { delay, desktopHarness, setupSession, until } from './helpers/desktop-harness';

// Real main, controller, signed EmbeddedService state and probe lock. Every process/device boundary is an offline fixture.
async function fixture(beforeRename?: (from: string, to: string) => Promise<void>) {
  let embedded!: EmbeddedService;
  let exitConfirmed = true;
  let markerConfirmsExit = false;
  let runtimeFailure = false;
  const counters = { builds: 0, inspections: 0, flashes: 0, verifications: 0, recoveries: 0, exitChecks: 0 };
  let flashAction: (context: EmbeddedHardwareContext) => Promise<FlashOutcome> = async () =>
    ({ status: 'unknown', processExited: exitConfirmed, detail: 'Synthetic unknown; never real hardware' });
  let verifyAction: () => Promise<FlashOutcome> = async () => { throw new Error('Verification must never follow the synthetic unknown'); };
  const h = await desktopHarness({ fixtureRoot: path.resolve('output/hardware/2026-10-16/unknown-recovery-fixtures'),
    allowRestrictedEngine: true, beforeRename,
    verifyHardwareRuntime: async () => { if (runtimeFailure) throw new Error('Injected runtime integrity refusal'); },
    embeddedFactory: options => {
      embedded = new EmbeddedService({ ...options,
        hardware: {
          async inspect(ctx) {
            counters.inspections++;
            const backup = path.join(ctx.operationDir, 'backup.bin');
            await writeFile(backup, Buffer.alloc(1048576, 0xff));
            return { status: 'succeeded', processExited: true, receipt: JSON.stringify({ backup: {
              path: backup, sha256: await fileHash(backup), bytes: 1048576, doubleReadMatch: true } }) };
          },
          async flash(ctx) { counters.flashes++; return flashAction(ctx); },
          async verify() { counters.verifications++; return verifyAction(); },
          async confirmProcessExited() { counters.exitChecks++; return markerConfirmsExit; },
        },
        async execute(command) {
          counters.builds++;
          const source = path.resolve(command.cwd!, '..');
          const header = await readFile(path.join(source, 'App/Inc/forgedesk_build_id.h'), 'utf8');
          const buildId = Buffer.from([...header.matchAll(/0x([a-f0-9]{2})/g)].map(match => Number.parseInt(match[1], 16)));
          assert.equal(buildId.length, 32);
          const objects = path.join(source, 'MDK-ARM/Objects'); await mkdir(objects, { recursive: true });
          await writeFile(path.join(objects, 'GestureScreen.axf'), Buffer.concat([Buffer.from('Offline ELF fixture'), buildId]));
          await writeFile(path.join(objects, 'GestureScreen.hex'), ':00000001FF\n');
          await writeFile(command.args[command.args.indexOf('-o') + 1], 'GestureScreen - 0 Error(s), 0 Warning(s).\n');
          return { exitCode: 0, signal: null, output: 'Offline compiler fixture', timedOut: false, cancelled: false, cleanup: 'not-needed' };
        },
      });
      const internals = embedded as unknown as { tools: () => Promise<Record<string, string>>; validateProject: () => Promise<void> };
      internals.tools = async () => ({ offlineCompiler: digest('no executable was started') });
      internals.validateProject = async () => {};
      const recover = embedded.recover.bind(embedded);
      embedded.recover = async () => { counters.recoveries++; await recover(); };
      return embedded;
    } });
  await mkdir(path.join(h.projectRoot, 'MDK-ARM'));
  await writeFile(path.join(h.projectRoot, 'main.c'), 'int main(void) { return 0; }\n');
  await writeFile(path.join(h.projectRoot, 'MDK-ARM/GestureScreen.uvprojx'), '<TargetName>GestureScreen</TargetName>');
  const session = await setupSession(h);
  h.dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: true });
  const start = () => h.invoke('hardwareAgentStart', session.taskId, 'Offline recovery test; no real hardware', 'gpt-6.1-sol');
  const throughInspect = async () => {
    const run = await start();
    for (const tool of ['embedded_status', 'embedded_build', 'embedded_inspect']) assert.equal((await h.restrictedEngine!.toolCall(tool)).ok, true);
    return run;
  };
  const unknown = async () => {
    const run = await throughInspect();
    const result = await h.restrictedEngine!.toolCall('embedded_request_flash'); assert.equal(result.result, 'unknown');
    await h.invoke('hardwareAgentStop', run.runId); return run;
  };
  const lock = path.join(h.dataDir, 'embedded/probe.lock');
  return { h, embedded, session, counters, start, throughInspect, unknown, lock,
    setExit: (confirmed: boolean) => { exitConfirmed = confirmed; },
    setMarker: (confirmed: boolean) => { markerConfirmsExit = confirmed; },
    setRuntimeFailure: (failure: boolean) => { runtimeFailure = failure; },
    setFlash: (action: typeof flashAction) => { flashAction = action; },
    setVerify: (action: typeof verifyAction) => { verifyAction = action; },
    cleanup: () => h.cleanup() };
}

test('strict real-main recovery releases only confirmed exit while unknown history and no replay remain', async () => {
  const f = await fixture();
  try {
    const run = await f.unknown();
    assert.equal(existsSync(f.lock), true);
    const held = (await f.h.snapshot()).hardwareAgent!;
    assert.equal(held.activeRunId, run.runId); assert.equal(held.runs[0].hardwareBusy, true);
    const state = await f.h.invoke('hardwareRecover', f.session.taskId);
    const flash = state.operations.find((op: { kind: string }) => op.kind === 'flash');
    assert.equal(flash.status, 'unknown'); assert.ok(flash.recoveredAt); assert.equal(flash.processExited, true);
    assert.equal(existsSync(f.lock), false); assert.equal(f.counters.flashes, 1); assert.equal(f.counters.builds, 1);
    const snapshot = await f.h.snapshot();
    assert.equal(snapshot.hardwareAgent!.activeRunId, undefined);
    assert.equal(snapshot.hardwareAgent!.runs[0].status, 'needs_attention');
    assert.equal(snapshot.hardwareAgent!.runs[0].hardwareBusy, false);
    assert.equal(snapshot.sessions.find(item => item.id === f.session.id)!.status, 'needs_attention');
    const disk = JSON.parse(await readFile(path.join(f.h.dataDir, 'hardware-agent', `${run.runId}.json`), 'utf8'));
    assert.equal(disk.payload.status, 'needs_attention'); assert.equal(disk.payload.hardwareBusy, false);
    await assert.rejects(f.h.restrictedEngine!.toolCall('embedded_request_flash'), /OWNER_MISMATCH/);
    f.h.window.callbacks.get('close')!({ preventDefault() {} }); await until(() => f.h.closed().quit);
  } finally { await f.cleanup(); }
});

test('alive or ambiguous exit remains held until a later explicit exact-exit recovery', async () => {
  const f = await fixture();
  try {
    f.setExit(false); const run = await f.unknown();
    await assert.rejects(f.h.invoke('hardwareRecover', f.session.taskId), /lock remains held/);
    assert.equal(existsSync(f.lock), true); assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, run.runId);
    assert.equal((await f.embedded.status(f.session.taskId)).operations.at(-1)!.recoveredAt, undefined);
    assert.ok(f.counters.exitChecks > 0); assert.equal(f.counters.flashes, 1);
    f.setMarker(true);
    const recovered = await f.h.invoke('hardwareRecover', f.session.taskId);
    assert.equal(recovered.operations.at(-1).status, 'unknown'); assert.ok(recovered.operations.at(-1).recoveredAt);
    assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, undefined); assert.equal(f.counters.flashes, 1);
  } finally { await f.cleanup(); }
});

test('recovery state persistence failure retains owner even after a confirmed lock cleanup', async () => {
  const f = await fixture();
  try {
    const run = await f.unknown();
    const internals = f.embedded as unknown as { persist: typeof durableJson };
    const persist = internals.persist;
    internals.persist = async (file, ...args) => {
      if (file.endsWith('state.json')) throw new Error('Injected recovery state write failure');
      return persist(file, ...args);
    };
    await assert.rejects(f.h.invoke('hardwareRecover', f.session.taskId), /recovery state write failure/);
    const held = (await f.h.snapshot()).hardwareAgent!;
    assert.equal(held.activeRunId, run.runId); assert.equal(held.runs[0].hardwareBusy, true);
    await assert.rejects(f.h.invoke('hardwareLeaveMode'), /HARDWARE_AGENT_ACTIVE/);
    assert.equal((await f.embedded.status(f.session.taskId)).operations.at(-1)!.recoveredAt, undefined);
    internals.persist = persist;
    await f.h.invoke('hardwareRecover', f.session.taskId);
    assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, undefined); assert.equal(f.counters.flashes, 1);
  } finally { await f.cleanup(); }
});

test('recovery rejects an active planner and a different task before invoking embedded recovery', async () => {
  const f = await fixture();
  try {
    const other = await f.h.invoke('createSession', f.session.projectId, 'Other recovery owner');
    const run = await f.start(); const count = f.counters.recoveries;
    await assert.rejects(f.h.invoke('hardwareRecover', f.session.taskId), /NOT_QUIESCENT/);
    await assert.rejects(f.h.invoke('hardwareRecover', other.taskId), /OWNER_MISMATCH/);
    assert.equal(f.counters.recoveries, count); assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, run.runId);
    await f.h.invoke('hardwareAgentStop', run.runId);
  } finally { await f.cleanup(); }
});

test('recovery cannot overlap a still-pending native dialog after planning stops', async () => {
  const f = await fixture(); let answer!: (value: { response: number; checkboxChecked: boolean }) => void;
  try {
    const run = await f.throughInspect(); let opened = false;
    f.h.dialog.showMessageBox = async () => { opened = true; return new Promise(resolve => { answer = resolve; }); };
    const pending = f.h.restrictedEngine!.toolCall('embedded_request_flash'); await until(() => opened);
    await f.h.invoke('hardwareAgentStop', run.runId); const count = f.counters.recoveries;
    await assert.rejects(f.h.invoke('hardwareRecover', f.session.taskId), /NOT_QUIESCENT/);
    assert.equal(f.counters.recoveries, count); assert.equal(f.counters.flashes, 0);
    answer({ response: 0, checkboxChecked: false }); await pending;
    await until(() => f.h.restrictedEngine!.state === 'stopped');
    for (let attempt = 0; attempt < 100 && (await f.h.snapshot()).hardwareAgent!.activeRunId; attempt++) await delay(10);
    assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, undefined);
  } finally { answer?.({ response: 0, checkboxChecked: false }); await f.cleanup(); }
});

test('recovery cannot overlap an unreturned hardware worker and never cancels or replays it', { timeout: 30000 }, async t => {
  async function waitForFixture<T>(work: Promise<T>, milliseconds: number, failure: string, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(failure)), milliseconds);
        abort = () => reject(new Error('Fixture wait aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  async function requireWorkerEntry(entered: Promise<void>, pending: Promise<unknown>, signal: AbortSignal): Promise<void> {
    await waitForFixture(Promise.race([entered, pending.then(result => {
      throw new Error(`Tool settled before fixture entry: ${JSON.stringify(result)}`);
    }, error => { throw new Error(`Tool rejected before fixture entry: ${String(error)}`); })]),
    30000, 'Fixture worker entry not observed', signal);
  }
  const f = await fixture(); let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  let pending: Promise<unknown> | undefined;
  try {
    const run = await f.throughInspect();
    f.setFlash(async () => { entered(); await releasePromise;
      return { status: 'unknown', processExited: true, detail: 'Synthetic worker settled after stop' }; });
    pending = f.h.restrictedEngine!.toolCall('embedded_request_flash');
    await requireWorkerEntry(enteredPromise, pending, t.signal);
    await f.h.invoke('hardwareAgentStop', run.runId); const count = f.counters.recoveries;
    await assert.rejects(f.h.invoke('hardwareRecover', f.session.taskId), /NOT_QUIESCENT/);
    assert.equal(f.counters.recoveries, count); assert.equal(f.counters.flashes, 1); assert.equal(existsSync(f.lock), true);
    release(); await waitForFixture(pending, 30000, 'Fixture worker settlement not observed', t.signal);
    await f.h.invoke('hardwareRecover', f.session.taskId);
    assert.equal(f.counters.flashes, 1); assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, undefined);
  } finally {
    release();
    // Unknown settlement retains the fixture rather than deleting an active operation.
    if (pending) await waitForFixture(pending.then(() => undefined, () => undefined), 5000,
      `Fixture cleanup unknown; retained ${f.h.directory}`);
    await f.cleanup();
  }
});

test('runtime integrity refusal leaves the stopped owner and probe lock held', async () => {
  const f = await fixture();
  try {
    const run = await f.unknown(); const count = f.counters.recoveries; f.setRuntimeFailure(true);
    await assert.rejects(f.h.invoke('hardwareRecover', f.session.taskId), /runtime integrity refusal/);
    assert.equal(f.counters.recoveries, count); assert.equal(existsSync(f.lock), true);
    assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, run.runId); assert.equal(f.counters.flashes, 1);
  } finally { await f.cleanup(); }
});

test('unconfirmed engine exit blocks recovery and an explicit later stop retry can confirm it', async () => {
  const f = await fixture();
  try {
    const run = await f.throughInspect();
    await f.h.restrictedEngine!.toolCall('embedded_request_flash');
    const engine = f.h.restrictedEngine!;
    engine.stopBehavior = async () => { engine.state = 'failed'; throw new Error('Synthetic engine exit unconfirmed'); };
    await assert.rejects(f.h.invoke('hardwareAgentStop', run.runId), /exit unconfirmed/);
    const count = f.counters.recoveries;
    await assert.rejects(f.h.invoke('hardwareRecover', f.session.taskId), /exit unconfirmed/);
    assert.equal(f.counters.recoveries, count); assert.equal(existsSync(f.lock), true);
    assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, run.runId);
    const starts = engine.startCalls, sends = engine.sendCalls;
    engine.stopBehavior = async () => {};
    await f.h.invoke('hardwareRecover', f.session.taskId);
    assert.equal(engine.state, 'stopped'); assert.equal(engine.startCalls, starts); assert.equal(engine.sendCalls, sends);
    assert.equal(f.counters.flashes, 1); assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, undefined);
  } finally { await f.cleanup(); }
});

for (const releaseTiming of ['after-first-finalizer', 'same-tick'] as const) {
  test(`early terminal at completed final-save waits for quiescence and finalizes exactly once: ${releaseTiming}`, async () => {
    let held = false; let release!: () => void;
    const f = await fixture(async (from, to) => {
      if (!to.includes(`${path.sep}hardware-agent${path.sep}`)) return;
      const envelope = JSON.parse(await readFile(from, 'utf8'));
      if (envelope.payload.status === 'completed' && envelope.payload.hardwareBusy === false && !held) {
        held = true; await new Promise<void>(resolve => { release = resolve; });
      }
    });
    try {
      f.setFlash(async () => ({ status: 'succeeded', processExited: true, receipt: '{"offline":true}' }));
      f.setVerify(async () => ({ status: 'succeeded', processExited: true, receipt: '{"offline":true}' }));
      const run = await f.throughInspect();
      for (const tool of ['embedded_request_flash', 'embedded_verify']) assert.equal((await f.h.restrictedEngine!.toolCall(tool)).ok, true);
      const pending = f.h.restrictedEngine!.toolCall('embedded_export'); await until(() => held);
      const before = await f.h.snapshot();
      assert.equal(before.hardwareAgent!.runs[0].status, 'completed');
      assert.equal(before.hardwareAgent!.runs[0].stopRequested, false);
      const engine = f.h.restrictedEngine!;
      engine.emit('turn/completed', { threadId: run.threadId, turn: { id: 'hardware-turn-1', status: 'completed' } });
      if (releaseTiming === 'after-first-finalizer') {
        await delay(25);
        assert.equal(engine.stopCalls, 0); assert.equal((await f.h.snapshot()).hardwareAgent!.activeRunId, run.runId);
      }
      release(); assert.equal((await pending).ok, true);
      for (let attempt = 0; attempt < 100 && (await f.h.snapshot()).hardwareAgent!.activeRunId; attempt++) await delay(10);
      const after = await f.h.snapshot();
      assert.equal(after.hardwareAgent!.activeRunId, undefined); assert.equal(after.hardwareAgent!.runs[0].status, 'completed');
      assert.equal(engine.stopCalls, 1); assert.equal(engine.startCalls, 1); assert.equal(engine.sendCalls, 1);
      assert.equal(f.counters.flashes, 1); assert.equal(f.counters.verifications, 1);
    } finally { release?.(); await f.cleanup(); }
  });
}
