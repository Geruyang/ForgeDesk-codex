import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopHarness, until } from './desktop-harness';

test('desktop VM explicitly disables native startup history while preserving visible asynchronous main startup', async () => {
  const h = await desktopHarness();
  try {
    await until(() => h.startupHistory.readCalls === 1);
    assert.equal(h.window.isVisible(), true); assert.deepEqual(h.failures, []);
    assert.equal(h.closed().quit, false); assert.equal(h.engine.state, 'ready');
    assert.equal(h.startupHistory.factoryCalls, 1);
    const result = h.startupHistory.result;
    assert.equal(result.status, 'held'); assert.equal(result.closeConfirmed, true);
    assert.equal(result.projection.observationPhase, 'post-startup-reconciliation');
    for (const flag of ['admissionAuthorized', 'releaseAuthorized', 'newRunAuthorized', 'activeEpochAdopted',
      'currentBootEstablished', 'automaticReplay', 'strictFinalizationVerified', 'operationalQuarantineVerified'] as const)
      assert.equal(result.projection[flag], false, flag);
    assert.equal(result.projection.rows.length, 0);
    assert((await h.snapshot()).diagnostics.some(line => line.includes('Startup history diagnostic: held')));
  } finally { await h.cleanup(); }
});

test('desktop VM shutdown reuses the same native-disabled owner and keeps normal close assertions', async () => {
  const h = await desktopHarness();
  try {
    await until(() => h.startupHistory.readCalls === 1);
    let prevented = 0;
    h.window.callbacks.get('close')!({ preventDefault() { prevented++; } });
    await until(() => h.closed().quit);
    assert.equal(prevented, 1); assert.equal(h.startupHistory.factoryCalls, 1); assert.equal(h.startupHistory.readCalls, 2);
    assert.equal(h.closed().runnerClosed, true); assert.equal(h.closed().bridgeClosed, true);
    assert.equal(h.window.isDestroyed(), true); assert.equal(h.window.isVisible(), false);
    assert.deepEqual(h.failures, []);
  } finally { await h.cleanup(); }
});
