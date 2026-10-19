import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, lstat, link, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, BASE, SOURCE, SOURCE_SHA256, SSH, SERVICED_SSH, SYSTEM_SSH_APPROVAL, PRIOR, PRIOR_SHA256, KNOWN, KEY, FILE_PINS,
  OLD_BOOT, OBSERVED_BOOT, MAX_STDOUT, MAX_STDERR, TIMEOUT_MS, CLEANUP_MS,
  digest, parseArgs, readBound, readApprovedSystemSsh, validatePlan, validatePrior, sshEnvironment, sshArgs, validateReport,
  capture, runQualification } from './new_boot_qualification.mjs';

const APP = '/root/fz3b-vision-console-20261009-001';
const UNITS = ['fz3b-vision-console.service', 'fz3b-pl-loader.service', 'fz3b-app-r5.service', 'fz3b-app-cpu-clock.service'];
const canon = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);
const bytes = value => Buffer.from(canon(value.snapshots ? asV2(value) : value) + '\n');
const metadata = () => ({ device: 1, inode: 8, bytes: 10, mode: 0o600, uid: 0, gid: 0, nlink: 1 });
function bootstrapFixture() {
  const f = p => ({ path: p, metadata: { ...metadata(), fileType: 32768 }, linkTarget: null });
  return { flags: { isolated: 1, noSite: 1, dontWriteBytecode: 1, ignoreEnvironment: 1, noUserSite: 1 }, pythonVersion: [3, 6, 15], reportedExecutableSha256: digest(Buffer.from('/usr/bin/python3')), executable: f('/usr/bin/python3'), resolvedExecutable: f('/usr/bin/python3'), origins: ['datetime', 'hashlib', 'json', 'os', 're', 'select', 'stat', 'subprocess', 'sys', 'time'].map(module => ({ module, kind: 'built-in', reportedOriginSha256: null, file: null })), trust: 'fixed-path-observation-only', cryptographicAttestation: false, transitiveOriginsVerified: false, issues: [] };
}
function asV2(legacy) {
  const { snapshots, diagnostics, ...r } = structuredClone(legacy); assert.equal(snapshots.length, 2);
  let counter = 0;
  const item = (id, data) => { const v = { id, state: 'observed', data, error: null, diagnostics: [], blockedBy: null, readBytesBefore: counter, readBytesAfter: counter }; if (id === 'boot' && counter === 0) { counter = r.totalReadBytes; v.readBytesAfter = counter; } return v; };
  const bootstrap = item('bootstrap', bootstrapFixture());
  const scans = snapshots.map((s, i) => ({ ordinal: i + 1, startedAt: r.startedAt, completedAt: r.completedAt, stages: [
    ['boot-before', [item('boot', s.bootId)]], ['files', s.files.map(f => item(f.path, f))], ['services', s.services.map(v => item(v.unit, v))], ['guards', Object.entries(s.guards).sort(([a], [b]) => ['journal', 'psLease', 'quarantine'].indexOf(a) - ['journal', 'psLease', 'quarantine'].indexOf(b)).map(([k, v]) => item(k, v))], ['census', [item('system', s.census)]], ['dependencies', s.dependencies.roots.map(v => item(v.path, v))], ['boot-after', [item('boot', s.bootId)]],
  ].map(([id, items]) => ({ id, state: 'complete', items })) }));
  const { pythonVersion, roots, ...dependencyScope } = snapshots[0].dependencies;
  return { ...r, schemaVersion: 2, scope: 'fz3b-new-boot-readonly-qualification-v2', bootstrap, dependencyScope, scans, relevantCoreStableObserved: r.stable, globalStop: null };
}
function observation() {
  const paths = [...Object.keys(FILE_PINS), ...['run.sh', 'vision_app/link_setup.py', 'vision_app/board_runtime.py', 'vision_app/r5_start.py', 'vision_app/r5_bridge.py', 'vision_app/cpu_clock_service.py'].map(v => APP + '/' + v), ...UNITS.slice(2).map(v => '/etc/systemd/system/' + v)].sort();
  const guard = p => ({ path: p, state: 'absent', records: [], inventorySha256: digest(Buffer.from('[]')) });
  const first = {
    bootId: OBSERVED_BOOT,
    files: paths.map(p => ({ path: p, sha256: FILE_PINS[p] ?? 'a'.repeat(64), expectedSha256: FILE_PINS[p] ?? null, matchesPin: FILE_PINS[p] ? true : null, metadata: metadata() })),
    services: UNITS.map((unit, i) => ({ unit, activeState: 'active', subState: i === 2 ? 'exited' : 'running', mainPid: i === 2 ? 0 : 200 + i, startTicks: i === 2 ? null : 10, fragmentMatches: true, dropInsMatch: true, execStartMatches: true, execStartSha256: 'a'.repeat(64), propertiesSha256: 'b'.repeat(64), managerCurrent: true, workingDirectoryMatches: true,
      process: i === 2 ? null : { pid: 200 + i, startTicks: 10, exe: '/usr/bin/python3.6', prefixSha256: 'a'.repeat(64), matchesExpectedPrefix: true, workingDirectoryMatches: true } })),
    guards: { journal: guard(APP + '/.forgedesk-product-operations'), quarantine: guard(APP + '/.forgedesk-recovery-quarantine'), psLease: { path: APP + '/.forgedesk-ps-transaction.lock', state: 'absent', sha256: null, metadata: null } },
    census: { complete: true, processCount: 20, fdCount: 100, selfExcluded: { pid: 100, startTicks: 10 }, sshAncestry: [{ pid: 90, startTicks: 8, exe: '/usr/sbin/sshd' }], device: { ...metadata(), mode: 0o666, rdev: 42 }, vanishedUnrelated: [], deviceOwners: [], inspectors: [], tcp: [], ipv6Absent: false, environmentRead: false, stdinRead: false, remainingArgumentsRead: false, deviceOpened: false },
    dependencies: { scope: 'fixed-cryptography-metadata-only', pythonVersion: [3, 6, 15], roots: ['/usr/lib/python3/dist-packages', '/usr/local/lib/python3.6/dist-packages', '/usr/local/lib/python3.6/site-packages'].map(p => ({ path: p, state: 'absent', distributions: [], moduleFiles: [] })), applicationImported: false, providerImported: false, nativeLoaded: false, providerFunctionVerified: false, ed25519Verified: false },
  };
  return { schemaVersion: 1, scope: 'fz3b-new-boot-readonly-qualification-v1', result: 'observed-only', startedAt: '2026-10-17T08:00:00.000Z', completedAt: '2026-10-17T08:00:01.000Z', historicalBootId: OLD_BOOT, historicalProfileSha256: '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd', resourceManifestSha256: 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07', profileAdopted: false, computeAuthorized: false, releaseAuthorized: false, noApplicationImport: true, noDeviceOpen: true, noRPC: true, noServiceActions: true, noIntentionalRemoteWrites: true, snapshots: [first, structuredClone(first)], stable: true, issues: [], diagnostics: [], unrelatedChurn: { processCountBefore: 20, processCountAfter: 20, fdCountBefore: 100, fdCountAfter: 100, vanishedClassifiedNonInspectors: 0 }, unverified: ['cryptography-provider-function-and-Ed25519-capability'], totalReadBytes: 100 };
}
const hostEnvironment = { systemroot: 'C:\\Windows', windir: 'C:\\Windows', ProgramData: 'C:\\ProgramData', TEMP: 'C:\\fixture-temp', tmp: 'C:\\fixture-temp', NODE_OPTIONS: '--require evil', PYTHONPATH: 'evil', SSH_AUTH_SOCK: 'secret', AUTH_TOKEN: 'secret', PATH: 'evil' };
const input = runId => ({ runId, planSha256: '' });
function plan(runId) { return { schemaVersion: 1, scope: 'fixed-newboot-observation-plan-v1', runId, expectedHistoricalBootId: OLD_BOOT, expectedObservedBootId: OBSERVED_BOOT, priorObservationPath: PRIOR, priorObservationSha256: PRIOR_SHA256, collectorSourceSha256: SOURCE_SHA256, nonce: 'f'.repeat(64) }; }
class Pipe extends EventEmitter { destroy() { this.destroyed = true; } }
class Child extends EventEmitter {
  constructor(behavior = {}) { super(); this.pid = 1234; this.stdout = new Pipe(); this.stderr = new Pipe(); this.stdin = new Pipe(); this.behavior = behavior; this.killCalls = 0; this.unrefCalls = 0;
    this.stdin.end = script => { this.script = script; queueMicrotask(() => { if (behavior.spawn !== false) this.emit('spawn'); if (behavior.stdinError) this.stdin.emit('error', new Error('fixture')); else if (behavior.finish !== false) this.stdin.emit('finish'); behavior.onEnd?.(this); }); };
  }
  kill() { this.killCalls++; if (this.behavior.killThrow) throw new Error('fixture'); this.behavior.onKill?.(this); return this.behavior.killReturn ?? true; }
  unref() { this.unrefCalls++; }
  success(raw = bytes(observation())) { this.stdout.emit('data', raw); this.emit('exit', 0, null); this.emit('close', 0, null); }
}
function clock() { const pending = new Map(); let id = 0; return { setTimeout(fn, ms) { pending.set(++id, { fn, ms }); return id; }, clearTimeout(n) { pending.delete(n); }, fire(ms) { for (const [n, timer] of [...pending]) if (timer.ms === ms) { pending.delete(n); timer.fn(); } } }; }
function spawnFor(behavior = {}, holder = {}) { return (...args) => { holder.args = args; holder.child = new Child(behavior); return holder.child; }; }
async function fixture(runId = 'newboot-1792239000000-aabbcc') {
  const out = path.join(ROOT, 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/new-boot-pure-fixtures'); await mkdir(out, { recursive: true });
  const root = await mkdtemp(path.join(out, 'case-'));
  for (const relative of [SOURCE, PRIOR, KNOWN]) { const target = path.join(root, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(path.join(ROOT, relative)), { flag: 'wx' }); }
  await mkdir(path.dirname(path.join(root, KEY)), { recursive: true }); await writeFile(path.join(root, KEY), 'OFFLINE SYNTHETIC NON-KEY FIXTURE '.repeat(8), { flag: 'wx' });
  const raw = Buffer.from(JSON.stringify(plan(runId), null, 2) + '\n'); const planPath = path.join(root, BASE, 'plans', runId + '.json'); await mkdir(path.dirname(planPath), { recursive: true }); await writeFile(planPath, raw, { flag: 'wx' });
  return { root, planPath, input: { runId, planSha256: digest(raw) }, overrides: { root, platform: 'win32', environment: hostEnvironment, readExecutable: async name => { assert.equal(name, SSH); return Buffer.from('offline fixture binary'); }, captureIO: { spawn: spawnFor({ onEnd: c => c.success() }) } } };
}

test('exact opt-in CLI and reviewed closed plan refuse overrides/retries', () => {
  const id = 'newboot-1792239000000-aabbcc', raw = Buffer.from(JSON.stringify(plan(id), null, 2) + '\n');
  const i = { runId: id, planSha256: digest(raw) }; assert.equal(validatePlan(raw, i).runId, id);
  assert.deepEqual(parseArgs(['--run-id', id, '--plan-sha256', i.planSha256, '--execute-readonly']), i);
  for (const args of [[], ['--run-id', id], ['--run-id', id, '--plan-sha256', i.planSha256, '--execute-readonly', '--retry']]) assert.throws(() => parseArgs(args));
  const p = plan(id); p.expectedObservedBootId = OLD_BOOT; const bad = Buffer.from(JSON.stringify(p, null, 2) + '\n'); assert.throws(() => validatePlan(bad, { ...i, planSha256: digest(bad) }));
});

test('fixed source and prior pins are actual public bytes, not self-reported new hashes', async () => {
  assert.equal(digest(await readFile(path.join(ROOT, SOURCE))), SOURCE_SHA256);
  validatePrior(await readFile(path.join(ROOT, PRIOR)));
  assert.throws(() => validatePrior(Buffer.from('{}')));
});

function systemBinaryFs(raw, settings = {}) {
  const a = path.resolve(SSH), b = path.resolve(SERVICED_SSH), opened = [], closed = [], state = { read: false };
  function info(filename) {
    const side = filename === b;
    const value = { dev: 1n, ino: side && settings.foreignPair ? 99n : 88n, size: BigInt(SYSTEM_SSH_APPROVAL.bytes),
      mode: 0o100644n, mtimeNs: 100000000n, ctimeNs: 100000000n, nlink: 2n, isFile: () => true, isSymbolicLink: () => false };
    if (settings.nlink !== undefined) value.nlink = BigInt(settings.nlink);
    if (settings.size !== undefined) value.size = BigInt(settings.size);
    if (settings.changedDuringRead && state.read && side) value.ino++;
    return value;
  }
  return { opened, closed, io: {
    async lstat(filename, options) { assert.equal(options.bigint, true); const absolute = path.resolve(filename); if (settings.linkedParent && absolute.toLowerCase() === path.resolve('C:/Windows/WinSxS').toLowerCase()) return { isSymbolicLink: () => true }; return absolute === a || absolute === b ? info(absolute) : { isSymbolicLink: () => false }; },
    async realpath(filename) { return settings.redirected ? path.resolve(filename) + '.other' : path.resolve(filename); },
    async open(filename, mode) { assert.equal(mode, 'r'); assert.ok([a, b].includes(filename)); opened.push(filename);
      return { async stat(options) { assert.equal(options.bigint, true); return info(filename); }, async read(buffer, offset, length, position) { state.read = true; const available = raw.subarray(position, position + length); available.copy(buffer, offset); return { bytesRead: available.length }; }, async close() { closed.push(filename); } };
    },
  } };
}

test('exactSystemBinary: reviewed bytes and servicing pair accepted only under fixed system paths', async () => {
  // This is a read of a public installed OS file, never a process launch. All
  // subsequent negative metadata/path operations use injected isolated fixtures.
  const raw = await readFile(SSH); assert.equal(raw.length, SYSTEM_SSH_APPROVAL.bytes); assert.equal(digest(raw), SYSTEM_SSH_APPROVAL.sha256);
  await assert.rejects(readBound(SSH, 8 * 1048576), /single-link/);
  const actual = await readApprovedSystemSsh(); assert.equal(actual.verification.observerKind, 'fixed-system-file-read');
  assert.equal(digest(actual.bytes), SYSTEM_SSH_APPROVAL.sha256);
  const f = systemBinaryFs(raw); const approved = await readApprovedSystemSsh(f.io);
  assert.equal(digest(approved.bytes), SYSTEM_SSH_APPROVAL.sha256);
  assert.deepEqual(f.opened, [path.resolve(SSH), path.resolve(SERVICED_SSH)]); assert.equal(f.closed.length, 2);
  assert.equal(approved.verification.observerKind, 'injected-offline-fixture');
  assert.equal(approved.verification.sameFileIdentityVerified, true); assert.equal(approved.verification.nlink, 2);
  assert.equal(approved.verification.authenticodeEvidence, 'root-reviewed-Valid-not-revalidated-by-this-reader');
  for (const settings of [{ nlink: 1 }, { nlink: 3 }, { size: raw.length - 1 }, { foreignPair: true }, { linkedParent: true }, { redirected: true }, { changedDuringRead: true }]) {
    const bad = systemBinaryFs(raw, settings); await assert.rejects(readApprovedSystemSsh(bad.io)); assert.equal(bad.closed.length, bad.opened.length);
  }
  const corrupt = Buffer.from(raw); corrupt[0] ^= 1;
  await assert.rejects(readApprovedSystemSsh(systemBinaryFs(corrupt).io), /reviewed-byte-pin/);
  await assert.rejects(readApprovedSystemSsh(systemBinaryFs(Buffer.concat([raw, Buffer.from('x')])).io), /read-byte-budget/);
  await assert.rejects(readApprovedSystemSsh({ filename: SSH }), /no-path-override/);
});

test('controlled genuine case-insensitive environment discards all authentication and interpreter overrides', () => {
  const env = sshEnvironment(hostEnvironment); assert.equal(env.SystemRoot, 'C:\\Windows'); assert.equal(env.ProgramData, 'C:\\ProgramData');
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'ProgramData', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'].sort());
  for (const bad of [{ ...hostEnvironment, SYSTEMROOT: 'D:\\Windows' }, { ...hostEnvironment, ProgramData: '' }, { ...hostEnvironment, systemroot: undefined }]) assert.throws(() => sshEnvironment(bad));
  const args = sshArgs('known', 'key'); assert.equal(args.at(-1), '/usr/bin/python3 -I -S -B -'); assert.equal(args.at(-2), 'root@169.254.220.254'); assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('IdentityAgent=none')); assert.ok(!args.includes('accept-new'));
});

test('strict nested report parser accepts observed-only but never authorizes or proves provider', () => {
  const report = validateReport(bytes(observation())); assert.equal(report.result, 'observed-only'); assert.equal(report.computeAuthorized, false); assert.equal(report.bootstrap.data.cryptographicAttestation, false);
  for (const mutate of [r => r.profileAdopted = true, r => r.extra = 1, r => r.snapshots[0].guards.journal.extra = 1,
    r => r.snapshots[0].census.extra = true, r => r.snapshots[0].dependencies.roots[0].extra = true,
    r => r.snapshots[0].files[0].metadata.extra = true, r => r.snapshots[0].services[0].fragmentMatches = false,
    r => r.snapshots[0].dependencies.ed25519Verified = true, r => r.snapshots[0].files.pop(),
    r => r.snapshots[0].services[0].process.matchesExpectedPrefix = false,
    r => r.snapshots[0].census.inspectors.push({ pid: 400, startTicks: 1 }),
    r => r.snapshots[0].guards.psLease.state = 'present-held']) {
    const changed = observation(); mutate(changed); assert.throws(() => validateReport(bytes(changed)));
  }
  assert.throws(() => validateReport(Buffer.from('{"a":1,"a":1}\n')));
  assert.throws(() => validateReport(Buffer.concat([bytes(observation()), bytes(observation())])));
});

test('relevant two-scan equality permits count churn, rejects device/service identity changes', () => {
  const changed = observation(); changed.snapshots[1].census.processCount = 22; changed.snapshots[1].census.fdCount = 103;
  changed.unrelatedChurn.processCountAfter = 22; changed.unrelatedChurn.fdCountAfter = 103;
  assert.equal(validateReport(bytes(changed)).stable, true);
  changed.snapshots[1].census.device.inode++; assert.throws(() => validateReport(bytes(changed)));
  const boot = observation(); boot.snapshots.forEach(s => s.bootId = OLD_BOOT); assert.throws(() => validateReport(bytes(boot)), /unexpected-observed-boot/);
});

test('refusal diagnostics expose only closed allowlisted path and actual metadata predicates', () => {
  const report = asV2(observation()); Object.assign(report, { result: 'held', stable: false, relevantCoreStableObserved: false, unrelatedChurn: null, issues: ['directory-metadata'] });
  const diagnostic = { category: 'directory-metadata', path: '/etc/systemd/system', pathClass: 'fixed-input', stage: 'named-entry', expectedKind: 'directory', procPolicy: false,
    named: { ...metadata(), mode: 0o777, fileType: 16384 }, opened: null, identityDifferences: [], limitBytes: null,
    checks: { kindMatches: true, ownerRoot: true, noGroupOrOtherWrite: false, singleLink: null, withinSizeBudget: null, namedAndOpenedEqual: null } };
  const failed = report.scans[0].stages[1].items[0]; Object.assign(failed, { state: 'refused', data: null, error: 'directory-metadata', diagnostics: [diagnostic] }); report.scans[0].stages[1].state = 'partial';
  assert.equal(validateReport(bytes(report)).scans[0].stages[1].items[0].diagnostics[0].checks.noGroupOrOtherWrite, false);
  for (const mutate of [d => d.path = '/root/.ssh', d => d.extra = 'secret', d => d.category = 'arbitrary', d => d.named.content = 'secret', d => d.checks.ownerRoot = false, d => d.stage = 'opened-entry', d => d.pathClass = 'proc-census', d => d.identityDifferences = ['unknown']]) {
    const changed = structuredClone(report); mutate(changed.scans[0].stages[1].items[0].diagnostics[0]); assert.throws(() => validateReport(bytes(changed)));
  }
  const opened = structuredClone(report); const d = opened.scans[0].stages[1].items[0].diagnostics[0]; d.stage = 'opened-entry'; d.named.mode = 0o700; d.opened = { ...d.named, inode: 99 }; d.checks.noGroupOrOtherWrite = true; d.checks.namedAndOpenedEqual = false; d.identityDifferences = ['inode']; assert.equal(validateReport(bytes(opened)).result, 'held');
  const observed = structuredClone(report); observed.result = 'observed-only'; assert.throws(() => validateReport(bytes(observed)));
});

test('V2 retains both complete independent cores while unsafe dependency remains held and untraversed', () => {
  const r = asV2(observation()); Object.assign(r, { result: 'held', stable: false, issues: ['directory-metadata', 'required-stage-incomplete'] });
  for (const scan of r.scans) {
    const stage = scan.stages[5], bad = stage.items[1], blocked = stage.items[2]; stage.state = 'partial';
    const d = { category: 'directory-metadata', path: '/usr/local/lib/python3.6', pathClass: 'fixed-input', stage: 'named-entry', expectedKind: 'directory', procPolicy: false, named: { ...metadata(), mode: 0o2775, fileType: 16384 }, opened: null, identityDifferences: [], limitBytes: null, checks: { kindMatches: true, ownerRoot: true, noGroupOrOtherWrite: false, singleLink: null, withinSizeBudget: null, namedAndOpenedEqual: null } };
    Object.assign(bad, { state: 'refused', data: null, error: 'directory-metadata', diagnostics: [d] });
    Object.assign(blocked, { state: 'not-attempted', data: null, error: 'unsafe-ancestor-not-traversed', blockedBy: bad.id });
  }
  assert.equal(validateReport(bytes(r)).relevantCoreStableObserved, true); assert.equal(r.profileAdopted, false);
  for (const mutate of [v => v.scans[0].stages[5].state = 'complete', v => v.scans[0].stages[4].items.pop(), v => v.scans[0].stages[1].items.push(v.scans[0].stages[1].items[0]), v => v.scans[0].stages[5].items[2].blockedBy = 'arbitrary', v => v.result = 'observed-only', v => v.stable = true]) {
    const changed = structuredClone(r); mutate(changed); assert.throws(() => validateReport(bytes(changed)));
  }
});

test('V2 rejects actions after global bounds and bootstrap or origin override claims', () => {
  const r = asV2(observation()); r.result = 'held'; r.globalStop = 'collector-deadline'; r.issues = ['collector-deadline'];
  Object.assign(r.scans[0].stages[1].items[0], { state: 'refused', data: null, error: 'collector-deadline' }); r.scans[0].stages[1].state = 'partial'; r.stable = false; r.relevantCoreStableObserved = false; r.unrelatedChurn = null;
  assert.throws(() => validateReport(bytes(r)), /observed-after-stop/);
  for (const mutate of [v => v.bootstrap.blockedBy = { arbitrary: true }, v => v.bootstrap.data.cryptographicAttestation = true, v => v.bootstrap.data.flags.noSite = 0, v => v.bootstrap.data.executable.path = '/usr/local/bin/python3', v => v.bootstrap.data.origins[0].file = { path: '/root/.ssh/key' }, v => v.bootstrap.data.sysPath = ['/secret']]) {
    const v = asV2(observation()); mutate(v); assert.throws(() => validateReport(bytes(v)));
  }
});

test('actual Python producer synthetic full/partial/changed-core envelopes match the host parser', async () => {
  const run = promisify(execFile);
  for (const mode of ['stable', 'changed', 'dependency', 'budget']) {
    const script = "import sys;sys.path.insert(0,'engineering/fz3b/tools');import test_new_boot_qualification as f\n" +
      "a=f.FakeAccess()\n" + (mode === 'changed' ? "a.values[1]['census']['device']['inode']+=1\n" : '') +
      (mode === 'dependency' ? "def bad(roots):\n if roots[0].startswith('/usr/local/'):\n  f.q.require_metadata(False,'directory-metadata','/usr/local/lib/python3.6','directory',False,f.meta(4096,mode=f.stat.S_IFDIR|0o2775))\n return {'roots':[r for r in a.current()['dependencies']['roots'] if r['path'] in roots]}\na.dependencies=bad\n" : '') +
      (mode === 'budget' ? "def badfile(name):\n a.read_bytes=f.q.MAX_TOTAL+2\n raise f.q.Refused('aggregate-read-budget')\na.file=badfile\n" : '') +
      "print(f.q.canonical(f.q.collect(a)).decode('ascii'))\n";
    const { stdout } = await run('C:/Users/ruyangge/.codex/mcp/serial/.venv/Scripts/python.exe', ['-I', '-S', '-B', '-c', script], { cwd: ROOT, windowsHide: true, shell: false, maxBuffer: MAX_STDOUT, timeout: 10000 });
    const r = validateReport(Buffer.from(stdout.replaceAll('\r\n', '\n')));
    assert.equal(r.result, mode === 'stable' ? 'observed-only' : 'held');
    if (mode === 'dependency') assert.equal(r.relevantCoreStableObserved, true);
    if (mode === 'budget') assert.equal(r.globalStop, 'aggregate-read-budget');
  }
});

test('Python 3.6 actual bootstrap sys identity compatibility passes only closed original-module facts', async () => {
  const run = promisify(execFile);
  for (const mode of ['none', 'replacement', 'missing-builtin', 'wrong-name', 'conflicting-spec', 'none-origin-spec', 'file-origin', 'unrelated-none']) {
    const script = "import sys;sys.path.insert(0,'engineering/fz3b/tools');import test_new_boot_qualification as f\n" +
      "a=f.FakeAccess();a.bootstrap=lambda:f.python36_bootstrap_fixture(" + JSON.stringify(mode) + ")\n" +
      "print(f.q.canonical(f.q.collect(a)).decode('ascii'))\n";
    const { stdout } = await run('C:/Users/ruyangge/.codex/mcp/serial/.venv/Scripts/python.exe', ['-I', '-S', '-B', '-c', script], { cwd: ROOT, windowsHide: true, shell: false, maxBuffer: MAX_STDOUT, timeout: 10000 });
    const report = validateReport(Buffer.from(stdout.replaceAll('\r\n', '\n')));
    assert.equal(report.result, mode === 'none' ? 'observed-only' : 'held');
    const identity = report.bootstrap.data.origins.find(v => v.module === (mode === 'unrelated-none' ? 'json' : 'sys'));
    assert.equal(identity.kind, mode === 'none' ? 'built-in' : 'untrusted');
    if (mode !== 'none') {
      assert.equal(report.globalStop, 'bootstrap-untrusted');
      assert.ok(report.scans.every(s => s.stages.every(stage => stage.items.every(item => item.state === 'not-attempted'))));
    }
    assert.equal(report.profileAdopted, false); assert.equal(report.releaseAuthorized, false);
  }
});

test('Python 3.6 ModuleSpec origin None requires actual bootstrap/importer objects across producer and host parser', async () => {
  const run = promisify(execFile);
  for (const mode of ['exact', 'spec-subclass', 'spec-lookalike', 'spec-name-eq', 'spec-loader-lookalike', 'sys-loader-lookalike', 'spec-origin-string-none', 'bootstrap-replaced', 'import-control-replaced', 'not-frozen', 'replaced-frozen-lambda', 'captured-frozen-lookalike', 'no-builtin-finder', 'unrelated-none', 'unsafe-ancestor']) {
    const script = "import sys;sys.path.insert(0,'engineering/fz3b/tools');import test_new_boot_qualification as f\n" +
      "a=f.FakeAccess();a.bootstrap=lambda:f.python36_modulespec_fixture(" + JSON.stringify(mode === 'unsafe-ancestor' ? 'exact' : mode) + ")\n" +
      (mode === 'unsafe-ancestor' ? "def bad(roots):\n if roots[0].startswith('/usr/local/'):\n  f.q.require_metadata(False,'directory-metadata','/usr/local/lib/python3.6','directory',False,f.meta(4096,mode=f.stat.S_IFDIR|0o2775))\n return {'roots':[r for r in a.current()['dependencies']['roots'] if r['path'] in roots]}\na.dependencies=bad\n" : '') +
      "print(f.q.canonical(f.q.collect(a)).decode('ascii'))\n";
    const { stdout } = await run('C:/Users/ruyangge/.codex/mcp/serial/.venv/Scripts/python.exe', ['-I', '-S', '-B', '-c', script], { cwd: ROOT, windowsHide: true, shell: false, maxBuffer: MAX_STDOUT, timeout: 10000 });
    const report = validateReport(Buffer.from(stdout.replaceAll('\r\n', '\n')));
    assert.equal(report.result, mode === 'exact' ? 'observed-only' : 'held');
    const validBootstrap = ['exact', 'unsafe-ancestor'].includes(mode);
    assert.equal(report.bootstrap.data.issues.length, validBootstrap ? 0 : 1);
    if (!validBootstrap) assert.equal(report.globalStop, 'bootstrap-untrusted');
    if (mode === 'unsafe-ancestor') {
      assert.equal(report.relevantCoreStableObserved, true); assert.ok(report.issues.includes('directory-metadata'));
      for (const scan of report.scans) assert.equal(scan.stages.find(s => s.id === 'dependencies').items[2].state, 'not-attempted');
    }
    assert.equal(report.profileAdopted, false); assert.equal(report.computeAuthorized, false); assert.equal(report.releaseAuthorized, false);
    assert.equal(report.bootstrap.data.cryptographicAttestation, false);
  }
});

test('complete source send plus consistent exit and close is required', async () => {
  const holder = {}; const result = await capture(Buffer.from('SOURCE'), [], {}, { spawn: spawnFor({ onEnd: c => c.success() }, holder) });
  assert.equal(result.remoteOutcomeUnknown, false); assert.equal(result.spawnObserved, true); assert.equal(result.stdinFinished, true); assert.equal(result.sshExitObserved, true); assert.equal(result.sshCloseConfirmed, true); assert.equal(holder.args[0], SSH); assert.equal(holder.args[2].shell, false); assert.equal(holder.child.script.toString(), 'SOURCE');
  for (const behavior of [{ spawn: false, onEnd: c => c.success() }, { finish: false, onEnd: c => c.success() }, { onEnd: c => c.emit('close', 0, null) }, { onEnd: c => { c.emit('exit', 7, null); c.emit('close', 0, null); } }]) {
    assert.equal((await capture(Buffer.from('x'), [], {}, { spawn: spawnFor(behavior) })).remoteOutcomeUnknown, true);
  }
});

test('stdin failure cannot be inferred successful from plausible JSON and clean close', async () => {
  const result = await capture(Buffer.from('x'), [], {}, { spawn: spawnFor({ stdinError: true, onEnd: c => c.success() }) });
  assert.equal(result.failure, 'ssh-stdin-error'); assert.equal(result.stdinFinished, false); assert.equal(result.remoteOutcomeUnknown, true);
});

test('overflow bounded raw prefixes retained, owned signal reentrancy records return', async () => {
  const result = await capture(Buffer.from('x'), [], {}, { spawn: spawnFor({ onEnd: c => c.stdout.emit('data', Buffer.alloc(MAX_STDOUT + 1, 65)), onKill: c => c.emit('close', null, 'SIGTERM') }) });
  assert.equal(result.failure, 'stdout-overflow'); assert.equal(result.stdout.length, MAX_STDOUT); assert.equal(result.stdoutBytes, MAX_STDOUT + 1); assert.equal(result.killReturned, true); assert.equal(result.remoteOutcomeUnknown, true);
  const stderr = await capture(Buffer.from('x'), [], {}, { spawn: spawnFor({ onEnd: c => c.stderr.emit('data', Buffer.alloc(MAX_STDERR + 1)), onKill: c => c.emit('close', null, 'SIGTERM') }) });
  assert.equal(stderr.stderr.length, MAX_STDERR); assert.equal(stderr.failure, 'stderr-overflow');
});

test('bounded cleanup releases only owned local handles without claiming child close', async () => {
  const timers = clock(), holder = {}; const pending = capture(Buffer.from('x'), [], {}, { timers, spawn: spawnFor({ killThrow: true }, holder) });
  await Promise.resolve(); timers.fire(TIMEOUT_MS); timers.fire(CLEANUP_MS); const result = await pending;
  assert.equal(result.sshCloseConfirmed, false); assert.equal(result.cleanupDeadlineExceeded, true); assert.equal(result.remoteOutcomeUnknown, true); assert.equal(result.killError, 'owned-child-signal-error'); assert.equal(holder.child.unrefCalls, 1);
  assert.ok(holder.child.stdin.destroyed && holder.child.stdout.destroyed && holder.child.stderr.destroyed);
  holder.child.emit('close', 0, null); assert.equal(result.sshCloseConfirmed, false);
});

test('actual isolated wrapper preserves source/public trust, no key bytes, exclusive report and no retry', async () => {
  const f = await fixture(); const result = await runQualification(f.input, f.overrides);
  assert.equal(result.evidence.observerKind, 'injected-offline-fixture'); assert.equal(result.evidence.result, 'observed-only'); assert.equal(result.evidence.computeAuthorized, false);
  assert.equal(digest(await readFile(path.join(result.directory, 'collector.py'))), SOURCE_SHA256);
  assert.equal(digest(await readFile(path.join(result.directory, 'stdout.capture'))), result.evidence.capture.stdoutCapturedSha256);
  assert.ok(!(await readFile(path.join(result.directory, 'evidence.json'), 'utf8')).includes('SYNTHETIC NON-KEY'));
  await assert.rejects(runQualification(f.input, f.overrides), { code: 'EEXIST' });
});

test('invalid bounded raw stdout is preserved while malformed reports fail held', async () => {
  const f = await fixture(); f.overrides.captureIO = { spawn: spawnFor({ onEnd: c => c.success(Buffer.from('NOT JSON\n')) }) };
  const result = await runQualification(f.input, f.overrides); assert.equal(result.evidence.result, 'held'); assert.equal(await readFile(path.join(result.directory, 'stdout.capture'), 'utf8'), 'NOT JSON\n'); assert.equal(result.evidence.observation, null);
});

test('changed known host during capture fails held and preserves actual capture', async () => {
  const f = await fixture(); f.overrides.captureIO = { spawn: spawnFor({ onEnd: c => { writeFile(path.join(f.root, KNOWN), 'changed').then(() => c.success()); } }) };
  const result = await runQualification(f.input, f.overrides); assert.equal(result.evidence.result, 'held'); assert.equal(result.evidence.failure, 'input-changed-during-capture');
});

test('link/hardlink and occupied output reject before any SSH spawn', async () => {
  const f = await fixture(); const holder = {}; f.overrides.captureIO = { spawn: spawnFor({}, holder) };
  const dest = path.join(f.root, BASE, 'runs', f.input.runId); await mkdir(dest, { recursive: true }); await assert.rejects(runQualification(f.input, f.overrides)); assert.equal(holder.child, undefined);
  const file = path.join(f.root, 'public.txt'); await writeFile(file, 'bounded'); await link(file, path.join(f.root, 'hard.txt')); await assert.rejects(readBound(file, 100), /single-link/);
  const actual = path.join(f.root, 'actual'); await mkdir(actual); const linked = path.join(f.root, 'linked'); await symlink(actual, linked, 'junction'); await writeFile(path.join(actual, 'x'), 'x'); await assert.rejects(readBound(path.join(linked, 'x'), 10), /linked-path/);
  assert.equal((await lstat(actual)).isDirectory(), true); await access(actual);
});
