import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test, { before, after, mock } from 'node:test';
import { Fz3bAgentMain, type Fz3bAgentMainOptions } from '../apps/desktop/main/fz3b-agent';
import { Fz3bHostFinalizationStore } from '../apps/desktop/main/host-finalization-store';
import { requestNativeFz3bHostLocalAction } from '../apps/desktop/main/fz3b-recovery-approval';
import { DesktopStore } from '../apps/desktop/main/store';
import { Fz3bBackend } from '../packages/engineering-runner/fz3b/backend';
import { fz3bHostProductionFixture } from './helpers/fz3b-host-production-fixture';
import { assertFz3bEmptyHomeReceipt } from './helpers/fz3b-host-finalization-ipc-observer';

const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
before(() => {
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    mock.method(childProcess, key, () => { throw new Error('EMPTY_HOME_STARTUP_FIXTURE_FORBIDS_SUBPROCESS'); });
  }
  syncBuiltinESMExports();
});
after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
type Fixture = Awaited<ReturnType<typeof fz3bHostProductionFixture>>;
function manager(f: Fixture, restart = false) {
  const store = restart ? new DesktopStore(f.home) : f.store, backend = restart ? new Fz3bBackend(f.options) : f.backend;
  const holds = new Set<string>(), state = { released: 0, signing: 0, saving: 0, acl: 0 };
  const forbidden = () => { throw new Error('No model, account, native or remote activity in this fixture'); };
  const options: Fz3bAgentMainOptions = { backend, createEngine: forbidden,
    getSession: taskId => { const session = store.sessions.find(item => item.taskId === taskId); assert.ok(session); return session; },
    assertCanStart: forbidden, assertBeforeClaim: forbidden, enterControlledMode: async () => forbidden(), assertGlobalOwner: forbidden,
    assertGlobalRecoveryOwner: owner => { f.assertOwner(owner); assert.equal(holds.size, 1); },
    assertHostCommitOwner: owner => { f.assertOwner(owner); assert.equal(holds.size, 1); },
    checkRuntime: async () => {}, readAccount: async () => forbidden(), setAccount: forbidden,
    hold: taskId => { holds.add(taskId); }, release: taskId => { holds.delete(taskId); state.released++; },
    save: () => { state.saving++; store.save(); }, publish() {}, log() {}, onEvent() {}, redact: value => value };
  const main = new Fz3bAgentMain(options);
  options.hostFinalization = new Fz3bHostFinalizationStore(store, backend, binding => main.assertSynchronousHostCommitOwner(binding.owner),
    'S-1-5-21-1-2-3-1001', { onStage: stage => { if (stage === 'signing') state.signing++; },
      privateAcl: () => { state.acl++; }, privateAclBatch: () => { state.acl++; }, dependencyAcl: () => { state.acl++; } });
  return { main, state, holds, store, backend };
}

test('actual production/HMAC startup recognizes the original empty canonical prefix, quarantines only after fresh policy, then independently finishes', async () => {
  const f = await fz3bHostProductionFixture(), canonical = path.join(f.home, 'fz3b-host-finalization-v1');
  fs.mkdirSync(canonical); const identity = fs.statSync(canonical), ledger = fs.readFileSync(f.ledgerPath);
  const original = JSON.stringify((await f.backend.status(f.owner.runId))!.preflightRefusalRecoveries);
  const first = manager(f); await first.main.recoverStartup(); await first.main.restoreCertifiedHostCompletion();
  const before = await first.main.snapshot(); assert.equal(first.main.held, true); assert.equal(before.activeRunId, f.owner.runId);
  assert.equal(before.recoveryActions?.quarantineEmptyHome, true); assert.equal(before.recoveryActions?.finishPreflightRefusal, true);
  assert.equal(first.state.signing, 0); assert.deepEqual(fs.readdirSync(canonical), []);
  // Local maintenance proof is independently read-only and cannot clear this startup hold.
  await first.main.prepareHostMaintenanceExit(f.owner.runId);
  assert.deepEqual(fs.readFileSync(f.ledgerPath), ledger); assert.equal(first.main.held, true); assert.equal(first.state.signing, 0);
  const second = manager(f, true); await second.main.recoverStartup(); await second.main.restoreCertifiedHostCompletion();
  assert.equal((await second.main.snapshot()).recoveryActions?.quarantineEmptyHome, true);
  const intent = await second.main.prepareEmptyHostHome(f.owner.runId);
  assert.equal(Date.parse(intent.expiresAt) - Date.parse(intent.createdAt), 300000);
  let dialogs = 0;
  const accepted = await requestNativeFz3bHostLocalAction(intent, { assertOwner: owner => second.main.assertRecoveryOwner({ ...intent.proof.completion.owner, ...owner }),
    show: async options => { dialogs++; assert.equal(options.title, 'ForgeDesk 主机空目录隔离'); assert.equal(options.checkboxChecked, false);
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); return { response: 1, checkboxChecked: true }; } });
  assert.equal(accepted, true); assert.equal(dialogs, 1); // Synthetic policy answer only, not native UI acceptance.
  const receipt = await second.main.quarantineEmptyHostHome(intent); assertFz3bEmptyHomeReceipt(receipt);
  assert.equal(receipt.nonce, intent.nonce); assert.equal(fs.existsSync(canonical), false);
  const preserved = path.join(f.home, `fz3b-host-quarantine-${intent.nonce}`, 'preserved-empty-home');
  assert.equal(fs.statSync(preserved).ino, identity.ino); assert.deepEqual(fs.readdirSync(preserved), []);
  assert.equal(receipt.intentSha256, createHash('sha256').update(fs.readFileSync(path.join(f.home, `fz3b-host-empty-${intent.nonce}.intent.json`))).digest('hex'));
  assert.equal(second.main.held, true); assert.equal(second.state.signing, 0); assert.equal(second.state.released, 0);
  const isolated = await second.main.snapshot(); assert.equal(isolated.recoveryActions?.quarantineEmptyHome, false);
  assert.equal(isolated.recoveryActions?.finishPreflightRefusal, true); assert.equal(isolated.runs[0].operations[1].status, 'unknown');
  assert.equal(JSON.stringify(isolated.runs[0].preflightRefusalRecoveries), original); assert.deepEqual(fs.readFileSync(f.ledgerPath), ledger);
  await second.main.reconcilePreflightRefusedInspect(f.owner.runId);
  assert.equal(second.main.held, false); assert.equal(second.state.signing, 1); assert.equal(second.state.released, 1);
  const third = manager(f, true); await third.main.recoverStartup(); await third.main.restoreCertifiedHostCompletion();
  assert.equal(third.main.held, false); assert.equal(third.state.signing, 0); assert.equal(third.state.saving, 0);
  assert.deepEqual(fs.readFileSync(f.ledgerPath), ledger); assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
});

test('legitimate startup with partial canonical identity stays held without quarantine capability, deletion or automatic repair', async () => {
  const f = await fz3bHostProductionFixture(), canonical = path.join(f.home, 'fz3b-host-finalization-v1');
  fs.mkdirSync(canonical); const leaf = path.join(canonical, 'partial-id.json'); fs.writeFileSync(leaf, 'retained partial bytes');
  const before = fs.readFileSync(leaf), ledger = fs.readFileSync(f.ledgerPath), current = manager(f);
  await current.main.recoverStartup(); await current.main.restoreCertifiedHostCompletion();
  assert.equal(current.main.held, true); assert.equal((await current.main.snapshot()).recoveryActions?.quarantineEmptyHome, false);
  await assert.rejects(current.main.prepareEmptyHostHome(f.owner.runId));
  assert.deepEqual(fs.readFileSync(leaf), before); assert.deepEqual(fs.readFileSync(f.ledgerPath), ledger);
  assert.equal(current.state.signing, 0); assert.equal(current.state.released, 0); assert.equal(f.state.forbidden, 0);
});
