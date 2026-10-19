import { readFile, writeFile, mkdir, lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const product = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(product, '../../..');
const destination = path.join(product, 'resources');
const semantic = path.join(project, 'output/hardware/2026-10-16-next/semantic');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [
  'run.sh', 'config.example.json',
  ...['__init__.py', 'board_agent.py', 'board_runtime.py', 'boot_units.py', 'camera.py', 'contract.py', 'cpu_clock_service.py', 'frequency.py',
    'hardware_monitor.py', 'image_boundary.py', 'link_setup.py', 'prefetch.py', 'protocol.py', 'r5_bridge.py', 'r5_start.py', 'recent_fps.py',
    'semantic-contract.json', 'state.py', 'upload_source.py'].map(name => `vision_app/${name}`),
  ...['worker.c', 'tcm_io.c', 'tcm.ld', 'tcm-split-overlay.dts', 'start.S', 'build.ps1'].map(name => `vision_app/r5/${name}`),
  ...['fz3b-vision-console.service', 'fz3b-pl-loader.service', 'fz3b-app-r5.service', 'fz3b-app-cpu-clock.service'].map(name => `services/${name}`),
];
async function readTrusted(file) {
  for (let current = file; ; current = path.dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Reparse resource input rejected');
    if (current === path.dirname(current)) break;
  }
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1048576 || path.resolve(await realpath(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('Untrusted resource input');
  return readFile(file);
}
const entries = new Map();
for (const relative of sourceFiles) entries.set(`ps-src/${relative}`, await readTrusted(path.join(project, 'engineering/fz3b/source/PS', relative)));
for (const name of ['input.jpg', 'predeclared.json', 'input-manifest.json', 'text-features.f32', 'query-template.json', 'host-reference.json', 'encoding-manifest.json', 'host-fixture.json']) {
  entries.set(`fixture/${name}`, await readTrusted(path.join(semantic, 'fixture-v1', name)));
}
entries.set('remote/remote.py', await readTrusted(path.join(product, 'remote.py')));
entries.set('remote/reconciliation.py', await readTrusted(path.join(product, 'reconciliation.py')));
entries.set('remote/wire.py', await readTrusted(path.join(project, 'engineering/fz3b/tools/fixed_tcp_acceptance.py')));
for (const name of ['LICENSE', 'LICENSE_MODELS']) entries.set(`licenses/MobileCLIP-${name}.txt`, await readTrusted(path.join(semantic, 'assets/models/official-mobileclip', name)));
entries.set('known_hosts', Buffer.from('169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ\n'));
entries.set('PACKAGE_PROVENANCE.json', Buffer.from(JSON.stringify({ schemaVersion: 1,
  scope: 'Fixed approved PS acceptance-package inputs, not Vivado or a deployable PL rebuild',
  upstreamCommit: '59cdbefade2535dbeea9a34d1658a307ab7f3bb7', approvedDeploymentManifestSha256: 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09',
  modelLicense: 'Research-only; embedded features do not grant commercial model rights', newPlBuilt: false, deployed: false,
  sourceFiles: sourceFiles.map(relative => ({ path: relative, sha256: digest(entries.get(`ps-src/${relative}`)) })) }, null, 2) + '\n'));
await mkdir(destination, { recursive: true });
async function inventory(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name);
    if (item.isSymbolicLink()) throw new Error('Output resource link rejected');
    if (item.isDirectory()) result.push(...await inventory(absolute));
    else result.push(path.relative(destination, absolute).split(path.sep).join('/'));
  }
  return result;
}
for (const relative of await inventory(destination)) if (relative !== 'manifest.json' && !entries.has(relative)) throw new Error(`Unexpected output resource: ${relative}`);
for (const [relative, bytes] of entries) {
  const file = path.join(destination, relative); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, scope: 'fixed-fz3b-product-resources-v1',
  sourceManifestSha256: 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09',
  files: [...entries].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([relative, bytes]) => ({ path: relative, bytes: bytes.length, sha256: digest(bytes) })) }, null, 2) + '\n');
await writeFile(path.join(destination, 'manifest.json'), manifest);
process.stdout.write(JSON.stringify({ files: entries.size, manifestSha256: digest(manifest), destination }) + '\n');
