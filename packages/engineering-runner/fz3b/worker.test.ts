import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { deterministicPsPackage } from './package.js';
import { durableJson } from '../embedded/files.js';
import { validateFz3bPrivateKey, FZ3B_PROJECT_KEY_FINGERPRINT } from './credentials.js';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bDigest, fz3bProfileSha256 } from './profile.js';
import { loadFz3bFixture, verifyFz3bResources, loadFz3bResourceBundle } from './resources.js';
import { ProductionFz3bAdapter, checkFz3bAvailability, fixedFz3bSshArgs, parseFz3bRemoteResult } from './worker.js';
import type { Fz3bAdapterContext, Fz3bArtifact, Fz3bIdentity, Fz3bSemanticFixture, Fz3bSemanticResult } from './types.js';

const RESOURCE_ROOT = fileURLToPath(new URL('../../../engineering/fz3b/product/resources/', import.meta.url));
const identity: Fz3bIdentity = { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot,
  platform: 'A0005', contractId: FZ3B_PROFILE.encoderIdentity.contractId, deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
  existingPlSha256: FZ3B_PROFILE.existingPlSha256, transport: 'pinned-ssh', helloAuthenticated: false };
const contextFor = (fixture: Fz3bSemanticFixture): Fz3bAdapterContext => ({ runId: 'run1', taskId: 'task1', sessionId: 'session1',
  operationId: randomUUID(), requestKey: randomUUID(), nonce: 'a'.repeat(64), profileSha256: fz3bProfileSha256(fixture), fixture });
function semanticFor(context: Fz3bAdapterContext): Fz3bSemanticResult {
  return { jobId: `fd-semantic-${context.operationId.replaceAll('-', '')}`, frameId: 0, queryRevision: 2, completedFrames: 1,
    fixtureManifestSha256: context.fixture.manifestSha256, queriesSha256: context.fixture.queriesSha256, imageSha256: context.fixture.imageSha256,
    encoderIdentity: context.fixture.encoderIdentity, ranking: [{ id: 'pillow', label: 'pillow', score: .3 }, { id: 'cup', label: 'cup', score: .1 },
      { id: 'mobile-phone', label: 'mobile-phone', score: .08 }, { id: 'bottle', label: 'bottle', score: .07 }],
    bestId: 'pillow', semanticInput: 'real-text-encoder', synthetic: false, classificationUnknown: false, threshold: .2, thresholdHit: true,
    expectedLabel: 'pillow', expectedLabelMatched: true, inferenceStopped: true, newPlLoaded: false };
}
function remote(context: Fz3bAdapterContext, action: 'inspect' | 'semantic'): {
  schemaVersion: 1; operationId: string; nonce: string; profileSha256: string; status: string;
  remoteQuiescent: boolean; remoteOutcomeUnknown: boolean; identity: Fz3bIdentity & { mainPid: number; loadedPlAttested: boolean };
  readOnly?: boolean; semantic?: Fz3bSemanticResult; grantId?: string;
} {
  return { schemaVersion: 1 as const, operationId: context.operationId, nonce: context.nonce, profileSha256: context.profileSha256,
    status: 'succeeded', remoteQuiescent: true, remoteOutcomeUnknown: false, identity: { ...identity, mainPid: 1234, loadedPlAttested: false },
    ...(action === 'inspect' ? { readOnly: true } : { semantic: semanticFor(context), grantId: context.grant?.id }) };
}
async function fixture() {
  const base = path.resolve('output/hardware/2026-10-16-next/product/worker-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-')); const fixture = await loadFz3bFixture(RESOURCE_ROOT);
  const adapter = new ProductionFz3bAdapter({ resourceRoot: RESOURCE_ROOT, dataDir: root });
  const internals = adapter as unknown as { projectKey: () => Promise<string>;
    now: () => number; persistIntent: typeof durableJson;
    transport: (action: 'inspect' | 'semantic', input: Buffer, key: string, known: string, directory: string) => Promise<{
      processExited: boolean; exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; spawned: boolean }> };
  let transportCalls = 0; let current!: Fz3bAdapterContext;
  internals.projectKey = async () => path.join(root, 'offline-key-not-used');
  internals.transport = async (action, input, _key, known) => {
    transportCalls++; assert.ok(input.includes(Buffer.from('forgedesk_main')));
    assert.equal(await readFile(known, 'utf8'), `${FZ3B_PROFILE.host} ${FZ3B_PROFILE.hostPublicKey}\n`);
    return { processExited: true, exitCode: 0, stdout: JSON.stringify(remote(current, action)) + '\n', stderr: '', timedOut: false, spawned: true };
  };
  const ctx = () => contextFor(fixture);
  const set = (context: Fz3bAdapterContext) => { current = context; return context; };
  async function build() {
    const context = ctx(); const result = await adapter.build(context); assert.equal(result.status, 'succeeded');
    const artifact: Fz3bArtifact = { id: randomUUID(), kind: 'fixed-ps-fixture-package', buildId: context.operationId,
      profileSha256: context.profileSha256, sourceManifestSha256: result.sourceManifestSha256, fixtureManifestSha256: result.fixtureManifestSha256,
      queriesSha256: result.queriesSha256, imageSha256: result.imageSha256, buildEvidenceSha256: result.evidenceSha256,
      packageSha256: result.packageSha256!, packageManifestSha256: result.packageManifestSha256!, newPlBuilt: false, deployed: false };
    return { context, result, artifact };
  }
  function approved(artifact: Fz3bArtifact) {
    const context = ctx(); context.artifact = artifact; context.identity = identity;
    const created = Date.now();
    const plan = { id: randomUUID(), runId: context.runId, sessionId: context.sessionId, taskId: context.taskId, artifactId: artifact.id,
      profileSha256: context.profileSha256, identity, fixture, scope: 'existing-candidate008-real-text-single-image-once', actions: FZ3B_PROFILE.actions,
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + 300000).toISOString() } as const;
    context.grant = { ...plan, planSha256: fz3bDigest(JSON.stringify(plan)), approvedAt: new Date().toISOString(), consumedBy: context.operationId };
    return set(context);
  }
  return { root, adapter, internals, ctx, set, build, approved, fixture, count: () => transportCalls, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('sealed production resources include actual dense real-text features, source and research license', async () => {
  await verifyFz3bResources(RESOURCE_ROOT);
  const resources = await loadFz3bResourceBundle(RESOURCE_ROOT);
  assert.equal(resources.fixture.queriesSha256, '0d10e566bb1c167d3987e8d782f1c0c6f87ee3c1aaba9983afe1f8a134e106e9');
  assert.equal(resources.fixture.manifestSha256, 'febcb9d93517f3c98eadb5d98eea6808f243fb6a1d4b61215cd981503de98e56');
  assert.ok(resources.files.has('licenses/MobileCLIP-LICENSE_MODELS.txt'));
  const features = resources.files.get('fixture/text-features.f32')!;
  assert.equal(features.length, 8192); assert.equal(fz3bDigest(features), 'eab4d0f4a6dc2abc19a0dfc59a0e026889039d1bad79260df7e0e8117fe2aaaf');
  assert.ok([...resources.files.keys()].filter(name => name.startsWith('ps-src/')).length > 25);
});

test('fresh real data directory reports typed missing key only after sealed resources verify', async () => {
  const f = await fixture();
  try {
    const absentDirectory = await checkFz3bAvailability(RESOURCE_ROOT, f.root);
    assert.deepEqual(absentDirectory, { available: false, status: 'missing-key', resourcesVerified: true, reason: 'FZ3B_PROJECT_KEY_MISSING' });
    const privateDirectory = path.join(f.root, 'fz3b-private'); await mkdir(privateDirectory);
    assert.deepEqual(await checkFz3bAvailability(RESOURCE_ROOT, f.root), absentDirectory);
    await writeFile(path.join(privateDirectory, 'id_ed25519'), 'invalid-public-or-private-key');
    const invalidKey = await checkFz3bAvailability(RESOURCE_ROOT, f.root);
    assert.equal(invalidKey.status, 'invalid-key'); assert.equal(invalidKey.resourcesVerified, true); assert.equal(invalidKey.available, false);
  } finally { await f.cleanup(); }
});

test('missing or changed resources never report missing-key even for a fresh keyless data directory', async () => {
  const f = await fixture();
  try {
    const missing = await checkFz3bAvailability(path.join(f.root, 'no-resources'), f.root);
    assert.equal(missing.status, 'invalid-resources'); assert.equal(missing.resourcesVerified, false); assert.equal(missing.available, false);
    const root = path.join(f.root, 'resources'); await cp(RESOURCE_ROOT, root, { recursive: true });
    await writeFile(path.join(root, 'remote/remote.py'), 'changed');
    const changed = await checkFz3bAvailability(root, f.root);
    assert.equal(changed.status, 'invalid-resources'); assert.equal(changed.resourcesVerified, false); assert.equal(changed.available, false);
  } finally { await f.cleanup(); }
});

test('linked private directory is invalid-key and cannot masquerade as an importable missing key', async () => {
  const f = await fixture();
  try {
    const target = path.join(f.root, 'linked-private'); await mkdir(target);
    await symlink(target, path.join(f.root, 'fz3b-private'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await checkFz3bAvailability(RESOURCE_ROOT, f.root);
    assert.equal(result.status, 'invalid-key'); assert.equal(result.resourcesVerified, true); assert.equal(result.available, false);
  } finally { await f.cleanup(); }
});

test('deterministic PS package is real USTAR, source-order independent and contains exact bytes', () => {
  const first = deterministicPsPackage([{ path: 'ps-src/main.py', bytes: Buffer.from('print(1)\n') }, { path: 'fixture/query.json', bytes: Buffer.from('{}') }]);
  const second = deterministicPsPackage([{ path: 'fixture/query.json', bytes: Buffer.from('{}') }, { path: 'ps-src/main.py', bytes: Buffer.from('print(1)\n') }]);
  assert.deepEqual(first.archive, second.archive); assert.equal(first.archive.length % 512, 0);
  const collected = new Map<string, Buffer>();
  for (let offset = 0; offset < first.archive.length && first.archive[offset];) {
    const header = first.archive.subarray(offset, offset + 512);
    assert.equal(header.toString('ascii', 257, 263), 'ustar\0');
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, ''), 8);
    const stated = Number.parseInt(header.toString('ascii', 148, 156).trim().replace(/\0.*$/, ''), 8);
    const checked = Buffer.from(header); checked.fill(32, 148, 156); assert.equal(checked.reduce((sum, byte) => sum + byte, 0), stated);
    collected.set(name, first.archive.subarray(offset + 512, offset + 512 + size)); offset += 512 + size + ((512 - size % 512) % 512);
  }
  assert.equal(collected.get('ps-src/main.py')!.toString(), 'print(1)\n');
  assert.deepEqual(collected.get('PACKAGE_MANIFEST.json'), first.manifest);
  assert.equal(JSON.parse(first.manifest.toString()).newPlBuilt, false);
});

for (const name of ['../escape', '/absolute', 'a/../b', 'a//b', 'C:/bad', 'a\\b']) test(`package refuses ${name}`, () => {
  assert.throws(() => deterministicPsPackage([{ path: name, bytes: Buffer.from('x') }]), /PATH/);
});

test('actual local PS package generation yields sealed archive/manifest and public evidence without SSH', async () => {
  const f = await fixture();
  try {
    const { context, result } = await f.build(); assert.equal(f.count(), 0); assert.equal(result.newPlBuilt, false); assert.equal(result.deployed, false);
    const files = await f.adapter.readPublicEvidence(context.operationId, result.evidenceSha256);
    assert.deepEqual(files.map(file => file.name), ['evidence.json', 'ps-acceptance.tar', 'package-manifest.json']);
    const bundle = await loadFz3bResourceBundle(RESOURCE_ROOT);
    const rebuilt = deterministicPsPackage([...bundle.files].filter(([name]) => /^(ps-src|fixture|licenses)\//.test(name)).map(([name, bytes]) => ({ path: name, bytes })));
    assert.deepEqual(files[1].bytes, rebuilt.archive); assert.equal(result.packageSha256, fz3bDigest(rebuilt.archive));
    assert.equal(files[2].sha256, result.packageManifestSha256); assert.ok(files[1].bytes.length > 200000);
    await assert.rejects(f.adapter.readPublicEvidence(context.operationId, '0'.repeat(64)), /CHANGED/);
    await assert.rejects(f.adapter.readPublicEvidence('../escape', result.evidenceSha256), /identifier/);
  } finally { await f.cleanup(); }
});

test('fixed SSH args pin host/key with no agent, forwarding, proxy, password or model-supplied command', () => {
  const args = fixedFz3bSshArgs('C:/fixed/key', 'C:/fixed/known_hosts');
  assert.deepEqual(args.slice(-2), ['root@169.254.220.254', 'python3 -B -']);
  for (const value of ['IdentitiesOnly=yes', 'IdentityAgent=none', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=NUL', 'PasswordAuthentication=no',
    'KbdInteractiveAuthentication=no', 'ProxyCommand=none', 'ProxyJump=none', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no']) assert.ok(args.includes(value));
  assert.equal(args.includes('-L'), false); assert.equal(args.includes('-R'), false);
});

test('private key validator rejects malformed, encrypted/nonfixed and public-only bytes without revealing content', () => {
  for (const input of [Buffer.alloc(100), Buffer.from('ssh-ed25519 anything'), Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nYWJjZA==\n-----END OPENSSH PRIVATE KEY-----\n')]) {
    assert.throws(() => validateFz3bPrivateKey(input), /FZ3B_PROJECT_KEY_/);
  }
  assert.match(FZ3B_PROJECT_KEY_FINGERPRINT, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test('successful inspect projects only the typed public identity and stores full bound remote evidence', async () => {
  const f = await fixture();
  try {
    const context = f.set(f.ctx()); const result = await f.adapter.inspect(context);
    assert.equal(result.status, 'succeeded'); assert.deepEqual(result.identity, identity); assert.equal(f.count(), 1);
    const files = await f.adapter.readPublicEvidence(context.operationId, result.evidenceSha256);
    assert.equal(files.length, 1); const evidence = JSON.parse(files[0].bytes.toString('utf8'));
    assert.deepEqual(parseFz3bRemoteResult(evidence.remoteStdout, context, 'inspect'), evidence.remote);
    assert.equal(evidence.authenticatedTransport, 'pinned-ssh');
    assert.equal((result.identity as unknown as Record<string, unknown>).mainPid, undefined);
  } finally { await f.cleanup(); }
});

for (const field of ['operationId', 'nonce', 'profileSha256', 'bootId', 'remoteQuiescent'] as const) test(`remote parser rejects stale/unsafe ${field}`, async () => {
  const fixture = await loadFz3bFixture(RESOURCE_ROOT); const context = contextFor(fixture); const value = remote(context, 'inspect');
  if (field === 'bootId') value.identity.bootId = 'stale-boot'; else if (field === 'remoteQuiescent') value.remoteQuiescent = false;
  else value[field] = field === 'operationId' ? randomUUID() : 'f'.repeat(64);
  assert.throws(() => parseFz3bRemoteResult(JSON.stringify(value) + '\n', context, 'inspect'), /BINDING|IDENTITY|QUIESCENT/);
});

test('semantic result retains independent strict ranking and fixed threshold decision, including low-score top1', async () => {
  const fixture = await loadFz3bFixture(RESOURCE_ROOT); const context = contextFor(fixture);
  context.grant = { id: 'grant1' } as Fz3bAdapterContext['grant'];
  const value = remote(context, 'semantic'); value.semantic!.ranking[0].score = .15; value.semantic!.thresholdHit = false;
  value.semantic!.classificationUnknown = true; value.semantic!.expectedLabelMatched = true;
  assert.equal(parseFz3bRemoteResult(JSON.stringify(value) + '\n', context, 'semantic').semantic!.expectedLabelMatched, true);
  value.semantic!.ranking[1].score = .15; value.semantic!.expectedLabelMatched = false;
  assert.equal(parseFz3bRemoteResult(JSON.stringify(value) + '\n', context, 'semantic').semantic!.expectedLabelMatched, false);
});

test('semantic requires native consumed grant and current built package before any transport', async () => {
  const f = await fixture();
  try {
    const { artifact } = await f.build();
    const context = f.ctx(); context.artifact = artifact; context.identity = identity;
    const result = await f.adapter.semantic(context); assert.equal(result.status, 'failed'); assert.equal(f.count(), 0);
    assert.match(result.detail!, /GRANT/);
  } finally { await f.cleanup(); }
});

test('semantic with exact grant, real packaged fixture and intact artifact yields narrow result and auditable evidence', async () => {
  const f = await fixture();
  try {
    const { artifact } = await f.build(); const context = f.approved(artifact);
    const result = await f.adapter.semantic(context);
    assert.equal(result.status, 'succeeded'); assert.equal(result.semantic!.semanticInput, 'real-text-encoder'); assert.equal(result.grantId, context.grant!.id);
    assert.equal(result.semantic!.jobId, `fd-semantic-${context.operationId.replaceAll('-', '')}`); assert.equal(f.count(), 1);
    assert.equal((await f.adapter.readPublicEvidence(context.operationId, result.evidenceSha256)).length, 1);
  } finally { await f.cleanup(); }
});

test('changed PS package blocks semantic transport despite a valid native grant', async () => {
  const f = await fixture();
  try {
    const { context: build, artifact } = await f.build();
    await writeFile(path.join(f.root, 'fz3b-worker', build.operationId, 'ps-acceptance.tar'), 'tampered');
    const result = await f.adapter.semantic(f.approved(artifact)); assert.equal(result.status, 'failed'); assert.equal(f.count(), 0);
    assert.match(result.detail!, /PACKAGE_CHANGED/);
  } finally { await f.cleanup(); }
});

test('grant expiring during durable intent never dispatches SSH and releases only its unstarted lock', async () => {
  const f = await fixture();
  try {
    const { artifact } = await f.build(); const context = f.approved(artifact);
    let now = Date.now(); f.internals.now = () => now;
    let entered!: () => void; let release!: () => void;
    const enteredIntent = new Promise<void>(resolve => { entered = resolve; });
    const pendingIntent = new Promise<void>(resolve => { release = resolve; });
    f.internals.persistIntent = async (file, value) => {
      await durableJson(file, value); entered(); await pendingIntent;
    };
    const operation = f.adapter.semantic(context); await enteredIntent;
    now = Date.parse(context.grant!.expiresAt) + 1; release();
    const result = await operation;
    assert.equal(result.status, 'failed'); assert.equal(result.processExited, true);
    assert.equal(result.remoteQuiescent, true); assert.equal(result.remoteOutcomeUnknown, false);
    assert.match(result.detail!, /EXPIRED_BEFORE_DISPATCH/); assert.equal(f.count(), 0);
    await assert.rejects(readFile(path.join(f.root, 'fz3b-worker/active.lock')), { code: 'ENOENT' });
    f.internals.persistIntent = durableJson;
    assert.equal((await f.adapter.inspect(f.set(f.ctx()))).status, 'succeeded'); assert.equal(f.count(), 1);
  } finally { await f.cleanup(); }
});

test('nonfinite clocks after key preparation or durable intent refuse semantic transport without retry', async () => {
  for (const phase of ['key', 'intent']) for (const invalid of [NaN, Infinity, -Infinity]) {
    const f = await fixture();
    try {
      const { artifact } = await f.build(); const context = f.approved(artifact);
      let now = Date.now(); f.internals.now = () => now;
      if (phase === 'key') f.internals.projectKey = async () => { now = invalid; return path.join(f.root, 'offline-key-not-used'); };
      else f.internals.persistIntent = async (file, value) => { await durableJson(file, value); now = invalid; };
      const result = await f.adapter.semantic(context);
      assert.equal(result.status, 'failed', `${phase}/${invalid}`); assert.equal(f.count(), 0, `${phase}/${invalid}`);
      assert.equal(result.processExited, true); assert.equal(result.remoteQuiescent, true); assert.equal(result.remoteOutcomeUnknown, false);
      assert.match(result.detail!, /EXPIRED_BEFORE_DISPATCH/);
    } finally { await f.cleanup(); }
  }
});

test('SSH close alone cannot release a remote unknown; later operations never replay it', async () => {
  const f = await fixture();
  try {
    const { artifact } = await f.build(); const context = f.approved(artifact);
    let count = 0;
    f.internals.transport = async () => { count++; return { processExited: true, exitCode: 0, stdout: JSON.stringify({ ...remote(context, 'semantic'), status: 'unknown', remoteQuiescent: false, remoteOutcomeUnknown: true }) + '\n', stderr: '', timedOut: false, spawned: true }; };
    const result = await f.adapter.semantic(context); assert.equal(result.status, 'unknown'); assert.equal(result.processExited, true); assert.equal(result.remoteQuiescent, false);
    await f.adapter.semantic(context); await f.adapter.inspect(f.ctx()); assert.equal(count, 1);
    const other = new ProductionFz3bAdapter({ resourceRoot: RESOURCE_ROOT, dataDir: f.root });
    assert.equal((await other.build(f.ctx())).status, 'failed');
  } finally { await f.cleanup(); }
});

test('remote visibility timeout stays unknown with processExited false and never retries', async () => {
  const f = await fixture();
  try {
    f.internals.transport = async () => ({ processExited: false, exitCode: null, stdout: '', stderr: 'deadline', timedOut: true, spawned: true });
    const result = await f.adapter.inspect(f.ctx()); assert.equal(result.status, 'unknown'); assert.equal(result.processExited, false); assert.equal(result.remoteQuiescent, false);
  } finally { await f.cleanup(); }
});

test('observed SSH exit255 with empty stdout stays unknown and preserves bounded redacted transport facts', async () => {
  const f = await fixture();
  try {
    const context = f.ctx();
    const syntheticStderr = 'synthetic fixture: key C:/private/user/key\npassword=do-not-export\n' + 'x'.repeat(5000);
    f.internals.transport = async () => ({ processExited: true, exitCode: 255, stdout: '', stderr: syntheticStderr, timedOut: false, spawned: true });
    const result = await f.adapter.inspect(context);
    assert.equal(result.status, 'unknown'); assert.equal(result.processExited, true); assert.equal(result.remoteQuiescent, false);
    assert.match(result.detail!, /RECEIPT_ENVELOPE/);
    const files = await f.adapter.readPublicEvidence(context.operationId, result.evidenceSha256);
    const evidence = JSON.parse(files[0].bytes.toString());
    assert.equal(evidence.action, 'inspect'); assert.equal(evidence.operationId, context.operationId); assert.equal(evidence.nonce, context.nonce);
    assert.equal(evidence.transport.exitCode, 255); assert.equal(evidence.transport.stdoutBytes, 0);
    assert.equal(evidence.transport.stdoutSha256, fz3bDigest(''));
    assert.equal(evidence.transport.spawned, true); assert.ok(Buffer.byteLength(evidence.transport.stderr) <= 4096);
    assert.equal(evidence.transport.stderr.includes('do-not-export'), false); assert.equal(evidence.transport.stderr.includes('C:/private'), false);
    const observed = JSON.parse(await readFile(path.join(f.root, 'fz3b-worker', context.operationId, 'transport.json'), 'utf8'));
    assert.deepEqual(observed.transport, evidence.transport);
    await f.adapter.inspect(f.ctx()); assert.equal((await readFile(path.join(f.root, 'fz3b-worker/active.lock'), 'utf8')).includes(context.operationId), true);
  } finally { await f.cleanup(); }
});

for (const change of ['extra', 'changed', 'link'] as const) test(`resource validation rejects ${change} before build/SSH`, async () => {
  const f = await fixture();
  try {
    const root = path.join(f.root, 'resources'); await cp(RESOURCE_ROOT, root, { recursive: true });
    if (change === 'extra') await writeFile(path.join(root, 'injected.py'), 'anything');
    if (change === 'changed') await writeFile(path.join(root, 'remote/remote.py'), 'anything');
    if (change === 'link') await symlink(path.join(root, 'fixture'), path.join(root, 'extra-linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(verifyFz3bResources(root), /RESOURCE|Reparse|reparse|links/);
  } finally { await f.cleanup(); }
});
