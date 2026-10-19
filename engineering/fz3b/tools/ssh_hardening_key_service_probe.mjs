import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownHostLine, projectRoot, sshArgs as fixedSshArgs } from './fetch_known_good_pl.mjs';
import { captureOwnedSsh } from './ssh_script_receipt.mjs';

const sourcePath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_hardening_key_service_probe.py');
const helperPath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_script_receipt.mjs');
export const sourceSha256 = '88f2e5f5b68390ddec340fd25a13f2ccb065a1861cc3ba539d293156e5389a5e';
const helperSha256 = '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515';
const authorizedSha256 = 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f';
const bootId = '5ceb45a3-8903-4efc-9484-ec75c17280df';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const keys = Object.freeze({ project: 'fz3b_acceptance_ed25519', recovery: 'fz3b_recovery_ed25519' });
const publicPins = Object.freeze({
  project: { fileSha256: 'f280c358961a097c399cbc179af7e2255c80a0765c7af8eeaad478f579596b0d',
    blobSha256: '08afbf42081b285b9ebbdfda5df75480e39279e38cd71614abe8580908c15381',
    fingerprint: 'SHA256:CK+/QggbKFueu9/aXfdUgOOSeeOM1xYUq+hYCQjBU4E' },
  recovery: { fileSha256: '158b56439ebdd62e85d2cc84bdf91ffe76f9189de46b0fbc7dc5a1072e84a27e',
    blobSha256: '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80',
    fingerprint: 'SHA256:WZsmwRMiJ+JmafeC7UR7Zfn+fo71YSE4t4ZVzj61TIA' },
});

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--key' ||
      !Object.hasOwn(keys, argv[1])) throw new Error('only --key project|recovery accepted');
  return argv[1];
}

function regularFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('local-file-not-regular');
  return info;
}

function evidenceParent() {
  let current = projectRoot;
  for (const part of ['output', 'hardware', '2026-10-16-next', 'ssh-hardening', 'key-login']) {
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

export function sshArgs(known, key) {
  const args = fixedSshArgs(known, key);
  const hostIndex = args.indexOf('root@169.254.220.254');
  if (hostIndex < 0) throw new Error('fixed-host-missing');
  args.splice(hostIndex, 0, '-o', 'ControlMaster=no', '-o', 'ControlPath=none');
  args.splice(hostIndex + 4, 0, '-v');
  return args;
}

export function parsePublicKey(raw, selected) {
  if (!Buffer.isBuffer(raw) || raw.length > 512) throw new Error('public-key-file-invalid');
  const fields = raw.toString('ascii').trim().split(/\s+/);
  if (fields.length !== 3 || fields[0] !== 'ssh-ed25519' ||
      sha256(raw) !== publicPins[selected].fileSha256)
    throw new Error('public-key-file-invalid');
  const blob = Buffer.from(fields[1], 'base64');
  const canonical = blob.toString('base64').replace(/=+$/, '');
  if (fields[1].replace(/=+$/, '') !== canonical ||
      sha256(blob) !== publicPins[selected].blobSha256 ||
      `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` !==
        publicPins[selected].fingerprint)
    throw new Error('public-key-blob-mismatch');
  return publicPins[selected];
}

export function acceptedFingerprint(stderr, selected) {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr, 'utf8') > 32768)
    throw new Error('ssh-debug-limit');
  const accepted = stderr.split(/\r?\n/).filter(line => line.startsWith('debug1: Server accepts key:'));
  const match = accepted.length === 1 &&
    /^debug1: Server accepts key: .* ED25519 (SHA256:[A-Za-z0-9+/]{43}) explicit$/.exec(accepted[0]);
  if (!match || match[1] !== publicPins[selected].fingerprint)
    throw new Error('accepted-key-fingerprint-mismatch');
  return match[1];
}

export function validateProbe(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > 32 * 1024) throw new Error('probe-output-limit');
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('invalid-probe-json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== 1 || value.scope !== 'fz3b-key-login-service-readonly' ||
      value.readOnly !== true || value.serviceActions !== false || value.filesWritten !== false ||
      value.user !== 'root' || value.uid !== 0 || value.bootId !== bootId ||
      value.connectionSource !== '169.254.142.174' ||
      value.connectionDestination !== '169.254.220.254' ||
      value.authorizedSha256 !== authorizedSha256 || value.authorizedBytes !== 221 ||
      value.backupSha256 !== '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b' ||
      value.projectPublicKeyCount !== 1 || value.recoveryPublicKeyCount !== 1 ||
      value.passwordOrShadowRead !== false || value.privateKeyRead !== false ||
      !value.services || typeof value.services !== 'object' ||
      !value.services['ssh.service'] || !value.services['sshd.service'])
    throw new Error('invalid-probe-envelope');
  for (const service of Object.values(value.services)) {
    if (!service || !Number.isInteger(service.exitCode) ||
        typeof service.stderrSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(service.stderrSha256))
      throw new Error('invalid-service-properties');
    if (service.available === false && service.exitCode !== 0) continue;
    if (service.available !== true || service.exitCode !== 0 ||
        typeof service.Id !== 'string' || typeof service.Names !== 'string' ||
        typeof service.FragmentPath !== 'string' ||
        !Number.isInteger(service.ExecReloadCount) || service.ExecReloadCount < 1 ||
        service.ExecReloadCount > 8 || !Array.isArray(service.ExecReloadEntries) ||
        !Array.isArray(service.ExecReloadEntrySha256) ||
        service.ExecReloadEntries.length !== service.ExecReloadCount ||
        service.ExecReloadEntrySha256.length !== service.ExecReloadCount ||
        !service.ExecReloadEntrySha256.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
        !service.ExecReloadEntries.every(value => value === null ||
          typeof value === 'string' && value.length <= 1024) ||
        !Number.isInteger(service.MainPID) || service.MainPID < 0 ||
        typeof service.ActiveState !== 'string' || typeof service.LoadState !== 'string')
      throw new Error('invalid-service-properties');
  }
  if (!Object.values(value.services).some(service => service.available === true &&
      service.ActiveState === 'active' && service.LoadState === 'loaded' && service.MainPID > 0))
    throw new Error('no-active-ssh-service');
  return value;
}

export function validateDiagnostic(value) {
  const errorTypes = ['ValueError', 'OSError', 'FileNotFoundError', 'PermissionError',
    'UnicodeDecodeError', 'TimeoutExpired', 'TypeError', 'AttributeError'];
  const propertyFields = ['propertyKey', 'propertyLine', 'valueLength', 'duplicateCount'];
  const hasPropertyFields = propertyFields.some(field => Object.hasOwn(value ?? {}, field));
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.schemaVersion !== 1 || value.scope !== 'fz3b-key-service-diagnostic' ||
      value.result !== 'failed' || !errorTypes.includes(value.errorType) ||
      typeof value.errorCode !== 'string' || !/^[a-z0-9-]{1,80}$/.test(value.errorCode) ||
      typeof value.function !== 'string' || !/^[a-z_]{1,32}$/.test(value.function) ||
      !(value.line === null || Number.isInteger(value.line) && value.line >= 1 && value.line <= 400) ||
      !(value.errno === null || Number.isInteger(value.errno) && value.errno >= 0 && value.errno < 1000) ||
      value.readOnly !== true || value.serviceActions !== false || value.filesWritten !== false ||
      (hasPropertyFields && (!propertyFields.every(field => Object.hasOwn(value, field)) ||
        !['Id', 'Names', 'FragmentPath', 'ExecReload', 'MainPID', 'ActiveState', 'LoadState',
          'unknown'].includes(value.propertyKey) ||
        !Number.isInteger(value.propertyLine) || value.propertyLine < 1 || value.propertyLine > 24 ||
        !Number.isInteger(value.valueLength) || value.valueLength < 0 || value.valueLength > 8192 ||
        !Number.isInteger(value.duplicateCount) || value.duplicateCount < 0 ||
        value.duplicateCount > 8)))
    throw new Error('invalid-controlled-diagnostic');
  return value;
}

export function extractPythonStderr(stderr) {
  if (typeof stderr !== 'string' || Buffer.byteLength(stderr, 'utf8') > 32768) return null;
  const lines = [...stderr.matchAll(/File "<stdin>", line ([0-9]{1,3})/g)];
  const types = [...stderr.matchAll(/^(SyntaxError|IndentationError|NameError|ImportError|AttributeError|TypeError|ValueError|OSError|FileNotFoundError):/gm)];
  if (!lines.length || !types.length) return null;
  const line = Number(lines[lines.length - 1][1]);
  if (!Number.isInteger(line) || line < 1 || line > 400) return null;
  return { scope: 'fz3b-key-service-stderr-diagnostic',
    errorType: types[types.length - 1][1], line, contentOmitted: true };
}

export function captureConfirmed(captured) {
  return captured && captured.sshCloseConfirmed === true && captured.sshExitObserved === true &&
    captured.exitCode === 0 && captured.signal === null && captured.failure === null &&
    captured.remoteOutcomeUnknown === false && captured.killAttempted === false;
}

export async function main(argv = process.argv.slice(2)) {
  const selected = parseArgs(argv);
  const privateRoot = path.join(projectRoot, '.runtime/fz3b-private');
  const known = path.join(privateRoot, 'known_hosts');
  const key = path.join(privateRoot, keys[selected]);
  const publicKey = path.join(privateRoot, keys[selected] + '.pub');
  for (const file of [known, key, publicKey, sourcePath, helperPath]) regularFile(file);
  if (fs.readFileSync(known, 'utf8').trim() !== knownHostLine)
    throw new Error('host-continuity-mismatch');
  if (sha256(fs.readFileSync(helperPath)) !== helperSha256)
    throw new Error('capture-helper-changed');
  const source = fs.readFileSync(sourcePath);
  if (source.length > 16384 || sha256(source) !== sourceSha256)
    throw new Error('source-hash-mismatch');
  const publicProof = parsePublicKey(fs.readFileSync(publicKey), selected);
  const parent = evidenceParent();
  const directory = path.join(parent, `${selected}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(directory);
  const captured = await captureOwnedSsh(source, sshArgs(known, key), { timeoutMs: 30000 });
  const { stdout, stderr, observation, ...transport } = captured;
  let report = null;
  let diagnostic = null;
  let sourceUnchanged = false;
  let fingerprint = null;
  let keyProofError = null;
  try {
    sourceUnchanged = sha256(fs.readFileSync(sourcePath)) === sourceSha256 &&
      sha256(fs.readFileSync(helperPath)) === helperSha256 &&
      fs.readFileSync(known, 'utf8').trim() === knownHostLine &&
      sha256(fs.readFileSync(publicKey)) === publicProof.fileSha256;
    if (captureConfirmed(captured) && sourceUnchanged) {
      try { fingerprint = acceptedFingerprint(stderr, selected); }
      catch (error) { keyProofError = error.message; }
      if (!fingerprint) throw new Error('accepted-key-not-proven');
      report = validateProbe(Buffer.from(stdout, 'utf8'));
    }
  } catch { /* Invalid or changed evidence remains an explicit unknown result. */ }
  if (!report) {
    try { diagnostic = validateDiagnostic(observation); }
    catch { /* Do not expose arbitrary remote stdout. */ }
  }
  const result = report ? 'key-login-collected' : 'unknown';
  const receipt = { schemaVersion: 1, scope: 'fz3b-key-login-service-receipt',
    selectedKey: selected, result, collectedAt: new Date().toISOString(),
    sourceSha256, helperSha256, hostTrust: 'pinned-ed25519-continuity',
    authentication: 'single-specified-public-key', sourceUnchanged,
    sshAttempted: true, stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stderrSha256: sha256(Buffer.from(stderr, 'utf8')),
    acceptedPublicKeyFingerprint: report ? fingerprint : null,
    acceptedPublicKeyBlobSha256: report ? publicProof.blobSha256 : null,
    publicKeyFileSha256: publicProof.fileSha256,
    cryptographicKeyProof: report !== null,
    keyProofError: report ? null : keyProofError,
    ...transport, report, diagnostic,
    stderrDiagnostic: diagnostic ? null : extractPythonStderr(stderr) };
  writeExclusive(path.join(directory, 'receipt.json'), receipt);
  console.log(JSON.stringify({ directory, selectedKey: selected, result,
    diagnosticCode: diagnostic?.errorCode ?? null,
    sshCloseConfirmed: captured.sshCloseConfirmed, localSshPid: captured.localSshPid }));
  if (!report) process.exitCode = 1;
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Key/service probe failed: ${error.message}`); process.exitCode = 1; });
}
