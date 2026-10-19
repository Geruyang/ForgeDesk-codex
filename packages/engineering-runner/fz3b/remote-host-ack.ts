import { ChildProcess, spawn } from 'node:child_process';
import { createHash, createPublicKey, KeyObject, randomUUID, sign } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path';

const DOMAIN = Buffer.from('ForgeDesk/FZ3B/RecoveryHostCommitAck/v1\0', 'ascii');
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RECORD_NAMES = ['intent', 'terminal', 'host-accepted', 'finalize-observation', 'release-authority', 'commit'] as const;
type RecordName = typeof RECORD_NAMES[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function requireAck(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`FZ3B_REMOTE_HOST_ACK_${reason}`);
}
const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');

// Recovery core JSON is ASCII, sorted, integer-only for these records, with LF.
// Refuse floats rather than guessing Python's float serialization.
function canonical(value: unknown, depth = 0, budget = { count: 0 }): string {
  requireAck(depth <= 16 && ++budget.count <= 8192, 'JSON_BUDGET');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { requireAck(Number.isSafeInteger(value), 'JSON_INTEGER'); return JSON.stringify(value); }
  if (typeof value === 'string') {
    requireAck(value.length <= 65536, 'JSON_STRING');
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  requireAck(value && typeof value === 'object', 'JSON_VALUE');
  requireAck([Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)), 'JSON_OBJECT');
  const desc = Object.getOwnPropertyDescriptors(value);
  requireAck(Object.getOwnPropertySymbols(value).length === 0, 'JSON_SYMBOL');
  for (const [key, entry] of Object.entries(desc)) {
    if (Array.isArray(value) && key === 'length') continue;
    requireAck(entry.enumerable && 'value' in entry && entry.value !== undefined, 'JSON_DESCRIPTOR');
  }
  if (Array.isArray(value)) {
    requireAck(Object.keys(value).length === value.length, 'JSON_ARRAY');
    return '[' + value.map(child => canonical(child, depth + 1, budget)).join(',') + ']';
  }
  return '{' + Object.keys(value).sort().map(key => canonical(key, depth + 1, budget) + ':' + canonical(desc[key].value, depth + 1, budget)).join(',') + '}';
}
const encode = (value: unknown) => Buffer.from(canonical(value) + '\n', 'ascii');
function parse(raw: Buffer): { [key: string]: Json } {
  requireAck(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 65536 && raw.every(byte => byte < 128), 'RAW_BUDGET');
  const value = JSON.parse(raw.toString('ascii'));
  requireAck(value && typeof value === 'object' && !Array.isArray(value) && encode(value).equals(raw), 'RAW_CANONICAL');
  return value;
}
function exact(value: { [key: string]: Json }, keys: string[]): void {
  requireAck(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'CLOSED_SCHEMA');
}
function time(value: Json): number {
  requireAck(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), 'TIME');
  const ms = Date.parse(value); requireAck(Number.isFinite(ms) && new Date(ms).toISOString() === value, 'TIME'); return ms;
}
function object(value: Json): { [key: string]: Json } {
  requireAck(value && typeof value === 'object' && !Array.isArray(value), 'OBJECT'); return value;
}

const INTENT_KEYS = ['schemaVersion', 'method', 'runId', 'action', 'planSha256', 'approvalIntentSha256', 'approvalReceiptSha256', 'consumedSha256', 'owner', 'bootId', 'profileSha256',
  'baselineSha256', 'sourcePinsSha256', 'fixtureSha256', 'metadataSha256', 'productJournalSha256', 'ownerPermitSha256', 'serviceInstance', 'imageSha256', 'queryBodySha256', 'inputMetadataSha256',
  'jobId', 'expectedQueryRevision', 'createdAt', 'approvalExpiresAt'];
const OBSERVATION_KEYS = ['activeSha256', 'owner', 'bootId', 'serviceInstance', 'metadataBeforeSha256', 'metadataAfterSha256', 'productJournalBeforeSha256', 'productJournalAfterSha256',
  'terminal', 'observer', 'scans', 'observedAt'];
const TERMINAL_KEYS = ['state', 'error', 'jobId', 'queryRevision', 'received', 'completed', 'queued', 'finished', 'cancelled'];
const equal = (left: unknown, right: unknown) => encode(left).equals(encode(right));

function terminalState(value: Json, intent: { [key: string]: Json }, coverage: Json, running = false): void {
  const state = object(value); exact(state, TERMINAL_KEYS);
  requireAck(state.state === (running ? 'RUNNING' : 'STOPPED') && state.error === null && state.jobId === intent.jobId &&
    state.queryRevision === intent.expectedQueryRevision && state.received === 1 && Number.isSafeInteger(state.completed) &&
    (state.completed === 0 || !running && state.completed === 1) && Number.isSafeInteger(state.queued) &&
    (state.queued === 0 || running && state.queued === 1) && state.finished === true, 'TERMINAL_STATE');
  requireAck(running ? state.cancelled === false : coverage === 'active-interrupted' ? state.cancelled === true : state.cancelled === false && state.completed === 1, 'TERMINAL_COVERAGE');
}
function observationState(value: { [key: string]: Json }, intent: { [key: string]: Json }, activeSha: string, coverage: Json): void {
  exact(value, OBSERVATION_KEYS);
  requireAck(value.activeSha256 === activeSha && equal(value.owner, intent.owner) && value.bootId === intent.bootId && equal(value.serviceInstance, intent.serviceInstance), 'OBSERVATION_CONTEXT');
  requireAck(value.metadataBeforeSha256 === intent.metadataSha256 && value.metadataAfterSha256 === intent.metadataSha256 &&
    value.productJournalBeforeSha256 === intent.productJournalSha256 && value.productJournalAfterSha256 === intent.productJournalSha256, 'OBSERVATION_DRIFT');
  terminalState(value.terminal, intent, coverage);
  const observer = object(value.observer); exact(observer, ['connectionId', 'sequential', 'closedBeforeScans', 'statusMayWriteR5Telemetry']);
  requireAck(typeof observer.connectionId === 'string' && UUID.test(observer.connectionId) && observer.sequential === true && observer.closedBeforeScans === true && observer.statusMayWriteR5Telemetry === true, 'OBSERVER');
  requireAck(Array.isArray(value.scans) && value.scans.length === 2, 'SCANS');
  let prior = 0, first = 0, self: Json = null;
  for (const [index, entry] of value.scans.entries()) {
    const scan = object(entry); exact(scan, ['complete', 'deviceOpened', 'deviceOwners', 'controlConnections', 'stdinOwners', 'newPidsAtEnd', 'selfExcluded', 'bootId', 'metadataSha256', 'productJournalSha256', 'observedAt']);
    requireAck(scan.complete === true && scan.deviceOpened === false && scan.bootId === intent.bootId && scan.metadataSha256 === intent.metadataSha256 && scan.productJournalSha256 === intent.productJournalSha256, 'SCAN_CONTEXT');
    for (const key of ['deviceOwners', 'controlConnections', 'stdinOwners', 'newPidsAtEnd']) requireAck(Array.isArray(scan[key]) && (scan[key] as Json[]).length === 0, 'SCAN_BUSY');
    const own = object(scan.selfExcluded); exact(own, ['pid', 'startTicks']);
    requireAck(Number.isSafeInteger(own.pid) && (own.pid as number) > 0 && Number.isSafeInteger(own.startTicks) && (own.startTicks as number) >= 0 && (self === null || equal(self, own)), 'SCAN_SELF');
    self = own;
    const sampled = time(scan.observedAt);
    requireAck(index === 0 || sampled - prior >= 100 && sampled - prior <= 120000, 'SCAN_ORDER');
    if (index === 0) first = sampled;
    prior = sampled;
  }
  requireAck(time(value.observedAt) >= prior && time(value.observedAt) - first <= 120000, 'OBSERVATION_ORDER');
}

function validateCoreRecordShapes(records: Record<RecordName, { [key: string]: Json }>, raw: Record<RecordName, Buffer>): void {
  const { intent, terminal, commit } = records;
  exact(intent, INTENT_KEYS);
  requireAck(intent.schemaVersion === 1 && intent.method === 'fz3b-active-recovery-maintenance-v2', 'INTENT_SCHEMA');
  for (const key of INTENT_KEYS.filter(key => key.endsWith('Sha256'))) requireAck(typeof intent[key] === 'string' && SHA.test(intent[key] as string), 'INTENT_HASH');
  const service = object(intent.serviceInstance); exact(service, ['mainPid', 'startTicks']);
  requireAck(Number.isSafeInteger(service.mainPid) && (service.mainPid as number) > 1 && Number.isSafeInteger(service.startTicks) && (service.startTicks as number) > 0 &&
    intent.jobId === 'fd-recovery-' + (intent.runId as string).slice(16).replaceAll('-', '') && Number.isSafeInteger(intent.expectedQueryRevision) && (intent.expectedQueryRevision as number) > 0 &&
    time(intent.approvalExpiresAt) - time(intent.createdAt) > 0 && time(intent.approvalExpiresAt) - time(intent.createdAt) <= 300000, 'INTENT_BINDING');
  exact(terminal, ['schemaVersion', 'method', 'runId', 'activeSha256', 'owner', 'action', 'coverage', 'activeSample', 'fault', 'observation']);
  requireAck(terminal.schemaVersion === 1 && terminal.method === 'fz3b-recovery-terminal-proof-v1' && terminal.action === intent.action, 'PROOF_SCHEMA');
  const activeSha = digest(raw.intent);
  observationState(object(terminal.observation), intent, activeSha, terminal.coverage);
  const fault = object(terminal.fault); exact(fault, ['action', 'attemptCount', 'connectionId', 'ownCloseObserved', 'cancelAck']);
  requireAck((fault.attemptCount === 0 || fault.attemptCount === 1) && typeof fault.connectionId === 'string' && UUID.test(fault.connectionId) && fault.ownCloseObserved === true &&
    object(object(terminal.observation).observer).connectionId !== fault.connectionId, 'FAULT');
  if (terminal.activeSample !== null) terminalState(terminal.activeSample, intent, terminal.coverage, true);
  if (fault.attemptCount === 0) requireAck(terminal.coverage === 'not-covered' && terminal.activeSample === null && fault.action === null && fault.cancelAck === null, 'FAULT_MISSED');
  else {
    requireAck(fault.action === intent.action && terminal.activeSample !== null, 'FAULT_CONTEXT');
    if (intent.action === 'tcp-close') requireAck(fault.cancelAck === null, 'FAULT_TCP');
    else {
      const ack = object(fault.cancelAck); exact(ack, ['requestId', 'op', 'ok', 'jobId', 'cancelled', 'queued']);
      requireAck(terminal.coverage === 'active-interrupted' && ack.requestId === 'cancel-' + (intent.jobId as string).slice(12) && ack.op === 'upload_cancel' && ack.ok === true && ack.jobId === intent.jobId && ack.cancelled === true && ack.queued === 0, 'FAULT_CANCEL');
    }
  }
  const accepted = records['host-accepted'], fresh = records['finalize-observation'], authority = records['release-authority'];
  exact(accepted, ['schemaVersion', 'method', 'runId', 'owner', 'activeSha256', 'proofSha256', 'rawReceiptSha256', 'acceptanceId', 'acceptedAt']);
  requireAck(accepted.schemaVersion === 1 && accepted.method === 'fz3b-recovery-host-accepted-v1' && typeof accepted.rawReceiptSha256 === 'string' && SHA.test(accepted.rawReceiptSha256) && typeof accepted.acceptanceId === 'string' && UUID.test(accepted.acceptanceId), 'ACCEPTED_SCHEMA');
  observationState(fresh, intent, activeSha, terminal.coverage);
  requireAck(equal(fresh.terminal, object(terminal.observation).terminal) && time(fresh.observedAt) >= time(accepted.acceptedAt) && time(accepted.acceptedAt) >= time(object(terminal.observation).observedAt), 'ACCEPTED_ORDER');
  exact(authority, ['schemaVersion', 'method', 'runId', 'activeSha256', 'proofSha256', 'hostAcceptedSha256', 'freshObservationSha256', 'owner', 'releaseAuthorized']);
  requireAck(authority.schemaVersion === 1 && authority.method === 'fz3b-recovery-release-authority-v1', 'AUTHORITY_SCHEMA');
  exact(commit, ['schemaVersion', 'method', 'runId', 'activeSha256', 'releaseAuthoritySha256', 'owner', 'activeAbsentObserved', 'unlinkDirectorySynced']);
  requireAck(commit.schemaVersion === 1 && commit.method === 'fz3b-recovery-commit-v1', 'COMMIT_SCHEMA');
}

export interface RemoteHostAckBootstrap {
  /** Main-only immutable composition. No request/renderer values or key paths. */
  privateKey: KeyObject;
  pinnedPublicKeyRaw32: Buffer;
  pinnedFinalizeSourceSha256: string;
  /** Exact source sent to the fixed command's stdin; stdin is closed internally. */
  finalizeSource: Buffer;
  fixedCommand: { executable: string; args: readonly string[]; pinnedCommandSha256: string };
  records: Readonly<Record<RecordName, Buffer>>;
  /** Already provisioned private directory. This component never creates it. */
  acceptanceDirectory: string;
  timeoutMs: number;
}

export interface RemoteHostAckCompletion {
  envelope: Buffer;
  envelopeSha256: string;
  /** This is not a publication or a claim that PS quarantine is clear. */
  logicalQuarantineRetained: true;
  automaticReplay: false;
}

interface DirectoryIdentity { path: string; dev: number; ino: number }
interface AcceptanceDirectory extends DirectoryIdentity { fd: number | null; ancestors: DirectoryIdentity[] }

function inspectAncestors(path: string): DirectoryIdentity[] {
  const absolute = resolve(path), root = parsePath(absolute).root;
  const names = [root];
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) names.push(join(names[names.length - 1], part));
  return names.map(name => {
    const info = lstatSync(name), actual = realpathSync.native(name);
    requireAck(info.isDirectory() && !info.isSymbolicLink() &&
      (process.platform === 'win32' ? actual.toLowerCase() === name.toLowerCase() : actual === name), 'STORE_ANCESTOR');
    return { path: name, dev: info.dev, ino: info.ino };
  });
}
function stableDirectory(opened: AcceptanceDirectory): void {
  const current = inspectAncestors(opened.path);
  requireAck(current.length === opened.ancestors.length && current.every((entry, index) =>
    entry.path === opened.ancestors[index].path && entry.dev === opened.ancestors[index].dev && entry.ino === opened.ancestors[index].ino), 'STORE_REPLACED');
}
function privateDirectory(path: string): AcceptanceDirectory {
  requireAck(isAbsolute(path), 'STORE_ABSOLUTE');
  const ancestors = inspectAncestors(path);
  const before = lstatSync(path);
  requireAck(before.isDirectory() && !before.isSymbolicLink(), 'STORE_DIRECTORY');
  if (process.platform !== 'win32') {
    requireAck((before.mode & 0o777) === 0o700 && before.uid === process.getuid!(), 'STORE_PRIVATE');
  }
  // Node does not provide directory flushing on Windows. File flush/readback
  // attests this acceptance only; restart must independently revalidate history.
  if (process.platform === 'win32') return { path, fd: null, dev: before.dev, ino: before.ino, ancestors };
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = fstatSync(fd);
    requireAck(before.dev === after.dev && before.ino === after.ino && after.isDirectory(), 'STORE_REPLACED');
    fsyncSync(fd); return { path, fd, dev: after.dev, ino: after.ino, ancestors };
  } catch (error) { closeSync(fd); throw error; }
}

function persist(directory: string, opened: AcceptanceDirectory, name: string, raw: Buffer): void {
  requireAck(raw.length > 0 && raw.length <= 65536, 'STORE_BUDGET');
  stableDirectory(opened);
  const current = lstatSync(directory);
  requireAck(current.dev === opened.dev && current.ino === opened.ino && !current.isSymbolicLink(), 'STORE_REPLACED');
  const path = join(directory, name);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const created = fstatSync(fd);
  try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
  if (opened.fd !== null) fsyncSync(opened.fd);
  const readFd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(readFd);
    requireAck(info.isFile() && info.dev === created.dev && info.ino === created.ino && info.nlink === 1 && info.size === raw.length, 'STORE_READBACK');
    const read = Buffer.alloc(raw.length);
    let offset = 0;
    while (offset < read.length) {
      const count = readSync(readFd, read, offset, read.length - offset, null);
      requireAck(count > 0, 'STORE_SHORT_READ'); offset += count;
    }
    requireAck(readSync(readFd, Buffer.alloc(1), 0, 1, null) === 0 && read.equals(raw), 'STORE_READBACK');
    const after = fstatSync(readFd), named = lstatSync(path);
    requireAck(after.dev === info.dev && after.ino === info.ino && after.size === info.size && after.mtimeMs === info.mtimeMs && after.ctimeMs === info.ctimeMs &&
      named.isFile() && !named.isSymbolicLink() && named.dev === info.dev && named.ino === info.ino && named.size === info.size, 'STORE_READBACK_CHANGED');
    stableDirectory(opened);
  } finally { closeSync(readFd); }
}

/**
 * Unintegrated trusted host composition. The sole public operation takes no
 * payload, proof flags, transport result or saved boolean. It can only sign its
 * captured exact finalize operation after actual process close and durable I/O.
 * Do not export through model tools/IPC. Production also requires reviewed SSH
 * command/source composition, pinned provider/key deployment and host durability.
 */
export function createRemoteHostAckFinalizer(input: RemoteHostAckBootstrap): { complete(): Promise<RemoteHostAckCompletion> } {
  const raw = Object.fromEntries(RECORD_NAMES.map(name => [name, Buffer.from(input.records[name])])) as Record<RecordName, Buffer>;
  const records = Object.fromEntries(RECORD_NAMES.map(name => [name, parse(raw[name])])) as Record<RecordName, { [key: string]: Json }>;
  const { intent, terminal, commit } = records;
  requireAck(typeof intent.runId === 'string' && /^active-recovery-/.test(intent.runId) && UUID.test(intent.runId.slice(16)), 'RUN');
  requireAck(typeof terminal.coverage === 'string' && ['active-interrupted', 'not-covered'].includes(terminal.coverage), 'COVERAGE');
  const owner = object(intent.owner); exact(owner, ['actor', 'generation', 'nonce']);
  requireAck(owner.actor === 'independent-native-qa' && typeof owner.generation === 'string' && UUID.test(owner.generation) && typeof owner.nonce === 'string' && SHA.test(owner.nonce), 'OWNER');
  for (const key of ['profileSha256', 'planSha256', 'approvalIntentSha256', 'approvalReceiptSha256', 'consumedSha256']) requireAck(typeof intent[key] === 'string' && SHA.test(intent[key] as string), 'INTENT_HASH');
  requireAck(intent.action === 'upload-cancel' || intent.action === 'tcp-close', 'ACTION');
  requireAck(typeof intent.bootId === 'string' && /^[a-f0-9-]{36}$/.test(intent.bootId), 'BOOT');
  validateCoreRecordShapes(records, raw);
  const activeSha = digest(raw.intent), proofSha = digest(raw.terminal);
  for (const name of RECORD_NAMES.slice(1)) {
    const record = records[name];
    requireAck((name === 'finalize-observation' || record.runId === intent.runId) && record.activeSha256 === activeSha, 'RECORD_CONTEXT');
    if ('owner' in record) requireAck(encode(record.owner).equals(encode(owner)), 'RECORD_OWNER');
  }
  const accepted = records['host-accepted'], fresh = records['finalize-observation'], authority = records['release-authority'];
  requireAck(accepted.proofSha256 === proofSha && authority.proofSha256 === proofSha && authority.hostAcceptedSha256 === digest(raw['host-accepted']) &&
    authority.freshObservationSha256 === digest(raw['finalize-observation']) && authority.releaseAuthorized === true &&
    commit.releaseAuthoritySha256 === digest(raw['release-authority']) && commit.activeAbsentObserved === true && commit.unlinkDirectorySynced === true, 'RECORD_CHAIN');
  requireAck(time(fresh.observedAt) >= time(accepted.acceptedAt), 'RECORD_ORDER');
  const expectedReceipt = encode({ schemaVersion: 1, method: 'fz3b-recovery-prepared-release-v1', runId: intent.runId,
    activeSha256: activeSha, proofSha256: proofSha, coverage: terminal.coverage, commitSha256: digest(raw.commit),
    guardAbsent: true, releaseDirectorySynced: true, preparedRelease: true, logicalQuarantineRetained: true,
    hostAckRequired: true, unknownHistoryRewritten: false, automaticReplay: false });
  const source = Buffer.from(input.finalizeSource), publicRaw = Buffer.from(input.pinnedPublicKeyRaw32);
  requireAck(source.length > 0 && source.length <= 1048576 && publicRaw.length === 32 && SHA.test(input.pinnedFinalizeSourceSha256) && digest(source) === input.pinnedFinalizeSourceSha256, 'PIN');
  const sourceSha = digest(source), privateKey = input.privateKey;
  requireAck(privateKey instanceof KeyObject && privateKey.type === 'private' && privateKey.asymmetricKeyType === 'ed25519', 'PRIVATE_KEY_TYPE');
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  requireAck(spki.equals(Buffer.concat([SPKI_PREFIX, publicRaw])), 'KEY_MISMATCH');
  const keyId = 'ed25519-sha256:' + digest(publicRaw);
  const executable = input.fixedCommand.executable, args = [...input.fixedCommand.args];
  requireAck(isAbsolute(executable) && args.length > 0 && args.every(arg => typeof arg === 'string' && !arg.includes('\0')) &&
    digest(encode({ executable, args })) === input.fixedCommand.pinnedCommandSha256, 'FIXED_COMMAND');
  requireAck(Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 && input.timeoutMs <= 120000, 'TIMEOUT');
  const timeoutMs = input.timeoutMs, directory = input.acceptanceDirectory;
  let consumed = false;

  return Object.freeze({ async complete(): Promise<RemoteHostAckCompletion> {
    requireAck(!consumed, 'ALREADY_CONSUMED'); consumed = true;
    const directoryFd = privateDirectory(directory);
    try {
      const now = Date.now();
      requireAck(0 <= now - time(fresh.observedAt) && now - time(fresh.observedAt) <= 120000, 'STALE_OBSERVATION');
      requireAck(time(intent.createdAt) <= now && now < time(intent.approvalExpiresAt) &&
        now - time(accepted.acceptedAt) >= 0 && now - time(accepted.acceptedAt) <= 120000 &&
        now - time(object(terminal.observation).observedAt) >= 0 && now - time(object(terminal.observation).observedAt) <= 120000, 'STALE_AUTHORITY');
      // Retain exact accepted inputs before any finalize dispatch.
      for (const name of RECORD_NAMES) persist(directory, directoryFd, `${name}.json`, raw[name]);
      persist(directory, directoryFd, 'finalize-source.sha256', Buffer.from(sourceSha + '\n', 'ascii'));
      let result: { stdout: Buffer };
      try { result = await observeRemoteFinalizeTransport(executable, args, source, timeoutMs); }
      catch (error) {
        if (error instanceof FinalizeTransportRefusal) persist(directory, directoryFd, 'transport-refusal.json', error.evidence);
        throw error;
      }
      if (!result.stdout.equals(expectedReceipt)) {
        persist(directory, directoryFd, 'transport-refusal.json', encode({ schemaVersion: 1, method: 'fz3b-host-finalize-receipt-refusal-v1',
          actualCloseObserved: true, receiptMatchesExpected: false, stdoutBytes: result.stdout.length, stdoutSha256: digest(result.stdout) }));
        throw new Error('FZ3B_REMOTE_HOST_ACK_FINALIZE_RECEIPT');
      }
      const acceptedAt = new Date().toISOString();
      requireAck(time(acceptedAt) >= time(fresh.observedAt) && time(acceptedAt) - time(fresh.observedAt) <= 120000, 'FINALIZE_STALE');
      const transport = encode({ schemaVersion: 1, method: 'fz3b-host-finalize-actual-close-v1', commandSha256: digest(encode({ executable, args })),
        finalizeSourceSha256: sourceSha, stdinSha256: sourceSha, stdoutSha256: digest(result.stdout), stdoutBytes: result.stdout.length,
        spawned: true, stdinFinished: true, exitCode: 0, signal: null, processExited: true, actualCloseObserved: true, timedOut: false, killed: false,
        persistence: 'exclusive-file-flush-readback', directoryDurability: directoryFd.fd === null ? 'not-attested' : 'directory-fsync', acceptedAt });
      persist(directory, directoryFd, 'finalize-receipt.json', result.stdout);
      persist(directory, directoryFd, 'transport-evidence.json', transport);
      const payload = { schemaVersion: 1, method: 'fz3b-recovery-host-commit-ack-v1', acceptanceId: randomUUID(),
        runId: intent.runId, owner, action: intent.action, bootId: intent.bootId, profileSha256: intent.profileSha256,
        planSha256: intent.planSha256, approvalIntentSha256: intent.approvalIntentSha256, approvalReceiptSha256: intent.approvalReceiptSha256,
        consumedSha256: intent.consumedSha256, activeSha256: activeSha, proofSha256: proofSha,
        hostAcceptedSha256: digest(raw['host-accepted']), finalizeObservationSha256: digest(raw['finalize-observation']),
        releaseAuthoritySha256: digest(raw['release-authority']), commitSha256: digest(raw.commit), finalizeReceiptSha256: digest(result.stdout),
        transportEvidenceSha256: digest(transport), finalizeSourceSha256: sourceSha, coverage: terminal.coverage, acceptedAt, keyId,
        scope: 'exact-finalize-completed-only' };
      const signature = sign(null, Buffer.concat([DOMAIN, encode(payload)]), privateKey);
      const envelope = encode({ schemaVersion: 1, algorithm: 'Ed25519', keyId, payload, signatureB64: signature.toString('base64') });
      persist(directory, directoryFd, 'host-ack.json', envelope);
      return { envelope, envelopeSha256: digest(envelope), logicalQuarantineRetained: true, automaticReplay: false };
    } finally { if (directoryFd.fd !== null) closeSync(directoryFd.fd); }
  } });
}

/** Transport observation alone confers no signing/publication authority. */
class FinalizeTransportRefusal extends Error {
  constructor(readonly evidence: Buffer) { super('FZ3B_REMOTE_HOST_ACK_ACTUAL_CLOSE_REQUIRED'); }
}

export function observeRemoteFinalizeTransport(executable: string, args: readonly string[], input: Buffer, timeoutMs: number): Promise<{ stdout: Buffer }> {
  requireAck(isAbsolute(executable) && args.length > 0 && args.every(arg => typeof arg === 'string' && !arg.includes('\0')) &&
    Buffer.isBuffer(input) && input.length > 0 && input.length <= 1048576 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'TRANSPORT_INPUT');
  const source = Buffer.from(input), fixedArgs = [...args];
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    // Fixed Windows target bootstrap only; never inherit language/SSH/proxy
    // preload overrides or credentials from the host application's environment.
    const env = process.platform === 'win32' ? { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32;C:\\Windows' } : { PATH: '/usr/bin:/bin' };
    try { child = spawn(executable, fixedArgs, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let spawned = false, finished = false, exited = false, closed = false, failed = false, timedOut = false, size = 0, stderrBytes = 0;
    let exitCode: number | null = null, exitSignal: string | null = null, killResult = 'not-attempted';
    const events: string[] = [];
    const chunks: Buffer[] = [];
    const fail = () => {
      failed = true;
      if (!child.killed && killResult === 'not-attempted') {
        try { killResult = child.kill() ? 'sent' : 'not-sent'; }
        catch { killResult = 'error'; }
      }
    };
    const refusal = () => new FinalizeTransportRefusal(encode({ schemaVersion: 1, method: 'fz3b-host-finalize-refused-transport-v1',
      spawned, stdinFinished: finished, processExited: exited, actualCloseObserved: closed, exitCode, signal: exitSignal,
      timedOut, failed, killed: child.killed, killResult, stdoutBytes: size, stdoutRetainedSha256: digest(Buffer.concat(chunks)), stderrBytes, events }));
    const timer = setTimeout(() => {
      events.push('timeout'); timedOut = true; fail();
      // A descendant can keep a pipe open after the direct child exits. Timeout
      // is still a terminal refusal; it must never manufacture an actual close.
      reject(refusal());
    }, timeoutMs);
    child.once('spawn', () => { events.push('spawn'); spawned = true; });
    child.once('error', () => { events.push('spawn-error'); fail(); });
    child.stdin!.once('finish', () => { events.push('stdin-finish'); finished = true; });
    child.stdin!.once('error', () => { events.push('stdin-error'); fail(); });
    child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) fail(); else chunks.push(Buffer.from(chunk)); });
    child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (chunk.length) fail(); });
    child.stdout!.once('error', fail); child.stderr!.once('error', fail);
    child.once('exit', (code, signal) => { events.push('exit'); exited = true; exitCode = code; exitSignal = signal; if (code !== 0 || signal !== null || !spawned || !finished) fail(); });
    child.once('close', (code, signal) => {
      events.push('close'); closed = true;
      clearTimeout(timer);
      if (!failed && !timedOut && !child.killed && spawned && finished && exited && code === 0 && signal === null) resolve({ stdout: Buffer.concat(chunks) });
      else reject(refusal());
    });
    child.stdin!.end(source);
  });
}
