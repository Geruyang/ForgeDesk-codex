import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSecondDesktop, assertSnapshotNodeVersion, deriveSnapshotScope, prepareSnapshotScope, primarySid, type DesktopIdentity } from './helpers/snapshot-smoke-scope';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = 'snapshot-1791970592002';
const sid = 'S-1-5-21-1196670755-766692816-2897134863-1006';
const identity = (): DesktopIdentity => ({ sid, account: 'TEST-HOST\\ForgeDeskTest', sessionId: 2, interactive: true, elevated: false, platformSids: [], explorerOwners: [{ sid, sessionId: 2 }], applications: [] });
const secondEnvironment = () => ({ FORGEDESK_SNAPSHOT_SECOND_USER: '1', FORGEDESK_SNAPSHOT_REAL_MODEL: '1' });

test('primary default and installed smoke paths retain the original scope', () => {
  const development = deriveSnapshotScope(root, {}, runId);
  assert.equal(development.dataDir, path.join(root, '.runtime/qa-snapshot', runId, 'data'));
  assert.equal(development.workspace, path.join(root, '.runtime/qa-snapshot', runId, 'workspace'));
  assert.equal(development.output, path.join(root, 'output/playwright/snapshot/development', runId));
  const installed = deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_REAL_MODEL: '1', FORGEDESK_SNAPSHOT_INSTALLED_EXE: path.join(root, 'install/ForgeDesk.exe') }, runId);
  assert.equal(installed.dataDir, path.join(root, '.runtime/app'));
  assert.equal(installed.output, path.join(root, 'output/playwright/snapshot/installed', runId));
  assert.equal(installed.secondUser, false);
});

test('eligible fixture derives only exact kit SID paths, never primary product data', () => {
  const scope = deriveSnapshotScope(root, secondEnvironment(), runId, identity());
  assert.equal(scope.installed, path.join(root, 'output/second-user', sid, 'install/ForgeDesk.exe'));
  assert.equal(scope.dataDir, path.join(root, '.runtime/second-user', sid, 'data'));
  assert.equal(scope.workspace, path.join(root, '.runtime/second-user', sid, 'snapshot', runId, 'workspace'));
  assert.equal(scope.output, path.join(root, 'output/second-user', sid, 'evidence/snapshot', runId));
  assert.ok(!scope.workspace.startsWith(scope.dataDir + path.sep));
  assert.ok(!scope.dataDir.startsWith(scope.runtime + path.sep));
  assert.equal(scope.userScope.includes(sid), true);
});

test('identity fixtures never substitute for real second-user acceptance', () => {
  assert.throws(() => deriveSnapshotScope(root, secondEnvironment(), runId), /actual Windows identity/);
  assert.throws(() => assertSecondDesktop({ ...identity(), sid: primarySid }), /primary Windows user/);
  assert.throws(() => assertSecondDesktop({ ...identity(), sid: 'S-1-5-21-1-2-3-1002' }), /RID 1002/);
  assert.throws(() => assertSecondDesktop({ ...identity(), sid: 'S-1-5-18' }), /real Windows user SID/);
});

test('platform account names and independently observed platform SIDs fail closed', () => {
  for (const account of ['HOST\\CodexSandboxOffline', 'HOST\\CODEXSANDBOXONLINE']) assert.throws(() => assertSecondDesktop({ ...identity(), account }), /platform sandbox identities/);
  assert.throws(() => assertSecondDesktop({ ...identity(), platformSids: [sid] }), /platform sandbox SID/);
});

test('interactive Explorer owner and session must match the current non-elevated identity', () => {
  for (const changed of [{ interactive: false }, { sessionId: 0 }, { elevated: true }, { explorerOwners: [] }, { explorerOwners: [{ sid: primarySid, sessionId: 2 }] }, { explorerOwners: [{ sid, sessionId: 3 }] }]) {
    assert.throws(() => assertSecondDesktop({ ...identity(), ...changed }), /BLOCKED/);
  }
});

test('second-user product and engine ambient overrides are rejected before any filesystem workflow', () => {
  for (const key of ['FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE']) assert.throws(() => deriveSnapshotScope(root, { ...secondEnvironment(), [key]: path.join(root, '.runtime/app') }, runId, identity()), /ambient/);
  for (const key of ['FORGEDESK_SNAPSHOT_DATA_DIR', 'FORGEDESK_SNAPSHOT_OUTPUT', 'FORGEDESK_SNAPSHOT_SID', 'FORGEDESK_SNAPSHOT_WORKSPACE']) assert.throws(() => deriveSnapshotScope(root, { ...secondEnvironment(), [key]: '..' }, runId, identity()), /Unsupported snapshot override/);
});

test('second-user install cannot redirect to primary, another SID or a foreign executable', () => {
  for (const filename of [path.join(root, 'install/ForgeDesk.exe'), path.join(root, 'output/second-user', primarySid, 'install/ForgeDesk.exe'), path.join(root, 'output/second-user', sid, 'install/ForgeDesk.exe')]) {
    assert.throws(() => deriveSnapshotScope(root, { ...secondEnvironment(), FORGEDESK_SNAPSHOT_INSTALLED_EXE: filename }, runId, identity()), /cannot be overridden/);
  }
  assert.throws(() => deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_INSTALLED_EXE: path.join(root, '..', 'outside/ForgeDesk.exe') }, runId), /escapes/);
  assert.throws(() => deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_INSTALLED_EXE: 'relative/ForgeDesk.exe' }, runId), /absolute/);
  assert.throws(() => deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_INSTALLED_EXE: path.join(root, 'install/not-forgedesk.exe') }, runId), /must be ForgeDesk.exe/);
});

test('invalid modes and run identifiers cannot create an alternate scope', () => {
  assert.throws(() => deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_SECOND_USER: 'yes' }, runId, identity()), /Invalid second-user mode/);
  assert.throws(() => deriveSnapshotScope(root, { FORGEDESK_SNAPSHOT_SECOND_USER: '1' }, runId, identity()), /real-model mode/);
  assert.throws(() => deriveSnapshotScope(root, secondEnvironment(), '../escape', identity()), /run identifier/);
});

test('second-user native workflow supports only Node 24.12 through 24.x', () => {
  for (const version of ['24.12.0', '24.21.0', '24.99.1']) assert.doesNotThrow(() => assertSnapshotNodeVersion(version));
  for (const version of ['23.20.0', '24.0.0', '24.11.9', '25.0.0', '26.1.0', 'invalid']) assert.throws(() => assertSnapshotNodeVersion(version), /other major versions are unsupported/);
});

test('scope preparation rejects an installed-directory junction without launching an app', async () => {
  const base = path.join(root, '.runtime/qa-snapshot-scope-tests'); await mkdir(base, { recursive: true });
  const fixture = await mkdtemp(path.join(base, 'run-'));
  try {
    const project = path.join(fixture, 'project'); const external = path.join(fixture, 'external');
    await mkdir(project); await mkdir(external);
    await symlink(external, path.join(project, 'install'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(prepareSnapshotScope(project, { FORGEDESK_SNAPSHOT_INSTALLED_EXE: path.join(project, 'install/ForgeDesk.exe') }, runId), /Reparse point/);
  } finally {
    const relative = path.relative(base, fixture); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(fixture, { recursive: true, force: true });
  }
});
