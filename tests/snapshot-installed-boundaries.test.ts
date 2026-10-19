import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertBoundaryObservations, assertInstalledSandboxArgs, assertNaturalSnapshotCompletion, boundaryTargets, installedFixtureEnvironment,
  isolatedNativeEnvironment, reviewedInstalledSandboxArgs, trustBootstrappedFixture, type BoundaryHostObservation } from './helpers/snapshot-installed-boundaries';

test('installed boundary observer accepts only the exact recorded fixed profile arguments', () => {
  assertInstalledSandboxArgs([...reviewedInstalledSandboxArgs]);
  for (const altered of [reviewedInstalledSandboxArgs.slice(0, -1), [...reviewedInstalledSandboxArgs, '-c', 'extra=true'],
    reviewedInstalledSandboxArgs.map(value => value === 'forgedesk_workspace_v1' ? ':workspace' : value),
    reviewedInstalledSandboxArgs.map(value => value === 'sandbox_workspace_write.writable_roots=[]' ? 'sandbox_workspace_write.writable_roots=["E:/extra"]' : value)]) {
    assert.throws(() => assertInstalledSandboxArgs(altered));
  }
});

test('successful natural snapshot close requires not-needed cleanup, zero exit and no signal', () => {
  const actualNaturalContract = { status: 'succeeded', cleanup: 'not-needed', exitCode: 0, signal: null };
  assertNaturalSnapshotCompletion(actualNaturalContract);
  for (const patch of [{ cleanup: 'confirmed' }, { cleanup: 'unconfirmed' }, { exitCode: 1 }, { signal: 'SIGTERM' },
    { status: 'interrupted' }, { exitCode: undefined }, { signal: undefined }]) {
    assert.throws(() => assertNaturalSnapshotCompletion({ ...actualNaturalContract, ...patch }));
  }
});

test('fixture trust is appended after bootstrap and preserves its exact managed bytes without exposing them', async () => {
  const order: string[] = []; const engineeringRoot = path.resolve('output/fixture/data/engineering');
  const managed = Buffer.from('# ForgeDesk-managed product configuration.\n[mcp_servers.engineering.env]\nFORGEDESK_RUNNER_TOKEN="fixture-private-value"\n');
  let bytes = Buffer.from('[projects."pre-launch-value-that-bootstrap-overwrites"]\ntrust_level="trusted"\n');
  const result = await trustBootstrappedFixture({ engineeringRoot,
    launch: async () => { order.push('launch'); bytes = Buffer.from(managed); },
    read: async () => { order.push('read'); return Buffer.from(bytes); },
    append: async suffix => { order.push('append'); bytes = Buffer.concat([bytes, suffix]); } });
  assert.deepEqual(order, ['launch', 'read', 'append', 'read']);
  assert.equal(bytes.subarray(0, managed.length).equals(managed), true);
  assert.equal(result.beforeSha256, createHash('sha256').update(managed).digest('hex'));
  assert.equal(result.trustKey, engineeringRoot.toLowerCase()); assert.equal(result.managedPrefixPreserved, true);
  assert.equal(JSON.stringify(result).includes('fixture-private-value'), false);
});

test('fixture trust refuses unexpected bootstrap, prior trust, or changed prefix before issuing a proof', async () => {
  for (const initial of ['not a product config', '# ForgeDesk-managed product configuration.\n[projects."existing"]\ntrust_level="trusted"\n']) {
    let appended = false;
    await assert.rejects(trustBootstrappedFixture({ engineeringRoot: path.resolve('output/fixture'), launch: async () => {},
      read: async () => Buffer.from(initial), append: async () => { appended = true; } }));
    assert.equal(appended, false);
  }
  let bytes = Buffer.from('# ForgeDesk-managed product configuration.\n');
  await assert.rejects(trustBootstrappedFixture({ engineeringRoot: path.resolve('output/fixture'), launch: async () => {},
    read: async () => Buffer.from(bytes), append: async suffix => { bytes = Buffer.concat([Buffer.from('changed-prefix'), suffix]); } }), /changed the managed prefix/);
});

test('fresh installed fixture removes ambient auth, model, Node and Git routing overrides', () => {
  const source = { PATH: 'path', GIT_DIR: 'foreign', git_work_tree: 'foreign', GIT_INDEX_FILE: 'foreign',
    CODEX_HOME: 'private', FORGEDESK_DATA_DIR: 'real-data', forgedesk_snapshot_real_model: '1',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=foreign', NODE_PATH: 'foreign', TEMP: 'foreign', TMP: 'foreign' };
  const env = installedFixtureEnvironment(source, 'fixture-data', 'fixture-temp', 'fixture-tmp');
  assert.deepEqual(env, { PATH: 'path', FORGEDESK_DATA_DIR: 'fixture-data', TEMP: 'fixture-temp', TMP: 'fixture-tmp',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL' });
  assert.deepEqual(isolatedNativeEnvironment({ ...source, AUTHORIZATION: 'private', OPENAI_API_KEY: 'private' }, 'home', 'temp', 'tmp'),
    { PATH: 'path', CODEX_HOME: 'home', TEMP: 'temp', TMP: 'tmp', ELECTRON_RUN_AS_NODE: '1' });
});

test('independent boundary checks reject partial SQLite creation, cleanup failure, false denial and missing targets', () => {
  const targets = boundaryTargets('E:/fixture/cwd', 'E:/fixture/temp', 'E:/fixture/tmp', 'E:/fixture/private', '11111111-1111-1111-1111-111111111111');
  const child = targets.map(t => ({ kind: t.kind, fs: { created: t.allowed, ...(t.allowed ? {} : { errorCode: 'EPERM' }) },
    sqlite: { opened: t.allowed, written: t.allowed, ...(t.allowed ? {} : { openErrorCode: 'ERR_SQLITE_ERROR' }) } }));
  const host: BoundaryHostObservation[] = targets.map(t => ({ kind: t.kind, markerPresent: t.allowed, markerMatches: t.allowed,
    databasePresent: t.allowed, sqliteHeader: t.allowed, auxiliaryPresent: [], hostPositiveControl: true, cleanupComplete: true }));
  assertBoundaryObservations(targets, child, host);
  for (const patch of [{ databasePresent: true }, { auxiliaryPresent: ['-journal'] }, { hostPositiveControl: false }, { cleanupComplete: false }]) {
    const altered = structuredClone(host); Object.assign(altered[1], patch);
    assert.throws(() => assertBoundaryObservations(targets, child, altered));
  }
  const falseDenial = structuredClone(child); falseDenial[1].sqlite.opened = true;
  assert.throws(() => assertBoundaryObservations(targets, falseDenial, host));
  assert.throws(() => assertBoundaryObservations(targets, child.slice(1), host));
  const wrongStage = structuredClone(child); wrongStage[1].sqlite.openErrorCode = undefined; Object.assign(wrongStage[1].sqlite, { writeErrorCode: 'ERR_SQLITE_ERROR' });
  assert.throws(() => assertBoundaryObservations(targets, wrongStage, host));
});
