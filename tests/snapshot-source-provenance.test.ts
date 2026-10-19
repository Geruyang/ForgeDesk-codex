import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotSourceProvenance } from './helpers/snapshot-source-provenance';

test('second-user provenance does not execute any shared repository Git command', async () => {
  let calls = 0;
  const result = await snapshotSourceProvenance('shared-repository-fixture', true, async () => {
    calls++; throw new Error('A secondary user must not query the shared repository Git');
  });
  assert.equal(calls, 0);
  assert.equal(result.sourceCommit, null); assert.equal(result.sourceDirty, null);
  assert.equal(result.sourceMetadataObservation.status, 'not-observed');
  assert.match(result.sourceMetadataObservation.reason, /another Windows SID/);
  assert.match(result.sourceMetadataObservation.reason, /no current repository HEAD or dirty state is claimed/);
});

test('primary provenance retains exact repository HEAD and dirty-status queries', async () => {
  const calls: { root: string; args: string[] }[] = [];
  const result = await snapshotSourceProvenance('primary-repository-fixture', false, async (root, args) => {
    calls.push({ root, args }); return args[0] === 'rev-parse' ? 'fixture-commit\n' : ' M tests/fixture.ts\n';
  });
  assert.deepEqual(calls, [{ root: 'primary-repository-fixture', args: ['rev-parse', 'HEAD'] },
    { root: 'primary-repository-fixture', args: ['status', '--porcelain'] }]);
  assert.equal(result.sourceCommit, 'fixture-commit'); assert.equal(result.sourceDirty, true);
  assert.equal(result.sourceMetadataObservation.status, 'observed');
});

test('primary provenance preserves a clean worktree observation', async () => {
  const result = await snapshotSourceProvenance('primary-repository-fixture', false, async (_root, args) => args[0] === 'rev-parse' ? 'clean-fixture\r\n' : '\r\n');
  assert.equal(result.sourceCommit, 'clean-fixture'); assert.equal(result.sourceDirty, false);
});

test('primary repository metadata errors propagate without fabricating observations', async () => {
  for (const failedCommand of ['rev-parse', 'status']) {
    const failure = new Error(`primary ${failedCommand} fixture failure`);
    await assert.rejects(snapshotSourceProvenance('primary-repository-fixture', false, async (_root, args) => {
      if (args[0] === failedCommand) throw failure;
      return 'fixture-commit\n';
    }), error => error === failure);
  }
});
