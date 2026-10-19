import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync, renameSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

const SOURCE_SHA256 = 'aa3079992d2ac92b5dd800d3e5c62f70671dce36ff80b28ca7f6f8694e75786e';
const COMPILER_SHA256 = '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00';
const compiler = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';
const servicedCompiler = 'C:/Windows/WinSxS/amd64_netfx4-csc_exe_b03f5f7f11d50a3a_4.0.15920.100_none_6da7ea4673b761aa/csc.exe';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs;
function noLinks(file) {
  const parsed = path.parse(file); let current = parsed.root;
  for (const part of file.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error('HOST_ACL_BUILD_LINK');
  }
}
function fixedRead(file, limit) {
  noLinks(file); const before = lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit) throw new Error('HOST_ACL_BUILD_FILE');
  const raw = readFileSync(file); if (raw.length !== before.size || !same(before, lstatSync(file))) throw new Error('HOST_ACL_BUILD_CHANGED'); return raw;
}

// Only this pinned Windows servicing pair may have two hard links.
export function readFixedCompiler() {
  const paths = [compiler, servicedCompiler].map(file => path.resolve(file));
  const identity = s => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
  const approved = s => s.isFile() && s.nlink === 2n && s.size === 2569832n;
  const checkPath = file => {
    noLinks(file);
    if (realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('HOST_ACL_COMPILER_PATH');
  };
  paths.forEach(checkPath);
  const named = paths.map(file => lstatSync(file, { bigint: true }));
  if (!named.every(approved) || identity(named[0]) !== identity(named[1])) throw new Error('HOST_ACL_COMPILER_PAIR');
  const handles = [];
  try {
    for (const file of paths) handles.push(openSync(file, 'r'));
    const unchanged = s => approved(s) && identity(s) === identity(named[0]);
    if (!handles.every(fd => unchanged(fstatSync(fd, { bigint: true })))) throw new Error('HOST_ACL_COMPILER_CHANGED');
    const bytes = Buffer.alloc(2569833); let used = 0;
    while (used < bytes.length) {
      const count = readSync(handles[0], bytes, used, bytes.length - used, used);
      if (!count) break;
      used += count;
    }
    paths.forEach(checkPath);
    if (used !== 2569832 || !handles.every(fd => unchanged(fstatSync(fd, { bigint: true }))) ||
        !paths.every(file => unchanged(lstatSync(file, { bigint: true })))) throw new Error('HOST_ACL_COMPILER_CHANGED');
    const raw = bytes.subarray(0, used);
    if (sha(raw) !== COMPILER_SHA256) throw new Error('HOST_ACL_COMPILER_PIN');
    return raw;
  } finally {
    let closeError;
    for (const fd of handles.reverse()) {
      try { closeSync(fd); } catch (error) { closeError ??= error; }
    }
    if (closeError) throw closeError;
  }
}

/** Called only by scripts/build.mjs; no helper execution and no unpinned compiler fallback. */
export function prepareHostAcl() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('HOST_ACL_BUILD_WINDOWS_X64_ONLY');
  const repository = realpathSync(process.cwd());
  const source = path.join(repository, 'engineering/windows/host-acl/NativeAclHelper.cs');
  if (sha(fixedRead(source, 65536)) !== SOURCE_SHA256 || sha(readFixedCompiler()) !== COMPILER_SHA256) throw new Error('HOST_ACL_BUILD_PIN');
  const parent = path.join(repository, 'vendor'); noLinks(parent);
  const root = path.join(parent, 'host-acl'); const attempt = randomUUID();
  const staging = path.join(parent, `host-acl-build-${attempt}`);
  const previous = path.join(parent, `host-acl-previous-${attempt}`);
  const hadRoot = readdirSync(parent).includes('host-acl');
  if (hadRoot) {
    noLinks(root);
    if (!lstatSync(root).isDirectory() || readdirSync(root).sort().join(',') !== 'NativeAclHelper.exe,manifest.json') throw new Error('HOST_ACL_BUILD_PREVIOUS_INVENTORY');
    fixedRead(path.join(root, 'manifest.json'), 65536); fixedRead(path.join(root, 'NativeAclHelper.exe'), 1048576);
  }
  mkdirSync(staging);
  const executable = path.join(staging, 'NativeAclHelper.exe');
  const start = process.hrtime.bigint();
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/debug-', `/out:${executable}`, source], {
    cwd: repository, shell: false, windowsHide: true, timeout: 30000, maxBuffer: 65536,
    env: { SystemRoot: process.env.SystemRoot ?? 'C:/Windows' },
  });
  if (Number(process.hrtime.bigint() - start) / 1e6 > 30000 || result.error || result.status !== 0 || result.signal !== null || result.stderr?.length || result.stdout?.length) throw new Error('HOST_ACL_BUILD_COMPILE');
  const bytes = fixedRead(executable, 1048576);
  if (sha(fixedRead(source, 65536)) !== SOURCE_SHA256 || sha(readFixedCompiler()) !== COMPILER_SHA256) throw new Error('HOST_ACL_BUILD_CHANGED');
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, scope: 'fixed-host-acl-dotnet-v1', protocolVersion: 1,
    sourceSha256: SOURCE_SHA256, compilerSha256: COMPILER_SHA256,
    files: [{ path: 'NativeAclHelper.exe', bytes: bytes.length, sha256: sha(bytes) }] }, null, 2) + '\n');
  writeFileSync(path.join(staging, 'manifest.json'), manifest, { flag: 'wx' });
  if (readdirSync(staging).sort().join(',') !== 'NativeAclHelper.exe,manifest.json') throw new Error('HOST_ACL_BUILD_INVENTORY');
  noLinks(staging);
  // Preserve previous bytes rather than trusting/reusing them as a compiler result.
  // Any publish error aborts the build; no runtime fallback or recursive deletion.
  if (hadRoot) renameSync(root, previous);
  renameSync(staging, root);
  // No compiled helper is executed during the build.
  return {
    __FORGEDESK_HOST_ACL_DEV_ROOT__: JSON.stringify(root),
    __FORGEDESK_HOST_ACL_MANIFEST_SHA256__: JSON.stringify(sha(manifest)),
    __FORGEDESK_HOST_ACL_EXECUTABLE_SHA256__: JSON.stringify(sha(bytes)),
    __FORGEDESK_HOST_ACL_SOURCE_SHA256__: JSON.stringify(SOURCE_SHA256),
  };
}
