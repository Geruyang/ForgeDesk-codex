import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { keilBuildCommand } from './keil-command.js';
import { GESTURESCREEN_PROFILE as PROFILE } from './profile.js';

test('Keil batch command adds only the documented GUI suppression option to the original build chain', () => {
  const executable = path.resolve('tests/.tmp/pinned Keil/UV4.exe');
  const snapshot = path.resolve('tests/.tmp/snapshot with spaces');
  const logPath = path.resolve('tests/.tmp/operation with spaces/keil-build.log');
  const command = keilBuildCommand(executable, snapshot, logPath);
  assert.equal(command.executable, executable);
  assert.deepEqual(command.args, ['-b', path.join(snapshot, PROFILE.uvprojx), '-j0', '-t', PROFILE.target, '-o', logPath]);
  assert.deepEqual(command.args.filter(arg => arg !== '-j0'), ['-b', path.join(snapshot, PROFILE.uvprojx), '-t', PROFILE.target, '-o', logPath]);
  assert.equal(command.cwd, path.join(snapshot, 'MDK-ARM'));
  assert.equal(command.timeoutMs, 180000);
  assert.equal(command.args.filter(arg => arg === '-j0').length, 1);
  assert.equal(command.args.includes('-f'), false, 'Batch compilation must never become a download command');
});

test('Keil command retains separated arguments and refuses PATH-relative or NUL-containing paths', () => {
  const absolute = path.resolve('tests/.tmp/absolute');
  for (const relative of [['UV4.exe', absolute, absolute], [absolute, 'snapshot', absolute], [absolute, absolute, 'build.log']]) {
    assert.throws(() => keilBuildCommand(relative[0], relative[1], relative[2]), /absolute/);
  }
  for (let index = 0; index < 3; index++) {
    const values = [absolute, absolute, absolute]; values[index] += '\0';
    assert.throws(() => keilBuildCommand(values[0], values[1], values[2]), /NUL/);
  }
});
