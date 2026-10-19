import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const BASE = 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/new-boot-qualification';
export const SOURCE = 'engineering/fz3b/tools/new_boot_qualification.py';
export const SOURCE_SHA256 = '2f726969f7747613637270a2adf33fd0bd331b4a0a1eb4a1386ce538c25fa8d6';
export const SSH = 'C:/Windows/System32/OpenSSH/ssh.exe';
export const SERVICED_SSH = 'C:/Windows/WinSxS/amd64_openssh-client-components-onecore_31bf3856ad364e35_10.0.26100.9711_none_9b9fa477ccbca506/ssh.exe';
export const SYSTEM_SSH_APPROVAL = Object.freeze({
  sha256: '98d447730047f5df91373e852d057928a921c3d1e89938700ab656ba84b19dc8',
  bytes: 1256448, nlink: 2,
  reviewedSigner: 'Microsoft Windows', reviewedSignerThumbprint: '667BBA1E1F478221AA65DE4F75187A751B03A453',
  authenticodeEvidence: 'root-reviewed-Valid-not-revalidated-by-this-reader',
});
export const OLD_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df';
export const OBSERVED_BOOT = 'fbecfd68-ea21-498b-8ff3-f20237939e27';
export const PRIOR = 'output/hardware/2026-10-16-continuation/phase2-boot-only/1792223836631/evidence.json';
export const PRIOR_SHA256 = '535d124da0fce76387293359a8f4f2462f2566510649219c4bcb1293042bbeb9';
export const KNOWN = 'engineering/fz3b/product/resources/known_hosts';
export const KNOWN_SHA256 = 'c78d2c61323a893eb61bda9897ad3906db28d7eb28801c98c197480af62241d8';
export const KEY = '.runtime/fz3b-private/fz3b_acceptance_ed25519';
export const TIMEOUT_MS = 60000, CLEANUP_MS = 5000, MAX_STDOUT = 2 * 1048576, MAX_STDERR = 32768;
const SCOPE = 'fz3b-new-boot-readonly-qualification-v2';
const SHA = /^[a-f0-9]{64}$/;
const ID = /^newboot-[0-9]{13}-[a-f0-9]{6}$/;
const PIN_LINE = '169.254.220.254 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOABpElTgi2orYUllbAOEh5BnvKhMWUye+BT838FHUFJ\n';
const APP = '/root/fz3b-vision-console-20261009-001';
const UNITS = ['fz3b-vision-console.service', 'fz3b-pl-loader.service', 'fz3b-app-r5.service', 'fz3b-app-cpu-clock.service'];
const PACKAGE_ROOTS = ['/usr/lib/python3/dist-packages', '/usr/local/lib/python3.6/dist-packages', '/usr/local/lib/python3.6/site-packages'];
const PACKAGE_FILES = ['__init__.py', 'hazmat/primitives/asymmetric/ed25519.py', 'hazmat/bindings/_openssl.abi3.so', 'hazmat/bindings/_rust.abi3.so'];
export const FILE_PINS = Object.freeze({
  [APP + '/vision_app/board_agent.py']: '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
  [APP + '/vision_app/camera.py']: 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
  [APP + '/vision_app/image_boundary.py']: '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
  [APP + '/vision_app/protocol.py']: 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
  [APP + '/vision_app/upload_source.py']: 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
  [APP + '/config.json']: 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2',
  [APP + '/vision_app/semantic-contract.json']: '5f2f281ff7d3f92539a96f42728bd0dcdf5e70d07c98a00cff7f07fdb64aac87',
  '/root/workspace/network10-v10.5-pl-loader/fz3b_pl_loader.py': 'aaa7f5ba913252f7f298eee6f025615c3eccb1ef09928d1e6724caff9a64101d',
  '/root/rtl_optim-board-20261010/candidate008/rtl-loader-config.json': '10d5878bcc40278f47995453662099fdc5814ed42fbd68973c1161a5664c81c8',
  '/etc/systemd/system/fz3b-pl-loader.service.d/rtl-optim-retained.conf': 'b2520099c6d021a2697c716a293359c44fabae2e6cb00ee9b950f092c9bed553',
  '/etc/systemd/system/fz3b-vision-console.service': '1089e63bb0138e9c0f0c45f22ad8f95a74bcc92fca998fa541f37836844d599b',
  '/etc/systemd/system/fz3b-pl-loader.service': '337b24f9abc571275d9286334773de75cc427529fb34ee0b1bac45e0e3a0ead7',
  [APP + '/.forgedesk-ps-backups/ps-security-1792122514610/manifest.json']: 'a478fd7f12b15bc5a39d84e074d0d929b049a4a862c7a618c2d8edaffa9df1d1',
  '/root/rtl_optim-board-20261010/candidate008/cnn_rtl.bit': '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726',
});
const FILE_PATHS = [...Object.keys(FILE_PINS), ...['run.sh', 'vision_app/link_setup.py', 'vision_app/board_runtime.py', 'vision_app/r5_start.py', 'vision_app/r5_bridge.py', 'vision_app/cpu_clock_service.py'].map(v => APP + '/' + v), ...UNITS.slice(2).map(v => '/etc/systemd/system/' + v)].sort();
const DIAGNOSTIC_FIXED_PATHS = new Set(['/']);
for (const fixed of [...FILE_PATHS, '/proc/sys/kernel/random/boot_id', '/dev/network10_v10_signed40', ...['/.forgedesk-product-operations', '/.forgedesk-recovery-quarantine', '/.forgedesk-ps-transaction.lock'].map(v => APP + v), ...PACKAGE_ROOTS, ...PACKAGE_ROOTS.flatMap(root => PACKAGE_FILES.map(leaf => root + '/cryptography/' + leaf))]) {
  const parts = fixed.slice(1).split('/'); for (let end = 1; end <= parts.length; end++) DIAGNOSTIC_FIXED_PATHS.add('/' + parts.slice(0, end).join('/'));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const demand = (value, code) => { if (!value) throw new Error(code); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...expected].sort().join();
const canon = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const nat = (n, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(n) && n >= 0 && n <= maximum;
const bool = n => typeof n === 'boolean';
const same = (a, b) => canon(a) === canon(b);
function fileMetadata(v, maximum = 8 * 1048576, device = false) {
  demand(keys(v, ['device', 'inode', 'bytes', 'mode', 'uid', 'gid', 'nlink', ...(device ? ['rdev'] : [])]) && Object.values(v).every(n => nat(n)) && v.bytes <= maximum && v.mode <= 0o7777 && v.uid === 0 && (device ? v.nlink > 0 : v.nlink === 1 && (v.mode & 0o022) === 0), 'file-metadata-closed');
}
function pidIdentity(v, extra = []) { demand(keys(v, ['pid', 'startTicks', ...extra]) && nat(v.pid, 4194304) && v.pid > 1 && nat(v.startTicks) && v.startTicks > 0, 'pid-identity-closed'); }
function diagnosticPathClass(p) {
  if (DIAGNOSTIC_FIXED_PATHS.has(p)) return 'fixed-input';
  if (/^\/proc\/[1-9][0-9]{0,6}(?:\/(?:fd|stat|cmdline|net(?:\/tcp6?)?))?$/.test(p)) return 'proc-census';
  if (PACKAGE_ROOTS.some(root => p.startsWith(root + '/') && /^cryptography(?:-[0-9][A-Za-z0-9_.+-]{0,79})?\.(?:dist-info|egg-info)(?:\/(?:METADATA|PKG-INFO))?$/.test(p.slice(root.length + 1)))) return 'package-metadata';
  if (p.startsWith(APP + '/.forgedesk-product-operations/') && /^(?:active\.lock|[0-9a-f-]{36}\.json)$/.test(p.slice((APP + '/.forgedesk-product-operations/').length)) || p.startsWith(APP + '/.forgedesk-recovery-quarantine/') && /^(?:admission\.lock|active\.json|fz3b-recovery-v1-[0-9a-f-]{36}\.[a-z-]+\.json)$/.test(p.slice((APP + '/.forgedesk-recovery-quarantine/').length))) return 'guard-record';
  return null;
}
function diagnostic(v) {
  demand(keys(v, ['category', 'path', 'pathClass', 'stage', 'expectedKind', 'procPolicy', 'named', 'opened', 'identityDifferences', 'limitBytes', 'checks']) && ['directory-metadata', 'file-metadata', 'file-size-budget'].includes(v.category) && typeof v.path === 'string' && v.path.length <= 256 && diagnosticPathClass(v.path) !== null && v.pathClass === diagnosticPathClass(v.path) && ['named-entry', 'opened-entry'].includes(v.stage) && ['directory', 'regular-file'].includes(v.expectedKind) && bool(v.procPolicy), 'diagnostic-closed-allowlist');
  demand(v.expectedKind === (v.category === 'directory-metadata' ? 'directory' : 'regular-file') && (v.expectedKind === 'directory' ? v.limitBytes === null : nat(v.limitBytes, 16 * 1048576)), 'diagnostic-category-kind');
  for (const meta of [v.named, ...(v.opened === null ? [] : [v.opened])]) demand(keys(meta, ['device', 'inode', 'bytes', 'mode', 'uid', 'gid', 'nlink', 'fileType']) && Object.values(meta).every(n => nat(n)) && meta.mode <= 0o7777 && [0, 4096, 8192, 16384, 24576, 32768, 40960, 49152, 57344].includes(meta.fileType), 'diagnostic-metadata-closed');
  const labels = ['device', 'inode', 'bytes', 'mtime', 'ctime', 'mode', 'uid', 'gid', 'nlink'];
  demand(Array.isArray(v.identityDifferences) && v.identityDifferences.length <= labels.length && new Set(v.identityDifferences).size === v.identityDifferences.length && v.identityDifferences.every(k => labels.includes(k)) && (v.opened !== null || v.identityDifferences.length === 0) && (v.stage === 'opened-entry') === (v.opened !== null), 'diagnostic-identity-stage');
  const m = v.opened ?? v.named, c = v.checks;
  demand(keys(c, ['kindMatches', 'ownerRoot', 'noGroupOrOtherWrite', 'singleLink', 'withinSizeBudget', 'namedAndOpenedEqual']) && c.kindMatches === (m.fileType === (v.expectedKind === 'directory' ? 16384 : 32768)) && c.ownerRoot === (m.uid === 0) && c.noGroupOrOtherWrite === ((m.mode & 0o022) === 0) && c.singleLink === (v.expectedKind === 'regular-file' ? m.nlink === 1 : null) && c.withinSizeBudget === (v.limitBytes === null ? null : m.bytes <= v.limitBytes) && c.namedAndOpenedEqual === (v.opened === null ? null : v.identityDifferences.length === 0), 'diagnostic-check-facts');
  demand(!c.kindMatches || !v.procPolicy && (!c.ownerRoot || !c.noGroupOrOtherWrite) || c.singleLink === false || c.withinSizeBudget === false || c.namedAndOpenedEqual === false, 'diagnostic-needs-real-refusal');
}
function owner(v) { pidIdentity(v, ['fd']); demand(nat(v.fd, 1048576), 'fd-owner-closed'); }
function guardDirectory(v, kind) {
  const expectedPath = APP + (kind === 'journal' ? '/.forgedesk-product-operations' : '/.forgedesk-recovery-quarantine');
  demand(keys(v, ['path', 'state', 'records', 'inventorySha256']) && v.path === expectedPath && ['absent', 'held', 'observed-no-active-record'].includes(v.state) && Array.isArray(v.records) && v.records.length <= 259 && SHA.test(v.inventorySha256) && v.inventorySha256 === digest(Buffer.from(canon(v.records))), 'guard-closed');
  const seen = new Set();
  for (const r of v.records) {
    demand(keys(r, ['name', 'sha256', 'metadata', 'state']) && typeof r.name === 'string' && !seen.has(r.name) && SHA.test(r.sha256), 'guard-record-closed'); seen.add(r.name);
    const lock = r.name === (kind === 'journal' ? 'active.lock' : 'admission.lock');
    demand(lock || (kind === 'journal' ? UUID.test(r.name.slice(0, -5)) && r.name.endsWith('.json') : r.name === 'active.json' || /^fz3b-recovery-v1-[0-9a-f-]{36}\.[a-z-]+\.json$/.test(r.name)), 'guard-record-name');
    fileMetadata(r.metadata, 65536); demand(r.metadata.mode === 0o600, 'guard-record-mode');
    demand(lock ? r.state === 'empty-lock' && r.metadata.bytes === 0 : (kind === 'journal' ? ['terminal-history-observed', 'held-history'].includes(r.state) : ['active', 'unverified-history'].includes(r.state)), 'guard-record-state');
  }
  demand(v.state !== 'absent' || v.records.length === 0, 'absent-guard-has-records');
  demand(v.state !== 'observed-no-active-record' || v.records.every(r => ['empty-lock', 'terminal-history-observed'].includes(r.state)), 'unverified-guard-cannot-pass');
}
function dependencyRoot(r, i) {
    demand(keys(r, ['path', 'state', 'distributions', 'moduleFiles']) && r.path === PACKAGE_ROOTS[i] && ['absent', 'observed'].includes(r.state) && Array.isArray(r.distributions) && r.distributions.length <= 4 && Array.isArray(r.moduleFiles), 'dependency-root-closed');
    demand(r.state === 'absent' ? r.distributions.length === 0 && r.moduleFiles.length === 0 : r.moduleFiles.length === 4, 'dependency-root-state');
    const seen = new Set();
    for (const d of r.distributions) { demand(keys(d, ['directory', 'name', 'version', 'metadataSha256', 'metadata']) && /^cryptography(?:-[0-9][A-Za-z0-9_.+-]{0,79})?\.(?:dist-info|egg-info)$/.test(d.directory) && !seen.has(d.directory) && d.name === 'cryptography' && /^[A-Za-z0-9_.+-]{1,80}$/.test(d.version) && SHA.test(d.metadataSha256), 'dependency-distribution-closed'); seen.add(d.directory); fileMetadata(d.metadata, 65536); }
    for (const [j, f] of r.moduleFiles.entries()) { demand(keys(f, ['relativePath', 'state', 'metadata']) && f.relativePath === PACKAGE_FILES[j] && ['present', 'absent'].includes(f.state), 'dependency-module-closed'); if (f.state === 'present') fileMetadata(f.metadata, Number.MAX_SAFE_INTEGER); else demand(f.metadata === null, 'absent-module-has-metadata'); }
}
function census(v) {
  demand(keys(v, ['complete', 'processCount', 'fdCount', 'selfExcluded', 'sshAncestry', 'device', 'vanishedUnrelated', 'deviceOwners', 'inspectors', 'tcp', 'ipv6Absent', 'environmentRead', 'stdinRead', 'remainingArgumentsRead', 'deviceOpened']) && v.complete === true && ['deviceOpened', 'environmentRead', 'stdinRead', 'remainingArgumentsRead'].every(k => v[k] === false) && nat(v.processCount, 16384) && nat(v.fdCount, 262144) && bool(v.ipv6Absent), 'census-closed');
  pidIdentity(v.selfExcluded); fileMetadata(v.device, Number.MAX_SAFE_INTEGER, true);
  demand(Array.isArray(v.sshAncestry) && v.sshAncestry.length > 0 && v.sshAncestry.length <= 4 && v.sshAncestry.at(-1).exe === '/usr/sbin/sshd', 'ssh-ancestry-required');
  for (const item of v.sshAncestry) { pidIdentity(item, ['exe']); demand(typeof item.exe === 'string' && item.exe.startsWith('/') && item.exe.length <= 256, 'parent-exe-closed'); }
  for (const k of ['vanishedUnrelated', 'deviceOwners', 'inspectors', 'tcp']) demand(Array.isArray(v[k]) && v[k].length <= (k === 'deviceOwners' ? 262144 : 16384), 'census-array-budget');
  v.vanishedUnrelated.forEach(item => pidIdentity(item)); v.deviceOwners.forEach(owner); v.inspectors.forEach(item => pidIdentity(item));
  for (const r of v.tcp) { demand(keys(r, ['family', 'localPort', 'remotePort', 'loopback', 'state', 'inode', 'owners']) && ['tcp', 'tcp6'].includes(r.family) && nat(r.localPort, 65535) && nat(r.remotePort, 65535) && [8765, 8766].some(p => p === r.localPort || p === r.remotePort) && bool(r.loopback) && /^(?:0[1-9ABC])$/.test(r.state) && nat(r.inode) && Array.isArray(r.owners) && r.owners.length <= 262144, 'tcp-row-closed'); r.owners.forEach(owner); }
}
function relevantSnapshot(s) {
  const c = structuredClone(s.census); for (const k of ['processCount', 'fdCount', 'vanishedUnrelated']) delete c[k];
  const sort = a => a.sort((x, y) => canon(x) < canon(y) ? -1 : canon(x) > canon(y) ? 1 : 0);
  sort(c.deviceOwners); sort(c.inspectors); c.tcp.forEach(r => sort(r.owners)); sort(c.tcp); return { ...s, census: c };
}

export function parseArgs(argv) {
  demand(Array.isArray(argv) && argv.length === 5 && argv[0] === '--run-id' && ID.test(argv[1]) && argv[2] === '--plan-sha256' && SHA.test(argv[3]) && argv[4] === '--execute-readonly', 'exact-readonly-arguments-required');
  return { runId: argv[1], planSha256: argv[3] };
}

async function plain(filename) {
  const absolute = path.resolve(filename), prefix = path.parse(absolute).root;
  let current = prefix;
  for (const part of absolute.slice(prefix.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const info = await lstat(current);
    demand(!info.isSymbolicLink(), 'linked-path-forbidden');
  }
  demand(path.resolve(await realpath(absolute)).toLowerCase() === absolute.toLowerCase(), 'reparse-path-forbidden'); return absolute;
}
function fileIdentity(s) { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`; }
export async function readBound(filename, maximum) {
  await plain(filename); const named = await lstat(filename);
  demand(named.isFile() && named.nlink === 1 && named.size > 0 && named.size <= maximum, 'regular-single-link-budget-required');
  const handle = await open(filename, 'r');
  try {
    const before = await handle.stat(); demand(fileIdentity(named) === fileIdentity(before), 'file-replaced-before-open');
    const buffer = Buffer.alloc(maximum + 1); let used = 0;
    while (used <= maximum) { const { bytesRead } = await handle.read(buffer, used, maximum + 1 - used, used); if (!bytesRead) break; used += bytesRead; }
    demand(used <= maximum, 'file-grew-beyond-budget'); const raw = buffer.subarray(0, used);
    const after = await handle.stat(); await plain(filename);
    demand(raw.length === after.size && fileIdentity(before) === fileIdentity(after) && fileIdentity(after) === fileIdentity(await lstat(filename)), 'file-changed-during-read'); return raw;
  } finally { await handle.close(); }
}

/** A single closed exception for the reviewed Windows servicing pair, never generic input. */
export async function readApprovedSystemSsh(injected = {}) {
  demand(injected && typeof injected === 'object' && Object.keys(injected).every(k => ['lstat', 'realpath', 'open'].includes(k)), 'system-ssh-fixed-reader-no-path-override');
  const io = { lstat, realpath, open, ...injected };
  async function fixedPlain(filename) {
    const absolute = path.resolve(filename), prefix = path.parse(absolute).root; let current = prefix;
    for (const part of absolute.slice(prefix.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); demand(!(await io.lstat(current, { bigint: true })).isSymbolicLink(), 'system-ssh-linked-path'); }
    demand(path.resolve(await io.realpath(absolute)).toLowerCase() === absolute.toLowerCase(), 'system-ssh-reparse-path');
    return absolute;
  }
  const primary = await fixedPlain(SSH), servicing = await fixedPlain(SERVICED_SSH);
  const named = await io.lstat(primary, { bigint: true }), pair = await io.lstat(servicing, { bigint: true });
  const identity = s => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs, s.nlink].join(':');
  const approved = s => s.isFile() && ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(k => typeof s[k] === 'bigint') && s.nlink === BigInt(SYSTEM_SSH_APPROVAL.nlink) && s.size === BigInt(SYSTEM_SSH_APPROVAL.bytes);
  demand(approved(named) && approved(pair) && named.dev === pair.dev && named.ino === pair.ino && identity(named) === identity(pair), 'system-ssh-exact-reviewed-hardlink-pair');
  const handles = [];
  try {
    const a = await io.open(primary, 'r'); handles.push(a); const b = await io.open(servicing, 'r'); handles.push(b);
    const before = await a.stat({ bigint: true }), sideBefore = await b.stat({ bigint: true });
    demand(approved(before) && approved(sideBefore) && identity(before) === identity(named) && identity(sideBefore) === identity(before), 'system-ssh-replaced-before-open');
    const buffer = Buffer.alloc(SYSTEM_SSH_APPROVAL.bytes + 1); let used = 0;
    while (used <= SYSTEM_SSH_APPROVAL.bytes) { const { bytesRead } = await a.read(buffer, used, buffer.length - used, used); if (!bytesRead) break; used += bytesRead; }
    demand(used === SYSTEM_SSH_APPROVAL.bytes, 'system-ssh-read-byte-budget');
    const after = await a.stat({ bigint: true }), sideAfter = await b.stat({ bigint: true }); await fixedPlain(SSH); await fixedPlain(SERVICED_SSH);
    demand([after, sideAfter, await io.lstat(primary, { bigint: true }), await io.lstat(servicing, { bigint: true })].every(s => approved(s) && identity(s) === identity(before)), 'system-ssh-changed-during-read');
    const bytes = buffer.subarray(0, used); demand(digest(bytes) === SYSTEM_SSH_APPROVAL.sha256, 'system-ssh-reviewed-byte-pin');
    return { bytes, verification: { ...SYSTEM_SSH_APPROVAL, systemPath: SSH, servicingPath: SERVICED_SSH,
      sameFileIdentityVerified: true, stableHandlesAndNamedPaths: true, observerKind: Object.keys(injected).length ? 'injected-offline-fixture' : 'fixed-system-file-read' } };
  } finally {
    const closed = await Promise.allSettled(handles.reverse().map(handle => handle.close()));
    demand(closed.every(v => v.status === 'fulfilled'), 'system-ssh-local-handle-close-failed');
  }
}
async function exclusiveDirectory(root, relative) {
  const absolute = path.resolve(root, relative); demand(absolute.startsWith(path.resolve(root) + path.sep), 'output-outside-project');
  const parent = path.dirname(absolute); let current = path.resolve(root); await plain(current);
  for (const part of path.relative(current, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    demand((await lstat(current)).isDirectory(), 'output-parent-not-directory'); await plain(current);
  }
  await mkdir(absolute); await plain(absolute); return absolute;
}
async function writeExclusive(filename, bytes) {
  await plain(path.dirname(filename)); const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  demand(digest(await readBound(filename, Math.max(1, bytes.length))) === digest(bytes), 'output-readback-mismatch');
}

export function validatePrior(raw) {
  demand(digest(raw) === PRIOR_SHA256, 'prior-observation-actual-byte-pin'); const v = JSON.parse(raw.toString('utf8'));
  demand(v.sourceSha256 === 'e2cba40db823f1617022550028cbb5fe8f02b23070dd16f2b2df685d87d8ec2d' && v.sourceUnchanged === true && v.exitCode === 0 && v.signal === null && v.failure === null && v.sshCloseConfirmed === true && v.remoteOutcomeUnknown === false && v.killAttempted === false && v.cleanupDeadlineExceeded === false, 'prior-transport-not-exact');
  demand(keys(v.observation, ['deviceQualified', 'observedBootId', 'quiescenceProved', 'releaseAuthorized', 'schemaVersion', 'scope', 'secondBootId', 'stableAcrossTwoReads']) && v.observation.schemaVersion === 1 && v.observation.scope === 'boot-id-only-readonly-diagnostic' && v.observation.observedBootId === OBSERVED_BOOT && v.observation.secondBootId === OBSERVED_BOOT && v.observation.stableAcrossTwoReads === true && v.observation.deviceQualified === false && v.observation.quiescenceProved === false && v.observation.releaseAuthorized === false, 'prior-observation-not-exact'); return v;
}
export function validatePlan(raw, input) {
  demand(digest(raw) === input.planSha256, 'reviewed-plan-byte-hash-mismatch'); const p = JSON.parse(raw.toString('utf8'));
  demand(Buffer.from(JSON.stringify(p, null, 2) + '\n').equals(raw), 'plan-canonical-encoding');
  demand(keys(p, ['schemaVersion', 'scope', 'runId', 'expectedHistoricalBootId', 'expectedObservedBootId', 'priorObservationPath', 'priorObservationSha256', 'collectorSourceSha256', 'nonce']) && p.schemaVersion === 1 && p.scope === 'fixed-newboot-observation-plan-v1' && p.runId === input.runId && p.expectedHistoricalBootId === OLD_BOOT && p.expectedObservedBootId === OBSERVED_BOOT && p.priorObservationPath === PRIOR && p.priorObservationSha256 === PRIOR_SHA256 && p.collectorSourceSha256 === SOURCE_SHA256 && SHA.test(p.nonce) && p.nonce !== '0'.repeat(64), 'closed-root-plan-required'); return p;
}
export function sshEnvironment(environment) {
  const found = new Map();
  for (const [name, value] of Object.entries(environment)) {
    const upper = name.toUpperCase();
    if (!['SYSTEMROOT', 'WINDIR', 'PROGRAMDATA', 'TEMP', 'TMP'].includes(upper) || typeof value !== 'string') continue;
    demand(!found.has(upper) || found.get(upper) === value, 'ambiguous-environment-key'); found.set(upper, value);
  }
  demand(found.get('SYSTEMROOT')?.replaceAll('\\', '/').toLowerCase() === 'c:/windows' && found.get('PROGRAMDATA') && found.get('TEMP') && found.get('TMP'), 'genuine-windows-environment-required');
  demand(!found.has('WINDIR') || found.get('WINDIR').replaceAll('\\', '/').toLowerCase() === 'c:/windows', 'unexpected-windir');
  return { SystemRoot: found.get('SYSTEMROOT'), ...(found.has('WINDIR') ? { WINDIR: found.get('WINDIR') } : {}), ProgramData: found.get('PROGRAMDATA'), TEMP: found.get('TEMP'), TMP: found.get('TMP'), PATH: 'C:\\Windows\\System32\\OpenSSH;C:\\Windows\\System32' };
}
export function sshArgs(known, key) {
  return ['-F', 'NUL', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`, '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'NumberOfPasswordPrompts=0', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'PubkeyAcceptedAlgorithms=ssh-ed25519', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none', '-o', 'PermitLocalCommand=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'RequestTTY=no', '-o', 'ConnectTimeout=6', '-o', 'ConnectionAttempts=1', '-i', key, 'root@169.254.220.254', '/usr/bin/python3 -I -S -B -'];
}

const STAGES = ['boot-before', 'files', 'services', 'guards', 'census', 'dependencies', 'boot-after'];
const BOOTSTRAP_MODULES = ['datetime', 'hashlib', 'json', 'os', 're', 'select', 'stat', 'subprocess', 'sys', 'time'];
const BOOTSTRAP_ORIGINS = Object.fromEntries(BOOTSTRAP_MODULES.map(name => [name, ['.py', '.pyc'].map(ext => '/usr/lib/python3.6/' + (name === 'json' ? 'json/__init__' : name) + ext)]));
BOOTSTRAP_ORIGINS.select = ['/usr/lib/python3.6/lib-dynload/select.cpython-36m-aarch64-linux-gnu.so'];
for (const fixed of ['/usr/bin/python3', '/usr/bin/python3.6', ...Object.values(BOOTSTRAP_ORIGINS).flat()]) { const p = fixed.slice(1).split('/'); for (let i = 1; i <= p.length; i++) DIAGNOSTIC_FIXED_PATHS.add('/' + p.slice(0, i).join('/')); }
const GLOBAL_ERRORS = ['collector-deadline', 'aggregate-read-budget', 'service-show-deadline', 'service-show-byte-budget', 'TimeoutExpired', 'MemoryError'];
const stageIds = stage => ({ 'boot-before': ['boot'], files: FILE_PATHS, services: UNITS, guards: ['journal', 'psLease', 'quarantine'], census: ['system'], dependencies: PACKAGE_ROOTS, 'boot-after': ['boot'] })[stage];
function serviceObservation(service, i) {
  demand(keys(service, ['unit', 'activeState', 'subState', 'mainPid', 'startTicks', 'fragmentMatches', 'dropInsMatch', 'execStartMatches', 'execStartSha256', 'propertiesSha256', 'managerCurrent', 'workingDirectoryMatches', 'process']) && service.unit === UNITS[i] && ['active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading'].includes(service.activeState) && /^[a-z-]{1,40}$/.test(service.subState) && nat(service.mainPid, 4194304) && (service.startTicks === null || nat(service.startTicks) && service.startTicks > 0) && SHA.test(service.execStartSha256) && SHA.test(service.propertiesSha256) && ['fragmentMatches', 'dropInsMatch', 'execStartMatches', 'managerCurrent', 'workingDirectoryMatches'].every(k => bool(service[k])), 'service-observation-shape');
  if (service.mainPid > 1) { const p = service.process; pidIdentity(p, ['exe', 'prefixSha256', 'matchesExpectedPrefix', 'workingDirectoryMatches']); demand(p.pid === service.mainPid && p.startTicks === service.startTicks && typeof p.exe === 'string' && p.exe.length <= 256 && p.exe.startsWith('/') && SHA.test(p.prefixSha256) && bool(p.matchesExpectedPrefix) && bool(p.workingDirectoryMatches), 'actual-service-process-shape'); }
  else demand(service.mainPid === 0 && service.startTicks === null && service.process === null, 'service-pid-zero-shape');
}
function inputData(stage, id, value) {
  if (stage.startsWith('boot-')) { demand(typeof value === 'string' && UUID.test(value), 'boot-id-closed'); return; }
  if (stage === 'files') { const f = value, expected = FILE_PINS[id] ?? null; demand(keys(f, ['path', 'sha256', 'expectedSha256', 'matchesPin', 'metadata']) && f.path === id && SHA.test(f.sha256) && f.expectedSha256 === expected && f.matchesPin === (expected === null ? null : f.sha256 === expected), 'file-observation-shape'); fileMetadata(f.metadata, id.endsWith('/cnn_rtl.bit') ? 8 * 1048576 : 262144); return; }
  if (stage === 'services') { serviceObservation(value, UNITS.indexOf(id)); return; }
  if (stage === 'guards') {
    if (id !== 'psLease') { guardDirectory(value, id); return; }
    demand(keys(value, ['path', 'state', 'sha256', 'metadata']) && value.path === APP + '/.forgedesk-ps-transaction.lock' && ['absent', 'present-held'].includes(value.state), 'lease-closed');
    if (value.state === 'absent') demand(value.sha256 === null && value.metadata === null, 'lease-absence-not-exact'); else { demand(SHA.test(value.sha256), 'lease-sha'); fileMetadata(value.metadata, 65536); } return;
  }
  if (stage === 'census') { census(value); return; }
  dependencyRoot(value, PACKAGE_ROOTS.indexOf(id));
}
function bootstrapData(value) {
  demand(keys(value, ['flags', 'pythonVersion', 'reportedExecutableSha256', 'executable', 'resolvedExecutable', 'origins', 'trust', 'cryptographicAttestation', 'transitiveOriginsVerified', 'issues']) && value.trust === 'fixed-path-observation-only' && value.cryptographicAttestation === false && value.transitiveOriginsVerified === false && (value.reportedExecutableSha256 === null || SHA.test(value.reportedExecutableSha256)) && keys(value.flags, ['isolated', 'noSite', 'dontWriteBytecode', 'ignoreEnvironment', 'noUserSite']) && Object.values(value.flags).every(n => nat(n, 1)) && Array.isArray(value.pythonVersion) && value.pythonVersion.length === 3 && value.pythonVersion.every(n => nat(n, 1000)) && Array.isArray(value.origins) && value.origins.length <= BOOTSTRAP_MODULES.length && Array.isArray(value.issues) && value.issues.length <= 12 && value.issues.every(v => /^[a-z-]{1,100}$/.test(v)), 'bootstrap-closed');
  function originFile(f, expected) {
    demand(keys(f, ['path', 'metadata', 'linkTarget']) && f.path === expected && keys(f.metadata, ['device', 'inode', 'bytes', 'mode', 'uid', 'gid', 'nlink', 'fileType']) && Object.values(f.metadata).every(n => nat(n)), 'bootstrap-file-closed');
    const m = f.metadata;
    if (expected === '/usr/bin/python3' && m.fileType === 40960) demand(m.uid === 0 && m.nlink === 1 && ['python3.6', '/usr/bin/python3.6'].includes(f.linkTarget), 'bootstrap-fixed-link');
    else { demand(f.linkTarget === null && m.fileType === 32768, 'bootstrap-regular-file'); const { fileType, ...plain } = m; fileMetadata(plain, Number.MAX_SAFE_INTEGER); }
  }
  if (value.executable !== null) originFile(value.executable, '/usr/bin/python3');
  else demand(value.resolvedExecutable === null && value.origins.length === 0, 'bootstrap-no-unbound-resolution');
  if (value.resolvedExecutable !== null) originFile(value.resolvedExecutable, value.executable?.linkTarget !== null ? '/usr/bin/python3.6' : '/usr/bin/python3');
  for (const [i, v] of value.origins.entries()) {
    demand(keys(v, ['module', 'kind', 'reportedOriginSha256', 'file']) && v.module === BOOTSTRAP_MODULES[i] && ['built-in', 'fixed-file', 'untrusted'].includes(v.kind), 'bootstrap-origin-closed');
    if (v.kind === 'built-in') demand(v.reportedOriginSha256 === null && v.file === null, 'bootstrap-builtin');
    else if (v.kind === 'untrusted') demand(SHA.test(v.reportedOriginSha256) && v.file === null && value.issues.includes('stdlib-origin-not-allowlisted'), 'bootstrap-untrusted-origin');
    else { demand(v.file && BOOTSTRAP_ORIGINS[v.module].includes(v.file.path) && v.reportedOriginSha256 === digest(Buffer.from(v.file.path)), 'bootstrap-fixed-origin'); originFile(v.file, v.file.path); }
  }
  const valid = value.issues.length === 0;
  if (valid) demand(Object.values(value.flags).every(n => n === 1) && value.pythonVersion[0] === 3 && value.pythonVersion[1] === 6 && value.reportedExecutableSha256 === digest(Buffer.from('/usr/bin/python3')) && value.executable !== null && value.resolvedExecutable !== null && value.origins.length === 10 && value.origins.every(v => v.kind !== 'untrusted'), 'bootstrap-untrusted-cannot-pass');
  return valid;
}
function core(scan) {
  const stages = Object.fromEntries(scan.stages.map(s => [s.id, s]));
  if (['boot-before', 'files', 'services', 'guards', 'census'].some(k => stages[k].state !== 'complete')) return null;
  return { bootId: stages['boot-before'].items[0].data, files: stages.files.items.map(v => v.data), services: stages.services.items.map(v => v.data), guards: Object.fromEntries(stages.guards.items.map(v => [v.id, v.data])), census: stages.census.items[0].data, dependencies: null };
}
function cleanCore(s) {
  return s.files.every(f => f.matchesPin !== false) && s.services.every((v, i) => v.activeState === 'active' && (v.subState === 'running' && v.mainPid > 1 || i === 2 && v.subState === 'exited' && v.mainPid === 0) && ['fragmentMatches', 'dropInsMatch', 'execStartMatches', 'managerCurrent', 'workingDirectoryMatches'].every(k => v[k]) && (v.process === null || v.process.matchesExpectedPrefix && v.process.workingDirectoryMatches)) && s.guards.psLease.state === 'absent' && ['journal', 'quarantine'].every(k => s.guards[k].state !== 'held') && s.census.deviceOwners.length === 0 && s.census.inspectors.length === 0 && s.census.tcp.every(r => r.state === '0A' ? [8765, 8766].includes(r.localPort) && r.loopback && r.owners.length > 0 && r.owners.every(o => o.pid === s.services[0].mainPid && o.startTicks === s.services[0].startTicks) : ['06', '07'].includes(r.state));
}
export function validateReport(raw, expectedBoot = OBSERVED_BOOT) {
  demand(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= MAX_STDOUT && raw.every(byte => byte < 128), 'report-byte-budget-or-encoding');
  const r = JSON.parse(raw.toString('utf8')); demand(Buffer.from(canon(r) + '\n').equals(raw), 'report-canonical-single-json');
  demand(keys(r, ['schemaVersion', 'scope', 'result', 'startedAt', 'completedAt', 'historicalBootId', 'historicalProfileSha256', 'resourceManifestSha256', 'profileAdopted', 'computeAuthorized', 'releaseAuthorized', 'noApplicationImport', 'noDeviceOpen', 'noRPC', 'noServiceActions', 'noIntentionalRemoteWrites', 'bootstrap', 'dependencyScope', 'scans', 'stable', 'relevantCoreStableObserved', 'issues', 'globalStop', 'unrelatedChurn', 'unverified', 'totalReadBytes']), 'report-closed-schema');
  demand(keys(r.dependencyScope, ['scope', 'applicationImported', 'providerImported', 'nativeLoaded', 'providerFunctionVerified', 'ed25519Verified']) && r.dependencyScope.scope === 'fixed-cryptography-metadata-only' && ['applicationImported', 'providerImported', 'nativeLoaded', 'providerFunctionVerified', 'ed25519Verified'].every(k => r.dependencyScope[k] === false), 'dependency-not-provider-proof');
  demand(r.schemaVersion === 2 && r.scope === SCOPE && ['observed-only', 'held'].includes(r.result) && r.historicalBootId === OLD_BOOT && r.historicalProfileSha256 === '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd' && r.resourceManifestSha256 === 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07', 'report-policy-binding');
  for (const k of ['profileAdopted', 'computeAuthorized', 'releaseAuthorized']) demand(r[k] === false, 'report-cannot-authorize');
  for (const k of ['noApplicationImport', 'noDeviceOpen', 'noRPC', 'noServiceActions', 'noIntentionalRemoteWrites']) demand(r[k] === true, 'report-side-effect-claim');
  demand(Array.isArray(r.issues) && r.issues.length <= 100 && r.issues.every(v => /^[A-Za-z0-9_.-]{1,100}$/.test(v)) && Array.isArray(r.unverified) && r.unverified.length <= 16 && r.unverified.every(v => /^[A-Za-z0-9_.-]{1,100}$/.test(v)) && bool(r.stable) && bool(r.relevantCoreStableObserved) && (r.globalStop === null || /^[A-Za-z0-9_.-]{1,100}$/.test(r.globalStop)) && nat(r.totalReadBytes, 16 * 1048576 + 65536), 'report-budget');
  const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v)); demand(time(r.startedAt) && time(r.completedAt) && Date.parse(r.completedAt) >= Date.parse(r.startedAt), 'report-time');
  let counter = 0, stopped = false;
  function item(v, id, action) {
    demand(keys(v, ['id', 'state', 'data', 'error', 'diagnostics', 'blockedBy', 'readBytesBefore', 'readBytesAfter']) && v.id === id && ['observed', 'refused', 'unavailable', 'not-attempted'].includes(v.state) && nat(v.readBytesBefore) && nat(v.readBytesAfter, 16 * 1048576 + 65536) && v.readBytesBefore === counter && v.readBytesAfter >= counter && Array.isArray(v.diagnostics) && v.diagnostics.length <= 1 && (v.error === null || /^[A-Za-z0-9_.-]{1,100}$/.test(v.error)), 'stage-item-closed');
    counter = v.readBytesAfter;
    if (v.state === 'observed') { demand(!stopped && v.error === null && v.blockedBy === null && !v.diagnostics.length, 'observed-after-stop-or-error'); action(v.data); }
    else { demand(v.data === null && v.error !== null && (v.state !== 'not-attempted' || v.readBytesAfter === v.readBytesBefore), 'failed-item-no-empty-success'); for (const d of v.diagnostics) { diagnostic(d); demand(d.category === v.error, 'diagnostic-error-binding'); } }
    if (GLOBAL_ERRORS.includes(v.error) || v.readBytesAfter > 16 * 1048576) stopped = true;
  }
  let bootstrapOK = false;
  demand(r.bootstrap.blockedBy === null, 'bootstrap-cannot-be-ancestor-blocked');
  item(r.bootstrap, 'bootstrap', value => { bootstrapOK = bootstrapData(value); });
  if (!bootstrapOK || r.bootstrap.state !== 'observed') stopped = true;
  demand(Array.isArray(r.scans) && r.scans.length === 2, 'exact-two-scans');
  for (const [i, scan] of r.scans.entries()) {
    demand(keys(scan, ['ordinal', 'startedAt', 'completedAt', 'stages']) && scan.ordinal === i + 1 && time(scan.startedAt) && time(scan.completedAt) && Date.parse(scan.completedAt) >= Date.parse(scan.startedAt) && Array.isArray(scan.stages) && same(scan.stages.map(s => s.id), STAGES), 'scan-closed');
    for (const stage of scan.stages) {
      demand(keys(stage, ['id', 'state', 'items']) && Array.isArray(stage.items) && same(stage.items.map(v => v.id), stageIds(stage.id)), 'stage-fixed-inputs');
      for (const v of stage.items) {
        item(v, v.id, data => inputData(stage.id, v.id, data));
        if (v.blockedBy !== null) { const previous = stage.items.slice(0, stage.items.indexOf(v)).find(p => p.id === v.blockedBy); demand(stage.id === 'dependencies' && v.state === 'not-attempted' && v.error === 'unsafe-ancestor-not-traversed' && previous?.diagnostics.some(d => d.category === 'directory-metadata' && d.stage === 'named-entry' && !d.procPolicy && v.id.startsWith(d.path + '/')), 'blocked-ancestor-binding'); }
        else demand(v.state !== 'not-attempted' || stopped && v.error === 'global-stop', 'unjustified-not-attempted');
      }
      demand(stage.state === (stage.items.every(v => v.state === 'observed') ? 'complete' : 'partial'), 'stage-completeness-not-self-reported');
    }
  }
  demand(counter === r.totalReadBytes && (!stopped || r.globalStop !== null && r.result === 'held'), 'aggregate-counter-or-stop-binding');
  const cores = r.scans.map(core), fences = r.scans.flatMap(s => s.stages.filter(v => v.id.startsWith('boot-')).flatMap(v => v.items.filter(x => x.state === 'observed').map(x => x.data)));
  const bootStable = fences.length === 4 && new Set(fences).size === 1, coreStable = cores.every(Boolean) && bootStable && same(relevantSnapshot(cores[0]), relevantSnapshot(cores[1]));
  demand(r.relevantCoreStableObserved === coreStable, 'relevant-core-stability');
  const complete = r.scans.every(s => s.stages.every(v => v.state === 'complete')), depsStable = r.scans.every(s => s.stages[5].state === 'complete') && same(r.scans[0].stages[5].items.map(v => v.data), r.scans[1].stages[5].items.map(v => v.data));
  demand(r.stable === (complete && coreStable && depsStable), 'complete-stability-binding');
  if (cores.every(Boolean) && bootStable) { const [a, b] = cores.map(c => c.census); demand(same(r.unrelatedChurn, { processCountBefore: a.processCount, processCountAfter: b.processCount, fdCountBefore: a.fdCount, fdCountAfter: b.fdCount, vanishedClassifiedNonInspectors: a.vanishedUnrelated.length + b.vanishedUnrelated.length }), 'churn-binding'); }
  else demand(r.unrelatedChurn === null, 'incomplete-core-churn');
  if (r.result === 'observed-only') demand(bootstrapOK && r.stable && r.globalStop === null && r.issues.length === 0 && cores.every(cleanCore) && fences.every(id => id === expectedBoot), 'unexpected-observed-boot-or-incomplete');
  else demand(r.issues.length > 0, 'held-needs-reason');
  const pending = [[r, 0]]; let count = 0;
  while (pending.length) { const [v, depth] = pending.pop(); demand(++count <= 50000 && depth <= 24, 'report-structure-budget'); if (v && typeof v === 'object') pending.push(...Object.values(v).map(c => [c, depth + 1])); else if (typeof v === 'string') demand(v.length <= 512 && !/[\u0000-\u001f]/.test(v), 'report-string-budget'); else if (typeof v === 'number') demand(nat(v), 'report-number-budget'); }
  return r;
}

/** Only this owned child handle can be signalled; no retries, no remote quiet claim. */
export async function capture(script, args, environment, io = {}) {
  const spawnChild = io.spawn ?? spawn, timers = io.timers ?? { setTimeout, clearTimeout };
  return new Promise(resolve => {
    const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
    let child, done = false, timer, cleanup, failure = null, closeConfirmed = false, exitObserved = false, exitCode = null, signal = null;
    let spawnObserved = false, stdinFinished = false, exitEventCode = null, exitEventSignal = null, cleanupDeadlineExceeded = false, localHandlesDetached = false;
    let killAttempted = false, killReturned = null, killError = null;
    const complete = () => {
      if (done) return; done = true; timers.clearTimeout(timer); timers.clearTimeout(cleanup);
      resolve({ stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr), stdoutBytes: sizes.stdout, stderrBytes: sizes.stderr,
        failure, spawnObserved, stdinFinished, sshCloseConfirmed: closeConfirmed, sshExitObserved: exitObserved, exitCode, signal, exitEventCode, exitEventSignal,
        cleanupDeadlineExceeded, localHandlesDetached,
        localSshPid: child?.pid ?? null, killAttempted, killReturned, killError, cleanupConfirmed: closeConfirmed,
        stdoutCapturedBytes: Buffer.concat(chunks.stdout).length, stderrCapturedBytes: Buffer.concat(chunks.stderr).length,
        remoteOutcomeUnknown: !!failure || !spawnObserved || !stdinFinished || !exitObserved || !closeConfirmed || exitCode !== 0 || signal !== null || exitEventCode !== exitCode || exitEventSignal !== signal });
    };
    const fail = code => {
      if (done) return; failure ??= code;
      if (!cleanup) cleanup = timers.setTimeout(() => {
        cleanupDeadlineExceeded = true;
        // Releasing only our pipe handles is not evidence the child exited.
        for (const pipe of [child?.stdin, child?.stdout, child?.stderr]) { try { pipe?.destroy(); } catch { /* outcome remains unknown */ } }
        try { child?.unref(); localHandlesDetached = true; } catch { /* no cleanup claim */ }
        complete();
      }, CLEANUP_MS);
      if (!killAttempted && child) { killAttempted = true; try { killReturned = child.kill(); } catch { killError = 'owned-child-signal-error'; } }
    };
    try { child = spawnChild(SSH, args, { cwd: ROOT, env: environment, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { failure = 'ssh-spawn-threw'; complete(); return; }
    child.on('spawn', () => { spawnObserved = true; });
    child.on('error', () => fail('ssh-process-error')); child.on('exit', (code, sig) => { exitObserved = true; exitEventCode = code; exitEventSignal = sig; });
    child.on('close', (code, sig) => { if (done) return; closeConfirmed = true; exitCode = Number.isInteger(code) ? code : null; signal = typeof sig === 'string' ? sig : null; if (exitCode !== 0 || signal) failure ??= 'ssh-close-not-success'; queueMicrotask(complete); });
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', value => { if (done) return; const bytes = Buffer.from(value), maximum = stream === 'stdout' ? MAX_STDOUT : MAX_STDERR, remaining = Math.max(0, maximum - sizes[stream]); sizes[stream] += bytes.length; if (remaining) chunks[stream].push(bytes.subarray(0, remaining)); if (sizes[stream] > maximum) fail(stream + '-overflow'); });
      child[stream].on('error', () => fail('ssh-' + stream + '-error'));
    }
    child.stdin.on('error', () => fail('ssh-stdin-error'));
    child.stdin.on('finish', () => { stdinFinished = true; });
    timer = timers.setTimeout(() => fail('ssh-deadline'), TIMEOUT_MS);
    try { child.stdin.end(script); } catch { fail('ssh-stdin-threw'); }
  });
}

export async function runQualification(input, overrides = {}) {
  const root = overrides.root ?? ROOT, platform = overrides.platform ?? process.platform;
  demand(ID.test(input.runId) && SHA.test(input.planSha256) && platform === 'win32', 'windows-root-reviewed-plan-required');
  const environment = sshEnvironment(overrides.environment ?? process.env);
  const source = await readBound(path.join(root, SOURCE), 262144); demand(digest(source) === SOURCE_SHA256, 'reviewed-collector-source-changed');
  const priorRaw = await readBound(path.join(root, PRIOR), 65536); validatePrior(priorRaw);
  const planRaw = await readBound(path.join(root, BASE, 'plans', input.runId + '.json'), 16384), plan = validatePlan(planRaw, input);
  const known = path.join(root, KNOWN), knownRaw = await readBound(known, 512); demand(digest(knownRaw) === KNOWN_SHA256 && knownRaw.toString('ascii') === PIN_LINE, 'known-host-continuity-pin');
  const key = path.join(root, KEY); await plain(key); const keyInfo = await lstat(key); demand(keyInfo.isFile() && keyInfo.nlink === 1 && keyInfo.size >= 128 && keyInfo.size <= 16384, 'approved-key-path-metadata');
  const binary = overrides.readExecutable ? { bytes: await overrides.readExecutable(SSH), verification: null } : await readApprovedSystemSsh();
  const directory = await exclusiveDirectory(root, path.join(BASE, 'runs', input.runId));
  const evidence = { schemaVersion: 1, scope: 'root-newboot-readonly-capture-v1', observerKind: Object.keys(overrides).length ? 'injected-offline-fixture' : 'native-owned-ssh',
    runId: input.runId, planSha256: input.planSha256, nonce: plan.nonce, remoteNonceEchoed: false, sourceSha256: digest(source),
    priorObservationSha256: digest(priorRaw), sshExecutable: SSH, sshExecutableSha256: digest(binary.bytes), systemBinaryApproval: binary.verification, knownHostsSha256: digest(knownRaw),
    hostKeyTrust: 'strict-existing-TOFU-continuity-not-chip-attestation', keyReference: KEY, environmentKeys: Object.keys(environment).sort(),
    expectedHistoricalBootId: OLD_BOOT, expectedObservedBootId: plan.expectedObservedBootId, profileAdopted: false, computeAuthorized: false,
    startedAt: new Date().toISOString(), completedAt: null, result: 'held', capture: null, observation: null, failure: null };
  await writeExclusive(path.join(directory, 'plan.json'), planRaw); await writeExclusive(path.join(directory, 'collector.py'), source);
  try {
    const captured = await capture(source, sshArgs(known, key), environment, overrides.captureIO);
    const { stdout, stderr, ...metadata } = captured;
    evidence.capture = { ...metadata, stdoutCapturedSha256: digest(stdout), stderrCapturedSha256: digest(stderr), stderrRedacted: stderr.length ? '[SSH_STDERR_OMITTED]' : '' };
    if (stdout.length) await writeExclusive(path.join(directory, 'stdout.capture'), stdout);
    demand(!captured.remoteOutcomeUnknown && captured.sshCloseConfirmed && captured.exitCode === 0 && captured.signal === null && captured.stderrBytes === 0, 'transport-not-cleanly-observed');
    demand(digest(await readBound(path.join(root, SOURCE), 262144)) === SOURCE_SHA256 && digest(await readBound(path.join(root, PRIOR), 65536)) === PRIOR_SHA256 && digest(await readBound(known, 512)) === KNOWN_SHA256 && digest(await readBound(path.join(root, BASE, 'plans', input.runId + '.json'), 16384)) === input.planSha256, 'input-changed-during-capture');
    const observation = validateReport(stdout, plan.expectedObservedBootId); evidence.observation = observation;
    evidence.result = observation.result;
    if (observation.scans.some(s => s.stages.some(stage => stage.id.startsWith('boot-') && stage.items.some(v => v.state === 'observed' && v.data !== plan.expectedObservedBootId)))) { evidence.result = 'held'; evidence.failure = 'expected-observed-boot-mismatch-no-replan'; }
  } catch (error) { evidence.failure = /^[a-z0-9-]{1,100}$/.test(error.message ?? '') ? error.message : 'capture-or-validation-failed'; evidence.result = 'held'; }
  evidence.completedAt = new Date().toISOString(); await writeExclusive(path.join(directory, 'evidence.json'), Buffer.from(JSON.stringify(evidence, null, 2) + '\n'));
  return { directory, evidence };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runQualification(parseArgs(process.argv.slice(2))); console.log(JSON.stringify({ directory: result.directory, result: result.evidence.result, profileAdopted: false })); if (result.evidence.result !== 'observed-only') process.exitCode = 1; }
  catch (error) { console.error(/^[a-z0-9-]{1,100}$/.test(error.message ?? '') ? error.message : 'qualification-refused'); process.exitCode = 1; }
}
