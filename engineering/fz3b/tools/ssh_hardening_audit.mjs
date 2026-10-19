import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownHostLine, projectRoot, sshArgs } from './fetch_known_good_pl.mjs';

const sourcePath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_hardening_audit.py');
export const sourceSha256 = 'cbbd6d8327d6f6e7c18f2f2a86401e26a2308861b83492462d64f1ddd6703c73';
export const MAX_STDOUT = 32 * 1024;
const MAX_STDERR = 8 * 1024;
const TIMEOUT_MS = 35_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function regularFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('local-file-not-regular');
}

function evidenceParent() {
  let current = projectRoot;
  for (const part of ['output', 'hardware', '2026-10-16-next', 'ssh-hardening']) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== path.resolve(current))
      throw new Error('evidence-parent-not-real-directory');
  }
  return current;
}

export async function captureAudit(script, args, spawnImpl = spawn, timeoutMs = TIMEOUT_MS) {
  const child = spawnImpl('ssh.exe', args, { windowsHide: true, cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure = null;
  let stopping = false;
  let timer;
  let graceTimer;
  const graceMs = Math.min(250, Math.max(1, Math.floor(timeoutMs / 4)));
  const stop = reason => {
    failure ??= reason;
    if (stopping) return;
    stopping = true;
    try { if (!child.kill()) failure = `${reason}-termination-unconfirmed`; }
    catch { failure = `${reason}-termination-unconfirmed`; }
  };
  child.stdout.on('data', chunk => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT) stop('stdout-size-limit');
    else chunks.push(chunk);
  });
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR) stop('stderr-size-limit');
  });
  child.stdout.on('error', () => { failure ??= 'ssh-stdout-failed'; });
  child.stderr.on('error', () => { failure ??= 'ssh-stderr-failed'; });
  child.stdin.on('error', () => { failure ??= 'ssh-stdin-failed'; });
  child.on('error', () => { failure = 'ssh-spawn-failed'; });
  const closed = new Promise(resolve => child.once('close', (...values) => resolve(values)));
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      stop('ssh-deadline-outcome-unknown');
      graceTimer = setTimeout(() => resolve([null, 'deadline']), graceMs);
    }, Math.max(1, timeoutMs - graceMs));
  });
  try { child.stdin.end(script); } catch { stop('ssh-stdin-failed'); }
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
  return Buffer.concat(chunks, stdoutBytes);
}

export function validateAudit(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_STDOUT) throw new Error('audit-output-limit');
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('invalid-audit-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== 1 || value.scope !== 'fz3b-ssh-auth-readonly-audit' ||
      value.host !== '169.254.220.254' || value.readOnly !== true ||
      value.configurationChanged !== false || value.serviceActions !== 'not-attempted' ||
      value.passwordOrShadowRead !== false || value.privateKeyRead !== false ||
      !['audit-collected', 'audit-incomplete'].includes(value.result) ||
      !Array.isArray(value.issues) || !Array.isArray(value.files) ||
      !value.commands || typeof value.commands !== 'object' ||
      typeof value.currentSessionMatchesExpectedConnection !== 'boolean' ||
      value.expectedConnection?.sourceAddress !== '169.254.142.174' ||
      value.expectedConnection?.destinationAddress !== '169.254.220.254' ||
      value.expectedConnection?.destinationPort !== 22 ||
      (value.currentSessionMatchesExpectedConnection === false && value.result !== 'audit-incomplete') ||
      (value.commands.effectiveRoot?.exitCode === 0 &&
       value.commands.effectiveRoot?.matchContext !==
         'user=root,host=169.254.142.174,addr=169.254.142.174,laddr=169.254.220.254,lport=22'))
    throw new Error('invalid-audit-envelope');
  if (value.issues.some(item => typeof item !== 'string' || item.length > 160 ||
      !/^[ -~]*$/.test(item))) throw new Error('invalid-audit-issue');
  return value;
}

function writeReceipt(audit) {
  const base = evidenceParent();
  const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(6).toString('hex');
  const directory = path.join(base, name);
  fs.mkdirSync(directory);
  const receipt = { schemaVersion: 1, scope: 'fz3b-ssh-hardening-audit-receipt',
    collectedAt: new Date().toISOString(), sourceSha256, hostTrust: 'pinned-ed25519-continuity',
    authentication: 'existing-project-public-key', readOnly: true,
    configurationChanged: false, passwordRotated: false, remotePasswordLoginDisabled: false,
    audit };
  const fd = fs.openSync(path.join(directory, 'audit.json'), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return directory;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error('no-arguments-accepted');
  const privateRoot = path.join(projectRoot, '.runtime/fz3b-private');
  const known = path.join(privateRoot, 'known_hosts');
  const key = path.join(privateRoot, 'fz3b_acceptance_ed25519');
  regularFile(known);
  regularFile(key);
  regularFile(sourcePath);
  if (fs.readFileSync(known, 'utf8').trim() !== knownHostLine)
    throw new Error('host-continuity-mismatch');
  const source = fs.readFileSync(sourcePath);
  if (source.length > 65536 || sha256(source) !== sourceSha256)
    throw new Error('source-hash-mismatch');
  const raw = await captureAudit(source, sshArgs(known, key));
  if (sha256(fs.readFileSync(sourcePath)) !== sourceSha256) throw new Error('source-changed');
  const audit = validateAudit(raw);
  const directory = writeReceipt(audit);
  console.log(JSON.stringify({ directory, result: audit.result, issues: audit.issues.length,
    readOnly: true, configurationChanged: false }));
  return directory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`SSH hardening audit failed: ${error.message}`);
    process.exitCode = 1;
  });
}
