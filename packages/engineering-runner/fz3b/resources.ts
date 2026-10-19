import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { noLinks } from '../embedded/files.js';
import { FZ3B_PROFILE, fz3bDigest, validateFz3bFixture } from './profile.js';
import type { Fz3bSemanticFixture } from './types.js';

declare const __FORGEDESK_FZ3B_RESOURCES_SHA256__: string;
const DEVELOPMENT_MANIFEST_SHA256 = 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07';
interface Manifest { schemaVersion: 1; scope: string; sourceManifestSha256: string; files: Array<{ path: string; bytes: number; sha256: string }> }
export interface Fz3bResourceBundle { fixture: Fz3bSemanticFixture; manifestSha256: string; files: ReadonlyMap<string, Buffer> }
export async function loadFz3bResourceBundle(root: string): Promise<Fz3bResourceBundle> {
  if (!path.isAbsolute(root)) throw new Error('FZ3B_RESOURCES_ABSOLUTE_PATH_REQUIRED');
  await noLinks(root);
  const manifestFile = path.join(root, 'manifest.json'); await noLinks(manifestFile);
  const manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.nlink !== 1 || manifestInfo.size > 65536) throw new Error('FZ3B_RESOURCE_MANIFEST_SIZE');
  const raw = await readFile(manifestFile);
  const pin = typeof __FORGEDESK_FZ3B_RESOURCES_SHA256__ === 'undefined' ? DEVELOPMENT_MANIFEST_SHA256 : __FORGEDESK_FZ3B_RESOURCES_SHA256__;
  if (!/^[a-f0-9]{64}$/.test(pin) || fz3bDigest(raw) !== pin) throw new Error('FZ3B_RESOURCE_MANIFEST_PIN_MISMATCH');
  const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.scope !== 'fixed-fz3b-product-resources-v1' || manifest.sourceManifestSha256 !== FZ3B_PROFILE.deployedManifestSha256 ||
      !Array.isArray(manifest.files) || manifest.files.length < 10 || manifest.files.length > 128) throw new Error('FZ3B_RESOURCE_MANIFEST_SCHEMA');
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const file of manifest.files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,160}$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') ||
        file.path === 'manifest.json' || expected.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1048576 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('FZ3B_RESOURCE_MANIFEST_PATH');
    expected.set(file.path, file);
  }
  const files = new Map<string, Buffer>(); let total = 0;
  async function walk(directory: string) {
    await noLinks(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name); const relative = path.relative(root, absolute).split(path.sep).join('/');
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('FZ3B_RESOURCE_LINK');
      if (info.isDirectory()) { await walk(absolute); continue; }
      if (!info.isFile() || info.nlink !== 1) throw new Error('FZ3B_RESOURCE_NONREGULAR');
      if (relative === 'manifest.json') continue;
      const item = expected.get(relative);
      if (!item || info.size !== item.bytes) throw new Error('FZ3B_RESOURCE_EXTRA_OR_SIZE');
      const bytes = await readFile(absolute);
      if (bytes.length !== item.bytes || fz3bDigest(bytes) !== item.sha256) throw new Error('FZ3B_RESOURCE_HASH_MISMATCH');
      total += bytes.length; if (total > 8 * 1048576) throw new Error('FZ3B_RESOURCE_TOTAL_BUDGET');
      files.set(relative, bytes);
    }
  }
  await walk(root);
  if (files.size !== expected.size) throw new Error('FZ3B_RESOURCE_MISSING');
  const fixtureBytes = files.get('fixture/host-fixture.json');
  if (!fixtureBytes) throw new Error('FZ3B_RESOURCE_FIXTURE_MISSING');
  const fixture = JSON.parse(fixtureBytes.toString('utf8')) as Fz3bSemanticFixture; validateFz3bFixture(fixture);
  for (const [name, hash] of [['encoding-manifest.json', fixture.manifestSha256], ['query-template.json', fixture.queriesSha256], ['input.jpg', fixture.imageSha256], ['predeclared.json', fixture.predeclaredSha256]]) {
    if (!files.has(`fixture/${name}`) || fz3bDigest(files.get(`fixture/${name}`)!) !== hash) throw new Error('FZ3B_RESOURCE_FIXTURE_BINDING');
  }
  const encoding = JSON.parse(files.get('fixture/encoding-manifest.json')!.toString('utf8'));
  const query = JSON.parse(files.get('fixture/query-template.json')!.toString('utf8'));
  const features = Buffer.from(query.features_f32_b64 ?? '', 'base64');
  if (encoding.fixture_id !== fixture.id || encoding.repeat_encode_equal !== true || encoding.device_inference_run !== false ||
      JSON.stringify(encoding.text_shape) !== '[4,512]' || encoding.text_dtype !== '<f4' || encoding.text_features_sha256 !== fz3bDigest(features) ||
      !files.get('fixture/text-features.f32')?.equals(features) || query.op !== 'queries' || !Array.isArray(query.items) ||
      JSON.stringify(query.items.map((item: { id: string }) => item.id)) !== JSON.stringify(fixture.queryIds) || features.length !== 8192 ||
      query.identity?.contract_id !== fixture.encoderIdentity.contractId || query.identity?.weight_sha256 !== fixture.encoderIdentity.weightSha256 ||
      query.identity?.bpe_sha256 !== fixture.encoderIdentity.bpeSha256 || query.identity?.normalization !== fixture.encoderIdentity.normalization ||
      encoding.actual_bpe?.sha256 !== fixture.encoderIdentity.bpeSha256) throw new Error('FZ3B_REAL_TEXT_ENCODING_PROVENANCE');
  const rows = new Set<string>();
  for (let row = 0; row < 4; row++) {
    let norm = 0; let nonzero = 0;
    for (let index = 0; index < 512; index++) {
      const value = features.readFloatLE((row * 512 + index) * 4);
      if (!Number.isFinite(value)) throw new Error('FZ3B_NONFINITE_TEXT_EMBEDDING');
      norm += value * value; if (value !== 0) nonzero++;
    }
    if (Math.abs(norm - 1) > .0001 || nonzero < 64) throw new Error('FZ3B_SYNTHETIC_OR_UNNORMALIZED_QUERY');
    rows.add(fz3bDigest(features.subarray(row * 2048, (row + 1) * 2048)));
  }
  if (rows.size !== 4) throw new Error('FZ3B_DUPLICATE_QUERY_EMBEDDINGS');
  if (files.get('known_hosts')?.toString('utf8') !== `${FZ3B_PROFILE.host} ${FZ3B_PROFILE.hostPublicKey}\n`) throw new Error('FZ3B_RESOURCE_HOST_PIN');
  return { fixture, manifestSha256: pin, files };
}
export async function verifyFz3bResources(root: string): Promise<void> { await loadFz3bResourceBundle(root); }
export async function loadFz3bFixture(root: string): Promise<Fz3bSemanticFixture> { return structuredClone((await loadFz3bResourceBundle(root)).fixture); }
