import assert from 'node:assert/strict';
import type { AppSnapshot } from '../../packages/shared/contracts';
import type { Fz3bSemanticFixture } from '../../packages/engineering-runner/fz3b/types';
import { assertFz3bRunUnheld } from './fz3b-installed-history';

export interface Fz3bStartupCallbacks {
  snapshot(): Promise<AppSnapshot>; connect(): Promise<void>; wait(ms: number): Promise<unknown>;
  observe(value: Record<string, unknown>): Promise<void>; now?: () => number; timeoutMs?: number;
  fixture?: Fz3bSemanticFixture;
}

export function assertFz3bStartupIdle(state: AppSnapshot, fixture?: Fz3bSemanticFixture) {
  assert.equal(state.hardware.modeActive, false, 'Leave controlled mode normally before ordinary engine connection');
  assert.equal(state.hardwareAgent?.activeRunId, undefined); assert.equal(state.fz3bAgent?.activeRunId, undefined);
  assert.equal(state.fz3bAgent?.recoveryTaskId, undefined, 'A no-run recovery hold must not be repaired by startup');
  assert.ok(!state.hardwareAgent || state.hardwareAgent.engineState === 'stopped');
  assert.ok(!state.fz3bAgent || state.fz3bAgent.engineState === 'stopped');
  assert.ok(!state.hardwareAgent?.runs.some(run => run.active || run.hardwareBusy || run.nativeApproval === 'pending'));
  for (const run of state.fz3bAgent?.runs ?? []) assertFz3bRunUnheld(run, fixture);
  assert.equal(state.approvals.length, 0);
  assert.ok(state.sessions.every(session => !session.engineUncertain && !session.turnId && !['running', 'stopping'].includes(session.status)));
  assert.ok(state.tasks.every(task => task.status !== 'running' && task.operations.every(op => !['prepared', 'running', 'stopping'].includes(op.status))));
}

export async function connectFz3bInstalledStartup(callbacks: Fz3bStartupCallbacks): Promise<AppSnapshot> {
  const now = callbacks.now ?? Date.now, deadline = now() + (callbacks.timeoutMs ?? 60000);
  const summary = (state: AppSnapshot) => ({ engineState: state.engine.state, modeActive: state.hardware.modeActive,
    publicLoggedIn: state.account.loggedIn, fz3bAvailable: state.fz3bAgent?.available });
  const routingError = 'Engine account/read: workspace routing discovery timed out';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let before = await callbacks.snapshot(); assertFz3bStartupIdle(before, callbacks.fixture);
    while (before.engine.state === 'starting') {
      assert.ok(now() < deadline, 'Ordinary engine auto-start did not settle; no connect race or forced recovery attempted');
      await callbacks.wait(100); before = await callbacks.snapshot(); assertFz3bStartupIdle(before, callbacks.fixture);
    }
    assert.ok(['stopped', 'ready'].includes(before.engine.state), 'Failed/stopping engines require explicit operator review');
    await callbacks.observe({ attempt, phase: 'before-explicit-connect', summary: summary(before) });
    try {
      // Public connect is valid from stopped. Main's optional auto-connect may be skipped or fail.
      await callbacks.connect(); const after = await callbacks.snapshot(); assertFz3bStartupIdle(after, callbacks.fixture);
      assert.equal(after.engine.state, 'ready');
      await callbacks.observe({ attempt, phase: 'completed', summary: summary(after) }); return after;
    } catch (error) {
      const after = await callbacks.snapshot(); assertFz3bStartupIdle(after, callbacks.fixture);
      const message = error instanceof Error ? error.message : String(error);
      await callbacks.observe({ attempt, phase: 'failed', summary: summary(after), error: message.slice(0, 2000) });
      if (attempt !== 1 || after.engine.state !== 'ready' || ![routingError, `page.evaluate: Error: Error invoking remote method 'forgedesk:invoke': Error: ${routingError}`].includes(message)) throw error;
      await callbacks.wait(5000);
    }
  }
  throw new Error('FZ3B startup attempts exhausted');
}
