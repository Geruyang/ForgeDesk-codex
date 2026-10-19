import { runFz3bHostAcl } from './host-acl.js';
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { noLinks } from '../embedded/files.js';

const exec = promisify(execFile);
export const FZ3B_PROJECT_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMu194W5GvW9GLcHfzp8+mcZfg3voUcSw9FzEetyH5gO';
const PUBLIC_BLOB = Buffer.from(FZ3B_PROJECT_PUBLIC_KEY.split(' ')[1], 'base64');
export const FZ3B_PROJECT_KEY_FINGERPRINT = `SHA256:${createHash('sha256').update(PUBLIC_BLOB).digest('base64').replace(/=+$/, '')}`;
export const fz3bPrivateKeyPath = (dataDir: string) => path.join(path.resolve(dataDir), 'fz3b-private', 'id_ed25519');

export function validateFz3bPrivateKey(bytes: Buffer): void {
  if (bytes.length < 128 || bytes.length > 16384 || bytes.some(byte => byte > 127 || byte === 0)) throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  const text = bytes.toString('ascii').trim();
  if (!/^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END OPENSSH PRIVATE KEY-----$/.test(text)) throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  const encoded = text.split(/\r?\n/).slice(1, -1).join('');
  const raw = Buffer.from(encoded, 'base64');
  if (raw.toString('base64') !== encoded) throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  if (raw.subarray(0, 15).toString('binary') !== 'openssh-key-v1\0') throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  let offset = 15;
  const word = () => { if (offset + 4 > raw.length) throw new Error('FZ3B_PROJECT_KEY_FORMAT'); const value = raw.readUInt32BE(offset); offset += 4; return value; };
  const field = () => { const length = word(); if (length > 8192 || offset + length > raw.length) throw new Error('FZ3B_PROJECT_KEY_FORMAT'); const value = raw.subarray(offset, offset + length); offset += length; return value; };
  if (field().toString() !== 'none' || field().toString() !== 'none' || field().length || word() !== 1 || !field().equals(PUBLIC_BLOB)) throw new Error('FZ3B_PROJECT_KEY_NOT_FIXED_OR_ENCRYPTED');
  const secret = field(); if (offset !== raw.length) throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  offset = 0;
  const privateWord = () => { if (offset + 4 > secret.length) throw new Error('FZ3B_PROJECT_KEY_FORMAT'); const value = secret.readUInt32BE(offset); offset += 4; return value; };
  const privateField = () => { const length = privateWord(); if (length > 4096 || offset + length > secret.length) throw new Error('FZ3B_PROJECT_KEY_FORMAT'); const value = secret.subarray(offset, offset + length); offset += length; return value; };
  if (privateWord() !== privateWord() || privateField().toString() !== 'ssh-ed25519') throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  const publicBytes = privateField(); const privateBytes = privateField(); privateField();
  if (publicBytes.length !== 32 || privateBytes.length !== 64 || !publicBytes.equals(PUBLIC_BLOB.subarray(-32)) || !privateBytes.subarray(32).equals(publicBytes)) throw new Error('FZ3B_PROJECT_KEY_NOT_FIXED');
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), privateBytes.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const derived = createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (!derived.subarray(-32).equals(publicBytes)) throw new Error('FZ3B_PROJECT_KEY_NOT_FIXED');
  for (let padding = 1; offset < secret.length; padding++, offset++) if (secret[offset] !== padding) throw new Error('FZ3B_PROJECT_KEY_FORMAT');
}

export async function currentSid(): Promise<string> {
  const system = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
  const result = await exec(path.join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  const values = result.stdout.match(/S-1-5-(?:\d+-)*\d+/g);
  if (values?.length !== 1) throw new Error('FZ3B_CURRENT_SID_UNAVAILABLE');
  return values[0];
}
const PRIVATE_ACL_SCRIPT = `$ErrorActionPreference='Stop';$p=$env:FORGEDESK_PRIVATE_PATH;$s=[Security.Principal.SecurityIdentifier]::new($env:FORGEDESK_PRIVATE_SID);if($env:FORGEDESK_SET_ACL -eq '1'){$d=(Get-Item -LiteralPath $p).PSIsContainer;if($d){$a=[Security.AccessControl.DirectorySecurity]::new()}else{$a=[Security.AccessControl.FileSecurity]::new()};$a.SetOwner($s);$a.SetAccessRuleProtection($true,$false);$r=[Security.AccessControl.FileSystemAccessRule]::new($s,'FullControl','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath $p -AclObject $a};$a=Get-Acl -LiteralPath $p;if(!$a.AreAccessRulesProtected){throw 'ACL inheritance remains enabled'};foreach($r in $a.Access){if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $s.Value -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited){throw 'Unexpected private-key ACL'}};if($a.Access.Count -ne 1){throw 'Unexpected private-key ACL count'};Write-Output 'FZ3B_PRIVATE_ACL_OK'`;
async function privateAcl(file: string, sid: string, update: boolean): Promise<void> {
  const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = PRIVATE_ACL_SCRIPT;
  const result = await exec(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096,
    env: { SystemRoot: process.env.SystemRoot ?? 'C:/Windows', FORGEDESK_PRIVATE_PATH: file, FORGEDESK_PRIVATE_SID: sid, FORGEDESK_SET_ACL: update ? '1' : '0' },
  });
  if (result.stdout.trim() !== 'FZ3B_PRIVATE_ACL_OK') throw new Error('FZ3B_PRIVATE_KEY_ACL_UNEXPECTED');
}

// Host phases avoid PowerShell's Security module discovery on their critical deadline.



/** Main-only host checkpoint ACL. Existing credential APIs retain their original script/behavior. */
export function fz3bPrivateAclSync(file: string, sid: string, update: boolean): void {
  if (process.platform !== 'win32' || !path.isAbsolute(file) || file.includes('\0') || !/^S-1-5-(?:\d+-)*\d+$/.test(sid)) throw new Error('FZ3B_HOST_PRIVATE_ACL_INPUT');
  runFz3bHostAcl(update ? 2 : 1, [file], sid);
}

/** One bounded, read-only private-ACL phase. Callers still verify named identities/content. */
export function fz3bPrivateAclBatchSync(files: readonly string[], sid: string): void {
  if (process.platform !== 'win32' || !Array.isArray(files) || !files.length || files.length > 51 || new Set(files).size !== files.length ||
      files.some(file => typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) || !/^S-1-5-(?:\d+-)*\d+$/.test(sid)) throw new Error('FZ3B_HOST_PRIVATE_ACL_BATCH_INPUT');
  if (Buffer.byteLength(JSON.stringify(files)) > 24576) throw new Error('FZ3B_HOST_PRIVATE_ACL_BATCH_INPUT');
  runFz3bHostAcl(3, files, sid);
}

/** Read-only trust check for the pre-existing backend MAC authority; never changes its ACL. */
export function fz3bHostDependencyAclSync(dataRoot: string, sid: string): void {
  if (process.platform !== 'win32' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0') || !/^S-1-5-(?:\d+-)*\d+$/.test(sid)) throw new Error('FZ3B_HOST_DEPENDENCY_ACL_INPUT');
  runFz3bHostAcl(4, [dataRoot], sid);
}

/** Only a native file picker or trusted installer may supply this path; never a model tool argument. */
export async function importFz3bProjectKey(sourcePath: string, dataDir: string): Promise<{ fingerprint: string }> {
  if (process.platform !== 'win32' || !path.isAbsolute(sourcePath) || !path.isAbsolute(dataDir)) throw new Error('FZ3B_KEY_IMPORT_REQUIRES_WINDOWS_NATIVE_PATH');
  await noLinks(sourcePath);
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  const bytes = await readFile(sourcePath); validateFz3bPrivateKey(bytes);
  const target = fz3bPrivateKeyPath(dataDir); const directory = path.dirname(target);
  await mkdir(directory, { recursive: true }); await noLinks(directory);
  const sid = await currentSid(); await privateAcl(directory, sid, true);
  const handle = await open(target, 'wx', 0o600);
  try { await privateAcl(target, sid, true); await handle.writeFile(bytes); await handle.sync(); }
  finally { bytes.fill(0); await handle.close(); }
  return { fingerprint: FZ3B_PROJECT_KEY_FINGERPRINT };
}

export async function requireFz3bProjectKey(dataDir: string): Promise<string> {
  const file = fz3bPrivateKeyPath(dataDir); await noLinks(file);
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 16384) throw new Error('FZ3B_PROJECT_KEY_FORMAT');
  const bytes = await readFile(file);
  try { validateFz3bPrivateKey(bytes); } finally { bytes.fill(0); }
  if (process.platform === 'win32') {
    const sid = await currentSid(); await privateAcl(path.dirname(file), sid, false); await privateAcl(file, sid, false);
  }
  return file;
}
