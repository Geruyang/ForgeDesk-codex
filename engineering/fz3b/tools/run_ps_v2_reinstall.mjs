import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { captureOwnedSsh } from './ssh_script_receipt.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTPUT = 'output/qa/2026-10-16-fz3b-051';
const APP = '/root/fz3b-vision-console-20261009-001';
const BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df';
const LEGACY = '9b0bf3212e10fd539872e8976814474edac0df4611655d8b01cafea8202b3a02';
const LIFECYCLE = 'b05172f7ead79cfda5995a70c2d7800f5eb72eae104c0621d904bfeb6467a81b';
const MANIFEST = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09';
const TAR = 'ec405d018a85e8c4c5e463b61d7f4dc565d34924913a9d54a68a3ac4262ebee3';
const TRANSPORT = '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515';
const PRODUCT_GATE = 'c14b4604b4d18377865080d477cb5aa0d357829aca14c85d3be961d283be17aa';
const INSPECTOR_GATE = '9c15a032ff912893824c3bc634551618bc39eab61790d7fb53e2dcc70bcca9d9';
const TARGETS = Object.freeze({
  'vision_app/board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
  'vision_app/camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
  'vision_app/image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
  'vision_app/protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
  'vision_app/upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
  'config.json': 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2',
});
const SIZES = [40992, 4032, 4678, 9358, 2876, 575];
const RUN = /^ps-v2-reinstall-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const keys = (value, expected) => assert.deepEqual(Object.keys(value ?? {}).sort(), [...expected].sort());

function plain(relative, file = true) {
  assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\'));
  const segments = relative.split('/'); assert.ok(segments.every(part => part && part !== '.' && part !== '..'));
  let current = root;
  for (const segment of segments) { current = path.join(current, segment); assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'Links/junctions are forbidden'); }
  const info = fs.lstatSync(current);
  assert.ok(file ? info.isFile() && info.nlink === 1 : info.isDirectory());
  assert.equal(fs.realpathSync.native(current).toLowerCase(), current.toLowerCase());
  return current;
}
const read = (relative, limit) => { const filename = plain(relative); assert.ok(fs.statSync(filename).size <= limit); const raw = fs.readFileSync(filename); assert.ok(raw.length <= limit); return raw; };
function canonicalJson(raw) {
  const value = JSON.parse(raw.toString('utf8'));
  assert.equal(Buffer.from(`${JSON.stringify(stable(value))}\n`).equals(raw), true, 'JSON must be canonical, duplicate-free ASCII JSON');
  return value;
}

export function validatePlan(plan, relative, readFile = read) {
  keys(plan, ['schemaVersion', 'method', 'runId', 'bootId', 'app', 'unit', 'approvedManifestSha256', 'approvedTarSha256',
    'toolSha256', 'legacySha256', 'lifecycleSha256', 'stdinFile', 'stdinSha256', 'requestFile', 'requestSha256',
    'transportSha256', 'productGateSha256', 'inspectorGateSha256', 'expectedSha256', 'requiresSeparateServiceStopStart', 'automaticRollback', 'changesPL', 'executed']);
  assert.equal(plan.schemaVersion, 1); assert.equal(plan.method, 'host-maintenance-ps-v2-reinstall');
  assert.match(plan.runId, RUN); assert.equal(relative, `${OUTPUT}/${plan.runId}/plan.json`);
  assert.equal(plan.bootId, BOOT); assert.equal(plan.app, APP); assert.equal(plan.unit, 'fz3b-vision-console.service');
  assert.equal(plan.approvedManifestSha256, MANIFEST); assert.equal(plan.approvedTarSha256, TAR);
  assert.equal(plan.legacySha256, LEGACY); assert.equal(plan.lifecycleSha256, LIFECYCLE);
  assert.equal(plan.transportSha256, TRANSPORT);
  assert.equal(plan.productGateSha256, PRODUCT_GATE);
  assert.equal(plan.inspectorGateSha256, INSPECTOR_GATE);
  assert.deepEqual(plan.expectedSha256, TARGETS); assert.equal(plan.requiresSeparateServiceStopStart, true);
  assert.equal(plan.automaticRollback, false); assert.equal(plan.changesPL, false); assert.equal(plan.executed, false);
  assert.equal(plan.stdinFile, `${OUTPUT}/${plan.runId}/stdin.py`); assert.equal(plan.requestFile, `${OUTPUT}/${plan.runId}/request.json`);
  for (const [relativeSource, expected] of [
    ['engineering/fz3b/tools/ps_v2_reinstall.py', plan.toolSha256], ['engineering/fz3b/tools/ps_security_transaction.py', LEGACY],
    ['engineering/fz3b/tools/service_lifecycle.py', LIFECYCLE],
    ['engineering/fz3b/tools/ssh_script_receipt.mjs', TRANSPORT],
    ['engineering/fz3b/tools/recovery_051_product_gate.py', PRODUCT_GATE],
    ['output/hardware/2026-10-16-next/recovery/maintenance-check/maintenance_gate.py', INSPECTOR_GATE],
    ['output/hardware/2026-10-16-continuation/deployment-bundle-v2/manifest.json', MANIFEST],
    ['output/hardware/2026-10-16-continuation/deployment-bundle-v2/data.tar', TAR],
  ]) assert.equal(sha(readFile(relativeSource, 256 * 1024)), expected, 'Reviewed source/bundle changed');
  const script = readFile(plan.stdinFile, 1024 * 1024); assert.equal(sha(script), plan.stdinSha256);
  const rawRequest = readFile(plan.requestFile, 2 * 1024 * 1024); assert.equal(sha(rawRequest), plan.requestSha256);
  const request = canonicalJson(rawRequest);
  keys(request, ['schema', 'mode', 'run_id', 'boot_id', 'approved_manifest_sha256', 'expected_sha256', 'payloads']);
  assert.equal(request.schema, 1); assert.equal(request.mode, 'reinstall-v2'); assert.equal(request.run_id, plan.runId);
  assert.equal(request.boot_id, BOOT); assert.equal(request.approved_manifest_sha256, MANIFEST); assert.deepEqual(request.expected_sha256, TARGETS);
  keys(request.payloads, Object.keys(TARGETS).filter(key => key !== 'config.json'));
  for (const [target, encoded] of Object.entries(request.payloads)) {
    assert.ok(typeof encoded === 'string' && encoded.length <= 350000);
    const raw = Buffer.from(encoded, 'base64'); assert.equal(raw.toString('base64'), encoded); assert.equal(sha(raw), TARGETS[target]);
  }
  return script;
}

export function assertReinstallResult(captured, runId) {
  assert.equal(captured.sshCloseConfirmed, true); assert.equal(captured.exitCode, 0); assert.equal(captured.signal, null);
  assert.equal(captured.failure, null); assert.equal(captured.remoteOutcomeUnknown, false);
  assert.equal(captured.sshExitObserved, true); assert.equal(captured.killAttempted, false);
  assert.equal(captured.killReturn, null); assert.equal(captured.killError, null); assert.equal(captured.cleanupDeadlineExceeded, false);
  assert.equal(captured.captureTimeoutMs, 60000); assert.equal(captured.cleanupTimeoutMs, 5000);
  assert.ok(Number.isInteger(captured.localSshPid) && captured.localSshPid > 0);
  const result = captured.observation;
  assert.equal(result?.status, 'reinstalled-v2'); assert.equal(result?.mode, 'reinstall-v2'); assert.equal(result.run_id, runId);
  assert.equal(result.attemptedTargetCount, 6); assert.equal(result.replacedTargetCount, 6);
  assert.equal(result.persistent_lock_retained, false); assert.equal(result.persistent_lock_uncertain, false);
  for (const flag of ['service_lifecycle_changed', 'hardware_accessed', 'application_started', 'automatic_rollback', 'new_pl_built']) assert.equal(result[flag], false);
  assert.equal(result.entries?.length, 6); assert.equal(result.manifest?.entries?.length, 6);
  keys(result.manifest, ['schema', 'method', 'run_id', 'boot_id', 'app', 'unit', 'approved_manifest_sha256', 'legacy_source_sha256', 'lifecycle_source_sha256', 'product_gate_source_sha256', 'inspector_gate_source_sha256', 'entries']);
  assert.equal(result.manifest.schema, 2); assert.equal(result.manifest.method, 'exact-ps-v2-reinstall');
  assert.equal(result.manifest.boot_id, BOOT); assert.equal(result.manifest.app, APP); assert.equal(result.manifest.unit, 'fz3b-vision-console.service');
  assert.equal(result.manifest.legacy_source_sha256, LEGACY); assert.equal(result.manifest.lifecycle_source_sha256, LIFECYCLE);
  assert.equal(result.manifest.product_gate_source_sha256, PRODUCT_GATE); assert.equal(result.productGateSha256, PRODUCT_GATE);
  assert.equal(result.manifest.inspector_gate_source_sha256, INSPECTOR_GATE); assert.equal(result.inspectorGateSha256, INSPECTOR_GATE);
  assert.equal(result.productLockFileModified, false); assert.equal(result.productLeaseClosed, true);
  assert.equal(result.productGateChecks?.length, 9);
  for (const proof of result.productGateChecks) {
    assert.equal(proof?.productLeaseHeldReadOnly, true); assert.equal(proof.unknownCleared, false);
    assert.equal(proof.fixedOperationId, 'af51470d-b545-4fde-ae78-69bf13a61fd7');
    assert.equal(proof.profileSha256, '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd');
    assert.ok(Number.isSafeInteger(proof.journalCount) && proof.journalCount > 0 && proof.journalCount <= 64);
    assert.equal(Object.keys(proof.journalHashes ?? {}).length, proof.journalCount);
    assert.ok(Object.values(proof.journalHashes).every(value => /^[a-f0-9]{64}$/.test(value)));
  }
  assert.equal(result.backup_directory, `${APP}/.forgedesk-ps-v2-reinstall-backups/${runId}`);
  assert.equal(result.checks?.length, 9);
  for (const check of result.checks) {
    assert.equal(check.boot_id, BOOT); assert.equal(check.unit_sha256, '1089e63bb0138e9c0f0c45f22ad8f95a74bcc92fca998fa541f37836844d599b');
    assert.equal(check.service?.activeState, 'inactive'); assert.equal(check.service?.subState, 'dead'); assert.equal(check.service?.mainPid, 0);
    keys(check.dependencies, ['fz3b-pl-loader.service', 'fz3b-app-r5.service', 'fz3b-app-cpu-clock.service']);
    assert.ok(Object.values(check.dependencies).every(value => value.activeState === 'active'));
    for (const field of ['boot_id', 'unit_sha256', 'service', 'dependencies']) assert.deepEqual(check[field], result.checks[0][field]);
    assert.equal(check.scan?.deviceOpened, false);
    for (const field of ['a0005Owners', 'active8765', 'listeners8765']) assert.deepEqual(check.scan[field], []);
    const audit = check.processAudit;
    assert.equal(audit?.completePass, true); assert.deepEqual(audit.stdinInspectors, []); assert.deepEqual(audit.newPidsAtEnd, []);
    assert.ok(Number.isSafeInteger(audit.selfExcluded?.pid) && audit.selfExcluded.pid > 0);
    assert.ok(Number.isSafeInteger(audit.selfExcluded?.startTicks) && audit.selfExcluded.startTicks >= 0);
    assert.deepEqual(audit.selfExcluded, result.checks[0].processAudit.selfExcluded);
    for (const field of ['rawArgvEmitted', 'stdinRead', 'environmentRead', 'remainingArgumentsRead']) assert.equal(audit[field], false);
  }
  assert.equal(sha(Buffer.from(`${JSON.stringify(stable(result.manifest))}\n`)), result.manifest_sha256);
  assert.equal(result.manifest.approved_manifest_sha256, MANIFEST); assert.equal(result.manifest.run_id, runId);
  for (const [index, target] of Object.keys(TARGETS).entries()) {
    const entry = result.entries[index]; const original = result.manifest.entries[index];
    assert.equal(entry.path, target); assert.equal(entry.sha256, TARGETS[target]);
    assert.equal(original.path, target); assert.equal(original.backup, `${index}.original`);
    assert.equal(original.old_sha256, TARGETS[target]); assert.equal(original.new_sha256, TARGETS[target]);
    assert.deepEqual(entry.before, original.before);
    for (const identity of [entry.before, entry.after]) {
      for (const field of ['dev', 'ino', 'bytes', 'mode', 'uid', 'gid', 'nlink']) assert.ok(Number.isSafeInteger(identity?.[field]) && identity[field] >= 0);
      assert.equal(identity.uid, 0); assert.equal(identity.gid, 0); assert.equal(identity.nlink, 1);
      assert.equal(identity.mode, target === 'config.json' ? 0o600 : 0o644);
      assert.equal(identity.bytes, SIZES[index]);
      for (const field of ['mtime_ns', 'ctime_ns']) assert.match(identity[field], /^\d{1,30}$/);
    }
    assert.ok(entry.after.dev !== entry.before.dev || entry.after.ino !== entry.before.ino, 'Equal content is not proof of a fresh replacement');
  }
}

async function requireNoForgeDesk() {
  const execute = promisify(execFile);
  const { stdout } = await execute('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';@(Get-CimInstance Win32_Process -Filter \"Name='ForgeDesk.exe'\").Count"],
    { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 });
  assert.equal(stdout.trim(), '0', 'All ForgeDesk instances must be normally closed before host maintenance');
}

export async function executeOne(plan, script, { capture = captureOwnedSsh, hostIdle = requireNoForgeDesk, storage } = {}) {
  assert.equal(plan?.method, 'host-maintenance-ps-v2-reinstall'); assert.match(plan.runId, RUN);
  assert.ok(Buffer.isBuffer(script) && script.length > 0 && script.length <= 1024 * 1024); assert.equal(sha(script), plan.stdinSha256);
  assert.ok(storage, 'An exclusive durable host ledger is required');
  await hostIdle(); storage.acquire();
  const record = { schemaVersion: 1, method: 'host-maintenance-ps-v2-reinstall', runId: plan.runId, startedAt: new Date().toISOString(),
    scope: 'Explicit host-only same-byte six-file PS v2 reinstall; not an installed model tool, PL build, or new deployment claim', result: 'running',
    serviceActionsIssued: false, automaticRollback: false, calls: 0 };
  try {
    storage.save(record);
    await hostIdle();
    const privateRoot = path.join(root, '.runtime/fz3b-private');
    const args = ['-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${path.join(privateRoot, 'known_hosts')}`,
      '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no', '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
      '-i', path.join(privateRoot, 'fz3b_acceptance_ed25519'), 'root@169.254.220.254', 'python3 -B -'];
    record.calls++;
    const { stdout, stderr, ...captured } = await capture(script, args, { timeoutMs: 60000 });
    assert.ok(typeof stdout === 'string' && Buffer.byteLength(stdout) <= 1024 * 1024);
    assert.ok(typeof stderr === 'string' && Buffer.byteLength(stderr) <= 32768);
    storage.writeStreams(stdout, stderr);
    record.receipt = { ...captured, stdoutSha256: sha(stdout), stderrSha256: sha(stderr), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) };
    storage.save(record); assertReinstallResult(captured, plan.runId);
    record.result = 'passed-host-ps-v2-reinstall'; record.endedAt = new Date().toISOString(); storage.save(record);
    storage.release(); return record;
  } catch (error) {
    record.result = 'unknown-held-for-root-review'; record.error = String(error?.message ?? error).slice(0, 1000); record.endedAt = new Date().toISOString();
    try { storage.save(record); } catch { record.evidenceWriteUnconfirmed = true; }
    return record;
  }
}

export function writeFully(fd, raw, io = fs) {
  let offset = 0;
  while (offset < raw.length) {
    const written = io.writeSync(fd, raw, offset, raw.length - offset, offset);
    assert.ok(Number.isInteger(written) && written > 0 && written <= raw.length - offset, 'Host evidence write made no valid progress');
    offset += written;
  }
}

export function createHostStorage(lock, destination, seal, io = fs) {
  let lockFd; let ledgerFd; let writeFailed = false;
  function closeOwned() {
    let failure;
    for (const name of ['ledger', 'lock']) {
      const fd = name === 'ledger' ? ledgerFd : lockFd;
      if (fd === undefined) continue;
      try {
        io.closeSync(fd);
        if (name === 'ledger') ledgerFd = undefined; else lockFd = undefined;
      } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  return {
    acquire() {
      assert.equal(lockFd, undefined); assert.equal(ledgerFd, undefined);
      try {
        lockFd = io.openSync(lock, 'wx', 0o600);
        writeFully(lockFd, seal, io); io.fsyncSync(lockFd);
        ledgerFd = io.openSync(destination, 'wx', 0o600);
      } catch (error) {
        writeFailed = true;
        // An uncertain durable lease is never removed, even when initialization fails.
        try { closeOwned(); } catch { /* The original failure remains authoritative. */ }
        throw error;
      }
    },
    save(value) {
      assert.equal(writeFailed, false, 'Prior host evidence write is uncertain');
      assert.notEqual(ledgerFd, undefined);
      try {
        const raw = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
        writeFully(ledgerFd, raw, io); io.ftruncateSync(ledgerFd, raw.length); io.fsyncSync(ledgerFd);
      } catch (error) { writeFailed = true; throw error; }
    },
    writeStreams(stdout, stderr) {
      assert.equal(writeFailed, false);
      try {
        for (const [name, content] of [['stdout.json', stdout], ['stderr.log', stderr]]) {
          const fd = io.openSync(path.join(path.dirname(destination), name), 'wx', 0o600);
          try { writeFully(fd, Buffer.from(content), io); io.fsyncSync(fd); } finally { io.closeSync(fd); }
        }
      } catch (error) { writeFailed = true; throw error; }
    },
    release() {
      assert.equal(writeFailed, false, 'Uncertain host evidence cannot release the lease');
      const named = io.lstatSync(lock); const held = io.fstatSync(lockFd);
      assert.equal(named.isSymbolicLink(), false); assert.equal(named.dev, held.dev); assert.equal(named.ino, held.ino);
      assert.equal(io.readFileSync(lock).equals(seal), true); io.unlinkSync(lock);
    },
    close: closeOwned,
  };
}

export async function main(argv) {
  assert.ok(argv.length === 2 || argv.length === 4); assert.equal(argv[0], '--plan');
  const rawPlan = read(argv[1], 65536); const plan = canonicalJson(rawPlan); const script = validatePlan(plan, argv[1]);
  if (argv.length === 2) return { result: 'reviewed-offline-not-executed', planSha256: sha(rawPlan), runId: plan.runId };
  assert.equal(argv[2], '--execute-reviewed'); assert.equal(argv[3], sha(rawPlan), 'Explicit reviewed plan SHA is required');
  const known = read('.runtime/fz3b-private/known_hosts', 4096).toString('utf8').trim();
  assert.equal(known, '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ');
  plain('.runtime/fz3b-private/fz3b_acceptance_ed25519'); // Metadata only. Never read or copy key bytes.
  const lock = path.join(plain('.runtime/fz3b-private', false), 'active-hardware-acceptance.lock');
  const destination = path.join(plain(`${OUTPUT}/${plan.runId}`, false), 'execution.json');
  const seal = Buffer.from(JSON.stringify({ schemaVersion: 1, runId: plan.runId, planSha256: sha(rawPlan), method: 'ps-v2-reinstall' }));
  const storage = createHostStorage(lock, destination, seal);
  let result;
  try { result = await executeOne(plan, script, { storage }); } finally { storage.close(); }
  return { result: result.result, runId: plan.runId, evidence: path.relative(root, destination), calls: result.calls };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(process.argv.slice(2)); console.log(JSON.stringify(result)); if (result.result === 'unknown-held-for-root-review') process.exitCode = 1; }
  catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 1; }
}
