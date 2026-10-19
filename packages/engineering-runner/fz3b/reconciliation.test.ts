import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { durableJson } from '../embedded/files.js';
import { Fz3bInspectReconciler } from './reconciliation-worker.js';
import { loadFz3bFixture, loadFz3bResourceBundle } from './resources.js';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { legacyInspectPayload } from './payload.js';
import type { Fz3bInspectReconciliationContext } from './types.js';

const resources = fileURLToPath(new URL('../../../engineering/fz3b/product/resources/', import.meta.url));
const actual = path.resolve('output/hardware/2026-10-16-next/product/inspect-failure-fixture');
const digest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));
async function fixture() {
  const base = path.resolve('output/hardware/2026-10-16-next/product/reconciliation-tests'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'case-'));
  const originalEvidence = JSON.parse(await readFile(path.join(actual, 'evidence.json'), 'utf8'));
  const context: Fz3bInspectReconciliationContext = { schemaVersion: 1, id: randomUUID(), nonce: 'c'.repeat(64), createdAt: new Date().toISOString(),
    original: { runId: '8b065e0a-c1ef-4848-8329-b18c19dda45c', taskId: 'd5b60090-3356-44ee-960b-39b9b2b5a39b',
      sessionId: 'd5b60090-3356-44ee-960b-39b9b2b5a39b', operationId: originalEvidence.operationId,
      nonce: originalEvidence.nonce, profileSha256: originalEvidence.profileSha256, fixture: await loadFz3bFixture(resources), requestKey: 'original-inspect-key' },
    originalEvidenceSha256: fz3bDigest(await readFile(path.join(actual, 'evidence.json'))), originalOperationSha256: 'a'.repeat(64), ownerBindingSha256: 'b'.repeat(64) };
  const op = path.join(root, context.original.operationId); await cp(actual, op, { recursive: true });
  await durableJson(path.join(root, 'active.lock'), { schemaVersion: 1, operationId: context.original.operationId, nonce: context.original.nonce,
    taskId: context.original.taskId, profileSha256: context.original.profileSha256 });
  let calls = 0, children = 0, releases = 0;
  let alter: (value: any) => any = value => value;
  const worker = new Fz3bInspectReconciler({ root, resourceRoot: resources, children: () => children, released: () => { releases++; },
    projectKey: async () => 'offline-key-never-opened', transport: async input => {
      calls++; assert.equal(input.includes(Buffer.from('forgedesk_reconcile')), true);
      const raw = input.toString().match(/forgedesk_reconcile\(json.loads\(base64.b64decode\('([^']+)'\)/)![1];
      const request = JSON.parse(Buffer.from(raw, 'base64').toString());
      return alter({ spawned: true, processExited: true, exitCode: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ schemaVersion: 1,
        id: request.id, nonce: request.nonce, contextSha256: request.contextSha256, profileSha256: request.profileSha256, status: 'succeeded',
        identity: { bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot, platform: 'A0005', contractId: FZ3B_PROFILE.encoderIdentity.contractId,
          deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256, existingPlSha256: FZ3B_PROFILE.existingPlSha256 },
        remote: { readOnly: true, metadataStable: true, deviceOwners: [], controlConnections: 0, inspectorPids: [], unfinishedJournalEntries: 0,
          scanCount: 2, procScanComplete: true, journalScanComplete: true, originalInspectorAbsent: true } }) + '\n' });
    } });
  return { root, op, context, worker, calls: () => calls, releases: () => releases, children: (value: number) => { children = value; },
    alter: (value: typeof alter) => { alter = value; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('real failed installed inspect fixture remains byte-bound and its old approved payload reconstructs exactly', async () => {
  const f = await fixture();
  try {
    assert.equal(f.context.originalEvidenceSha256, '7aa14eeb18dae936342e8f197d6ca690260d4bd4d47a1178a6a2a33ac0affa43');
    const intent = JSON.parse(await readFile(path.join(f.op, 'intent.json'), 'utf8'));
    assert.equal(fz3bDigest(legacyInspectPayload(await loadFz3bResourceBundle(resources), f.context.original)), intent.payloadSha256);
    assert.equal(intent.payloadSha256, '95c4b726eba9ffefcada28ba8b7f4004c83551aad22d995a1397b1950cd3ae5c');
  } finally { await f.cleanup(); }
});

test('prepare preserves original unknown and exact lease; finalize releases only after durable proof and is idempotent', async () => {
  const f = await fixture();
  try {
    const old = await readFile(path.join(f.op, 'evidence.json')); const lock = await readFile(path.join(f.root, 'active.lock'));
    const proof = await f.worker.prepare(f.context); assert.equal(f.calls(), 1);
    assert.deepEqual(await readFile(path.join(f.root, 'active.lock')), lock); assert.deepEqual(await readFile(path.join(f.op, 'evidence.json')), old);
    assert.equal((await f.worker.prepare(f.context)).evidenceSha256, proof.evidenceSha256); assert.equal(f.calls(), 1);
    const finalized = await f.worker.finalize(f.context, proof); assert.equal(finalized.lockReleased, true); assert.equal(f.releases(), 1);
    assert.equal((await f.worker.finalize(f.context, proof)).evidenceSha256, finalized.evidenceSha256);
    await assert.rejects(readFile(path.join(f.root, 'active.lock')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(path.join(f.op, 'evidence.json')), old);
    assert.deepEqual((await f.worker.publicEvidence(f.context, proof, finalized)).map(file => file.name), ['proof-evidence.json', 'finalization-evidence.json']);
  } finally { await f.cleanup(); }
});

for (const change of ['semantic', 'wrong-payload', 'unapproved-resource', 'missing-close', 'alive-local', 'foreign-owner'] as const) test(`prepare rejects ${change} with zero transport and retains lease`, async () => {
  const f = await fixture();
  try {
    if (change === 'alive-local') f.children(1);
    if (change === 'missing-close') await rm(path.join(f.op, 'process-exit.json'));
    if (change === 'foreign-owner') await durableJson(path.join(f.root, 'active.lock'), { schemaVersion: 1, operationId: 'other-operation' });
    if (change === 'semantic') {
      const file = path.join(f.op, 'evidence.json'); const value = JSON.parse(await readFile(file, 'utf8')); value.kind = 'semantic'; value.readOnly = false;
      await durableJson(file, value); f.context.originalEvidenceSha256 = fz3bDigest(await readFile(file));
    }
    if (change === 'wrong-payload' || change === 'unapproved-resource') {
      const file = path.join(f.op, 'intent.json'); const value = JSON.parse(await readFile(file, 'utf8'));
      value[change === 'wrong-payload' ? 'payloadSha256' : 'resourceManifestSha256'] = 'd'.repeat(64); await durableJson(file, value);
    }
    await assert.rejects(f.worker.prepare(f.context)); assert.equal(f.calls(), 0); await readFile(path.join(f.root, 'active.lock'));
  } finally { await f.cleanup(); }
});

for (const bad of ['inspector', 'journal', 'incomplete', 'metadata', 'timeout', 'stale-id'] as const) test(`fresh ${bad} proof never releases unknown`, async () => {
  const f = await fixture();
  try {
    f.alter(transport => {
      if (bad === 'timeout') return { ...transport, processExited: false, timedOut: true };
      const value = JSON.parse(transport.stdout);
      if (bad === 'inspector') value.remote.inspectorPids = [999];
      if (bad === 'journal') value.remote.unfinishedJournalEntries = 1;
      if (bad === 'incomplete') value.remote.procScanComplete = false;
      if (bad === 'metadata') value.remote.metadataStable = false;
      if (bad === 'stale-id') value.id = randomUUID();
      return { ...transport, stdout: JSON.stringify(value) + '\n' };
    });
    await assert.rejects(f.worker.prepare(f.context)); assert.equal(f.calls(), 1); await readFile(path.join(f.root, 'active.lock'));
    await assert.rejects(f.worker.prepare(f.context)); assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('finalization refuses a new foreign lease even with a prior valid proof or finalization marker', async () => {
  const f = await fixture();
  try {
    const proof = await f.worker.prepare(f.context);
    await durableJson(path.join(f.root, 'reconciliation.lock'), { id: 'other-readonly-probe' });
    await assert.rejects(f.worker.finalize(f.context, proof), /GUARD_HELD/); await readFile(path.join(f.root, 'active.lock'));
    await rm(path.join(f.root, 'reconciliation.lock'));
    await durableJson(path.join(f.root, 'active.lock'), { schemaVersion: 1, operationId: 'new-owner' });
    await assert.rejects(f.worker.finalize(f.context, proof), /FOREIGN_LEASE/); assert.equal(f.releases(), 0);
  } finally { await f.cleanup(); }
});

test('proof or finalization-marker persistence failure never unlinks the original lease', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, 'reconciliations', f.context.id);
    await mkdir(path.join(directory, 'proof-evidence.json'), { recursive: true });
    await assert.rejects(f.worker.prepare(f.context)); assert.equal(f.calls(), 1);
    await readFile(path.join(f.root, 'active.lock'));
    await assert.rejects(f.worker.prepare(f.context)); assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
  const second = await fixture();
  try {
    const proof = await second.worker.prepare(second.context);
    await mkdir(path.join(second.root, 'reconciliations', second.context.id, 'finalization-evidence.json'));
    await assert.rejects(second.worker.finalize(second.context, proof));
    await readFile(path.join(second.root, 'active.lock')); assert.equal(second.releases(), 0);
  } finally { await second.cleanup(); }
});

test('failed exact unlink leaves a bound durable marker and supports only the same proof retry', async () => {
  const f = await fixture();
  try {
    const proof = await f.worker.prepare(f.context);
    const internals = f.worker as unknown as { removeLease: (file: string) => Promise<void> };
    internals.removeLease = async () => { throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' }); };
    await assert.rejects(f.worker.finalize(f.context, proof), /synthetic EPERM/);
    await readFile(path.join(f.root, 'active.lock')); assert.equal(f.releases(), 0);
    const marker = JSON.parse(await readFile(path.join(f.root, 'reconciliations', f.context.id, 'finalization-evidence.json'), 'utf8'));
    assert.equal(marker.contextSha256, digest(f.context)); assert.equal(marker.proofSha256, digest(proof));
    internals.removeLease = async file => { await rm(file); };
    assert.equal((await f.worker.finalize(f.context, proof)).lockReleased, true);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

test('freshness crossing during the last lease read blocks exact unlink even with an existing marker', async () => {
  const f = await fixture();
  try {
    const proof = await f.worker.prepare(f.context);
    const internals = f.worker as unknown as { now: () => number; lease: (context: Fz3bInspectReconciliationContext) => Promise<unknown>; removeLease: (file: string) => Promise<void> };
    const originalLease = internals.lease.bind(f.worker); let now = Date.now(); let unlinks = 0;
    internals.now = () => now;
    internals.removeLease = async () => { unlinks++; throw new Error('should not unlink an expired proof'); };
    internals.lease = async context => { const value = await originalLease(context); now = Date.parse(proof.observedAt) + 120001; return value; };
    await assert.rejects(f.worker.finalize(f.context, proof), /stale/); assert.equal(unlinks, 0); assert.equal(f.releases(), 0);
    await readFile(path.join(f.root, 'active.lock'));
    now = Date.now(); internals.lease = originalLease;
    internals.removeLease = async () => { throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' }); };
    await assert.rejects(f.worker.finalize(f.context, proof), /synthetic EPERM/);
    now = Date.now(); internals.lease = async context => { const value = await originalLease(context); now = Date.parse(proof.observedAt) + 120001; return value; };
    internals.removeLease = async () => { unlinks++; };
    await assert.rejects(f.worker.finalize(f.context, proof), /stale/); assert.equal(unlinks, 0); assert.equal(f.releases(), 0);
    await readFile(path.join(f.root, 'active.lock'));
  } finally { await f.cleanup(); }
});

test('post-unlink expiry stays held for manual review and a missing lease is not a fresh-proof success', async () => {
  const f = await fixture();
  try {
    const original = await readFile(path.join(f.op, 'evidence.json')); const proof = await f.worker.prepare(f.context);
    let now = Date.now();
    const internals = f.worker as unknown as { now: () => number; removeLease: (file: string) => Promise<void> };
    internals.now = () => now;
    internals.removeLease = async file => { await rm(file); now = Date.parse(proof.observedAt) + 120001; };
    await assert.rejects(f.worker.finalize(f.context, proof), /stale/); assert.equal(f.releases(), 0);
    await readFile(path.join(f.root, 'reconciliations', f.context.id, 'finalization-evidence.json'));
    await assert.rejects(readFile(path.join(f.root, 'active.lock')), { code: 'ENOENT' });
    await assert.rejects(f.worker.finalize(f.context, proof), /stale/);
    const fresh = { ...f.context, id: randomUUID(), nonce: 'e'.repeat(64), createdAt: new Date(now).toISOString() };
    await assert.rejects(f.worker.prepare(fresh), { code: 'ENOENT' }); assert.equal(f.calls(), 1);
    assert.deepEqual(await readFile(path.join(f.op, 'evidence.json')), original);
  } finally { await f.cleanup(); }
});

test('local maintenance proof needs context-bound observed close, not an empty in-memory children set', async () => {
  const f = await fixture();
  try {
    const original = await readFile(path.join(f.op, 'evidence.json'));
    const state = await f.worker.localProcessState([f.context.original]); assert.equal(state.closed, true);
    assert.equal(state.operations[0].closeConfirmed, true); assert.equal(state.operations[0].operationId, f.context.original.operationId);
    await durableJson(path.join(f.root, 'reconciliation.lock'), { id: 'unconfirmed-probe' });
    assert.equal((await f.worker.localProcessState([f.context.original])).closed, false);
    await rm(path.join(f.root, 'reconciliation.lock'));
    const closeFile = path.join(f.op, 'process-exit.json'); const close = JSON.parse(await readFile(closeFile, 'utf8')); close.observedClose = false;
    await durableJson(closeFile, close);
    assert.equal((await f.worker.localProcessState([f.context.original])).closed, false);
    assert.deepEqual(await readFile(path.join(f.op, 'evidence.json')), original);
    assert.notEqual(digest(state), digest({ ...state, closed: false }));
  } finally { await f.cleanup(); }
});
