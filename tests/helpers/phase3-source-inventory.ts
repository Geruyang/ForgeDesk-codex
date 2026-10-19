import assert from 'node:assert/strict';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { plainPath } from './embedded-installed';

const SOURCE_EXTENSION = /\.(?:ts|tsx|js|mjs|cjs|py|ps1|json|toml|cs)$/;
export const PHASE3_GENERATED_SOURCE_DIRS = ['packages/engine-adapter/.test-output', 'packages/engine-adapter/.protocol-home',
  'engineering/fixtures/software/demo-output', 'engineering/__pycache__', 'tests/.tmp'] as const;
const GENERATED_DIRECTORY_NAMES = new Set(['node_modules', 'dist', 'release', 'output', '.runtime', 'test-results', 'install',
  'coverage', '__pycache__', 'demo-output', '.tmp', '.runner-tests']);

export async function collectPhase3SourceFiles(root: string, sourceRoots: readonly string[], excludedDirectories: readonly string[] = PHASE3_GENERATED_SOURCE_DIRS): Promise<string[]> {
  const excluded = new Set(excludedDirectories.map(value => value.replaceAll('\\', '/').replace(/\/$/, '')));
  const files: string[] = [];
  const skipDirectory = (relative: string) => {
    const normalized = relative.split(path.sep).join('/'), name = path.basename(relative);
    return name.startsWith('.') || GENERATED_DIRECTORY_NAMES.has(name) ||
      [...excluded].some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
  };
  const walk = async (relative: string): Promise<void> => {
    if (skipDirectory(relative)) return;
    const directory = path.join(root, relative); await plainPath(directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(relative, item.name), normalized = child.split(path.sep).join('/');
      if (item.isDirectory() && skipDirectory(child)) continue;
      const absolute = path.join(root, child); await plainPath(absolute);
      if (item.isSymbolicLink()) assert.fail(`Symlink forbidden in source inventory: ${normalized}`);
      if (item.isDirectory()) await walk(child);
      else if (item.isFile() && SOURCE_EXTENSION.test(item.name)) { const info = await lstat(absolute); assert.ok(info.isFile() && info.nlink === 1); files.push(normalized); }
      else if (!item.isFile()) assert.fail(`Unsupported source inventory entry: ${normalized}`);
    }
  };
  for (const relative of sourceRoots) await walk(relative);
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}
