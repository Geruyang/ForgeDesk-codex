import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const filename = path.resolve('engineering/templates/node-software-v1/sandbox-probe.mjs');
const code = transpileModule(readFileSync(filename, 'utf8'), {
  fileName: filename + '.ts', compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const roots = { input: path.resolve('mock-input'), output: path.resolve('mock-output'),
  private: path.resolve('mock-private'), template: path.resolve('mock-template') };
const nonce = 'structured-mock';
const marker = '.runner-os-probe-' + nonce;
const deniedRoots = new Set([roots.input, roots.private, roots.template]);
const failure = (code: string) => Object.assign(new Error('Injected filesystem failure'), { code });
type Faults = {
  platform?: 'win32' | 'linux';
  fsAllowedRoot?: string;
  fsPartialRoot?: string;
  unlinkDeniedRoot?: string;
  sqliteAllowedRoot?: string;
  sqliteFault?: 'open' | 'exec' | 'close';
  sqlitePartialOpen?: boolean;
  sqliteSidecar?: boolean;
  inspectionDeniedRoot?: string;
};
type Facts = Record<string, unknown>;
type Receipt = { inputWriteDenied: boolean; privateWriteDenied: boolean; templateWriteDenied: boolean;
  sqliteInputWriteDenied: boolean; outputWriteAllowed: boolean; sqliteOutputWriteAllowed: boolean;
  passed: boolean; facts: Record<string, Facts> };

function probe(faults: Faults = {}) {
  const files = new Set<string>();
  const sqlitePaths: string[] = [];
  const output: string[] = [];
  const processMock = { argv: ['node', filename, roots.input, roots.output, roots.private, roots.template, nonce], exitCode: 0, platform: faults.platform ?? process.platform };
  const fsMock = {
    lstatSync(file: string) {
      if (path.dirname(file) === faults.inspectionDeniedRoot) throw failure('EACCES');
      if (!files.has(file)) throw failure('ENOENT');
      return { isFile: () => true };
    },
    writeFileSync(file: string) {
      const root = path.dirname(file);
      if (root === faults.fsPartialRoot) { files.add(file); throw failure('EPERM'); }
      if (deniedRoots.has(root) && root !== faults.fsAllowedRoot) throw failure('EPERM');
      files.add(file);
    },
    unlinkSync(file: string) {
      if (path.dirname(file) === faults.unlinkDeniedRoot) throw failure('EPERM');
      if (!files.delete(file)) throw failure('ENOENT');
    },
  };
  class DatabaseMock {
    private root: string;
    constructor(file: string) {
      sqlitePaths.push(file);
      const original = [roots.input, roots.output].map(root => path.join(root, marker + '.db'))
        .find(candidate => file === candidate || file === path.toNamespacedPath(candidate));
      assert.ok(original, 'SQLite argument must denote one of the original physical marker files');
      file = original;
      this.root = path.dirname(file);
      if (this.root === faults.sqliteAllowedRoot && faults.sqliteFault === 'open') {
        if (faults.sqlitePartialOpen) files.add(file);
        if (faults.sqliteSidecar) files.add(file + '-journal');
        throw failure('ERR_SQLITE_ERROR');
      }
      if (deniedRoots.has(this.root) && this.root !== faults.sqliteAllowedRoot) throw failure('ERR_SQLITE_ERROR');
      files.add(file);
      if (faults.sqliteSidecar && this.root === faults.sqliteAllowedRoot) files.add(file + '-wal');
    }
    exec(sql: string) {
      assert.equal(sql, 'CREATE TABLE probe (id INTEGER)');
      if (this.root === faults.sqliteAllowedRoot && faults.sqliteFault === 'exec') throw failure('ERR_SQLITE_ERROR');
    }
    close() {
      if (this.root === faults.sqliteAllowedRoot && faults.sqliteFault === 'close') throw failure('ERR_SQLITE_ERROR');
    }
  }
  const modules = { 'node:fs': fsMock, 'node:path': path, 'node:sqlite': { DatabaseSync: DatabaseMock } };
  const context = vm.createContext({ exports: {}, process: processMock, console: { log: (line: string) => output.push(line) },
    require: (name: keyof typeof modules) => { assert.ok(name in modules); return modules[name]; } });
  new vm.Script(code, { filename }).runInContext(context, { timeout: 1000 });
  assert.equal(output.length, 1);
  const prefix = 'FORGEDESK_SANDBOX_RECEIPT:';
  assert.ok(output[0].startsWith(prefix));
  return { receipt: JSON.parse(output[0].slice(prefix.length)) as Receipt, exitCode: processMock.exitCode, files, sqlitePaths };
}

test('fixed sandbox template accepts only denied negative writes and cleaned positive controls', () => {
  const result = probe();
  assert.equal(result.receipt.passed, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.files.size, 0);
  assert.equal(result.receipt.facts.inputFs.created, false);
  assert.equal(result.receipt.facts.outputSqlite.closeSucceeded, true);
});

test('Windows SQLite namespaces both original marker paths without changing cleanup or non-Windows paths', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const result = probe({ platform });
    const original = [roots.input, roots.output].map(root => path.join(root, marker + '.db'));
    assert.deepEqual(result.sqlitePaths, platform === 'win32' ? original.map(file => path.toNamespacedPath(file)) : original);
    assert.equal(result.receipt.passed, true);
    assert.equal(result.receipt.sqliteInputWriteDenied, true);
    assert.equal(result.receipt.sqliteOutputWriteAllowed, true);
    assert.equal(result.files.size, 0);
  }
});

test('successful negative fs creation is never denial when cleanup fails or succeeds', () => {
  for (const root of deniedRoots) {
    for (const unlinkDeniedRoot of [root, undefined]) {
      const result = probe({ fsAllowedRoot: root, unlinkDeniedRoot });
      const key = root === roots.input ? 'input' : root === roots.private ? 'private' : 'template';
      assert.equal(result.receipt[`${key}WriteDenied` as 'inputWriteDenied'], false);
      assert.equal(result.receipt.facts[`${key}Fs`].writeSucceeded, true);
      assert.equal(result.receipt.facts[`${key}Fs`].created, true);
      assert.equal(result.receipt.facts[`${key}Fs`].cleanupComplete, !unlinkDeniedRoot);
      assert.equal(result.receipt.passed, false);
      assert.equal(result.exitCode, 1);
    }
  }
});

test('partial fs creation followed by EPERM is not a denied write', () => {
  const result = probe({ fsPartialRoot: roots.input });
  assert.equal(result.receipt.inputWriteDenied, false);
  assert.equal(result.receipt.facts.inputFs.created, true);
  assert.equal(result.receipt.facts.inputFs.writeSucceeded, false);
  assert.equal(result.receipt.facts.inputFs.cleanupComplete, true);
  assert.equal(result.receipt.passed, false);
  assert.equal(result.files.size, 0);
});

test('SQLite exec or close failure after creation cannot be reported as open denial', () => {
  for (const sqliteFault of ['exec', 'close'] as const) {
    const result = probe({ sqliteAllowedRoot: roots.input, sqliteFault, sqliteSidecar: true });
    assert.equal(result.receipt.sqliteInputWriteDenied, false);
    assert.equal(result.receipt.facts.inputSqlite.created, true);
    assert.equal(result.receipt.facts.inputSqlite.opened, true);
    assert.equal(result.receipt.facts.inputSqlite.cleanupComplete, true);
    assert.equal(result.receipt.passed, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.files.size, 0);
  }
});

test('SQLite failed open with a partial database or journal fails closed', () => {
  for (const sqlitePartialOpen of [false, true]) {
    const result = probe({ sqliteAllowedRoot: roots.input, sqliteFault: 'open', sqlitePartialOpen, sqliteSidecar: true });
    assert.equal(result.receipt.sqliteInputWriteDenied, false);
    assert.equal(result.receipt.facts.inputSqlite.created, true);
    assert.equal(result.receipt.facts.inputSqlite.opened, false);
    assert.equal(result.receipt.facts.inputSqlite.cleanupComplete, true);
    assert.equal(result.receipt.passed, false);
    assert.equal(result.files.size, 0);
  }
});

test('output deletion or SQLite exec/close failure prevents a positive receipt', () => {
  const deletion = probe({ unlinkDeniedRoot: roots.output });
  assert.equal(deletion.receipt.outputWriteAllowed, false);
  assert.equal(deletion.receipt.sqliteOutputWriteAllowed, false);
  assert.equal(deletion.receipt.passed, false);
  assert.ok(deletion.files.has(path.join(roots.output, marker)));
  assert.ok(deletion.files.has(path.join(roots.output, marker + '.db')));
  for (const sqliteFault of ['exec', 'close'] as const) {
    const result = probe({ sqliteAllowedRoot: roots.output, sqliteFault });
    assert.equal(result.receipt.sqliteOutputWriteAllowed, false);
    assert.equal(result.receipt.passed, false);
  }
});

test('unobservable marker state cannot become a denied-write receipt', () => {
  const result = probe({ inspectionDeniedRoot: roots.input });
  assert.equal(result.receipt.inputWriteDenied, false);
  assert.equal(result.receipt.sqliteInputWriteDenied, false);
  assert.equal(result.receipt.passed, false);
});
