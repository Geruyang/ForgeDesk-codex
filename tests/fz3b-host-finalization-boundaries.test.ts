import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test, { after, before, mock } from 'node:test';
import { DesktopStore } from '../apps/desktop/main/store';
import { Fz3bAgentMain, type Fz3bAgentMainOptions } from '../apps/desktop/main/fz3b-agent';
import { Fz3bHostFinalizationStore, type HostFinalizationStage } from '../apps/desktop/main/host-finalization-store';
import { Fz3bBackend } from '../packages/engineering-runner/fz3b/backend';
import type { Fz3bBinding } from '../packages/engineering-runner/fz3b/types';
import { fz3bHostProductionFixture } from './helpers/fz3b-host-production-fixture';
import { FZ3B_PREFLIGHT_RECOVERY_CASE } from '../packages/engineering-runner/fz3b/preflight-recovery';
import { FZ3B_PREFLIGHT_REFUSAL_PINS } from '../packages/engineering-runner/fz3b/preflight-refusal-proof';
import { assertFz3bPreflightHostCompletionBinding, fz3bHostFinalizationDigest,
  type Fz3bPreflightHostCompletionBinding } from '../packages/engineering-runner/fz3b/host-finalization';

// Keep a newly added native default from escaping a synthetic IO fixture.
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
before(() => {
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    mock.method(childProcess, method, () => { throw new Error('INDEPENDENT_CONSUMER_FORBIDS_SUBPROCESS'); });
  }
  syncBuiltinESMExports();
});
after(() => { mock.restoreAll(); syncBuiltinESMExports(); });

// Deliberately untrusted format-valid JSON, not a backend-authenticated receipt.
function selfReportedBinding(owner?: Fz3bBinding): Fz3bPreflightHostCompletionBinding {
  const h = 'a'.repeat(64), approved = FZ3B_PREFLIGHT_RECOVERY_CASE;
  const body: Omit<Fz3bPreflightHostCompletionBinding, 'completeChainSha256'> = {
    schemaVersion: 1, method: 'fz3b-preflight-host-completion-binding-v1', purpose: 'exact-local-preflight-host-finish-only',
    owner: { runId: approved.runId, taskId: owner?.taskId ?? 'offline-task', sessionId: owner?.sessionId ?? 'offline-session',
      threadId: owner?.threadId ?? 'offline-thread', turnId: owner?.turnId ?? 'offline-turn', model: 'gpt-6.1-sol', generation: owner?.generation ?? 1 },
    recoveryId: '11111111-1111-4111-8111-111111111111', operationId: approved.operationId, nonce: approved.nonce,
    profileSha256: FZ3B_PREFLIGHT_REFUSAL_PINS.profile, resourceManifestSha256: FZ3B_PREFLIGHT_REFUSAL_PINS.manifest,
    checkpointSha256: h, checkpointEnvelopeSha256: h, sourceRecordSha256: h, sourceProjectionSha256: h,
    maintenanceExitSha256: null, originalHistorySha256: h, contextSha256: h, proofSha256: h, finalizationSha256: h,
    ackSha256: h, acknowledgmentSha256: h, closureSha256: h, closureIssuedAt: '2026-10-17T00:00:00.000Z',
    originalUnknownPreserved: true, remoteQuiescence: 'not-established', newBootIdentity: 'not-observed-or-adopted',
    localProcessesClosed: true, leaseAndBarrierAbsent: true,
  };
  return { ...body, completeChainSha256: fz3bHostFinalizationDigest(body) };
}

function certificateNames(home: string): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(directory, entry.name));
      else if (entry.name.endsWith('.certificate.json')) found.push(path.join(directory, entry.name));
    }
  };
  visit(home); return found;
}

type Fixture = Awaited<ReturnType<typeof fz3bHostProductionFixture>>;
const sid = 'S-1-5-21-1-2-3-1001';
function hostStore(f: Fixture, onStage?: (stage: HostFinalizationStage) => void, store = f.store, backend = f.backend, nativeSid = sid) {
  return new Fz3bHostFinalizationStore(store, backend, binding => f.assertOwner(binding.owner), nativeSid,
    { now: () => f.state.now, onStage, privateAcl: () => {}, privateAclBatch: () => {}, dependencyAcl: () => {} });
}
async function freshHost(f: Fixture) {
  const backend = new Fz3bBackend(f.options); await backend.list();
  return hostStore(f, undefined, new DesktopStore(f.home), backend);
}
async function held(host: Fz3bHostFinalizationStore, runId: string) {
  let accepted: boolean | undefined;
  try { accepted = await host.has(runId); } catch { /* An integrity error also leaves the owner held. */ }
  assert.notEqual(accepted, true);
}

test('host store refuses fake structural and prototype DesktopStore instances', async () => {
  const f = await fz3bHostProductionFixture();
  assert.throws(() => hostStore(f, undefined, { root: f.home, projects: f.store.projects, sessions: f.store.sessions } as DesktopStore));
  const prototypeOnly = Object.create(DesktopStore.prototype) as DesktopStore;
  Object.assign(prototypeOnly, { root: f.home, projects: f.store.projects, sessions: f.store.sessions });
  assert.throws(() => hostStore(f, undefined, prototypeOnly));
});

test('readonly absence assessment does not bootstrap a signer or certificate', async () => {
  const f = await fz3bHostProductionFixture(), before = readdirSync(f.home).sort();
  const host = hostStore(f);
  assert.equal(await host.has(f.owner.runId), false);
  assert.deepEqual(readdirSync(f.home).sort(), before);
  assert.deepEqual(certificateNames(f.home), []);
});

test('format-valid caller JSON cannot substitute for an authenticated backend completion capability', async () => {
  const f = await fz3bHostProductionFixture(), binding = selfReportedBinding(f.owner);
  assertFz3bPreflightHostCompletionBinding(binding);
  let signingStages = 0;
  const observe = (stage: HostFinalizationStage) => { if (stage === 'signing') signingStages++; };
  const host = hostStore(f, observe);
  assert.equal((host as unknown as { commit?: unknown }).commit, undefined, 'The raw-binding signer API must not exist');
  await assert.rejects(host.finish(binding as unknown as string));
  const forgedBackend = { readPreflightHostCompletion: async () => binding } as unknown as Fz3bBackend;
  await assert.rejects(async () => { await hostStore(f, observe, f.store, forgedBackend).finish(f.owner.runId); });
  const authentic = await f.backend.readPreflightHostCompletion(f.owner.runId), originalRead = f.backend.readPreflightHostCompletion;
  f.backend.readPreflightHostCompletion = async () => structuredClone(authentic);
  try { await assert.rejects(hostStore(f, observe).finish(f.owner.runId)); }
  finally { f.backend.readPreflightHostCompletion = originalRead; }
  assert.equal(signingStages, 0); assert.deepEqual(certificateNames(f.home), []);
});

test('actual local production chain mints once and a new instance verifies without replay or ledger writes', async () => {
  const f = await fz3bHostProductionFixture(), ledger = readFileSync(f.ledgerPath);
  let signing = 0;
  const host = hostStore(f, stage => { if (stage === 'signing') signing++; });
  await host.finish(f.owner.runId);
  const files = certificateNames(f.home); assert.equal(files.length, 1); const original = readFileSync(files[0]);
  assert.equal(await host.has(f.owner.runId), true);
  await host.finish(f.owner.runId);
  assert.equal(signing, 1); assert.deepEqual(certificateNames(f.home), files); assert.deepEqual(readFileSync(files[0]), original);
  assert.equal(await (await freshHost(f)).has(f.owner.runId), true);
  assert.deepEqual(readFileSync(f.ledgerPath), ledger);
  const current = (await f.backend.status(f.owner.runId))!;
  assert.deepEqual(current.calls, f.completed.calls); assert.deepEqual(current.operations, f.completed.operations);
  assert.equal(current.operations[1].status, 'unknown'); assert.equal(current.operations[1].remoteQuiescent, false);
  assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
});

for (const failure of ['desktop-written', 'desktop-renamed', 'desktop-readback', 'checkpoint-written', 'checkpoint-readback', 'before-signing'] as const) {
  test(`a real ${failure} failure never signs and a new reader remains held`, async () => {
    const f = await fz3bHostProductionFixture(); let signing = 0, reached = false;
    const host = hostStore(f, stage => {
      if (stage === 'signing') signing++;
      if (stage === failure) { reached = true; throw new Error(`INDEPENDENT_IO_FAILURE_${failure}`); }
    });
    await assert.rejects(host.finish(f.owner.runId), new RegExp(`INDEPENDENT_IO_FAILURE_${failure}`));
    assert.equal(reached, true); assert.equal(signing, 0); assert.deepEqual(certificateNames(f.home), []);
    await held(await freshHost(f), f.owner.runId); assert.equal(f.state.forbidden, 0);
  });
}

test('visible certificate publication failure is not action success but can be authenticated on a new readonly instance', async () => {
  const f = await fz3bHostProductionFixture(); let signing = 0;
  const host = hostStore(f, stage => {
    if (stage === 'signing') signing++;
    if (stage === 'certificate-written') throw new Error('INDEPENDENT_PUBLICATION_VISIBLE_THROW');
  });
  await assert.rejects(host.finish(f.owner.runId), /INDEPENDENT_PUBLICATION_VISIBLE_THROW/);
  assert.equal(signing, 1); assert.equal(certificateNames(f.home).length, 1);
  assert.equal(await (await freshHost(f)).has(f.owner.runId), true);
  assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
});

const authorityMutations: ReadonlyArray<readonly [string, (f: Fixture) => void]> = [
  ['target messages', f => { f.store.sessions[0].messages.push({ id: 'extra', role: 'user', text: 'changed', timestamp: '2026-10-17T12:00:00.000Z' }); }],
  ['extra target authority', f => { Object.assign(f.store.sessions[0], { saved: true }); }],
  ['HMAC envelope bytes', f => { writeFileSync(f.ledgerPath, Buffer.concat([readFileSync(f.ledgerPath), Buffer.from(' ')])); }],
  ['worker closure bytes', f => {
    const recovery = f.completed.preflightRefusalRecoveries![0];
    const file = path.join(f.workerRoot, 'preflight-refusal-recoveries', recovery.context.id, 'closure.json');
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from(' ')]));
  }],
  ['foreign worker lease', f => { writeFileSync(path.join(f.workerRoot, 'active.lock'), '{}', { flag: 'wx' }); }],
  ['tracked child', f => { (f.adapter as unknown as { children: Set<unknown> }).children.add({ synthetic: true }); }],
  ['same-owner assertion', f => { f.state.ownerValid = false; }],
  ['clock rollback', f => { f.state.now--; }],
];
for (const [name, mutate] of authorityMutations) {
  test(`fresh ${name} change before mint cannot reuse an earlier authenticated read`, async () => {
    const f = await fz3bHostProductionFixture(); let signing = 0, mutated = false;
    const host = hostStore(f, stage => {
      if (stage === 'before-signing') { mutate(f); mutated = true; }
      if (stage === 'signing') signing++;
    });
    await assert.rejects(host.finish(f.owner.runId)); assert.equal(mutated, true);
    assert.equal(signing, 0); assert.deepEqual(certificateNames(f.home), []); assert.equal(f.state.forbidden, 0);
  });
}

test('title and unrelated inactive session edits do not migrate or resign the immutable target certificate', async () => {
  const f = await fz3bHostProductionFixture(); let signing = 0;
  const host = hostStore(f, stage => { if (stage === 'signing') signing++; }); await host.finish(f.owner.runId);
  const [file] = certificateNames(f.home), original = readFileSync(file);
  f.store.sessions[0].title = 'Display title only';
  f.store.sessions.push({ id: 'unrelated', taskId: 'unrelated-task', projectId: 'offline-project', title: 'Other inactive task', status: 'idle', messages: [] });
  f.store.save();
  assert.equal(await host.has(f.owner.runId), true); assert.equal(await (await freshHost(f)).has(f.owner.runId), true);
  await host.finish(f.owner.runId); assert.equal(signing, 1); assert.deepEqual(readFileSync(file), original);
});

for (const [name, mutate] of authorityMutations.filter(([name]) => ['target messages', 'extra target authority'].includes(name))) {
  test(`a certified ${name} change stays held and explicit finish cannot overwrite or re-sign`, async () => {
    const f = await fz3bHostProductionFixture(); let signing = 0;
    const host = hostStore(f, stage => { if (stage === 'signing') signing++; }); await host.finish(f.owner.runId);
    const [file] = certificateNames(f.home), original = readFileSync(file);
    mutate(f); f.store.save(); await held(host, f.owner.runId); await held(await freshHost(f), f.owner.runId);
    await assert.rejects(host.finish(f.owner.runId)); assert.equal(signing, 1);
    assert.deepEqual(certificateNames(f.home), [file]); assert.deepEqual(readFileSync(file), original);
  });
}

test('SID mismatch and missing private key refuse readonly acceptance without rotation or repair', async () => {
  const f = await fz3bHostProductionFixture(); await hostStore(f).finish(f.owner.runId);
  const [file] = certificateNames(f.home), original = readFileSync(file);
  await held(hostStore(f, undefined, f.store, f.backend, 'S-1-5-21-1-2-3-1002'), f.owner.runId);
  const key = path.join(f.home, 'fz3b-host-finalization-v1', 'key.bin'); unlinkSync(key);
  const names = readdirSync(path.dirname(key)).sort();
  await held(await freshHost(f), f.owner.runId); await assert.rejects(hostStore(f).finish(f.owner.runId));
  assert.deepEqual(readdirSync(path.dirname(key)).sort(), names); assert.deepEqual(readFileSync(file), original);
});

test('an immutable certificate binds all target authority fields, not only message count', async () => {
  const f = await fz3bHostProductionFixture(); let signing = 0;
  const host = hostStore(f, stage => { if (stage === 'signing') signing++; }); await host.finish(f.owner.runId);
  const [file] = certificateNames(f.home), original = readFileSync(file);
  const baseline = structuredClone({ projects: f.store.projects, sessions: f.store.sessions });
  const mutations: Array<() => void> = [
    () => { f.store.projects[0].name += ' changed'; },
    () => { f.store.projects[0].root = path.join(f.home, 'another-project'); },
    () => { f.store.sessions[0].threadId = 'foreign-thread'; },
    () => { f.store.sessions[0].model = 'foreign-model'; },
    () => { f.store.sessions[0].status = 'completed'; },
    () => { f.store.sessions[0].engineUncertain = true; },
    () => { f.store.sessions[0].turnId = 'foreign-turn'; },
    () => { f.store.sessions[0].historyIncomplete = false; },
  ];
  for (const mutate of mutations) {
    f.store.projects = structuredClone(baseline.projects); f.store.sessions = structuredClone(baseline.sessions);
    mutate(); f.store.save(); await held(host, f.owner.runId);
    await assert.rejects(host.finish(f.owner.runId)); assert.equal(signing, 1); assert.deepEqual(readFileSync(file), original);
  }
});

test('modified certificate or immutable checkpoint is never repaired by readonly assessment', async () => {
  const f = await fz3bHostProductionFixture(); await hostStore(f).finish(f.owner.runId);
  const [file] = certificateNames(f.home), original = readFileSync(file), cert = JSON.parse(original.toString('utf8'));
  cert.saved = true; writeFileSync(file, JSON.stringify(cert)); const invalid = readFileSync(file);
  await held(await freshHost(f), f.owner.runId); assert.deepEqual(readFileSync(file), invalid);
  const forged = JSON.parse(original.toString('utf8')); forged.mac = '0'.repeat(64);
  writeFileSync(file, JSON.stringify(forged)); const badMac = readFileSync(file);
  await held(await freshHost(f), f.owner.runId); assert.deepEqual(readFileSync(file), badMac);
  writeFileSync(file, original);
  const checkpoint = path.join(f.home, 'fz3b-host-finalization-v1', cert.snapshot.checkpointFile);
  writeFileSync(checkpoint, Buffer.concat([readFileSync(checkpoint), Buffer.from(' ')])); const changed = readFileSync(checkpoint);
  await held(await freshHost(f), f.owner.runId); await assert.rejects(hostStore(f).finish(f.owner.runId));
  assert.deepEqual(readFileSync(checkpoint), changed); assert.deepEqual(readFileSync(file), original);
});

function mainFixture(f: Fixture, backend: Fz3bBackend, store: DesktopStore) {
  const state = { holds: new Set<string>(), released: [] as string[], saves: 0, logs: [] as string[] };
  const forbidden = async (): Promise<never> => { throw new Error('Independent startup consumer forbids model/engine/native activity'); };
  const options: Fz3bAgentMainOptions = {
    backend, createEngine: () => { throw new Error('Startup assessment must not create or start a model engine'); },
    getSession: taskId => { const value = store.sessions.find(session => session.taskId === taskId); assert.ok(value); return value; },
    assertCanStart: () => {}, assertBeforeClaim: () => {}, enterControlledMode: forbidden,
    assertGlobalOwner: forbidden, assertGlobalRecoveryOwner: binding => f.assertOwner(binding), assertHostCommitOwner: binding => f.assertOwner(binding),
    checkRuntime: async () => {}, readAccount: forbidden, setAccount: () => {},
    hold: taskId => { state.holds.add(taskId); }, release: taskId => { state.holds.delete(taskId); state.released.push(taskId); },
    save: () => { state.saves++; throw new Error('Readonly startup must not save'); },
    publish: () => {}, log: message => { state.logs.push(message); }, onEvent: () => {}, redact: value => value,
  };
  const main = new Fz3bAgentMain(options);
  options.hostFinalization = new Fz3bHostFinalizationStore(store, backend, binding => main.assertSynchronousHostCommitOwner(binding.owner), sid,
    { now: () => f.state.now, privateAcl: () => {}, privateAclBatch: () => {}, dependencyAcl: () => {} });
  return { main, state };
}

test('certified startup releases only the exact local host hold and performs no save or replay', async () => {
  const f = await fz3bHostProductionFixture(); await hostStore(f).finish(f.owner.runId);
  const ledger = readFileSync(f.ledgerPath), [file] = certificateNames(f.home), certificate = readFileSync(file);
  const backend = new Fz3bBackend(f.options), store = new DesktopStore(f.home), { main, state } = mainFixture(f, backend, store);
  await main.recoverStartup(); assert.equal(main.held, true); assert.equal(state.holds.has(f.owner.taskId), true);
  await main.restoreCertifiedHostCompletion(); assert.equal(main.held, false); assert.deepEqual(state.released, [f.owner.taskId]);
  assert.equal(state.saves, 0); assert.deepEqual(readFileSync(f.ledgerPath), ledger); assert.deepEqual(readFileSync(file), certificate);
  assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
});

for (const mode of ['active', 'inspect-unknown', 'semantic-unknown'] as const) {
  test(`a valid old host certificate cannot release a different ${mode} owner`, async () => {
    const f = await fz3bHostProductionFixture(); await hostStore(f).finish(f.owner.runId);
    const internal = f.backend as unknown as { records: Map<string, any>; save(record: unknown): Promise<void> };
    const foreign = structuredClone(internal.records.get(f.owner.runId));
    foreign.runId = 'zz-offline-foreign-run'; foreign.taskId = 'foreign-task'; foreign.sessionId = 'foreign-session';
    foreign.active = mode === 'active'; foreign.hardwareBusy = true; delete foreign.preflightRefusalRecoveries;
    foreign.operations[1].id = 'foreign-operation'; foreign.operations[1].kind = mode === 'semantic-unknown' ? 'semantic' : 'inspect';
    foreign.calls[2].tool = mode === 'semantic-unknown' ? 'fz3b_semantic' : 'fz3b_inspect';
    foreign.calls[2].result.operation = structuredClone(foreign.operations[1]);
    internal.records.set(foreign.runId, foreign); await internal.save(foreign);
    const backend = new Fz3bBackend(f.options), { main, state } = mainFixture(f, backend, new DesktopStore(f.home));
    await main.recoverStartup(); await main.restoreCertifiedHostCompletion(); await assert.rejects(main.assertIdle());
    assert.equal(main.held, true); assert.equal(state.holds.has(f.owner.taskId), true); assert.equal(state.holds.has(foreign.taskId), true);
    assert.deepEqual(state.released, []); assert.equal(state.saves, 0);
    const after = (await backend.status(foreign.runId))!;
    assert.equal(after.hardwareBusy, true); assert.equal(after.operations[1].status, 'unknown'); assert.equal(after.operations[1].remoteQuiescent, false);
    assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
  });
}

test('a rejected private-directory ACL prevents key bytes and certificate minting', async () => {
  const f = await fz3bHostProductionFixture(), home = path.join(f.home, 'fz3b-host-finalization-v1'); let signing = 0;
  const calls: Array<{ file: string; update: boolean }> = [];
  const host = new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid, {
    now: () => f.state.now, onStage: stage => { if (stage === 'signing') signing++; }, privateAclBatch: () => {}, dependencyAcl: () => {},
    privateAcl: (file, actualSid, update) => {
      assert.equal(actualSid, sid); calls.push({ file, update });
      if (file === home && update) throw new Error('INDEPENDENT_ACL_REJECTED');
    },
  });
  await assert.rejects(host.finish(f.owner.runId), { message: 'FZ3B_HOST_FINALIZATION_ACL_HOME_PROTECT_FAILED' });
  assert.deepEqual(calls, [{ file: home, update: true }]); assert.deepEqual(readdirSync(home), []);
  assert.equal(signing, 0); assert.deepEqual(certificateNames(f.home), []);
});

test('key ACL is established while empty and readonly validation never requests ACL repair', async () => {
  const f = await fz3bHostProductionFixture(); let creating = true, emptyKeyObserved = false;
  const updates: string[] = [];
  const host = new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid, {
    now: () => f.state.now, privateAclBatch: () => {}, dependencyAcl: () => {},
    privateAcl: (file, actualSid, update) => {
      assert.equal(actualSid, sid);
      if (update) { assert.equal(creating, true); updates.push(file); }
      if (update && path.basename(file) === 'key.bin') { assert.equal(statSync(file).size, 0); emptyKeyObserved = true; }
    },
  });
  await host.finish(f.owner.runId); assert.equal(emptyKeyObserved, true); assert.ok(updates.length > 0);
  creating = false; assert.equal(await host.has(f.owner.runId), true);
});

test('a broad dependency ACL rejects before backend read or any host store bootstrap', async () => {
  const f = await fz3bHostProductionFixture(), before = readdirSync(f.home).sort(); let reads = 0, signing = 0;
  const originalRead = f.backend.readPreflightHostCompletion.bind(f.backend);
  f.backend.readPreflightHostCompletion = async runId => { reads++; return originalRead(runId); };
  const host = new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid, {
    now: () => f.state.now, privateAcl: () => {}, privateAclBatch: () => {}, onStage: stage => { if (stage === 'signing') signing++; },
    dependencyAcl: (root, actualSid) => {
      assert.equal(root, f.home); assert.equal(actualSid, sid); throw new Error('INDEPENDENT_DEPENDENCY_ACL_BROAD');
    },
  });
  await assert.rejects(host.has(f.owner.runId), { message: 'FZ3B_HOST_FINALIZATION_ACL_DEPENDENCY_READ_FAILED' });
  await assert.rejects(host.finish(f.owner.runId), { message: 'FZ3B_HOST_FINALIZATION_ACL_DEPENDENCY_READ_FAILED' });
  assert.equal(reads, 0); assert.equal(signing, 0); assert.deepEqual(readdirSync(f.home).sort(), before);
});

test('readonly batching fits unchanged logical deadlines with one second per native process', async () => {
  const f = await fz3bHostProductionFixture(), started = f.state.now;
  const calls = { updates: 0, batches: 0, dependency: 0, signing: 0 };
  const observation = {
    now: () => f.state.now,
    onStage: (stage: HostFinalizationStage) => { if (stage === 'signing') calls.signing++; },
    privateAcl: (_file: string, actualSid: string, update: boolean) => {
      assert.equal(actualSid, sid); assert.equal(update, true); calls.updates++; f.state.now += 1000;
    },
    privateAclBatch: (files: readonly string[], actualSid: string) => {
      assert.equal(actualSid, sid); assert.ok(files.length > 0 && files.length <= 51);
      assert.equal(new Set(files).size, files.length);
      for (const file of files) {
        const relative = path.relative(path.join(f.home, 'fz3b-host-finalization-v1'), file);
        assert.ok(!path.isAbsolute(relative) && !relative.startsWith('..'));
      }
      calls.batches++; f.state.now += 1000;
    },
    dependencyAcl: () => { calls.dependency++; f.state.now += 1000; },
  };
  const host = new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid, observation);
  await host.finish(f.owner.runId);
  assert.deepEqual(calls, { updates: 7, batches: 2, dependency: 1, signing: 1 });
  assert.equal(f.state.now - started, 10000);
  const backend = new Fz3bBackend(f.options); await backend.list();
  const fresh = new Fz3bHostFinalizationStore(new DesktopStore(f.home), backend, binding => f.assertOwner(binding.owner), sid, observation);
  assert.equal(await fresh.has(f.owner.runId), true);
  assert.deepEqual(calls, { updates: 7, batches: 3, dependency: 2, signing: 1 });
  assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
});

test('an incomplete pure ACL seam pair is refused at construction before any native fallback', async () => {
  const f = await fz3bHostProductionFixture();
  assert.throws(() => new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid,
    { now: () => f.state.now, privateAcl: () => {}, dependencyAcl: () => {} }));
  assert.throws(() => new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid,
    { now: () => f.state.now, privateAclBatch: () => {}, dependencyAcl: () => {} }));
});

for (const mode of ['append-certificate', 'checkpoint-bytes'] as const) {
  test(`a pre-mint ACL batch cannot conceal ${mode} mutation`, async () => {
    const f = await fz3bHostProductionFixture(); let mutated = false, signing = 0;
    const host = new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid, {
      now: () => f.state.now, privateAcl: () => {}, dependencyAcl: () => {},
      onStage: stage => { if (stage === 'signing') signing++; },
      privateAclBatch: files => {
        if (mutated) return;
        const checkpoint = files.find(file => file.endsWith('.desktop.json')); assert.ok(checkpoint);
        if (mode === 'append-certificate') writeFileSync(checkpoint.replace(/\.desktop\.json$/, '.certificate.json'), '{}', { flag: 'wx' });
        else writeFileSync(checkpoint, Buffer.concat([readFileSync(checkpoint), Buffer.from(' ')]));
        mutated = true;
      },
    });
    await assert.rejects(host.finish(f.owner.runId)); assert.equal(mutated, true); assert.equal(signing, 0);
    await held(hostStore(f), f.owner.runId); assert.equal(f.state.forbidden, 0);
  });
}

test('the post-publication ACL batch cannot turn a corrupted MAC into a successful finish', async () => {
  const f = await fz3bHostProductionFixture(); let batches = 0, mutated = false, signing = 0;
  const host = new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid, {
    now: () => f.state.now, privateAcl: () => {}, dependencyAcl: () => {},
    onStage: stage => { if (stage === 'signing') signing++; },
    privateAclBatch: files => {
      if (++batches !== 2) return;
      const file = files.find(candidate => candidate.endsWith('.certificate.json')); assert.ok(file);
      const value = JSON.parse(readFileSync(file).toString('utf8')); value.mac = '0'.repeat(64);
      writeFileSync(file, JSON.stringify(value)); mutated = true;
    },
  });
  await assert.rejects(host.finish(f.owner.runId)); assert.equal(mutated, true); assert.equal(signing, 1);
  await held(await freshHost(f), f.owner.runId); assert.equal(f.state.forbidden, 0);
});

test('startup batches and validates the whole inventory rather than accepting the first matching certificate', async () => {
  const f = await fz3bHostProductionFixture(); await hostStore(f).finish(f.owner.runId);
  const [valid] = certificateNames(f.home), invalid = path.join(path.dirname(valid), '11111111-1111-4111-8111-111111111111.certificate.json');
  writeFileSync(invalid, '{}', { flag: 'wx' }); let batches = 0, invalidIncluded = false;
  const backend = new Fz3bBackend(f.options); await backend.list();
  const host = new Fz3bHostFinalizationStore(new DesktopStore(f.home), backend, binding => f.assertOwner(binding.owner), sid, {
    now: () => f.state.now, privateAcl: () => { throw new Error('Readonly assessment must not repair ACLs'); }, dependencyAcl: () => {},
    privateAclBatch: files => { batches++; invalidIncluded = files.includes(valid) && files.includes(invalid); },
  });
  await held(host, f.owner.runId); assert.equal(batches, 1); assert.equal(invalidIncluded, true);
  assert.equal(readFileSync(invalid).toString('utf8'), '{}'); assert.equal(f.state.forbidden, 0);
});
