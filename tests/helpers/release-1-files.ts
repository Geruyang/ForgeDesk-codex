import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { plainPath } from './embedded-installed';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SHA = /^[a-f0-9]{64}$/;
export const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
export interface Pin { path: string; bytes: number; sha256: string }
export const APPROVED_LARGE_CODEX: Readonly<Pin> = Object.freeze({ path: 'resources/codex/codex.exe', bytes: 334121776, sha256: 'e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e' });
const FILE_LIMIT = 256 * 1024 * 1024;
export function assertFilePin(p: Pin) {
  closed(p, ['path', 'bytes', 'sha256']); relative(p.path); assert.match(p.sha256, SHA);
  assert.ok(Number.isSafeInteger(p.bytes) && p.bytes >= 0 && (p.bytes <= FILE_LIMIT ||
    (p.path === APPROVED_LARGE_CODEX.path && p.bytes === APPROVED_LARGE_CODEX.bytes && p.sha256 === APPROVED_LARGE_CODEX.sha256)));
}
export function assertInstallerPin(p: Pin) {
  closed(p, ['path', 'bytes', 'sha256']); assert.equal(p.path, 'release/ForgeDesk-1.0.0-x64-setup.exe'); assert.match(p.sha256, SHA);
  // The package audit has this fixed ceiling; actual reads use only the pinned row size.
  assert.ok(Number.isSafeInteger(p.bytes) && p.bytes > 0 && p.bytes <= 512 * 1024 * 1024);
}
export function closed(value: any, keys: readonly string[]) {
  assert.ok(value && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys) assert.ok(Object.getOwnPropertyDescriptor(value, key)?.value !== undefined);
}
export function relative(value: string) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\:\x00-\x1f\x7f]/.test(value));
  assert.ok(value.split('/').every(p => p && p !== '.' && p !== '..')); return value;
}
export async function readStable(file: string, max = 2 * 1024 * 1024, expectedStat?: Stats) {
  await plainPath(file); const before = await lstat(file);
  assert.ok(before.isFile() && before.nlink === 1 && before.size >= 0 && before.size <= max);
  const identity = (v: typeof before) => [v.dev, v.ino, v.nlink, v.size, v.ctimeMs, v.mtimeMs];
  if (expectedStat) assert.deepEqual(identity(before), identity(expectedStat));
  const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.deepEqual(identity(await fd.stat()), identity(before)); const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const part = await fd.read(bytes, count, bytes.length - count, null); if (!part.bytesRead) break; count += part.bytesRead; }
    assert.equal(count, before.size); assert.deepEqual(identity(await fd.stat()), identity(before));
    assert.deepEqual(identity(await lstat(file)), identity(before)); await plainPath(file); return bytes.subarray(0, count);
  } finally { await fd.close(); }
}
export async function writeNew(file: string, value: unknown) {
  await plainPath(path.dirname(file)); const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  assert.ok(raw.length <= 8 * 1024 * 1024); const fd = await open(file, 'wx');
  try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); }
  assert.ok((await readStable(file, raw.length)).equals(raw)); return sha(raw);
}
export function assertPins(rows: Pin[]) {
  assert.ok(Array.isArray(rows) && Object.getPrototypeOf(rows) === Array.prototype && rows.length > 0 && rows.length <= 10000);
  const names = new Set<string>();
  for (const p of rows) { assertFilePin(p); assert.ok(!names.has(p.path.toLowerCase())); names.add(p.path.toLowerCase()); }
}
export async function hashStable(file: string, expected: Pin, io: Pick<typeof fs, 'lstat' | 'open'> = fs, expectedStat?: Stats): Promise<Pin> {
  if (expected.path === 'release/ForgeDesk-1.0.0-x64-setup.exe') assertInstallerPin(expected); else assertFilePin(expected);
  const noLinks = async () => { const absolute = path.resolve(file); let p = path.parse(absolute).root; assert.equal((await io.lstat(p)).isSymbolicLink(), false); for (const part of absolute.slice(p.length).split(path.sep).filter(Boolean)) { p = path.join(p, part); assert.equal((await io.lstat(p)).isSymbolicLink(), false); } };
  const identity = (s: Stats) => [s.dev, s.ino, s.nlink, s.size, s.ctimeMs, s.mtimeMs];
  await noLinks(); const before = await io.lstat(file); assert.ok(before.isFile() && before.nlink === 1 && before.size === expected.bytes);
  if (expectedStat) assert.deepEqual(identity(before), identity(expectedStat));
  const fd = await io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assert.deepEqual(identity(await fd.stat()), identity(before)); const buffer = Buffer.alloc(Math.min(65536, before.size + 1)), hash = createHash('sha256'); let count = 0;
    while (count <= before.size) { const n = (await fd.read(buffer, 0, Math.min(buffer.length, before.size + 1 - count), null)).bytesRead; if (!n) break; count += n; assert.ok(count <= before.size); hash.update(buffer.subarray(0, n)); }
    assert.equal(count, before.size); assert.deepEqual(identity(await fd.stat()), identity(before)); assert.deepEqual(identity(await io.lstat(file)), identity(before)); await noLinks();
    assert.equal(hash.digest('hex'), expected.sha256); return { ...expected };
  } finally { await fd.close(); }
}
export async function treePins(directory: string, expected?: Pin[]): Promise<Pin[]> {
  if (expected) assertPins(expected); const approved = expected ? new Map(expected.map(p => [p.path, p])) : undefined;
  const rows: Pin[] = []; let total = 0, directories = 0;
  const visit = async (dir: string, depth: number) => {
    await plainPath(dir); assert.ok(depth <= 32 && ++directories <= 10000); const before = await lstat(dir); assert.ok(before.isDirectory());
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const file = path.join(dir, name); await plainPath(file); const s = await lstat(file);
      if (s.isDirectory()) await visit(file, depth + 1);
      else {
        const rel = path.relative(directory, file).split(path.sep).join('/'), pin = approved?.get(rel);
        assert.ok(s.isFile() && s.nlink === 1 && rows.length < 10000 && Number.isSafeInteger(s.size) && s.size >= 0);
        if (approved) { assert.ok(pin, 'Unreviewed installed/unpacked leaf'); assert.equal(s.size, pin.bytes); } else assert.ok(s.size <= FILE_LIMIT);
        total += s.size + 1; assert.ok(total <= 4 * 1024 ** 3);
        if (pin) rows.push(await hashStable(file, pin, fs, s));
        else { const raw = await readStable(file, FILE_LIMIT, s); rows.push({ path: rel, bytes: raw.length, sha256: sha(raw) }); }
      }
    }
    assert.deepEqual((await readdir(dir)).sort(), names); const after = await lstat(dir);
    assert.deepEqual([after.dev, after.ino, after.mtimeMs, after.ctimeMs], [before.dev, before.ino, before.mtimeMs, before.ctimeMs]);
  };
  await visit(directory, 0); return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
