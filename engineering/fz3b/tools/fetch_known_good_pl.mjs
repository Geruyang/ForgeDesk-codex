import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const sourcePath = path.join(projectRoot, 'engineering/fz3b/tools/export_known_good_pl.py');
export const sourceSha256 = 'cb64df729bf22a500d8d04082f39178ef0db21cd443731a57eafa1ed6a7d8f23';
export const knownHostLine = '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ';
export const manifest = Object.freeze([
  Object.freeze({ name: 'cnn_rtl.bit', bytes: 5568891, sha256: '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726' }),
  Object.freeze({ name: 'cnn_rtl.native.bin', bytes: 5568668, sha256: 'bf788681c0e990c337b07ee949bec735dd81224bcabc4d5948d03221e217d439' }),
  Object.freeze({ name: 'cnn_rtl.pcap.bin', bytes: 5568668, sha256: '76dff052e3648a4634585bbed186cfa202b434c66c996a3d2b3349fa3b908c02' }),
]);
export const MAX_STDOUT = 24 * 1024 * 1024;
const MAX_STDERR = 32 * 1024;
const TIMEOUT_MS = 60_000;
const sha256 = data => createHash('sha256').update(data).digest('hex');

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function validateEnvelope(raw, expected = manifest) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_STDOUT) throw new Error('response-size-limit');
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { throw new Error('invalid-response-json'); }
  if (!exactKeys(value, ['schemaVersion', 'scope', 'readOnly', 'deployed', 'entries']) ||
      value.schemaVersion !== 1 || value.scope !== 'fz3b-known-good-pl-readonly' ||
      value.readOnly !== true || value.deployed !== false || !Array.isArray(value.entries) ||
      value.entries.length !== expected.length) throw new Error('invalid-response-envelope');
  const files = [];
  for (let index = 0; index < expected.length; index++) {
    const entry = value.entries[index];
    const fixed = expected[index];
    if (!exactKeys(entry, ['name', 'bytes', 'sha256', 'base64']) ||
        entry.name !== fixed.name || entry.bytes !== fixed.bytes || entry.sha256 !== fixed.sha256 ||
        typeof entry.base64 !== 'string' || entry.base64.length !== 4 * Math.ceil(fixed.bytes / 3) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(entry.base64)) throw new Error('artifact-declaration-mismatch');
    const bytes = Buffer.from(entry.base64, 'base64');
    if (bytes.length !== fixed.bytes || bytes.toString('base64') !== entry.base64 ||
        sha256(bytes) !== fixed.sha256) throw new Error('artifact-byte-mismatch');
    files.push({ name: fixed.name, bytes });
  }
  return files;
}

export function sshArgs(known, key) {
  return ['-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=NUL',
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '-i', key, 'root@169.254.220.254', 'python3 -B -'];
}

export async function captureRemote(script, args, spawnImpl = spawn, timeoutMs = TIMEOUT_MS) {
  const child = spawnImpl('ssh.exe', args, { windowsHide: true, cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  let total = 0;
  let stderrBytes = 0;
  let failure = null;
  let stopRequested = false;
  const graceMs = Math.min(250, Math.max(1, Math.floor(timeoutMs / 4)));
  let timer;
  let graceTimer;
  const requestStop = reason => {
    failure ??= reason;
    if (stopRequested) return;
    stopRequested = true;
    try { child.kill(); } catch { failure = reason + '-kill-failed-outcome-unknown'; }
  };
  child.stdout.on('data', chunk => {
    total += chunk.length;
    if (total > MAX_STDOUT) requestStop('stdout-size-limit');
    else chunks.push(chunk);
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR) requestStop('stderr-size-limit');
  });
  child.stdout.on('error', () => { failure ??= 'ssh-stdout-failed'; });
  child.stderr.on('error', () => { failure ??= 'ssh-stderr-failed'; });
  child.on('error', () => { failure = 'ssh-spawn-failed'; });
  child.stdin.on('error', () => { failure ??= 'ssh-stdin-failed'; });
  const closed = new Promise(resolve => child.once('close', (...values) => resolve(values)));
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      requestStop('ssh-deadline-outcome-unknown');
      graceTimer = setTimeout(() => resolve([null, 'deadline']), graceMs);
    }, Math.max(1, timeoutMs - graceMs));
  });
  try { child.stdin.end(script); } catch { requestStop('ssh-stdin-failed'); }
  const [exitCode, signal] = await Promise.race([closed, deadline]);
  clearTimeout(timer);
  clearTimeout(graceTimer);
  if (signal === 'deadline') {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref?.();
  }
  if (failure || exitCode !== 0 || signal) throw new Error(failure ?? 'ssh-nonzero-exit');
  return Buffer.concat(chunks, total);
}

function regularPrivateFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('private-file-not-regular');
}

export function commitVerified(files, sourceHash, base = path.join(projectRoot, 'output/known-good-pl'), deadline = Infinity) {
  if (path.resolve(base) !== path.join(projectRoot, 'output/known-good-pl') ||
      !Array.isArray(files) || files.length !== manifest.length ||
      files.some((file, index) => !file || file.name !== manifest[index].name ||
        !Buffer.isBuffer(file.bytes) || file.bytes.length !== manifest[index].bytes ||
        sha256(file.bytes) !== manifest[index].sha256)) throw new Error('unverified-local-files');
  const outputRoot = path.join(projectRoot, 'output');
  if (!fs.lstatSync(outputRoot).isDirectory() || fs.realpathSync(outputRoot) !== outputRoot)
    throw new Error('output-parent-not-real-directory');
  fs.mkdirSync(base, { recursive: true });
  if (!fs.lstatSync(base).isDirectory() || fs.realpathSync(base) !== path.resolve(base))
    throw new Error('output-root-not-real-directory');
  const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex');
  const directory = path.join(base, name);
  fs.mkdirSync(directory); // Exclusive: existing directory is an error.
  for (const file of files) {
    if (Date.now() >= deadline) throw new Error('fetch-deadline');
    const fd = fs.openSync(path.join(directory, file.name), 'wx', 0o600);
    try { fs.writeFileSync(fd, file.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (Date.now() >= deadline) throw new Error('fetch-deadline');
  const receipt = { schemaVersion: 1, scope: 'fz3b-known-good-pl-readonly',
    retrievedAt: new Date().toISOString(), source: path.relative(projectRoot, sourcePath),
    sourceSha256: sourceHash, authentication: 'project-public-key', hostTrust: 'TOFU-continuity',
    remoteReadOnly: true, deployed: false, programmed: false,
    files: files.map(file => ({ name: file.name, bytes: file.bytes.length, sha256: sha256(file.bytes) })) };
  const temporaryReceipt = path.join(directory, 'receipt.json.tmp');
  const fd = fs.openSync(temporaryReceipt, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (Date.now() >= deadline) throw new Error('fetch-deadline');
  fs.linkSync(temporaryReceipt, path.join(directory, 'receipt.json'));
  try { fs.unlinkSync(temporaryReceipt); } catch { /* Published receipt is already complete. */ }
  return directory;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error('no-arguments-accepted');
  const deadline = Date.now() + TIMEOUT_MS;
  const priv = path.join(projectRoot, '.runtime/fz3b-private');
  const known = path.join(priv, 'known_hosts');
  const key = path.join(priv, 'fz3b_acceptance_ed25519');
  regularPrivateFile(known);
  regularPrivateFile(key);
  if (fs.readFileSync(known, 'utf8').trim() !== knownHostLine) throw new Error('host-continuity-mismatch');
  regularPrivateFile(sourcePath);
  const script = fs.readFileSync(sourcePath);
  if (script.length > 65536 || sha256(script) !== sourceSha256) throw new Error('source-hash-mismatch');
  const raw = await captureRemote(script, sshArgs(known, key), spawn,
    Math.max(1, deadline - Date.now()));
  if (sha256(fs.readFileSync(sourcePath)) !== sourceSha256) throw new Error('source-changed');
  const files = validateEnvelope(raw);
  if (Date.now() >= deadline) throw new Error('fetch-deadline');
  const directory = commitVerified(files, sourceSha256, undefined, deadline);
  console.log(JSON.stringify({ directory, files: files.map(file => file.name),
    readOnly: true, deployed: false, programmed: false }));
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Known-good PL fetch failed: ${error.message}`); process.exitCode = 1; });
}
