import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownHostLine, projectRoot } from './fetch_known_good_pl.mjs';
import { captureOwnedSsh } from './ssh_script_receipt.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const knownPath = path.join(projectRoot, '.runtime/fz3b-private/known_hosts');
const rootPolicyReceipt = path.join(projectRoot,
  'output/hardware/2026-10-16-next/ssh-hardening/root-policy/receipt.json');
const helperPath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_script_receipt.mjs');
const helperSha = '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515';

function regularFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('local-file-not-regular');
  return fs.readFileSync(filename);
}

function evidenceParent() {
  let current = projectRoot;
  for (const part of ['output', 'hardware', '2026-10-16-next', 'ssh-hardening', 'method-offer']) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    if (!fs.lstatSync(current).isDirectory() || fs.realpathSync(current) !== path.resolve(current))
      throw new Error('evidence-parent-not-real-directory');
  }
  return current;
}

function writeExclusive(filename, value) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export function noCredentialArgs(known) {
  return ['-F', 'NUL', '-T', '-vv', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`,
    '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none', '-o', 'PubkeyAuthentication=no',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'GSSAPIAuthentication=no', '-o', 'HostbasedAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive',
    '-o', 'NumberOfPasswordPrompts=0', '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none', '-o', 'ConnectTimeout=6',
    '-o', 'ConnectionAttempts=1', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', 'root@169.254.220.254', 'true'];
}

export function offeredMethods(stderr) {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr, 'utf8') > 32768)
    throw new Error('ssh-debug-output-limit');
  const lines = [...stderr.matchAll(/^debug1: Authentications that can continue: ([a-z-]+(?:,[a-z-]+)*)\r?$/gm)];
  if (lines.length !== 1) throw new Error('server-method-list-unobserved-or-ambiguous');
  const methods = lines[0][1].split(',');
  if (methods.length !== 1 || methods[0] !== 'publickey')
    throw new Error('server-offered-nonpublickey-method');
  return methods;
}

export function validatePolicyReceipt(raw) {
  const value = JSON.parse(raw.toString('utf8'));
  if (value.schemaVersion !== 1 || value.scope !== 'fz3b-root-publickey-only-policy' ||
      value.result !== 'committed-reloaded' ||
      value.sourceSha256 !== 'c384335524d64fed22b3b5d865b37a4ab4643c7a14ed25d6eb44a4874dc5bd5f' ||
      value.originalConfigSha256 !== 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216' ||
      value.authorizedSha256 !== 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f' ||
      value.candidateBytes !== 3405 ||
      value.serviceAction !== 'reload' || value.sshCloseConfirmed !== true ||
      value.sshExitObserved !== true || value.hostTrust !== 'pinned-ed25519-continuity' ||
      value.passwordLoginStillRequiresIndependentPostcheck !== true)
    throw new Error('root-policy-receipt-invalid');
  return value;
}

export function observedOffer(captured) {
  if (captured?.sshCloseConfirmed !== true || captured?.sshExitObserved !== true ||
      captured?.exitCode !== 255 || captured?.signal !== null || captured?.killAttempted !== false ||
      captured?.stdout !== '')
    throw new Error('ssh-handshake-unconfirmed');
  return offeredMethods(captured.stderr);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error('no-arguments-accepted');
  if (regularFile(knownPath).toString('utf8').trim() !== knownHostLine)
    throw new Error('host-continuity-mismatch');
  if (sha256(regularFile(helperPath)) !== helperSha) throw new Error('capture-helper-changed');
  const policy = regularFile(rootPolicyReceipt);
  validatePolicyReceipt(policy);
  const parent = evidenceParent();
  const directory = path.join(parent, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(directory);
  const captured = await captureOwnedSsh(Buffer.alloc(0), noCredentialArgs(knownPath),
    { timeoutMs: 20000 });
  let methods = null;
  try { methods = observedOffer(captured); } catch { /* Unknown, never claim blocked. */ }
  const receipt = { schemaVersion: 1, scope: 'fz3b-root-server-method-offer',
    result: methods ? 'only-publickey-offered' : 'unknown',
    observedAt: new Date().toISOString(), hostTrust: 'pinned-ed25519-continuity',
    policyReceiptSha256: sha256(policy), passwordSent: false, privateKeyUsed: false,
    remoteCommandRan: false, offeredMethods: methods,
    sshCloseConfirmed: captured.sshCloseConfirmed, sshExitObserved: captured.sshExitObserved,
    sshExitCode: captured.exitCode, localSshPid: captured.localSshPid,
    killAttempted: captured.killAttempted,
    stderrBytes: Buffer.byteLength(captured.stderr, 'utf8'),
    stderrSha256: sha256(Buffer.from(captured.stderr, 'utf8')) };
  writeExclusive(path.join(directory, 'receipt.json'), receipt);
  console.log(JSON.stringify({ directory, result: receipt.result, offeredMethods: methods }));
  if (!methods) process.exitCode = 1;
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Method offer probe failed: ${error.message}`); process.exitCode = 1; });
}
