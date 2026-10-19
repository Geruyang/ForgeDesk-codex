import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./host-acl.ts', import.meta.url), 'utf8');
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const sid = 'S-1-5-21-1-2-3-1002';
const sourcePin = 'aa3079992d2ac92b5dd800d3e5c62f70671dce36ff80b28ca7f6f8694e75786e';
const compilerPin = '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00';
const validDependency = () => JSON.stringify(Array.from({ length: 3 }, (_, index) => ({ owner: sid, protected: index === 0,
  rules: [{ sid, allow: true, fullControl: true, effective: true }, { sid: 'S-1-5-18', allow: true, fullControl: false, effective: false }] }))) + '\n';

function fixture(options: { packaged?: boolean; modifyManifest?: (value: any) => void; noDefines?: boolean; noInitialization?: boolean } = {}) {
  const devRoot = 'E:\\fixed-development\\vendor\\host-acl';
  const resourcesPath = 'C:\\fixed-install\\resources';
  const root = options.packaged ? path.win32.join(resourcesPath, 'host-acl') : devRoot;
  const executableBytes = Buffer.from('pure-fixture-not-an-executable');
  const manifest: any = { schemaVersion: 1, scope: 'fixed-host-acl-dotnet-v1', protocolVersion: 1, sourceSha256: sourcePin,
    compilerSha256: compilerPin, files: [{ path: 'NativeAclHelper.exe', bytes: executableBytes.length, sha256: sha(executableBytes) }] };
  options.modifyManifest?.(manifest);
  const raw = Buffer.from(JSON.stringify(manifest));
  const files = new Map<string, Buffer>([[path.win32.join(root, 'manifest.json'), raw], [path.win32.join(root, 'NativeAclHelper.exe'), executableBytes]]);
  const links = new Set<string>(); const fds = new Map<number, string>();
  let fd = 1; let time = 0n; let childResult: any = { status: 0, signal: null, stdout: Buffer.from('FZ3B_PRIVATE_ACL_OK\n'), stderr: Buffer.alloc(0) };
  let childElapsed = 0; const calls: any[] = []; let extraEntry = false; let touched = 0; let rewriteOnOpen = false; let ctime = 1;
  const stat = (file: string): any => ({ dev: 1, ino: file.length, nlink: 1, size: files.get(file)?.length ?? 0, mtimeMs: 1, ctimeMs: ctime, birthtimeMs: 1, mode: files.has(file) ? 0o100644 : 0o40755,
    isFile: () => files.has(file), isDirectory: () => !files.has(file), isSymbolicLink: () => links.has(file) });
  const filesystem = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
    lstatSync(file: string) { touched++; return stat(file); },
    fstatSync(handle: number) { return stat(fds.get(handle)!); },
    readdirSync: () => ['NativeAclHelper.exe', 'manifest.json', ...(extraEntry ? ['extra.exe'] : [])],
    openSync(file: string) { const handle = fd++; fds.set(handle, file); if (rewriteOnOpen) ctime++; return handle; },
    closeSync(handle: number) { fds.delete(handle); },
    readSync(handle: number, buffer: Buffer, offset: number, length: number, position: number) {
      const data = files.get(fds.get(handle)!)!; const count = Math.min(length, Math.max(0, data.length - position));
      data.copy(buffer, offset, position, position + count); return count;
    },
  };
  const processFixture = { platform: 'win32', versions: { electron: '44.7.2' },
    resourcesPath, env: { SystemRoot: 'C:/Windows', FORGEDESK_ACL_HELPER: 'E:/attacker/other.exe', SECRET_TEST_VALUE: 'must-not-inherit' },
    hrtime: { bigint: () => time } };
  const definitions = options.noDefines ? {} : {
    __FORGEDESK_HOST_ACL_DEV_ROOT__: devRoot, __FORGEDESK_HOST_ACL_MANIFEST_SHA256__: sha(raw),
    __FORGEDESK_HOST_ACL_EXECUTABLE_SHA256__: sha(executableBytes), __FORGEDESK_HOST_ACL_SOURCE_SHA256__: sourcePin,
  };
  const exports: any = {};
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, { exports, Buffer, process: processFixture, ...definitions,
    require(name: string) {
      if (name === 'node:path') return { default: path.win32 };
      if (name === 'node:crypto') return { createHash };
      if (name === 'node:fs') return filesystem;
      if (name === 'node:child_process') return { spawnSync: (...args: any[]) => { calls.push(args); time += BigInt(Math.round(childElapsed * 1e6)); return childResult; } };
      throw new Error(`Unexpected module ${name}`);
    },
  });
  if (!options.noInitialization) exports.initializeFz3bHostAclHelper(options.packaged === true);
  return { invoke: exports.runFz3bHostAcl as (operation: number, files: string[], sid: string) => string,
    initialize: exports.initializeFz3bHostAclHelper as (mode: boolean) => void, calls, root, files, links,
    process: processFixture, setResult: (value: any) => { childResult = value; }, setElapsed: (value: number) => { childElapsed = value; },
    extra: () => { extraEntry = true; }, rewrite: () => { rewriteOnOpen = true; }, touched: () => touched, closedFds: () => fds.size === 0 };
}

test('private fixed resource binary protocol keeps exact 5000ms and closed environment', () => {
  const f = fixture(); const file = 'E:\\fake \\unicode-\u6d4b\u8bd5';
  assert.equal(f.invoke(2, [file], sid), 'FZ3B_PRIVATE_ACL_OK\n');
  assert.equal(f.calls.length, 1); const [executable, argv, options] = f.calls[0];
  assert.equal(executable, path.win32.join(f.root, 'NativeAclHelper.exe')); assert.deepEqual(Array.from(argv), []);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 4096);
  assert.deepEqual(Object.keys(options.env), ['SystemRoot']); assert.equal(options.env.SystemRoot, 'C:/Windows');
  assert.equal(options.input.subarray(0, 12).toString('ascii'), 'FZ3B-ACL-v1\0'); assert.equal(options.input[12], 2);
  assert.equal(options.input.readUInt16BE(13), Buffer.byteLength(sid));
  const count = 15 + Buffer.byteLength(sid); assert.equal(options.input.readUInt16BE(count), 1);
  assert.equal(options.input.subarray(count + 6).toString('utf8'), file); assert.equal(f.closedFds(), true);
});

test('packaged route is fixed resources only; environment cannot choose another executable', () => {
  const f = fixture({ packaged: true }); f.invoke(1, ['E:\\fake'], sid);
  assert.equal(f.calls[0][0], 'C:\\fixed-install\\resources\\host-acl\\NativeAclHelper.exe');
  assert.doesNotMatch(f.calls[0][0], /attacker/);
});

test('no compile pins, wrong platform and invalid request fail before resource/child access', () => {
  const uninitialized = fixture({ noInitialization: true }); assert.throws(() => uninitialized.invoke(1, ['E:\\fake'], sid), /INITIALIZATION/); assert.equal(uninitialized.touched(), 0);
  uninitialized.initialize(false); assert.throws(() => uninitialized.initialize(true), /INITIALIZATION/);
  const noPins = fixture({ noDefines: true }); assert.throws(() => noPins.invoke(1, ['E:\\fake'], sid), /BUILD_PIN/); assert.equal(noPins.touched(), 0);
  const wrong = fixture(); wrong.process.platform = 'linux'; assert.throws(() => wrong.invoke(1, ['E:\\fake'], sid), /PLATFORM/); assert.equal(wrong.touched(), 0);
  const bad = fixture();
  for (const [operation, files, value] of [[0, ['E:\\fake'], sid], [5, ['E:\\fake'], sid], [1, ['relative'], sid], [1, ['E:\\fake'], 'invalid'], [3, [], sid], [3, ['E:\\a', 'E:\\a'], sid], [1, ['E:\\bad\ud800'], sid]] as const) {
    assert.throws(() => bad.invoke(operation, [...files], value), /INPUT/);
  }
  assert.equal(bad.touched(), 0); assert.equal(bad.calls.length, 0);
});

test('resource mutation, extra resource, reparse path and closed-schema deviations reject before spawn', () => {
  const changed = fixture(); changed.files.set(path.win32.join(changed.root, 'NativeAclHelper.exe'), Buffer.from('changed'));
  assert.throws(() => changed.invoke(1, ['E:\\fake'], sid), /EXECUTABLE_PIN/); assert.equal(changed.calls.length, 0);
  const extra = fixture(); extra.extra(); assert.throws(() => extra.invoke(1, ['E:\\fake'], sid), /INVENTORY/);
  const linked = fixture(); linked.links.add(linked.root); assert.throws(() => linked.invoke(1, ['E:\\fake'], sid), /LINK/);
  const rewritten = fixture(); rewritten.rewrite(); assert.throws(() => rewritten.invoke(1, ['E:\\fake'], sid), /IDENTITY/); assert.equal(rewritten.calls.length, 0); assert.equal(rewritten.closedFds(), true);
  for (const modifyManifest of [(v: any) => { v.extra = true; }, (v: any) => { v.files[0].path = '../evil.exe'; }, (v: any) => { v.sourceSha256 = '0'.repeat(64); }, (v: any) => { v.compilerSha256 = '0'.repeat(64); }]) {
    const f = fixture({ modifyManifest }); assert.throws(() => f.invoke(1, ['E:\\fake'], sid), /MANIFEST/); assert.equal(f.calls.length, 0);
  }
});

test('outer monotonic check refuses late success even when native timeout did not fire', () => {
  const f = fixture(); f.setElapsed(5000.001); assert.throws(() => f.invoke(1, ['E:\\fake'], sid), /DEADLINE/); assert.equal(f.calls.length, 1);
  const boundary = fixture(); boundary.setElapsed(5000); assert.equal(boundary.invoke(1, ['E:\\fake'], sid), 'FZ3B_PRIVATE_ACL_OK\n');
});

test('all process failure states, stderr, oversized output and nonexact marker fail without retry', () => {
  const valid = { status: 0, signal: null, stdout: Buffer.from('FZ3B_PRIVATE_ACL_OK\n'), stderr: Buffer.alloc(0) };
  for (const patch of [{ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }, { status: null }, { status: 77 }, { signal: 'SIGTERM' },
    { stderr: Buffer.from('warning') }, { stdout: Buffer.alloc(4097) }, { stdout: Buffer.from(' FZ3B_PRIVATE_ACL_OK\n') },
    { stdout: Buffer.from('FZ3B_PRIVATE_ACL_OK\nextra\n') }, { stdout: Buffer.from([0xff]) }]) {
    const f = fixture(); f.setResult({ ...valid, ...patch }); assert.throws(() => f.invoke(1, ['E:\\fake'], sid), /PROCESS|OUTPUT/); assert.equal(f.calls.length, 1);
  }
});

test('batch count, unique exact paths and JSON byte limits remain closed', () => {
  const f = fixture(); f.setResult({ status: 0, signal: null, stdout: Buffer.from('FZ3B_PRIVATE_ACL_BATCH_OK\n'), stderr: Buffer.alloc(0) });
  const paths = Array.from({ length: 51 }, (_, i) => `E:\\fake\\${i}`); f.invoke(3, paths, sid); assert.equal(f.calls[0][2].input[12], 3);
  for (const files of [Array.from({ length: 52 }, (_, i) => `E:\\${i}`), ['E:\\' + 'a'.repeat(24576)]]) assert.throws(() => f.invoke(3, files, sid), /INPUT/);
  assert.equal(f.calls.length, 1);
});

test('dependency keeps three owners, root protection, allowed principals and effective owner FullControl', () => {
  const good = validDependency(); const f = fixture(); f.setResult({ status: 0, signal: null, stdout: Buffer.from(good), stderr: Buffer.alloc(0) });
  assert.equal(f.invoke(4, ['E:\\data'], sid), good);
  for (const mutate of [(v: any[]) => { v[0].protected = false; }, (v: any[]) => { v[1].owner = 'S-1-5-18'; },
    (v: any[]) => { v[2].rules[0].allow = false; }, (v: any[]) => { v[2].rules[0].effective = false; },
    (v: any[]) => { v[2].rules[0].fullControl = false; }, (v: any[]) => { v[1].rules[1].sid = 'S-1-1-0'; },
    (v: any[]) => { v[0].extra = true; }, (v: any[]) => { v[0].rules[0].extra = true; }]) {
    const values = JSON.parse(good); mutate(values); const bad = fixture();
    bad.setResult({ status: 0, signal: null, stdout: Buffer.from(JSON.stringify(values) + '\n'), stderr: Buffer.alloc(0) });
    assert.throws(() => bad.invoke(4, ['E:\\data'], sid), /OUTPUT/);
  }
});

test('source makes no native shell/async fallback or caller-controlled helper path available', () => {
  assert.doesNotMatch(source, /powershell|execFile|process\.env\.(?:FORGEDESK|PATH)|spawnSync\([^,]*env/);
  assert.match(source, /packagedMode === undefined/); assert.match(source, /resourcesPath/);
  assert.match(source, /DEADLINE_MS = 5000/); assert.match(source, /result\.status !== 0/); assert.match(source, /result\.signal !== null/);
  assert.match(source, /result\.stderr\.length !== 0/);
});
