import assert from 'node:assert/strict';
import type { EventEmitter } from 'node:events';

type ExitEmitter = Pick<EventEmitter, 'listeners' | 'removeListener'>;
const launcherExitSource = 'function exitHandler() { for (const kill of killSet) kill(); }';

export function capturePlaywrightExitListeners(emitter: ExitEmitter = process): readonly Function[] {
  return [...emitter.listeners('exit')];
}

export function detachNewPlaywrightExitHandler(before: readonly Function[], emitter: ExitEmitter = process) {
  const baseline = new Set(before);
  const introduced = emitter.listeners('exit').filter(listener => !baseline.has(listener));
  const candidates = introduced.filter(listener => listener.name === 'exitHandler');
  assert.equal(candidates.length, 1, 'Exactly one new Playwright launcher exitHandler must be identified; no detachment is claimed');
  const handler = candidates[0];
  const source = Function.prototype.toString.call(handler).replace(/\s+/g, ' ').trim();
  assert.equal(source, launcherExitSource, 'New exitHandler does not match the inspected Playwright killSet cleanup implementation');
  emitter.removeListener('exit', handler as (...args: any[]) => void);
  const remaining = emitter.listeners('exit');
  assert.equal(remaining.includes(handler), false, 'Playwright launcher exit hook was not detached');
  for (const listener of before) assert.equal(remaining.includes(listener), true, 'A pre-existing exit listener changed');
  return { removedCount: 1, sourceVerified: true, baselineListenerCount: before.length, preExistingListenersPreserved: true };
}
