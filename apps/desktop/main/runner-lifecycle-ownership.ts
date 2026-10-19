import * as fs from 'node:fs';
import path from 'node:path';

/** Fresh precheck for the standard runner close; not an atomic filesystem lease. */
export function assertRunnerLifecycleOwner(dataDir: string): void {
  const directory = path.resolve(dataDir, 'engineering'), file = path.join(directory, 'owner.lock');
  let current = directory;
  const ancestors: Array<{ name: string; dev: number; ino: number; birthtimeMs: number }> = [];
  for (;;) {
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('FZ3B_RUNNER_LIFECYCLE_DIRECTORY_INVALID');
    ancestors.push({ name: current, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
    const parent = path.dirname(current); if (current === parent) break; current = parent;
  }
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size <= 0 || named.size > 512) throw new Error('FZ3B_RUNNER_LIFECYCLE_FILE_INVALID');
  const same = (left: fs.Stats, right: fs.Stats) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs && left.nlink === right.nlink;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!same(named, fs.fstatSync(fd))) throw new Error('FZ3B_RUNNER_LIFECYCLE_OWNER_CHANGED');
    const bytes = Buffer.alloc(named.size + 1); let count = 0;
    while (count < bytes.length) { const read = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    if (count !== named.size || !same(named, fs.fstatSync(fd)) || !same(named, fs.lstatSync(file))) throw new Error('FZ3B_RUNNER_LIFECYCLE_OWNER_CHANGED');
    for (const ancestor of ancestors) {
      const stat = fs.lstatSync(ancestor.name);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== ancestor.dev || stat.ino !== ancestor.ino || stat.birthtimeMs !== ancestor.birthtimeMs) throw new Error('FZ3B_RUNNER_LIFECYCLE_DIRECTORY_CHANGED');
    }
    const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'pid,schemaVersion' || value.schemaVersion !== 1 || value.pid !== process.pid ||
        !bytes.subarray(0, count).equals(Buffer.from(JSON.stringify({ schemaVersion: 1, pid: process.pid })))) throw new Error('FZ3B_RUNNER_LIFECYCLE_FOREIGN_OWNER');
  } finally { fs.closeSync(fd); }
}
