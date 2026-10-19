import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Fz3bBackend } from './backend.js';
import { backendPreflightFixture, preflightRecoveryFixture } from './preflight-recovery.fixture.js';
import { fz3bPreflightDigest, fz3bPreflightRecordProjection, fz3bPreflightSourceProjection,
  FZ3B_PREFLIGHT_RECOVERY_CASE, assertFz3bMaintenanceLocalCloseProof,
  assertFz3bPreflightRecoveryProof, fz3bReleasedPreflightRefusalRecovery } from './preflight-recovery.js';
import { fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { ProductionFz3bAdapter } from './worker.js';

test('closed whole-record projection verifies maintenance bytes and only normalizes reviewed host restart text', () => {
  const f = preflightRecoveryFixture();
  f.record.failure = 'Application restarted; planning stopped and no action was replayed';
  const result = fz3bPreflightRecordProjection(f.record, f.fixture);
  assert.equal(result.sourceRun.failure, f.record.failure);
  assert.equal(result.projection.failure, 'Error: FZ3B receipt is not terminal and quiescent');
  assert.equal(result.maintenanceExitSha256, fz3bPreflightDigest(f.record.maintenanceExit));
  assert.ok(result.sourceRun.maintenanceExit); assert.equal(result.projection.maintenanceExit, undefined);
  assert.equal(result.sourceRecordSha256, fz3bPreflightDigest(f.record));
  assert.deepEqual(result.projection.operations, f.record.operations); assert.deepEqual(result.projection.calls, f.record.calls);
});

for (const field of ['grant', 'semantic', 'identity', 'export', 'reconciliations', 'unreviewedAuthority']) test(`projection cannot hide ${field}`, () => {
  const f = preflightRecoveryFixture();
  (f.record as any)[field] = {};
  assert.throws(() => fz3bPreflightRecordProjection(f.record, f.fixture), /CLOSED_SCHEMA/);
});

test('maintenance changed scope, close hash, seal bytes, operation digest, extra child or bool count is rejected', () => {
  for (const field of ['seal', 'snapshot', 'owner', 'closehash', 'extra', 'bool']) {
    const f = preflightRecoveryFixture(), seal = f.record.maintenanceExit!;
    if (field === 'seal') seal.sealSha256 = '0'.repeat(64);
    else if (field === 'snapshot') seal.operationSnapshotSha256 = '0'.repeat(64);
    else if (field === 'owner') seal.taskId = 'foreign';
    else if (field === 'closehash') seal.processState.operations[0].evidenceSha256 = '0'.repeat(64);
    else if (field === 'extra') (seal.processState as any).authorization = true;
    else (seal.processState as any).liveChildren = false;
    if (field !== 'seal') { const { sealSha256: _old, ...body } = seal; seal.sealSha256 = fz3bPreflightDigest(body); }
    assert.throws(() => fz3bPreflightRecordProjection(f.record, f.fixture));
  }
});

test('maintenance aggregate and raw actual-close evidence are separate exact domains, not an allowed-hash union', async () => {
  const f = await backendPreflightFixture();
  try {
    const facts = assertFz3bMaintenanceLocalCloseProof(f.localCloseProof, f.run);
    assert.equal(facts.historicalPidAttested, false); assert.equal(facts.originalCloseSha256, FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256);
    assert.equal(fz3bDigest(f.localCloseProof), FZ3B_PREFLIGHT_RECOVERY_CASE.maintenanceLocalCloseProofSha256);
    assert.throws(() => assertFz3bMaintenanceLocalCloseProof(f.input.files.actualClose, f.run), /MAINTENANCE_LOCAL_CLOSE_BYTES/);
    const source = structuredClone(f.run);
    source.maintenanceExit!.processState.operations[0].evidenceSha256 = FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256;
    const { sealSha256: _old, ...body } = source.maintenanceExit!; source.maintenanceExit!.sealSha256 = fz3bPreflightDigest(body);
    assert.throws(() => fz3bPreflightSourceProjection(source, f.fixture), /LOCAL_PROCESS_OWNER/);
    assert.throws(() => assertFz3bMaintenanceLocalCloseProof(f.localCloseProof, source), /LOCAL_PROCESS_OWNER/);
    const prepare = f.options.adapter.preparePreflightRefusalRecovery!;
    f.options.adapter.preparePreflightRefusalRecovery = async context => {
      const proof = await prepare(context);
      proof.processState.operations[0].evidenceSha256 = FZ3B_PREFLIGHT_RECOVERY_CASE.maintenanceLocalCloseProofSha256;
      assert.throws(() => assertFz3bPreflightRecoveryProof(context, proof), /LOCAL_PROCESS_OWNER/);
      return proof;
    };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /LOCAL_PROCESS_OWNER/);
    assert.equal(f.calls.includes('finalize'), false);
  } finally { await f.cleanup(); }
});

test('maintenance aggregate exact bytes reject altered owner, original file hashes, extra claims and serialization', () => {
  const f = preflightRecoveryFixture();
  for (const key of ['runId', 'taskId', 'sessionId', 'operationId', 'nonce', 'profileSha256', 'originalEvidenceSha256', 'originalIntentSha256', 'originalCloseSha256', 'historicalPidAttested', 'extra']) {
    const value = JSON.parse(f.localCloseProof.toString()); value[key] = key === 'historicalPidAttested' ? true : 'changed';
    assert.throws(() => assertFz3bMaintenanceLocalCloseProof(Buffer.from(JSON.stringify(value, null, 2)), f.run), /MAINTENANCE_LOCAL_CLOSE_BYTES/);
  }
  assert.throws(() => assertFz3bMaintenanceLocalCloseProof(Buffer.concat([f.localCloseProof, Buffer.from('\n')]), f.run), /MAINTENANCE_LOCAL_CLOSE_BYTES/);
  const foreign = structuredClone(f.run); foreign.taskId = 'foreign';
  assert.throws(() => assertFz3bMaintenanceLocalCloseProof(f.localCloseProof, foreign), /MAINTENANCE_LOCAL_CLOSE_BINDING/);
});

test('real ProductionAdapter legacy local-close producer flows through maintenance HMAC, restart and exact local preflight recovery', async () => {
  const f = await backendPreflightFixture();
  try {
    const root = path.join(f.directory, 'fz3b-worker'), original = f.run.operations[1], directory = path.join(root, original.id);
    await mkdir(directory, { recursive: true });
    for (const [key, name] of [['evidence', 'evidence.json'], ['intent', 'intent.json'], ['transport', 'transport.json'], ['actualClose', 'process-exit.json']] as const) {
      await writeFile(path.join(directory, name), f.input.files[key]);
    }
    await writeFile(path.join(root, 'active.lock'), JSON.stringify({ schemaVersion: 1, operationId: original.id, nonce: original.nonce,
      taskId: f.run.taskId, profileSha256: f.run.profileSha256 }));
    const actual = new ProductionFz3bAdapter({ dataDir: f.directory, resourceRoot: path.resolve('engineering/fz3b/product/resources') });
    let unexpected = 0;
    const trap = async () => { unexpected++; throw new Error('No transport, planning or key action is allowed in this file-only fixture'); };
    Object.assign(actual as any, { now: f.options.now, transport: trap, projectKey: trap, build: trap, inspect: trap, semantic: trap });
    (actual as any).preflightRecovery.now = f.options.now;
    f.options.adapter = actual;
    const before = await f.backend.status(f.run.runId);
    const seal = await f.backend.prepareMaintenanceExit(f.run.runId);
    assert.equal(seal.processState.operations[0].evidenceSha256, FZ3B_PREFLIGHT_RECOVERY_CASE.maintenanceLocalCloseProofSha256);
    const produced = await readFile(path.join(directory, 'local-close-proof.json'));
    assert.equal(fz3bDigest(produced), '6f7ade3ffaeae1bd661ab39c5703e795074556790c5d903b45cf0789f4d61be3');
    assert.deepEqual(produced, f.localCloseProof, 'Actual legacy producer, not the new validator, determines these bytes');
    const authenticated = await f.backend.status(f.run.runId);
    assert.equal(assertFz3bMaintenanceLocalCloseProof(produced, authenticated!).closeConfirmed, true);
    const restarted = new Fz3bBackend(f.options);
    assert.equal((await restarted.recoveryActions(f.run.runId)).reconcilePreflightRefusedInspect, true);
    const recovered = await restarted.reconcilePreflightRefusedInspect(f.run.runId);
    assert.equal(recovered.hardwareBusy, false);
    assert.deepEqual(recovered.operations, before!.operations); assert.deepEqual(recovered.calls, before!.calls);
    assert.equal(recovered.preflightRefusalRecoveries![0].context.sourceRun.maintenanceExit!.processState.operations[0].evidenceSha256,
      FZ3B_PREFLIGHT_RECOVERY_CASE.maintenanceLocalCloseProofSha256);
    assert.equal(recovered.preflightRefusalRecoveries![0].proof!.processState.operations[0].evidenceSha256, FZ3B_PREFLIGHT_RECOVERY_CASE.actualCloseSha256);
    assert.equal(recovered.preflightRefusalRecoveries![0].proof!.classification.remoteQuiescence, 'not-established');
    const nextActual = new ProductionFz3bAdapter({ dataDir: f.directory, resourceRoot: path.resolve('engineering/fz3b/product/resources') });
    Object.assign(nextActual as any, { now: f.options.now, transport: trap, projectKey: trap, build: trap, inspect: trap, semantic: trap });
    (nextActual as any).preflightRecovery.now = f.options.now;
    f.options.adapter = nextActual;
    const freshBackend = new Fz3bBackend(f.options);
    assert.equal((await freshBackend.status(f.run.runId))!.hardwareBusy, false, 'Restart authenticates full worker completion without redoing any action');
    const binding = await freshBackend.readPreflightHostCompletion(f.run.runId);
    assert.equal(binding.originalUnknownPreserved, true); assert.equal(binding.remoteQuiescence, 'not-established');
    assert.equal(binding.checkpointEnvelopeSha256, fz3bDigest(await readFile(path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`))));
    assert.equal(unexpected, 0);
  } finally { await f.cleanup(); }
});

test('actual worker rejects missing, changed or raw-close substituted legacy aggregate without removing the original lease', async () => {
  for (const fault of ['missing', 'changed', 'raw-substitution']) {
    const f = await backendPreflightFixture();
    try {
      const root = path.join(f.directory, 'fz3b-worker'), original = f.run.operations[1], directory = path.join(root, original.id);
      await mkdir(directory, { recursive: true });
      for (const [key, name] of [['evidence', 'evidence.json'], ['intent', 'intent.json'], ['transport', 'transport.json'], ['actualClose', 'process-exit.json']] as const) {
        await writeFile(path.join(directory, name), f.input.files[key]);
      }
      const lease = Buffer.from(JSON.stringify({ schemaVersion: 1, operationId: original.id, nonce: original.nonce, taskId: f.run.taskId, profileSha256: f.run.profileSha256 }));
      await writeFile(path.join(root, 'active.lock'), lease);
      const actual = new ProductionFz3bAdapter({ dataDir: f.directory, resourceRoot: path.resolve('engineering/fz3b/product/resources') });
      let unexpected = 0;
      const trap = async () => { unexpected++; throw new Error('No transport, key or device action in negative file-only fixture'); };
      Object.assign(actual as any, { now: f.options.now, transport: trap, projectKey: trap, build: trap, inspect: trap, semantic: trap });
      (actual as any).preflightRecovery.now = f.options.now; f.options.adapter = actual;
      await f.backend.prepareMaintenanceExit(f.run.runId);
      const file = path.join(directory, 'local-close-proof.json');
      assert.equal(fz3bDigest(await readFile(file)), FZ3B_PREFLIGHT_RECOVERY_CASE.maintenanceLocalCloseProofSha256);
      if (fault === 'missing') await rm(file);
      else await writeFile(file, fault === 'changed' ? Buffer.concat([f.localCloseProof, Buffer.from('\n')]) : f.input.files.actualClose);
      const restarted = new Fz3bBackend(f.options);
      await assert.rejects(restarted.reconcilePreflightRefusedInspect(f.run.runId), /ENOENT|MAINTENANCE_LOCAL_CLOSE_BYTES/);
      assert.deepEqual(await readFile(path.join(root, 'active.lock')), lease);
      const held = (await restarted.status(f.run.runId))!;
      assert.equal(held.hardwareBusy, true); assert.equal(held.operations[1].status, 'unknown'); assert.equal(held.operations[1].remoteQuiescent, false);
      assert.equal(held.preflightRefusalRecoveries?.[0].finalization, undefined);
      assert.equal(unexpected, 0);
    } finally { await f.cleanup(); }
  }
});

test('private results or receipts cannot hide a semantic/grant authority or modified successful build', () => {
  for (const field of ['semantic-result', 'semantic-receipt', 'receipt-hash', 'step']) {
    const f = preflightRecoveryFixture();
    if (field === 'semantic-result') (f.record.results as any).fz3b_semantic = {};
    else if (field === 'semantic-receipt') (f.record.receipts as any).foreign = {};
    else if (field === 'receipt-hash') Object.values(f.record.receipts)[0].evidenceSha256 = '0'.repeat(64);
    else f.record.step = 2;
    assert.throws(() => fz3bPreflightRecordProjection(f.record, f.fixture));
  }
});

test('exact local recovery preserves unknown bytes, uses one native and no planning/remote action, restores only authenticated completion', async () => {
  const f = await backendPreflightFixture();
  try {
    const original = await f.backend.status(f.run.runId), recordFile = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`);
    let saves = 0; const save = f.internal.save.bind(f.backend);
    f.internal.save = async record => { saves++; await save(record); };
    const ack = f.options.adapter.acknowledgePreflightRefusalRecovery!;
    f.options.adapter.acknowledgePreflightRefusalRecovery = async (...args) => {
      const bytes = await readFile(recordFile), payload = JSON.parse(bytes.toString()).payload;
      assert.equal(payload.preflightRefusalRecoveries[0].status, 'released');
      assert.equal(payload.preflightRefusalRecoveries[0].ack, undefined);
      assert.equal(fz3bPreflightDigest(payload), args[3].checkpointSha256);
      const atAck = saves, result = await ack(...args);
      assert.equal(saves, atAck); return result;
    };
    const result = await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    assert.equal(result.hardwareBusy, false); assert.equal(result.status, 'needs_attention'); assert.equal(result.active, false);
    assert.deepEqual(result.operations, original!.operations); assert.deepEqual(result.calls, original!.calls);
    assert.equal(result.operations[1].status, 'unknown'); assert.equal(result.operations[1].remoteQuiescent, false);
    assert.equal(result.preflightRefusalRecoveries![0].proof!.classification.releaseAuthority, 'none');
    assert.ok(result.preflightRefusalRecoveries![0].closure);
    assert.ok(fz3bReleasedPreflightRefusalRecovery(result, result.operations[1], f.fixture));
    assert.equal(f.calls.filter(value => value === 'native').length, 1);
    assert.deepEqual(f.calls.filter(value => ['prepare', 'finalize', 'ack', 'certify'].includes(value)), ['prepare', 'finalize', 'ack', 'certify']);
    assert.equal(saves, 3, 'preparing, prepared, last release checkpoint; no required save follows worker closure');
    const after = await readFile(recordFile);
    await f.backend.stop(f.run.runId);
    assert.deepEqual(await readFile(recordFile), after, 'Stop cannot invalidate immutable checkpoint after main save failure');
    const resumed = new Fz3bBackend(f.options), count = f.calls.length;
    assert.equal((await resumed.status(f.run.runId))!.hardwareBusy, false);
    assert.equal((await resumed.quiescence(f.run.runId)).quiescent, true);
    assert.deepEqual(f.calls.slice(count), ['read-completion']);
    const beforeFinish = f.calls.length;
    const finished = await resumed.reconcilePreflightRefusedInspect(f.run.runId);
    assert.equal(finished.hardwareBusy, false, 'Read-only follow-up view must be computed after reconciling finally settles');
    assert.equal(f.calls.slice(beforeFinish).some(value => ['native', 'prepare', 'finalize', 'ack', 'certify'].includes(value)), false);
    assert.deepEqual(await readFile(recordFile), after, 'explicit same-proof main follow-up is read-only');
    await assert.rejects(resumed.prepareMaintenanceExit(f.run.runId), /immutable/);
    assert.equal(fz3bDigest(after).length, 64);
  } finally { await f.cleanup(); }
});

test('source case allowlist and original HMAC evidence prevent a future matching error string from entering native', async () => {
  const f = await backendPreflightFixture();
  try {
    const record = f.internal.records.get(f.run.runId); record.operations[1].evidenceSha256 = '0'.repeat(64);
    await f.internal.save(record);
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /EXACT_CASE/);
    assert.equal(f.calls.includes('native'), false); assert.equal(f.calls.includes('prepare'), false);
  } finally { await f.cleanup(); }
});

test('tampering isolated ledger without its real HMAC is rejected on restart', async () => {
  const f = await backendPreflightFixture();
  try {
    const file = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`), envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.payload.operations[1].status = 'failed'; await writeFile(file, JSON.stringify(envelope));
    await assert.rejects(new Fz3bBackend(f.options).list(), /integrity/);
  } finally { await f.cleanup(); }
});

for (const action of ['refused', 'expired', 'clock-backward', 'owner']) test(`${action} native recovery never finalizes lease`, async () => {
  const f = await backendPreflightFixture();
  try {
    if (action === 'refused') f.options.requestPreflightRefusalRecovery = async () => false;
    else if (action === 'expired') f.options.requestPreflightRefusalRecovery = async () => { f.advance(300000); return true; };
    else if (action === 'clock-backward') f.options.requestPreflightRefusalRecovery = async () => { f.advance(-1); return true; };
    else f.options.requestPreflightRefusalRecovery = async () => { f.options.assertRecoveryOwner = () => { throw new Error('foreign owner'); }; return true; };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId));
    assert.equal(f.calls.includes('prepare'), false); assert.equal(f.state.lease, true);
    assert.equal((await f.backend.status(f.run.runId))!.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('backend checks original bounded bytes independently rather than trusting adapter classifier hashes', async () => {
  const f = await backendPreflightFixture();
  try {
    const read = f.options.adapter.readPreflightRefusalRecoveryInput!;
    f.options.adapter.readPreflightRefusalRecoveryInput = async (...args) => {
      const data = await read(...args); return { resources: data.resources, files: { ...data.files, actualClose: Buffer.from('{}') } };
    };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /SEALED_FILE/);
    assert.equal(f.calls.includes('finalize'), false); assert.equal(f.state.barrier, true); assert.equal(f.state.lease, true);
  } finally { await f.cleanup(); }
});

test('classification literal/extra authority tampering is rejected even when its self hash is recomputed', async () => {
  const f = await backendPreflightFixture();
  try {
    const prepare = f.options.adapter.preparePreflightRefusalRecovery!;
    f.options.adapter.preparePreflightRefusalRecovery = async context => {
      const proof = await prepare(context); const value = structuredClone(proof);
      (value.classification as any).remoteQuiescence = 'established';
      const { proofSha256: _old, ...body } = value.classification; value.classification.proofSha256 = fz3bPreflightDigest(body);
      assert.throws(() => assertFz3bPreflightRecoveryProof(context, value), /PROOF_BINDING/);
      return value;
    };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /classification differs/);
    assert.equal(f.state.lease, true);
  } finally { await f.cleanup(); }
});

test('prepared signed-save failure never calls exact lease finalization', async () => {
  const f = await backendPreflightFixture();
  try {
    const save = f.internal.save.bind(f.backend);
    f.internal.save = async record => { if ((record as any).preflightRefusalRecoveries?.[0]?.status === 'prepared') throw new Error('injected prepared save failure'); await save(record); };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /prepared save/);
    assert.equal(f.calls.includes('finalize'), false); assert.equal(f.state.lease, true); assert.equal(f.state.barrier, true);
  } finally { await f.cleanup(); }
});

test('visible released checkpoint followed by save error never mints ACK or clears a new instance', async () => {
  const f = await backendPreflightFixture();
  try {
    const save = f.internal.save.bind(f.backend);
    f.internal.save = async record => { await save(record); if ((record as any).preflightRefusalRecoveries?.[0]?.status === 'released') throw new Error('injected visible checkpoint save error'); };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /visible checkpoint/);
    assert.equal(f.calls.includes('ack'), false); assert.equal(f.calls.includes('certify'), false);
    assert.equal(f.state.lease, false); assert.equal(f.state.barrier, true);
    const restarted = new Fz3bBackend(f.options);
    assert.equal((await restarted.status(f.run.runId))!.hardwareBusy, true);
    await assert.rejects(restarted.reconcilePreflightRefusedInspect(f.run.runId), /absent|incomplete/);
    assert.equal(f.calls.includes('ack'), false);
  } finally { await f.cleanup(); }
});

test('worker unlink becomes visible then throws: absent barrier plus valid ACK cannot produce closure certificate', async () => {
  const f = await backendPreflightFixture();
  try {
    const ack = f.options.adapter.acknowledgePreflightRefusalRecovery!;
    f.options.adapter.acknowledgePreflightRefusalRecovery = async (...args) => { await ack(...args); throw new Error('unlink visible, sync failed, restore failed'); };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /sync failed/);
    assert.equal(f.state.barrier, false); assert.ok(f.state.ack); assert.equal(f.state.closure, undefined);
    assert.equal(f.calls.includes('certify'), false);
    assert.equal((await new Fz3bBackend(f.options).status(f.run.runId))!.hardwareBusy, true);
  } finally { await f.cleanup(); }
});

test('closure publication visible then error keeps current main held; explicit read-only follow-up verifies prior actual closure', async () => {
  const f = await backendPreflightFixture();
  try {
    const certify = f.options.adapter.certifyPreflightRefusalRecovery!;
    f.options.adapter.certifyPreflightRefusalRecovery = async (...args) => { await certify(...args); throw new Error('closure file visible but publish failed'); };
    await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /publish failed/);
    assert.equal((await f.backend.status(f.run.runId))!.hardwareBusy, true);
    assert.ok(f.state.closure);
    const count = f.calls.length, restarted = new Fz3bBackend(f.options);
    assert.equal((await restarted.status(f.run.runId))!.hardwareBusy, false);
    assert.deepEqual(f.calls.slice(count), ['read-completion']);
    const before = f.calls.length; await restarted.reconcilePreflightRefusedInspect(f.run.runId);
    assert.equal(f.calls.slice(before).some(value => ['native', 'prepare', 'finalize', 'ack', 'certify'].includes(value)), false);
  } finally { await f.cleanup(); }
});

test('missing or forged post-success certificate never clears signed released checkpoint', async () => {
  const f = await backendPreflightFixture();
  try {
    await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
    const valid = structuredClone(f.state.closure!);
    f.state.closure = undefined;
    assert.equal((await new Fz3bBackend(f.options).status(f.run.runId))!.hardwareBusy, true);
    f.state.closure = { ...valid, mac: '0'.repeat(64) };
    assert.equal((await new Fz3bBackend(f.options).status(f.run.runId))!.hardwareBusy, true);
    f.state.closure = valid; f.state.barrier = true;
    assert.equal((await new Fz3bBackend(f.options).status(f.run.runId))!.hardwareBusy, true);
    assert.equal(fz3bCanonicalJson(f.run.operations).includes('unknown'), true);
  } finally { await f.cleanup(); }
});

test('read-only finish owner, runtime or read error cannot rewrite released checkpoint; same certificate remains usable', async () => {
  for (const fault of ['owner', 'runtime', 'read']) {
    const f = await backendPreflightFixture();
    try {
      await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
      const file = path.join(f.directory, 'fz3b-agent', `${f.run.runId}.json`), before = await readFile(file), count = f.calls.length;
      const owner = f.options.assertRecoveryOwner, runtime = f.options.checkRuntime, read = f.options.adapter.readPreflightRefusalRecoveryCompletion;
      if (fault === 'owner') f.options.assertRecoveryOwner = () => { throw new Error('temporary foreign owner'); };
      else if (fault === 'runtime') f.options.checkRuntime = async () => { throw new Error('temporary runtime mismatch'); };
      else f.options.adapter.readPreflightRefusalRecoveryCompletion = async () => { throw new Error('temporary local read failure'); };
      await assert.rejects(f.backend.reconcilePreflightRefusedInspect(f.run.runId), /temporary/);
      assert.deepEqual(await readFile(file), before, `${fault} must not append error or resign checkpoint`);
      assert.equal((await f.backend.status(f.run.runId))!.hardwareBusy, true);
      f.options.assertRecoveryOwner = owner; f.options.checkRuntime = runtime; f.options.adapter.readPreflightRefusalRecoveryCompletion = read;
      const result = await f.backend.reconcilePreflightRefusedInspect(f.run.runId);
      assert.equal(result.hardwareBusy, false);
      assert.deepEqual(await readFile(file), before);
      assert.equal(f.calls.slice(count).some(value => ['native', 'prepare', 'finalize', 'ack', 'certify'].includes(value)), false);
    } finally { await f.cleanup(); }
  }
});
