import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSourceFile, isFunctionDeclaration, ScriptTarget } from 'typescript';
import { capturePlaywrightExitListeners, detachNewPlaywrightExitHandler } from './helpers/playwright-no-kill';

function launcherHook() {
  return runInNewContext('(function exitHandler() { for (const kill of killSet) kill(); })', { killSet: new Set() }) as Function;
}

test('no-kill detachment removes only the newly introduced verified launcher hook', () => {
  const emitter = new EventEmitter(); const old = launcherHook(); const other = () => {};
  emitter.on('exit', old as () => void); emitter.on('exit', other);
  const baseline = capturePlaywrightExitListeners(emitter); const introduced = launcherHook(); const unrelated = () => {};
  emitter.on('exit', introduced as () => void); emitter.on('exit', unrelated);
  assert.deepEqual(detachNewPlaywrightExitHandler(baseline, emitter), {
    removedCount: 1, sourceVerified: true, baselineListenerCount: 2, preExistingListenersPreserved: true,
  });
  assert.deepEqual(emitter.listeners('exit'), [old, other, unrelated]);
});

test('no new launcher hook cannot be reported as successful detachment', () => {
  const emitter = new EventEmitter(); const old = launcherHook(); emitter.on('exit', old as () => void);
  const baseline = capturePlaywrightExitListeners(emitter);
  assert.throws(() => detachNewPlaywrightExitHandler(baseline, emitter), /no detachment is claimed/);
  assert.deepEqual(emitter.listeners('exit'), [old]);
});

test('unknown or duplicate launcher-shaped hooks fail without removing any listener', () => {
  const emitter = new EventEmitter(); const baseline = capturePlaywrightExitListeners(emitter);
  const unknown = function exitHandler() { return false; }; emitter.on('exit', unknown);
  assert.throws(() => detachNewPlaywrightExitHandler(baseline, emitter), /does not match/);
  assert.deepEqual(emitter.listeners('exit'), [unknown]);
  emitter.removeListener('exit', unknown); const first = launcherHook(); const second = launcherHook();
  emitter.on('exit', first as () => void); emitter.on('exit', second as () => void);
  assert.throws(() => detachNewPlaywrightExitHandler(baseline, emitter), /Exactly one new/);
  assert.deepEqual(emitter.listeners('exit'), [first, second]);
});

test('the locally installed Playwright launcher hook matches without launching any application', () => {
  const require = createRequire(import.meta.url);
  const filename = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/server/utils/processLauncher.js');
  const source = createSourceFile(filename, readFileSync(filename, 'utf8'), ScriptTarget.ES2022, true);
  const declaration = source.statements.find(statement => isFunctionDeclaration(statement) && statement.name?.text === 'exitHandler');
  assert.ok(declaration, 'The installed launcher must retain the inspected named exit handler');
  const handler = runInNewContext(`(${declaration.getText(source)})`, { killSet: new Set() });
  const emitter = new EventEmitter(); const baseline = capturePlaywrightExitListeners(emitter); emitter.on('exit', handler);
  assert.equal(detachNewPlaywrightExitHandler(baseline, emitter).removedCount, 1);
  assert.deepEqual(emitter.listeners('exit'), []);
});
