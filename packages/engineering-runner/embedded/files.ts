import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { GESTURESCREEN_PROFILE } from './profile.js';
import type { EmbeddedFile } from './types.js';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const fileHash = async (file: string) => digest(await readFile(file));
export function safePart(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid task or request identifier');
  return value;
}
export function contained(root: string, candidate: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Path escapes trusted root');
  return path.resolve(candidate);
}
export async function noLinks(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links and reparse points are forbidden');
  }
  const resolved = await realpath(absolute);
  if (path.resolve(resolved).toLowerCase() !== absolute.toLowerCase()) throw new Error('Reparse path is forbidden');
  return resolved;
}
export interface DurableJsonIO {
  /** Pure-test boundaries; production always uses the defaults. */
  rename?: typeof rename; wait?: (milliseconds: number) => Promise<void>; platform?: NodeJS.Platform;
}
export async function durableJson(file: string, value: unknown, io: DurableJsonIO = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, 'wx'); created = true;
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    const delays = [25, 50, 100, 150, 250, 400];
    for (let attempt = 0; ; attempt++) {
      try { await (io.rename ?? rename)(temporary, file); break; }
      catch (error) {
        if ((io.platform ?? process.platform) !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt === delays.length) throw error;
        await (io.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(delays[attempt]);
      }
    }
  } finally {
    if (created) await rm(temporary, { force: true });
  }
}
export function excluded(relative: string): boolean {
  const normalized = relative.replaceAll('\\', '/').toLowerCase();
  return GESTURESCREEN_PROFILE.excludedPaths.some(item => normalized === item.toLowerCase() || normalized.startsWith(`${item.toLowerCase()}/`));
}
export async function sourceFiles(root: string): Promise<EmbeddedFile[]> {
  await noLinks(root);
  const files: EmbeddedFile[] = [];
  let bytes = 0;
  async function walk(directory: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = contained(root, path.join(directory, entry.name));
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (excluded(relative)) continue;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Reparse source is forbidden: ${relative}`);
      if (info.isDirectory()) { await walk(absolute); continue; }
      if (!info.isFile()) throw new Error(`Non-regular source is forbidden: ${relative}`);
      bytes += info.size;
      if (files.length >= 30000 || bytes > 512 * 1024 * 1024) throw new Error('Source snapshot exceeds fixed limits');
      files.push({ path: relative, bytes: info.size, sha256: await fileHash(absolute) });
    }
  }
  await walk(root);
  return files;
}
export const filesDigest = (files: EmbeddedFile[]) => digest(JSON.stringify(files));
export async function copyManifest(source: string, destination: string, files: EmbeddedFile[]) {
  await mkdir(destination, { recursive: true });
  await noLinks(destination);
  for (const file of files) {
    const input = contained(source, path.join(source, file.path));
    const output = contained(destination, path.join(destination, file.path));
    await noLinks(input);
    if (await fileHash(input) !== file.sha256) throw new Error(`Source changed during snapshot: ${file.path}`);
    await mkdir(path.dirname(output), { recursive: true });
    await noLinks(path.dirname(output));
    await copyFile(input, output);
    if (await fileHash(output) !== file.sha256) throw new Error('Snapshot copy hash mismatch');
  }
}
