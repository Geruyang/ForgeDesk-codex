import { fz3bDigest } from './profile.js';

export interface PackageEntry { path: string; bytes: Buffer }
export function deterministicPsPackage(entries: PackageEntry[]): { archive: Buffer; manifest: Buffer; manifestSha256: string } {
  if (!entries.length || entries.length > 128) throw new Error('FZ3B_PACKAGE_ENTRY_BUDGET');
  const ordered = [...entries].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const names = new Set<string>(); let total = 0;
  for (const entry of ordered) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,98}$/.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(entry.path) || entry.bytes.length > 1048576) throw new Error('FZ3B_PACKAGE_PATH_OR_SIZE');
    names.add(entry.path); total += entry.bytes.length;
  }
  if (total > 8 * 1048576) throw new Error('FZ3B_PACKAGE_TOTAL_BUDGET');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'fixed-ps-fixture-package',
    newPlBuilt: false, deployed: false, deploymentAllowed: false,
    files: ordered.map(entry => ({ path: entry.path, bytes: entry.bytes.length, sha256: fz3bDigest(entry.bytes) })) }, null, 2) + '\n');
  const members = [...ordered, { path: 'PACKAGE_MANIFEST.json', bytes: manifest }];
  const blocks: Buffer[] = [];
  for (const entry of members) {
    const header = Buffer.alloc(512);
    const octal = (value: number, offset: number, width: number) => header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width, 'ascii');
    header.write(entry.path, 0, 100, 'ascii'); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(entry.bytes.length, 124, 12); octal(0, 136, 12); header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return { archive: Buffer.concat(blocks), manifest, manifestSha256: fz3bDigest(manifest) };
}
