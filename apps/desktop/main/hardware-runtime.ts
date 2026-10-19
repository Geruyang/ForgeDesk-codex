import { createHash } from 'node:crypto';
import { readFile, realpath, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

declare const __FORGEDESK_HARDWARE_MANIFEST_SHA256__: string;
declare const __FORGEDESK_HARDWARE_WORKER_SHA256__: string;

interface RuntimeFile { path: string; bytes: number; sha256: string }
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const pathKey = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;

async function rejectLinkedParents(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  const volume = path.parse(absolute).root;
  let current = volume;
  for (const component of absolute.slice(volume.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Hardware resource links and reparse points are forbidden');
  }
  const actual = await realpath(absolute);
  if (pathKey(path.resolve(actual)) !== pathKey(absolute)) throw new Error('Hardware resource parent resolved through a reparse point');
  return absolute;
}

function manifestFile(value: unknown): RuntimeFile {
  if (!value || typeof value !== 'object') throw new Error('Invalid hardware resource manifest entry');
  const file = value as RuntimeFile;
  if (typeof file.path !== 'string' || path.posix.isAbsolute(file.path) || path.win32.isAbsolute(file.path)
      || file.path.includes('\\') || file.path.split('/').some(part => !part || part === '..' || part === '.' || /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part))
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
    throw new Error('Invalid hardware resource path, size or hash');
  }
  return file;
}

function defaultWorker(root: string): string {
  const development = path.basename(root).toLowerCase() === 'hardware' && path.basename(path.dirname(root)).toLowerCase() === 'vendor';
  return development ? path.resolve(root, '../../engineering/hardware-worker.py') : path.resolve(root, '../hardware-worker.py');
}

function ioLimit(maximum: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(action: () => Promise<T>): Promise<T> => {
    if (active >= maximum) await new Promise<void>(resolve => waiting.push(resolve));
    else active++;
    try { return await action(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}

async function ownPath(filename: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const info = await lstat(filename);
  if (info.isSymbolicLink()) throw new Error(`Hardware resource links are forbidden: ${filename}`);
  if (pathKey(path.resolve(await realpath(filename))) !== pathKey(path.resolve(filename))) throw new Error(`Hardware resource resolved through a reparse point: ${filename}`);
  return info;
}

export async function verifyHardwareRuntime(root: string, workerPath?: string): Promise<void> {
  const pinned = typeof __FORGEDESK_HARDWARE_MANIFEST_SHA256__ === 'string' ? __FORGEDESK_HARDWARE_MANIFEST_SHA256__ : '';
  const pinnedWorker = typeof __FORGEDESK_HARDWARE_WORKER_SHA256__ === 'string' ? __FORGEDESK_HARDWARE_WORKER_SHA256__ : '';
  if (!/^[a-f0-9]{64}$/.test(pinned)) throw new Error('Hardware runtime manifest is not pinned in this build');
  if (!/^[a-f0-9]{64}$/.test(pinnedWorker)) throw new Error('Hardware worker is not pinned in this build');
  const base = await rejectLinkedParents(root);
  if (!(await lstat(base)).isDirectory()) throw new Error('Hardware runtime root is not a directory');
  const manifestPath = await rejectLinkedParents(path.join(base, 'manifest.json'));
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Hardware manifest is not a regular file');
  const raw = await readFile(manifestPath);
  if (hash(raw) !== pinned) throw new Error('Hardware runtime manifest changed');
  const manifest = JSON.parse(raw.toString('utf8')) as { schemaVersion: number; files: unknown[] };
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Hardware runtime manifest is empty or unsupported');
  const files = manifest.files.map(manifestFile);
  const expected = new Map<string, RuntimeFile>();
  const allowedDirectories = new Set<string>();
  for (const file of files) {
    if (file.path.toLowerCase() === 'manifest.json') throw new Error('Hardware manifest cannot list itself');
    if (expected.has(file.path.toLowerCase())) throw new Error('Duplicate hardware resource');
    expected.set(file.path.toLowerCase(), file);
    const components = file.path.toLowerCase().split('/');
    for (let count = 1; count < components.length; count++) allowedDirectories.add(components.slice(0, count).join('/'));
  }
  const limited = ioLimit(16);
  const inventory = async (directory: string, verifyContents: boolean, prefix = '', observed = { files: new Set<string>(), directories: new Set<string>() }): Promise<number> => {
    // Parents have already been checked by this traversal; verify each descendant itself once.
    if (!(await ownPath(directory)).isDirectory()) throw new Error('Hardware resource directory changed');
    if (observed.directories.has(prefix.toLowerCase())) throw new Error('Duplicate hardware resource directory alias');
    observed.directories.add(prefix.toLowerCase());
    const work = (await readdir(directory, { withFileTypes: true })).map(async entry => {
      const relative = `${prefix}${entry.name}`;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(relative.toLowerCase())) throw new Error(`Unlisted hardware resource directory: ${relative}`);
        return inventory(filename, verifyContents, `${relative}/`, observed);
      }
      return limited(async () => {
        const info = await ownPath(filename);
        if (!info.isFile()) throw new Error(`Hardware resource is not a regular file: ${relative}`);
        if (relative === 'manifest.json') return 0;
        const file = expected.get(relative.toLowerCase());
        if (!file) throw new Error(`Unlisted hardware resource: ${relative}`);
        if (observed.files.has(relative.toLowerCase())) throw new Error('Duplicate hardware resource file alias');
        observed.files.add(relative.toLowerCase());
        if (verifyContents) {
          const bytes = await readFile(filename);
          if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Hardware resource changed: ${file.path}`);
        }
        return 1;
      });
    });
    const results = await Promise.allSettled(work);
    let count = 0;
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      count += result.value;
    }
    return count;
  };
  if (await inventory(base, true) !== files.length) throw new Error('Hardware runtime file inventory differs from manifest');
  const worker = await rejectLinkedParents(workerPath ?? defaultWorker(base));
  if (!(await lstat(worker)).isFile() || hash(await readFile(worker)) !== pinnedWorker) throw new Error('Hardware worker changed or is not a regular file');
  if (await inventory(base, false) !== files.length) throw new Error('Hardware runtime inventory changed during verification');
  if (hash(await readFile(manifestPath)) !== pinned) throw new Error('Hardware runtime manifest changed during verification');
}
