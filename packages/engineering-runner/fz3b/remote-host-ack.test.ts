import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';
import { createRemoteHostAckFinalizer, observeRemoteFinalizeTransport, type RemoteHostAckBootstrap } from './remote-host-ack.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = join(ROOT, 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/remote-host-ack-fixtures');
mkdirSync(FIXTURES, { recursive: true });
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
}
const enc = (value: unknown) => Buffer.from(JSON.stringify(sorted(value)) + '\n', 'ascii');

function fixture(changeSource?: (source: Buffer, receipt: Buffer) => Buffer): { input: RemoteHostAckBootstrap; receipt: Buffer; publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']; cleanup(): void } {
  const directory = mkdtempSync(join(FIXTURES, 'isolated-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicRaw = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32);
  const owner = { actor: 'independent-native-qa', generation: 'abcdef01-2345-4abc-8abc-123456789abc', nonce: 'a'.repeat(64) };
  const runId = 'active-recovery-01234567-89ab-4cde-8fab-0123456789ab';
  const now = Date.now();
  const jobId = 'fd-recovery-0123456789ab4cde8fab0123456789ab';
  const serviceInstance = { mainPid: 3925, startTicks: 1000 };
  const intent = enc({ schemaVersion: 1, method: 'fz3b-active-recovery-maintenance-v2', runId, owner, action: 'upload-cancel',
    bootId: '5ceb45a3-8903-4efc-9484-ec75c17280df', profileSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64), approvalIntentSha256: 'c'.repeat(64),
    approvalReceiptSha256: 'd'.repeat(64), consumedSha256: 'e'.repeat(64), baselineSha256: '1'.repeat(64), sourcePinsSha256: '2'.repeat(64),
    fixtureSha256: '3'.repeat(64), metadataSha256: '4'.repeat(64), productJournalSha256: '5'.repeat(64), ownerPermitSha256: '6'.repeat(64),
    imageSha256: '7'.repeat(64), queryBodySha256: '8'.repeat(64), inputMetadataSha256: '9'.repeat(64), serviceInstance, jobId, expectedQueryRevision: 2,
    createdAt: new Date(now - 60000).toISOString(), approvalExpiresAt: new Date(now + 240000).toISOString() });
  const activeSha256 = sha(intent);
  const intentValue = JSON.parse(intent.toString());
  const terminalState = { state: 'STOPPED', error: null, jobId, queryRevision: 2, received: 1, completed: 0, queued: 0, finished: true, cancelled: true };
  function observation(start: number) {
    const scan = (at: number) => ({ complete: true, deviceOpened: false, deviceOwners: [], controlConnections: [], stdinOwners: [], newPidsAtEnd: [],
      selfExcluded: { pid: 123, startTicks: 456 }, bootId: intentValue.bootId, metadataSha256: intentValue.metadataSha256, productJournalSha256: intentValue.productJournalSha256, observedAt: new Date(at).toISOString() });
    return { activeSha256, owner, bootId: intentValue.bootId, serviceInstance, metadataBeforeSha256: intentValue.metadataSha256, metadataAfterSha256: intentValue.metadataSha256,
      productJournalBeforeSha256: intentValue.productJournalSha256, productJournalAfterSha256: intentValue.productJournalSha256, terminal: terminalState,
      observer: { connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sequential: true, closedBeforeScans: true, statusMayWriteR5Telemetry: true },
      scans: [scan(start), scan(start + 100)], observedAt: new Date(start + 200).toISOString() };
  }
  const terminal = enc({ schemaVersion: 1, method: 'fz3b-recovery-terminal-proof-v1', runId, activeSha256, owner, action: intentValue.action, coverage: 'active-interrupted',
    activeSample: { ...terminalState, state: 'RUNNING', cancelled: false },
    fault: { action: intentValue.action, attemptCount: 1, connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ownCloseObserved: true,
      cancelAck: { requestId: 'cancel-' + jobId.slice(12), op: 'upload_cancel', ok: true, jobId, cancelled: true, queued: 0 } }, observation: observation(now - 10000) });
  const proofSha256 = sha(terminal);
  const accepted = enc({ schemaVersion: 1, method: 'fz3b-recovery-host-accepted-v1', runId, activeSha256, proofSha256, owner,
    rawReceiptSha256: 'f'.repeat(64), acceptanceId: 'abcdef01-2345-4abc-8abc-123456789abc', acceptedAt: new Date(now - 2000).toISOString() });
  const fresh = enc(observation(now - 1000));
  const authority = enc({ schemaVersion: 1, method: 'fz3b-recovery-release-authority-v1', runId, activeSha256, proofSha256, hostAcceptedSha256: sha(accepted),
    freshObservationSha256: sha(fresh), owner, releaseAuthorized: true });
  const commit = enc({ schemaVersion: 1, method: 'fz3b-recovery-commit-v1', runId, activeSha256, releaseAuthoritySha256: sha(authority), owner,
    activeAbsentObserved: true, unlinkDirectorySynced: true });
  const receipt = enc({ schemaVersion: 1, method: 'fz3b-recovery-prepared-release-v1', runId, activeSha256, proofSha256, coverage: 'active-interrupted',
    commitSha256: sha(commit), guardAbsent: true, releaseDirectorySynced: true, preparedRelease: true, logicalQuarantineRetained: true,
    hostAckRequired: true, unknownHistoryRewritten: false, automaticReplay: false });
  const originalSource = Buffer.from(`process.stdout.write(Buffer.from('${receipt.toString('base64')}','base64'));\n`, 'ascii');
  const source = changeSource ? changeSource(originalSource, receipt) : originalSource;
  const command = { executable: process.execPath, args: ['-'] };
  return { input: { privateKey, pinnedPublicKeyRaw32: Buffer.from(publicRaw), pinnedFinalizeSourceSha256: sha(source), finalizeSource: source,
    fixedCommand: { ...command, pinnedCommandSha256: sha(enc(command)) }, records: { intent, terminal, 'host-accepted': accepted, 'finalize-observation': fresh,
      'release-authority': authority, commit }, acceptanceDirectory: directory, timeoutMs: 4000 }, receipt, publicKey,
    cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('real fixed child close + exclusive flushed readback gates real Ed25519 exact ACK', async () => {
  const f = fixture();
  try {
    const operation = createRemoteHostAckFinalizer(f.input);
    assert.deepEqual(Object.keys(operation), ['complete']);
    const result = await operation.complete();
    assert.equal(result.logicalQuarantineRetained, true);
    assert.equal(result.automaticReplay, false);
    const envelope = JSON.parse(result.envelope.toString('ascii'));
    const message = Buffer.concat([Buffer.from('ForgeDesk/FZ3B/RecoveryHostCommitAck/v1\0'), enc(envelope.payload)]);
    assert.equal(verify(null, message, f.publicKey, Buffer.from(envelope.signatureB64, 'base64')), true);
    assert.equal(verify(null, Buffer.concat([message, Buffer.from('changed')]), f.publicKey, Buffer.from(envelope.signatureB64, 'base64')), false);
    assert.equal(result.envelopeSha256, sha(result.envelope));
    assert.deepEqual(readFileSync(join(f.input.acceptanceDirectory, 'host-ack.json')), result.envelope);
    assert.deepEqual(readFileSync(join(f.input.acceptanceDirectory, 'finalize-receipt.json')), f.receipt);
    const transportRaw = readFileSync(join(f.input.acceptanceDirectory, 'transport-evidence.json'));
    const transport = JSON.parse(transportRaw.toString('ascii'));
    assert.equal(envelope.payload.transportEvidenceSha256, sha(transportRaw));
    assert.equal(transport.actualCloseObserved, true);
    assert.equal(transport.persistence, 'exclusive-file-flush-readback');
    assert.equal(transport.directoryDurability, process.platform === 'win32' ? 'not-attested' : 'directory-fsync');
    await assert.rejects(operation.complete(), /ALREADY_CONSUMED/);
  } finally { f.cleanup(); }
});

test('wrong receipt, stderr, nonzero exit, timeout and duplicate output cannot produce an ACK', async () => {
  const cases = [
    () => Buffer.from("process.stdout.write('{}\\n');\n"),
    (source: Buffer) => Buffer.concat([Buffer.from("process.stderr.write('unexpected');\n"), source]),
    (source: Buffer) => Buffer.concat([source, Buffer.from('process.exitCode=3;\n')]),
    () => Buffer.from('setTimeout(()=>{},30000);\n'),
    (source: Buffer) => Buffer.concat([source, source]),
    (source: Buffer) => Buffer.concat([source, Buffer.from('setTimeout(()=>{},30000);\n')]),
  ];
  for (const [index, change] of cases.entries()) {
    const f = fixture(change);
    if (index === 3 || index === 5) f.input.timeoutMs = 100;
    try {
      await assert.rejects(createRemoteHostAckFinalizer(f.input).complete());
      assert.equal(existsSync(join(f.input.acceptanceDirectory, 'host-ack.json')), false);
      const refusal = JSON.parse(readFileSync(join(f.input.acceptanceDirectory, 'transport-refusal.json')).toString());
      if (index === 3 || index === 5) {
        assert.equal(refusal.timedOut, true);
        assert.equal(refusal.actualCloseObserved, false);
      }
    } finally { f.cleanup(); }
  }
});

test('a receipt cannot authorize an ACK when transport persistence fails after the real child closes', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.input.acceptanceDirectory, 'transport-evidence.json'), 'occupied');
    const operation = createRemoteHostAckFinalizer(f.input);
    await assert.rejects(operation.complete());
    assert.deepEqual(readFileSync(join(f.input.acceptanceDirectory, 'finalize-receipt.json')), f.receipt);
    assert.equal(readFileSync(join(f.input.acceptanceDirectory, 'transport-evidence.json')).toString(), 'occupied');
    assert.equal(existsSync(join(f.input.acceptanceDirectory, 'host-ack.json')), false);
    await assert.rejects(operation.complete(), /ALREADY_CONSUMED/);
  } finally { f.cleanup(); }
});

test('an ancestor junction or symlink is rejected before dispatch', async () => {
  const f = fixture(), alias = f.input.acceptanceDirectory + '-alias';
  try {
    const child = join(f.input.acceptanceDirectory, 'child'); mkdirSync(child, { mode: 0o700 });
    symlinkSync(f.input.acceptanceDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
    f.input.acceptanceDirectory = join(alias, 'child');
    await assert.rejects(createRemoteHostAckFinalizer(f.input).complete(), /STORE_ANCESTOR/);
    assert.equal(existsSync(join(child, 'intent.json')), false);
  } finally { if (existsSync(alias)) unlinkSync(alias); f.cleanup(); }
});

test('store failure is observed before dispatch, and cannot be asserted saved by a caller', async () => {
  const f = fixture();
  const marker = join(f.input.acceptanceDirectory, 'spawned-marker');
  try {
    const source = Buffer.from(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`);
    f.input.finalizeSource = source; f.input.pinnedFinalizeSourceSha256 = sha(source);
    writeFileSync(join(f.input.acceptanceDirectory, 'intent.json'), 'occupied');
    const operation = createRemoteHostAckFinalizer(f.input);
    await assert.rejects((operation.complete as (...args: unknown[]) => Promise<unknown>)({ saved: true, actualCloseObserved: true }));
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(f.input.acceptanceDirectory, 'host-ack.json')), false);
  } finally { f.cleanup(); }
});

test('immutable snapshot, key pin, command pin, raw canonical encoding, record chain are enforced', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.input.pinnedPublicKeyRaw32 = Buffer.alloc(32); },
    (f: ReturnType<typeof fixture>) => { f.input.fixedCommand.pinnedCommandSha256 = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.input.pinnedFinalizeSourceSha256 = '0'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { (f.input.records as any).intent = Buffer.from('{}'); },
    (f: ReturnType<typeof fixture>) => { (f.input.records as any).commit = enc({ ...JSON.parse(f.input.records.commit.toString()), releaseAuthoritySha256: '0'.repeat(64) }); },
  ]) {
    const f = fixture();
    try { mutate(f); assert.throws(() => createRemoteHostAckFinalizer(f.input)); } finally { f.cleanup(); }
  }
  const f = fixture();
  try {
    const operation = createRemoteHostAckFinalizer(f.input);
    f.input.records.intent.fill(0); f.input.finalizeSource.fill(0); f.input.pinnedPublicKeyRaw32.fill(0);
    const result = await operation.complete();
    assert.equal(JSON.parse(result.envelope.toString()).payload.finalizeReceiptSha256, sha(f.receipt));
  } finally { f.cleanup(); }
});

test('transport uses actual spawn/stdin/exit/close and refuses nonexistent command or output overflow', async () => {
  const normal = Buffer.from("process.stdout.write('actual-close\\n');\n");
  assert.equal((await observeRemoteFinalizeTransport(process.execPath, ['-'], normal, 4000)).stdout.toString(), 'actual-close\n');
  await assert.rejects(observeRemoteFinalizeTransport(join(dirname(process.execPath), 'no-such-fz3b-test-executable'), ['-'], normal, 2000));
  await assert.rejects(observeRemoteFinalizeTransport(process.execPath, ['-'], Buffer.from("process.stdout.write('x'.repeat(65537));\n"), 4000));
  await assert.rejects(observeRemoteFinalizeTransport(process.execPath, ['-e', 'process.exit(0)'], Buffer.alloc(1048576, 'x'), 4000));
});

test('child environment excludes inherited preload, Python, SSH and proxy overrides', async () => {
  const names = ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'SSH_AUTH_SOCK', 'SSH_ASKPASS', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'PATH'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'fixture-poison';
    const result = await observeRemoteFinalizeTransport(process.execPath, ['-'], Buffer.from('process.stdout.write(JSON.stringify(process.env));\n'), 4000);
    const env = JSON.parse(result.stdout.toString());
    for (const name of names) assert.notEqual(env[name], 'fixture-poison');
    for (const name of names.filter(name => name !== 'PATH')) assert.equal(env[name], undefined);
    // Windows process startup can supply account/system defaults even with a
    // minimal explicit env. It must not pass through the parent's overrides.
    const systemDefaults = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
    for (const name of Object.keys(env)) assert.ok(systemDefaults.includes(name.toUpperCase()));
  } finally {
    for (const name of names) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});

test('kill false or throw remains an unsigned timeout refusal without claiming actual close', async () => {
  for (const result of ['false', 'throw']) {
    const f = fixture(() => Buffer.from('setTimeout(()=>{},150);\n'));
    f.input.timeoutMs = 25;
    const kill = mock.method(ChildProcess.prototype, 'kill', () => {
      if (result === 'throw') throw new Error('fixture-kill-denied');
      return false;
    });
    try {
      await assert.rejects(createRemoteHostAckFinalizer(f.input).complete());
      const refusal = JSON.parse(readFileSync(join(f.input.acceptanceDirectory, 'transport-refusal.json')).toString());
      assert.equal(refusal.killResult, result === 'throw' ? 'error' : 'not-sent');
      assert.equal(refusal.actualCloseObserved, false);
      assert.equal(existsSync(join(f.input.acceptanceDirectory, 'host-ack.json')), false);
    } finally {
      kill.mock.restore();
      // These local fixture children deliberately self-exit after failed kill.
      await new Promise(resolve => setTimeout(resolve, 300));
      f.cleanup();
    }
  }
});
