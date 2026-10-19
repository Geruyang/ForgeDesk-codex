import { mkdir, open, readFile, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { durableJson, noLinks, safePart } from '../embedded/files.js';
import { fz3bCanonicalJson, fz3bDigest, fz3bProfileSha256, FZ3B_HOST_KEY_SHA256, validateFz3bIdentity } from './profile.js';
import { loadFz3bResourceBundle } from './resources.js';
import { legacyInspectPayload, LEGACY_INSPECT_RESOURCE_SHA256 } from './payload.js';
import { assertFz3bReconciliationProof, fz3bReconciliationDigest as hash } from './reconciliation.js';
import type { Fz3bAdapterContext, Fz3bIdentity, Fz3bInspectReconciliationContext, Fz3bInspectReconciliationProof,
  Fz3bInspectReconciliationFinalization, Fz3bLocalProcessState } from './types.js';

interface Transport { spawned: boolean; processExited: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }
interface Host {
  resourceRoot: string; root: string; children: () => number; released: () => void;
  projectKey: () => Promise<string>;
  transport: (input: Buffer, key: string, knownHosts: string, directory: string) => Promise<Transport>;
}
const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function demand(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function readBound(file: string, limit = 131072) {
  await noLinks(file); const info = await lstat(file);
  demand(info.isFile() && info.nlink === 1 && info.size <= limit, 'FZ3B_RECONCILIATION_FILE_UNTRUSTED');
  const bytes = await readFile(file); demand(bytes.length <= limit, 'FZ3B_RECONCILIATION_FILE_BUDGET');
  return { bytes, value: JSON.parse(bytes.toString('utf8')), sha256: fz3bDigest(bytes) };
}
function publicIdentity(value: any): Fz3bIdentity {
  const answer: Fz3bIdentity = { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: value?.bootId, appRoot: value?.appRoot,
    platform: value?.platform, contractId: value?.contractId, deployedManifestSha256: value?.deployedManifestSha256,
    existingPlSha256: value?.existingPlSha256, transport: 'pinned-ssh', helloAuthenticated: false };
  validateFz3bIdentity(answer); return answer;
}

export class Fz3bInspectReconciler {
  private running = false;
  private now = () => Date.now();
  private removeLease = (file: string) => rm(file);
  constructor(private readonly host: Host) {}
  private directory(context: Readonly<Fz3bInspectReconciliationContext>) { return path.join(this.host.root, 'reconciliations', safePart(context.id)); }
  private async original(context: Readonly<Fz3bInspectReconciliationContext>) {
    const original = context.original;
    for (const part of [context.id, original.operationId, original.runId, original.taskId, original.sessionId]) safePart(part);
    demand(context.schemaVersion === 1 && context.id !== original.operationId && isHash(context.nonce) && isHash(context.ownerBindingSha256) &&
      isHash(context.originalOperationSha256) && isHash(context.originalEvidenceSha256) && isHash(original.nonce), 'FZ3B_RECONCILIATION_CONTEXT');
    const resources = await loadFz3bResourceBundle(this.host.resourceRoot);
    demand(original.profileSha256 === fz3bProfileSha256(resources.fixture) && hash(original.fixture) === hash(resources.fixture), 'FZ3B_RECONCILIATION_PROFILE');
    const directory = path.join(this.host.root, original.operationId); await noLinks(directory);
    const evidence = await readBound(path.join(directory, 'evidence.json'));
    const intent = await readBound(path.join(directory, 'intent.json'));
    const close = await readBound(path.join(directory, 'process-exit.json'));
    demand(evidence.sha256 === context.originalEvidenceSha256 && evidence.value.operationId === original.operationId &&
      evidence.value.nonce === original.nonce && evidence.value.profileSha256 === original.profileSha256 && evidence.value.kind === 'inspect' &&
      evidence.value.readOnly === true && evidence.value.status === 'unknown' && evidence.value.processExited === true,
    'FZ3B_RECONCILIATION_ORIGINAL_NOT_INSPECT_UNKNOWN');
    demand(intent.value.schemaVersion === 1 && intent.value.operationId === original.operationId && intent.value.nonce === original.nonce &&
      intent.value.profileSha256 === original.profileSha256 && intent.value.action === 'inspect' && intent.value.dispatchPhase === 'may-have-started' &&
      intent.value.resourceManifestSha256 === LEGACY_INSPECT_RESOURCE_SHA256 &&
      intent.value.payloadSha256 === fz3bDigest(legacyInspectPayload(resources, original)), 'FZ3B_RECONCILIATION_ORIGINAL_PAYLOAD_NOT_ALLOWLISTED');
    demand(close.value.schemaVersion === 1 && close.value.observedClose === true && Number.isInteger(close.value.exitCode) &&
      isHash(close.value.outputSha256) && Number.isFinite(Date.parse(close.value.at)), 'FZ3B_RECONCILIATION_ORIGINAL_CLOSE_UNCONFIRMED');
    return { evidence, intent, close, resources };
  }
  private async lease(context: Readonly<Fz3bInspectReconciliationContext>) {
    const lease = await readBound(path.join(this.host.root, 'active.lock'), 4096); const owner = lease.value, original = context.original;
    demand(owner.schemaVersion === 1 && owner.operationId === original.operationId && owner.nonce === original.nonce &&
      owner.taskId === original.taskId && owner.profileSha256 === original.profileSha256, 'FZ3B_RECONCILIATION_FOREIGN_LEASE'); return lease;
  }
  private async noPendingGuard() {
    try { await noLinks(path.join(this.host.root, 'reconciliation.lock')); throw new Error('FZ3B_RECONCILIATION_GUARD_HELD'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async prepare(context: Readonly<Fz3bInspectReconciliationContext>): Promise<Fz3bInspectReconciliationProof> {
    demand(!this.running && this.host.children() === 0, 'FZ3B_RECONCILIATION_LOCAL_PROCESS_LIVE'); this.running = true;
    let ownGuard = false; let terminal = false;
    try {
      const original = await this.original(context); const lease = await this.lease(context);
      const contextSha256 = hash(context); const directory = this.directory(context);
      await mkdir(directory, { recursive: true }); await noLinks(directory);
      try {
        const previous = await readBound(path.join(directory, 'prepared-proof.json'));
        assertFz3bReconciliationProof(context, previous.value, this.now());
        await this.publicEvidence(context, previous.value); return previous.value as Fz3bInspectReconciliationProof;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      demand(Number.isFinite(Date.parse(context.createdAt)) && this.now() - Date.parse(context.createdAt) >= -1000 &&
        this.now() - Date.parse(context.createdAt) <= 120000, 'FZ3B_RECONCILIATION_CONTEXT_EXPIRED');
      const guard = await open(path.join(this.host.root, 'reconciliation.lock'), 'wx'); ownGuard = true;
      try { await guard.writeFile(JSON.stringify({ id: context.id, contextSha256 })); await guard.sync(); } finally { await guard.close(); }
      try { await lstat(path.join(directory, 'intent.json')); throw new Error('FZ3B_RECONCILIATION_NO_REPLAY'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const knownHosts = path.join(directory, 'known_hosts'); const known = await open(knownHosts, 'wx');
      try { await known.writeFile(original.resources.files.get('known_hosts')!); await known.sync(); } finally { await known.close(); }
      const request = { schemaVersion: 1, action: 'reconcile_inspect', id: context.id, nonce: context.nonce, contextSha256,
        profileSha256: context.original.profileSha256, originalOperationId: context.original.operationId };
      const remote = original.resources.files.get('remote/remote.py')!; const reconcile = original.resources.files.get('remote/reconciliation.py');
      demand(reconcile, 'FZ3B_RECONCILIATION_RESOURCE_MISSING');
      const input = Buffer.from(`import base64,json\nexec(compile(base64.b64decode('${remote.toString('base64')}'),'forgedesk-pinned-remote.py','exec'))\nexec(compile(base64.b64decode('${reconcile.toString('base64')}'),'forgedesk-readonly-reconciliation.py','exec'))\nforgedesk_reconcile(json.loads(base64.b64decode('${Buffer.from(JSON.stringify(request)).toString('base64')}').decode('utf-8')))\n`);
      const key = await this.host.projectKey();
      await durableJson(path.join(directory, 'intent.json'), { schemaVersion: 1, id: context.id, contextSha256, payloadSha256: fz3bDigest(input),
        originalEvidenceSha256: original.evidence.sha256, originalIntentSha256: original.intent.sha256, originalCloseSha256: original.close.sha256,
        originalLeaseSha256: lease.sha256, resourceManifestSha256: original.resources.manifestSha256, dispatchPhase: 'may-have-started' });
      demand(this.now() - Date.parse(context.createdAt) <= 120000, 'FZ3B_RECONCILIATION_CONTEXT_EXPIRED');
      const transport = await this.host.transport(input, key, knownHosts, directory);
      demand(transport.spawned && transport.processExited && transport.exitCode === 0 && !transport.timedOut, 'FZ3B_RECONCILIATION_TRANSPORT_UNKNOWN');
      demand(Buffer.byteLength(transport.stdout) <= 131072 && transport.stdout.endsWith('\n') && transport.stdout.trim().split('\n').length === 1, 'FZ3B_RECONCILIATION_ENVELOPE');
      const result = JSON.parse(transport.stdout);
      demand(result.schemaVersion === 1 && result.id === context.id && result.nonce === context.nonce && result.contextSha256 === contextSha256 &&
        result.profileSha256 === context.original.profileSha256 && result.status === 'succeeded', 'FZ3B_RECONCILIATION_REMOTE_BINDING');
      demand((await this.lease(context)).sha256 === lease.sha256 && this.host.children() === 0, 'FZ3B_RECONCILIATION_LEASE_CHANGED');
      const observedAt = new Date(this.now()).toISOString();
      const evidence = { schemaVersion: 1, context, contextSha256, originalLeaseSha256: lease.sha256,
        originalEvidenceSha256: original.evidence.sha256, originalIntentSha256: original.intent.sha256, originalCloseSha256: original.close.sha256,
        transport: { spawned: true, closeConfirmed: true, exitCode: 0, timedOut: false }, remoteStdout: transport.stdout, remote: result,
        observedAt, originalUnknownPreserved: true };
      const proof: Fz3bInspectReconciliationProof = { schemaVersion: 1, id: context.id, nonce: context.nonce, contextSha256,
        originalEvidenceSha256: original.evidence.sha256, originalIntentSha256: original.intent.sha256, originalCloseSha256: original.close.sha256,
        originalResourceManifestSha256: LEGACY_INSPECT_RESOURCE_SHA256, localOriginalCloseConfirmed: true, identity: publicIdentity(result.identity),
        transport: { spawned: true, closeConfirmed: true, exitCode: 0, timedOut: false }, remote: result.remote, observedAt, evidenceSha256: '0'.repeat(64) };
      assertFz3bReconciliationProof(context, proof, this.now());
      await durableJson(path.join(directory, 'proof-evidence.json'), evidence);
      proof.evidenceSha256 = fz3bDigest(await readFile(path.join(directory, 'proof-evidence.json')));
      await durableJson(path.join(directory, 'prepared-proof.json'), proof); terminal = true; return proof;
    } finally {
      try { if (ownGuard && terminal) await rm(path.join(this.host.root, 'reconciliation.lock')); }
      finally { this.running = false; }
    }
  }
  async finalize(context: Readonly<Fz3bInspectReconciliationContext>, proof: Readonly<Fz3bInspectReconciliationProof>): Promise<Fz3bInspectReconciliationFinalization> {
    demand(!this.running && this.host.children() === 0, 'FZ3B_RECONCILIATION_LOCAL_PROCESS_LIVE'); this.running = true;
    try {
      await this.noPendingGuard();
      const original = await this.original(context); await this.publicEvidence(context, proof);
      const contextSha256 = hash(context); const proofSha256 = hash(proof); const directory = this.directory(context);
      const prepared = await readBound(path.join(directory, 'prepared-proof.json'));
      demand(hash(prepared.value) === proofSha256 && proof.contextSha256 === contextSha256 && proof.originalIntentSha256 === original.intent.sha256 &&
        proof.originalCloseSha256 === original.close.sha256, 'FZ3B_RECONCILIATION_PREPARED_PROOF_CHANGED');
      assertFz3bReconciliationProof(context, proof, this.now());
      const evidence = await readBound(path.join(directory, 'proof-evidence.json'));
      const markerPath = path.join(directory, 'finalization-evidence.json');
      let marker: Awaited<ReturnType<typeof readBound>>;
      try { marker = await readBound(markerPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const lease = await this.lease(context);
        demand(lease.sha256 === evidence.value.originalLeaseSha256, 'FZ3B_RECONCILIATION_LEASE_CHANGED');
        await durableJson(markerPath, { schemaVersion: 1, id: context.id, contextSha256, proofSha256,
          originalOperationId: context.original.operationId, originalNonce: context.original.nonce,
          originalLeaseSha256: lease.sha256, oldUnknownPreserved: true, preparedBeforeExactUnlink: true });
        marker = await readBound(markerPath);
      }
      demand(marker.value.schemaVersion === 1 && marker.value.id === context.id && marker.value.contextSha256 === contextSha256 &&
        marker.value.proofSha256 === proofSha256 && marker.value.originalOperationId === context.original.operationId && marker.value.originalNonce === context.original.nonce &&
        marker.value.originalLeaseSha256 === evidence.value.originalLeaseSha256 && marker.value.preparedBeforeExactUnlink === true,
      'FZ3B_RECONCILIATION_FINALIZATION_MARKER_CHANGED');
      try {
        await this.noPendingGuard();
        const lease = await this.lease(context);
        demand(lease.sha256 === marker.value.originalLeaseSha256, 'FZ3B_RECONCILIATION_FOREIGN_LEASE');
        assertFz3bReconciliationProof(context, proof, this.now());
        await this.removeLease(path.join(this.host.root, 'active.lock'));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      try { await lstat(path.join(this.host.root, 'active.lock')); throw new Error('FZ3B_RECONCILIATION_LEASE_STILL_PRESENT'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      assertFz3bReconciliationProof(context, proof, this.now());
      demand(this.host.children() === 0, 'FZ3B_RECONCILIATION_LOCAL_PROCESS_LIVE'); this.host.released();
      return { schemaVersion: 1, id: context.id, contextSha256, proofSha256, lockReleased: true, localProcessesClosed: true, evidenceSha256: marker.sha256 };
    } finally { this.running = false; }
  }
  async publicEvidence(context: Readonly<Fz3bInspectReconciliationContext>, proof: Readonly<Fz3bInspectReconciliationProof>, finalization?: Readonly<Fz3bInspectReconciliationFinalization>) {
    demand(proof.contextSha256 === hash(context) && proof.id === context.id && proof.nonce === context.nonce, 'FZ3B_RECONCILIATION_PUBLIC_BINDING');
    const proofFile = await readBound(path.join(this.directory(context), 'proof-evidence.json'));
    demand(proofFile.sha256 === proof.evidenceSha256 && proofFile.value.contextSha256 === hash(context), 'FZ3B_RECONCILIATION_PUBLIC_EVIDENCE_CHANGED');
    const files: { name: 'proof-evidence.json' | 'finalization-evidence.json'; bytes: Buffer; sha256: string }[] = [{ name: 'proof-evidence.json', bytes: proofFile.bytes, sha256: proofFile.sha256 }];
    if (finalization) {
      const file = await readBound(path.join(this.directory(context), 'finalization-evidence.json'));
      demand(finalization.contextSha256 === hash(context) && finalization.proofSha256 === hash(proof) && file.sha256 === finalization.evidenceSha256,
        'FZ3B_RECONCILIATION_PUBLIC_FINALIZATION_CHANGED');
      files.push({ name: 'finalization-evidence.json', bytes: file.bytes, sha256: file.sha256 });
    }
    return files;
  }
  async localProcessState(contexts: readonly Fz3bAdapterContext[]): Promise<Fz3bLocalProcessState> {
    const operations: Fz3bLocalProcessState['operations'] = [];
    for (const context of contexts) {
      for (const part of [context.operationId, context.taskId, context.sessionId, context.runId]) safePart(part);
      const directory = path.join(this.host.root, context.operationId);
      const evidence = await readBound(path.join(directory, 'evidence.json')); const intent = await readBound(path.join(directory, 'intent.json'));
      const close = await readBound(path.join(directory, 'process-exit.json'));
      const closeConfirmed = evidence.value.operationId === context.operationId && evidence.value.nonce === context.nonce && evidence.value.profileSha256 === context.profileSha256 &&
        (evidence.value.processExited === true || evidence.value.transport?.processExited === true) && intent.value.operationId === context.operationId && intent.value.nonce === context.nonce &&
        intent.value.profileSha256 === context.profileSha256 && ['inspect', 'semantic'].includes(intent.value.action) &&
        close.value.schemaVersion === 1 && close.value.observedClose === true && Number.isInteger(close.value.exitCode) && isHash(close.value.outputSha256);
      const facts = { schemaVersion: 1, operationId: context.operationId, nonce: context.nonce, taskId: context.taskId,
        runId: context.runId, sessionId: context.sessionId, profileSha256: context.profileSha256,
        originalEvidenceSha256: evidence.sha256, originalIntentSha256: intent.sha256, originalCloseSha256: close.sha256,
        closeConfirmed, historicalPidAttested: false, claim: 'Bound existing observed-close evidence plus current adapter child census only' };
      await durableJson(path.join(directory, 'local-close-proof.json'), facts);
      operations.push({ operationId: context.operationId, nonce: context.nonce, closeConfirmed,
        evidenceSha256: fz3bDigest(await readFile(path.join(directory, 'local-close-proof.json'))) });
    }
    let guardClear = true;
    try { await this.noPendingGuard(); } catch { guardClear = false; }
    const liveChildren = this.host.children(); return { closed: guardClear && !this.running && liveChildren === 0 && operations.every(value => value.closeConfirmed), liveChildren, operations };
  }
}
