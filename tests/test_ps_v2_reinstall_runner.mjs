import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { root, validatePlan, assertReinstallResult, executeOne, writeFully, createHostStorage } from '../engineering/fz3b/tools/run_ps_v2_reinstall.mjs';

const runId = 'ps-v2-reinstall-01234567-89ab-4cde-8fab-0123456789ab';
const directory = `output/qa/2026-10-16-fz3b-051/${runId}`;
const boot = '5ceb45a3-8903-4efc-9484-ec75c17280df';
const app = '/root/fz3b-vision-console-20261009-001';
const sizes = [40992, 4032, 4678, 9358, 2876, 575];
const pins = {
  'vision_app/board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
  'vision_app/camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
  'vision_app/image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
  'vision_app/protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
  'vision_app/upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
  'config.json': 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2',
};
const sha = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const json = value => Buffer.from(`${JSON.stringify(stable(value))}\n`);

function fixture() {
  const sources = ['engineering/fz3b/tools/ps_v2_reinstall.py', 'engineering/fz3b/tools/ps_security_transaction.py',
    'engineering/fz3b/tools/service_lifecycle.py', 'engineering/fz3b/tools/ssh_script_receipt.mjs',
    'output/hardware/2026-10-16-continuation/deployment-bundle-v2/manifest.json',
    'output/hardware/2026-10-16-continuation/deployment-bundle-v2/data.tar', 'engineering/fz3b/tools/recovery_051_product_gate.py',
    'output/hardware/2026-10-16-next/recovery/maintenance-check/maintenance_gate.py'];
  const files = new Map(sources.map(name => [name, fs.readFileSync(path.join(root, name))]));
  const request = { schema: 1, mode: 'reinstall-v2', run_id: runId, boot_id: boot,
    approved_manifest_sha256: sha(files.get(sources[4])), expected_sha256: pins, payloads: {} };
  for (const key of Object.keys(pins).filter(key => key !== 'config.json')) {
    request.payloads[key] = fs.readFileSync(path.join(root, 'output/hardware/2026-10-16-continuation/release-source-v2/PS', key)).toString('base64');
  }
  // This fake stdin is never executed. Real generation/byte binding is tested in Python separately.
  const script = Buffer.from('# fixture transport bytes, no process launched\n');
  files.set(`${directory}/request.json`, json(request)); files.set(`${directory}/stdin.py`, script);
  const plan = { schemaVersion: 1, method: 'host-maintenance-ps-v2-reinstall', runId, bootId: boot, app,
    unit: 'fz3b-vision-console.service', approvedManifestSha256: sha(files.get(sources[4])), approvedTarSha256: sha(files.get(sources[5])),
    toolSha256: sha(files.get(sources[0])), legacySha256: sha(files.get(sources[1])), lifecycleSha256: sha(files.get(sources[2])),
    transportSha256: sha(files.get(sources[3])), stdinFile: `${directory}/stdin.py`, stdinSha256: sha(script),
    productGateSha256: sha(files.get(sources[6])),
    inspectorGateSha256: sha(files.get(sources[7])),
    requestFile: `${directory}/request.json`, requestSha256: sha(files.get(`${directory}/request.json`)), expectedSha256: pins,
    requiresSeparateServiceStopStart: true, automaticRollback: false, changesPL: false, executed: false };
  const read = (name, limit) => { assert.ok(files.has(name), name); const raw = files.get(name); assert.ok(raw.length <= limit); return raw; };
  return { plan, request, script, files, read };
}

function success() {
  const before = index => ({ dev: 1, ino: 100 + index, bytes: sizes[index], mode: index === 5 ? 0o600 : 0o644,
    uid: 0, gid: 0, nlink: 1, mtime_ns: '1792154386501571393', ctime_ns: '1792154386501571393' });
  const manifest = { schema: 2, method: 'exact-ps-v2-reinstall', run_id: runId, boot_id: boot, app,
    unit: 'fz3b-vision-console.service', approved_manifest_sha256: 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09',
    legacy_source_sha256: '9b0bf3212e10fd539872e8976814474edac0df4611655d8b01cafea8202b3a02',
    lifecycle_source_sha256: 'b05172f7ead79cfda5995a70c2d7800f5eb72eae104c0621d904bfeb6467a81b',
    product_gate_source_sha256: 'c14b4604b4d18377865080d477cb5aa0d357829aca14c85d3be961d283be17aa',
    inspector_gate_source_sha256: '9c15a032ff912893824c3bc634551618bc39eab61790d7fb53e2dcc70bcca9d9',
    entries: Object.keys(pins).map((key, index) => ({ path: key, old_sha256: pins[key], new_sha256: pins[key],
      bytes: sizes[index], backup: `${index}.original`, before: before(index) })) };
  const dependencies = Object.fromEntries(['fz3b-pl-loader.service', 'fz3b-app-r5.service', 'fz3b-app-cpu-clock.service'].map(key => [key, { activeState: 'active' }]));
  const check = { boot_id: boot, unit_sha256: '1089e63bb0138e9c0f0c45f22ad8f95a74bcc92fca998fa541f37836844d599b',
    service: { activeState: 'inactive', subState: 'dead', mainPid: 0 }, dependencies,
    scan: { deviceOpened: false, a0005Owners: [], active8765: [], listeners8765: [] },
    processAudit: { completePass: true, selfExcluded: { pid: 42, startTicks: 123 }, stdinInspectors: [], newPidsAtEnd: [],
      rawArgvEmitted: false, stdinRead: false, environmentRead: false, remainingArgumentsRead: false } };
  const observation = { status: 'reinstalled-v2', mode: 'reinstall-v2', run_id: runId, attemptedTargetCount: 6, replacedTargetCount: 6,
    persistent_lock_retained: false, persistent_lock_uncertain: false, service_lifecycle_changed: false, hardware_accessed: false,
    application_started: false, automatic_rollback: false, new_pl_built: false, manifest, manifest_sha256: sha(json(manifest)),
    backup_directory: `${app}/.forgedesk-ps-v2-reinstall-backups/${runId}`, checks: Array.from({ length: 9 }, () => structuredClone(check)),
    productGateSha256: manifest.product_gate_source_sha256, productLockFileModified: false, productLeaseClosed: true,
    inspectorGateSha256: manifest.inspector_gate_source_sha256,
    productGateChecks: Array.from({ length: 9 }, () => ({ journalCount: 1,
      journalHashes: { 'af51470d-b545-4fde-ae78-69bf13a61fd7.json': 'a'.repeat(64) },
      profileSha256: '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd',
      fixedOperationId: 'af51470d-b545-4fde-ae78-69bf13a61fd7', productLeaseHeldReadOnly: true, unknownCleared: false })),
    entries: Object.keys(pins).map((key, index) => ({ path: key, sha256: pins[key], before: before(index), after: { ...before(index), ino: 1000 + index } })) };
  return { stdout: JSON.stringify(observation), stderr: '', sshCloseConfirmed: true, exitCode: 0, signal: null, failure: null,
    remoteOutcomeUnknown: false, observation, sshExitObserved: true, killAttempted: false, killReturn: null, killError: null,
    cleanupDeadlineExceeded: false, captureTimeoutMs: 60000, cleanupTimeoutMs: 5000, localSshPid: 123 };
}

function storage() {
  const actions = []; const records = [];
  return { actions, records, acquire() { actions.push('acquire'); }, save(value) { records.push(structuredClone(value)); actions.push('save'); },
    writeStreams(stdout, stderr) { actions.push('archive-streams'); assert.ok(typeof stdout === 'string' && typeof stderr === 'string'); }, release() { actions.push('release'); } };
}

test('pure plan validation binds fixed paths, six current hashes and all reviewed sources', () => {
  const f = fixture(); assert.deepEqual(validatePlan(f.plan, `${directory}/plan.json`, f.read), f.script);
  for (const change of [value => { value.expectedSha256 = { ...pins, 'loader.py': '0'.repeat(64) }; },
    value => { value.bootId = 'other'; }, value => { value.stdinFile = '../foreign.py'; },
    value => { value.automaticRollback = true; }, value => { value.executed = true; }, value => { value.extra = null; }]) {
    const value = structuredClone(f.plan); change(value); assert.throws(() => validatePlan(value, `${directory}/plan.json`, f.read));
  }
});

test('payload/source/manifest drift and duplicate request keys are refused offline', () => {
  const f = fixture(); const original = f.files.get(f.plan.stdinFile); f.files.set(f.plan.stdinFile, Buffer.from('changed'));
  assert.throws(() => validatePlan(f.plan, `${directory}/plan.json`, f.read)); f.files.set(f.plan.stdinFile, original);
  const raw = Buffer.from('{"schema":1,"schema":1}\n'); f.files.set(f.plan.requestFile, raw); f.plan.requestSha256 = sha(raw);
  assert.throws(() => validatePlan(f.plan, `${directory}/plan.json`, f.read), /canonical/);
});

test('all six inode changes, independent checks and confirmed transport facts are mandatory', () => {
  assert.doesNotThrow(() => assertReinstallResult(success(), runId));
  for (const change of [value => { value.sshCloseConfirmed = false; }, value => { value.remoteOutcomeUnknown = true; },
    value => { value.sshExitObserved = false; }, value => { value.killAttempted = true; }, value => { value.cleanupDeadlineExceeded = true; },
    value => { value.signal = 'SIGTERM'; }, value => { value.observation.replacedTargetCount = 5; },
    value => { value.observation.persistent_lock_retained = true; }, value => { value.observation.persistent_lock_uncertain = true; },
    value => { value.observation.entries[0].after = { ...value.observation.entries[0].before }; },
    value => { value.observation.checks[2].scan.a0005Owners = [{ pid: 1 }]; }, value => { value.observation.checks.pop(); },
    value => { value.observation.checks[3].processAudit.stdinInspectors = [{ pid: 99 }]; },
    value => { value.observation.checks[2].processAudit.selfExcluded.startTicks++; },
    value => { value.observation.checks[4].processAudit.completePass = false; },
    value => { value.observation.manifest.entries[2].backup = null; }, value => { value.observation.automatic_rollback = true; }]) {
    const value = success(); change(value); assert.throws(() => assertReinstallResult(value, runId));
  }
});

test('one explicit action sends only fixed python stdin, observes close and releases host lease after success', async () => {
  const f = fixture(); const ledger = storage(); let calls = 0;
  const result = await executeOne(f.plan, f.script, { hostIdle: async () => {}, storage: ledger,
    capture: async (script, args, options) => {
      calls++; assert.deepEqual(script, f.script); assert.equal(options.timeoutMs, 60000);
      assert.equal(args.at(-1), 'python3 -B -'); assert.ok(args.includes('PasswordAuthentication=no'));
      assert.ok(args.includes('ConnectionAttempts=1')); assert.ok(!args.some(value => /systemctl|restart|rollback/.test(value)));
      return success();
    } });
  assert.equal(calls, 1); assert.equal(result.result, 'passed-host-ps-v2-reinstall'); assert.equal(result.calls, 1);
  assert.equal(ledger.actions.at(-1), 'release'); assert.equal(JSON.stringify(result).includes('fz3b_acceptance_ed25519'), false);
});

test('timeout/partial/no-close/inner-unknown never retries, releases the lease or starts a service', async () => {
  for (const change of [value => { value.failure = 'SSH deadline'; value.remoteOutcomeUnknown = true; value.exitCode = null; value.sshCloseConfirmed = false; },
    value => { value.observation.status = 'unknown'; value.observation.replacedTargetCount = 2; value.exitCode = 2; },
    value => { value.observation = null; }, value => { value.failure = 'Non-JSON response'; }]) {
    const f = fixture(); const ledger = storage(); let calls = 0;
    const result = await executeOne(f.plan, f.script, { hostIdle: async () => {}, storage: ledger, capture: async () => { calls++; const response = success(); change(response); return response; } });
    assert.equal(result.result, 'unknown-held-for-root-review'); assert.equal(calls, 1); assert.ok(!ledger.actions.includes('release'));
    assert.equal(result.serviceActionsIssued, false); assert.equal(result.automaticRollback, false);
  }
});

test('app presence or an existing host lease prevents even a single transport call', async () => {
  const f = fixture(); let calls = 0;
  const capture = async () => { calls++; throw new Error('must not execute'); };
  await assert.rejects(executeOne(f.plan, f.script, { capture, storage: storage(), hostIdle: async () => { throw new Error('app still present'); } }));
  const ledger = storage(); ledger.acquire = () => { throw new Error('lease exists'); };
  await assert.rejects(executeOne(f.plan, f.script, { capture, storage: ledger, hostIdle: async () => {} })); assert.equal(calls, 0);
});

test('host app absence is checked again under the acquired lease before transport', async () => {
  const f = fixture(); const ledger = storage(); let checks = 0; let calls = 0;
  const result = await executeOne(f.plan, f.script, { storage: ledger,
    hostIdle: async () => { if (++checks === 2) throw new Error('app appeared after initial census'); },
    capture: async () => { calls++; return success(); } });
  assert.equal(checks, 2); assert.equal(calls, 0); assert.equal(result.calls, 0);
  assert.equal(result.result, 'unknown-held-for-root-review'); assert.ok(!ledger.actions.includes('release'));
});

test('source evidence save failure remains held, including after a valid remote action', async () => {
  const f = fixture(); const ledger = storage(); let saves = 0;
  ledger.save = () => { if (++saves >= 2) throw new Error('durability unconfirmed'); };
  const result = await executeOne(f.plan, f.script, { capture: async () => success(), storage: ledger, hostIdle: async () => {} });
  assert.equal(result.result, 'unknown-held-for-root-review'); assert.equal(result.evidenceWriteUnconfirmed, true); assert.ok(!ledger.actions.includes('release'));
});

function memoryIo() {
  const files = new Map(); const descriptors = new Map(); const actions = []; let nextFd = 10;
  const io = {
    files, descriptors, actions, maximumWrite: Infinity, zeroWrite: false, failOpen: undefined,
    openSync(name, mode) {
      actions.push(['open', name, mode]);
      if (name === io.failOpen || files.has(name)) throw new Error('existing or unavailable file');
      const fd = ++nextFd; const file = { data: Buffer.alloc(0), ino: fd }; files.set(name, file); descriptors.set(fd, file); return fd;
    },
    writeSync(fd, raw, offset, length, position) {
      const count = io.zeroWrite ? 0 : Math.min(length, io.maximumWrite);
      actions.push(['write', fd, position, count]);
      const file = descriptors.get(fd); assert.ok(file);
      const data = Buffer.alloc(Math.max(file.data.length, position + count)); file.data.copy(data); raw.copy(data, position, offset, offset + count); file.data = data;
      return count;
    },
    fsyncSync(fd) { assert.ok(descriptors.has(fd)); actions.push(['fsync', fd]); },
    ftruncateSync(fd, length) { const file = descriptors.get(fd); file.data = file.data.subarray(0, length); actions.push(['truncate', fd, length]); },
    closeSync(fd) { assert.ok(descriptors.delete(fd)); actions.push(['close', fd]); },
    lstatSync(name) { const file = files.get(name); return { dev: 1, ino: file.ino, isSymbolicLink: () => false }; },
    fstatSync(fd) { return { dev: 1, ino: descriptors.get(fd).ino }; },
    readFileSync(name) { return files.get(name).data; },
    unlinkSync(name) { assert.ok(files.delete(name)); actions.push(['unlink', name]); },
  };
  return io;
}

test('partial host writes are completed and zero/invalid progress cannot be acknowledged', () => {
  const io = memoryIo(); io.maximumWrite = 2;
  const ledger = createHostStorage('lease', 'fresh/execution.json', Buffer.from('seal'), io);
  ledger.acquire(); ledger.save({ result: 'running' });
  assert.deepEqual(JSON.parse(io.files.get('fresh/execution.json').data), { result: 'running' });
  assert.equal(io.files.get('lease').data.toString(), 'seal');
  io.zeroWrite = true;
  assert.throws(() => ledger.save({ result: 'passed' }), /no valid progress/);
  assert.throws(() => ledger.save({ result: 'unknown' }), /uncertain/);
  assert.throws(() => ledger.release(), /Uncertain/); ledger.close();
  assert.equal(io.files.has('lease'), true); assert.equal(io.descriptors.size, 0);
  for (const count of [0, -1, NaN, 99]) assert.throws(() => writeFully(1, Buffer.from('x'), { writeSync: () => count }));
});

test('partial acquire closes only owned descriptors and preserves uncertain lease and prior receipt', () => {
  for (const scenario of ['seal-write', 'receipt-exists', 'foreign-lease']) {
    const io = memoryIo(); const old = { data: Buffer.from('prior completed receipt'), ino: 999 };
    if (scenario === 'seal-write') io.zeroWrite = true;
    if (scenario === 'receipt-exists') io.files.set('fresh/execution.json', old);
    if (scenario === 'foreign-lease') io.files.set('lease', old);
    const ledger = createHostStorage('lease', 'fresh/execution.json', Buffer.from('seal'), io);
    assert.throws(() => ledger.acquire()); ledger.close();
    assert.equal(io.descriptors.size, 0); assert.equal(io.files.has('lease'), true);
    assert.ok(!io.actions.some(action => action[0] === 'unlink'));
    if (scenario === 'receipt-exists') assert.equal(io.files.get('fresh/execution.json'), old);
    if (scenario === 'foreign-lease') assert.equal(io.files.get('lease'), old);
  }
});
