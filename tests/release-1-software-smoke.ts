import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { inside, samePath, plainPath } from './helpers/embedded-installed';
import { assertSnapshotNodeVersion } from './helpers/snapshot-smoke-scope';
import { ROOT, OUTPUT, NODE, SHA, Gate, assertManifest, assertPlan, verifyManifest, verifyPlan, verifyRelease, readHostAdmission, readStable, writeNew, sha, type Manifest, type Plan, type Phase } from './helpers/release-1-policy';
import { SoftwareFlow } from './helpers/release-1-workflow';

async function fixedDirectory(name: string) { const parent = path.join(ROOT, OUTPUT); await plainPath(parent); const directory = path.join(parent, name); try { await mkdir(directory); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } await plainPath(directory); return directory; }
export function assertEnvironment(env: NodeJS.ProcessEnv) {
  for (const [key, value] of Object.entries(env)) if (value && !(key === 'TSX_DISABLE_CACHE' && value === '1') && (/^(?:FORGEDESK_DATA_DIR|CODEX_HOME|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|NODE_V8_COVERAGE|ESBUILD_BINARY_PATH|PYTHONPATH|PYTHONHOME|__COMPAT_LAYER)$/i.test(key) || /^(?:TSX_|PLAYWRIGHT_|PWTEST_)/i.test(key) || /^FORGEDESK_(?:FZ3B|T2|HARDWARE_AGENT|SNAPSHOT)_/i.test(key))) throw Error('SOFTWARE_AMBIENT_OVERRIDE');
}
export async function main(args = process.argv.slice(2), bootstrapVerified = false) {
  assert.equal(bootstrapVerified, true, 'Use the externally SHA-verified builtins-only software bootstrap before importing TS/runtime dependencies');
  assertEnvironment(process.env); assertSnapshotNodeVersion(process.versions.node); assert.ok(samePath(process.execPath, NODE));
  const mode = args[0];
  if (mode === '--prepare-only' && args.length === 7) {
    const [, manifestPath, manifestSha256, installedInventoryPath, installedInventorySha256, hostDescriptorPath, hostDescriptorSha256] = args;
    assert.ok(path.isAbsolute(manifestPath)); const bytes = await readStable(manifestPath); assert.equal(sha(bytes), manifestSha256); const manifest: Manifest = JSON.parse(bytes.toString()); assertManifest(manifest); await verifyManifest(manifestPath, manifestSha256, manifest.candidateSha256);
    const release = await verifyRelease(manifest.candidateSha256, installedInventoryPath, installedInventorySha256), host = await readHostAdmission(hostDescriptorPath, hostDescriptorSha256);
    const plan: Plan = { schemaVersion: 1, scope: 'release-1-root-phased-snapshot-v1', version: '1.0.0', acceptanceId: `release-1-${Date.now()}-${randomUUID().slice(0, 6)}`, preparedAt: new Date().toISOString(), candidateSha256: manifest.candidateSha256, manifestPath, manifestSha256, release, host }; assertPlan(plan);
    const directory = path.join(await fixedDirectory('runs'), plan.acceptanceId); await mkdir(directory); const file = path.join(directory, 'plan.json'), pin = await writeNew(file, plan); console.log(JSON.stringify({ result: 'prepared-only-not-launched-not-root-armed', plan: file, sha256: pin })); return;
  }
  assert.ok(mode === '--observe' && args.length === 3, 'Use the builtins-only bootstrap capture/prepare/observe modes. No direct TS CLI or implicit action.');
  assert.equal(process.platform, 'win32'); const file = args[1]; assert.ok(path.isAbsolute(file) && inside(path.join(ROOT, OUTPUT, 'runs'), file));
  const raw = await readStable(file); assert.equal(sha(raw), args[2]); const plan: Plan = JSON.parse(raw.toString()); assertPlan(plan); const directory = path.join(ROOT, OUTPUT, 'runs', plan.acceptanceId); assert.ok(samePath(file, path.join(directory, 'plan.json'))); await verifyPlan(plan);
  await writeNew(path.join(directory, 'session.json'), { schemaVersion: 1, scope: plan.scope, candidateSha256: plan.candidateSha256, planSha256: sha(raw), startedAt: new Date().toISOString(), automaticNextPhase: false });
  const flow = new SoftwareFlow(plan, directory), gate = new Gate(sha(raw)); let controlled = false, failed = false, done = false, failureWritten = false;
  let unsafeKeepAlive: ReturnType<typeof setInterval> | undefined;
  const stamp = () => ({ schemaVersion: 1, scope: plan.scope, acceptanceId: plan.acceptanceId, candidateSha256: plan.candidateSha256, planSha256: sha(raw) });
  let resolve!: () => void; const finished = new Promise<void>(r => { resolve = r; });
  const hold = async (error: unknown = Error('SOFTWARE_ROOT_INPUT_OR_SIGNAL')) => {
    if (failed || done) return;
    failed = true; gate.fail(); flow.stop(); process.exitCode = 1; const protection = flow.protect();
    input.close();
    const failure = flow.failure(error);
    if ('safeHarnessExit' in protection && protection.safeHarnessExit === false && !unsafeKeepAlive) unsafeKeepAlive = setInterval(() => {}, 60000);
    if (!failureWritten) { failureWritten = true; try { const pin = await writeNew(path.join(directory, 'held.json'), { ...stamp(), result: 'held-no-cleanup-no-cancel-no-retry-no-forced-close', phase: gate.next, predecessorSha256: gate.predecessor, error: 'SOFTWARE_ACCEPTANCE_HELD', failure, protection, observedAt: new Date().toISOString() }); console.log(JSON.stringify({ result: 'held', sha256: pin, needsHumanDecision: true })); } catch { console.error('SOFTWARE_HELD_EVIDENCE_UNAVAILABLE'); } }
    resolve();
  };
  const barrier = () => console.log(`ROOT_ARM_REQUIRED ${gate.expected(controlled)} ${gate.predecessor}`);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (failed || done) return;
    let phase: Phase; try { phase = gate.arm(line, controlled); } catch { void hold(); return; }
    const predecessorSha256 = gate.predecessor;
    void (async () => {
      await writeNew(path.join(directory, `${phase}.pending.json`), { ...stamp(), phase, predecessorSha256, result: 'pending', startedAt: new Date().toISOString() });
      flow.stage = 'phase-precheck'; await verifyPlan(plan); assert.equal(failed, false); const facts = await flow.run(phase); assert.equal(failed, false); flow.stage = 'phase-postcheck'; await verifyPlan(plan); assert.equal(failed, false);
      if (flow.page) { const state = await flow.snapshot(); assert.equal(typeof state.hardware.modeActive, 'boolean'); controlled = state.hardware.modeActive === true; }
      flow.stage = 'phase-receipt'; const pin = await writeNew(path.join(directory, `${phase}.json`), { ...stamp(), phase, predecessorSha256, result: 'passed', facts, automaticNextPhase: false, finishedAt: new Date().toISOString() }); assert.equal(failed, false); gate.complete(phase, pin); console.log(JSON.stringify({ result: 'passed', phase, sha256: pin }));
      if (gate.done) { done = true; input.close(); resolve(); } else barrier();
    })().catch(error => hold(error));
  });
  input.on('close', () => { if (!done && !failed) void hold(); });
  const abort = () => { void hold(); }; process.on('SIGINT', abort); process.on('SIGTERM', abort); process.stdout.on('error', abort); process.stderr.on('error', abort);
  barrier(); await finished;
  if (failed) console.error('SOFTWARE_APP_PRESERVED: pending original IPC/work is not cancelled, interrupted, disconnected, replayed or closed. Root must separately decide any maintenance action.');
  else { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); process.stdout.removeListener('error', abort); process.stderr.removeListener('error', abort); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
