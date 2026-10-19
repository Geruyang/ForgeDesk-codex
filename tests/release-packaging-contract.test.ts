import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('release metadata pins version 0.5.7 without changing the locked package identity', () => {
  assert.equal(manifest.version, '0.5.7');
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[''].name, manifest.name);
});

// Configuration checks cannot establish the contents or behavior of a built installer.
test('release configuration keeps private runtime and acceptance output outside packaged files', () => {
  assert.deepEqual(manifest.build.files, ['dist/**/*', 'package.json']);
  assert.deepEqual(manifest.build.extraResources, [
    { from: 'vendor/codex', to: 'codex' },
    { from: 'vendor/process-host', to: 'process-host' },
    { from: 'engineering/templates/node-software-v1', to: 'templates/node-software-v1' },
    { from: 'vendor/hardware', to: 'hardware' },
    { from: 'engineering/hardware-worker.py', to: 'hardware-worker.py' },
    { from: 'engineering/templates/gesturescreen-v1', to: 'templates/gesturescreen-v1' },
    { from: 'engineering/fz3b/product/resources', to: 'fz3b' },
    { from: 'vendor/host-acl', to: 'host-acl' },
    { from: 'vendor/host-failed-empty-intent', to: 'host-failed-empty-intent' },
  ]);
  assert.equal(manifest.build.extraFiles, undefined);
  assert.equal(manifest.main, 'dist/main/index.cjs');
});

test('release configuration retains per-user interactive NSIS installation and user data', () => {
  assert.equal(manifest.build.win.target, 'nsis');
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.oneClick, false);
  assert.equal(manifest.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(manifest.build.nsis.include, undefined, 'Custom uninstall hooks need a separate retention review');
  assert.equal(manifest.build.nsis.script, undefined, 'Custom NSIS scripts need a separate retention review');
});

test('release configuration remains the explicit Windows x64 frozen desktop route', () => {
  assert.equal(manifest.build.appId, 'dev.forgedesk.codex');
  assert.equal(manifest.build.productName, 'ForgeDesk');
  assert.equal(manifest.scripts.package, 'npm run build && electron-builder --win nsis --x64');
  assert.equal(manifest.build.artifactName, 'ForgeDesk-${version}-${arch}-setup.${ext}');
  assert.equal(manifest.build.directories.output, 'release');
});
