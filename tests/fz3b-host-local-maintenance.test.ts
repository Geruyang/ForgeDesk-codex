import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { Fz3bHostFinalizationStore, assertFz3bHostLocalProof, readFz3bHostLocalProof, prepareFz3bEmptyHome, quarantineFz3bEmptyHome } from '../apps/desktop/main/host-finalization-store';
import { requestNativeFz3bHostLocalAction, type Fz3bHostLocalConfirmation } from '../apps/desktop/main/fz3b-recovery-approval';
import { fz3bHostProductionFixture } from './helpers/fz3b-host-production-fixture';

type Fixture = Awaited<ReturnType<typeof fz3bHostProductionFixture>>;
const sid = 'S-1-5-21-1-2-3-1001';
const hostHome = (f: Fixture) => path.join(f.home, 'fz3b-host-finalization-v1');
function component(f: Fixture, observation: ConstructorParameters<typeof Fz3bHostFinalizationStore>[4] = {}) {
  return new Fz3bHostFinalizationStore(f.store, f.backend, binding => f.assertOwner(binding.owner), sid,
    { privateAcl() {}, privateAclBatch() {}, dependencyAcl() {}, ...observation });
}
function unchanged(f: Fixture) {
  const ledger = fs.readFileSync(f.ledgerPath), desktop = fs.readFileSync(path.join(f.home, 'desktop.json'));
  const run = JSON.stringify(f.sourceRun);
  return () => { assert.deepEqual(fs.readFileSync(f.ledgerPath), ledger); assert.deepEqual(fs.readFileSync(path.join(f.home, 'desktop.json')), desktop); assert.equal(JSON.stringify(f.sourceRun), run); assert.equal(f.state.forbidden, 0); };
}

test('readonly exit proof does not depend on broken certificate home and cannot be forged or replayed after owner/source change', async () => {
  const f = await fz3bHostProductionFixture(), host = component(f), same = unchanged(f);
  fs.mkdirSync(hostHome(f));
  const proof = await readFz3bHostLocalProof(host, f.owner.runId);
  assertFz3bHostLocalProof(host, proof);
  assert.throws(() => assertFz3bHostLocalProof(host, structuredClone(proof)), /PROVENANCE/);
  assert.equal(fs.readdirSync(hostHome(f)).length, 0); same();
  f.state.ownerValid = false;
  assert.throws(() => assertFz3bHostLocalProof(host, proof)); f.state.ownerValid = true;
  fs.appendFileSync(f.ledgerPath, '\n'); assert.throws(() => assertFz3bHostLocalProof(host, proof));
});

test('native local maintenance is default-cancel, checkbox-required, fixed TTL and whole-context-bound', async () => {
  const f = await fz3bHostProductionFixture(), host = component(f), same = unchanged(f);
  const proof = await host.readLocalProof(f.owner.runId), time = Date.now(); let clock = time, shows = 0;
  const context = (): Fz3bHostLocalConfirmation => ({ schemaVersion: 1, action: 'maintenance-exit', nonce: randomBytes(32).toString('hex'), createdAt: new Date(time).toISOString(), expiresAt: new Date(time + 300000).toISOString(), proof: structuredClone(proof) });
  const options = (change: (value: Fz3bHostLocalConfirmation) => void = () => {}, checked = true, preview = context()) => ({ preview, value: {
    now: () => clock, assertOwner: () => f.assertOwner(f.owner), show: async (details: any) => {
      shows++; assert.equal(details.defaultId, 0); assert.equal(details.cancelId, 0); assert.equal(details.checkboxChecked, false); assert.match(details.detail, /不连接 SSH/);
      change(preview); return { response: 1, checkboxChecked: checked };
    },
  } });
  let o = options(undefined, false); assert.equal(await requestNativeFz3bHostLocalAction(o.preview, o.value), false);
  o = options(); assert.equal(await requestNativeFz3bHostLocalAction(o.preview, o.value), true);
  o = options(value => { value.proof.targetSha256 = 'f'.repeat(64); }); assert.equal(await requestNativeFz3bHostLocalAction(o.preview, o.value), false);
  o = options(() => { clock = time - 1; }); assert.equal(await requestNativeFz3bHostLocalAction(o.preview, o.value), false);
  clock = time + 300000; o = options(); assert.equal(await requestNativeFz3bHostLocalAction(o.preview, o.value), false); assert.equal(shows, 4);
  assert.equal(fs.existsSync(hostHome(f)), false); same();
});

test('explicit empty-home isolation preserves old directory and requires later independent actual finish', async () => {
  const f = await fz3bHostProductionFixture(), host = component(f), same = unchanged(f);
  fs.mkdirSync(hostHome(f)); const original = fs.statSync(hostHome(f));
  const intent = await prepareFz3bEmptyHome(host, f.owner.runId);
  await assert.rejects(quarantineFz3bEmptyHome(host, structuredClone(intent)), /INTENT_INVALID/);
  const receipt = await quarantineFz3bEmptyHome(host, intent); same();
  assert.deepEqual(Object.keys(receipt).sort(), ['canonicalHomeAbsent', 'intentSha256', 'nonce', 'preservedEmpty', 'schemaVersion']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.nonce, intent.nonce); assert.equal(receipt.canonicalHomeAbsent, true); assert.equal(receipt.preservedEmpty, true); assert.match(receipt.intentSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(hostHome(f)), false);
  const preserved = path.join(f.home, `fz3b-host-quarantine-${intent.nonce}`, 'preserved-empty-home');
  assert.equal(fs.statSync(preserved).ino, original.ino); assert.deepEqual(fs.readdirSync(preserved), []);
  await assert.rejects(quarantineFz3bEmptyHome(host, intent), /USED/);
  assert.equal(await component(f).has(f.owner.runId), false);
  await component(f).finish(f.owner.runId);
  assert.equal(await component(f).has(f.owner.runId), true); same();
});

for (const mutation of ['nonempty', 'changed-owner', 'changed-target', 'changed-ledger'] as const) {
  test(`empty-home isolation rejects ${mutation} without adopting or deleting original directory`, async () => {
    const f = await fz3bHostProductionFixture(), host = component(f); fs.mkdirSync(hostHome(f));
    const intent = await prepareFz3bEmptyHome(host, f.owner.runId), original = fs.statSync(hostHome(f));
    if (mutation === 'nonempty') fs.writeFileSync(path.join(hostHome(f), 'identity.json'), 'untrusted');
    if (mutation === 'changed-owner') f.state.ownerValid = false;
    if (mutation === 'changed-target') f.store.sessions[0].messages.push({ id: 'changed', role: 'user', text: 'changed', timestamp: new Date().toISOString() });
    if (mutation === 'changed-ledger') fs.appendFileSync(f.ledgerPath, '\n');
    await assert.rejects(quarantineFz3bEmptyHome(host, intent));
    assert.equal(fs.statSync(hostHome(f)).ino, original.ino); assert.equal(f.state.forbidden, 0);
    await assert.rejects(quarantineFz3bEmptyHome(host, intent), /USED/);
  });
}

test('ACL timeout at new-home protection leaves no identity/key and reports only role+code; explicit isolation can recover it', async () => {
  const f = await fz3bHostProductionFixture();
  const host = component(f, { privateAcl: () => { throw Object.assign(new Error('PRIVATE_PATH secret script text'), { code: 'ETIMEDOUT' }); } });
  await assert.rejects(host.finish(f.owner.runId), error => String(error).endsWith('FZ3B_HOST_FINALIZATION_ACL_HOME_PROTECT_ETIMEDOUT'));
  assert.deepEqual(fs.readdirSync(hostHome(f)), []);
  const next = component(f), intent = await next.prepareEmptyHome(f.owner.runId);
  await next.quarantineEmptyHome(intent); await next.finish(f.owner.runId); assert.equal(await next.has(f.owner.runId), true);
});

test('partial intent or interrupted post-rename verification blocks absent-home finish rather than hiding it', async () => {
  for (const failRole of ['EMPTY_INTENT_PROTECT', 'QUARANTINE_PROTECT', 'EMPTY_RECEIPT_PROTECT']) {
    const f = await fz3bHostProductionFixture(); fs.mkdirSync(hostHome(f)); let signing = 0;
    const host = component(f, { privateAcl: file => {
      if (failRole === 'EMPTY_INTENT_PROTECT' && file.endsWith('.intent.json') || failRole === 'QUARANTINE_PROTECT' && file.includes('fz3b-host-quarantine-') || failRole === 'EMPTY_RECEIPT_PROTECT' && file.endsWith('.verified.json')) throw new Error('Synthetic failure');
    } });
    const intent = await host.prepareEmptyHome(f.owner.runId); await assert.rejects(host.quarantineEmptyHome(intent));
    const restarted = component(f, { onStage: stage => { if (stage === 'signing') signing++; } });
    await assert.rejects(restarted.finish(f.owner.runId)); assert.equal(signing, 0); assert.equal(f.state.forbidden, 0);
  }
});

test('nonempty or partially initialized homes cannot be isolated and certificate startup never repairs them', async () => {
  for (const file of ['identity.json', 'key.bin', 'unknown.certificate.json']) {
    const f = await fz3bHostProductionFixture(), host = component(f); fs.mkdirSync(hostHome(f)); fs.writeFileSync(path.join(hostHome(f), file), 'preserved');
    assert.equal(host.canQuarantineEmptyHome(), false); await assert.rejects(host.prepareEmptyHome(f.owner.runId)); await assert.rejects(host.has(f.owner.runId));
    assert.equal(fs.readFileSync(path.join(hostHome(f), file), 'utf8'), 'preserved');
  }
});

test('old untrusted leaf mutation after rename prevents verified receipt bytes; later mutation blocks startup and finish', async () => {
  for (const phase of ['before-receipt', 'later-finish']) {
    const f = await fz3bHostProductionFixture(); fs.mkdirSync(hostHome(f)); let nonce = '', signing = 0;
    const host = component(f, { privateAcl: file => {
      if (phase === 'before-receipt' && file.endsWith('.verified.json')) fs.writeFileSync(path.join(f.home, `fz3b-host-quarantine-${nonce}`, 'preserved-empty-home', 'unexpected'), 'untrusted');
    } });
    const intent = await host.prepareEmptyHome(f.owner.runId); nonce = intent.nonce;
    if (phase === 'before-receipt') {
      await assert.rejects(host.quarantineEmptyHome(intent), /QUARANTINE_IDENTITY_CHANGED/);
      assert.equal(fs.statSync(path.join(f.home, `fz3b-host-empty-${nonce}.verified.json`)).size, 0);
    } else {
      await host.quarantineEmptyHome(intent);
      fs.writeFileSync(path.join(f.home, `fz3b-host-quarantine-${nonce}`, 'preserved-empty-home', 'unexpected'), 'untrusted');
    }
    const restarted = component(f, { onStage: stage => { if (stage === 'signing') signing++; } });
    await assert.rejects(restarted.has(f.owner.runId)); await assert.rejects(restarted.finish(f.owner.runId));
    assert.equal(signing, 0); assert.equal(f.state.forbidden, 0);
  }
});

test('final quarantine ACL boundary cannot return absent receipt if canonical home reappears', async () => {
  const f = await fz3bHostProductionFixture(), same = unchanged(f); fs.mkdirSync(hostHome(f));
  let recreated = false, returned = false;
  const host = component(f, { privateAclBatch: files => {
    if (!recreated && files.some(file => file.endsWith('.verified.json'))) { fs.mkdirSync(hostHome(f)); recreated = true; }
  } });
  const intent = await host.prepareEmptyHome(f.owner.runId);
  await assert.rejects(host.quarantineEmptyHome(intent).then(() => { returned = true; }), /QUARANTINE_IDENTITY_CHANGED/);
  assert.equal(recreated, true); assert.equal(returned, false); assert.ok(fs.statSync(hostHome(f)).isDirectory()); same();
});

function exitHandler(ports: Record<string, unknown>) {
  const source = fs.readFileSync(new URL('../apps/desktop/main/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let method: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'fz3bMaintenanceExit') method = node; ts.forEachChild(node, visit); }; visit(ast);
  assert.ok(method);
  const js = ts.transpileModule(`module.exports = ({${method.getText(ast)}}).fz3bMaintenanceExit;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ module: { exports: undefined }, Date, randomBytes, clearTimeout, fz3bHostStartupReadOnly: false, fz3bHostActionRunId: undefined, evidenceTimer: undefined, closing: false, ...ports });
  vm.runInContext(js, context);
  return { invoke: (context.module as { exports: (runId: string) => Promise<void> }).exports, context };
}

for (const outcome of ['confirmed', 'cancelled', 'changed-after-dialog', 'changed-after-close', 'foreign-runner-owner'] as const) {
  test(`actual maintenance IPC ${outcome} never saves, releases, signs or creates legacy backend seal`, async () => {
    const f = await fz3bHostProductionFixture(), host = component(f), same = unchanged(f), calls: string[] = [];
    fs.mkdirSync(hostHome(f));
    const { fz3bCanonicalJson } = await import('../packages/engineering-runner/fz3b/profile');
    const routing = exitHandler({
      ensureWritable() {}, checkedText() {}, publish() {}, fz3bUnavailableHold: false, fz3bCanonicalJson,
      fz3bAgent: { engineState: 'stopped', requiresHostCompletion: () => true,
        prepareHostMaintenanceExit: async () => { calls.push('proof'); return readFz3bHostLocalProof(host, f.owner.runId); },
        assertRecoveryOwner: () => f.assertOwner(f.owner), assertHostLocalProof: (proof: any) => assertFz3bHostLocalProof(host, proof),
        prepareMaintenanceExit() { throw new Error('Legacy backend seal forbidden'); },
      },
      nativeApproval: async (_signal: unknown, _expiry: unknown, show: () => Promise<boolean>) => show(), requestNativeFz3bHostLocalAction,
      nativeWindow: () => ({}), dialog: { showMessageBox: async () => {
        calls.push('native'); if (outcome === 'changed-after-dialog') f.state.ownerValid = false;
        return { response: outcome === 'cancelled' ? 0 : 1, checkboxChecked: true };
      } },
      nativeDialogs: { busy: false, close: () => { calls.push('native-close'); } },
      bridge: { close: async () => { calls.push('bridge-close'); } }, embedded: { close: async () => { calls.push('embedded-close'); } },
      runner: { close: async () => { calls.push('runner-close'); if (outcome === 'changed-after-close') f.state.ownerValid = false; } },
      dataDir: f.home, assertRunnerLifecycleOwner: () => { calls.push('runner-owner'); if (outcome === 'foreign-runner-owner') throw new Error('Foreign runner owner'); },
      engine: { state: 'stopped' }, hardwareEngine: undefined,
      window: { destroy: () => { calls.push('destroy'); } }, app: { quit: () => { calls.push('quit'); } },
      save() { throw new Error('No session write allowed'); },
    });
    if (outcome.startsWith('changed') || outcome === 'foreign-runner-owner') await assert.rejects(routing.invoke(f.owner.runId)); else await routing.invoke(f.owner.runId);
    assert.equal(calls.includes('quit'), outcome === 'confirmed');
    if (outcome === 'confirmed') assert.deepEqual(calls, ['proof', 'native', 'proof', 'bridge-close', 'embedded-close', 'runner-owner', 'runner-close', 'proof', 'native-close', 'destroy', 'quit']);
    if (outcome === 'cancelled') assert.deepEqual(calls, ['proof', 'native']);
    if (outcome === 'changed-after-dialog') assert.equal(calls.includes('bridge-close'), false);
    if (outcome === 'changed-after-close') { assert.equal(calls.includes('runner-close'), true); assert.equal(calls.filter(call => call === 'proof').length, 3); }
    if (outcome === 'foreign-runner-owner') { assert.equal(calls.includes('runner-owner'), true); assert.equal(calls.includes('runner-close'), false); }
    assert.equal((routing.context as any).fz3bHostActionRunId, undefined);
    assert.equal((routing.context as any).closing, outcome === 'confirmed');
    assert.deepEqual(fs.readdirSync(hostHome(f)), []); same();
  });
}
