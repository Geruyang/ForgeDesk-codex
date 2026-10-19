import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { assertRunnerLifecycleOwner } from '../apps/desktop/main/runner-lifecycle-ownership';

function fixture() {
  const base = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/host-finalization');
  const home = fs.mkdtempSync(path.join(base, 'runner-owner-pure-')); fs.mkdirSync(path.join(home, 'engineering'));
  return { home, file: path.join(home, 'engineering', 'owner.lock') };
}
test('runner lifecycle precheck reads only the exact current owner and leaves bytes and metadata unchanged', () => {
  const f = fixture(), bytes = JSON.stringify({ schemaVersion: 1, pid: process.pid }); fs.writeFileSync(f.file, bytes);
  const before = fs.statSync(f.file); assertRunnerLifecycleOwner(f.home);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes); assert.equal(fs.statSync(f.file).mtimeMs, before.mtimeMs);
});
test('foreign, ambiguous, missing, nonregular and oversized runner lifecycle owners are never removed', () => {
  for (const contents of [JSON.stringify({ schemaVersion: 1, pid: process.pid + 1 }), `{"schemaVersion":1,"pid":0,"pid":${process.pid}}`, '{}', 'x'.repeat(513)]) {
    const f = fixture(); fs.writeFileSync(f.file, contents); assert.throws(() => assertRunnerLifecycleOwner(f.home)); assert.equal(fs.readFileSync(f.file, 'utf8'), contents);
  }
  const missing = fixture(); assert.throws(() => assertRunnerLifecycleOwner(missing.home)); assert.equal(fs.existsSync(missing.file), false);
  const directory = fixture(); fs.mkdirSync(directory.file); assert.throws(() => assertRunnerLifecycleOwner(directory.home)); assert.ok(fs.statSync(directory.file).isDirectory());
  const linked = fixture(); fs.writeFileSync(linked.file, JSON.stringify({ schemaVersion: 1, pid: process.pid })); fs.linkSync(linked.file, linked.file + '.copy');
  assert.throws(() => assertRunnerLifecycleOwner(linked.home)); assert.equal(fs.statSync(linked.file).nlink, 2);
});
test('modeled ancestor junction cannot pass by retaining the same owner inode', () => {
  const f = fixture(); fs.writeFileSync(f.file, JSON.stringify({ schemaVersion: 1, pid: process.pid }));
  const directory = path.dirname(f.file);
  let changed = false;
  const modeled = { ...fs, lstatSync(name: fs.PathLike) {
    const stat = fs.lstatSync(name);
    return changed && String(name) === directory ? { ...stat, isDirectory: () => true, isSymbolicLink: () => true } : stat;
  }, readSync(...args: Parameters<typeof fs.readSync>) { changed = true; return (fs.readSync as Function)(...args); } };
  const source = fs.readFileSync(new URL('../apps/desktop/main/runner-lifecycle-ownership.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, Function> = {};
  vm.runInNewContext(javascript, { exports, process: { pid: process.pid }, Buffer,
    require: (name: string) => { if (name === 'node:fs') return modeled; if (name === 'node:path') return { default: path }; throw new Error('Unexpected dependency'); } });
  assert.throws(() => exports.assertRunnerLifecycleOwner(f.home), /DIRECTORY_CHANGED/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify({ schemaVersion: 1, pid: process.pid }));
});
