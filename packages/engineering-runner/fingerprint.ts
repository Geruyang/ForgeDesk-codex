import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { RunnerOptions, SourceSnapshot } from './types.js';
import { EVIDENCE_LIMITATION } from './redaction.js';
import { commandEnvironment } from './environment.js';

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export async function hashFile(filename: string): Promise<{ sha256: string; bytes: number }> {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Unsupported input (not a regular file): ${filename}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) { hash.update(chunk); bytes += chunk.length; }
  const after = await lstat(filename);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || bytes !== after.size) {
    throw new Error(`Input changed while fingerprinting: ${filename}`);
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function git(root: string, args: string[], options: RunnerOptions): Promise<Buffer | null> {
  let executable = 'git';
  const managed = process.platform === 'win32' ? options.processHost : undefined;
  if (managed) {
    let resolved: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      try { const candidate = path.join(directory, 'git.exe'); if ((await lstat(candidate)).isFile()) { resolved = await realpath(candidate); break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (!resolved) return null;
    executable = resolved;
  }
  const arguments_ = ['--no-pager', '-c', 'core.fsmonitor=false', '-C', root, ...args];
  return new Promise(resolve => execFile(managed ?? executable, managed ? ['--', executable, ...arguments_] : arguments_, {
    shell: false, windowsHide: true, timeout: 10000, maxBuffer: 32 * 1024 * 1024,
    encoding: 'buffer', env: { ...commandEnvironment(), GIT_OPTIONAL_LOCKS: '0' },
  }, (error, stdout) => resolve(error ? null : stdout)));
}

export async function fingerprint(root: string, options: RunnerOptions, includeGit = true): Promise<SourceSnapshot> {
  const resolved = await realpath(root);
  const generated = (options.excludedGeneratedDirs ?? []).map(entry => {
    const target = path.resolve(resolved, entry);
    if (!inside(resolved, target) || target === resolved) throw new Error('Generated exclusions must be project-relative child directories');
    return path.relative(resolved, target).replaceAll('\\', '/');
  });
  const excludes = ['.git', ...generated].sort();
  const files: SourceSnapshot['files'] = [];
  const directories: string[] = [];
  const maxFiles = options.maxFingerprintFiles ?? 30000;
  const maxBytes = options.maxFingerprintBytes ?? 1024 * 1024 * 1024;
  let total = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(resolved, filename).replaceAll('\\', '/');
      if (excludes.some(excluded => relative === excluded || relative.startsWith(`${excluded}/`))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links/junctions require an explicit supported input profile: ${relative}`);
      if (entry.isDirectory()) {
        if (directories.length >= maxFiles) throw new Error(`Fingerprint directory limit exceeded (${maxFiles}); evidence was not collected`);
        directories.push(relative); await walk(filename);
      }
      else if (entry.isFile()) {
        if (files.length >= maxFiles) throw new Error(`Fingerprint file limit exceeded (${maxFiles}); evidence was not collected`);
        const stat = await lstat(filename);
        if (total + stat.size > maxBytes) throw new Error(`Fingerprint byte limit exceeded (${maxBytes}); evidence was not collected`);
        const hashed = await hashFile(filename);
        total += hashed.bytes;
        files.push({ path: relative, ...hashed });
      } else throw new Error(`Unsupported filesystem input: ${relative}`);
    }
  };
  await walk(resolved);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  directories.sort((a, b) => a.localeCompare(b, 'en'));
  const [isRepo, commit, unstaged, staged, untracked] = includeGit ? await Promise.all([
    git(root, ['rev-parse', '--is-inside-work-tree'], options), git(root, ['rev-parse', '--verify', 'HEAD'], options),
    git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv'], options), git(root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv'], options),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'], options),
  ]) : [null, null, null, null, null];
  if (isRepo && (!unstaged || !staged || !untracked)) throw new Error('Git input metadata could not be collected');
  const untrackedNames = new Set((untracked?.toString() ?? '').split('\0'));
  const untrackedDigest = digest(JSON.stringify(files.filter(file => untrackedNames.has(file.path))));
  const gitCommit = commit?.toString().trim() ?? null;
  const dirtyDiffDigest = isRepo ? digest(Buffer.concat([unstaged!, Buffer.from('\0'), staged!])) : null;
  const inputDigest = digest(JSON.stringify({ files, directories, gitCommit, dirtyDiffDigest, untrackedDigest, excludes }));
  return { schemaVersion: 1, evidenceLevel: 'A', capturedAt: new Date().toISOString(), inputDigest,
    gitCommit, dirtyDiffDigest, untrackedDigest, files, directories, excludedGeneratedDirs: excludes, limitation: EVIDENCE_LIMITATION };
}
