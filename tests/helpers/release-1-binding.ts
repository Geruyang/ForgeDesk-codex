import assert from 'node:assert/strict';
import path from 'node:path';
import { extractFile } from '@electron/asar';
import { ROOT, SHA, sha, closed, assertPins, assertInstallerPin, hashStable, readStable, treePins, type Pin } from './release-1-files';

export const RELEASE_PATH = 'output/release-1.0/package-audit/RELEASE_MANIFEST.json';
export const VALIDATOR_PATH = 'scripts/release-package-audit.mjs';
export const BUNDLES = ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.js', 'dist/renderer/index.css', 'dist/renderer/index.html', 'dist/mcp/index.cjs'];
export interface ReleaseManifest {
  schema: 'forgedesk-release-package-audit-v1'; version: '1.0.0'; appId: 'dev.forgedesk.codex';
  sourceFreeze: { packageSha256: string; lockSha256: string; auditSourceSha256: string; buildSourceSha256: string; assetApproval: {path: 'output/release-1.0/ASSET_DISTRIBUTION_APPROVAL.json'; sha256: string}; resourceManifestPins: { path: string; sha256: string }[]; resourceTransforms: { path: 'resources/codex/manifest.json'; sourceSha256: string; packagedSha256: string; method: 'codex-public-source-only-v1' }[] };
  artifacts: Pin[]; unpacked: { path: string; files: Pin[] }; resources: Pin[]; bundles: Pin[];
  qualification: { packageInventoryVerified: true; installationVerified: false; softwareAccepted: false; deviceQualified: false; releaseAuthorized: false };
}
export interface InstallInventory { schemaVersion: 1; scope: 'release-1-installed-inventory-v1'; releaseManifestSha256: string; extras: Pin[] }
export interface Release { version: '1.0.0'; candidateSha256: string; installedInventoryPath: string; installedInventorySha256: string; electronVersion: string; manifest: ReleaseManifest }

export function assertInstalledInventory(v: any, releaseSha256: string): asserts v is InstallInventory {
  closed(v, ['schemaVersion', 'scope', 'releaseManifestSha256', 'extras']); assert.equal(v.schemaVersion, 1); assert.equal(v.scope, 'release-1-installed-inventory-v1'); assert.equal(v.releaseManifestSha256, releaseSha256);
  assert.ok(Array.isArray(v.extras) && v.extras.length <= 2); if (v.extras.length) assertPins(v.extras);
  for (const p of v.extras) assert.ok(['Uninstall ForgeDesk.exe', '.install-scope.json'].includes(p.path), 'Unreviewed installed addition');
}
export function assertReleaseShape(v: any): asserts v is ReleaseManifest {
  closed(v, ['schema', 'version', 'appId', 'sourceFreeze', 'artifacts', 'unpacked', 'resources', 'bundles', 'qualification']);
  assert.equal(v.schema, 'forgedesk-release-package-audit-v1'); assert.equal(v.version, '1.0.0'); assert.equal(v.appId, 'dev.forgedesk.codex');
  closed(v.sourceFreeze, ['packageSha256', 'lockSha256', 'auditSourceSha256', 'buildSourceSha256', 'assetApproval', 'resourceManifestPins', 'resourceTransforms']);
  closed(v.sourceFreeze.assetApproval, ['path', 'sha256']); assert.equal(v.sourceFreeze.assetApproval.path, 'output/release-1.0/ASSET_DISTRIBUTION_APPROVAL.json'); assert.match(v.sourceFreeze.assetApproval.sha256, SHA);
  for (const key of ['packageSha256', 'lockSha256', 'auditSourceSha256', 'buildSourceSha256']) assert.match(v.sourceFreeze[key], SHA);
  closed(v.unpacked, ['path', 'files']); assert.equal(v.unpacked.path, 'release/win-unpacked');
  for (const rows of [v.unpacked.files, v.resources, v.bundles]) assertPins(rows);
  assert.ok(Array.isArray(v.artifacts) && Object.getPrototypeOf(v.artifacts) === Array.prototype); assert.equal(v.artifacts.length, 1); assertInstallerPin(v.artifacts[0]);
  for (const name of BUNDLES) assert.ok(v.bundles.some((p: Pin) => p.path === name));
  assert.ok(v.unpacked.files.some((p: Pin) => p.path === 'ForgeDesk.exe')); assert.ok(v.unpacked.files.some((p: Pin) => p.path === 'resources/app.asar'));
  const resources = v.unpacked.files.filter((p: Pin) => p.path.startsWith('resources/'));
  assert.deepEqual([...v.resources].sort((a: Pin, b: Pin) => a.path.localeCompare(b.path)), [...resources].sort((a: Pin, b: Pin) => a.path.localeCompare(b.path)));
  for (const p of v.resources) assert.deepEqual(v.unpacked.files.find((f: Pin) => f.path === p.path), p);
  assert.ok(Array.isArray(v.sourceFreeze.resourceTransforms) && v.sourceFreeze.resourceTransforms.length === 1);
  const transform = v.sourceFreeze.resourceTransforms[0]; closed(transform, ['path', 'sourceSha256', 'packagedSha256', 'method']);
  assert.equal(transform.path, 'resources/codex/manifest.json'); assert.equal(transform.method, 'codex-public-source-only-v1'); assert.match(transform.sourceSha256, SHA); assert.match(transform.packagedSha256, SHA);
  assert.equal(v.resources.find((p: Pin) => p.path === transform.path)?.sha256, transform.packagedSha256);
  closed(v.qualification, ['packageInventoryVerified', 'installationVerified', 'softwareAccepted', 'deviceQualified', 'releaseAuthorized']);
  assert.deepEqual(v.qualification, { packageInventoryVerified: true, installationVerified: false, softwareAccepted: false, deviceQualified: false, releaseAuthorized: false });
}
export function assertExactInventory(expected: Pin[], actual: Pin[]) {
  assertPins(expected); assertPins(actual); const order = (a: Pin, b: Pin) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  assert.deepEqual([...actual].sort(order), [...expected].sort(order));
}
export async function readRelease(pin: string): Promise<ReleaseManifest> {
  assert.match(pin, SHA); const raw = await readStable(path.join(ROOT, RELEASE_PATH), 8 * 1024 * 1024); assert.equal(sha(raw), pin);
  const value = JSON.parse(raw.toString('utf8')); assertReleaseShape(value);
  // Execute the captured, externally manifest-bound validator bytes, not a second named read.
  const source = await readStable(path.join(ROOT, VALIDATOR_PATH)); assert.equal(sha(source), value.sourceFreeze.auditSourceSha256);
  const validator = await import('data:text/javascript;base64,' + source.toString('base64'));
  assert.equal(typeof validator.validateReleaseManifest, 'function'); assert.deepEqual(validator.validateReleaseManifest(value), value);
  for (const [file, digest] of [['package.json', value.sourceFreeze.packageSha256], ['package-lock.json', value.sourceFreeze.lockSha256], ['scripts/build.mjs', value.sourceFreeze.buildSourceSha256]] as const) assert.equal(sha(await readStable(path.join(ROOT, file), 8 * 1024 * 1024)), digest);
  assert.equal(sha(await readStable(path.join(ROOT, 'vendor/codex/manifest.json'))), value.sourceFreeze.resourceTransforms[0].sourceSha256);
  assert.equal(sha(await readStable(path.join(ROOT, value.sourceFreeze.assetApproval.path), 4096)), value.sourceFreeze.assetApproval.sha256);
  for (const p of value.artifacts) await hashStable(path.join(ROOT, p.path), p);
  assertExactInventory(value.unpacked.files, await treePins(path.join(ROOT, value.unpacked.path), value.unpacked.files)); return value;
}
export async function verifyRelease(pin: string, installedInventoryPath: string, installedInventorySha256: string): Promise<Release> {
  const manifest = await readRelease(pin); assert.match(installedInventorySha256, SHA);
  assert.ok(path.isAbsolute(installedInventoryPath) && path.resolve(installedInventoryPath).startsWith(path.join(ROOT, 'output', 'release-1.0') + path.sep));
  const raw = await readStable(installedInventoryPath); assert.equal(sha(raw), installedInventorySha256); const inventory = JSON.parse(raw.toString()); assertInstalledInventory(inventory, pin);
  assertExactInventory([...manifest.unpacked.files, ...inventory.extras], await treePins(path.join(ROOT, 'install'), [...manifest.unpacked.files, ...inventory.extras]));
  const archive = path.join(ROOT, 'install/resources/app.asar'), before = await readStable(archive, 256 * 1024 * 1024);
  const pkg = JSON.parse(extractFile(archive, 'package.json').toString()); assert.equal(pkg.version, manifest.version);
  const sourcePackage = JSON.parse((await readStable(path.join(ROOT, 'package.json'))).toString()); assert.match(sourcePackage.devDependencies.electron, /^\d+\.\d+\.\d+$/);
  for (const p of manifest.bundles) { const bytes = extractFile(archive, p.path.split('/').join(path.sep)); assert.equal(bytes.length, p.bytes); assert.equal(sha(bytes), p.sha256); }
  assert.ok((await readStable(archive, 256 * 1024 * 1024)).equals(before));
  return { version: manifest.version, candidateSha256: pin, installedInventoryPath, installedInventorySha256, electronVersion: sourcePackage.devDependencies.electron, manifest };
}
