import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopStore } from '../../apps/desktop/main/store';
import { Fz3bBackend, type Fz3bBackendOptions } from '../../packages/engineering-runner/fz3b/backend';
import { preflightRecoveryFixture } from '../../packages/engineering-runner/fz3b/preflight-recovery.fixture';
import { ProductionFz3bAdapter } from '../../packages/engineering-runner/fz3b/worker';
import type { Fz3bBinding } from '../../packages/engineering-runner/fz3b/types';

/** Project-local actual file/adapter fixture. Synthetic history; never an actual product data home. */
export async function fz3bHostProductionFixture() {
  const base = path.resolve('output/qa/2026-10-17-fz3b-recovery/recovery-phase3/host-finalization/production-fixtures');
  await mkdir(base, { recursive: true }); const home = await mkdtemp(path.join(base, 'offline-'));
  const source = preflightRecoveryFixture(), owner = source.run, operation = owner.operations[1];
  const workerRoot = path.join(home, 'fz3b-worker'), directory = path.join(workerRoot, operation.id);
  await mkdir(directory, { recursive: true });
  for (const [name, file] of [['evidence', 'evidence.json'], ['intent', 'intent.json'], ['transport', 'transport.json'], ['actualClose', 'process-exit.json']] as const) {
    await writeFile(path.join(directory, file), source.input.files[name], { flag: 'wx' });
  }
  await writeFile(path.join(workerRoot, 'active.lock'), JSON.stringify({ schemaVersion: 1, operationId: operation.id, nonce: operation.nonce,
    taskId: owner.taskId, profileSha256: owner.profileSha256 }), { flag: 'wx' });
  const state = { now: Date.parse('2026-10-17T12:00:00.000Z'), native: 0, forbidden: 0, ownerValid: true };
  const adapter = new ProductionFz3bAdapter({ resourceRoot: path.resolve('engineering/fz3b/product/resources'), dataDir: home });
  const forbidden = async () => { state.forbidden++; throw new Error('Offline host fixture forbids App/model/key/SSH/semantic/export activity'); };
  const seams = adapter as unknown as { now(): number; projectKey(): Promise<never>; transport(...args: unknown[]): Promise<never>;
    preflightRecovery: { now(): number } };
  seams.now = () => state.now; seams.preflightRecovery.now = () => state.now;
  seams.projectKey = forbidden; seams.transport = forbidden;
  adapter.build = forbidden; adapter.inspect = forbidden; adapter.semantic = forbidden; adapter.readPublicEvidence = forbidden;
  const assertOwner = (binding: Fz3bBinding) => {
    assert.equal(state.ownerValid, true);
    for (const field of ['runId', 'taskId', 'sessionId', 'threadId', 'turnId', 'model', 'generation'] as const) assert.equal(binding[field], owner[field]);
  };
  const options: Fz3bBackendOptions = { dataDir: home, fixture: source.fixture, adapter, now: () => state.now,
    assertOwner: forbidden, assertRecoveryOwner: assertOwner, checkRuntime: async () => {},
    requestSemantic: forbidden, requestPreflightRefusalRecovery: async () => { state.native++; return true; } };
  const backend = new Fz3bBackend(options); await backend.list();
  // Seed only this new synthetic home through the actual backend HMAC writer; key bytes are never read by the fixture.
  const internal = backend as unknown as { records: Map<string, any>; save(record: unknown): Promise<void> };
  const record = structuredClone(source.record); delete record.maintenanceExit;
  internal.records.set(owner.runId, record); await internal.save(record);
  await backend.prepareMaintenanceExit(owner.runId);
  const sourceRun = (await backend.status(owner.runId))!;
  const completed = await backend.reconcilePreflightRefusedInspect(owner.runId);
  assert.equal(completed.hardwareBusy, false); assert.equal(completed.operations[1].status, 'unknown');
  assert.equal(completed.operations[1].remoteQuiescent, false); assert.equal(state.native, 1); assert.equal(state.forbidden, 0);
  assert.ok(completed.preflightRefusalRecoveries?.[0].closure);
  const store = new DesktopStore(home), projectRoot = path.join(home, 'project'); await mkdir(projectRoot);
  store.projects = [{ id: 'offline-project', root: projectRoot, name: 'Offline host finalization' }];
  store.sessions = [{ id: owner.sessionId, taskId: owner.taskId, projectId: 'offline-project', title: 'Offline host finalization',
    threadId: owner.threadId, model: owner.model, engineProfile: 'fz3b', status: 'needs_attention', historyIncomplete: true,
    engineUncertain: false, messages: [] }];
  store.save();
  return { home, dataDir: home, store, backend, options, backendOptions: options, adapter, owner, sourceRun, completed, state,
    workerRoot, ledgerPath: path.join(home, 'fz3b-agent', `${owner.runId}.json`), assertOwner };
}
