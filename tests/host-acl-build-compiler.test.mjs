import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Extract definitions only. Never import the build module or touch native csc/ACL.
const text = readFileSync(new URL('../scripts/prepare-host-acl.mjs', import.meta.url), 'utf8');
const source = ts.createSourceFile('prepare-host-acl.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const variables = ['COMPILER_SHA256', 'compiler', 'servicedCompiler'];
const functions = ['noLinks', 'readFixedCompiler'];
const nodes = source.statements.filter(node =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some(item => variables.includes(item.name.getText(source))) ||
  ts.isFunctionDeclaration(node) && functions.includes(node.name?.text));
assert.equal(nodes.length, variables.length + functions.length);
const executable = nodes.map(node => node.getText(source).replace(/^export /, '')).join('\n') + '\n({ readFixedCompiler, compiler, servicedCompiler, COMPILER_SHA256 });';
const pin = '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00';
const fixedPaths = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\WinSxS\\amd64_netfx4-csc_exe_b03f5f7f11d50a3a_4.0.15920.100_none_6da7ea4673b761aa\\csc.exe',
];
const size = 2569832;

function fixture(options = {}) {
  const files = fixedPaths;
  const bytes = Buffer.alloc(options.length ?? size, 0x5a);
  const handles = new Map(); const opens = []; const closes = []; const hashes = []; const reads = []; const pathChecks = [];
  const namedCounts = new Map(); const fdCounts = new Map();
  const identity = () => ({ dev: 1n, ino: 11n, mode: 0o100644n, size: BigInt(size), mtimeNs: 123456789012345678n, ctimeNs: 223456789012345678n,
    nlink: 2n, isFile: () => true, isSymbolicLink: () => false });
  const context = {
    Buffer, path: path.win32,
    lstatSync(file, settings) {
      if (settings?.bigint !== true) return { isSymbolicLink: () => typeof options.link === 'function' ? options.link(file, reads.length) : options.link === file };
      assert.ok(files.includes(file), 'Only the two compiled paths may receive identity reads');
      const count = (namedCounts.get(file) ?? 0) + 1; namedCounts.set(file, count);
      const value = identity(); options.named?.(file, count, value); return value;
    },
    realpathSync(file) { pathChecks.push(file); return options.realpath ? options.realpath(file, pathChecks.length) : file; },
    openSync(file, flags) {
      assert.ok(files.includes(file)); assert.equal(flags, 'r'); opens.push(file);
      if (options.openErrorAt === opens.length) throw new Error('FAKE_OPEN_ERROR');
      const fd = 20 + opens.length; handles.set(fd, file); return fd;
    },
    fstatSync(fd, settings) {
      assert.equal(settings.bigint, true); assert.ok(handles.has(fd));
      const count = (fdCounts.get(fd) ?? 0) + 1; fdCounts.set(fd, count);
      const value = identity(); options.fd?.(handles.get(fd), count, value); return value;
    },
    readSync(fd, target, offset, length, position) {
      assert.equal(handles.get(fd), files[0], 'Only the first approved file descriptor supplies bytes');
      reads.push({ fd, offset, length, position });
      if (options.readError) throw new Error('FAKE_READ_ERROR');
      const count = Math.min(length, bytes.length - position, options.chunk ?? Infinity);
      if (count <= 0) return 0;
      bytes.copy(target, offset, position, position + count); return count;
    },
    closeSync(fd) {
      assert.ok(handles.has(fd)); closes.push(fd);
      if (options.closeErrorAt === closes.length) throw new Error('FAKE_CLOSE_ERROR');
      handles.delete(fd);
    },
    sha(raw) { hashes.push(Buffer.from(raw)); return options.hash ?? pin; },
  };
  const api = runInNewContext(executable, context);
  return { invoke: api.readFixedCompiler, api, files, bytes, handles, opens, closes, reads, hashes, pathChecks, namedCounts, fdCounts };
}

test('compiler reader uses only the exact approved Windows servicing pair and fixed size/hash', () => {
  const f = fixture();
  assert.equal(path.win32.resolve(f.api.compiler), fixedPaths[0]); assert.equal(path.win32.resolve(f.api.servicedCompiler), fixedPaths[1]); assert.equal(f.api.COMPILER_SHA256, pin);
  const raw = f.invoke(); assert.ok(raw.equals(f.bytes)); assert.equal(raw.length, size);
  assert.deepEqual(f.opens, fixedPaths); assert.deepEqual(f.closes, [22, 21]); assert.equal(f.handles.size, 0);
  assert.deepEqual(f.pathChecks, [...fixedPaths, ...fixedPaths]);
  assert.equal(f.hashes.length, 1); assert.ok(f.hashes[0].equals(f.bytes));
  for (const count of f.namedCounts.values()) assert.equal(count, 2);
  for (const count of f.fdCounts.values()) assert.equal(count, 2);
});

test('reader loops through short reads and compares bigint nanosecond identities without number conversion', () => {
  const f = fixture({ chunk: 65537 }); const raw = f.invoke(); assert.ok(raw.equals(f.bytes)); assert.ok(f.reads.length > 30); assert.equal(f.handles.size, 0);
  const drift = fixture({ named(file, count, value) { if (file === fixedPaths[1] && count === 1) value.mtimeNs += 1n; } });
  assert.throws(() => drift.invoke(), /HOST_ACL_COMPILER_PAIR/); assert.equal(drift.opens.length, 0);
});

test('pair requires exact size two links regular files and all identity fields', () => {
  const mutations = [
    value => { value.nlink = 1n; }, value => { value.nlink = 3n; }, value => { value.size -= 1n; }, value => { value.size += 1n; },
    value => { value.isFile = () => false; }, value => { value.dev += 1n; }, value => { value.ino += 1n; },
    value => { value.mode += 1n; }, value => { value.mtimeNs += 1n; }, value => { value.ctimeNs += 1n; },
  ];
  for (const mutate of mutations) {
    const f = fixture({ named(file, count, value) { if (file === fixedPaths[1] && count === 1) mutate(value); } });
    assert.throws(() => f.invoke(), /HOST_ACL_COMPILER_PAIR/); assert.equal(f.opens.length, 0); assert.equal(f.hashes.length, 0);
  }
  const both = fixture({ named(_file, _count, value) { value.nlink = 3n; } }); assert.throws(() => both.invoke(), /PAIR/);
});

test('leaf and ancestor reparse points and redirected canonical paths reject before opening compiler', () => {
  for (const link of [fixedPaths[0], fixedPaths[1], 'C:\\Windows', 'C:\\Windows\\Microsoft.NET']) {
    const f = fixture({ link }); assert.throws(() => f.invoke(), /HOST_ACL_BUILD_LINK/); assert.equal(f.opens.length, 0);
  }
  const redirected = fixture({ realpath: file => file === fixedPaths[1] ? 'C:\\other\\csc.exe' : file });
  assert.throws(() => redirected.invoke(), /HOST_ACL_COMPILER_PATH/); assert.equal(redirected.opens.length, 0);
  const caseOnly = fixture({ realpath: file => file.toUpperCase() }); assert.equal(caseOnly.invoke().length, size);
});

test('opened descriptor pair mismatch fails before reading and closes both handles', () => {
  for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) {
    const f = fixture({ fd(file, count, value) { if (file === fixedPaths[1] && count === 1) value[field] += 1n; } });
    assert.throws(() => f.invoke(), /HOST_ACL_COMPILER_CHANGED/); assert.equal(f.reads.length, 0); assert.deepEqual(f.closes, [22, 21]); assert.equal(f.handles.size, 0);
  }
});

test('post-read descriptor and named identity drift refuse even if bytes/hash could match', () => {
  for (const where of ['fd', 'named']) for (const field of ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) {
    const f = fixture({ [where](file, count, value) { if (file === fixedPaths[0] && count === 2) value[field] += 1n; } });
    assert.throws(() => f.invoke(), /HOST_ACL_COMPILER_CHANGED/); assert.equal(f.hashes.length, 0); assert.equal(f.handles.size, 0);
  }
});

test('post-read path redirect or new reparse check cannot be bypassed by held descriptors', () => {
  const f = fixture({ realpath: (file, count) => count === 3 ? 'C:\\other\\csc.exe' : file });
  assert.throws(() => f.invoke(), /HOST_ACL_COMPILER_PATH/); assert.equal(f.handles.size, 0); assert.equal(f.hashes.length, 0);
  const linked = fixture({ link: (file, readCount) => file === fixedPaths[1] && readCount > 0 });
  assert.throws(() => linked.invoke(), /HOST_ACL_BUILD_LINK/); assert.equal(linked.handles.size, 0); assert.equal(linked.hashes.length, 0);
});

test('short, oversized and wrong hash bytes fail without returning compiler bytes', () => {
  for (const length of [0, size - 1, size + 1, size + 20]) {
    const f = fixture({ length }); assert.throws(() => f.invoke(), /HOST_ACL_COMPILER_CHANGED/); assert.equal(f.hashes.length, 0); assert.equal(f.handles.size, 0);
  }
  const wrong = fixture({ hash: '0'.repeat(64) }); assert.throws(() => wrong.invoke(), /HOST_ACL_COMPILER_PIN/); assert.equal(wrong.hashes.length, 1); assert.equal(wrong.handles.size, 0);
});

test('first/second open and read errors do not report success and close every acquired handle', () => {
  const first = fixture({ openErrorAt: 1 }); assert.throws(() => first.invoke(), /FAKE_OPEN_ERROR/); assert.equal(first.closes.length, 0);
  const second = fixture({ openErrorAt: 2 }); assert.throws(() => second.invoke(), /FAKE_OPEN_ERROR/); assert.deepEqual(second.closes, [21]); assert.equal(second.handles.size, 0);
  const read = fixture({ readError: true }); assert.throws(() => read.invoke(), /FAKE_READ_ERROR/); assert.deepEqual(read.closes, [22, 21]); assert.equal(read.handles.size, 0);
});

test('one close error is propagated but still attempts the other acquired descriptor', () => {
  const f = fixture({ closeErrorAt: 1 }); assert.throws(() => f.invoke(), /FAKE_CLOSE_ERROR/);
  assert.deepEqual(f.closes, [22, 21]); assert.equal(f.handles.has(21), false);
  // The injected close failure leaves its own handle uncertain; no false cleanup claim.
  assert.equal(f.handles.has(22), true);
  const second = fixture({ closeErrorAt: 2 }); assert.throws(() => second.invoke(), /FAKE_CLOSE_ERROR/);
  assert.deepEqual(second.closes, [22, 21]); assert.equal(second.handles.has(22), false); assert.equal(second.handles.has(21), true);
});

test('compiler-only hardlink exception does not weaken singlelink source/output reads or permit fallback', () => {
  const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'fixedRead'); assert.ok(node);
  assert.match(node.getText(source), /before.nlink !== 1/);
  assert.match(text, /spawnSync\(compiler, \['\/nologo'/);
  assert.doesNotMatch(text, /spawnSync\(servicedCompiler|process.env.PATH|where.exe|powershell|SetOwner|requestedCompiler/);
});
