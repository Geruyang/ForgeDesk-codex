import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, readFile, rm, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { durableJson, noLinks, safePart } from '../embedded/files.js';
import { redact } from '../redaction.js';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bCanonicalJson, fz3bDigest, fz3bProfileSha256, validateFz3bIdentity } from './profile.js';
import { deterministicPsPackage } from './package.js';
import { loadFz3bResourceBundle, type Fz3bResourceBundle } from './resources.js';
import { fz3bPrivateKeyPath, requireFz3bProjectKey } from './credentials.js';
import { fz3bSshEnvironment } from './ssh-environment.js';
import { fixedFz3bPayload } from './payload.js';
import { Fz3bInspectReconciler } from './reconciliation-worker.js';
import { Fz3bPreflightRecoveryWorker } from './preflight-recovery-worker.js';
import { captureFz3bHostCompletionWitness, fz3bHostRootIdentitySync } from './host-finalization-witness.js';
import type { Fz3bAvailability } from './availability.js';
import type { Fz3bAdapter, Fz3bAdapterContext, Fz3bBuildReceipt, Fz3bIdentity, Fz3bInspectReceipt,
  Fz3bReceiptBase, Fz3bSemanticReceipt, Fz3bSemanticResult, Fz3bInspectReconciliationContext,
  Fz3bInspectReconciliationProof, Fz3bInspectReconciliationFinalization, Fz3bPreflightRefusalRecoveryContext,
  Fz3bPreflightRefusalRecoveryProof, Fz3bPreflightRefusalRecoveryFinalization, Fz3bPreflightRefusalRecoveryAck,
  Fz3bPreflightRefusalRecoveryAcknowledgment, Fz3bPreflightRefusalRecoveryClosure } from './types.js';
export { loadFz3bFixture, verifyFz3bResources } from './resources.js';
export { importFz3bProjectKey, FZ3B_PROJECT_KEY_FINGERPRINT } from './credentials.js';
export type { Fz3bAvailability, Fz3bAvailabilityStatus } from './availability.js';

export interface ProductionFz3bOptions { resourceRoot: string; dataDir: string; processHost?: string }
interface RemoteResult { schemaVersion: 1; operationId: string; nonce: string; profileSha256: string;
  status: 'succeeded' | 'failed' | 'unknown'; remoteQuiescent: boolean; remoteOutcomeUnknown: boolean;
  identity?: Omit<Fz3bIdentity, 'hostKeySha256' | 'transport' | 'helloAuthenticated'>;
  semantic?: Fz3bSemanticResult; grantId?: string; detail?: string; readOnly?: true }
interface TransportResult { processExited: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; spawned: boolean }
const DEADLINE = { inspect: 45000, semantic: 240000 };
const ZERO = '0'.repeat(64);
const productionCompletionSources = new WeakMap<object, { root: string; resourceRoot: string; children(): number; held(): boolean }>();

/** Only a real constructed production adapter can supply this fixed readonly witness. */
export function captureProductionFz3bHostCompletionWitness(adapter: Fz3bAdapter, dataDir: string, context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>,
  finalization: Readonly<Fz3bPreflightRefusalRecoveryFinalization>, ack: Readonly<Fz3bPreflightRefusalRecoveryAck>,
  acknowledgment: Readonly<Fz3bPreflightRefusalRecoveryAcknowledgment>, closure: Readonly<Fz3bPreflightRefusalRecoveryClosure>): (() => void) | undefined {
  const source = productionCompletionSources.get(adapter);
  if (source && fz3bCanonicalJson(fz3bHostRootIdentitySync(source.root)) !== fz3bCanonicalJson(fz3bHostRootIdentitySync(path.join(dataDir, 'fz3b-worker')))) throw new Error('FZ3B_HOST_COMPLETION_WITNESS_ROOT');
  return source ? captureFz3bHostCompletionWitness(source, context, proof, finalization, ack, acknowledgment, closure) : undefined;
}

function transportEvidence(transport: TransportResult) {
  const diagnostic = redact(transport.stderr)
    .replace(/[A-Za-z]:[\\/][^\r\n"']+/g, '[LOCAL_PATH]')
    .replace(/(?:\/home\/|\/Users\/)[^\s"']+/g, '[LOCAL_PATH]');
  return { processExited: transport.processExited, exitCode: transport.exitCode, timedOut: transport.timedOut,
    spawned: transport.spawned, stdoutBytes: Buffer.byteLength(transport.stdout), stdoutSha256: fz3bDigest(transport.stdout),
    stderr: Buffer.from(diagnostic).subarray(0, 4096).toString('utf8') };
}

export async function checkFz3bAvailability(resourceRoot: string, dataDir: string): Promise<Fz3bAvailability> {
  const reason = (error: unknown) => redact(String(error)).slice(0, 500);
  try {
    await loadFz3bResourceBundle(resourceRoot);
  } catch (error) { return { available: false, status: 'invalid-resources', resourcesVerified: false, reason: reason(error) }; }
  try { await noLinks(dataDir); }
  catch (error) { return { available: false, status: 'invalid-key', resourcesVerified: true, reason: reason(error) }; }
  const key = fz3bPrivateKeyPath(dataDir);
  try {
    await noLinks(path.dirname(key)); await noLinks(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { available: false, status: 'missing-key', resourcesVerified: true, reason: 'FZ3B_PROJECT_KEY_MISSING' };
    }
    return { available: false, status: 'invalid-key', resourcesVerified: true, reason: reason(error) };
  }
  try { await requireFz3bProjectKey(dataDir); }
  catch (error) { return { available: false, status: 'invalid-key', resourcesVerified: true, reason: reason(error) }; }
  if (process.platform !== 'win32') {
    return { available: false, status: 'unsupported-host', resourcesVerified: true, reason: 'FZ3B_PRODUCTION_REQUIRES_WINDOWS_OPENSSH' };
  }
  try {
    const ssh = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/OpenSSH/ssh.exe');
    const environment = fz3bSshEnvironment();
    await noLinks(ssh); await noLinks(environment.ProgramData);
    if (!(await lstat(ssh)).isFile() || !(await lstat(environment.ProgramData)).isDirectory()) throw new Error('FZ3B_SSH_HOST_NOT_EXECUTABLE');
  } catch (error) { return { available: false, status: 'missing-ssh', resourcesVerified: true, reason: reason(error) }; }
  return { available: true, status: 'available', resourcesVerified: true };
}

export function fixedFz3bSshArgs(key: string, knownHosts: string): string[] {
  return ['-T', '-F', 'NUL', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'PubkeyAcceptedAlgorithms=ssh-ed25519',
    '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=NUL', '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'RequestTTY=no',
    '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
    '-i', key, `${FZ3B_PROFILE.user}@${FZ3B_PROFILE.host}`, FZ3B_PROFILE.remoteCommand];
}

function contextBinding(context: Readonly<Fz3bAdapterContext>, resources: Fz3bResourceBundle) {
  for (const id of [context.runId, context.sessionId, context.taskId, context.operationId]) safePart(id);
  if (!/^[a-f0-9]{64}$/.test(context.nonce) || context.profileSha256 !== fz3bProfileSha256(resources.fixture) ||
      fz3bCanonicalJson(context.fixture) !== fz3bCanonicalJson(resources.fixture)) throw new Error('FZ3B_WORKER_CONTEXT_BINDING');
}

function publicIdentity(value: NonNullable<RemoteResult['identity']>): Fz3bIdentity {
  return { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: value.bootId, appRoot: value.appRoot, platform: value.platform,
    contractId: value.contractId, deployedManifestSha256: value.deployedManifestSha256, existingPlSha256: value.existingPlSha256,
    transport: 'pinned-ssh', helloAuthenticated: false };
}

export function parseFz3bRemoteResult(stdout: string, context: Readonly<Fz3bAdapterContext>, action: 'inspect' | 'semantic'): RemoteResult {
  if (Buffer.byteLength(stdout) > 131072 || !stdout.endsWith('\n') || stdout.trim().split('\n').length !== 1) throw new Error('FZ3B_REMOTE_RECEIPT_ENVELOPE');
  const value = JSON.parse(stdout) as RemoteResult;
  if (value.schemaVersion !== 1 || value.operationId !== context.operationId || value.nonce !== context.nonce || value.profileSha256 !== context.profileSha256 ||
      !['succeeded', 'failed', 'unknown'].includes(value.status) || typeof value.remoteQuiescent !== 'boolean' || typeof value.remoteOutcomeUnknown !== 'boolean') throw new Error('FZ3B_REMOTE_RECEIPT_BINDING');
  if (value.status === 'succeeded') {
    if (!value.identity || value.remoteQuiescent !== true || value.remoteOutcomeUnknown !== false) throw new Error('FZ3B_REMOTE_RECEIPT_NOT_QUIESCENT');
    validateFz3bIdentity(publicIdentity(value.identity));
    if (action === 'inspect' && (value.readOnly !== true || value.semantic)) throw new Error('FZ3B_INSPECT_NOT_READONLY');
    if (action === 'semantic') {
      const result = value.semantic;
      const fixture = context.fixture;
      if (!result || value.grantId !== context.grant?.id || result.fixtureManifestSha256 !== fixture.manifestSha256 || result.queriesSha256 !== fixture.queriesSha256 || result.imageSha256 !== fixture.imageSha256 ||
          fz3bCanonicalJson(result.encoderIdentity) !== fz3bCanonicalJson(fixture.encoderIdentity) || result.semanticInput !== 'real-text-encoder' || result.synthetic !== false ||
          result.jobId !== `fd-semantic-${context.operationId.replaceAll('-', '')}` || result.frameId !== 0 || result.completedFrames !== 1 || !Number.isSafeInteger(result.queryRevision) || result.queryRevision < 1 ||
          result.inferenceStopped !== true || result.newPlLoaded !== false || result.threshold !== .2 || !Array.isArray(result.ranking) || result.ranking.length !== 4 ||
          JSON.stringify(result.ranking.map(item => item.id).sort()) !== JSON.stringify([...fixture.queryIds].sort()) ||
          result.ranking.some((item, index) => item.label !== item.id || !Number.isFinite(item.score) || item.score < -1 || item.score > 1 || (index > 0 && result.ranking[index - 1].score < item.score)) ||
          result.bestId !== result.ranking[0].id || result.thresholdHit !== (result.ranking[0].score >= .2) || result.classificationUnknown !== !result.thresholdHit ||
          result.expectedLabel !== 'pillow' || result.expectedLabelMatched !== (result.bestId === 'pillow' && result.ranking[0].score > Math.max(...result.ranking.slice(1).map(item => item.score)))) throw new Error('FZ3B_SEMANTIC_RECEIPT_FIXED_FIXTURE');
    }
  }
  return value;
}

export class ProductionFz3bAdapter implements Fz3bAdapter {
  private readonly root: string;
  private readonly reconciliation: Fz3bInspectReconciler;
  private readonly preflightRecovery: Fz3bPreflightRecoveryWorker;
  private active = false;
  private children = new Set<ChildProcess>();
  private now = () => Date.now();
  private persistIntent = durableJson;
  private projectKey = () => requireFz3bProjectKey(this.options.dataDir);
  /** Offline-only injection seam. Installed main never supplies or modifies it. */
  private transport = (action: 'inspect' | 'semantic', input: Buffer, key: string, knownHosts: string, directory: string, expiresAt?: string) => this.ssh(action, input, key, knownHosts, directory, expiresAt);
  constructor(private readonly options: ProductionFz3bOptions) {
    if (!path.isAbsolute(options.resourceRoot) || !path.isAbsolute(options.dataDir)) throw new Error('FZ3B_HOST_PATHS_MUST_BE_ABSOLUTE');
    this.root = path.join(options.dataDir, 'fz3b-worker');
    productionCompletionSources.set(this, { root: this.root, resourceRoot: options.resourceRoot, children: () => this.children.size, held: () => this.active });
    this.preflightRecovery = new Fz3bPreflightRecoveryWorker({ root: this.root, resourceRoot: options.resourceRoot,
      children: () => this.children.size, released: () => { this.active = false; } });
    this.reconciliation = new Fz3bInspectReconciler({ root: this.root, resourceRoot: options.resourceRoot,
      children: () => this.children.size, released: () => { this.active = false; }, projectKey: () => this.projectKey(),
      transport: (input, key, known, directory) => this.transport('inspect', input, key, known, directory) });
  }
  async prepareInspectReconciliation(context: Readonly<Fz3bInspectReconciliationContext>) { await this.preflightRecovery.assertNoRecoveryBarrier(); return this.reconciliation.prepare(context); }
  async finalizeInspectReconciliation(context: Readonly<Fz3bInspectReconciliationContext>, proof: Readonly<Fz3bInspectReconciliationProof>) { await this.preflightRecovery.assertNoRecoveryBarrier(); return this.reconciliation.finalize(context, proof); }
  readInspectReconciliationEvidence(context: Readonly<Fz3bInspectReconciliationContext>, proof: Readonly<Fz3bInspectReconciliationProof>, finalization?: Readonly<Fz3bInspectReconciliationFinalization>) {
    return this.reconciliation.publicEvidence(context, proof, finalization);
  }
  // Local close evidence supports maintenance exit while the independent recovery barrier remains held.
  localProcessState(contexts: readonly Fz3bAdapterContext[]) { return this.reconciliation.localProcessState(contexts); }
  preparePreflightRefusalRecovery(context: Readonly<Fz3bPreflightRefusalRecoveryContext>) { return this.preflightRecovery.prepare(context); }
  readPreflightRefusalRecoveryInput(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>) { return this.preflightRecovery.readInput(context, proof); }
  finalizePreflightRefusalRecovery(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>) { return this.preflightRecovery.finalize(context, proof); }
  acknowledgePreflightRefusalRecovery(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>, finalization: Readonly<Fz3bPreflightRefusalRecoveryFinalization>, ack: Readonly<Fz3bPreflightRefusalRecoveryAck>, verifyAck: (value: Fz3bPreflightRefusalRecoveryAck) => void) { return this.preflightRecovery.acknowledge(context, proof, finalization, ack, verifyAck); }
  readPreflightRefusalRecoveryCompletion(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>, finalization: Readonly<Fz3bPreflightRefusalRecoveryFinalization>, verifyAck: (value: Fz3bPreflightRefusalRecoveryAck) => void, verifyClosure: (ack: Fz3bPreflightRefusalRecoveryAck, acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment, value: Fz3bPreflightRefusalRecoveryClosure) => void) { return this.preflightRecovery.readCompletion(context, proof, finalization, verifyAck, verifyClosure); }
  certifyPreflightRefusalRecovery(context: Readonly<Fz3bPreflightRefusalRecoveryContext>, proof: Readonly<Fz3bPreflightRefusalRecoveryProof>, finalization: Readonly<Fz3bPreflightRefusalRecoveryFinalization>, ack: Readonly<Fz3bPreflightRefusalRecoveryAck>, acknowledgment: Readonly<Fz3bPreflightRefusalRecoveryAcknowledgment>, closure: Readonly<Fz3bPreflightRefusalRecoveryClosure>, verifyClosure: (ack: Fz3bPreflightRefusalRecoveryAck, acknowledgment: Fz3bPreflightRefusalRecoveryAcknowledgment, value: Fz3bPreflightRefusalRecoveryClosure) => void) { return this.preflightRecovery.certify(context, proof, finalization, ack, acknowledgment, closure, verifyClosure); }
  private base(context: Readonly<Fz3bAdapterContext>, status: Fz3bReceiptBase['status'], detail?: string): Fz3bReceiptBase {
    return { schemaVersion: 1, operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256,
      status, processExited: true, remoteQuiescent: true, remoteOutcomeUnknown: false, evidenceSha256: ZERO, ...(detail ? { detail } : {}) };
  }
  private directory(context: Readonly<Fz3bAdapterContext>) { return path.join(this.root, safePart(context.operationId)); }
  private async evidence(context: Readonly<Fz3bAdapterContext>, value: unknown): Promise<string> {
    const directory = this.directory(context); await mkdir(directory, { recursive: true }); await noLinks(directory);
    const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    const handle = await open(path.join(directory, 'evidence.json'), 'wx');
    try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
    return fz3bDigest(raw);
  }
  private async lock(context: Readonly<Fz3bAdapterContext>): Promise<void> {
    await this.preflightRecovery.assertNoRecoveryBarrier();
    if (this.active) throw new Error('FZ3B_WORKER_BUSY');
    this.active = true;
    try {
      await mkdir(this.root, { recursive: true }); await noLinks(this.root);
      const handle = await open(path.join(this.root, 'active.lock'), 'wx');
      try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, operationId: context.operationId, nonce: context.nonce, taskId: context.taskId, profileSha256: context.profileSha256 })); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) { this.active = false; throw error; }
  }
  private async unlock(context: Readonly<Fz3bAdapterContext>): Promise<void> {
    const file = path.join(this.root, 'active.lock'); await noLinks(file);
    const owner = JSON.parse(await readFile(file, 'utf8'));
    if (owner.operationId !== context.operationId || owner.nonce !== context.nonce || owner.taskId !== context.taskId) throw new Error('FZ3B_WORKER_LOCK_OWNER_MISMATCH');
    await rm(file); this.active = false;
  }
  private async verifyArtifact(context: Readonly<Fz3bAdapterContext>, resources: Fz3bResourceBundle): Promise<void> {
    const artifact = context.artifact;
    if (!artifact || artifact.kind !== 'fixed-ps-fixture-package' || artifact.profileSha256 !== context.profileSha256 ||
        artifact.sourceManifestSha256 !== FZ3B_PROFILE.deployedManifestSha256 || !/^[a-f0-9]{64}$/.test(artifact.packageSha256) || !/^[a-f0-9]{64}$/.test(artifact.packageManifestSha256)) throw new Error('FZ3B_PACKAGE_ARTIFACT_REQUIRED');
    await noLinks(this.root);
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)) continue;
      const directory = path.join(this.root, entry.name); await noLinks(directory);
      const evidence = path.join(directory, 'evidence.json');
      let raw: Buffer;
      try { await noLinks(evidence); if ((await lstat(evidence)).size > 131072) continue; raw = await readFile(evidence); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (fz3bDigest(raw) !== artifact.buildEvidenceSha256) continue;
      const binding = JSON.parse(raw.toString('utf8'));
      if (binding.action !== 'build' || binding.kind !== artifact.kind || binding.operationId !== entry.name || artifact.buildId !== entry.name ||
          binding.runId !== context.runId || binding.taskId !== context.taskId || binding.sessionId !== context.sessionId || binding.profileSha256 !== context.profileSha256 ||
          binding.resourceManifestSha256 !== resources.manifestSha256 || binding.packageSha256 !== artifact.packageSha256 || binding.packageManifestSha256 !== artifact.packageManifestSha256) throw new Error('FZ3B_PACKAGE_EVIDENCE_BINDING');
      for (const [name, expected, limit] of [['ps-acceptance.tar', artifact.packageSha256, 8 * 1048576], ['package-manifest.json', artifact.packageManifestSha256, 65536]] as const) {
        const file = path.join(directory, name); await noLinks(file); const info = await lstat(file);
        if (!info.isFile() || info.nlink !== 1 || info.size > limit || fz3bDigest(await readFile(file)) !== expected) throw new Error('FZ3B_PACKAGE_CHANGED_AFTER_BUILD');
      }
      return;
    }
    throw new Error('FZ3B_PACKAGE_EVIDENCE_NOT_FOUND');
  }
  async build(context: Readonly<Fz3bAdapterContext>): Promise<Fz3bBuildReceipt> {
    await this.preflightRecovery.assertNoRecoveryBarrier();
    const receipt: Fz3bBuildReceipt = { ...this.base(context, 'failed'), kind: 'build', sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
      fixtureManifestSha256: context.fixture.manifestSha256, queriesSha256: context.fixture.queriesSha256, imageSha256: context.fixture.imageSha256, newPlBuilt: false, deployed: false };
    let locked = false;
    try {
      const resources = await loadFz3bResourceBundle(this.options.resourceRoot); contextBinding(context, resources);
      await this.lock(context); locked = true;
      const directory = this.directory(context); await mkdir(directory); await noLinks(directory);
      const entries = [...resources.files].filter(([name]) => name.startsWith('ps-src/') || name.startsWith('fixture/') || name.startsWith('licenses/'))
        .map(([name, bytes]) => ({ path: name, bytes }));
      const built = deterministicPsPackage(entries);
      for (const [name, bytes] of [['ps-acceptance.tar', built.archive], ['package-manifest.json', built.manifest]] as const) {
        const handle = await open(path.join(directory, name), 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      }
      receipt.packageSha256 = fz3bDigest(built.archive); receipt.packageManifestSha256 = built.manifestSha256;
      receipt.evidenceSha256 = await this.evidence(context, { schemaVersion: 1, action: 'build', kind: 'fixed-ps-fixture-package',
        operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256, resourceManifestSha256: resources.manifestSha256,
        runId: context.runId, taskId: context.taskId, sessionId: context.sessionId,
        packageSha256: receipt.packageSha256, packageManifestSha256: receipt.packageManifestSha256, bytes: built.archive.length,
        newPlBuilt: false, deployed: false, scope: 'Actual deterministic PS acceptance package generation; no Vivado, deployment, or PL construction.' });
      receipt.status = 'succeeded';
    } catch (error) { receipt.detail = redact(String(error)).slice(0, 2000); }
    if (locked) {
      try { await this.unlock(context); } catch (error) { receipt.status = 'unknown'; receipt.remoteQuiescent = false; receipt.detail = redact(String(error)); }
    }
    if (receipt.evidenceSha256 === ZERO) {
      try { receipt.evidenceSha256 = await this.evidence(context, receipt); } catch { receipt.status = 'unknown'; receipt.remoteQuiescent = false; }
    }
    return receipt;
  }
  async readPublicEvidence(operationId: string, evidenceSha256: string): Promise<Array<{ name: 'evidence.json' | 'ps-acceptance.tar' | 'package-manifest.json'; bytes: Buffer; sha256: string }>> {
    safePart(operationId);
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) throw new Error('FZ3B_PUBLIC_EVIDENCE_HASH_REQUIRED');
    const directory = path.join(this.root, operationId); await noLinks(directory);
    const read = async (name: 'evidence.json' | 'ps-acceptance.tar' | 'package-manifest.json', limit: number) => {
      const file = path.join(directory, name); await noLinks(file); const info = await lstat(file);
      if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('FZ3B_PUBLIC_EVIDENCE_SIZE_OR_LINK');
      const bytes = await readFile(file); return { name, bytes, sha256: fz3bDigest(bytes) };
    };
    const evidence = await read('evidence.json', 131072);
    if (evidence.sha256 !== evidenceSha256) throw new Error('FZ3B_PUBLIC_EVIDENCE_CHANGED');
    const body = JSON.parse(evidence.bytes.toString('utf8'));
    if (body.operationId !== operationId) throw new Error('FZ3B_PUBLIC_EVIDENCE_OPERATION');
    const files = [evidence];
    if (body.action === 'build' && body.packageSha256 && body.packageManifestSha256) {
      const archive = await read('ps-acceptance.tar', 4 * 1048576); const manifest = await read('package-manifest.json', 65536);
      if (archive.sha256 !== body.packageSha256 || manifest.sha256 !== body.packageManifestSha256) throw new Error('FZ3B_PUBLIC_PACKAGE_CHANGED');
      files.push(archive, manifest);
    }
    return files;
  }
  inspect(context: Readonly<Fz3bAdapterContext>): Promise<Fz3bInspectReceipt> { return this.remote('inspect', context) as Promise<Fz3bInspectReceipt>; }
  semantic(context: Readonly<Fz3bAdapterContext>): Promise<Fz3bSemanticReceipt> { return this.remote('semantic', context) as Promise<Fz3bSemanticReceipt>; }
  private async remote(action: 'inspect' | 'semantic', context: Readonly<Fz3bAdapterContext>): Promise<Fz3bInspectReceipt | Fz3bSemanticReceipt> {
    await this.preflightRecovery.assertNoRecoveryBarrier();
    let receipt: Fz3bInspectReceipt | Fz3bSemanticReceipt = action === 'inspect' ? { ...this.base(context, 'failed'), kind: action, readOnly: true } : { ...this.base(context, 'failed'), kind: action };
    let locked = false; let dispatched = false; let observedTransport: TransportResult | undefined;
    let resourceManifestSha256: string | undefined;
    try {
      const resources = await loadFz3bResourceBundle(this.options.resourceRoot); contextBinding(context, resources);
      resourceManifestSha256 = resources.manifestSha256;
      if (action === 'semantic') {
        const grant = context.grant; const artifact = context.artifact;
        const now = this.now(), created = Date.parse(grant?.createdAt ?? ''), approved = Date.parse(grant?.approvedAt ?? ''), expires = Date.parse(grant?.expiresAt ?? '');
        if (!context.identity || !artifact || !grant?.approvedAt || grant.consumedBy !== context.operationId || grant.taskId !== context.taskId || grant.runId !== context.runId ||
            grant.sessionId !== context.sessionId || grant.artifactId !== artifact.id || grant.profileSha256 !== context.profileSha256 || grant.scope !== 'existing-candidate008-real-text-single-image-once' ||
            ![now, created, approved, expires].every(Number.isFinite) || typeof grant.createdAt !== 'string' || typeof grant.approvedAt !== 'string' || typeof grant.expiresAt !== 'string' ||
            created > approved || approved > now || approved >= expires || expires <= now || expires - created > 300000 || fz3bCanonicalJson(grant.fixture) !== fz3bCanonicalJson(resources.fixture) ||
            fz3bCanonicalJson(grant.identity) !== fz3bCanonicalJson(context.identity) || artifact.fixtureManifestSha256 !== context.fixture.manifestSha256 || artifact.queriesSha256 !== context.fixture.queriesSha256 || artifact.imageSha256 !== context.fixture.imageSha256) throw new Error('FZ3B_NATIVE_GRANT_BINDING');
        validateFz3bIdentity(context.identity);
        const { planSha256, approvedAt: _approved, consumedBy: _consumed, ...plan } = grant;
        if (fz3bDigest(JSON.stringify(plan)) !== planSha256 || fz3bCanonicalJson(grant.actions) !== fz3bCanonicalJson(FZ3B_PROFILE.actions)) throw new Error('FZ3B_NATIVE_GRANT_PLAN_CHANGED');
        await this.verifyArtifact(context, resources);
      }
      const key = await this.projectKey();
      await this.lock(context); locked = true;
      const directory = this.directory(context); await mkdir(directory); await noLinks(directory);
      const knownHosts = path.join(directory, 'known_hosts');
      const known = await open(knownHosts, 'wx'); try { await known.writeFile(resources.files.get('known_hosts')!); await known.sync(); } finally { await known.close(); }
      let grantRemainingMs: number | undefined;
      if (action === 'semantic') {
        const now = this.now(), expires = Date.parse(context.grant!.expiresAt);
        if (!Number.isFinite(now) || !Number.isFinite(expires) || expires <= now || expires - now > 300000) throw new Error('FZ3B_NATIVE_GRANT_EXPIRED_BEFORE_DISPATCH');
        grantRemainingMs = expires - now;
      }
      const request = { schemaVersion: 1, action, operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256,
        ...(action === 'semantic' ? { fixture: resources.fixture, grant: context.grant,
          grantRemainingMs,
          queriesB64: resources.files.get('fixture/query-template.json')!.toString('base64'), imageB64: resources.files.get('fixture/input.jpg')!.toString('base64') } : {}) };
      const input = fixedFz3bPayload(resources, request);
      if (input.length > 1048576) throw new Error('FZ3B_WORKER_INPUT_BUDGET');
      await this.persistIntent(path.join(directory, 'intent.json'), { schemaVersion: 1, operationId: context.operationId, nonce: context.nonce,
        profileSha256: context.profileSha256, action, resourceManifestSha256: resources.manifestSha256, payloadSha256: fz3bDigest(input), dispatchPhase: 'may-have-started' });
      if (action === 'semantic') {
        const now = this.now(), expires = Date.parse(context.grant!.expiresAt);
        if (!Number.isFinite(now) || !Number.isFinite(expires) || expires <= now || expires - now > 300000) throw new Error('FZ3B_NATIVE_GRANT_EXPIRED_BEFORE_DISPATCH');
      }
      dispatched = true;
      const transport = await this.transport(action, input, key, knownHosts, directory, action === 'semantic' ? context.grant!.expiresAt : undefined);
      observedTransport = transport;
      dispatched = transport.spawned;
      receipt.processExited = transport.processExited;
      await durableJson(path.join(directory, 'transport.json'), { schemaVersion: 1, operationId: context.operationId, nonce: context.nonce,
        profileSha256: context.profileSha256, action, resourceManifestSha256, observedAt: new Date().toISOString(), transport: transportEvidence(transport) });
      if (!transport.spawned) throw new Error('FZ3B_SSH_NOT_SPAWNED');
      if (!transport.processExited || transport.timedOut) throw new Error('FZ3B_REMOTE_VISIBILITY_UNKNOWN_NO_REPLAY');
      const parsed = parseFz3bRemoteResult(transport.stdout, context, action);
      if (transport.exitCode !== 0) throw new Error('FZ3B_SSH_EXIT_NOT_SUCCESS');
      receipt = { ...receipt, status: parsed.status, remoteQuiescent: parsed.remoteQuiescent, remoteOutcomeUnknown: parsed.remoteOutcomeUnknown,
        ...(parsed.detail ? { detail: redact(parsed.detail).slice(0, 2000) } : {}),
        ...(parsed.identity ? { identity: publicIdentity(parsed.identity) } : {}),
        ...(action === 'semantic' ? { semantic: parsed.semantic, grantId: parsed.grantId } : {}) };
      receipt.evidenceSha256 = await this.evidence(context, { schemaVersion: 1, operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256,
        action, transport: transportEvidence(transport),
        remoteStdout: transport.stdout, remote: parsed, resourceManifestSha256: resources.manifestSha256, authenticatedTransport: 'pinned-ssh', helloAuthenticated: false });
      if (receipt.status === 'succeeded' && (!receipt.remoteQuiescent || receipt.remoteOutcomeUnknown)) throw new Error('FZ3B_REMOTE_NOT_TERMINAL');
    } catch (error) {
      receipt.status = dispatched ? 'unknown' : 'failed'; receipt.remoteQuiescent = !dispatched; receipt.remoteOutcomeUnknown = dispatched;
      receipt.detail = redact(String(error)).slice(0, 2000);
      if (receipt.evidenceSha256 === ZERO) {
        try { receipt.evidenceSha256 = await this.evidence(context, { ...receipt,
          ...(observedTransport ? { action, resourceManifestSha256, transport: transportEvidence(observedTransport) } : {}) }); }
        catch { receipt.status = 'unknown'; receipt.remoteQuiescent = false; }
      }
    }
    if (locked && receipt.processExited && receipt.remoteQuiescent && !receipt.remoteOutcomeUnknown && receipt.status !== 'unknown') {
      try { await this.unlock(context); } catch (error) { receipt.status = 'unknown'; receipt.remoteQuiescent = false; receipt.detail = redact(String(error)); }
    }
    return receipt;
  }
  private async ssh(action: 'inspect' | 'semantic', input: Buffer, key: string, knownHosts: string, directory: string, expiresAt?: string): Promise<TransportResult> {
    if (process.platform !== 'win32' || !this.options.processHost) throw new Error('FZ3B_WINDOWS_PROCESS_HOST_REQUIRED');
    const executable = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/OpenSSH/ssh.exe');
    const environment = fz3bSshEnvironment();
    await noLinks(executable); await noLinks(this.options.processHost); await noLinks(environment.ProgramData);
    if (!(await lstat(executable)).isFile() || !(await lstat(this.options.processHost)).isFile() || !(await lstat(environment.ProgramData)).isDirectory()) throw new Error('FZ3B_SSH_HOST_NOT_EXECUTABLE');
    if (action === 'semantic') {
      const now = this.now(), expires = Date.parse(expiresAt ?? '');
      if (!Number.isFinite(now) || !Number.isFinite(expires) || expires <= now || expires - now > 300000)
        return { processExited: true, exitCode: null, stdout: '', stderr: 'Native grant expired before SSH process dispatch', timedOut: false, spawned: false };
    }
    return new Promise(resolve => {
      let spawned = false; let completed = false; let exceeded = false; let outputBytes = 0; let errorBytes = 0;
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      const child = spawn(this.options.processHost!, ['--', executable, ...fixedFz3bSshArgs(key, knownHosts)], {
        cwd: directory, shell: false, windowsHide: true, env: environment, stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.children.add(child);
      child.once('spawn', () => { spawned = true; });
      child.stdout.on('data', (bytes: Buffer) => { outputBytes += bytes.length; if (outputBytes <= 131072) stdout.push(bytes); else exceeded = true; });
      child.stderr.on('data', (bytes: Buffer) => { errorBytes += bytes.length; if (errorBytes <= 16384) stderr.push(bytes); else exceeded = true; });
      child.stdin.on('error', () => { exceeded = true; });
      child.on('error', error => { if (!spawned) stderr.push(Buffer.from(error.message)); });
      child.stdin.end(input);
      const timer = setTimeout(() => {
        completed = true;
        resolve({ processExited: false, exitCode: null, stdout: '', stderr: 'Visibility deadline reached; process was not killed', timedOut: true, spawned });
      }, DEADLINE[action]);
      child.once('close', (exitCode) => {
        clearTimeout(timer); this.children.delete(child);
        const result = { processExited: true, exitCode, stdout: exceeded ? '' : Buffer.concat(stdout).toString('utf8'),
          stderr: redact(Buffer.concat(stderr).toString('utf8')), timedOut: false, spawned };
        void durableJson(path.join(directory, 'process-exit.json'), { schemaVersion: 1, observedClose: true, exitCode, at: new Date().toISOString(), outputSha256: fz3bDigest(Buffer.concat(stdout)) }).catch(() => {});
        if (!completed) resolve(result);
      });
    });
  }
}
