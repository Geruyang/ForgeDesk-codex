import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownHostLine, projectRoot, sshArgs as fixedSshArgs } from './fetch_known_good_pl.mjs';
import { captureOwnedSsh } from './ssh_script_receipt.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const base = path.join(projectRoot, 'output/hardware/2026-10-16-next/ssh-hardening');
const sourcePath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_hardening_root_policy.py');
const helperPath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_script_receipt.mjs');
const sshOptionsPath = path.join(projectRoot, 'engineering/fz3b/tools/fetch_known_good_pl.mjs');
const knownPath = path.join(projectRoot, '.runtime/fz3b-private/known_hosts');
const recoveryKey = path.join(projectRoot, '.runtime/fz3b-private/fz3b_recovery_ed25519');
const forwardAttempt = path.join(base, 'root-policy/attempt.json');
const sourceSha256 = 'c384335524d64fed22b3b5d865b37a4ab4643c7a14ed25d6eb44a4874dc5bd5f';
const helperSha256 = '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515';
const sshOptionsSha256 = '043c5815d6de96662a0310186fceca38543e93287dddd6535fb058d44105ee30';
const configSha256 = 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216';
const authSha256 = 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f';

function regularFile(filename, read = true) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('local-file-not-regular');
  return read ? fs.readFileSync(filename) : null;
}

function fixedDirectory() {
  let current = projectRoot;
  for (const part of ['output', 'hardware', '2026-10-16-next', 'ssh-hardening',
    'root-policy-rollback']) {
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

export function validateForwardAttempt(raw) {
  const value = JSON.parse(raw.toString('utf8'));
  if (value.schemaVersion !== 1 || value.scope !== 'fz3b-root-policy-attempt' ||
      value.sourceSha256 !== sourceSha256 ||
      value.originalConfigSha256 !== configSha256 ||
      value.authorizedSha256 !== authSha256 || value.outcome !== 'pending-or-unknown' ||
      value.automaticRetry !== false || value.automaticRollback !== false)
    throw new Error('forward-attempt-not-matching');
  return value;
}

export function validateRollback(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > 32768) throw new Error('rollback-output-limit');
  const value = JSON.parse(raw.toString('utf8'));
  if (value.schemaVersion !== 1 || value.scope !== 'fz3b-root-policy-rollback' ||
      value.result !== 'original-restored-reloaded' ||
      value.bootId !== '5ceb45a3-8903-4efc-9484-ec75c17280df' ||
      value.restoredConfigSha256 !== configSha256 || value.restoredConfigBytes !== 3248 ||
      value.backupPath !== '/etc/ssh/sshd_config.fz3b-prehardening-20261016' ||
      value.backupSha256 !== configSha256 ||
      !/^[a-f0-9]{64}$/.test(value.priorCandidateSha256) ||
      value.priorCandidateBytes !== 3405 || value.authorizedSha256 !== authSha256 ||
      value.rootContextsChecked !== 2 || value.nonrootContextsUnchanged !== 2 ||
      value.serviceId !== 'ssh.service' ||
      value.serviceFragment !== '/lib/systemd/system/ssh.service' ||
      value.serviceAction !== 'reload' || !Number.isInteger(value.servicePidBefore) ||
      value.servicePidBefore <= 0 || !Number.isInteger(value.servicePidAfter) ||
      value.servicePidAfter <= 0 || value.passwordRotated !== false ||
      value.remoteRootPasswordRouteRestored !== true ||
      value.independentLoginPostchecked !== false)
    throw new Error('rollback-result-invalid');
  return value;
}

export function confirmed(captured) {
  return captured?.sshCloseConfirmed === true && captured?.sshExitObserved === true &&
    captured?.exitCode === 0 && captured?.signal === null && captured?.failure === null &&
    captured?.remoteOutcomeUnknown === false && captured?.killAttempted === false;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== '--confirm-rollback')
    throw new Error('explicit --confirm-rollback required');
  if (regularFile(knownPath).toString('utf8').trim() !== knownHostLine)
    throw new Error('host-continuity-mismatch');
  regularFile(recoveryKey, false);
  if (sha256(regularFile(helperPath)) !== helperSha256) throw new Error('capture-helper-changed');
  if (sha256(regularFile(sshOptionsPath)) !== sshOptionsSha256) throw new Error('ssh-options-source-changed');
  const source = regularFile(sourcePath);
  if (source.length > 32768 || sha256(source) !== sourceSha256)
    throw new Error('source-hash-mismatch');
  validateForwardAttempt(regularFile(forwardAttempt));
  const args = fixedSshArgs(knownPath, recoveryKey);
  const hostIndex = args.indexOf('root@169.254.220.254');
  if (hostIndex < 0 || args[args.length - 1] !== 'python3 -B -')
    throw new Error('fixed-ssh-command-mismatch');
  args.splice(hostIndex, 0, '-o', 'ControlMaster=no', '-o', 'ControlPath=none');
  args[args.length - 1] = 'python3 -B - --rollback';
  const parent = fixedDirectory();
  const attemptPath = path.join(parent, 'attempt.json');
  writeExclusive(attemptPath, { schemaVersion: 1, scope: 'fz3b-root-policy-rollback-attempt',
    startedAt: new Date().toISOString(), sourceSha256, originalConfigSha256: configSha256,
    authorizedSha256: authSha256, authentication: 'independent-recovery-public-key',
    hostTrust: 'pinned-ed25519-continuity', outcome: 'pending-or-unknown',
    automaticRetry: false, automaticRollback: false });
  const captured = await captureOwnedSsh(source, args, { timeoutMs: 110000 });
  const { stdout, stderr, observation, ...transport } = captured;
  writeExclusive(path.join(parent, 'transport.json'), { schemaVersion: 1,
    scope: 'fz3b-root-policy-rollback-transport', sourceSha256,
    recordedAt: new Date().toISOString(), stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stderrSha256: sha256(Buffer.from(stderr, 'utf8')), ...transport });
  let report = null;
  try {
    if (confirmed(captured) && sha256(regularFile(sourcePath)) === sourceSha256 &&
        regularFile(knownPath).toString('utf8').trim() === knownHostLine)
      report = validateRollback(Buffer.from(stdout, 'utf8'));
  } catch { /* Unknown; no automatic retry. */ }
  if (!report) {
    let diagnostic = null;
    if (observation?.scope === 'fz3b-root-policy-diagnostic' &&
        observation?.operation === 'rollback' &&
        observation?.automaticRetry === false && observation?.automaticRollback === false)
      diagnostic = { scope: observation.scope, operation: observation.operation,
        phase: observation.phase, errorCode: observation.errorCode,
        candidateSha256: observation.candidateSha256 };
    writeExclusive(path.join(parent, 'diagnostic.json'), { schemaVersion: 1,
      scope: 'fz3b-root-policy-rollback-local-diagnostic', result: 'unknown',
      diagnostic, automaticRetry: false, automaticRollback: false });
    throw new Error('rollback-outcome-unknown-inspect-board-do-not-retry');
  }
  writeExclusive(path.join(parent, 'receipt.json'), { ...report,
    sourceSha256, sshCloseConfirmed: captured.sshCloseConfirmed,
    sshExitObserved: captured.sshExitObserved, localSshPid: captured.localSshPid,
    hostTrust: 'pinned-ed25519-continuity',
    independentLoginPostcheckRequired: true });
  console.log(JSON.stringify({ receiptPath: path.join(parent, 'receipt.json'),
    result: report.result, remoteRootPasswordRouteRestored: true }));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Rollback stage failed: ${error.message}`); process.exitCode = 1; });
}
