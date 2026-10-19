import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveSnapshotScope, primarySid, type DesktopIdentity } from './helpers/snapshot-smoke-scope';
import { approvedMissingToolsSid, assertAcceptanceUnchanged, assertMissingGitResult, assertMissingNodeResult,
  assertMissingToolsDesktop, missingToolsAppEnvironment, missingToolsGateEnvironment, missingToolsPaths } from './helpers/second-user-missing-tools';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = (): DesktopIdentity => ({ sid: approvedMissingToolsSid, account: 'FIXTURE\\ForgeDeskTest', sessionId: 2,
  interactive: true, elevated: false, platformSids: [], explorerOwners: [{ sid: approvedMissingToolsSid, sessionId: 2 }], applications: [] });

test('missing-tools entry rejects all ambient scope/identity/data overrides and arguments', () => {
  const environment = { PATH: 'original-toolchain' };
  assert.deepEqual(missingToolsGateEnvironment(environment, ['node', 'entry']), { ...environment, FORGEDESK_SNAPSHOT_SECOND_USER: '1', FORGEDESK_SNAPSHOT_REAL_MODEL: '1' });
  assert.deepEqual(environment, { PATH: 'original-toolchain' });
  for (const key of ['FORGEDESK_SNAPSHOT_SECOND_USER', 'FORGEDESK_SNAPSHOT_INSTALLED_EXE', 'FORGEDESK_MISSING_TOOLS_SID', 'FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE', 'Codex_Home']) {
    assert.throws(() => missingToolsGateEnvironment({ [key]: 'untrusted' }, ['node', 'entry']), /remove ambient/);
  }
  assert.throws(() => missingToolsGateEnvironment({}, ['node', 'entry', '--sid=1006']), /no identity, path or mode arguments/);
});

test('only approved standard SID 1006 with a matching Explorer desktop reaches the shared kit gate', () => {
  assert.doesNotThrow(() => assertMissingToolsDesktop(identity()));
  for (const change of [{ sid: primarySid }, { elevated: true }, { interactive: false }, { explorerOwners: [] },
    { platformSids: [approvedMissingToolsSid] }, { account: 'HOST\\CodexSandboxOffline' }]) {
    assert.throws(() => assertMissingToolsDesktop({ ...identity(), ...change }), /BLOCKED/);
  }
  const sid = approvedMissingToolsSid.replace(/1006$/, '1007');
  assert.throws(() => assertMissingToolsDesktop({ ...identity(), sid, explorerOwners: [{ sid, sessionId: 2 }] }), /only the approved/);
});

test('missing-tools paths retain the exact verified installed SID scope', () => {
  const scope = deriveSnapshotScope(root, missingToolsGateEnvironment({}, ['node', 'entry']), 'snapshot-1792000000000', identity());
  const paths = missingToolsPaths(scope);
  assert.equal(paths.emptyPath, path.join(scope.runtime, 'missing-tools', 'empty-path'));
  assert.equal(paths.output, path.join(root, 'output/second-user', approvedMissingToolsSid, 'evidence/missing-tools', scope.runId));
  assert.equal(path.relative(paths.workspace, paths.verifier).startsWith('..'), true);
  assert.throws(() => missingToolsPaths({ ...scope, secondUser: false }), /never supports the primary/);
});

test('child PATH fault injection preserves the parent and removes case-duplicate PATH keys', () => {
  const original = { Path: 'C:\\tools', PATH: 'C:\\alternate', SystemRoot: 'C:\\Windows' };
  const empty = path.join(root, '.runtime', 'pure-empty-path'); const data = path.join(root, '.runtime', 'pure-data');
  const child = missingToolsAppEnvironment(original, empty, data);
  assert.equal(child.PATH, empty); assert.equal(child.Path, undefined); assert.equal(child.FORGEDESK_DATA_DIR, data);
  assert.deepEqual(original, { Path: 'C:\\tools', PATH: 'C:\\alternate', SystemRoot: 'C:\\Windows' });
  assert.throws(() => missingToolsAppEnvironment({}, 'relative', data), /absolute/);
});

test('Git absence requires precise ENOENT rather than an ordinary repository failure', () => {
  assert.doesNotThrow(() => assertMissingGitResult({ rejected: true, error: '无法读取 Git 差异: Error: spawn git ENOENT' }));
  assert.throws(() => assertMissingGitResult({ rejected: true, error: '无法读取 Git 差异: fatal: not a git repository' }), /missing executable/);
  assert.throws(() => assertMissingGitResult({ rejected: false, error: '' }), /never return an empty successful diff/);
});

test('Node absence requires command-resolution rejection and unchanged acceptance state', () => {
  assert.doesNotThrow(() => assertMissingNodeResult({ rejected: true, error: 'Error invoking remote method: Executable not found: node' }));
  assert.throws(() => assertMissingNodeResult({ rejected: true, error: 'Node verifier exited 1' }));
  const before = { acceptance: [{ id: 'baseline', kind: 'manual' }], profileRevision: 1, operations: [], evidence: [], status: 'draft', updatedAt: 'fixed' };
  assert.doesNotThrow(() => assertAcceptanceUnchanged(before, structuredClone(before)));
  for (const change of [{ acceptance: [] }, { profileRevision: 2 }, { operations: [{ status: 'prepared' }] }, { evidence: [{}] }, { status: 'passed' }, { updatedAt: 'changed' }]) {
    assert.throws(() => assertAcceptanceUnchanged(before, { ...before, ...change }), /Missing-tool rejection changed task/);
  }
});
