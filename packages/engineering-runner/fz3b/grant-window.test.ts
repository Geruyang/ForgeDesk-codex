import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Fz3bBackend } from './backend.js';
import { ProductionFz3bAdapter } from './worker.js';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bDigest } from './profile.js';
import { historicalFz3bProfileDefinitions } from './profile-history.js';
import type { Fz3bAdapterContext, Fz3bGrant } from './types.js';

const old = historicalFz3bProfileDefinitions()[0]!;
const now = Date.parse('2026-10-17T00:01:00.000Z');
function fixture() {
  const identity = { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot,
    platform: 'A0005' as const, contractId: FZ3B_PROFILE.encoderIdentity.contractId, deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256,
    existingPlSha256: FZ3B_PROFILE.existingPlSha256, transport: 'pinned-ssh' as const, helloAuthenticated: false as const };
  const context: Fz3bAdapterContext = { runId: 'audit-run', sessionId: 'audit-session', taskId: 'audit-task', operationId: 'audit-op',
    requestKey: 'audit-request', nonce: 'a'.repeat(64), profileSha256: old.profileSha256, fixture: structuredClone(old.fixture), identity,
    artifact: { id: 'audit-artifact', kind: 'fixed-ps-fixture-package', buildId: 'audit-build', profileSha256: old.profileSha256,
      sourceManifestSha256: old.profile.deployedManifestSha256, fixtureManifestSha256: old.fixture.manifestSha256,
      queriesSha256: old.fixture.queriesSha256, imageSha256: old.fixture.imageSha256, buildEvidenceSha256: 'b'.repeat(64),
      packageSha256: 'c'.repeat(64), packageManifestSha256: 'd'.repeat(64), newPlBuilt: false, deployed: false } };
  const backend = { profileHash: old.profileSha256, fixture: old.fixture, now: () => now };
  const body = { id: 'audit-grant', runId: context.runId, sessionId: context.sessionId, taskId: context.taskId, artifactId: context.artifact!.id,
    profileSha256: old.profileSha256, identity, fixture: context.fixture, scope: 'existing-candidate008-real-text-single-image-once' as const,
    actions: FZ3B_PROFILE.actions, createdAt: '2026-10-17T00:00:00.000Z', expiresAt: '2026-10-17T00:05:00.000Z' };
  context.grant = { ...body, planSha256: fz3bDigest(JSON.stringify(body)), approvedAt: '2026-10-17T00:00:01.000Z', consumedBy: context.operationId };
  return { backend, context };
}
function rehash(grant: Fz3bGrant) {
  const { planSha256: _pin, approvedAt: _approved, consumedBy: _consumed, ...body } = grant;
  grant.planSha256 = fz3bDigest(JSON.stringify(body));
}
const mutations = [
  ['invalid approvedAt', (grant: Fz3bGrant) => { grant.approvedAt = 'not-a-time'; }],
  ['invalid expiresAt', (grant: Fz3bGrant) => { grant.expiresAt = 'not-a-time'; }],
  ['invalid createdAt', (grant: Fz3bGrant) => { grant.createdAt = 'not-a-time'; }],
  ['infinite expiresAt', (grant: Fz3bGrant) => { grant.expiresAt = 'Infinity'; }],
  ['approval predates creation', (grant: Fz3bGrant) => { grant.approvedAt = '2026-10-16T23:59:59.000Z'; }],
  ['future creation', (grant: Fz3bGrant) => { grant.createdAt = '2026-10-17T00:01:01.000Z'; }],
  ['overlong lifetime', (grant: Fz3bGrant) => { grant.expiresAt = '2026-10-17T00:05:00.001Z'; }],
  ['expired at the current sample', (grant: Fz3bGrant) => { grant.expiresAt = '2026-10-17T00:01:00.000Z'; }],
  ['reversed lifetime', (grant: Fz3bGrant) => { grant.expiresAt = '2026-10-16T23:59:59.000Z'; }],
] as const;

async function workerCheck(context: Fz3bAdapterContext, clock = now) {
  const proto = ProductionFz3bAdapter.prototype as unknown as { remote(this: unknown, action: string, context: Fz3bAdapterContext): Promise<any>; base: Function };
  let keyCalls = 0;
  const memory = { options: { resourceRoot: path.resolve(fileURLToPath(new URL('../../../engineering/fz3b/product/resources/', import.meta.url))) },
    now: () => clock, preflightRecovery: { assertNoRecoveryBarrier: async () => {} }, base: proto.base,
    verifyArtifact: async () => {}, projectKey: async () => { keyCalls++; throw Error('Offline key boundary reached'); },
    evidence: async () => 'e'.repeat(64), lock: async () => { throw Error('Unexpected lock'); }, transport: async () => { throw Error('Unexpected transport'); } };
  return { result: await proto.remote.call(memory, 'semantic', context), keyCalls };
}

test('backend rejects invalid or noncausal approval windows even with a matching synthetic plan hash', () => {
  const check = (Fz3bBackend.prototype as unknown as { checkGrant(this: unknown, record: unknown): void }).checkGrant;
  for (const [label, mutate] of mutations) {
    const { backend, context } = fixture(); mutate(context.grant!); delete context.grant!.consumedBy; rehash(context.grant!);
    assert.throws(() => check.call(backend, context), /grant/, label);
  }
});

test('real worker rejects invalid or noncausal grant windows before key, lock, intent or transport', async () => {
  for (const [label, mutate] of mutations) {
    const { context } = fixture(); mutate(context.grant!); rehash(context.grant!);
    const { result, keyCalls } = await workerCheck(context);
    assert.equal(result.status, 'failed', label); assert.equal(keyCalls, 0, label);
    assert.match(result.detail, /FZ3B_NATIVE_GRANT_/, label);
  }
});

test('both layers reject NaN and infinite current-clock samples before consuming or requesting a key', async () => {
  for (const clock of [NaN, Infinity, -Infinity]) {
    const { backend, context } = fixture(); backend.now = () => clock;
    const original = structuredClone(context.grant); delete context.grant!.consumedBy;
    assert.throws(() => (Fz3bBackend.prototype as any).checkGrant.call(backend, context), /grant/);
    context.grant = original;
    const { result, keyCalls } = await workerCheck(context, clock);
    assert.equal(result.status, 'failed'); assert.equal(keyCalls, 0);
  }
});

test('backend samples current time once while checking an unchanged legitimate five-minute grant', () => {
  const { backend, context } = fixture(); delete context.grant!.consumedBy; let samples = 0;
  backend.now = () => { samples++; return now; };
  (Fz3bBackend.prototype as unknown as { checkGrant(this: unknown, record: unknown): void }).checkGrant.call(backend, context);
  assert.equal(samples, 1);
});
