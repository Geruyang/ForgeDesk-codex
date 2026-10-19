import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('credentials.ts', readFileSync(new URL('./credentials.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const sid = 'S-1-5-21-1-2-3-1001';
type Method = 'fz3bPrivateAclSync' | 'fz3bPrivateAclBatchSync' | 'fz3bHostDependencyAclSync';
function fixture(method: Method, error?: Error) {
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === method); assert.ok(node);
  const calls: any[][] = [];
  const invoke = runInNewContext(ts.transpileModule(node.getText(source).replace(/^export /, '') + `\n${method};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    { Buffer, path: path.win32, process: { platform: 'win32' }, runFz3bHostAcl: (...args: any[]) => { calls.push(args); if (error) throw error; return ''; } }) as (...args: any[]) => void;
  return { calls, invoke };
}

test('host-only credential entrypoints delegate only fixed opcodes without choosing a process/path', () => {
  const file = 'E:\\fake with spaces\\\u6d4b\u8bd5';
  for (const [method, arguments_, opcode] of [
    ['fz3bPrivateAclSync', [file, sid, false], 1], ['fz3bPrivateAclSync', [file, sid, true], 2],
    ['fz3bPrivateAclBatchSync', [[file], sid], 3], ['fz3bHostDependencyAclSync', [file, sid], 4],
  ] as const) {
    const f = fixture(method); f.invoke(...arguments_); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], opcode);
    assert.deepEqual(Array.from(f.calls[0][1]), [file]); assert.equal(f.calls[0][2], sid);
  }
});

test('public input/count/byte gates remain before helper delegation', () => {
  const one = fixture('fz3bPrivateAclSync');
  assert.throws(() => one.invoke('relative', sid, false), /INPUT/); assert.throws(() => one.invoke('E:\\fake', 'not-sid', false), /INPUT/); assert.equal(one.calls.length, 0);
  const batch = fixture('fz3bPrivateAclBatchSync');
  for (const files of [[], ['relative'], ['E:\\same', 'E:\\same'], Array.from({ length: 52 }, (_, i) => `E:\\${i}`), ['E:\\' + 'a'.repeat(24576)]]) assert.throws(() => batch.invoke(files, sid), /BATCH_INPUT/);
  assert.equal(batch.calls.length, 0);
  const dependency = fixture('fz3bHostDependencyAclSync'); assert.throws(() => dependency.invoke('relative', sid), /INPUT/); assert.equal(dependency.calls.length, 0);
});

test('all synchronous host entrypoints propagate helper failure without retry/fallback', () => {
  for (const method of ['fz3bPrivateAclSync', 'fz3bPrivateAclBatchSync', 'fz3bHostDependencyAclSync'] as const) {
    const error = new Error('FZ3B_HOST_ACL_HELPER_DEADLINE'); const f = fixture(method, error);
    assert.throws(() => f.invoke(method === 'fz3bPrivateAclBatchSync' ? ['E:\\fake'] : 'E:\\fake', sid, true), value => value === error); assert.equal(f.calls.length, 1);
  }
});

test('legacy asynchronous credential script/import/require retain their original exact source hashes', () => {
  const expected: Record<string, string> = {
    PRIVATE_ACL_SCRIPT: '768cc129039e59bd389bfe1260944e91f57f0ecd251afab0c4768b570f29f9af',
    privateAcl: 'c1e9fee5c5466bbc0cf5f24438abdd9266e0f62d053e822493375767d26215c7',
    importFz3bProjectKey: '34f234ff2bcc079ac8571c2f3a551c8537722f7e01f068448ea6c81ca41ed7ad',
    requireFz3bProjectKey: 'd52e4e5778100f2aff8c3f0bdb0c9ee31a17343b8a5595290671b6cf1af0c262',
  };
  for (const [name, pin] of Object.entries(expected)) {
    const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name || ts.isVariableStatement(item) && item.declarationList.declarations.some(entry => entry.name.getText(source) === name)); assert.ok(node);
    assert.equal(createHash('sha256').update(node.getText(source).replace(/\r\n/g, '\n')).digest('hex'), pin, name);
  }
});

test('reviewed C# preserves owner-before-DACL, no SetOwner, reparse refusal and private/dependency predicates', () => {
  const text = readFileSync(new URL('../../../engineering/windows/host-acl/NativeAclHelper.cs', import.meta.url), 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), 'aa3079992d2ac92b5dd800d3e5c62f70671dce36ff80b28ca7f6f8694e75786e');
  assert.doesNotMatch(text, /\.SetOwner\s*\(|Process\.Start|DllImport/); assert.match(text, /FileAttributes.ReparsePoint/);
  assert.match(text, /rules.Count != 1/); assert.match(text, /rule.IsInherited \|\| rule.FileSystemRights != FileSystemRights.FullControl/);
  assert.match(text, /if \(owner != expectedSid \|\| \(i == 0 && !acl.AreAccessRulesProtected\)/);
});
