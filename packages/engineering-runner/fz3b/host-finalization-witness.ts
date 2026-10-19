import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import { safePart } from '../embedded/files.js';
import { fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS } from './preflight-refusal-proof.js';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from './preflight-recovery.js';
import type { Fz3bPreflightRefusalRecoveryContext as Context, Fz3bPreflightRefusalRecoveryProof as Proof,
  Fz3bPreflightRefusalRecoveryFinalization as Finalization, Fz3bPreflightRefusalRecoveryAck as Ack,
  Fz3bPreflightRefusalRecoveryAcknowledgment as Acknowledgment, Fz3bPreflightRefusalRecoveryClosure as Closure } from './types.js';

function fail(value: unknown): asserts value { if (!value) throw new Error('FZ3B_HOST_COMPLETION_WITNESS_CHANGED'); }
const same = (a: unknown, b: unknown) => fz3bCanonicalJson(a) === fz3bCanonicalJson(b);
function identity(info: Stats, cross = false) {
  return { dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, size: info.size, uid: info.uid, gid: info.gid,
    mtimeMs: info.mtimeMs, ...(!cross ? { ctimeMs: info.ctimeMs } : {}) };
}
function normalized(value: string) { return process.platform === 'win32' ? value.toLowerCase() : value; }
export function noLinksFz3bHostSync(file: string): string {
  const absolute = path.resolve(file), root = path.parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) { current = path.join(current, part); fail(!lstatSync(current).isSymbolicLink()); }
  fail(normalized(path.resolve(realpathSync(absolute))) === normalized(absolute)); return absolute;
}
export function fz3bHostRootIdentitySync(root: string) {
  const absolute = noLinksFz3bHostSync(root), info = lstatSync(absolute); fail(info.isDirectory());
  return { root: normalized(absolute), dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs };
}
/** Fixed bounded handle read; no key, subprocess, device or cleanup action. */
export function readFz3bHostWitnessSync(file: string, limit = 2 * 1024 * 1024) {
  noLinksFz3bHostSync(file); const namedBefore = lstatSync(file);
  fail(namedBefore.isFile() && namedBefore.nlink === 1 && namedBefore.size > 0 && namedBefore.size <= limit);
  const fd = openSync(file, 'r'); let bytes: Buffer;
  try {
    const before = fstatSync(fd); fail(same(identity(namedBefore, true), identity(before, true)));
    const buffer = Buffer.alloc(limit + 1); let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, Math.min(65536, buffer.length - offset), offset); if (!count) break; offset += count; }
    bytes = buffer.subarray(0, offset); fail(bytes.length === before.size && bytes.length <= limit && same(identity(before), identity(fstatSync(fd))));
  } finally { closeSync(fd); }
  noLinksFz3bHostSync(file); fail(same(identity(namedBefore), identity(lstatSync(file))));
  return { bytes, sha256: fz3bDigest(bytes), identity: fz3bCanonicalJson(identity(namedBefore)) };
}
function absent(file: string) {
  try { lstatSync(file); throw new Error('FZ3B_HOST_COMPLETION_WITNESS_PATH_PRESENT'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
interface Source {
  root: string; resourceRoot: string; children(): number; held(): boolean;
}
/** Called only after full asynchronous completion authentication, then replayed synchronously before signing. */
export function captureFz3bHostCompletionWitness(source: Source, context: Readonly<Context>, proof: Readonly<Proof>, finalization: Readonly<Finalization>,
  ack: Readonly<Ack>, acknowledgment: Readonly<Acknowledgment>, closure: Readonly<Closure>): () => void {
  const root = fz3bHostRootIdentitySync(source.root), resources = fz3bHostRootIdentitySync(source.resourceRoot);
  const directory = path.join(source.root, 'preflight-refusal-recoveries', safePart(context.id));
  const original = path.join(source.root, safePart(context.original.operationId));
  const fixed: { file: string; limit: number; expectedHash?: string; expectedJson?: unknown }[] = [
    { file: path.join(original, 'evidence.json'), limit: 131072, expectedHash: FZ3B_PREFLIGHT_RECOVERY_CASE.evidenceSha256 },
    { file: path.join(original, 'intent.json'), limit: 131072, expectedHash: FZ3B_PREFLIGHT_RECOVERY_CASE.intentSha256 },
    { file: path.join(original, 'transport.json'), limit: 131072, expectedHash: FZ3B_PREFLIGHT_RECOVERY_CASE.transportSha256 },
    { file: path.join(original, 'process-exit.json'), limit: 131072, expectedHash: FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256 },
    { file: path.join(directory, 'prepared.json'), limit: 2 * 1048576 },
    { file: path.join(directory, 'prepared-evidence.json'), limit: 2 * 1048576, expectedHash: proof.evidenceSha256 },
    { file: path.join(directory, 'finalization.json'), limit: 65536, expectedJson: finalization },
    { file: path.join(directory, 'finalization-evidence.json'), limit: 65536, expectedHash: finalization.evidenceSha256 },
    { file: path.join(directory, 'unlink-intent.json'), limit: 65536, expectedJson: { schemaVersion: 1, contextSha256: proof.contextSha256,
      proofSha256: fz3bDigest(fz3bCanonicalJson(proof)), originalLeaseSha256: proof.originalLeaseSha256, state: 'intent-only-not-success' } },
    { file: path.join(directory, 'ack.json'), limit: 65536, expectedJson: ack },
    { file: path.join(directory, 'acknowledgment.json'), limit: 65536, expectedJson: acknowledgment },
    { file: path.join(directory, 'acknowledgment-evidence.json'), limit: 65536, expectedHash: acknowledgment.evidenceSha256 },
    { file: path.join(directory, 'closure.json'), limit: 65536, expectedJson: closure },
    { file: path.join(source.resourceRoot, 'manifest.json'), limit: 131072, expectedHash: FZ3B_PREFLIGHT_REFUSAL_PINS.manifest },
    { file: path.join(source.resourceRoot, 'remote', 'remote.py'), limit: 1048576, expectedHash: FZ3B_PREFLIGHT_REFUSAL_PINS.remote },
    { file: path.join(source.resourceRoot, 'remote', 'wire.py'), limit: 1048576, expectedHash: FZ3B_PREFLIGHT_REFUSAL_PINS.wire },
    { file: path.join(source.resourceRoot, 'fixture', 'host-fixture.json'), limit: 1048576, expectedHash: FZ3B_PREFLIGHT_REFUSAL_PINS.fixture },
  ];
  if (context.sourceRun.maintenanceExit) fixed.push({ file: path.join(original, 'local-close-proof.json'), limit: 16384,
    expectedHash: FZ3B_PREFLIGHT_RECOVERY_CASE.maintenanceLocalCloseProofSha256 });
  const allowed = fixed.filter(item => path.dirname(item.file) === directory).map(item => path.basename(item.file)).sort();
  const capture = () => {
    fail(same(root, fz3bHostRootIdentitySync(source.root)) && same(resources, fz3bHostRootIdentitySync(source.resourceRoot)) && source.children() === 0 && source.held() === false);
    for (const name of ['active.lock', 'preflight-refusal-recovery.lock', 'reconciliation.lock']) absent(path.join(source.root, name));
    noLinksFz3bHostSync(directory);
    const attempts = readdirSync(path.dirname(directory)); fail(same(attempts, [context.id]));
    fail(same(readdirSync(directory).sort(), allowed));
    const result = fixed.map(item => {
      const read = readFz3bHostWitnessSync(item.file, item.limit);
      if (item.expectedHash) fail(read.sha256 === item.expectedHash);
      if (item.expectedJson) fail(read.bytes.equals(Buffer.from(JSON.stringify(item.expectedJson, null, 2))));
      if (path.basename(item.file) === 'prepared.json') {
        const text = read.bytes.toString('utf8'), value = JSON.parse(text);
        fail(JSON.stringify(value, null, 2) === text && same(Object.keys(value).sort(), ['context', 'leaseBase64', 'leaseIdentity', 'proof']) &&
          same(value.context, context) && same(value.proof, proof) && typeof value.leaseBase64 === 'string' && value.leaseBase64.length <= 8192 &&
          typeof value.leaseIdentity === 'string' && value.leaseIdentity.length <= 512);
        const lease = Buffer.from(value.leaseBase64, 'base64');
        fail(lease.toString('base64') === value.leaseBase64 && fz3bDigest(lease) === proof.originalLeaseSha256);
      }
      return { file: item.file, sha256: read.sha256, identity: read.identity };
    });
    fail(source.children() === 0 && source.held() === false); return result;
  };
  const expected = capture();
  return () => { fail(same(capture(), expected)); };
}
