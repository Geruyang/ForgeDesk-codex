import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { DesktopStore } from '../apps/desktop/main/store';
import { Fz3bHostFinalizationStore, finishFz3bHostFinalization, hasFz3bHostFinalization, type HostFinalizationStage } from '../apps/desktop/main/host-finalization-store';
import { FZ3B_HOST_FINALIZATION_LIMITS } from '../packages/engineering-runner/fz3b/host-finalization';
import { fz3bHostProductionFixture } from './helpers/fz3b-host-production-fixture';

const sid = 'S-1-5-21-1-2-3-1001';
type Fixture = Awaited<ReturnType<typeof fz3bHostProductionFixture>>;
const componentFor = (f: Fixture, observation: ConstructorParameters<typeof Fz3bHostFinalizationStore>[4] = {}, store = f.store, identity = sid) =>
  new Fz3bHostFinalizationStore(store, f.backend, binding => f.assertOwner(binding.owner), identity, { privateAcl: () => {}, privateAclBatch: (files, value) => { for (const file of files) observation.privateAcl?.(file, value, false); }, dependencyAcl: () => {}, ...observation });
function certificates(home: string): string[] {
  const directory = path.join(home, 'fz3b-host-finalization-v1'); if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory()).flatMap(item => fs.readdirSync(path.join(directory, item.name)).filter(name => name.endsWith('.certificate.json')).map(name => path.join(directory, item.name, name)));
}

test('real critical save precedes signing; restart verifies without writes or ordinary-save attestations', async () => {
  const f = await fz3bHostProductionFixture(), stages: string[] = [];
  f.store.save = () => { throw new Error('Ordinary void save must not be a receipt'); };
  const component = componentFor(f, { onStage: stage => { stages.push(stage); } });
  assert.equal(await component.has(f.owner.runId), false); await component.finish(f.owner.runId);
  assert.ok(stages.indexOf('signing') > stages.indexOf('desktop-readback'));
  assert.ok(stages.indexOf('signing') > stages.indexOf('checkpoint-readback'));
  assert.equal(certificates(f.home).length, 1); assert.equal(await component.has(f.owner.runId), true);
  const file = certificates(f.home)[0], original = fs.readFileSync(file), metadata = fs.statSync(file);
  const restarted = componentFor(f, { onStage: () => { throw new Error('Readonly startup wrote'); } }, new DesktopStore(f.home));
  assert.equal(await restarted.has(f.owner.runId), true); await restarted.finish(f.owner.runId);
  assert.deepEqual(fs.readFileSync(file), original); assert.equal(fs.statSync(file).mtimeMs, metadata.mtimeMs);
  assert.equal(f.state.native, 1); assert.equal(f.state.forbidden, 0);
});

test('title and unrelated sessions remain valid; changed target cannot overwrite its certificate', async () => {
  const f = await fz3bHostProductionFixture(), component = componentFor(f); await component.finish(f.owner.runId);
  f.store.sessions[0].title = 'Renamed display title';
  f.store.sessions.push({ id: 'unrelated', taskId: 'unrelated', projectId: 'offline-project', title: 'Other', status: 'draft', messages: [] }); f.store.save();
  assert.equal(await component.has(f.owner.runId), true);
  for (const mutate of [() => { f.store.sessions[0].threadId = 'foreign'; }, () => { f.store.sessions[0].messages.push({ id: 'new', role: 'user', text: 'Changed', timestamp: '2026-10-17T12:00:00.000Z' }); }, () => { f.store.projects[0].root += '-changed'; }]) {
    const sessions = structuredClone(f.store.sessions), projects = structuredClone(f.store.projects), certificate = fs.readFileSync(certificates(f.home)[0]);
    mutate(); f.store.save(); await assert.rejects(component.finish(f.owner.runId)); assert.deepEqual(fs.readFileSync(certificates(f.home)[0]), certificate);
    f.store.sessions = sessions; f.store.projects = projects; f.store.save();
  }
});

for (const fault of ['identity-written', 'key-written', 'desktop-written', 'desktop-renamed', 'desktop-readback', 'checkpoint-written', 'checkpoint-readback', 'before-signing'] as const) {
  test(`${fault} visible-save or earlier failure cannot reach the signer`, async () => {
    const f = await fz3bHostProductionFixture(), stages: HostFinalizationStage[] = [];
    const component = componentFor(f, { onStage: stage => { stages.push(stage); if (stage === fault) throw new Error('Synthetic write failure'); } });
    await assert.rejects(component.finish(f.owner.runId), /Synthetic write failure/);
    assert.equal(stages.includes('signing'), false); assert.equal(certificates(f.home).length, 0);
    try { assert.equal(await componentFor(f, {}, new DesktopStore(f.home)).has(f.owner.runId), false); }
    catch (error) { assert.match(String(error), /ENOENT|IDENTITY/); }
  });
}

test('certificate publication visible-then-throw remains failed, but restart authenticates its upstream save', async () => {
  const f = await fz3bHostProductionFixture();
  const component = componentFor(f, { onStage: stage => { if (stage === 'certificate-written') throw new Error('Certificate publish failed after visible'); } });
  await assert.rejects(component.finish(f.owner.runId), /after visible/); assert.equal(certificates(f.home).length, 1);
  assert.equal(await componentFor(f, {}, new DesktopStore(f.home)).has(f.owner.runId), true);
});

test('last-stage target/source changes, bad readback and late/backwards clock deny minting', async () => {
  for (const mode of ['corrupt-desktop', 'late', 'rollback', 'target-before-mint', 'source-before-mint'] as const) {
    const f = await fz3bHostProductionFixture(); let clock = Date.parse('2026-10-17T12:30:00.000Z'), signing = 0;
    const component = componentFor(f, { now: () => clock, onStage: stage => {
      if (stage === 'signing') signing++;
      if (stage === 'desktop-renamed') {
        if (mode === 'corrupt-desktop') fs.writeFileSync(path.join(f.home, 'desktop.json'), '{}');
        if (mode === 'late') clock += 5001;
        if (mode === 'rollback') clock--;
      }
      if (stage === 'before-signing') {
        if (mode === 'target-before-mint') f.store.sessions[0].threadId = 'foreign';
        if (mode === 'source-before-mint') fs.appendFileSync(f.ledgerPath, '\n');
      }
    } });
    await assert.rejects(component.finish(f.owner.runId)); assert.equal(signing, 0); assert.equal(certificates(f.home).length, 0);
  }
});

test('real-store/component provenance, missing identity/key, forged cert, checkpoint changes and hardlinks never repair', async () => {
  const base = await fz3bHostProductionFixture();
  assert.throws(() => componentFor(base, {}, { root: base.home } as DesktopStore), /REAL_STORE_REQUIRED/);
  assert.throws(() => componentFor(base, {}, Object.create(DesktopStore.prototype)), /REAL_STORE_REQUIRED/);
  assert.throws(() => finishFz3bHostFinalization({ finish: async () => {} } as unknown as Fz3bHostFinalizationStore, base.owner.runId), /REAL_COMPONENT_REQUIRED/);
  for (const mode of ['missing-key', 'missing-identity', 'forged', 'checkpoint', 'hardlink'] as const) {
    const f = await fz3bHostProductionFixture(), component = componentFor(f); await component.finish(f.owner.runId);
    const certFile = certificates(f.home)[0], cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
    const checkpoint = path.join(f.home, 'fz3b-host-finalization-v1', cert.snapshot.checkpointFile);
    if (mode === 'missing-key') fs.unlinkSync(path.join(f.home, 'fz3b-host-finalization-v1/key.bin'));
    if (mode === 'missing-identity') fs.unlinkSync(path.join(f.home, 'fz3b-host-finalization-v1/identity.json'));
    if (mode === 'forged') { cert.mac = '0'.repeat(64); fs.writeFileSync(certFile, JSON.stringify(cert)); }
    if (mode === 'checkpoint') fs.appendFileSync(checkpoint, ' ');
    if (mode === 'hardlink') fs.linkSync(checkpoint, path.join(f.home, 'extra-hardlink'));
    const before = fs.readFileSync(certFile);
    await assert.rejects(component.has(f.owner.runId)); await assert.rejects(component.finish(f.owner.runId)); assert.deepEqual(fs.readFileSync(certFile), before);
  }
});

test('readonly absence never bootstraps; a different token SID cannot verify or rekey', async () => {
  const f = await fz3bHostProductionFixture(), component = componentFor(f), before = fs.readdirSync(f.home);
  assert.equal(await component.has(f.owner.runId), false); assert.deepEqual(fs.readdirSync(f.home), before);
  await component.finish(f.owner.runId);
  await assert.rejects(componentFor(f, {}, f.store, 'S-1-5-21-1-2-3-1002').has(f.owner.runId), /IDENTITY/);
  await assert.rejects(componentFor(f, {}, f.store, 'S-1-5-21-1-2-3-1002').finish(f.owner.runId), /IDENTITY/);
});

test('trusted dispatch cannot be replaced by a public instance method or completed flag', async () => {
  const f = await fz3bHostProductionFixture(), component = componentFor(f);
  component.finish = async () => {}; component.has = async () => true;
  assert.equal(await hasFz3bHostFinalization(component, f.owner.runId), false);
  await finishFz3bHostFinalization(component, f.owner.runId); assert.equal(certificates(f.home).length, 1);
});

test('snapshot and append-only inventory budgets never truncate or evade signing', async () => {
  const f = await fz3bHostProductionFixture(); f.store.sessions[0].messages = [{ id: 'big', role: 'user', text: 'x'.repeat(FZ3B_HOST_FINALIZATION_LIMITS.snapshotBytes), timestamp: '2026-10-17T12:00:00.000Z' }];
  let signing = 0; const component = componentFor(f, { onStage: stage => { if (stage === 'signing') signing++; } });
  await assert.rejects(component.finish(f.owner.runId), /BUDGET/); assert.equal(signing, 0);
  const g = await fz3bHostProductionFixture(), other = componentFor(g); await other.finish(g.owner.runId);
  const runDirectory = path.join(g.home, 'fz3b-host-finalization-v1', g.owner.runId);
  for (let i = 0; i < 16; i++) fs.writeFileSync(path.join(runDirectory, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}.desktop.json`), '{}');
  await assert.rejects(other.has(g.owner.runId), /INVENTORY_BUDGET/); await assert.rejects(other.finish(g.owner.runId), /INVENTORY_BUDGET/);
});

test('privacy is established before writing bytes; readonly verification never requests ACL repair', async () => {
  const f = await fz3bHostProductionFixture(), calls: Array<{ file: string; update: boolean }> = [];
  const component = componentFor(f, { privateAcl: (file, value, update) => {
    assert.equal(value, sid); calls.push({ file, update });
    if (update && fs.statSync(file).isFile()) assert.equal(fs.statSync(file).size, 0, 'Protect each exclusive file before its first secret/checkpoint byte');
  } });
  await component.finish(f.owner.runId);
  const updates = calls.filter(call => call.update);
  assert.ok(updates.some(call => call.file.endsWith('fz3b-host-finalization-v1')));
  assert.ok(updates.some(call => call.file.endsWith('key.bin')));
  calls.length = 0; assert.equal(await component.has(f.owner.runId), true); assert.ok(calls.length > 0); assert.ok(calls.every(call => !call.update));
  await assert.rejects(componentFor(f, { privateAcl: () => { throw new Error('ACL no longer private'); } }).has(f.owner.runId), /ACL_PRIVATE_INVENTORY_READ_FAILED/);
});

test('private directory or key ACL failure cannot reach secret writes or certificate signing', async () => {
  for (const target of ['directory', 'key'] as const) {
    const f = await fz3bHostProductionFixture(); let signing = 0;
    const component = componentFor(f, { privateAcl: (file, _sid, update) => {
      if (update && (target === 'directory' && file.endsWith('fz3b-host-finalization-v1') || target === 'key' && file.endsWith('key.bin'))) throw new Error('Synthetic private ACL failure');
    }, onStage: stage => { if (stage === 'signing') signing++; } });
    await assert.rejects(component.finish(f.owner.runId), /ACL_.*FAILED/); assert.equal(signing, 0);
    const key = path.join(f.home, 'fz3b-host-finalization-v1/key.bin'); if (fs.existsSync(key)) assert.equal(fs.statSync(key).size, 0);
    assert.equal(certificates(f.home).length, 0);
  }
});

test('actual fsync, close and visible rename errors cannot be replaced by stage callbacks or success flags', async () => {
  for (const fault of ['sync-before', 'sync-after', 'close-after', 'rename-after'] as const) {
    const f = await fz3bHostProductionFixture(); let signing = 0;
    const component = componentFor(f, { onStage: stage => { if (stage === 'signing') signing++; } });
    const mutable = fsMutable as unknown as Record<string, any>, names = ['openSync', 'fsyncSync', 'closeSync', 'renameSync'];
    const originals = Object.fromEntries(names.map(name => [name, mutable[name]])), descriptors = new Map<number, string>();
    let injected = false;
    mutable.openSync = (...args: any[]) => { const fd = Reflect.apply(originals.openSync, fsMutable, args) as number; descriptors.set(fd, String(args[0])); return fd; };
    mutable.fsyncSync = (fd: number) => {
      const target = descriptors.get(fd)?.includes('.host-terminal-');
      if (!injected && target && fault === 'sync-before') { injected = true; throw new Error('Synthetic actual fsync failure'); }
      const result = originals.fsyncSync(fd);
      if (!injected && target && fault === 'sync-after') { injected = true; throw new Error('Synthetic actual fsync failure'); }
      return result;
    };
    mutable.closeSync = (fd: number) => {
      const target = descriptors.get(fd)?.includes('.host-terminal-'); const result = originals.closeSync(fd); descriptors.delete(fd);
      if (!injected && target && fault === 'close-after') { injected = true; throw new Error('Synthetic actual close failure'); } return result;
    };
    mutable.renameSync = (...args: any[]) => {
      const result = Reflect.apply(originals.renameSync, fsMutable, args);
      if (!injected && String(args[0]).includes('.host-terminal-') && fault === 'rename-after') { injected = true; throw new Error('Synthetic actual visible rename failure'); } return result;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(component.finish(f.owner.runId), /Synthetic actual/); }
    finally { for (const name of names) mutable[name] = originals[name]; syncBuiltinESMExports(); }
    assert.equal(injected, true); assert.equal(signing, 0); assert.equal(certificates(f.home).length, 0);
    assert.equal(await componentFor(f, {}, new DesktopStore(f.home)).has(f.owner.runId), false);
  }
});

test('named backend directory or MAC key replacement after the final await denies signing without reading key bytes', async () => {
  for (const target of ['directory', 'key'] as const) {
    const f = await fz3bHostProductionFixture(), original = f.backend.readPreflightHostCompletion.bind(f.backend);
    const name = target === 'directory' ? path.join(f.home, 'fz3b-agent') : path.join(f.home, 'fz3b-agent/binding.key'), moved = `${name}.original`;
    f.backend.readPreflightHostCompletion = async runId => {
      const value = await original(runId); fs.renameSync(name, moved);
      if (target === 'directory') fs.mkdirSync(name); else fs.writeFileSync(name, Buffer.alloc(32), { flag: 'wx' });
      return value;
    };
    let signing = 0;
    const component = componentFor(f, { onStage: stage => { if (stage === 'signing') signing++; } });
    try { await assert.rejects(component.finish(f.owner.runId), /DEPENDENCY_IDENTITY_CHANGED|ENOENT/); }
    finally { if (target === 'directory') fs.rmdirSync(name); else fs.unlinkSync(name); fs.renameSync(moved, name); }
    assert.equal(signing, 0); assert.equal(certificates(f.home).length, 0);
    assert.equal(fs.existsSync(path.join(f.home, 'fz3b-host-finalization-v1')), false);
  }
});

test('authenticated immutable certificate names changed target history without re-signing', async () => {
  const f = await fz3bHostProductionFixture(), component = componentFor(f); await component.finish(f.owner.runId);
  const file = certificates(f.home)[0], before = fs.readFileSync(file);
  f.store.sessions[0].messages.push({ id: 'changed', role: 'user', text: 'Changed target history', timestamp: '2026-10-17T12:00:00.000Z' }); f.store.save();
  await assert.rejects(component.finish(f.owner.runId), /FZ3B_HOST_FINALIZATION_TARGET_HISTORY_CHANGED/);
  assert.deepEqual(fs.readFileSync(file), before); assert.equal(certificates(f.home).length, 1);
});

test('late synchronous full checks fail before consuming provenance or computing a certificate MAC', async () => {
  const f = await fz3bHostProductionFixture(); let clock = Date.parse('2026-10-17T12:30:00.000Z'), owners = 0, signing = 0;
  const component = new Fz3bHostFinalizationStore(f.store, f.backend, binding => {
    f.assertOwner(binding.owner); if (++owners === 2) clock += 5001;
  }, sid, { now: () => clock, privateAcl: () => {}, privateAclBatch: () => {}, dependencyAcl: () => {}, onStage: stage => { if (stage === 'signing') signing++; } });
  await assert.rejects(component.finish(f.owner.runId), /STAGE_BUDGET/);
  assert.equal(signing, 0); assert.equal(certificates(f.home).length, 0);
});
