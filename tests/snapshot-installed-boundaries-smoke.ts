import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, readdir, lstat, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractFile } from '@electron/asar';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { EngineeringTask, Operation } from '../packages/engineering-runner';
import { redact } from '../packages/engineering-runner/redaction';
import { prepareSnapshotInstalledLifecycle } from './helpers/snapshot-installed-lifecycle';
import { verifySnapshotInstalledRelease, snapshotReleaseResources, snapshotReleaseVersion } from './helpers/snapshot-installed-release';
import { assertSnapshotNodeVersion } from './helpers/snapshot-smoke-scope';
import { assertInstalledSandboxArgs, assertNaturalSnapshotCompletion, assertBoundaryObservations, boundaryTargets, installedBoundaryProbeCode,
  installedFixtureEnvironment, isolatedNativeEnvironment, trustBootstrappedFixture, type BoundaryHostObservation } from './helpers/snapshot-installed-boundaries';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = path.join(root, 'install/ForgeDesk.exe');
const execute = promisify(execFile);
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fileHash = async (filename: string) => hash(await readFile(filename));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const active = (operation: Operation) => ['prepared', 'running', 'stopping'].includes(operation.status);
type Scenario = { name: string; directory: string; workspace: string; dataDir: string; home: string; temp: string; tmp: string; extra: string; env: NodeJS.ProcessEnv };
type InstalledBinding = { sandboxArgs: string[]; cli: { path: string; sha256: string }; host: { path: string; sha256: string }; node: { path: string; sha256: string } };

async function plain(filename: string): Promise<void> {
  const absolute = path.resolve(filename); let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment); assert.equal((await lstat(current)).isSymbolicLink(), false, 'Fixture paths cannot contain links or junctions');
  }
  assert.equal(samePath(await realpath(absolute), absolute), true);
}
async function present(filename: string): Promise<boolean> {
  try { const stat = await lstat(filename); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function safe(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]));
  return value;
}

async function main() {
  assert.deepEqual(process.argv.slice(2), ['--execute-installed-snapshot-boundaries'], 'Explicit installed-boundary execution flag required; this script launches the real installed application');
  assert.equal(process.platform, 'win32'); assertSnapshotNodeVersion(process.versions.node);
  const outputBase = path.join(root, 'output/qa/2026-10-16-snapshot-installed'); await mkdir(outputBase, { recursive: true });
  const output = await mkdtemp(path.join(outputBase, 'boundaries-'));
  const report: Record<string, any> = { schemaVersion: 1, scope: 'Primary-SID installed snapshot boundaries; fresh unauthenticated fixtures; no model or hardware requests',
    output, startedAt: new Date().toISOString(), status: 'running', steps: [], scenarios: [], pageErrors: [], failures: [],
    limits: ['Not real-model prompt compliance, second-SID acceptance, or arbitrary malicious same-user process isolation.',
      'Native file pickers are test-controlled fixed choices. Actual production renderer, preload, main, adapter and runner are not replaced.',
      'TEMP/TMP probe uses installed Codex/Job binaries and arguments observed in the installed GUI proof; it is a separate native probe, not a model tool call.',
      'One successful bounded native probe and normal-close observation do not inject process-crash, disk-full or timeout failures. No independent descendant census is claimed.',
      'No network egress test; no login, model turn, hardware API, SSH, ACL, installation or authentication-file copy is performed.'] };
  let app: ElectronApplication | undefined; let page: Page | undefined;
  let lifecycle: Awaited<ReturnType<typeof prepareSnapshotInstalledLifecycle>> | undefined;
  let current: Scenario | undefined; let taskId: string | undefined; let binding: InstalledBinding | undefined;
  const evidence = async () => writeFile(path.join(output, 'evidence.json'), JSON.stringify(safe(report), null, 2));
  const snapshot = () => page!.evaluate(() => window.forgeDesk.snapshot());
  function task(state: AppSnapshot): EngineeringTask {
    const value = state.tasks.find(item => item.id === taskId); assert.ok(value); return value as unknown as EngineeringTask;
  }
  async function waitFor(predicate: (state: AppSnapshot) => boolean, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await snapshot(); assert.equal(state.account.loggedIn, false); assert.equal(state.approvals.length, 0);
      assert.ok(state.sessions.every(session => !session.turnId && session.messages.length === 0), 'No model turns or messages are allowed in this fixture');
      if (predicate(state)) return state;
      await pause(150);
    }
    throw new Error('Installed boundary state wait timed out');
  }
  async function fixture(name: string): Promise<Scenario> {
    const directory = path.join(output, name); const workspace = path.join(directory, 'workspace'); const dataDir = path.join(directory, 'data');
    const home = path.join(dataDir, 'engine'); const temp = path.join(directory, 'TEMP with spaces'); const tmp = path.join(directory, 'TMP-distinct');
    const extra = path.join(directory, 'unauthorized-root');
    for (const dir of [workspace, home, temp, tmp, extra]) { await mkdir(dir, { recursive: true }); await plain(dir); }
    const env = installedFixtureEnvironment(process.env, dataDir, temp, tmp);
    await writeFile(path.join(workspace, 'numbers.mjs'), 'export function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }\n', { flag: 'wx' });
    await writeFile(path.join(workspace, '.gitignore'), 'ignored.bin\n', { flag: 'wx' });
    await writeFile(path.join(workspace, 'ignored.bin'), Buffer.from([0, 255, 0, 1]), { flag: 'wx' });
    await git(workspace, env, ['init', '--quiet', '--template=']);
    await git(workspace, env, ['add', 'numbers.mjs', '.gitignore']);
    await git(workspace, env, ['-c', 'user.name=ForgeDesk Boundary Fixture', '-c', 'user.email=boundary@example.invalid', 'commit', '--quiet', '-m', 'Correct fixed software baseline']);
    const top = await git(workspace, env, ['rev-parse', '--show-toplevel']); assert.equal(samePath(top.stdout.trim(), workspace), true);
    return { name, directory, workspace, dataDir, home, temp, tmp, extra, env };
  }
  async function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]) {
    const hooks = path.join(output, 'empty-git-hooks'); await mkdir(hooks, { recursive: true });
    return execute('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-C', cwd, ...args],
      { env, windowsHide: true, shell: false, timeout: 30000, maxBuffer: 1024 * 1024 });
  }
  async function launch(scenario: Scenario) {
    current = scenario; taskId = undefined;
    await verifySnapshotInstalledRelease(root, installed); await lifecycle!.beforeLaunch();
    const env = Object.fromEntries(Object.entries(scenario.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    app = await electron.launch({ executablePath: installed, args: [], cwd: root, env }); await lifecycle!.attach(app);
    page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
    await page.setViewportSize({ width: 1360, height: 900 }); await page.locator('.app-header').waitFor();
    await waitFor(state => ['ready', 'failed'].includes(state.engine.state)); await page.evaluate(() => window.forgeDesk.connect());
    const state = await snapshot(); assert.equal(state.version, snapshotReleaseVersion); assert.equal(state.dataDir, scenario.dataDir);
    assert.equal(state.engine.state, 'ready'); assert.equal(samePath(state.engine.home, scenario.home), true);
    assert.equal(samePath(state.engine.executable, path.join(root, 'install/resources/codex/codex.exe')), true);
    assert.equal(state.account.loggedIn, false); assert.equal(state.hardware.modeActive, false); assert.equal(state.approvals.length, 0);
    assert.equal(state.projects.length, 0); assert.equal(state.sessions.length, 0); assert.equal(state.tasks.length, 0);
    assert.equal(await present(path.join(scenario.home, 'auth.json')), false, 'Fresh fixture must not acquire credentials');
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, scenario.workspace);
    const project = await page.evaluate(() => window.forgeDesk.importProject()); assert.ok(project);
    await page.getByTitle(scenario.workspace, { exact: true }).and(page.getByRole('button')).click();
    const session = await page.evaluate(id => window.forgeDesk.createSession(id, 'Installed boundary fixture'), project.id); taskId = session.id;
    await page.getByRole('button', { name: /Installed boundary fixture/ }).click();
    await page.getByRole('tab', { name: '工程交付', exact: true }).click();
    await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, process.execPath);
    await page.getByRole('button', { name: '启用快照模板', exact: true }).click();
    const enabled = task(await waitFor(value => !!task(value).snapshotProfile)); assert.ok(enabled.snapshotProfile);
    assert.equal(enabled.snapshotProfile.id, 'forgedesk.node-software.v1');
    assert.equal(samePath(enabled.snapshotProfile.templateDirectory, path.join(root, 'install/resources/templates/node-software-v1')), true);
    return enabled;
  }
  async function close() {
    if (!app) return;
    await lifecycle!.closeNormally(); app = undefined; page = undefined;
    assert.equal(await present(path.join(current!.home, 'auth.json')), false);
  }
  async function build() {
    const before = task(await snapshot()).operations.length;
    await page!.getByRole('button', { name: '快照构建', exact: true }).click();
    await waitFor(state => task(state).operations.length === before + 1 && !task(state).operations.some(active) && task(state).status !== 'running');
    const button = page!.getByRole('button', { name: '快照构建', exact: true }); const deadline = Date.now() + 30000;
    while (!await button.isEnabled()) { if (Date.now() >= deadline) throw new Error('GUI build handler remained pending after terminal persistence'); await pause(100); }
    return task(await snapshot());
  }
  async function screenshots(prefix: string) {
    for (const size of [{ width: 1360, height: 900 }, { width: 800, height: 600 }]) {
      await page!.setViewportSize(size); assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page!.screenshot({ path: path.join(output, `${prefix}-${size.width}x${size.height}.png`) });
    }
  }
  try {
    report.release = await verifySnapshotInstalledRelease(root, installed);
    const installedAsar = path.join(root, 'install/resources/app.asar'); const unpackedAsar = path.join(root, 'release/win-unpacked/resources/app.asar');
    await plain(unpackedAsar); assert.equal(await fileHash(installedAsar), await fileHash(unpackedAsar), 'Installed ASAR differs from this release/win-unpacked candidate');
    const packaged = JSON.parse(extractFile(installedAsar, 'package.json').toString('utf8'));
    const sourcePackage = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    assert.equal(packaged.version, snapshotReleaseVersion); assert.equal(sourcePackage.version, packaged.version);
    const resourceEquality = [];
    for (const resource of snapshotReleaseResources) {
      const candidate = path.join(root, 'release/win-unpacked', resource); await plain(candidate);
      assert.equal(await fileHash(candidate), await fileHash(path.join(root, 'install', resource)), `Installed/unpacked resource mismatch: ${resource}`);
      resourceEquality.push({ path: resource, sha256: await fileHash(candidate) });
    }
    report.packageEquality = { packagedVersion: packaged.version, sourcePackageVersion: sourcePackage.version, asarSha256: await fileHash(installedAsar), resources: resourceEquality };
    report.provenance = await Promise.all(['tests/snapshot-installed-boundaries-smoke.ts', 'tests/helpers/snapshot-installed-boundaries.ts',
      'tests/helpers/snapshot-installed-lifecycle.ts', 'tests/helpers/snapshot-installed-release.ts', 'tests/helpers/snapshot-smoke-scope.ts',
      'tests/helpers/second-user-controls.ts', 'tests/helpers/playwright-no-kill.ts', 'tests/helpers/normal-close-observation.ts']
      .map(async filename => ({ path: filename, sha256: await fileHash(path.join(root, filename)) })));
    report.node = { executable: process.execPath, version: process.version, sha256: await fileHash(process.execPath) };
    lifecycle = await prepareSnapshotInstalledLifecycle(root, installed); report.lifecycle = lifecycle.evidence; await evidence();

    const clean = await fixture('clean'); await launch(clean);
    const cleanTask = await build(); const operation = cleanTask.operations.at(-1)!; const value = operation.snapshot;
    report.scenarios.push({ name: 'clean-installed-GUI', task: cleanTask }); await evidence();
    assertNaturalSnapshotCompletion(operation);
    assert.equal(cleanTask.status, 'passed'); assert.equal(cleanTask.acceptance.find(item => item.id === 'snapshot-software')?.status, 'passed');
    assert.ok(value && cleanTask.snapshotProfile); assert.equal(value.verificationResult, 'passed');
    for (const key of ['inputWriteDenied', 'privateWriteDenied', 'templateWriteDenied', 'sqliteInputWriteDenied', 'outputWriteAllowed', 'sqliteOutputWriteAllowed', 'hostMarkersAbsent', 'passed']) assert.equal(value.sandboxProbe?.[key], true, key);
    assert.equal(value.permissionProbe?.build.passed, true); assert.equal(value.permissionProbe?.verify.passed, true);
    assert.deepEqual(value.verifierReceipt?.checks, ['empty', 'nonempty', 'signed']); assert.equal(value.verifierReceipt?.passed, true);
    const probePath = value.isolation.probeLogRef; await plain(probePath); assert.equal(await fileHash(probePath), value.isolation.probeLogSha256);
    const proof = JSON.parse(await readFile(probePath, 'utf8'));
    assert.equal(proof.writeDenied, true); assert.equal(proof.workspaceWritten, true); assert.equal(proof.cleanupComplete, true);
    assert.equal(proof.originalSha256, proof.protectedAfterSha256); assert.equal(proof.failure, null);
    assert.equal(samePath(proof.projectRoot, clean.workspace), true); assert.equal(samePath(proof.binding.home, clean.home), true);
    assertInstalledSandboxArgs(proof.binding.sandboxArgs); binding = proof.binding as InstalledBinding;
    for (const [name, target] of [['cli', path.join(root, 'install/resources/codex/codex.exe')], ['host', path.join(root, 'install/resources/process-host/process-host.exe')], ['node', process.execPath]] as const) {
      assert.equal(samePath(binding[name].path, target), true); assert.equal(binding[name].sha256, await fileHash(target));
    }
    const stages = value.executionPolicies; assert.equal(stages?.length, 5); assert.ok(stages);
    const expectedStages = [['sandbox-probe.mjs', 'sandbox_probe', undefined], ['permission-probe.mjs', 'permission_probe', 'build'],
      ['build.mjs', 'building', undefined], ['permission-probe.mjs', 'permission_probe', 'verify'], ['verify.mjs', 'verifying', undefined]];
    const nonces = new Set<string>(); const digests = new Set<string>(); const generations = new Set<number>();
    for (const [index, stage] of stages.entries()) {
      assert.deepEqual([stage.file, stage.phase, stage.permissionStage], expectedStages[index]); assert.equal(stage.status, 'verified');
      assert.equal(stage.permissionProfileId, 'forgedesk_workspace_v1'); assert.equal(stage.sandboxArgsDigest, hash(JSON.stringify(binding.sandboxArgs)));
      assert.match(stage.commandDigest, /^[a-f0-9]{64}$/); assert.ok(stage.before && stage.after && stage.policyDigest);
      assert.equal(samePath(stage.before.projectRoot, value.outputRoot), true); assert.equal(samePath(stage.after.projectRoot, value.outputRoot), true);
      assert.equal(samePath(stage.before.home, clean.home), true); assert.equal(samePath(stage.after.home, clean.home), true);
      assert.equal(stage.before.generation, stage.after.generation); assert.equal(stage.before.effectivePolicySha256, stage.after.effectivePolicySha256);
      assert.equal(stage.before.managedPolicySha256, stage.after.managedPolicySha256); assert.equal(nonces.has(stage.nonce), false);
      const profile: NonNullable<EngineeringTask['snapshotProfile']> = cleanTask.snapshotProfile;
      const nodeArgs: string[] = stage.file === 'sandbox-probe.mjs'
        ? [path.join(profile.templateDirectory, stage.file), value.inputRoot, value.outputRoot, path.resolve(value.inputRoot, '../../../..'), profile.templateDirectory, stage.nonce]
        : ['--permission', `--allow-fs-read=${profile.templateDirectory}`, `--allow-fs-read=${value.inputRoot}`, `--allow-fs-read=${value.outputRoot}`,
          ...(stage.file === 'build.mjs' || stage.permissionStage === 'build' ? [`--allow-fs-write=${value.outputRoot}`] : []), path.join(profile.templateDirectory, stage.file),
          ...(stage.file === 'build.mjs' ? [value.inputRoot, value.outputRoot, stage.nonce]
            : stage.file === 'verify.mjs' ? [value.outputRoot, stage.nonce] : [value.inputRoot, value.outputRoot, stage.nonce, stage.permissionStage!])];
      assert.equal(stage.commandDigest, hash(JSON.stringify({ executable: profile.sandbox.executable,
        args: [...binding.sandboxArgs, profile.nodeExecutable, ...nodeArgs], cwd: value.outputRoot, timeoutMs: 30000 })), 'Actual command digest must match its complete independently reconstructed fixed-stage command');
      assert.equal(stage.policyDigest, hash(JSON.stringify({ schemaVersion: stage.before.schemaVersion, method: stage.before.method,
        projectRoot: stage.before.projectRoot, home: stage.before.home, effectivePolicySha256: stage.before.effectivePolicySha256,
        managedPolicySha256: stage.before.managedPolicySha256, permissionProfileId: 'forgedesk_workspace_v1', sandboxArgs: binding.sandboxArgs })));
      nonces.add(stage.nonce); digests.add(stage.policyDigest); generations.add(stage.before.generation);
    }
    assert.equal(digests.size, 1); assert.equal(generations.size, 1);
    report.installedObservedBinding = { probePath, probeSha256: value.isolation.probeLogSha256, binding, stageCount: stages.length, generation: [...generations][0] };
    await screenshots('clean-passed');
    const probeFiles = await readdir(path.dirname(probePath)); const priorIds = cleanTask.operations.map(item => item.id);
    await writeFile(path.join(clean.workspace, 'source-change.bin'), Buffer.from([0, 1, 255]), { flag: 'wx' });
    await page!.evaluate(id => window.forgeDesk.refreshEvidence(id), taskId!);
    const stale = task(await snapshot()); assert.equal(stale.acceptance.find(item => item.id === 'snapshot-software')?.status, 'stale');
    assert.equal(stale.operations.at(-1)?.snapshot?.verificationResult, 'passed', 'Current stale must not erase historical verifier success');
    await page!.evaluate(({ id, key }) => window.forgeDesk.runSnapshotBuild(id, key), { id: taskId!, key: operation.requestKey });
    const dedup = task(await snapshot()); assert.deepEqual(dedup.operations.map(item => item.id), priorIds);
    assert.equal(dedup.acceptance.find(item => item.id === 'snapshot-software')?.status, 'stale');
    assert.deepEqual(await readdir(path.dirname(probePath)), probeFiles, 'Old requestKey must not create a fresh native receipt');
    report.staleAndDedup = { taskId, originalOperationId: operation.id, requestKey: operation.requestKey, beforeOperationIds: priorIds,
      afterOperationIds: dedup.operations.map(item => item.id), acceptance: dedup.acceptance, evidence: dedup.evidence,
      historicalVerificationResult: dedup.operations.at(-1)?.snapshot?.verificationResult, nativeProbeFilesBefore: probeFiles,
      nativeProbeFilesAfter: await readdir(path.dirname(probePath)), noReexecution: true };
    report.steps.push('Installed GUI clean B passed; all five actual-cwd stage policies bound; source mutation stale; durable duplicate key neither re-executed nor restored current pass');
    await evidence(); await close();

    const injected = await fixture('actual-cwd-injection');
    const engineeringRoot = path.join(injected.dataDir, 'engineering'); await mkdir(path.join(engineeringRoot, '.codex'), { recursive: true });
    await git(engineeringRoot, injected.env, ['init', '--quiet', '--template=']);
    const engineeringTop = await git(engineeringRoot, injected.env, ['rev-parse', '--show-toplevel']); assert.equal(samePath(engineeringTop.stdout.trim(), engineeringRoot), true);
    const injectedConfig = `[permissions.forgedesk_workspace_v1.filesystem]\n${JSON.stringify(injected.extra.replaceAll('\\', '/'))} = "write"\n`;
    await writeFile(path.join(engineeringRoot, '.codex/config.toml'), injectedConfig, { flag: 'wx' });
    const homeConfig = path.join(injected.home, 'config.toml');
    const bootstrapTrust = await trustBootstrappedFixture({ engineeringRoot, launch: () => launch(injected),
      read: async () => { await plain(homeConfig); assert.equal(await present(homeConfig), true); return readFile(homeConfig); },
      append: async suffix => { await plain(homeConfig); assert.equal(await present(homeConfig), true); await appendFile(homeConfig, suffix, { flag: 'a' }); } });
    report.fixtureTrust = { homeConfig, ...bootstrapTrust }; await evidence();
    const refused = await build(); const rejected = refused.operations.at(-1)!;
    report.scenarios.push({ name: 'actual-output-cwd-profile-injection', engineeringRoot, configSha256: hash(injectedConfig), bootstrapTrust, task: refused }); await evidence();
    assert.equal(rejected.status, 'failed'); assert.match(rejected.failureReason ?? '', /fixed no-temp workspace policy/);
    assert.ok(rejected.snapshot, 'Copy may complete; the actual execution policy must reject before its first command');
    assert.equal(rejected.snapshot.sandboxProbe, undefined); assert.equal(rejected.snapshot.verifierReceipt, undefined);
    assert.equal(rejected.snapshot.executionPolicies?.length ?? 0, 0); assert.equal(await present(path.join(rejected.snapshot.outputRoot, 'numbers.mjs')), false);
    assert.notEqual(refused.status, 'passed'); assert.ok(refused.evidence.every(item => item.result !== 'passed'));
    assert.deepEqual(await readdir(injected.extra), []); assert.equal(await present(path.join(injected.home, 'auth.json')), false);
    await screenshots('actual-cwd-refused'); report.steps.push('Installed producer rejected trusted actual-output-cwd profile injection before the first outer command; no build artifact or verifier receipt');
    await evidence(); await close();

    assert.ok(binding); report.native = await nativeBoundaries(output, binding, evidence, report);
    report.steps.push('Installed-resource native profile denied actual distinct TEMP/TMP filesystem and SQLite creation with host-positive controls and exact cleanup');
    assert.deepEqual(report.pageErrors, []); report.status = 'passed'; report.completedAt = new Date().toISOString(); await evidence();
    const evidenceSha256 = await fileHash(path.join(output, 'evidence.json')); await writeFile(path.join(output, 'evidence.sha256'), `${evidenceSha256}  evidence.json\n`, { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, output, evidenceSha256, modelInvoked: false, hardwareInvoked: false }));
  } catch (error) {
    report.status = 'failed'; report.failures.push(redact(error instanceof Error ? error.stack ?? error.message : String(error)));
    if (page) {
      try { report.lastSnapshot = await snapshot(); await page.screenshot({ path: path.join(output, 'failure.png') }); } catch { /* Preserve the original failure. */ }
    }
    if (app) try { await close(); } catch (closeError) { report.closeFailure = redact(String(closeError)); }
    const protection = lifecycle?.protectOnFailure(); report.protection = protection;
    report.completedAt = new Date().toISOString(); await evidence(); console.error(JSON.stringify({ status: 'failed', output, needsHumanClose: protection?.needsHumanClose ?? false }));
    if (protection?.safeHarnessExit === false) {
      console.error('Unknown process exit hook: harness retained for operator action; no product kill attempted');
      setInterval(() => {}, 1000);
      await new Promise<never>(() => {});
    }
    process.exit(1);
  }
}

async function nativeBoundaries(output: string, binding: InstalledBinding, save: () => Promise<void>, report: Record<string, any>) {
  assertInstalledSandboxArgs(binding.sandboxArgs);
  for (const name of ['cli', 'host', 'node'] as const) { await plain(binding[name].path); assert.equal(await fileHash(binding[name].path), binding[name].sha256); }
  const base = path.join(output, 'installed-native'); const cwd = path.join(base, 'workspace'); const home = path.join(base, 'home');
  const temp = path.join(base, 'TEMP with spaces'); const tmp = path.join(base, 'TMP-distinct'); const protectedRoot = path.join(base, 'protected');
  const nonce = randomUUID(); const targets = boundaryTargets(cwd, temp, tmp, protectedRoot, nonce);
  for (const dir of [home, ...targets.map(target => target.directory)]) { await mkdir(dir, { recursive: true }); await plain(dir); }
  const { DatabaseSync } = await import('node:sqlite');
  for (const target of targets) {
    for (const filename of [target.marker, target.database, ...['-journal', '-wal', '-shm'].map(suffix => target.database + suffix)]) assert.equal(await present(filename), false);
    await writeFile(target.marker, nonce, { flag: 'wx' }); assert.equal(await readFile(target.marker, 'utf8'), nonce); await unlink(target.marker);
    let database: InstanceType<typeof DatabaseSync> | undefined;
    try {
      database = new DatabaseSync(path.toNamespacedPath(target.database)); database.exec('CREATE TABLE precondition(value INTEGER); INSERT INTO precondition VALUES (1)');
      assert.equal(database.prepare('SELECT value FROM precondition').get()?.value, 1);
    } finally { database?.close(); }
    assert.equal((await readFile(target.database)).subarray(0, 16).toString('binary'), 'SQLite format 3\0'); await unlink(target.database);
    for (const suffix of ['', '-journal', '-wal', '-shm']) assert.equal(await present(target.database + suffix), false);
  }
  const startedAt = new Date().toISOString(); const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  let stdoutBytes = 0; let stderrBytes = 0; let timedOut = false; let overflow = false; let childError: string | undefined;
  const args = ['--', binding.cli.path, ...binding.sandboxArgs, binding.node.path, '-e', installedBoundaryProbeCode, nonce, JSON.stringify(targets)];
  const child = spawn(binding.host.path, args, { cwd, env: isolatedNativeEnvironment(process.env, home, temp, tmp), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const native: Record<string, any> = { scope: 'Installed-resource native probe, not model or second-SID acceptance', startedAt, hostPid: child.pid,
    commandSha256: hash(JSON.stringify({ executable: binding.host.path, args, cwd })), codeSha256: hash(installedBoundaryProbeCode),
    capturedArgsSha256: hash(JSON.stringify(binding.sandboxArgs)), binding, targets, timeoutMs: 30000, hostPositiveControls: true, timedOut: false, overflow: false };
  report.native = native;
  const terminationAttempts: Array<{ at: string; accepted?: boolean; error?: string }> = [];
  let supervisorCloseObserved = false;
  const terminateOwnedHost = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const attempt: (typeof terminationAttempts)[number] = { at: new Date().toISOString() }; terminationAttempts.push(attempt);
    try { attempt.accepted = child.kill(); } catch (error) { attempt.error = redact(String(error)); }
  };
  for (const [stream, chunks, label] of [[child.stdout, stdout, 'stdout'], [child.stderr, stderr, 'stderr']] as const) stream.on('data', (chunk: Buffer) => {
    if (label === 'stdout') stdoutBytes += chunk.length; else stderrBytes += chunk.length;
    if ((label === 'stdout' ? stdoutBytes : stderrBytes) <= 65536) chunks.push(chunk); else { overflow = true; terminateOwnedHost(); }
  });
  const deadline = setTimeout(() => { timedOut = true; terminateOwnedHost(); }, 30000);
  let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
  const exitRequest = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', error => { childError = String(error); clearTimeout(deadline); reject(error); });
    child.once('close', (code, signal) => { supervisorCloseObserved = true; resolve({ code, signal }); });
    cleanupDeadline = setTimeout(() => reject(new Error('Owned native Job supervisor did not close after its fixed deadline; cleanup unconfirmed')), 40000);
  }).finally(() => { clearTimeout(deadline); if (cleanupDeadline) clearTimeout(cleanupDeadline); });
  // Attach before any I/O; a fast native exit must not be missed while saving.
  void exitRequest.catch(() => {});
  let saveFailure: unknown;
  try { await save(); } catch (error) { saveFailure = error; }
  const recordNativeOutput = () => Object.assign(native, { childError, durationMs: Date.now() - Date.parse(startedAt), timedOut, overflow, stdoutBytes, stderrBytes,
    stdoutSha256: hash(Buffer.concat(stdout)), stderrSha256: hash(Buffer.concat(stderr)), stderr: redact(Buffer.concat(stderr).toString('utf8')),
    supervisorCloseObserved, terminationAttempts });
  let exit: { code: number | null; signal: string | null };
  try { exit = await exitRequest; }
  catch (error) {
    recordNativeOutput(); native.cleanup = 'unconfirmed'; native.status = 'failed'; native.failure = redact(String(error));
    try { await save(); } catch { /* The original process/cleanup error remains the failure. */ }
    throw error;
  }
  recordNativeOutput(); Object.assign(native, { exit });
  if (saveFailure) throw saveFailure;
  const out = Buffer.concat(stdout); const err = Buffer.concat(stderr);
  recordNativeOutput(); Object.assign(native, { exit, stderr: redact(err.toString('utf8')) }); await save();
  let parsed: any; try { parsed = JSON.parse(out.toString('utf8').trim()); } catch { parsed = null; }
  native.child = parsed;
  const observed: BoundaryHostObservation[] = [];
  for (const target of targets) {
    const markerPresent = await present(target.marker); const databasePresent = await present(target.database);
    const auxiliaryPresent = [];
    for (const suffix of ['-journal', '-wal', '-shm']) if (await present(target.database + suffix)) auxiliaryPresent.push(suffix);
    const observation = { kind: target.kind, markerPresent, markerMatches: markerPresent && await readFile(target.marker, 'utf8') === nonce,
      databasePresent, sqliteHeader: databasePresent && (await readFile(target.database)).subarray(0, 16).toString('binary') === 'SQLite format 3\0',
      auxiliaryPresent, hostPositiveControl: true, cleanupComplete: false };
    observed.push(observation);
    // Delete only the nonce-specific regular files after recording any forbidden creation.
    for (const filename of [target.marker, target.database, ...auxiliaryPresent.map(suffix => target.database + suffix)]) if (await present(filename)) await unlink(filename);
    observation.cleanupComplete = !(await present(target.marker)) && !(await present(target.database));
    for (const suffix of ['-journal', '-wal', '-shm']) if (await present(target.database + suffix)) observation.cleanupComplete = false;
  }
  native.independent = observed; await save();
  assert.equal(timedOut, false); assert.equal(overflow, false); assert.equal(exit.code, 0, native.stderr); assert.equal(exit.signal, null);
  assert.equal(parsed?.schemaVersion, 1); assert.equal(parsed?.nonce, nonce); assert.equal(parsed?.nodeVersion, process.versions.node);
  assert.ok(Number.isSafeInteger(parsed.pid) && parsed.pid > 0);
  assertBoundaryObservations(targets, parsed.observations, observed);
  native.status = 'passed'; native.cleanup = 'confirmed-owned-files-and-supervisor-close'; native.completedAt = new Date().toISOString(); return native;
}

await main();
