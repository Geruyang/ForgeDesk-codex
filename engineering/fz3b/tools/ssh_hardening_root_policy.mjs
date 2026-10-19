import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownHostLine, projectRoot, sshArgs as fixedSshArgs } from './fetch_known_good_pl.mjs';
import { captureOwnedSsh } from './ssh_script_receipt.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rootPath = path.join(projectRoot, 'output/hardware/2026-10-16-next/ssh-hardening');
const scriptPath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_hardening_root_policy.py');
const helperPath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_script_receipt.mjs');
const sshOptionsPath = path.join(projectRoot, 'engineering/fz3b/tools/fetch_known_good_pl.mjs');
const knownPath = path.join(projectRoot, '.runtime/fz3b-private/known_hosts');
const keyPath = path.join(projectRoot, '.runtime/fz3b-private/fz3b_acceptance_ed25519');
const bootId = '5ceb45a3-8903-4efc-9484-ec75c17280df';
const authSha = 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f';
const configSha = 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216';
const proofPaths = Object.freeze({
  project: path.join(rootPath, 'key-login/project-2026-10-16T07-38-03-829Z-7eed969a619e/receipt.json'),
  recovery: path.join(rootPath, 'key-login/recovery-2026-10-16T07-39-13-281Z-32462aada06c/receipt.json'),
});
const proofHashes = Object.freeze({
  project: 'e1833c961a6b248d747648ac72f9ed7b91895fd5a0b4983cc270cb9ae8cf1d5e',
  recovery: '054d8a70f6f3d4b6beb7842abddab36f26bd18810aad2c71d79e5067045a100c',
});
const acceptedPins = Object.freeze({
  project: { fingerprint: 'SHA256:CK+/QggbKFueu9/aXfdUgOOSeeOM1xYUq+hYCQjBU4E',
    blob: '08afbf42081b285b9ebbdfda5df75480e39279e38cd71614abe8580908c15381',
    file: 'f280c358961a097c399cbc179af7e2255c80a0765c7af8eeaad478f579596b0d' },
  recovery: { fingerprint: 'SHA256:WZsmwRMiJ+JmafeC7UR7Zfn+fo71YSE4t4ZVzj61TIA',
    blob: '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80',
    file: '158b56439ebdd62e85d2cc84bdf91ffe76f9189de46b0fbc7dc5a1072e84a27e' },
});
const probeSourceSha = '88f2e5f5b68390ddec340fd25a13f2ccb065a1861cc3ba539d293156e5389a5e';
const helperSha = '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515';
const sshOptionsSha = '043c5815d6de96662a0310186fceca38543e93287dddd6535fb058d44105ee30';
export const sourceSha256 = 'c384335524d64fed22b3b5d865b37a4ab4643c7a14ed25d6eb44a4874dc5bd5f';

function regularFile(filename, read = true) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('local-file-not-regular');
  return read ? fs.readFileSync(filename) : null;
}

function fixedDirectory(name) {
  let current = projectRoot;
  for (const part of ['output', 'hardware', '2026-10-16-next', 'ssh-hardening', name]) {
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

export function validateKeyProof(bytes, selected) {
  const value = JSON.parse(bytes.toString('utf8'));
  if (value.schemaVersion !== 1 || value.scope !== 'fz3b-key-login-service-receipt' ||
      value.selectedKey !== selected || value.result !== 'key-login-collected' ||
      value.sourceSha256 !== probeSourceSha || value.helperSha256 !== helperSha ||
      value.hostTrust !== 'pinned-ed25519-continuity' ||
      value.authentication !== 'single-specified-public-key' || value.sourceUnchanged !== true ||
      value.exitCode !== 0 || value.signal !== null || value.failure !== null ||
      value.sshCloseConfirmed !== true || value.sshExitObserved !== true ||
      value.remoteOutcomeUnknown !== false || value.killAttempted !== false ||
      value.cryptographicKeyProof !== true || value.keyProofError !== null ||
      value.acceptedPublicKeyFingerprint !== acceptedPins[selected].fingerprint ||
      value.acceptedPublicKeyBlobSha256 !== acceptedPins[selected].blob ||
      value.publicKeyFileSha256 !== acceptedPins[selected].file ||
      value.report?.scope !== 'fz3b-key-login-service-readonly' ||
      value.report?.readOnly !== true || value.report?.serviceActions !== false ||
      value.report?.filesWritten !== false || value.report?.user !== 'root' ||
      value.report?.uid !== 0 || value.report?.bootId !== bootId ||
      value.report?.authorizedSha256 !== authSha || value.report?.authorizedBytes !== 221 ||
      value.report?.projectPublicKeyCount !== 1 || value.report?.recoveryPublicKeyCount !== 1 ||
      value.report?.connectionSource !== '169.254.142.174' ||
      value.report?.connectionDestination !== '169.254.220.254')
    throw new Error('key-proof-invalid');
  for (const name of ['ssh.service', 'sshd.service']) {
    const service = value.report.services?.[name];
    if (service?.available !== true || service?.Id !== 'ssh.service' ||
        service?.FragmentPath !== '/lib/systemd/system/ssh.service' ||
        service?.ActiveState !== 'active' || service?.LoadState !== 'loaded' ||
        !Number.isInteger(service?.MainPID) || service.MainPID <= 0 ||
        service?.ExecReloadCount !== 2 || !Array.isArray(service?.ExecReloadEntries) ||
        !service.ExecReloadEntries[0]?.includes('argv[]=/usr/sbin/sshd -t ;') ||
        !service.ExecReloadEntries[1]?.includes('argv[]=/bin/kill -HUP $MAINPID ;'))
      throw new Error('service-proof-invalid');
  }
  return value;
}

export function validateResult(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > 32768) throw new Error('policy-output-limit');
  const value = JSON.parse(raw.toString('utf8'));
  if (value.schemaVersion !== 1 || value.scope !== 'fz3b-root-publickey-only-policy' ||
      value.result !== 'committed-reloaded' || value.bootId !== bootId ||
      value.originalConfigSha256 !== configSha || value.originalConfigBytes !== 3248 ||
      value.backupPath !== '/etc/ssh/sshd_config.fz3b-prehardening-20261016' ||
      value.backupSha256 !== configSha || !/^[0-9a-f]{64}$/.test(value.candidateSha256) ||
      value.candidateBytes !== 3405 || value.authorizedSha256 !== authSha ||
      value.rootContextsChecked !== 2 || value.nonrootContextsUnchanged !== 2 ||
      value.serviceId !== 'ssh.service' ||
      value.serviceFragment !== '/lib/systemd/system/ssh.service' ||
      value.serviceAction !== 'reload' || !Number.isInteger(value.servicePidBefore) ||
      value.servicePidBefore <= 0 || !Number.isInteger(value.servicePidAfter) ||
      value.servicePidAfter <= 0 || value.passwordRotated !== false ||
      value.consolePasswordUnchanged !== true || value.remotePasswordLoginPostchecked !== false)
    throw new Error('policy-result-invalid');
  return value;
}

export function validateDiagnostic(value) {
  const phases = ['start', 'preflight-verified', 'backup-durable',
    'candidate-validated', 'replace-started', 'config-replaced-durable',
    'reload-started', 'reload-confirmed', 'rollback-preflight-verified',
    'rollback-stage-validated', 'rollback-replace-started',
    'rollback-config-replaced-durable', 'rollback-reload-started',
    'rollback-reload-confirmed'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== 1 || value.scope !== 'fz3b-root-policy-diagnostic' ||
      value.result !== 'failed-or-unknown' || !phases.includes(value.phase) ||
      !(value.candidateSha256 === null || /^[a-f0-9]{64}$/.test(value.candidateSha256)) ||
      typeof value.errorType !== 'string' || !/^[A-Za-z]{1,40}$/.test(value.errorType) ||
      typeof value.errorCode !== 'string' || !/^[a-z-]{1,80}$/.test(value.errorCode) ||
      !['apply', 'rollback'].includes(value.operation) ||
      value.automaticRetry !== false || value.automaticRollback !== false)
    throw new Error('policy-diagnostic-invalid');
  return value;
}

export function confirmed(captured) {
  return captured?.sshCloseConfirmed === true && captured?.sshExitObserved === true &&
    captured?.exitCode === 0 && captured?.signal === null && captured?.failure === null &&
    captured?.remoteOutcomeUnknown === false && captured?.killAttempted === false;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length) throw new Error('no-arguments-accepted');
  if (regularFile(knownPath).toString('utf8').trim() !== knownHostLine)
    throw new Error('host-continuity-mismatch');
  regularFile(keyPath, false);
  if (sha256(regularFile(helperPath)) !== helperSha) throw new Error('capture-helper-changed');
  if (sha256(regularFile(sshOptionsPath)) !== sshOptionsSha) throw new Error('ssh-options-source-changed');
  const source = regularFile(scriptPath);
  if (source.length > 32768 || sha256(source) !== sourceSha256) throw new Error('source-hash-mismatch');
  for (const selected of ['project', 'recovery']) {
    const proof = regularFile(proofPaths[selected]);
    if (sha256(proof) !== proofHashes[selected]) throw new Error('key-proof-hash-mismatch');
    validateKeyProof(proof, selected);
  }
  const args = fixedSshArgs(knownPath, keyPath);
  const hostIndex = args.indexOf('root@169.254.220.254');
  if (hostIndex < 0 || args[args.length - 1] !== 'python3 -B -')
    throw new Error('fixed-ssh-command-mismatch');
  args.splice(hostIndex, 0, '-o', 'ControlMaster=no', '-o', 'ControlPath=none');
  const parent = fixedDirectory('root-policy');
  const attemptPath = path.join(parent, 'attempt.json');
  writeExclusive(attemptPath, { schemaVersion: 1, scope: 'fz3b-root-policy-attempt',
    startedAt: new Date().toISOString(), sourceSha256,
    originalConfigSha256: configSha, authorizedSha256: authSha,
    proofHashes, hostTrust: 'pinned-ed25519-continuity',
    outcome: 'pending-or-unknown', automaticRetry: false, automaticRollback: false });
  const captured = await captureOwnedSsh(source, args, { timeoutMs: 110000 });
  const { stdout, stderr, observation, ...transport } = captured;
  writeExclusive(path.join(parent, 'transport.json'), { schemaVersion: 1,
    scope: 'fz3b-root-policy-transport', sourceSha256,
    recordedAt: new Date().toISOString(), stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stderrSha256: sha256(Buffer.from(stderr, 'utf8')), ...transport });
  let report = null;
  let diagnostic = null;
  try {
    if (confirmed(captured) && sha256(regularFile(scriptPath)) === sourceSha256 &&
        regularFile(knownPath).toString('utf8').trim() === knownHostLine)
      report = validateResult(Buffer.from(stdout, 'utf8'));
  } catch { /* Unknown; never retry or roll back automatically. */ }
  if (!report) {
    try { diagnostic = validateDiagnostic(observation); } catch { /* No raw stdout. */ }
    writeExclusive(path.join(parent, 'diagnostic.json'), { schemaVersion: 1,
      scope: 'fz3b-root-policy-local-diagnostic', result: 'unknown',
      diagnostic, automaticRetry: false, automaticRollback: false });
    throw new Error('root-policy-outcome-unknown-inspect-board-do-not-retry');
  }
  writeExclusive(path.join(parent, 'receipt.json'), { ...report,
    sourceSha256, sshCloseConfirmed: captured.sshCloseConfirmed,
    sshExitObserved: captured.sshExitObserved, localSshPid: captured.localSshPid,
    hostTrust: 'pinned-ed25519-continuity',
    passwordLoginStillRequiresIndependentPostcheck: true });
  console.log(JSON.stringify({ receiptPath: path.join(parent, 'receipt.json'),
    result: report.result, passwordLoginStillRequiresIndependentPostcheck: true }));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Root policy stage failed: ${error.message}`); process.exitCode = 1; });
}
