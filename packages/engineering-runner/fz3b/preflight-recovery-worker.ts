import { lstat, mkdir, open, readdir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { noLinks, safePart } from '../embedded/files.js';
import { fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { loadFz3bResourceBundle } from './resources.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS, verifyFz3bPreflightRefusal, type Fz3bPreflightRefusalInput } from './preflight-refusal-proof.js';
import { assertFz3bPreflightRecoveryContext, assertFz3bPreflightRecoveryProof, assertFz3bPreflightRecoveryFinalization,
  assertFz3bPreflightRecoveryAck, assertFz3bPreflightRecoveryAcknowledgment, assertFz3bPreflightRecoveryClosure, fz3bPreflightDigest } from './preflight-recovery.js';
import { assertFz3bMaintenanceLocalCloseProof } from './preflight-recovery.js';
import type { Fz3bPreflightRefusalRecoveryContext as Context, Fz3bPreflightRefusalRecoveryProof as Proof,
  Fz3bPreflightRefusalRecoveryFinalization as Finalization, Fz3bPreflightRefusalRecoveryAck as Ack,
  Fz3bPreflightRefusalRecoveryAcknowledgment as Acknowledgment, Fz3bPreflightRefusalRecoveryClosure as Closure } from './types.js';

interface Host { root: string; resourceRoot: string; children(): number; released(): void }
interface Bound { bytes: Buffer; sha256: string; identity: string }
interface Prepared { context: Context; proof: Proof; leaseBase64: string; leaseIdentity: string }
const folder = 'preflight-refusal-recoveries';
const barrier = 'preflight-refusal-recovery.lock';
function fail(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(`FZ3B_PREFLIGHT_WORKER_${code}`); }
const same = (a: unknown, b: unknown) => fz3bCanonicalJson(a) === fz3bCanonicalJson(b);
const identity = (s: Awaited<ReturnType<FileHandle['stat']>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** A handle-bound read rejects links, multi-links, replacement and edits during the read. */
async function readBound(file: string, limit = 2 * 1048576): Promise<Bound> {
  await noLinks(file); const before = await lstat(file);
  fail(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= limit, 'FILE_KIND_OR_BUDGET');
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat(); fail(identity(opened) === identity(before), 'FILE_REPLACED');
    const bytes = await handle.readFile(); const after = await handle.stat(); await noLinks(file); const named = await lstat(file);
    fail(identity(opened) === identity(after) && identity(after) === identity(named) && bytes.length === after.size, 'FILE_CHANGED');
    return { bytes, sha256: fz3bDigest(bytes), identity: identity(after) };
  } finally { await handle.close(); }
}
function decode<T>(bound: Bound): T {
  const text = bound.bytes.toString('utf8'); const value = JSON.parse(text);
  fail(JSON.stringify(value, null, 2) === text, 'RECORD_ENCODING'); return value as T;
}
async function absent(file: string) {
  try { await lstat(file); throw new Error('FZ3B_PREFLIGHT_WORKER_PATH_ALREADY_PRESENT'); }
  catch (error) { if (!missing(error)) throw error; }
}

/** Local-only transaction. It has no key reader, transport, child launcher, or device callback. */
export class Fz3bPreflightRecoveryWorker {
  private running = false;
  private now = () => Date.now();
  private removeLease = (file: string) => unlink(file);
  private removeBarrier = (file: string) => unlink(file);
  private verifySavedAck?: (ack: Ack) => void;
  private verifySavedClosure?: (ack: Ack, acknowledgment: Acknowledgment, value: Closure) => void;
  private successfulAcks = new Map<string, string>();
  private persist = async (file: string, value: unknown) => {
    await noLinks(path.dirname(file)); const raw = Buffer.from(JSON.stringify(value, null, 2));
    const handle = await open(file, 'wx');
    try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    fail((await readBound(file)).sha256 === fz3bDigest(raw), 'PERSIST_READBACK');
  };
  constructor(private readonly host: Host) {
    fail(path.isAbsolute(host.root) && path.isAbsolute(host.resourceRoot), 'ABSOLUTE_ROOT_REQUIRED');
  }
  private directory(context: Readonly<Context>) { return path.join(this.host.root, folder, safePart(context.id)); }
  private async roots() {
    await noLinks(this.host.root); await mkdir(path.join(this.host.root, folder), { recursive: true }); await noLinks(path.join(this.host.root, folder));
  }
  private noChildren() { fail(this.host.children() === 0, 'LOCAL_PROCESS_LIVE'); }
  private fresh(context: Readonly<Context>, proof?: Readonly<Proof>) {
    assertFz3bPreflightRecoveryContext(context as Context, context.original.fixture, this.now());
    if (proof) assertFz3bPreflightRecoveryProof(context as Context, proof as Proof, this.now());
    this.noChildren();
  }
  private async otherGuardAbsent() { await absent(path.join(this.host.root, 'reconciliation.lock')); }
  private async resources() {
    const resources = await loadFz3bResourceBundle(this.host.resourceRoot);
    fail(resources.manifestSha256 === FZ3B_PREFLIGHT_REFUSAL_PINS.manifest, 'RESOURCE_MANIFEST');
    const names = { manifest: 'manifest.json', remote: 'remote/remote.py', wire: 'remote/wire.py', fixture: 'fixture/host-fixture.json' } as const;
    const result = {} as Fz3bPreflightRefusalInput['resources'];
    for (const [name, relative] of Object.entries(names) as [keyof typeof names, string][]) result[name] = (await readBound(path.join(this.host.resourceRoot, relative), name === 'manifest' ? 131072 : 1048576)).bytes;
    return { fixture: resources.fixture, bytes: result };
  }
  private async input(context: Readonly<Context>, fresh: boolean) {
    const resources = await this.resources(); assertFz3bPreflightRecoveryContext(context as Context, resources.fixture, fresh ? this.now() : undefined);
    const original = context.original; for (const part of [original.operationId, original.taskId, original.runId, original.sessionId]) safePart(part);
    const directory = path.join(this.host.root, original.operationId); await noLinks(directory);
    const files = {} as Fz3bPreflightRefusalInput['files'];
    for (const [key, name] of [['evidence', 'evidence.json'], ['intent', 'intent.json'], ['transport', 'transport.json'], ['actualClose', 'process-exit.json']] as const) files[key] = (await readBound(path.join(directory, name), 131072)).bytes;
    const classification = verifyFz3bPreflightRefusal({ run: context.projection, anchor: context.anchor, resources: resources.bytes, files });
    if (context.sourceRun.maintenanceExit !== undefined) {
      const maintenance = await readBound(path.join(directory, 'local-close-proof.json'), 16384);
      assertFz3bMaintenanceLocalCloseProof(maintenance.bytes, context.sourceRun);
    }
    return { resources: resources.bytes, files, classification };
  }
  private async lease(context: Readonly<Context>) {
    const value = await readBound(path.join(this.host.root, 'active.lock'), 4096), o = context.original;
    const expected = JSON.stringify({ schemaVersion: 1, operationId: o.operationId, nonce: o.nonce, taskId: o.taskId, profileSha256: o.profileSha256 });
    fail(value.bytes.equals(Buffer.from(expected)), 'EXACT_ORIGINAL_LEASE_REQUIRED'); return value;
  }
  private async guard(context: Readonly<Context>) {
    const value = decode(await readBound(path.join(this.host.root, barrier), 4096));
    fail(same(value, { schemaVersion: 1, id: context.id, contextSha256: fz3bPreflightDigest(context) }), 'FOREIGN_BARRIER');
  }
  private async prepared(context: Readonly<Context>, proof: Readonly<Proof>, fresh: boolean) {
    const record = decode<Prepared>(await readBound(path.join(this.directory(context), 'prepared.json')));
    fail(same(record.context, context) && same(record.proof, proof) && Object.keys(record).sort().join() === 'context,leaseBase64,leaseIdentity,proof', 'PREPARED_BINDING');
    assertFz3bPreflightRecoveryProof(context as Context, proof as Proof, fresh ? this.now() : undefined);
    const original = await this.input(context, fresh); fail(same(proof.classification, original.classification), 'CLASSIFICATION_CHANGED');
    fail(fz3bDigest(Buffer.from(record.leaseBase64, 'base64')) === proof.originalLeaseSha256, 'PREPARED_LEASE_CHANGED');
    const evidence = await readBound(path.join(this.directory(context), 'prepared-evidence.json'));
    fail(evidence.sha256 === proof.evidenceSha256 && same(decode(evidence), { schemaVersion: 1, purpose: 'exact-preflight-branch-only',
      contextSha256: proof.contextSha256, classification: proof.classification, processState: proof.processState,
      originalLeaseSha256: proof.originalLeaseSha256, observedAt: proof.observedAt }), 'PREPARED_EVIDENCE_CHANGED');
    return record;
  }
  async prepare(context: Readonly<Context>): Promise<Proof> {
    fail(!this.running, 'BUSY'); this.running = true;
    try {
      this.noChildren(); await this.roots(); await this.assertNoRecoveryBarrier(); await this.otherGuardAbsent();
      const original = await this.input(context, true), lease = await this.lease(context);
      const directory = this.directory(context); await mkdir(directory); await noLinks(directory);
      await this.persist(path.join(this.host.root, barrier), { schemaVersion: 1, id: context.id, contextSha256: fz3bPreflightDigest(context) });
      const processState: Proof['processState'] = { closed: true, liveChildren: 0, operations: [{ operationId: context.original.operationId,
        nonce: context.original.nonce, closeConfirmed: true, evidenceSha256: context.anchor.actualCloseSha256 }] };
      const evidence = { schemaVersion: 1, purpose: 'exact-preflight-branch-only', contextSha256: fz3bPreflightDigest(context),
        classification: original.classification, processState, originalLeaseSha256: lease.sha256, observedAt: new Date(this.now()).toISOString() };
      await this.persist(path.join(directory, 'prepared-evidence.json'), evidence);
      const proof: Proof = { schemaVersion: 1, reason: context.reason, id: context.id, nonce: context.nonce, contextSha256: fz3bPreflightDigest(context),
        observedAt: evidence.observedAt, classification: original.classification, originalLeaseSha256: lease.sha256, processState,
        evidenceSha256: (await readBound(path.join(directory, 'prepared-evidence.json'))).sha256 };
      assertFz3bPreflightRecoveryProof(context as Context, proof, this.now());
      await this.persist(path.join(directory, 'prepared.json'), { context, proof, leaseBase64: lease.bytes.toString('base64'), leaseIdentity: lease.identity });
      this.noChildren(); await this.guard(context); return structuredClone(proof);
    } finally { this.running = false; }
  }
  async readInput(context: Readonly<Context>, proof: Readonly<Proof>): Promise<Pick<Fz3bPreflightRefusalInput, 'resources' | 'files'>> {
    this.noChildren(); await this.guard(context); await this.prepared(context, proof, false);
    const input = await this.input(context, false); return { resources: input.resources, files: input.files };
  }
  async finalize(context: Readonly<Context>, proof: Readonly<Proof>): Promise<Finalization> {
    fail(!this.running, 'BUSY'); this.running = true;
    try {
      this.noChildren(); await this.otherGuardAbsent(); await this.guard(context); const prepared = await this.prepared(context, proof, true);
      const lease = await this.lease(context); fail(lease.sha256 === proof.originalLeaseSha256 && lease.identity === prepared.leaseIdentity, 'LEASE_PREIMAGE_CHANGED');
      const directory = this.directory(context); await absent(path.join(directory, 'finalization.json'));
      await this.persist(path.join(directory, 'unlink-intent.json'), { schemaVersion: 1, contextSha256: fz3bPreflightDigest(context), proofSha256: fz3bPreflightDigest(proof),
        originalLeaseSha256: lease.sha256, state: 'intent-only-not-success' });
      await this.prepared(context, proof, true); await this.guard(context);
      this.noChildren(); const last = await this.lease(context); fail(last.sha256 === lease.sha256 && last.identity === lease.identity, 'LEASE_PREIMAGE_CHANGED');
      this.fresh(context, proof);
      await this.removeLease(path.join(this.host.root, 'active.lock')); await absent(path.join(this.host.root, 'active.lock'));
      const evidence = { schemaVersion: 1 as const, id: context.id, contextSha256: fz3bPreflightDigest(context), proofSha256: fz3bPreflightDigest(proof),
        originalLeaseSha256: lease.sha256, leaseUnlinked: true as const, barrierRetained: true as const, localProcessesClosed: true as const, finalizedAt: new Date(this.now()).toISOString() };
      this.noChildren(); await this.guard(context); await this.persist(path.join(directory, 'finalization-evidence.json'), evidence);
      const finalization: Finalization = { ...evidence, evidenceSha256: (await readBound(path.join(directory, 'finalization-evidence.json'))).sha256 };
      assertFz3bPreflightRecoveryFinalization(context as Context, proof as Proof, finalization);
      await this.persist(path.join(directory, 'finalization.json'), finalization); return structuredClone(finalization);
    } finally { this.running = false; }
  }
  async acknowledge(context: Readonly<Context>, proof: Readonly<Proof>, finalization: Readonly<Finalization>, ack: Readonly<Ack>, verifyAck: (value: Ack) => void): Promise<Acknowledgment> {
    fail(!this.running, 'BUSY'); this.running = true;
    try {
      this.noChildren(); await this.guard(context); await this.prepared(context, proof, true); await absent(path.join(this.host.root, 'active.lock'));
      assertFz3bPreflightRecoveryFinalization(context as Context, proof as Proof, finalization as Finalization);
      assertFz3bPreflightRecoveryAck(context as Context, proof as Proof, finalization as Finalization, ack as Ack);
      fail(typeof verifyAck === 'function', 'TRUSTED_ACK_VERIFIER_REQUIRED'); verifyAck(structuredClone(ack));
      const directory = this.directory(context);
      fail(same(decode(await readBound(path.join(directory, 'finalization.json'))), finalization), 'FINALIZATION_CHANGED');
      const finalEvidence = await readBound(path.join(directory, 'finalization-evidence.json'));
      const { evidenceSha256, ...finalBody } = finalization;
      fail(finalEvidence.sha256 === evidenceSha256 && same(decode(finalEvidence), finalBody), 'FINALIZATION_EVIDENCE_CHANGED');
      await this.persist(path.join(directory, 'ack.json'), ack);
      // Predeclared completion data alone is never success: inventory also requires authenticated ACK and actual barrier absence.
      const evidence = { schemaVersion: 1 as const, id: context.id, contextSha256: fz3bPreflightDigest(context), proofSha256: fz3bPreflightDigest(proof),
        finalizationSha256: fz3bPreflightDigest(finalization), ackSha256: fz3bPreflightDigest(ack), originalLeaseSha256: proof.originalLeaseSha256,
        localBarrierRemoved: true as const, localProcessesClosed: true as const };
      await this.persist(path.join(directory, 'acknowledgment-evidence.json'), evidence);
      const acknowledgment: Acknowledgment = { ...evidence, evidenceSha256: (await readBound(path.join(directory, 'acknowledgment-evidence.json'))).sha256 };
      assertFz3bPreflightRecoveryAcknowledgment(context as Context, proof as Proof, finalization as Finalization, ack as Ack, acknowledgment);
      await this.persist(path.join(directory, 'acknowledgment.json'), acknowledgment);
      await this.prepared(context, proof, true); await absent(path.join(this.host.root, 'active.lock'));
      await this.guard(context); this.fresh(context, proof);
      fail(Date.parse(ack.issuedAt) <= this.now() && this.now() - Date.parse(ack.issuedAt) <= 120000 && this.now() < Date.parse(context.expiresAt), 'ACK_EXPIRED');
      verifyAck(structuredClone(ack));
      // Absence alone remains held: a separately signed post-success closure must still be published.
      await this.removeBarrier(path.join(this.host.root, barrier));
      this.successfulAcks.set(context.id, fz3bPreflightDigest(acknowledgment)); return structuredClone(acknowledgment);
    } finally { this.running = false; }
  }
  /** Read-only restart authentication; it never completes or replays a pending attempt. */
  async readCompletion(context: Readonly<Context>, proof: Readonly<Proof>, finalization: Readonly<Finalization>, verifyAck: (value: Ack) => void,
    verifyClosure: (ack: Ack, acknowledgment: Acknowledgment, value: Closure) => void): Promise<{ ack: Ack; acknowledgment: Acknowledgment; closure: Closure }> {
    this.noChildren(); await absent(path.join(this.host.root, 'active.lock'));
    fail(typeof verifyAck === 'function', 'TRUSTED_ACK_VERIFIER_REQUIRED');
    const directory = this.directory(context);
    fail(same(decode(await readBound(path.join(directory, 'finalization.json'))), finalization), 'FINALIZATION_CHANGED');
    const prepared = decode<Prepared>(await readBound(path.join(directory, 'prepared.json')));
    fail(same(prepared.context, context) && same(prepared.proof, proof), 'COMPLETION_OWNER');
    const ack = decode<Ack>(await readBound(path.join(directory, 'ack.json')));
    const acknowledgment = decode<Acknowledgment>(await readBound(path.join(directory, 'acknowledgment.json')));
    const closure = decode<Closure>(await readBound(path.join(directory, 'closure.json')));
    fail(typeof verifyClosure === 'function', 'TRUSTED_CLOSURE_VERIFIER_REQUIRED');
    this.verifySavedAck = verifyAck; this.verifySavedClosure = verifyClosure;
    try { await this.assertNoRecoveryBarrier(); await absent(path.join(this.host.root, 'active.lock')); this.noChildren(); }
    catch (error) { this.verifySavedAck = undefined; this.verifySavedClosure = undefined; throw error; }
    this.host.released();
    return { ack, acknowledgment, closure };
  }
  async certify(context: Readonly<Context>, proof: Readonly<Proof>, finalization: Readonly<Finalization>, ack: Readonly<Ack>, acknowledgment: Readonly<Acknowledgment>, closure: Readonly<Closure>,
    verifyClosure: (ack: Ack, acknowledgment: Acknowledgment, value: Closure) => void): Promise<void> {
    fail(!this.running, 'BUSY'); this.running = true;
    try {
      this.fresh(context, proof); await absent(path.join(this.host.root, barrier)); await absent(path.join(this.host.root, 'active.lock'));
      fail(this.successfulAcks.get(context.id) === fz3bPreflightDigest(acknowledgment), 'ACTUAL_SUCCESSFUL_ACK_REQUIRED');
      const directory = this.directory(context);
      fail(same(decode(await readBound(path.join(directory, 'ack.json'))), ack) && same(decode(await readBound(path.join(directory, 'acknowledgment.json'))), acknowledgment), 'COMPLETION_CHANGED');
      assertFz3bPreflightRecoveryClosure(context as Context, proof as Proof, finalization as Finalization, ack as Ack, acknowledgment as Acknowledgment, closure as Closure);
      fail(typeof verifyClosure === 'function', 'TRUSTED_CLOSURE_VERIFIER_REQUIRED'); verifyClosure(structuredClone(ack), structuredClone(acknowledgment), structuredClone(closure));
      await this.prepared(context, proof, true); this.fresh(context, proof);
      await this.persist(path.join(directory, 'closure.json'), closure);
      this.verifySavedAck = value => {
        fail(same(value, ack), 'CERTIFIED_ACK_CHANGED');
        verifyClosure(value, structuredClone(acknowledgment), structuredClone(closure));
      };
      this.verifySavedClosure = verifyClosure;
      try { await this.assertNoRecoveryBarrier(); this.fresh(context, proof); }
      catch (error) { this.verifySavedAck = undefined; this.verifySavedClosure = undefined; throw error; }
      this.host.released();
    } finally { this.running = false; }
  }
  async assertNoRecoveryBarrier(): Promise<void> {
    await absent(path.join(this.host.root, barrier));
    let entries;
    try { await noLinks(path.join(this.host.root, folder)); entries = await readdir(path.join(this.host.root, folder), { withFileTypes: true }); }
    catch (error) { if (missing(error)) return; throw error; }
    // This reviewed recovery is deliberately one-shot for the exact sealed original operation.
    fail(entries.length <= 1, 'ATTEMPT_BUDGET');
    for (const entry of entries) {
      fail(entry.isDirectory() && !entry.isSymbolicLink(), 'ATTEMPT_KIND'); safePart(entry.name);
      const directory = path.join(this.host.root, folder, entry.name); await noLinks(directory);
      const files = await readdir(directory, { withFileTypes: true });
      const allowed = ['ack.json', 'acknowledgment-evidence.json', 'acknowledgment.json', 'closure.json', 'finalization-evidence.json', 'finalization.json', 'prepared-evidence.json', 'prepared.json', 'unlink-intent.json'];
      fail(files.length === allowed.length && files.every(file => file.isFile() && !file.isSymbolicLink() && allowed.includes(file.name)), 'ATTEMPT_FILES');
      const p = decode<Prepared>(await readBound(path.join(directory, 'prepared.json')));
      fail(p.context.id === entry.name, 'ATTEMPT_OWNER');
      const finalization = decode<Finalization>(await readBound(path.join(directory, 'finalization.json')));
      const ack = decode<Ack>(await readBound(path.join(directory, 'ack.json')));
      const a = decode<Acknowledgment>(await readBound(path.join(directory, 'acknowledgment.json')));
      const closure = decode<Closure>(await readBound(path.join(directory, 'closure.json')));
      await this.prepared(p.context, p.proof, false);
      assertFz3bPreflightRecoveryFinalization(p.context, p.proof, finalization); assertFz3bPreflightRecoveryAck(p.context, p.proof, finalization, ack);
      assertFz3bPreflightRecoveryAcknowledgment(p.context, p.proof, finalization, ack, a);
      assertFz3bPreflightRecoveryClosure(p.context, p.proof, finalization, ack, a, closure);
      fail(same(decode(await readBound(path.join(directory, 'unlink-intent.json'))), { schemaVersion: 1, contextSha256: fz3bPreflightDigest(p.context),
        proofSha256: fz3bPreflightDigest(p.proof), originalLeaseSha256: p.proof.originalLeaseSha256, state: 'intent-only-not-success' }), 'UNLINK_INTENT_CHANGED');
      fail(this.verifySavedAck, 'RESTART_ACK_AUTHENTICATION_REQUIRED'); this.verifySavedAck(ack);
      fail(this.verifySavedClosure, 'RESTART_CLOSURE_AUTHENTICATION_REQUIRED'); this.verifySavedClosure(ack, a, closure);
      const finalEvidence = await readBound(path.join(directory, 'finalization-evidence.json'));
      const { evidenceSha256: finalHash, ...finalBody } = finalization;
      fail(finalEvidence.sha256 === finalHash && same(decode(finalEvidence), finalBody), 'FINALIZATION_EVIDENCE_CHANGED');
      const ackEvidence = await readBound(path.join(directory, 'acknowledgment-evidence.json'));
      const { evidenceSha256: ackHash, ...ackBody } = a;
      fail(ackEvidence.sha256 === ackHash && same(decode(ackEvidence), ackBody), 'ACK_EVIDENCE_CHANGED');
    }
  }
}
