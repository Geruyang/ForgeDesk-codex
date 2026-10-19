import assert from 'node:assert/strict';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { mkdir, readFile, writeFile, readdir, unlink, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { EngineeringTask, Operation } from '../packages/engineering-runner';
import { redact } from '../packages/engineering-runner/redaction';
import { assertSecondUserAppClosed, assertSnapshotNodeVersion, prepareSnapshotScope } from './helpers/snapshot-smoke-scope';
import { snapshotSourceProvenance } from './helpers/snapshot-source-provenance';
import { assertOriginalSnapshotDefect, snapshotFailureDiagnostic } from './helpers/snapshot-failure-diagnostics';
import { prepareSnapshotInstalledLifecycle } from './helpers/snapshot-installed-lifecycle';
import { verifySnapshotInstalledRelease, snapshotReleaseVersion } from './helpers/snapshot-installed-release';
import { connectControlsStartup } from './helpers/second-user-controls';
import { plainPath } from './helpers/embedded-installed';
import { grantClockScope, grantClockSnapshotPins, prepareGrantClockOutput, snapshotGrantClockFlag, verifyGrantClockSnapshotRelease } from './helpers/snapshot-grant-clock-release';
import { fz3b051LaunchEnvironment } from './helpers/fz3b-051-installed';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = `snapshot-${Date.now()}`;
const grantClockRelease = snapshotGrantClockFlag(process.argv.slice(2));
const originalScope = await prepareSnapshotScope(root, process.env, runId);
const scope = grantClockRelease ? grantClockScope(originalScope) : originalScope;
const { installed, realModel, runtime, workspace, dataDir, output } = scope;
if (grantClockRelease) assertSnapshotNodeVersion(process.versions.node);
const grantClockEnvironment = grantClockRelease ? fz3b051LaunchEnvironment(process.env, dataDir) : undefined;
const execute = promisify(execFile);
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const active = (operation: Operation) => ['prepared', 'running', 'stopping'].includes(operation.status);
const within = (base: string, candidate: string) => { const value = path.relative(base, candidate); return value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value); };
const buggy = 'export function average(values) { return values.reduce((sum, value) => sum + value) / values.length; }\n';
const corrected = 'export function average(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }\n';
const secretFixture = `qa-input-must-not-be-exported-${runId}`;
const report: Record<string, any> = { runId, scope: `${installed ? 'Installed' : 'Development'} B snapshot`, realModel,
  userScope: scope.userScope, secondUser: scope.secondUser, desktopIdentity: scope.identity, dependencies: scope.dependencies,
  releaseBinding: grantClockRelease ? { profile: 'grant-clock-0.5.1', candidateSha256: grantClockSnapshotPins.candidate } : { profile: 'original-snapshot-candidate' },
  workspace, dataDir, startedAt: new Date().toISOString(), steps: [], failures: [], pageErrors: [] };
let app: ElectronApplication | undefined;
let page: Page | undefined;
let taskId: string | undefined;
const approvals = new Set<string>();
let installedLifecycle: Awaited<ReturnType<typeof prepareSnapshotInstalledLifecycle>> | undefined;

async function fileDigest(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }
function sanitized(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:token|secret|credential|password|authorization|api.?key)/i.test(key) ? '[REDACTED]' : sanitized(item)]));
  return value;
}
async function evidence() { await writeFile(path.join(output, 'evidence.json'), JSON.stringify(sanitized(report), null, 2)); }
async function snapshot(): Promise<AppSnapshot> { return page!.evaluate(() => window.forgeDesk.snapshot()); }
function task(state: AppSnapshot): EngineeringTask { const value = state.tasks.find(item => item.id === taskId); assert.ok(value); return value as unknown as EngineeringTask; }
async function capture(name: string) {
  await page!.evaluate(() => { const value = document.querySelector('.sidebar-footer strong'); if (value) value.textContent = 'QA account state'; });
  await page!.screenshot({ path: path.join(output, `${name}.png`) });
}
async function approveBuild(state: AppSnapshot) {
  for (const approval of state.approvals) {
    const key = `${approval.generation}:${typeof approval.id}:${approval.id}`; if (approvals.has(key)) continue;
    const params = approval.params as Record<string, any>; const args = params?._meta?.tool_params;
    const current = state.sessions.find(item => item.id === taskId); const profile = task(state).snapshotProfile;
    assert.equal(state.approvals.length, 1); assert.equal(approval.method, 'mcpServer/elicitation/request');
    assert.equal(params.serverName, 'engineering'); assert.equal(params.mode, 'form');
    assert.deepEqual(params.requestedSchema, { type: 'object', properties: {} });
    assert.equal(params._meta?.codex_approval_kind, 'mcp_tool_call');
    assert.equal(params.message, 'Allow the engineering MCP server to run tool "engineering.build"?');
    assert.equal(params.threadId, current?.threadId); assert.equal(params.turnId, current?.turnId);
    assert.deepEqual(Object.keys(args).sort(), ['taskId', 'profileRevision', 'requestKey'].sort());
    assert.equal(args.taskId, taskId); assert.equal(args.profileRevision, profile?.revision); assert.equal(typeof args.requestKey, 'string');
    assert.ok(approval.decisions.includes('accept')); approvals.add(key);
    report.approvalActions ??= []; report.approvalActions.push({ generation: approval.generation, id: approval.id,
      method: approval.method, decision: 'accept', via: 'renderer-button', taskId, profileRevision: args.profileRevision, requestKey: args.requestKey });
    await capture(`build-approval-${approvals.size}`);
    const card = page!.locator('.approval'); await card.waitFor({ state: 'visible' }); assert.equal(await card.count(), 1);
    await card.getByRole('button', { name: '允许本次', exact: true }).click();
  }
}
async function waitFor(predicate: (state: AppSnapshot) => boolean, timeout = 300000) {
  const deadline = Date.now() + timeout; let checkpoint = 0;
  while (Date.now() < deadline) {
    const state = await snapshot();
    if (realModel && state.approvals.length) await approveBuild(state);
    if (predicate(state)) return state;
    if (Date.now() >= checkpoint) { report.latestTask = taskId ? task(state) : undefined; await evidence(); checkpoint = Date.now() + 10000; }
    await pause(500);
  }
  throw new Error('Real snapshot GUI state wait timed out');
}
async function launch() {
  await assertSecondUserAppClosed(scope);
  if (installed && !scope.secondUser) {
    report.installedRelease = grantClockRelease ? await verifyGrantClockSnapshotRelease(root, installed) : await verifySnapshotInstalledRelease(root, installed);
    installedLifecycle ??= await prepareSnapshotInstalledLifecycle(root, installed);
    report.installedLifecycle = installedLifecycle.evidence;
    await plainPath(path.join(dataDir, 'desktop.json'));
    const saved = JSON.parse(await readFile(path.join(dataDir, 'desktop.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error; return '{"sessions":[]}';
    }));
    assert.ok(Array.isArray(saved.sessions));
    assert.equal(saved.sessions.some((session: { engineUncertain?: boolean; status: string; turnId?: string }) =>
      session.engineUncertain || ['running', 'stopping'].includes(session.status) || session.turnId), false,
    'Persisted active or uncertain sessions must not be implicitly recovered on startup');
    await installedLifecycle.beforeLaunch();
  }
  const environment = grantClockEnvironment ?? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete environment.ELECTRON_RUN_AS_NODE; environment.FORGEDESK_DATA_DIR = dataDir;
  app = await electron.launch({ executablePath: installed || path.join(root, 'node_modules/electron/dist/electron.exe'), args: installed ? [] : [root], cwd: root, env: environment });
  if (installedLifecycle) await installedLifecycle.attach(app);
  page = await app.firstWindow(); page.on('pageerror', error => report.pageErrors.push(redact(error.message)));
  await page.locator('.app-header').waitFor(); await page.setViewportSize({ width: 1380, height: 900 });
  const beforeConnect = await snapshot();
  if (installedLifecycle) {
    assert.equal(beforeConnect.approvals.length, 0, 'Existing approvals must be resolved outside this acceptance run');
    assert.equal(beforeConnect.sessions.some(session => session.engineUncertain || ['running', 'stopping'].includes(session.status) || session.turnId), false,
      'Existing uncertain or active model sessions must not be implicitly recovered by this acceptance run');
    assert.equal(beforeConnect.tasks.some(task => task.operations.some(operation => ['prepared', 'running', 'stopping', 'unknown'].includes(operation.status))), false,
      'Existing active or unknown software operations must not be bypassed');
  }
  if (installedLifecycle && beforeConnect.hardware.modeActive) {
    report.softwareModeTransition = { before: beforeConnect.hardware, via: 'public fz3bLeaveMode with original idle gates', status: 'requested' };
    await evidence();
    await page.evaluate(() => window.forgeDesk.fz3bLeaveMode());
    assert.equal((await snapshot()).hardware.modeActive, false);
    report.softwareModeTransition.status = 'passed';
  }
  await waitFor(state => ['ready', 'failed'].includes(state.engine.state));
  let initial: AppSnapshot;
  if (installedLifecycle) {
    report.startupConnections ??= [];
    initial = await connectControlsStartup({ snapshot, connect: () => page!.evaluate(() => window.forgeDesk.connect()), wait: pause,
      observe: async observation => { report.startupConnections.push({ ...observation, observedAt: new Date().toISOString() }); await evidence(); } });
  } else { await page.evaluate(() => window.forgeDesk.connect()); initial = await snapshot(); }
  assert.equal(initial.engine.state, 'ready'); assert.equal(initial.engine.home, path.join(dataDir, 'engine'));
  assert.equal(initial.account.loggedIn, realModel, 'Fixture data must be unauthenticated; real-model mode requires existing public login');
  if (installedLifecycle) {
    assert.equal(initial.version, snapshotReleaseVersion);
    assert.equal(initial.dataDir, dataDir);
    assert.equal(initial.engine.executable, path.join(path.dirname(installed!), 'resources/codex/codex.exe'));
  }
  return initial;
}
async function closeApp() {
  if (!app) return;
  if (installedLifecycle) await installedLifecycle.closeNormally();
  else await app.close();
  app = undefined; page = undefined;
}
async function walk(directory: string, base = directory): Promise<string[]> {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    const filename = path.join(directory, name); const stat = await lstat(filename); assert.equal(stat.isSymbolicLink(), false);
    if (stat.isDirectory()) files.push(...await walk(filename, base));
    else { assert.equal(stat.isFile(), true); files.push(path.relative(base, filename).replaceAll('\\', '/')); }
  }
  return files.sort();
}
async function verifySnapshot(operation: Operation) {
  const value = operation.snapshot; assert.ok(value); assert.equal(operation.evidenceLevel, 'B');
  const owned = path.join(dataDir, 'engineering/snapshots', taskId!, operation.id);
  assert.equal(value.inputRoot, path.join(owned, 'input')); assert.equal(value.outputRoot, path.join(owned, 'output'));
  assert.equal(value.manifestPath, path.join(owned, 'manifest.json')); assert.equal(await fileDigest(value.manifestPath), value.manifestDigest);
  const manifest = JSON.parse(await readFile(value.manifestPath, 'utf8'));
  assert.equal(manifest.id, operation.id); assert.equal(manifest.taskId, taskId); assert.deepEqual(manifest.excludedInputs, ['.git']);
  assert.equal(manifest.source.gitCommit, null); assert.equal(manifest.source.dirtyDiffDigest, null);
  assert.deepEqual(await walk(value.inputRoot), manifest.source.files.map((file: { path: string }) => file.path).sort());
  for (const file of manifest.source.files) assert.equal(await fileDigest(path.join(value.inputRoot, file.path)), file.sha256);
  assert.ok(manifest.source.files.some((file: { path: string }) => file.path === 'ignored.bin'));
  assert.ok(manifest.source.files.some((file: { path: string }) => file.path === '.cache/necessary-input.txt'));
  assert.ok(manifest.source.files.some((file: { path: string }) => file.path === 'package-lock.json'));
  assert.equal((await lstat(path.join(value.inputRoot, 'empty/nested'))).isDirectory(), true);
  const proof = JSON.parse(await readFile(value.isolation.probeLogRef, 'utf8'));
  assert.equal(await fileDigest(value.isolation.probeLogRef), value.isolation.probeLogSha256);
  assert.equal(proof.method, 'engine-sandbox-write-denial'); assert.equal(proof.writeDenied, true); assert.equal(proof.workspaceWritten, true);
  assert.equal(proof.cleanupComplete, true); assert.equal(proof.originalSha256, proof.protectedAfterSha256);
  assert.equal(value.sandboxProbe?.sqliteInputWriteDenied, true); assert.equal(value.sandboxProbe?.inputWriteDenied, true);
  assert.equal(value.sandboxProbe?.outputWriteAllowed, true); assert.equal(value.permissionProbe?.build.passed, true);
  assert.equal(value.permissionProbe?.verify.passed, true);
  if (!scope.secondUser) {
    assert.ok(value.executionPolicies);
    assert.equal(value.executionPolicies?.length, 5, 'Current source requires an actual-cwd policy proof for every stage');
    assert.ok(value.executionPolicies.every(policy => policy.status === 'verified' && policy.before?.generation === policy.after?.generation));
  }
  return { manifestDigest: value.manifestDigest, copiedFiles: manifest.source.files.length, isolation: value.isolation, proof,
    sandboxProbe: value.sandboxProbe, permissionProbe: value.permissionProbe, verificationResult: value.verificationResult };
}
async function guiBuild() {
  const count = task(await snapshot()).operations.length;
  await page!.getByRole('button', { name: '快照构建', exact: true }).click();
  await waitFor(state => task(state).operations.length === count + 1 && !task(state).operations.some(active) && task(state).status !== 'running');
  const deadline = Date.now() + 30000;
  while (!await page!.getByRole('button', { name: '快照构建', exact: true }).isEnabled()) {
    if (Date.now() >= deadline) throw new Error('Snapshot handler did not release its GUI gate after terminal task persistence');
    await pause(100);
  }
  return task(await snapshot());
}
async function viewports(name: string) {
  for (const size of [{ width: 1380, height: 900 }, { width: 800, height: 600 }]) {
    await page!.setViewportSize(size); await pause(150);
    assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.equal(await page!.locator('.brand img').evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0)), true);
    await capture(`${name}-${size.width}x${size.height}`);
  }
  await page!.setViewportSize({ width: 1380, height: 900 });
}

if (grantClockRelease) await prepareGrantClockOutput(scope);
else await mkdir(output, { recursive: true });
try {
  assert.ok(!realModel || installed, 'Real-model B acceptance requires the installed executable, not development');
  await mkdir(path.join(workspace, '.cache'), { recursive: true }); await mkdir(path.join(workspace, 'empty/nested'), { recursive: true });
  await writeFile(path.join(workspace, 'numbers.mjs'), buggy); await writeFile(path.join(workspace, '.gitignore'), 'ignored.bin\n.cache/\n');
  await writeFile(path.join(workspace, 'ignored.bin'), Buffer.from([0, 255, 1, 0])); await writeFile(path.join(workspace, '.cache/necessary-input.txt'), 'required ignored input\n');
  await writeFile(path.join(workspace, 'package-lock.json'), '{"lockfileVersion":3}\n'); await writeFile(path.join(workspace, 'local-settings.secret'), secretFixture);
  await execute('git', ['init', workspace], { windowsHide: true, shell: false, ...(grantClockEnvironment ? { env: grantClockEnvironment } : {}) });
  await execute('git', ['-C', workspace, 'add', 'numbers.mjs', '.gitignore'], { windowsHide: true, shell: false, ...(grantClockEnvironment ? { env: grantClockEnvironment } : {}) });
  await execute('git', ['-C', workspace, '-c', 'user.name=ForgeDesk QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'B snapshot QA defective baseline'], { windowsHide: true, shell: false, ...(grantClockEnvironment ? { env: grantClockEnvironment } : {}) });
  const initial = await launch();
  report.initial = { appVersion: initial.version, engine: initial.engine, publicLoggedIn: initial.account.loggedIn, hardwareEnabled: initial.hardware.enabled };
  report.testScriptSha256 = await fileDigest(fileURLToPath(import.meta.url));
  Object.assign(report, await snapshotSourceProvenance(root, scope.secondUser));
  if (installed) {
    report.installedAsarSha256 = await fileDigest(path.join(path.dirname(installed), 'resources/app.asar'));
    report.installerSha256 = grantClockRelease ? report.installedRelease.installer.sha256 : await fileDigest(path.join(root, `release/ForgeDesk-${initial.version}-x64-setup.exe`));
    if (grantClockRelease) {
      report.grantClockHarnessHashes = {};
      for (const file of ['tests/helpers/snapshot-grant-clock-release.ts', 'tests/helpers/fz3b-051-installed.ts',
        'tests/helpers/snapshot-installed-lifecycle.ts', 'tests/helpers/snapshot-installed-release.ts', 'tests/helpers/snapshot-smoke-scope.ts']) report.grantClockHarnessHashes[file] = await fileDigest(path.join(root, file));
      report.environmentScope = 'Existing case-insensitive Windows launch allowlist preserves host ProgramData; excludes authentication, SSH-agent/proxy, Node hooks and ambient Git routing. Git global/system configuration is disabled for this fixture.';
    }
  }
  else report.distMainSha256 = await fileDigest(path.join(root, 'dist/main/index.cjs'));
  console.log(JSON.stringify({ scope: report.scope, publicLoggedIn: initial.account.loggedIn, runId }));
  await app!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, workspace);
  const project = await page!.evaluate(() => window.forgeDesk.importProject()); assert.ok(project);
  await pause(150); await page!.getByTitle(workspace, { exact: true }).and(page!.getByRole('button')).click();
  const session = await page!.evaluate(id => window.forgeDesk.createSession(id, 'B snapshot QA'), project.id); taskId = session.id;
  await pause(150); await page!.getByRole('button', { name: /B snapshot QA/ }).click();
  await page!.getByRole('tab', { name: '工程交付', exact: true }).click();
  await app!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, process.execPath);
  await page!.getByRole('button', { name: '启用快照模板', exact: true }).click();
  const enabled = task(await waitFor(state => !!task(state).snapshotProfile && task(state).acceptance.some(item => item.id === 'snapshot-software'))); report.profile = enabled.snapshotProfile;
  assert.equal(enabled.snapshotProfile?.id, 'forgedesk.node-software.v1'); assert.equal(enabled.acceptance.length, 1);
  assert.equal(enabled.acceptance[0].id, 'snapshot-software');
  assert.equal(await page!.getByRole('button', { name: /运行验证：Snapshot:/ }).isDisabled(), true);
  await assert.rejects(page!.evaluate(id => window.forgeDesk.setAcceptance(id, [{ id: 'snapshot-software', title: 'forged', kind: 'manual' }]), taskId), /snapshot|fixed|模板/i);
  assert.equal(task(await snapshot()).acceptance[0].kind, 'automated');
  report.steps.push('Actual GUI enabled fixed B profile only after real engine/config policy and native write-denial probe'); await evidence();
  console.log('SNAPSHOT_PROFILE_ENABLED'); await viewports('profile');

  let passed: EngineeringTask;
  if (realModel) {
    const originalFiles = (await walk(workspace)).filter(filename => !filename.startsWith('.git/'));
    const unchangedFiles = await Promise.all(originalFiles.filter(filename => filename !== 'numbers.mjs').map(async filename => ({ filename, sha256: await fileDigest(path.join(workspace, filename)) })));
    const model = initial.models[0]?.id; assert.ok(model); report.chosenModel = model;
    const prompt = `Fix average(values) in numbers.mjs: empty arrays return 0; preserve positive and signed means. Modify only numbers.mjs. Do not read product/authentication files or change template, profile, acceptance, or protected snapshots. Use engineering.build with taskId=${taskId}, profileRevision=${enabled.snapshotProfile!.revision} and a unique requestKey to check the original defect, then repair source and invoke engineering.build again with a NEW requestKey. The configured fixed template builds and verifies all three checks from B snapshots. Do not substitute engineering.test or manual claims for this authoritative runner evidence. End with a concise actual result.`;
    report.prompt = prompt; await page!.evaluate(({ id, prompt, model }) => window.forgeDesk.send(id, prompt, model), { id: taskId, prompt, model });
    const terminal = await waitFor(state => ['completed', 'failed', 'interrupted', 'needs_attention'].includes(state.sessions.find(item => item.id === taskId)?.status || ''));
    report.modelSession = terminal.sessions.find(item => item.id === taskId); assert.equal(report.modelSession.status, 'completed');
    assert.notEqual(await readFile(path.join(workspace, 'numbers.mjs'), 'utf8'), buggy);
    assert.deepEqual((await walk(workspace)).filter(filename => !filename.startsWith('.git/')), originalFiles);
    for (const file of unchangedFiles) assert.equal(await fileDigest(path.join(workspace, file.filename)), file.sha256);
    report.modelSourceScope = { changedOnly: 'numbers.mjs', unchangedFileCount: unchangedFiles.length, noAddedOrRemovedFiles: true };
    passed = task(terminal); assert.ok(passed.operations.length >= 2); assertOriginalSnapshotDefect(passed.operations[0]);
    assert.notEqual(passed.operations[0].requestKey, passed.operations.at(-1)!.requestKey, 'Original and repaired model builds require different request keys');
    report.originalModelOperation = passed.operations[0]; report.modelOperationIds = passed.operations.map(operation => operation.id);
    report.originalSnapshot = await verifySnapshot(passed.operations[0]);
    assert.ok(report.approvalActions.length >= 2);
    for (const operation of passed.operations) {
      assert.equal(report.approvalActions.filter((action: { requestKey: string }) => action.requestKey === operation.requestKey).length, 1,
        'Every model build requires exactly one matched renderer approval');
    }
    assert.equal(report.approvalActions.length, passed.operations.length, 'No unmatched accepted model build');
    const modelBuildItems = report.modelSession.messages.filter((message: { role: string }) => message.role === 'tool')
      .flatMap((message: { text: string }) => { try { return [JSON.parse(message.text)]; } catch { return []; } })
      .filter((item: { type?: string; server?: string; tool?: string }) => item.type === 'mcpToolCall' && item.server === 'engineering' && item.tool === 'engineering.build');
    assert.equal(modelBuildItems.length, passed.operations.length, 'Every model build requires its actual MCP tool item');
    for (const operation of passed.operations) {
      const items = modelBuildItems.filter((item: { arguments?: { requestKey?: string } }) => item.arguments?.requestKey === operation.requestKey);
      assert.equal(items.length, 1); assert.equal(items[0].arguments.taskId, taskId);
      assert.equal(items[0].arguments.profileRevision, enabled.snapshotProfile!.revision);
    }
    report.modelBuildItems = modelBuildItems;
    const diff = await page!.evaluate(id => window.forgeDesk.diff(id), project.id); assert.ok(diff.text.includes('numbers.mjs') && diff.text.includes('+')); report.diff = diff;
  } else {
    const failed = await guiBuild(); assert.equal(failed.status, 'failed'); assertOriginalSnapshotDefect(failed.operations[0]);
    report.originalFailed = failed; report.originalSnapshot = await verifySnapshot(failed.operations[0]);
    await writeFile(path.join(workspace, 'numbers.mjs'), corrected); report.manualFixtureCorrection = true;
    passed = await guiBuild();
  }
  assert.equal(passed.status, 'passed'); assert.equal(passed.acceptance[0].status, 'passed');
  assert.equal(passed.evidence.at(-1)?.evidenceLevel, 'B'); assert.equal(passed.evidence.at(-1)?.result, 'passed');
  report.passedTask = passed; report.passedSnapshot = await verifySnapshot(passed.operations.at(-1)!);
  const checkedEvidence = passed.evidence.at(-1)!;
  assert.ok(checkedEvidence.artifacts.length);
  for (const artifact of checkedEvidence.artifacts) {
    assert.ok(within(passed.operations.at(-1)!.snapshot!.outputRoot, artifact.path));
    assert.equal(await fileDigest(artifact.path), artifact.sha256);
    assert.equal((await lstat(artifact.path)).size, artifact.bytes);
  }
  assert.deepEqual(passed.operations.at(-1)!.snapshot!.verifierReceipt?.checks, ['empty', 'nonempty', 'signed']);
  assert.equal(passed.operations.at(-1)!.snapshot!.verifierReceipt?.passed, true);
  assert.equal(passed.operations.at(-1)!.snapshot!.verifierReceipt?.sha256, checkedEvidence.artifacts[0].sha256);
  report.independentlyCheckedArtifacts = checkedEvidence.artifacts;
  const snapshotInput = passed.operations.at(-1)!.snapshot!.inputRoot;
  assert.equal(await readFile(path.join(snapshotInput, 'numbers.mjs'), 'utf8'), await readFile(path.join(workspace, 'numbers.mjs'), 'utf8'));
  assert.equal(await readFile(path.join(passed.operations[0].snapshot!.inputRoot, 'numbers.mjs'), 'utf8'), buggy);
  assert.notEqual(passed.operations[0].snapshot!.inputRoot, snapshotInput);
  await viewports('passed'); console.log('SNAPSHOT_B_PASSED');
  await app!.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, output);
  const exported = await page!.evaluate(id => window.forgeDesk.exportTask(id), taskId); assert.ok(exported); assert.ok(within(output, exported));
  const exportedText = await readFile(path.join(exported, 'manifest.json'), 'utf8'); const manifest = JSON.parse(exportedText);
  assert.equal(manifest.evidenceLevel, 'B'); assert.deepEqual(manifest.evidenceLevels, ['B']); assert.equal(manifest.task.status, 'passed');
  assert.equal(exportedText.includes(secretFixture), false); assert.deepEqual((await readdir(exported)).sort(), ['logs', 'manifest.json']);
  assert.equal(manifest.logs.length, passed.operations.length);
  for (const log of manifest.logs) { assert.ok(within(exported, path.join(exported, log.file))); assert.equal(await fileDigest(path.join(exported, log.file)), log.sha256); assert.equal((await readFile(path.join(exported, log.file), 'utf8')).includes(secretFixture), false); }
  report.export = { directory: exported, manifestSha256: digest(exportedText), evidenceLevel: manifest.evidenceLevel, containsRawInput: false, hashCheckedLogCount: manifest.logs.length };

  const operationIds = passed.operations.map(operation => operation.id); const retryKey = passed.operations.at(-1)!.requestKey;
  await closeApp(); await launch();
  const restarted = task(await snapshot());
  if (scope.secondUser) assert.equal(restarted.status, 'passed');
  else {
    assert.notEqual(restarted.status, 'passed');
    assert.equal(restarted.acceptance[0].status, 'stale');
    assert.equal(restarted.evidence.at(-1)?.snapshot?.verificationResult, 'passed');
  }
  assert.deepEqual(restarted.operations.map(operation => operation.id), operationIds);
  const probesBefore = (await readdir(path.join(dataDir, 'engineering/isolation-probes'))).sort();
  await page!.evaluate(({ id, key }) => window.forgeDesk.runSnapshotBuild(id, key), { id: taskId, key: retryKey });
  assert.deepEqual(task(await snapshot()).operations.map(operation => operation.id), operationIds);
  assert.deepEqual((await readdir(path.join(dataDir, 'engineering/isolation-probes'))).sort(), probesBefore);
  report.restart = { persistedPassed: restarted.status === 'passed', currentStatus: restarted.status,
    historicalVerification: restarted.evidence.at(-1)?.snapshot?.verificationResult,
    originalOperationIds: operationIds, durableRetryDidNotProbeOrExecute: true };
  await viewports('restarted');
  if (!scope.secondUser) {
    const revalidated = await guiBuild(); assert.equal(revalidated.status, 'passed');
    report.restart.explicitNewBuildPassed = true;
    await verifySnapshot(revalidated.operations.at(-1)!);
  }
  const changed = path.join(workspace, 'external-input.bin'); await writeFile(changed, Buffer.from([9, 8, 7]));
  await page!.getByRole('button', { name: '核对证据', exact: true }).click();
  const stale = task(await waitFor(state => task(state).acceptance[0].status === 'stale'));
  assert.notEqual(stale.status, 'passed'); assert.equal(stale.evidence.at(-1)?.snapshot?.verificationResult, 'passed');
  assert.equal(await readFile(path.join(snapshotInput, 'numbers.mjs'), 'utf8'), await readFile(path.join(workspace, 'numbers.mjs'), 'utf8'));
  report.workspaceStale = { currentStatus: stale.status, acceptanceStatus: stale.acceptance[0].status, historicalSnapshotResult: stale.evidence.at(-1)?.snapshot?.verificationResult };
  await capture('workspace-stale'); await unlink(changed);
  const clean = await guiBuild(); assert.equal(clean.status, 'passed');
  const artifact = clean.evidence.at(-1)!.artifacts[0].path; assert.ok(within(clean.operations.at(-1)!.snapshot!.outputRoot, artifact));
  await writeFile(artifact, (await readFile(artifact, 'utf8')) + '\n// QA external artifact change\n');
  await page!.getByRole('button', { name: '核对证据', exact: true }).click();
  const tampered = task(await waitFor(state => task(state).acceptance[0].status === 'stale')); assert.notEqual(tampered.status, 'passed');
  report.outputStale = { currentStatus: tampered.status, acceptanceStatus: tampered.acceptance[0].status }; await capture('output-stale');
  if (realModel) { const final = await guiBuild(); assert.equal(final.status, 'passed'); report.finalTask = final; await viewports('final-passed'); }
  report.steps.push('B copied ignored/untracked/binary/lock/empty-directory inputs; unique operation input copies with checked manifests and separate artifacts verified; export, restart dedup and source/artifact invalidation passed');
  assert.deepEqual(report.pageErrors, []); report.result = 'passed';
} catch (error) {
  report.result = 'failed'; report.failures.push(redact(error instanceof Error ? error.stack || error.message : String(error))); process.exitCode = 1;
  if (page) try {
    report.latestTask = taskId ? task(await snapshot()) : undefined;
    report.operationFailures = [];
    for (const operation of (report.latestTask?.operations ?? []).filter((operation: Operation) => operation.status === 'failed' || operation.status === 'unknown').slice(-12)) {
      let publicLog: string | undefined; let logReadError: string | undefined;
      try { publicLog = await page.evaluate(({ id, operationId }) => window.forgeDesk.readOperationLog(id, operationId), { id: taskId!, operationId: operation.id }); }
      catch (error) { logReadError = redact(String(error)); }
      report.operationFailures.push({ ...snapshotFailureDiagnostic(operation, publicLog), logReadError });
    }
    await capture('failure');
  } catch {}
  await evidence();
} finally {
  if (app) {
    try {
      if (report.result === 'failed' && taskId && page) {
        const state = await snapshot();
        for (const operation of task(state).operations.filter(active)) await page.evaluate(({ id, operationId }) => window.forgeDesk.cancelOperation(id, operationId), { id: taskId, operationId: operation.id });
        const session = state.sessions.find(item => item.id === taskId);
        if (session?.turnId && ['running', 'stopping'].includes(session.status)) await page.evaluate(id => window.forgeDesk.interrupt(id), taskId);
        await waitFor(state => !task(state).operations.some(active) && task(state).status !== 'running', 60000);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (installedLifecycle) await closeApp();
        else await Promise.race([closeApp(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Graceful QA app close exceeded 30 seconds')), 30000); })]);
      }
      finally { if (timer) clearTimeout(timer); }
      report.cleanup = { normalClose: true, forcedFixtureCleanup: false };
    } catch (error) {
      report.result = 'failed'; report.failures.push(redact(String(error))); process.exitCode = 1;
      if (installedLifecycle) report.cleanup = { normalClose: false, forcedFixtureCleanup: false, ...await installedLifecycle.protectOnFailure() };
      if (!installed && !realModel) {
        const child = app.process(); const expected = path.join(root, 'node_modules/electron/dist/electron.exe');
        assert.equal(path.resolve(child.spawnfile).toLowerCase(), path.resolve(expected).toLowerCase());
        if (child.exitCode === null && child.signalCode === null) child.kill();
        report.cleanup = { normalClose: false, forcedFixtureCleanup: true, ownedPid: child.pid, executable: expected };
      }
    }
  }
  if (!app && report.result === 'failed' && installedLifecycle && !report.cleanup) {
    report.cleanup = { normalClose: false, forcedFixtureCleanup: false, ...await installedLifecycle.protectOnFailure() };
  }
  if (installedLifecycle) report.installedLifecycle = installedLifecycle.evidence;
  report.finishedAt = new Date().toISOString(); await evidence();
  console.log(JSON.stringify({ result: report.result, scope: report.scope, realModel, steps: report.steps, failures: report.failures, evidence: path.join(output, 'evidence.json') }, null, 2));
  if (report.cleanup?.safeHarnessExit === false) {
    console.error('Unknown launcher exit hook: harness retained for operator action, no forced application close');
    setInterval(() => {}, 60000);
    await new Promise<never>(() => {});
  }
}
