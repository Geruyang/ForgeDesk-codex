import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('credentials.ts', readFileSync(new URL('../packages/engineering-runner/fz3b/credentials.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function fixture(method: string, error?: Error) {
  const fn = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === method); assert.ok(fn);
  const calls: any[][] = [];
  const invoke = runInNewContext(ts.transpileModule(fn.getText(source).replace(/^export /, '') + `\n${method};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { Buffer, path: path.win32, process: { platform: 'win32' }, runFz3bHostAcl: (...args: any[]) => { calls.push(args); if (error) throw error; } }) as (...args: any[]) => void;
  return { invoke, calls };
}

test('host finalization uses the closed helper primitive, not a PowerShell command path', () => {
  const sid = 'S-1-5-21-1-2-3-1001'; const file = 'E:\\fake';
  for (const update of [false, true]) { const f = fixture('fz3bPrivateAclSync'); f.invoke(file, sid, update); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], update ? 2 : 1); }
});

test('dependency gate selects only fixed data-root opcode and does not authorize arbitrary child commands', () => {
  const f = fixture('fz3bHostDependencyAclSync'); f.invoke('E:\\fake', 'S-1-5-21-1'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 4); assert.equal(f.calls[0][1].length, 1);
  assert.doesNotMatch(source.text.slice(source.text.indexOf('export function fz3bHostDependencyAclSync'), source.text.indexOf('/** Only a native file picker')), /execFile|EncodedCommand|powershell/);
});

test('bad private/dependency input cannot invoke the helper', () => {
  for (const method of ['fz3bPrivateAclSync', 'fz3bHostDependencyAclSync']) {
    const f = fixture(method); assert.throws(() => f.invoke('relative', 'S-1-5-21-1', false), /INPUT/); assert.throws(() => f.invoke('E:\\fake', 'not-SID', false), /INPUT/); assert.equal(f.calls.length, 0);
  }
});

test('private readonly batch keeps original public limits and helper failure remains terminal', () => {
  const error = new Error('FZ3B_HOST_ACL_HELPER_PROCESS'); const f = fixture('fz3bPrivateAclBatchSync', error);
  for (const files of [[], ['E:\\same', 'E:\\same'], ['relative'], Array.from({ length: 52 }, (_, i) => `E:\\${i}`), ['E:\\' + 'x'.repeat(25000)]]) assert.throws(() => f.invoke(files, 'S-1-5-21-1'), /BATCH_INPUT/);
  assert.equal(f.calls.length, 0); assert.throws(() => f.invoke(['E:\\fake'], 'S-1-5-21-1'), value => value === error); assert.equal(f.calls.length, 1);
});
