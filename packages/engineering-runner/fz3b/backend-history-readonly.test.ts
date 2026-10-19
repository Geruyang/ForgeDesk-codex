import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink, link } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import test from 'node:test';
import { historicalFz3bProfileDefinitions } from './profile-history.js';
import { decodeReadonlyLedger } from './history-readonly.js';

const old = historicalFz3bProfileDefinitions()[0]!;
const key = Buffer.alloc(32, 0x39); // Offline fixture authority only, never a real user key.
const base = path.resolve('output/revision-0.5.7/recovery-qualification-v1/integration/readonly-loader-v1/production-integration-v1/fixtures');
const require = createRequire(import.meta.url);
function payload(runId = 'old-run') {
  return { runId, sessionId: 'offline-session', taskId: 'offline-task', model: old.profile.model, generation: 1, threadId: 'offline-thread',
    schemaVersion: 1, profileId: old.profileId, profileSha256: old.profileSha256, status: 'needs_attention', phase: 'needs_attention',
    active: false, hardwareBusy: true, stopRequested: true, nativeApproval: 'unknown', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:01.000Z',
    calls: [], operations: [{ id: 'offline-op', requestKey: 'offline-request', nonce: 'a'.repeat(64), kind: 'semantic', status: 'unknown',
      dispatchPhase: 'may-have-started', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:01.000Z', processExited: false, remoteQuiescent: false }],
    step: 3, results: {}, receipts: {} };
}
function encode(value: unknown) {
  return Buffer.from(JSON.stringify({ payload: value, mac: createHmac('sha256', key).update(JSON.stringify(value)).digest('hex') }, null, 2));
}
let bundled: Promise<string> | undefined;
function bundle() {
  return bundled ??= build({ entryPoints: ['packages/engineering-runner/fz3b/backend.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'offline-history-native-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\.\/credentials(?:\.js)?$/ }, () => ({ path: 'credentials', namespace: 'offline-history' }));
      builder.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'fs', namespace: 'offline-history' }));
      builder.onLoad({ filter: /.*/, namespace: 'offline-history' }, args => ({ contents: args.path === 'fs' ?
        'export const {lstatSync,fstatSync,openSync,readSync,closeSync,readdirSync,realpathSync}=globalThis.__history.fs;' :
        `export const {currentSid,fz3bHostDependencyAclSync,fz3bPrivateAclBatchSync}=globalThis.__history.acl;
         export const FZ3B_PROJECT_PUBLIC_KEY='offline-unused'; export const FZ3B_PROJECT_KEY_FINGERPRINT='offline-unused';
         export const requireFz3bProjectKey=()=>{throw Error('Real credential path forbidden');};
         export const fz3bPrivateAclSync=()=>{throw Error('ACL repair forbidden');};
         export const fz3bPrivateKeyPath=()=>{throw Error('SSH key path forbidden');};` }));
    } }],
  }).then(result => result.outputFiles[0]!.text);
}
async function fixture(create = true) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'case-')), ledger = path.join(directory, 'fz3b-agent');
  if (create) { await mkdir(ledger); await writeFile(path.join(ledger, 'binding.key'), key); await writeFile(path.join(ledger, 'old-run.json'), encode(payload())); }
  const aclCalls: string[] = [], reads: string[] = [], descriptors = new Map<number, string>();
  let sidFailure = false, aclFailure = false, readsStarted = false;
  let readHook: ((file: string, count: number) => void) | undefined, closeFailure = false;
  const fsPort = { ...fs, openSync(file: fs.PathLike, flags: fs.OpenMode) {
    assert.equal(flags, 'r'); const fd = fs.openSync(file, flags); descriptors.set(fd, String(file)); return fd;
  }, readSync(fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) {
    readsStarted = true; const file = descriptors.get(fd)!; reads.push(file);
    const count = fs.readSync(fd, buffer, offset, length, position); readHook?.(file, count); return count;
  }, closeSync(fd: number) { const file = descriptors.get(fd); fs.closeSync(fd); descriptors.delete(fd); if (closeFailure && file?.endsWith('binding.key')) throw Error('Offline close unknown'); } };
  const acl = { currentSid: async () => { if (sidFailure) throw Error('Offline SID unavailable'); return 'S-1-5-21-101'; },
    fz3bHostDependencyAclSync(root: string, sid: string) {
      assert.equal(root, directory); assert.equal(sid, 'S-1-5-21-101'); aclCalls.push('dependency');
      if (aclFailure) throw Error('Offline dependency ACL refused');
    }, fz3bPrivateAclBatchSync(files: string[], sid: string) {
      assert.equal(sid, 'S-1-5-21-101'); assert(files.every(file => path.dirname(file) === ledger && file.endsWith('.json'))); aclCalls.push('records');
    } };
  const module = { exports: {} as any };
  runInNewContext(await bundle(), { module, exports: module.exports, require, Buffer, process, console, URL, AbortController, AbortSignal,
    setTimeout, clearTimeout, structuredClone, __history: { fs: fsPort, acl } });
  const backend = new module.exports.Fz3bBackend({ dataDir: directory, fixture: old.fixture,
    adapter: {}, requestSemantic: () => { throw Error('Dialog forbidden'); }, assertOwner: () => { throw Error('Owner mutation forbidden'); },
    checkRuntime: () => { throw Error('Runtime action forbidden'); } });
  backend.init = () => { throw Error('Initialization forbidden'); };
  backend.attention = () => { throw Error('History rewrite forbidden'); };
  backend.save = () => { throw Error('Ledger save forbidden'); };
  return { backend, directory, ledger, aclCalls, reads, descriptors, readsStarted: () => readsStarted,
    sidFailure: () => { sidFailure = true; }, aclFailure: () => { aclFailure = true; },
    readHook: (hook: typeof readHook) => { readHook = hook; }, failClose: () => { closeFailure = true; },
    cleanup: async () => {
      const relative = path.relative(base, path.resolve(directory));
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.equal(descriptors.size, 0); await rm(directory, { recursive: true, force: true });
    } };
}

test('existing real backend method reads a stable fixture census and preserves unknown without operational insertion', async () => {
  const f = await fixture();
  try {
    const before = await readFile(path.join(f.ledger, 'old-run.json'));
    const out = await f.backend.readExistingHistory();
    assert.equal(out.status, 'history-only-blocked'); assert.equal(out.records.length, 1);
    assert.equal(out.records[0].record.operations[0].status, 'unknown'); assert.equal(out.records[0].rawEnvelopeHex, before.toString('hex'));
    assert.equal(out.historicalHoldObserved, true); assert.equal(out.acquisition.jsonCensusStableAcrossRead, true);
    for (const flag of ['admissionAuthorized', 'newRunAuthorized', 'releaseAuthorized', 'activeEpochAdopted', 'automaticReplay']) assert.equal(out[flag], false);
    assert.deepEqual(await readFile(path.join(f.ledger, 'old-run.json')), before);
    assert.equal(f.backend.records.size, 0); assert.equal(f.backend.key, undefined); assert.equal(f.backend.initialization, undefined);
    assert.deepEqual(f.aclCalls, ['dependency', 'records', 'dependency', 'records']);
    assert.equal(f.descriptors.size, 0);
  } finally { await f.cleanup(); }
});

test('method accepts no caller path/key/authority and SID or dependency ACL failure precedes byte reads', async () => {
  for (const mode of ['argument', 'sid', 'acl']) {
    const f = await fixture();
    try {
      if (mode === 'sid') f.sidFailure(); if (mode === 'acl') f.aclFailure();
      await assert.rejects(mode === 'argument' ? f.backend.readExistingHistory({ key, root: f.directory, authenticated: true }) : f.backend.readExistingHistory());
      assert.equal(f.readsStarted(), false);
    } finally { await f.cleanup(); }
  }
});

test('missing existing root/key and nonjson orphan refuse without creating or repairing anything', async () => {
  for (const mode of ['root', 'key', 'orphan']) {
    const f = await fixture(mode !== 'root');
    try {
      if (mode === 'key') await rm(path.join(f.ledger, 'binding.key'));
      if (mode === 'orphan') await writeFile(path.join(f.ledger, 'unfinished.tmp'), 'orphan');
      await assert.rejects(f.backend.readExistingHistory()); assert.equal(f.readsStarted(), false);
      if (mode === 'root') assert.equal(fs.existsSync(f.ledger), false);
      if (mode === 'key') assert.equal(fs.existsSync(path.join(f.ledger, 'binding.key')), false);
    } finally { await f.cleanup(); }
  }
});

test('any bad MAC/schema/profile makes the entire census fail rather than skipping one old row', async () => {
  for (const mode of ['mac', 'schema', 'profile']) {
    const f = await fixture();
    try {
      const bad = payload('second'); if (mode === 'schema') (bad as any).epochQualified = true; if (mode === 'profile') bad.profileSha256 = 'b'.repeat(64);
      let raw = encode(bad); if (mode === 'mac') { const wire = JSON.parse(raw.toString()); wire.mac = '0'.repeat(64); raw = Buffer.from(JSON.stringify(wire, null, 2)); }
      await writeFile(path.join(f.ledger, 'second.json'), raw);
      await assert.rejects(f.backend.readExistingHistory()); assert.equal(f.backend.records.size, 0);
      assert.deepEqual(await readFile(path.join(f.ledger, 'second.json')), raw);
    } finally { await f.cleanup(); }
  }
});

test('linked key, root reparse and oversized leaf are refused, never followed as trusted bytes', async () => {
  for (const mode of ['hardlink', 'reparse', 'oversize']) {
    const f = await fixture();
    try {
      if (mode === 'hardlink') await link(path.join(f.ledger, 'binding.key'), path.join(f.directory, 'key-link'));
      if (mode === 'oversize') await writeFile(path.join(f.ledger, 'old-run.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
      if (mode === 'reparse') {
        await fs.promises.rename(f.ledger, path.join(f.directory, 'target'));
        await symlink(path.join(f.directory, 'target'), f.ledger, process.platform === 'win32' ? 'junction' : 'dir');
      }
      await assert.rejects(f.backend.readExistingHistory());
      if (mode === 'oversize') assert(f.reads.every(file => file.endsWith('binding.key')));
      else assert.equal(f.readsStarted(), false);
    } finally { await f.cleanup(); }
  }
});

test('body mutation during read and census growth are detected instead of yielding a partial historical clear', async () => {
  for (const mode of ['body', 'census']) {
    const f = await fixture(); let changed = false;
    try {
      f.readHook((file, count) => {
        if (!changed && file.endsWith('old-run.json') && count === 0) {
          changed = true;
          if (mode === 'body') fs.appendFileSync(file, ' ');
          else fs.writeFileSync(path.join(f.ledger, 'new-run.json'), encode(payload('new-run')));
        }
      });
      await assert.rejects(f.backend.readExistingHistory()); assert.equal(changed, true); assert.equal(f.backend.records.size, 0);
    } finally { await f.cleanup(); }
  }
});

test('unknown descriptor close refuses the snapshot and starts no subsequent record read', async () => {
  const f = await fixture();
  try {
    f.failClose(); await assert.rejects(f.backend.readExistingHistory(), /Offline close unknown/);
    assert(f.reads.length > 0); assert(f.reads.every(file => file.endsWith('binding.key')));
  } finally { await f.cleanup(); }
});

test('production pure loader keeps whole-envelope rules and rejects forged evidence/mapper input', () => {
  const raw = encode(payload()); assert.equal(decodeReadonlyLedger(raw, 'old-run.json', key).releaseAuthorized, false);
  const changed = JSON.parse(raw.toString()); changed.payload.operations[0].status = 'succeeded';
  assert.throws(() => decodeReadonlyLedger(Buffer.from(JSON.stringify(changed, null, 2)), 'old-run.json', key), /integrity/);
  assert.throws(() => decodeReadonlyLedger(raw, '../old-run.json', key), /leaf-name/);
});
