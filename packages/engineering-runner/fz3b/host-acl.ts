import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

declare const __FORGEDESK_HOST_ACL_DEV_ROOT__: string;
declare const __FORGEDESK_HOST_ACL_MANIFEST_SHA256__: string;
declare const __FORGEDESK_HOST_ACL_EXECUTABLE_SHA256__: string;
declare const __FORGEDESK_HOST_ACL_SOURCE_SHA256__: string;

const DEADLINE_MS = 5000;
const FRAME_LIMIT = 32768;
const OUTPUT_LIMIT = 4096;
const SOURCE_SHA256 = 'aa3079992d2ac92b5dd800d3e5c62f70671dce36ff80b28ca7f6f8694e75786e';
const COMPILER_SHA256 = '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00';
const EXECUTABLE = 'NativeAclHelper.exe';
const MAGIC = Buffer.from('FZ3B-ACL-v1\0', 'ascii');
let packagedMode: boolean | undefined;
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function failure(role: string): never { throw new Error(`FZ3B_HOST_ACL_HELPER_${role}`); }
const keys = (value: unknown, expected: string): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === expected;

/** Trusted main composition passes actual app.isPackaged once; no path/IPC option. */
export function initializeFz3bHostAclHelper(isPackaged: boolean): void {
  if (packagedMode !== undefined || typeof isPackaged !== 'boolean') failure('INITIALIZATION');
  packagedMode = isPackaged;
}

function frame(operation: 1 | 2 | 3 | 4, files: readonly string[], sid: string): Buffer {
  if (!Number.isInteger(operation) || operation < 1 || operation > 4 || !/^S-1-5-(?:[0-9]+-)*[0-9]+$/.test(sid) ||
      !Array.isArray(files) || !files.length || files.length > 51 || operation !== 3 && files.length !== 1 ||
      new Set(files).size !== files.length || files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))) failure('INPUT');
  if (operation === 3 && Buffer.byteLength(JSON.stringify(files)) > 24576) failure('INPUT');
  const sidBytes = Buffer.from(sid, 'utf8'); if (sidBytes.length > 256) failure('INPUT');
  const word = (value: number) => { const raw = Buffer.alloc(2); raw.writeUInt16BE(value); return raw; };
  const pieces = [MAGIC, Buffer.from([operation]), word(sidBytes.length), sidBytes, word(files.length)];
  for (const file of files) {
    const raw = Buffer.from(file, 'utf8');
    if (raw.toString('utf8') !== file || raw.length > FRAME_LIMIT) failure('INPUT');
    const length = Buffer.alloc(4); length.writeUInt32BE(raw.length); pieces.push(length, raw);
  }
  const input = Buffer.concat(pieces); if (input.length > FRAME_LIMIT) failure('INPUT'); return input;
}

function noLinks(file: string): void {
  if (!path.isAbsolute(file)) failure('PATH');
  const parsed = path.parse(file); let current = parsed.root;
  for (const part of file.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) failure('LINK');
  }
}

function sameIdentity(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs &&
    a.birthtimeMs === b.birthtimeMs && a.mode === b.mode && a.nlink === b.nlink;
}

function pinnedRead(file: string, limit: number): Buffer {
  noLinks(file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > limit) failure('FILE');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd); if (!opened.isFile() || !sameIdentity(before, opened)) failure('IDENTITY');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) failure('READ'); offset += count; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || !sameIdentity(opened, fs.fstatSync(fd))) failure('IDENTITY');
    noLinks(file); if (!sameIdentity(before, fs.lstatSync(file))) failure('IDENTITY'); return bytes;
  } finally { fs.closeSync(fd); }
}

function verifiedExecutable(): string {
  if (packagedMode === undefined) failure('INITIALIZATION');
  if (typeof __FORGEDESK_HOST_ACL_DEV_ROOT__ === 'undefined' || typeof __FORGEDESK_HOST_ACL_MANIFEST_SHA256__ === 'undefined' ||
      typeof __FORGEDESK_HOST_ACL_EXECUTABLE_SHA256__ === 'undefined' || typeof __FORGEDESK_HOST_ACL_SOURCE_SHA256__ === 'undefined' ||
      !/^[a-f0-9]{64}$/.test(__FORGEDESK_HOST_ACL_MANIFEST_SHA256__) || !/^[a-f0-9]{64}$/.test(__FORGEDESK_HOST_ACL_EXECUTABLE_SHA256__) ||
      __FORGEDESK_HOST_ACL_SOURCE_SHA256__ !== SOURCE_SHA256) failure('BUILD_PIN');
  const runtime = process as NodeJS.Process & { resourcesPath?: string };
  const packaged = packagedMode;
  const root = packaged ? path.join(runtime.resourcesPath ?? '', 'host-acl') : __FORGEDESK_HOST_ACL_DEV_ROOT__;
  if (!path.isAbsolute(root) || packaged && !path.isAbsolute(runtime.resourcesPath ?? '')) failure('PATH');
  noLinks(root);
  if (!fs.lstatSync(root).isDirectory() || fs.readdirSync(root).sort().join(',') !== `${EXECUTABLE},manifest.json`) failure('INVENTORY');
  const raw = pinnedRead(path.join(root, 'manifest.json'), 65536);
  if (digest(raw) !== __FORGEDESK_HOST_ACL_MANIFEST_SHA256__) failure('MANIFEST_PIN');
  let manifest: unknown; try { manifest = JSON.parse(raw.toString('utf8')); } catch { failure('MANIFEST'); }
  if (!keys(manifest, 'compilerSha256,files,protocolVersion,schemaVersion,scope,sourceSha256') || manifest.schemaVersion !== 1 ||
      manifest.scope !== 'fixed-host-acl-dotnet-v1' || manifest.protocolVersion !== 1 || manifest.sourceSha256 !== SOURCE_SHA256 ||
      manifest.compilerSha256 !== COMPILER_SHA256 || !Array.isArray(manifest.files) || manifest.files.length !== 1) failure('MANIFEST');
  const item = manifest.files[0];
  if (!keys(item, 'bytes,path,sha256') || item.path !== EXECUTABLE || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 1048576 || item.sha256 !== __FORGEDESK_HOST_ACL_EXECUTABLE_SHA256__) failure('MANIFEST');
  const executable = path.join(root, EXECUTABLE); const bytes = pinnedRead(executable, 1048576);
  if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) failure('EXECUTABLE_PIN');
  return executable;
}

function validateDependency(output: string, sid: string): void {
  let values: unknown; try { values = JSON.parse(output); } catch { failure('OUTPUT'); }
  if (!Array.isArray(values) || values.length !== 3 || JSON.stringify(values) + '\n' !== output) failure('OUTPUT');
  const allowed = new Set([sid, 'S-1-5-18', 'S-1-5-32-544']);
  for (const [index, value] of values.entries()) {
    if (!keys(value, 'owner,protected,rules') || value.owner !== sid || typeof value.protected !== 'boolean' || index === 0 && !value.protected ||
        !Array.isArray(value.rules) || !value.rules.length || value.rules.length > 32 ||
        !value.rules.every((rule: unknown) => keys(rule, 'allow,effective,fullControl,sid') && allowed.has(rule.sid) && rule.allow === true && typeof rule.fullControl === 'boolean' && typeof rule.effective === 'boolean') ||
        !value.rules.some((rule: any) => rule.sid === sid && rule.fullControl && rule.effective)) failure('OUTPUT');
  }
}

/** Main-only fixed resource primitive. No model/IPC/env-selected executable or retry. */
export function runFz3bHostAcl(operation: 1 | 2 | 3 | 4, files: readonly string[], sid: string): string {
  if (process.platform !== 'win32') failure('PLATFORM');
  const start = process.hrtime.bigint(); const input = frame(operation, files, sid);
  const executable = verifiedExecutable();
  const elapsed = () => Number(process.hrtime.bigint() - start) / 1e6;
  if (elapsed() > DEADLINE_MS) failure('DEADLINE');
  const result = spawnSync(executable, [], {
    shell: false, windowsHide: true, timeout: DEADLINE_MS, maxBuffer: OUTPUT_LIMIT, input,
    env: { SystemRoot: process.env.SystemRoot ?? 'C:/Windows' },
  });
  // A synchronous spawn may return late even without its internal timeout firing.
  if (elapsed() > DEADLINE_MS) failure('DEADLINE');
  if (result.error || result.status !== 0 || result.signal !== null || !Buffer.isBuffer(result.stdout) || !Buffer.isBuffer(result.stderr) ||
      result.stderr.length !== 0 || result.stdout.length > OUTPUT_LIMIT) failure('PROCESS');
  const output = result.stdout.toString('utf8'); if (!Buffer.from(output, 'utf8').equals(result.stdout)) failure('OUTPUT');
  if (operation === 4) validateDependency(output, sid);
  else if (output !== (operation === 3 ? 'FZ3B_PRIVATE_ACL_BATCH_OK\n' : 'FZ3B_PRIVATE_ACL_OK\n')) failure('OUTPUT');
  if (elapsed() > DEADLINE_MS) failure('DEADLINE');
  return output;
}
