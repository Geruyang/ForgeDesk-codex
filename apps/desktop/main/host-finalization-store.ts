import * as fs from 'node:fs';
import { configuredFailedEmptyIntentRecovery, validateFailedEmptyIntentIsolation, type FailedEmptyIntentRecovery } from './host-failed-empty-intent';
import { incidentFailedIntentRequired } from './host-failed-empty-intent-main';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assertDesktopStore, DesktopStore } from './store';
import type { Fz3bEmptyHomeReceipt } from '../../../packages/shared/contracts';
import { FZ3B_HOST_FINALIZATION_DOMAIN, FZ3B_HOST_FINALIZATION_LIMITS as limits, FZ3B_HOST_FINALIZATION_PRODUCER,
  assertFz3bHostFinalizationBody, assertFz3bHostFinalizationCertificate, assertFz3bPreflightHostCompletionBinding,
  fz3bHostFinalizationDigest, fz3bHostTargetProjection,
  type Fz3bHostFinalizationBody, type Fz3bHostFinalizationCertificate, type Fz3bHostFinalizationExpected, type Fz3bPreflightHostCompletionBinding } from '../../../packages/engineering-runner/fz3b/host-finalization';
import { fz3bCanonicalJson } from '../../../packages/engineering-runner/fz3b/profile';
import { assertFz3bHostCompletionRead, consumeFz3bHostCompletionRead, type Fz3bBackend } from '../../../packages/engineering-runner/fz3b/backend';
import { fz3bHostDependencyAclSync, fz3bPrivateAclBatchSync, fz3bPrivateAclSync } from '../../../packages/engineering-runner/fz3b/credentials';

export type HostFinalizationStage = 'identity-written' | 'key-written' | 'desktop-written' | 'desktop-renamed' | 'desktop-readback' | 'checkpoint-written' | 'checkpoint-readback' | 'before-signing' | 'signing' | 'certificate-written' | 'certificate-readback';
interface TestObservation { now?: () => number; onStage?: (stage: HostFinalizationStage) => void; privateAcl?: typeof fz3bPrivateAclSync; privateAclBatch?: typeof fz3bPrivateAclBatchSync; dependencyAcl?: typeof fz3bHostDependencyAclSync }
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function fail(code: string): never { throw new Error(`FZ3B_HOST_FINALIZATION_${code}`); }
const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface Fz3bHostLocalProof { completion: Fz3bPreflightHostCompletionBinding; targetSha256: string }
export interface Fz3bEmptyHomeIntent {
  schemaVersion: 1; action: 'quarantine-empty-home'; nonce: string; createdAt: string; expiresAt: string;
  proof: Fz3bHostLocalProof; emptyDirectorySha256: string;
}
const instances = new WeakMap<object, { has(runId: string): Promise<boolean>; finish(runId: string): Promise<void>; readLocalProof(runId: string): Promise<Fz3bHostLocalProof>;
  canQuarantineEmptyHome(): boolean; assertLocalProof(proof: Fz3bHostLocalProof): void; prepareEmptyHome(runId: string): Promise<Fz3bEmptyHomeIntent>; quarantineEmptyHome(intent: Fz3bEmptyHomeIntent): Promise<Fz3bEmptyHomeReceipt> }>();

/** Only this main-only component can sign, after its own real, synchronous save path returns. */
export class Fz3bHostFinalizationStore {
  #store: DesktopStore;
  #root: string;
  #home: string;
  #identity: string;
  #directoryIdentity: { realpath: string; dev: number; ino: number; birthtimeMs: number };
  #sid: string;
  #readCompletion: (runId: string) => Promise<Fz3bPreflightHostCompletionBinding>;
  #backend: Fz3bBackend;
  #assertOwner: (binding: Fz3bPreflightHostCompletionBinding) => void;
  #busy = false;
  #observation: TestObservation;
  #acl: typeof fz3bPrivateAclSync;
  #aclBatch: typeof fz3bPrivateAclBatchSync;
  #dependencyAcl: typeof fz3bHostDependencyAclSync;
  #failedIntentRecovery?: FailedEmptyIntentRecovery;
  #emptyIntents = new WeakMap<object, { canonical: string; directory: string; used: boolean }>();
  #localProofs = new WeakMap<object, { binding: Fz3bPreflightHostCompletionBinding; dependency: () => void; canonical: string }>();
  constructor(store: DesktopStore, backend: Fz3bBackend, assertOwner: (binding: Fz3bPreflightHostCompletionBinding) => void, nativeSid: string, observation: TestObservation = {}, failedIntentRecovery?: FailedEmptyIntentRecovery) {
    assertDesktopStore(store);
    if (!backend || typeof backend.readPreflightHostCompletion !== 'function' || typeof assertOwner !== 'function' || !/^S-1-(?:\d+-)+\d+$/.test(nativeSid)) fail('COMPOSITION_REQUIRED');
    this.#store = store; this.#root = path.resolve(store.root); this.#home = path.join(this.#root, 'fz3b-host-finalization-v1');
    this.#readCompletion = backend.readPreflightHostCompletion.bind(backend); this.#backend = backend; this.#assertOwner = assertOwner; this.#sid = nativeSid;
    this.#observation = observation;
    this.#failedIntentRecovery = failedIntentRecovery;
    if (Boolean(observation.privateAcl) !== Boolean(observation.privateAclBatch)) fail('TEST_ACL_PAIR_REQUIRED');
    this.#acl = observation.privateAcl ?? fz3bPrivateAclSync;
    this.#aclBatch = observation.privateAclBatch ?? fz3bPrivateAclBatchSync;
    this.#dependencyAcl = observation.dependencyAcl ?? fz3bHostDependencyAclSync;
    this.directories(this.#root);
    const stat = fs.lstatSync(this.#root);
    this.#directoryIdentity = { realpath: fs.realpathSync(this.#root), dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
    this.#identity = '';
    instances.set(this, { has: runId => originalHas.call(this, runId), finish: runId => originalFinish.call(this, runId), readLocalProof: runId => originalReadLocalProof.call(this, runId),
      canQuarantineEmptyHome: () => originalCanQuarantineEmptyHome.call(this), assertLocalProof: proof => originalAssertLocalProof.call(this, proof), prepareEmptyHome: runId => originalPrepareEmptyHome.call(this, runId), quarantineEmptyHome: intent => originalQuarantineEmptyHome.call(this, intent) });
  }
  private nativeRole<T>(role: string, action: () => T): T {
    try { return action(); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'FAILED';
      fail(`ACL_${role}_${/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'FAILED'}`);
    }
  }
  private protect(file: string, role: string) { this.nativeRole(role, () => this.#acl(file, this.#sid, true)); }
  private directories(directory: string) {
    let current = path.resolve(directory);
    for (;;) {
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) fail('DIRECTORY_LINK');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
  private rootIdentity() {
    this.directories(this.#root);
    const stat = fs.lstatSync(this.#root), current = { realpath: fs.realpathSync(this.#root), dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs };
    if (path.resolve(this.#store.root) !== this.#root || fz3bHostFinalizationDigest(current) !== fz3bHostFinalizationDigest(this.#directoryIdentity)) fail('STORE_IDENTITY_CHANGED');
    return current;
  }
  private identity() {
    const current = this.rootIdentity();
    if (fs.existsSync(this.#home)) {
      const metadata = JSON.parse(this.read(path.join(this.#home, 'identity.json'), 16384).toString('utf8'));
      if (!metadata || Object.keys(metadata).sort().join(',') !== 'directory,schemaVersion,sid,storeId' || metadata.schemaVersion !== 1 || !uuid.test(metadata.storeId) || metadata.sid !== this.#sid ||
          fz3bHostFinalizationDigest(metadata.directory) !== fz3bHostFinalizationDigest(current)) fail('STORE_IDENTITY_CHANGED');
      this.#identity = fz3bHostFinalizationDigest(metadata);
    }
  }
  private read(file: string, max: number): Buffer {
    this.directories(path.dirname(file));
    const named = fs.lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size <= 0 || named.size > max) fail('FILE_BUDGET_OR_LINK');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(fd); if (!sameFile(named, before)) fail('FILE_CHANGED');
      const bytes = Buffer.alloc(before.size + 1); let count = 0;
      while (count < bytes.length) { const read = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
      const after = fs.fstatSync(fd), final = fs.lstatSync(file);
      if (count !== before.size || !sameFile(before, after) || !sameFile(after, final)) fail('FILE_CHANGED');
      return bytes.subarray(0, count);
    } finally { fs.closeSync(fd); }
  }
  private entries(directory: string, max: number): fs.Dirent[] {
    this.directories(directory); const handle = fs.opendirSync(directory), entries: fs.Dirent[] = [];
    try { for (;;) { const item = handle.readSync(); if (!item) break; if (entries.length >= max) fail('INVENTORY_BUDGET'); entries.push(item); } }
    finally { handle.closeSync(); }
    return entries;
  }
  private inventory(): string[] {
    if (!fs.existsSync(this.#home)) return [];
    const certificates: string[] = []; let checkpointBytes = 0, checkpoints = 0;
    for (const entry of this.entries(this.#home, limits.certificateEntries + 2)) {
      if (entry.name === 'key.bin') { this.read(path.join(this.#home, entry.name), 32); continue; }
      if (entry.name === 'identity.json') { this.read(path.join(this.#home, entry.name), 16384); continue; }
      if (!entry.isDirectory() || !uuid.test(entry.name)) fail('INVENTORY_NAME');
      for (const file of this.entries(path.join(this.#home, entry.name), limits.certificateEntries * 2)) {
        const match = /^([a-f0-9-]{36})\.(desktop|certificate)\.json$/.exec(file.name);
        if (!match || !uuid.test(match[1]) || !file.isFile()) fail('INVENTORY_NAME');
        const full = path.join(this.#home, entry.name, file.name);
        if (match[2] === 'certificate') {
          this.read(full, limits.certificateBytes); certificates.push(full);
          if (certificates.length > limits.certificateEntries) fail('INVENTORY_BUDGET');
        } else {
          const bytes = this.read(full, limits.snapshotBytes); checkpointBytes += bytes.length; checkpoints++;
          if (checkpoints > limits.certificateEntries || checkpointBytes > limits.checkpointTotalBytes) fail('INVENTORY_BUDGET');
        }
      }
    }
    return certificates;
  }
  private discoverPrivateFiles() {
    if (!fs.existsSync(this.#home)) return [];
    const names = [this.#home, path.join(this.#home, 'identity.json'), path.join(this.#home, 'key.bin')];
    let checkpoints = 0, certificates = 0;
    for (const entry of this.entries(this.#home, limits.certificateEntries + 2)) {
      if (entry.name === 'key.bin' || entry.name === 'identity.json') continue;
      if (!entry.isDirectory() || !uuid.test(entry.name)) fail('INVENTORY_NAME');
      const directory = path.join(this.#home, entry.name); names.push(directory);
      for (const file of this.entries(directory, limits.certificateEntries * 2)) {
        const match = /^([a-f0-9-]{36})\.(desktop|certificate)\.json$/.exec(file.name);
        if (!match || !uuid.test(match[1]) || !file.isFile()) fail('INVENTORY_NAME');
        if (match[2] === 'certificate') certificates++; else checkpoints++;
        if (certificates > limits.certificateEntries || checkpoints > limits.certificateEntries) fail('INVENTORY_BUDGET');
        names.push(path.join(directory, file.name));
      }
    }
    if (names.length > 51) fail('INVENTORY_BUDGET');
    return names.sort().map(name => {
      this.directories(path.dirname(name)); const stat = fs.lstatSync(name);
      if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('FILE_BUDGET_OR_LINK');
      return { name, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode, nlink: stat.nlink };
    });
  }
  private readOnlyPhase<T>(action: () => T, afterNative: () => void = () => {}): T {
    const before = this.discoverPrivateFiles(), digest = fz3bHostFinalizationDigest(before);
    if (before.length) { this.nativeRole('PRIVATE_INVENTORY_READ', () => this.#aclBatch(before.map(file => file.name), this.#sid)); afterNative(); }
    const recheck = () => { if (fz3bHostFinalizationDigest(this.discoverPrivateFiles()) !== digest) fail('PRIVATE_INVENTORY_CHANGED'); };
    recheck(); const result = action(); recheck(); return result;
  }
  private target(bytes: Buffer | undefined, binding: Fz3bPreflightHostCompletionBinding) {
    const data = bytes ? JSON.parse(bytes.toString('utf8')) : { schemaVersion: 1, projects: this.#store.projects, sessions: this.#store.sessions };
    if (!data || Object.keys(data).sort().join(',') !== 'projects,schemaVersion,sessions' || data.schemaVersion !== 1 || !Array.isArray(data.projects) || !Array.isArray(data.sessions)) fail('DESKTOP_SCHEMA');
    const sessions = data.sessions.filter((item: any) => item?.id === binding.owner.sessionId || item?.taskId === binding.owner.taskId);
    if (sessions.length !== 1) fail('TARGET_OWNER');
    const projects = data.projects.filter((item: any) => item?.id === sessions[0].projectId);
    if (projects.length !== 1) fail('TARGET_OWNER');
    return fz3bHostTargetProjection(projects[0], sessions[0], binding);
  }
  private expected(): Fz3bHostFinalizationExpected { return { storeIdentitySha256: this.#identity, producerVersion: FZ3B_HOST_FINALIZATION_PRODUCER }; }
  private dependency() {
    const names = [this.#root, path.join(this.#root, 'fz3b-agent'), path.join(this.#root, 'fz3b-agent', 'binding.key')];
    const capture = () => names.map((name, index) => {
      this.directories(index === 2 ? path.dirname(name) : name);
      const stat = fs.lstatSync(name);
      if (stat.isSymbolicLink() || index === 2 && (!stat.isFile() || stat.nlink !== 1)) fail('DEPENDENCY_IDENTITY');
      return { realpath: fs.realpathSync(name), dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, ctimeMs: index === 0 ? null : stat.ctimeMs, mode: stat.mode };
    });
    const before = fz3bHostFinalizationDigest(capture());
    this.nativeRole('DEPENDENCY_READ', () => this.#dependencyAcl(this.#root, this.#sid));
    const recheck = () => { if (fz3bHostFinalizationDigest(capture()) !== before) fail('DEPENDENCY_IDENTITY_CHANGED'); };
    recheck(); return recheck;
  }
  private key(): Buffer {
    const key = this.read(path.join(this.#home, 'key.bin'), 32); if (key.length !== 32) fail('KEY_INVALID'); return key;
  }
  /** Authenticates local closure without opening, repairing or creating host certificate state. */
  async readLocalProof(runId: string): Promise<Fz3bHostLocalProof> {
    if (typeof runId !== 'string' || !uuid.test(runId) || this.#busy) fail('EXACT_IDLE_RUN_REQUIRED');
    const dependency = this.dependency();
    const completion = await this.#readCompletion(runId);
    dependency(); assertFz3bHostCompletionRead(completion, this.#backend, this.#root);
    this.owner(completion);
    const targetSha256 = fz3bHostFinalizationDigest(this.target(undefined, completion));
    dependency(); assertFz3bHostCompletionRead(completion, this.#backend, this.#root);
    const proof = { completion: structuredClone(completion), targetSha256 };
    this.#localProofs.set(proof, { binding: completion, dependency, canonical: fz3bCanonicalJson(proof) });
    return proof;
  }
  assertLocalProof(proof: Fz3bHostLocalProof): void {
    const witness = this.#localProofs.get(proof);
    if (!witness || fz3bCanonicalJson(proof) !== witness.canonical) fail('LOCAL_PROOF_PROVENANCE');
    witness.dependency(); assertFz3bHostCompletionRead(witness.binding, this.#backend, this.#root); this.owner(witness.binding);
    if (fz3bHostFinalizationDigest(this.target(undefined, witness.binding)) !== proof.targetSha256) fail('LOCAL_PROOF_TARGET_CHANGED');
  }
  private emptyHomeIdentity(): string {
    this.rootIdentity(); this.directories(this.#home);
    const stat = fs.lstatSync(this.#home);
    if (this.entries(this.#home, 1).length) fail('HOME_NOT_EMPTY');
    return fz3bCanonicalJson({ root: this.#directoryIdentity, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs,
      ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, mode: stat.mode, nlink: stat.nlink });
  }
  canQuarantineEmptyHome(): boolean {
    try { this.emptyHomeIdentity(); return !this.#busy; } catch { return false; }
  }
  private validateQuarantines(binding: Fz3bPreflightHostCompletionBinding, targetSha256: string, afterNative: () => void = () => {}) {
    const failedNamespace = this.entries(this.#root, 256).filter(entry => entry.name.startsWith('fz3b-host-failed-'));
    const recovery = this.#failedIntentRecovery ?? configuredFailedEmptyIntentRecovery();
    if (recovery) {
      validateFailedEmptyIntentIsolation(recovery, { completion: binding, targetSha256 });
      afterNative();
    } else if (failedNamespace.length || incidentFailedIntentRequired(this.#root, binding.owner.runId)) {
      fail('FAILED_INTENT_NATIVE_GATE_REQUIRED');
    }
    const names = this.entries(this.#root, 256).filter(entry => entry.name.startsWith('fz3b-host-empty-') || entry.name.startsWith('fz3b-host-quarantine-'));
    if (names.length > 24) fail('EMPTY_INTENT_BUDGET');
    const nonces = new Set<string>();
    for (const entry of names) {
      const match = /^(?:fz3b-host-empty-([a-f0-9]{64})\.(?:intent|verified)\.json|fz3b-host-quarantine-([a-f0-9]{64}))$/.exec(entry.name);
      if (!match) fail('EMPTY_INVENTORY_NAME'); nonces.add(match[1] ?? match[2]);
    }
    if (nonces.size > 8 || names.length !== nonces.size * 3) fail('EMPTY_INTENT_INCOMPLETE');
    const discover = () => {
      const current = this.entries(this.#root, 256).filter(entry => entry.name.startsWith('fz3b-host-empty-') || entry.name.startsWith('fz3b-host-quarantine-')).map(entry => entry.name).sort();
      if (fz3bCanonicalJson(current) !== fz3bCanonicalJson(names.map(entry => entry.name).sort())) fail('EMPTY_INVENTORY_CHANGED');
      const paths = current.map(name => path.join(this.#root, name));
      for (const nonce of nonces) paths.push(path.join(this.#root, `fz3b-host-quarantine-${nonce}`, 'preserved-empty-home'));
      return paths.sort().map(name => {
        this.directories(path.dirname(name)); const stat = fs.lstatSync(name);
        if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) fail('EMPTY_INVENTORY_LINK');
        return { name, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, size: stat.size, nlink: stat.nlink, mode: stat.mode };
      });
    };
    const before = discover(), identity = fz3bCanonicalJson(before);
    if (before.length) {
      // Preserve the old empty leaf's ACL; only the new private container and audit files are ours.
      this.nativeRole('QUARANTINE_READ', () => this.#aclBatch(before.filter(item => path.basename(item.name) !== 'preserved-empty-home').map(item => item.name), this.#sid)); afterNative();
    }
    const recheck = () => { if (fz3bCanonicalJson(discover()) !== identity) fail('EMPTY_INVENTORY_CHANGED'); };
    recheck();
    for (const nonce of nonces) {
      const journal = this.read(path.join(this.#root, `fz3b-host-empty-${nonce}.intent.json`), 65536);
      const intent = JSON.parse(journal.toString('utf8'));
      const receipt = JSON.parse(this.read(path.join(this.#root, `fz3b-host-empty-${nonce}.verified.json`), 16384).toString('utf8'));
      const directory = path.join(this.#root, `fz3b-host-quarantine-${nonce}`), preserved = path.join(directory, 'preserved-empty-home');
      this.directories(directory); this.directories(preserved);
      const children = this.entries(directory, 1);
      if (children.length !== 1 || children[0].name !== 'preserved-empty-home' || this.entries(preserved, 1).length) fail('QUARANTINE_NOT_EMPTY');
      const stat = fs.lstatSync(preserved);
      const identity = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, mode: stat.mode, nlink: stat.nlink };
      if (Object.keys(intent).sort().join(',') !== 'action,canonicalHome,createdAt,directoryIdentity,emptyDirectorySha256,expiresAt,nonce,preservedDirectory,proof,schemaVersion' ||
          Object.keys(intent.proof ?? {}).sort().join(',') !== 'completion,targetSha256' || Date.parse(intent.expiresAt) - Date.parse(intent.createdAt) !== 300000 ||
          intent.emptyDirectorySha256 !== sha(Buffer.from(fz3bCanonicalJson(intent.directoryIdentity))) ||
          Object.keys(receipt).sort().join(',') !== 'directory,intentSha256,nonce,schemaVersion' || receipt.schemaVersion !== 1 || receipt.nonce !== nonce || receipt.intentSha256 !== sha(journal) ||
          fz3bCanonicalJson(receipt.directory) !== fz3bCanonicalJson(identity) || intent.nonce !== nonce || intent.schemaVersion !== 1 || intent.action !== 'quarantine-empty-home' ||
          intent.canonicalHome !== 'fz3b-host-finalization-v1' || intent.preservedDirectory !== `fz3b-host-quarantine-${nonce}/preserved-empty-home` ||
          intent.proof?.targetSha256 !== targetSha256 || fz3bCanonicalJson(intent.proof?.completion) !== fz3bCanonicalJson(binding) ||
          intent.directoryIdentity?.dev !== stat.dev || intent.directoryIdentity?.ino !== stat.ino || intent.directoryIdentity?.birthtimeMs !== stat.birthtimeMs ||
          fz3bCanonicalJson(intent.directoryIdentity?.root) !== fz3bCanonicalJson(this.#directoryIdentity)) fail('QUARANTINE_PROOF_CHANGED');
    }
    recheck();
  }
  async prepareEmptyHome(runId: string): Promise<Fz3bEmptyHomeIntent> {
    const proof = await originalReadLocalProof.call(this, runId), directory = this.emptyHomeIdentity();
    const created = Date.now();
    const intent: Fz3bEmptyHomeIntent = { schemaVersion: 1, action: 'quarantine-empty-home', nonce: randomBytes(32).toString('hex'),
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString(), proof,
      emptyDirectorySha256: sha(Buffer.from(directory)) };
    this.#emptyIntents.set(intent, { canonical: fz3bCanonicalJson(intent), directory, used: false });
    return intent;
  }
  async quarantineEmptyHome(intent: Fz3bEmptyHomeIntent): Promise<Fz3bEmptyHomeReceipt> {
    const witness = this.#emptyIntents.get(intent);
    if (!witness || witness.used) fail('EMPTY_INTENT_INVALID_OR_USED');
    witness.used = true;
    const fresh = () => {
      const time = Date.now();
      if (fz3bCanonicalJson(intent) !== witness.canonical || time < Date.parse(intent.createdAt) || time >= Date.parse(intent.expiresAt)) fail('EMPTY_INTENT_CHANGED_OR_EXPIRED');
      if (this.emptyHomeIdentity() !== witness.directory) fail('EMPTY_DIRECTORY_CHANGED');
    };
    fresh();
    const proof = await originalReadLocalProof.call(this, intent.proof.completion.owner.runId);
    if (fz3bCanonicalJson(proof) !== fz3bCanonicalJson(intent.proof)) fail('EMPTY_COMPLETION_CHANGED');
    fresh();
    if (this.#busy) fail('WRITE_PENDING');
    this.#busy = true;
    try {
      const now = this.#observation.now ?? Date.now, started = now(); let prior = started;
      const budget = () => { const time = now(); if (time < prior || time - prior > 5000 || time - started > 60000) fail('STAGE_BUDGET'); prior = time; };
      const check = () => { budget(); fresh(); originalAssertLocalProof.call(this, proof); };
      check();
      const existing = this.entries(this.#root, 256).filter(entry => entry.name.startsWith('fz3b-host-empty-') || entry.name.startsWith('fz3b-host-quarantine-'));
      if (existing.length >= 24) fail('EMPTY_INTENT_BUDGET');
      this.validateQuarantines(proof.completion, proof.targetSha256, check);
      const journal = path.join(this.#root, `fz3b-host-empty-${intent.nonce}.intent.json`);
      const quarantine = path.join(this.#root, `fz3b-host-quarantine-${intent.nonce}`);
      if (fs.existsSync(journal) || fs.existsSync(quarantine)) fail('EMPTY_INTENT_ALREADY_EXISTS');
      const bytes = Buffer.from(JSON.stringify({ ...intent, directoryIdentity: JSON.parse(witness.directory), canonicalHome: 'fz3b-host-finalization-v1', preservedDirectory: `fz3b-host-quarantine-${intent.nonce}/preserved-empty-home` }));
      if (bytes.length > 65536) fail('EMPTY_INTENT_BUDGET');
      const fd = fs.openSync(journal, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { this.protect(journal, 'EMPTY_INTENT_PROTECT'); check(); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); check(); }
      finally { fs.closeSync(fd); }
      if (!this.read(journal, 65536).equals(bytes)) fail('EMPTY_INTENT_READBACK');
      check();
      fs.mkdirSync(quarantine); this.protect(quarantine, 'QUARANTINE_PROTECT');
      check();
      const destination = path.join(quarantine, 'preserved-empty-home');
      if (this.entries(quarantine, 1).length || fs.existsSync(destination)) fail('QUARANTINE_NOT_EMPTY');
      fs.renameSync(this.#home, destination);
      const moved = fs.lstatSync(destination), original = JSON.parse(witness.directory);
      if (moved.dev !== original.dev || moved.ino !== original.ino || moved.birthtimeMs !== original.birthtimeMs || this.entries(destination, 1).length || fs.existsSync(this.#home)) fail('QUARANTINE_IDENTITY_CHANGED');
      const preserved = () => {
        this.directories(destination);
        if (!sameFile(moved, fs.lstatSync(destination)) || this.entries(destination, 1).length || fs.existsSync(this.#home)) fail('QUARANTINE_IDENTITY_CHANGED');
      };
      if (!this.read(journal, 65536).equals(bytes)) fail('EMPTY_INTENT_READBACK');
      const receipt = Buffer.from(JSON.stringify({ schemaVersion: 1, nonce: intent.nonce, intentSha256: sha(bytes), directory: {
        dev: moved.dev, ino: moved.ino, birthtimeMs: moved.birthtimeMs, ctimeMs: moved.ctimeMs, mtimeMs: moved.mtimeMs, mode: moved.mode, nlink: moved.nlink,
      } }));
      budget(); originalAssertLocalProof.call(this, proof); preserved();
      const receiptFile = path.join(this.#root, `fz3b-host-empty-${intent.nonce}.verified.json`);
      const receiptFd = fs.openSync(receiptFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { this.protect(receiptFile, 'EMPTY_RECEIPT_PROTECT'); budget(); originalAssertLocalProof.call(this, proof); preserved(); fs.writeFileSync(receiptFd, receipt); fs.fsyncSync(receiptFd); budget(); preserved(); }
      finally { fs.closeSync(receiptFd); }
      if (!this.read(receiptFile, 16384).equals(receipt)) fail('EMPTY_RECEIPT_READBACK');
      const finished = now(); if (finished < prior || finished - prior > 5000 || finished - started > 60000) fail('STAGE_BUDGET');
      originalAssertLocalProof.call(this, proof); this.validateQuarantines(proof.completion, proof.targetSha256, budget); budget(); originalAssertLocalProof.call(this, proof);
      preserved();
      // The preserved directory is never adopted as authority. A later explicit finish starts absent-home initialization afresh.
      return { schemaVersion: 1, nonce: intent.nonce, canonicalHomeAbsent: true, preservedEmpty: true, intentSha256: sha(bytes) };
    } finally { this.#busy = false; }
  }
  private certificate(file: string, key: Buffer): Fz3bHostFinalizationCertificate {
    const cert: unknown = JSON.parse(this.read(file, limits.certificateBytes).toString('utf8'));
    const binding = (cert as Fz3bHostFinalizationCertificate)?.completion;
    assertFz3bHostFinalizationCertificate(cert, binding, this.expected());
    const { mac, ...body } = cert;
    const expected = createHmac('sha256', key).update(FZ3B_HOST_FINALIZATION_DOMAIN).update(fz3bCanonicalJson(body)).digest();
    const actual = Buffer.from(mac, 'hex'); if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('CERTIFICATE_MAC');
    if (file !== path.join(this.#home, binding.owner.runId, `${cert.certificateId}.certificate.json`)) fail('CERTIFICATE_PATH');
    const snapshot = this.read(path.join(this.#home, cert.snapshot.checkpointFile), limits.snapshotBytes);
    if (snapshot.length !== cert.snapshot.bytes || sha(snapshot) !== cert.snapshot.sha256 || fz3bHostFinalizationDigest(this.target(snapshot, binding)) !== cert.targetSha256) fail('CHECKPOINT_CHANGED');
    return cert;
  }
  /** Read-only, including when files/key are absent or corrupt. No bootstrap or repair. */
  async has(runId: string): Promise<boolean> {
    const dependency = this.dependency();
    const binding = await this.#readCompletion(runId);
    dependency();
    assertFz3bHostCompletionRead(binding, this.#backend, this.#root);
    this.owner(binding); const result = this.readOnlyPhase(() => this.#has(binding));
    dependency(); assertFz3bHostCompletionRead(binding, this.#backend, this.#root); return result;
  }
  private owner(binding: Fz3bPreflightHostCompletionBinding) {
    if (this.#assertOwner(binding) !== undefined) fail('SYNCHRONOUS_OWNER_REQUIRED');
  }
  #has(binding: Fz3bPreflightHostCompletionBinding, afterNative: () => void = () => {}): boolean {
    assertFz3bPreflightHostCompletionBinding(binding);
    this.validateQuarantines(binding, fz3bHostFinalizationDigest(this.target(undefined, binding)), afterNative); this.identity();
    const files = this.inventory(); if (!files.length) return false;
    const key = this.key(), current = fz3bHostFinalizationDigest(this.target(undefined, binding));
    const onDisk = fz3bHostFinalizationDigest(this.target(this.read(path.join(this.#root, 'desktop.json'), limits.snapshotBytes), binding));
    let match = false;
    for (const file of files) {
      const cert = this.certificate(file, key);
      if (fz3bHostFinalizationDigest(cert.completion) === fz3bHostFinalizationDigest(binding) && cert.targetSha256 === current && current === onDisk) match = true;
    }
    return match;
  }
  /** No saved flag, raw receipt, signer callback or caller-selected path is accepted. */
  async finish(runId: string): Promise<void> {
    if (typeof runId !== 'string' || !uuid.test(runId)) fail('EXACT_RUN_REQUIRED');
    const dependency = this.dependency();
    const binding = await this.#readCompletion(runId);
    dependency();
    assertFz3bHostCompletionRead(binding, this.#backend, this.#root);
    this.owner(binding); this.#commit(binding, dependency);
    dependency();
    assertFz3bHostCompletionRead(binding, this.#backend, this.#root);
  }
  #commit(binding: Fz3bPreflightHostCompletionBinding, dependency: () => void): void {
    if (this.#busy) fail('WRITE_PENDING');
    this.#busy = true;
    const now = this.#observation.now ?? Date.now, started = now(); let prior = started;
    const checkTime = () => { const time = now(); if (time < prior || time - prior > 5000 || time - started > 60000) fail('STAGE_BUDGET'); prior = time; };
    const stage = (value: HostFinalizationStage) => { this.#observation.onStage?.(value); checkTime(); };
    const writeNew = (file: string, bytes: Buffer, value: HostFinalizationStage) => {
      this.directories(path.dirname(file));
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        this.protect(file, value.toUpperCase().replaceAll('-', '_')); checkTime();
        let written = 0; while (written < bytes.length) { const count = fs.writeSync(fd, bytes, written, bytes.length - written); if (!count) fail('SHORT_WRITE'); written += count; }
        stage(value); fs.fsyncSync(fd); checkTime();
      } finally { fs.closeSync(fd); }
    };
    try {
      assertFz3bPreflightHostCompletionBinding(binding); this.rootIdentity(); checkTime();
      const target = this.target(undefined, binding), targetSha256 = fz3bHostFinalizationDigest(target);
      this.validateQuarantines(binding, targetSha256, checkTime); checkTime();
      let key!: Buffer;
      if (fs.existsSync(this.#home)) {
        const reused = this.readOnlyPhase(() => {
          this.identity(); const files = this.inventory(); key = this.key();
          if (files.length) {
            if (this.#has(binding, checkTime)) return true;
            for (const file of files) {
              const existing = this.certificate(file, key);
              if (fz3bHostFinalizationDigest(existing.completion) === fz3bHostFinalizationDigest(binding) &&
                  (existing.targetSha256 !== targetSha256 || existing.targetSha256 !== fz3bHostFinalizationDigest(this.target(this.read(path.join(this.#root, 'desktop.json'), limits.snapshotBytes), binding)))) fail('TARGET_HISTORY_CHANGED');
            }
            fail('EXISTING_CERTIFICATE_MISMATCH');
          }
          return false;
        }, checkTime);
        if (reused) { assertFz3bHostCompletionRead(binding, this.#backend, this.#root); return; }
      } else {
        fs.mkdirSync(this.#home); this.directories(this.#home);
        this.protect(this.#home, 'HOME_PROTECT'); checkTime();
        writeNew(path.join(this.#home, 'identity.json'), Buffer.from(JSON.stringify({ schemaVersion: 1, storeId: randomUUID(), sid: this.#sid, directory: this.#directoryIdentity })), 'identity-written'); this.identity();
        writeNew(path.join(this.#home, 'key.bin'), randomBytes(32), 'key-written'); key = this.key();
      }
      const id = randomUUID();
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, projects: this.#store.projects, sessions: this.#store.sessions }));
      if (!bytes.length || bytes.length > limits.snapshotBytes) fail('SNAPSHOT_BUDGET');
      const temporary = path.join(this.#root, `.host-terminal-${id}.tmp`), desktop = path.join(this.#root, 'desktop.json');
      if (fs.existsSync(desktop)) this.read(desktop, limits.snapshotBytes);
      writeNew(temporary, bytes, 'desktop-written');
      fs.renameSync(temporary, desktop); stage('desktop-renamed');
      // Reopen and sync the published file, then verify named/handle identity and exact bytes.
      const fd = fs.openSync(desktop, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const saved = this.read(desktop, limits.snapshotBytes);
      if (!saved.equals(bytes)) fail('DESKTOP_READBACK'); stage('desktop-readback');
      if (fz3bHostFinalizationDigest(this.target(undefined, binding)) !== targetSha256) fail('TARGET_CHANGED');
      const runDirectory = path.join(this.#home, binding.owner.runId);
      if (!fs.existsSync(runDirectory)) { fs.mkdirSync(runDirectory); this.protect(runDirectory, 'RUN_DIRECTORY_PROTECT'); checkTime(); }
      const checkpointFile = `${binding.owner.runId}/${id}.desktop.json`;
      writeNew(path.join(this.#home, checkpointFile), saved, 'checkpoint-written');
      if (!this.read(path.join(this.#home, checkpointFile), limits.snapshotBytes).equals(saved)) fail('CHECKPOINT_READBACK'); stage('checkpoint-readback');
      if (fz3bHostFinalizationDigest(this.target(undefined, binding)) !== targetSha256 || !this.read(desktop, limits.snapshotBytes).equals(saved)) fail('TARGET_CHANGED');
      const body: Fz3bHostFinalizationBody = { schemaVersion: 1, method: 'fz3b-preflight-host-finalization-v1', certificateId: id,
        issuedAt: new Date(now()).toISOString(), producerVersion: FZ3B_HOST_FINALIZATION_PRODUCER, storeIdentitySha256: this.#identity,
        completion: structuredClone(binding), target, targetSha256, snapshot: { sha256: sha(saved), bytes: saved.length, checkpointSha256: sha(saved), checkpointFile } };
      stage('before-signing');
      this.readOnlyPhase(() => {
        this.inventory(); this.identity(); this.owner(binding);
        if (!timingSafeEqual(this.key(), key) || fz3bHostFinalizationDigest(this.target(undefined, binding)) !== targetSha256 || !this.read(desktop, limits.snapshotBytes).equals(saved) ||
            !this.read(path.join(this.#home, checkpointFile), limits.snapshotBytes).equals(saved) || fz3bHostFinalizationDigest(body.completion) !== fz3bHostFinalizationDigest(binding)) fail('TARGET_CHANGED');
        assertFz3bHostFinalizationBody(body, binding, this.expected());
        this.validateQuarantines(binding, targetSha256, checkTime);
        dependency(); checkTime(); consumeFz3bHostCompletionRead(binding, this.#backend, this.#root);
      }, checkTime);
      checkTime();
      const cert: Fz3bHostFinalizationCertificate = { ...body, mac: createHmac('sha256', key).update(FZ3B_HOST_FINALIZATION_DOMAIN).update(fz3bCanonicalJson(body)).digest('hex') };
      stage('signing');
      assertFz3bHostFinalizationCertificate(cert, binding, this.expected());
      const certificateBytes = Buffer.from(JSON.stringify(cert)); if (certificateBytes.length > limits.certificateBytes) fail('CERTIFICATE_BUDGET');
      const certificateFile = path.join(runDirectory, `${id}.certificate.json`);
      writeNew(certificateFile, certificateBytes, 'certificate-written');
      this.readOnlyPhase(() => {
        if (!timingSafeEqual(this.key(), key)) fail('KEY_INVALID');
        this.certificate(certificateFile, key); stage('certificate-readback');
        if (!this.#has(binding, checkTime)) fail('CERTIFICATE_READBACK');
      }, checkTime); checkTime();
    } finally { this.#busy = false; }
  }
}
const originalHas = Fz3bHostFinalizationStore.prototype.has;
const originalFinish = Fz3bHostFinalizationStore.prototype.finish;
const originalReadLocalProof = Fz3bHostFinalizationStore.prototype.readLocalProof;
const originalAssertLocalProof = Fz3bHostFinalizationStore.prototype.assertLocalProof;
const originalCanQuarantineEmptyHome = Fz3bHostFinalizationStore.prototype.canQuarantineEmptyHome;
const originalPrepareEmptyHome = Fz3bHostFinalizationStore.prototype.prepareEmptyHome;
const originalQuarantineEmptyHome = Fz3bHostFinalizationStore.prototype.quarantineEmptyHome;

export function hasFz3bHostFinalization(component: Fz3bHostFinalizationStore, runId: string): Promise<boolean> {
  const value = instances.get(component); if (!value) fail('REAL_COMPONENT_REQUIRED'); return value.has(runId);
}
export function finishFz3bHostFinalization(component: Fz3bHostFinalizationStore, runId: string): Promise<void> {
  const value = instances.get(component); if (!value) fail('REAL_COMPONENT_REQUIRED'); return value.finish(runId);
}
export function readFz3bHostLocalProof(component: Fz3bHostFinalizationStore, runId: string): Promise<Fz3bHostLocalProof> {
  const value = instances.get(component); if (!value) fail('REAL_COMPONENT_REQUIRED'); return value.readLocalProof(runId);
}
export function assertFz3bHostLocalProof(component: Fz3bHostFinalizationStore, proof: Fz3bHostLocalProof): void {
  const value = instances.get(component); if (!value) fail('REAL_COMPONENT_REQUIRED'); value.assertLocalProof(proof);
}
export function canQuarantineFz3bEmptyHome(component: Fz3bHostFinalizationStore): boolean {
  const value = instances.get(component); if (!value) fail('REAL_COMPONENT_REQUIRED'); return value.canQuarantineEmptyHome();
}
export function prepareFz3bEmptyHome(component: Fz3bHostFinalizationStore, runId: string): Promise<Fz3bEmptyHomeIntent> {
  const value = instances.get(component); if (!value) fail('REAL_COMPONENT_REQUIRED'); return value.prepareEmptyHome(runId);
}
export function quarantineFz3bEmptyHome(component: Fz3bHostFinalizationStore, intent: Fz3bEmptyHomeIntent): Promise<Fz3bEmptyHomeReceipt> {
  const value = instances.get(component); if (!value) fail('REAL_COMPONENT_REQUIRED'); return value.quarantineEmptyHome(intent);
}

export function createFz3bHostFinalizationStore(store: DesktopStore, backend: Fz3bBackend, assertOwner: (binding: Fz3bPreflightHostCompletionBinding) => void, nativeSid: string, failedIntentRecovery?: FailedEmptyIntentRecovery): Fz3bHostFinalizationStore {
  return new Fz3bHostFinalizationStore(store, backend, assertOwner, nativeSid, {}, failedIntentRecovery);
}
