import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const sourcePath = path.join(projectRoot, 'engineering/fz3b/tools/recovery_client_probe.py');
export const helperPath = path.join(projectRoot, 'engineering/fz3b/tools/ssh_script_receipt.mjs');
export const outputRoot = path.join(projectRoot, 'output/hardware/2026-10-16-next/recovery');
export const sourceSha256 = '7d9e615ec35304c6d7cfc8ea90117c207d343ddc997ee81d1cda4d1e90985639';
export const helperSha256 = '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515';
export const knownHostLine = '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ';
export const scenarios = Object.freeze(['disconnect', 'rejection', 'checkpoint']);
const privateRoot = path.join(projectRoot, '.runtime/fz3b-private');
const known = path.join(privateRoot, 'known_hosts');
const key = path.join(privateRoot, 'fz3b_acceptance_ed25519');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseArgs(argv) {
  if (!Array.isArray(argv) || ![2, 3].includes(argv.length) || argv[0] !== '--scenario' ||
      !scenarios.includes(argv[1]) || (argv.length === 3 && argv[2] !== '--execute-reviewed')) {
    throw new Error('Only --scenario disconnect|rejection|checkpoint [--execute-reviewed] is accepted');
  }
  return Object.freeze({ scenario: argv[1], execute: argv.length === 3 });
}

export function sshArgs(scenario) {
  if (!scenarios.includes(scenario)) throw new Error('Scenario not fixed');
  return ['-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '-i', key, 'root@169.254.220.254',
    `python3 -B - --scenario ${scenario}`];
}

function realPath(filename) {
  const absolute = path.resolve(filename);
  if (absolute !== projectRoot && !absolute.startsWith(projectRoot + path.sep)) throw new Error('Outside project');
  for (let current = absolute; ; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || fs.realpathSync(current) !== current) throw new Error('Linked path forbidden');
    if (current === projectRoot) break;
  }
  return fs.lstatSync(absolute);
}

function fixedRead(filename, max) {
  const before = realPath(filename);
  if (!before.isFile() || before.nlink !== 1 || before.size > max) throw new Error('Unsafe fixed file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const size = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (size === 0) break;
      count += size;
    }
    const identity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
    if (count !== before.size || identity(before) !== identity(opened) ||
        identity(opened) !== identity(fs.fstatSync(fd)) || identity(opened) !== identity(realPath(filename))) {
      throw new Error('Fixed file changed');
    }
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}

function writeExclusive(directory, name, bytes) {
  const fd = fs.openSync(path.join(directory, name), 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function createDirectory(scenario) {
  // Create/check each fixed component individually; never traverse an existing link.
  let current = projectRoot;
  for (const component of path.relative(projectRoot, outputRoot).split(path.sep)) {
    current = path.join(current, component);
    try { fs.mkdirSync(current); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!realPath(current).isDirectory()) throw new Error('Output component is not a real directory');
  }
  const name = `${scenario}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}`;
  const directory = path.join(outputRoot, name);
  fs.mkdirSync(directory); // No recursive reuse, overwrite or cleanup of old evidence.
  realPath(directory);
  return directory;
}

export function evaluateCapture(captured, identity, scenario) {
  if (!scenarios.includes(scenario)) throw new Error('Scenario not fixed');
  const value = captured?.observation;
  const count = scenario === 'checkpoint' ? 1 : 2;
  const transportConfirmed = captured?.sshCloseConfirmed === true && captured?.sshExitObserved === true &&
    captured.exitCode === 0 && captured.signal === null && captured.failure === null &&
    captured.remoteOutcomeUnknown === false && captured.killAttempted === false;
  const sourceConfirmed = identity?.sourceUnchanged === true && identity?.helperUnchanged === true &&
    identity?.knownHostUnchanged === true && identity?.keyMetadataUnchanged === true;
  const applicationConfirmed = value?.schema === 'fz3b-idle-client-recovery-v1' && value.scenario === scenario &&
    value.result === 'passed' && value.stage === 'complete' && value.endpoint === '127.0.0.1:8765' &&
    value.connections_attempted === count && value.normal_closes_confirmed === count &&
    value.compute_requested === false && value.service_actions === false && value.device_opened === false &&
    value.files_written === false && value.application_imported === false && value.retries === 0 &&
    value.replay_attempted === false && value.network_fault_injected === false && value.human_review_required === false;
  const passed = transportConfirmed && sourceConfirmed && applicationConfirmed;
  return { result: passed ? 'passed' : 'unknown', humanReviewRequired: !passed,
    transportConfirmed, sourceConfirmed, applicationConfirmed,
    historicalUnknownResolved: false, realNetworkFaultQualified: false };
}

export async function main(argv = process.argv.slice(2)) {
  const { scenario, execute } = parseArgs(argv);
  const source = fixedRead(sourcePath, 65536);
  if (sha(source) !== sourceSha256) throw new Error('Reviewed recovery source changed');
  if (sha(fixedRead(helperPath, 65536)) !== helperSha256) throw new Error('Reviewed SSH helper changed');
  const directory = createDirectory(scenario);
  const plan = { schema: 'fz3b-idle-client-recovery-host-v1', scenario, sourceSha256, helperSha256,
    source: path.relative(projectRoot, sourcePath), executeRequested: execute, defaultIsPrepareOnly: true,
    captureTimeoutMs: 60000, automaticRetry: false, historicalUnknownResolved: false,
    knownHostPin: knownHostLine, authentication: 'project-public-key', hostTrust: 'TOFU-continuity',
    outputDirectory: directory, scope: 'idle client recovery; no service/compute/new-bit operation' };
  writeExclusive(directory, 'reviewed-stdin.py', source);
  writeExclusive(directory, 'plan.json', JSON.stringify(plan, null, 2) + '\n');
  if (!execute) {
    console.log(JSON.stringify({ directory, result: 'prepared-not-executed', sshAttempted: false }));
    return { directory, result: 'prepared-not-executed', sshAttempted: false };
  }
  // No key body is read or emitted. Root alone invokes this explicit execution mode.
  let keyInfo, captureOwnedSsh;
  try {
    if (fixedRead(known, 4096).toString('utf8').trim() !== knownHostLine) throw new Error('Host continuity mismatch');
    keyInfo = realPath(key);
    if (!keyInfo.isFile() || keyInfo.nlink !== 1 || keyInfo.size < 1 || keyInfo.size > 65536) throw new Error('Unsafe project key metadata');
    ({ captureOwnedSsh } = await import('./ssh_script_receipt.mjs'));
  } catch (error) {
    const refused = { ...plan, result: 'blocked', sshAttempted: false, humanReviewRequired: true,
      error: String(error?.message ?? error).slice(0, 500) };
    writeExclusive(directory, 'evidence.json', JSON.stringify(refused, null, 2) + '\n');
    console.log(JSON.stringify({ directory, result: 'blocked', sshAttempted: false }));
    process.exitCode = 1;
    return refused;
  }
  const keyIdentity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
  const started = new Date().toISOString();
  // One invocation only. Exceptions/unknown capture never select another scenario.
  let captured;
  try { captured = await captureOwnedSsh(source, sshArgs(scenario), { timeoutMs: 60000 }); }
  catch (error) {
    const unknown = { ...plan, started, ended: new Date().toISOString(), result: 'unknown',
      sshAttempted: true, sshCloseConfirmed: false, remoteOutcomeUnknown: true, humanReviewRequired: true,
      error: String(error?.message ?? error).slice(0, 500) };
    writeExclusive(directory, 'evidence.json', JSON.stringify(unknown, null, 2) + '\n');
    console.log(JSON.stringify({ directory, result: 'unknown', remoteOutcomeUnknown: true }));
    process.exitCode = 1;
    return unknown;
  }
  const identity = { sourceUnchanged: false, helperUnchanged: false, knownHostUnchanged: false, keyMetadataUnchanged: false };
  try {
    identity.sourceUnchanged = sha(fixedRead(sourcePath, 65536)) === sourceSha256;
    identity.helperUnchanged = sha(fixedRead(helperPath, 65536)) === helperSha256;
    identity.knownHostUnchanged = fixedRead(known, 4096).toString('utf8').trim() === knownHostLine;
    identity.keyMetadataUnchanged = keyIdentity(realPath(key)) === keyIdentity(keyInfo);
  } catch { /* Preserve the capture; missing identity confirmation remains unknown. */ }
  const evaluated = evaluateCapture(captured, identity, scenario);
  const { stdout, stderr, ...facts } = captured;
  const receipt = { ...plan, started, ended: new Date().toISOString(), sshAttempted: true,
    ...facts, ...identity, ...evaluated,
    remoteOutcomeUnknown: facts.remoteOutcomeUnknown || evaluated.result !== 'passed' };
  writeExclusive(directory, 'stdout.json', stdout);
  writeExclusive(directory, 'stderr.log', stderr);
  writeExclusive(directory, 'evidence.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ directory, result: receipt.result, remoteOutcomeUnknown: receipt.remoteOutcomeUnknown,
    sshCloseConfirmed: receipt.sshCloseConfirmed, humanReviewRequired: receipt.humanReviewRequired }));
  if (receipt.result !== 'passed') process.exitCode = 1;
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Recovery probe refused: ${error.message}`); process.exitCode = 1; });
}
