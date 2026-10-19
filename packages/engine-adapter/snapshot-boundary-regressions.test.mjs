import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url), digest = value => createHash('sha256').update(value).digest('hex');
const base = path.resolve('output/software-audit-20261019/engine/fake-snapshot');
const dataDir = path.join(base, 'private'), directory = path.join(dataDir, 'engineering');
const projectRoot = path.join(base, 'workspace'), protectedRoot = path.join(directory, 'snapshots');
const log = path.join(directory, 'isolation-probes', 'proof.json');
let compiled;
function bundle() {
  return compiled ??= build({ entryPoints: ['packages/engineering-runner/snapshots.ts'], bundle: true,
    platform: 'node', format: 'cjs', write: false, plugins: [{ name: 'pure-snapshot-ports', setup(b) {
      b.onResolve({ filter: /^node:fs\/promises$/ }, () => ({ path: 'fs', namespace: 'pure-snapshot' }));
      b.onResolve({ filter: /^\.\/fingerprint\.js$/ }, () => ({ path: 'fingerprint', namespace: 'pure-snapshot' }));
      b.onResolve({ filter: /^\.\/processes\.js$/ }, () => ({ path: 'processes', namespace: 'pure-snapshot' }));
      b.onLoad({ filter: /.*/, namespace: 'pure-snapshot' }, ({ path: name }) => ({ contents: name === 'fs' ?
        ['copyFile','mkdir','lstat','realpath','writeFile','readFile','open'].map(method =>
          `export const ${method}=(...args)=>globalThis.__ports.fs.${method}(...args);`).join('\n') : name === 'fingerprint' ?
        'export const {digest,fingerprint,hashFile,inside}=globalThis.__ports.fingerprint;' :
        'export const {resolveExecutable,toolIdentity,execute}=globalThis.__ports.processes;' }));
    } }] }).then(result => result.outputFiles[0].text);
}
function proof(writeDenied = true) {
  return { schemaVersion: 1, method: 'engine-sandbox-write-denial', policyDigest: 'a'.repeat(64),
    projectRoot, protectedRoot, verifiedAt: '2026-10-19T00:00:00.000Z',
    attemptedPath: path.join(protectedRoot, '.fixed-attempt'), writeDenied, cleanupComplete: true };
}
async function fixture({ oversized = false, mismatchedHashRead = false, processResult } = {}) {
  const bytes = Buffer.from(JSON.stringify(proof())), expected = mismatchedHashRead ? Buffer.from(JSON.stringify(proof(false))) : bytes;
  const stats = { dev: 1, ino: 2, mode: 0o100600, nlink: 1, uid: 1, gid: 1,
    size: oversized ? 256 * 1024 + 1 : bytes.length, mtimeMs: 1, ctimeMs: 2,
    isFile: () => true, isSymbolicLink: () => false };
  const counts = { bodyReads: 0, hashReads: 0, opens: 0, closes: 0, executes: 0 };
  const ports = { fs: { mkdir: async () => {}, realpath: async file => path.resolve(file), lstat: async () => stats,
    readFile: async () => { counts.bodyReads++; return bytes.toString('utf8'); },
    open: async () => { counts.opens++; return { stat: async () => stats,
      read: async (buffer, offset, length, position) => { counts.bodyReads++; const end = Math.min(position + length, bytes.length);
        const bytesRead = Math.max(0, end - position); bytes.copy(buffer, offset, position, end); return { bytesRead, buffer }; },
      close: async () => { counts.closes++; } }; },
    copyFile: async () => { throw Error('Copy forbidden'); }, writeFile: async () => { throw Error('Write forbidden'); } },
    fingerprint: { digest, fingerprint: async () => { throw Error('Unexpected fingerprint'); },
      hashFile: async () => { counts.hashReads++; return { sha256: digest(expected), bytes: expected.length }; },
      inside(root, candidate) { const rel = path.relative(root, candidate); return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); } },
    processes: { resolveExecutable: async () => { throw Error('Executable resolution forbidden'); },
      toolIdentity: async () => { throw Error('Tool probe forbidden'); }, execute: async () => { counts.executes++;
        if (processResult) return processResult;
        throw Error('Process forbidden'); } } };
  const module = { exports: {} };
  runInNewContext(await bundle(), { module, exports: module.exports, Buffer, path, console, process, __ports: ports,
    require(name) { if (name === 'node:child_process') throw Error('Native subprocess forbidden'); return require(name); } });
  const receipt = { ...proof(), probeLogRef: log, probeLogSha256: digest(expected) };
  return { api: module.exports, receipt, counts, ports, bytes, options: { dataDir, snapshotPolicyDigest: () => receipt.policyDigest } };
}

test('isolation proof size bound is enforced before hashing or reading its body', async () => {
  const f = await fixture({ oversized: true });
  await assert.rejects(f.api.validateIsolation(f.receipt, { projectRoot }, directory, f.options), /limit|exceeded/i);
  assert.equal(f.counts.hashReads, 0, 'oversized proof must not be streamed before its size gate');
  assert.equal(f.counts.bodyReads, 0); assert.equal(f.counts.opens, 0);
});

test('isolation proof parser must consume the exact bytes whose digest matches the receipt', async () => {
  const f = await fixture({ mismatchedHashRead: true });
  await assert.rejects(f.api.validateIsolation(f.receipt, { projectRoot }, directory, f.options), /changed|match/i);
});

test('valid isolation proof is captured once, closed and hashed from the parsed bytes', async () => {
  const f = await fixture();
  await f.api.validateIsolation(f.receipt, { projectRoot }, directory, f.options);
  assert.equal(f.counts.hashReads, 0); assert.equal(f.counts.opens, 1); assert.equal(f.counts.closes, 1);
  assert.equal(f.counts.bodyReads, 2, 'bounded body plus EOF');
});

test('isolation proof unknown close refuses even a valid hash and receipt', async () => {
  const f = await fixture(), originalOpen = f.ports.fs.open;
  f.ports.fs.open = async (...args) => { const handle = await originalOpen(...args), close = handle.close;
    handle.close = async () => { await close(); throw Error('Mock close unknown'); }; return handle; };
  await assert.rejects(f.api.validateIsolation(f.receipt, { projectRoot }, directory, f.options), /close unknown/);
  assert.equal(f.counts.closes, 1);
});

test('isolation proof named and opened identity mismatch refuses before any body read', async () => {
  const f = await fixture(), originalOpen = f.ports.fs.open;
  f.ports.fs.open = async (...args) => { const handle = await originalOpen(...args), stat = handle.stat;
    handle.stat = async () => ({ ...await stat(), ino: 900 }); return handle; };
  await assert.rejects(f.api.validateIsolation(f.receipt, { projectRoot }, directory, f.options), /changed/);
  assert.equal(f.counts.bodyReads, 0); assert.equal(f.counts.closes, 1);
});

function execution(f) {
  const home = path.join(dataDir, 'engine'), outputRoot = path.join(directory, 'snapshots', 'task', 'op', 'output');
  const profile = { nodeExecutable: process.execPath, templateDirectory: path.join(base, 'templates'),
    sandbox: { executable: path.join(base, 'fake-sandbox.exe'), codexHome: home, mode: 'unelevated' } };
  const policy = () => ({ schemaVersion: 1, method: 'app-server/config-read', generation: 1, observedAt: new Date().toISOString(),
    projectRoot: outputRoot, home, effectivePolicySha256: 'a'.repeat(64), managedPolicySha256: 'b'.repeat(64) });
  return { profile, snapshot: { inputRoot: path.join(directory, 'snapshots', 'task', 'op', 'input'), outputRoot },
    command: { executable: process.execPath, args: [], cwd: outputRoot, timeoutMs: 30000 },
    options: { ...f.options, snapshotExecutionPolicy: async () => policy() } };
}

test('cancellation while persisting stage approval prevents sandbox process dispatch', async () => {
  const f = await fixture(), e = execution(f), control = { cancelled: false }; let audit;
  await assert.rejects(f.api.sandboxExecute(e.profile, e.command, control, e.options, value => {
    audit = value; control.cancelled = true;
  }), /cancelled/);
  assert.equal(f.counts.executes, 0); assert.equal(audit.status, 'rejected');
});

test('sandbox refuses nonfixed deadline or relative cwd before any policy or process work', async () => {
  const f = await fixture(), e = execution(f); let policies = 0;
  const options = { ...e.options, snapshotExecutionPolicy: async () => { policies++; throw Error('must not call'); } };
  for (const command of [{ ...e.command, timeoutMs: 30001 }, { ...e.command, cwd: 'relative' }]) {
    await assert.rejects(f.api.sandboxExecute(e.profile, command, { cancelled: false }, options), /fixed 30-second/);
  }
  assert.equal(policies, 0); assert.equal(f.counts.executes, 0);
});

test('unknown sandbox process cleanup cannot advance to a passed snapshot stage', async () => {
  const f = await fixture({ processResult: { exitCode: 0, signal: null, output: 'not a proof', cancelled: false,
    timedOut: false, cleanup: 'unconfirmed' } }), e = execution(f); let phases = 0;
  await assert.rejects(f.api.runSnapshotCommands(e.profile, e.snapshot, e.options, { cancelled: false }, async () => { phases++; }),
    error => error.result.cleanup === 'unconfirmed' && /failed/.test(error.message));
  assert.equal(f.counts.executes, 1); assert.equal(phases, 1);
});

test('snapshot ownership path mismatch refuses before reading a manifest or source file', async () => {
  const f = await fixture();
  await assert.rejects(f.api.validateTaskSnapshot({ id: 'op', taskId: 'task', operationId: 'op',
    inputRoot: path.join(base, 'foreign'), outputRoot: path.join(base, 'foreign-output'), manifestPath: path.join(base, 'manifest.json') },
  directory, f.options), /ownership\/path/);
  assert.equal(f.counts.hashReads, 0); assert.equal(f.counts.bodyReads, 0);
});
