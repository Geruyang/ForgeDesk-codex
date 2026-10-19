import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureOwnedSsh } from './ssh_script_receipt.mjs';
import { knownHostLine, projectRoot, sshArgs } from './fetch_known_good_pl.mjs';

const sourcePath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_hardening_add_recovery.py');
export const sourceSha256 = '5899d665b1a1ae30eaf4b2cf0cef5120c2181a4dfcd544069f4e64836bb13b5a';
const recoveryPubSha256 = '158b56439ebdd62e85d2cc84bdf91ffe76f9189de46b0fbc7dc5a1072e84a27e';
const authorizedSha256 = '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b';
const recoveryBlobSha256 = '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80';
const backupPath = '/root/.ssh/authorized_keys.fz3b-prehardening-20261016';
const sha256 = value => createHash('sha256').update(value).digest('hex');

function regularFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('local-file-not-regular');
}

function evidenceParent() {
  let current = projectRoot;
  for (const part of ['output', 'hardware', '2026-10-16-next', 'ssh-hardening', 'recovery-key']) {
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

export function validateRecovery(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > 32 * 1024) throw new Error('recovery-output-limit');
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('invalid-recovery-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [
        'schemaVersion', 'scope', 'sshdConfigChanged', 'sshdReloaded',
        'passwordAuthenticationChanged', 'passwordRotated', 'originalAuthorizedSha256',
        'backupPath', 'backupSha256', 'authorizedSha256', 'authorizedBytes',
        'projectPublicKeyCount', 'recoveryPublicKeyCount', 'recoveryPublicKeyBlobSha256',
        'independentRecoveryLoginVerified'].sort().join(',') ||
      value.schemaVersion !== 1 || value.scope !== 'fz3b-recovery-key-added' ||
      value.sshdConfigChanged !== false || value.sshdReloaded !== false ||
      value.passwordAuthenticationChanged !== false || value.passwordRotated !== false ||
      value.originalAuthorizedSha256 !== authorizedSha256 ||
      value.backupPath !== backupPath || value.backupSha256 !== authorizedSha256 ||
      typeof value.authorizedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.authorizedSha256) ||
      !Number.isInteger(value.authorizedBytes) || value.authorizedBytes < 220 ||
      value.authorizedBytes > 512 || value.projectPublicKeyCount !== 1 ||
      value.recoveryPublicKeyCount !== 1 ||
      value.recoveryPublicKeyBlobSha256 !== recoveryBlobSha256 ||
      value.independentRecoveryLoginVerified !== false) throw new Error('invalid-recovery-receipt');
  return value;
}

export function transportIsConfirmed(captured) {
  return captured && captured.sshCloseConfirmed === true &&
    captured.sshExitObserved === true && captured.exitCode === 0 &&
    captured.signal === null && captured.failure === null &&
    captured.killAttempted === false && captured.remoteOutcomeUnknown === false;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error('no-arguments-accepted');
  const privateRoot = path.join(projectRoot, '.runtime/fz3b-private');
  const known = path.join(privateRoot, 'known_hosts');
  const key = path.join(privateRoot, 'fz3b_acceptance_ed25519');
  const recoveryPub = path.join(privateRoot, 'fz3b_recovery_ed25519.pub');
  for (const file of [known, key, recoveryPub, sourcePath]) regularFile(file);
  if (fs.readFileSync(known, 'utf8').trim() !== knownHostLine)
    throw new Error('host-continuity-mismatch');
  if (sha256(fs.readFileSync(recoveryPub)) !== recoveryPubSha256)
    throw new Error('recovery-public-key-file-mismatch');
  const script = fs.readFileSync(sourcePath);
  if (script.length > 16384 || sha256(script) !== sourceSha256)
    throw new Error('source-hash-mismatch');
  const parent = evidenceParent();
  const attemptPath = path.join(parent, 'attempt.json');
  writeExclusive(attemptPath, { schemaVersion: 1, scope: 'fz3b-recovery-key-attempt',
    startedAt: new Date().toISOString(), sourceSha256, originalAuthorizedSha256: authorizedSha256,
    recoveryPublicKeyBlobSha256: recoveryBlobSha256, hostTrust: 'pinned-ed25519-continuity',
    authentication: 'existing-project-public-key', outcome: 'pending-or-unknown',
    retryAllowedAutomatically: false });
  let receipt;
  let transport;
  try {
    const captured = await captureOwnedSsh(script, sshArgs(known, key), { timeoutMs: 35000 });
    const { stdout, stderr, observation, ...facts } = captured;
    transport = { schemaVersion: 1, scope: 'fz3b-recovery-key-transport',
      sourceSha256, recordedAt: new Date().toISOString(), ...facts };
    writeExclusive(path.join(parent, 'transport.json'), transport);
    if (!transportIsConfirmed(captured))
      throw new Error('ssh-transport-unconfirmed');
    if (sha256(fs.readFileSync(sourcePath)) !== sourceSha256)
      throw new Error('source-changed-after-remote-attempt');
    receipt = validateRecovery(Buffer.from(stdout, 'utf8'));
  } catch {
    throw new Error('recovery-attempt-outcome-unknown-inspect-board-do-not-retry');
  }
  const receiptPath = path.join(parent, 'receipt.json');
  writeExclusive(receiptPath, { ...receipt, sourceSha256, hostTrust: 'pinned-ed25519-continuity',
    recoveredAt: new Date().toISOString(), localAttemptPath: attemptPath,
    sshCloseConfirmed: transport.sshCloseConfirmed, sshExitObserved: transport.sshExitObserved,
    localSshPid: transport.localSshPid,
    independentRecoveryLoginVerified: false });
  console.log(JSON.stringify({ receiptPath, keyAdded: true, sshdReloaded: false,
    independentRecoveryLoginVerified: false }));
  return receiptPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Recovery key stage failed: ${error.message}`); process.exitCode = 1; });
}
