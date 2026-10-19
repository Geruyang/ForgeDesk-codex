import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FZ3B_PROFILE, FZ3B_HOST_KEY_SHA256, fz3bDigest, fz3bProfileSha256 } from '../../packages/engineering-runner/fz3b/profile';
import { FZ3B_TOOLS, type Fz3bRunView, type Fz3bSemanticFixture } from '../../packages/engineering-runner/fz3b/types';
import { FZ3B_INSTALLED_SCOPE, assertFz3bCloseSafe, assertFz3bCompletion, assertFz3bNoReplay, assertFz3bPolicy, fz3bPlanScope, verifyFz3bArtifacts, type Fz3bInstalledPlan } from './fz3b-installed';
import { deterministicPsPackage } from '../../packages/engineering-runner/fz3b/package';
import { assertFz3bNativeReceipt, installFz3bNativeObserver, readFz3bNativeObserver, restoreFz3bNativeObserver } from './fz3b-native-observer';

const sha = (letter: string) => letter.repeat(64);
const fixture: Fz3bSemanticFixture = { id: 'fz3b-pillow-scene-v1', manifestSha256: FZ3B_PROFILE.semanticManifestSha256, queriesSha256: FZ3B_PROFILE.queriesSha256,
  imageSha256: FZ3B_PROFILE.imageSha256, predeclaredSha256: FZ3B_PROFILE.predeclaredSha256, width: 914, height: 512, queryCount: 4,
  embeddingDimensions: 512, expectedLabel: 'pillow', queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'], encoderIdentity: structuredClone(FZ3B_PROFILE.encoderIdentity) };
function completed(): Fz3bRunView {
  const run: Fz3bRunView = { schemaVersion: 1, runId: 'controller-fz3b', taskId: 'task-fz3b', sessionId: 'session-fz3b', threadId: 'thread-fz3b', turnId: 'turn-fz3b', generation: 1,
    model: 'gpt-6.1-sol', profileId: FZ3B_PROFILE.id, profileSha256: fz3bProfileSha256(fixture), status: 'completed', phase: 'completed', active: false, hardwareBusy: false,
    stopRequested: false, nativeApproval: 'approved', createdAt: '2026-10-16T06:00:00.000Z', updatedAt: '2026-10-16T06:00:10.000Z', operations: [], calls: [] };
  run.operations = (['build', 'inspect', 'semantic'] as const).map((kind, index) => ({ id: `${index + 1}0000000-0000-4000-8000-000000000000`, kind,
    requestKey: `fz3b-${fz3bDigest(`${run.runId}:fz3b_${kind}`)}`, nonce: sha(String(index + 1)), evidenceSha256: sha(String(index + 4)), status: 'succeeded',
    dispatchPhase: 'may-have-started', processExited: true, remoteQuiescent: true, createdAt: '2026-10-16T06:00:03.000Z', updatedAt: '2026-10-16T06:00:05.000Z' }));
  const body = { kind: 'fixed-ps-fixture-package' as const, buildId: run.operations[0].id, profileSha256: run.profileSha256,
    sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256, fixtureManifestSha256: fixture.manifestSha256, queriesSha256: fixture.queriesSha256,
    imageSha256: fixture.imageSha256, buildEvidenceSha256: run.operations[0].evidenceSha256!, packageSha256: sha('c'), packageManifestSha256: sha('d'), newPlBuilt: false as const, deployed: false as const };
  run.artifact = { id: fz3bDigest(JSON.stringify(body)), ...body };
  run.identity = { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot, platform: 'A0005',
    contractId: FZ3B_PROFILE.encoderIdentity.contractId, deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256, existingPlSha256: FZ3B_PROFILE.existingPlSha256,
    transport: 'pinned-ssh', helloAuthenticated: false };
  const preview = { id: 'grant-fz3b', runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, artifactId: run.artifact.id,
    profileSha256: run.profileSha256, identity: structuredClone(run.identity), fixture: structuredClone(fixture),
    scope: 'existing-candidate008-real-text-single-image-once' as const, actions: [...FZ3B_PROFILE.actions], createdAt: '2026-10-16T06:00:01.000Z', expiresAt: '2026-10-16T06:05:01.000Z' };
  run.grant = { ...preview, planSha256: fz3bDigest(JSON.stringify(preview)), approvedAt: '2026-10-16T06:00:02.000Z', consumedBy: run.operations[2].id };
  run.semantic = { jobId: `fd-semantic-${run.operations[2].id.replaceAll('-', '')}`, frameId: 0, queryRevision: 3, completedFrames: 1,
    fixtureManifestSha256: fixture.manifestSha256, queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256,
    encoderIdentity: structuredClone(fixture.encoderIdentity), ranking: fixture.queryIds.map((id, index) => ({ id, label: id, score: .19 - index * .01 })),
    bestId: 'pillow', semanticInput: 'real-text-encoder', synthetic: false, classificationUnknown: true, threshold: .2, thresholdHit: false,
    expectedLabel: 'pillow', expectedLabelMatched: true, inferenceStopped: true, newPlLoaded: false };
  run.export = { path: '/fixture-only/export', sha256: sha('e') };
  run.calls = FZ3B_TOOLS.map((tool, index) => {
    const operation = run.operations.find(op => tool === `fz3b_${op.kind}`), callId = `actual-${index}`;
    return { callId, tool, receivedAt: '2026-10-16T06:00:01.000Z', completedAt: '2026-10-16T06:00:06.000Z', status: 'succeeded', operationId: operation?.id,
      result: { runId: run.runId, callId, tool, ok: true, result: tool === 'fz3b_status' ? 'status' : 'succeeded', phase: 'completed',
        operation: operation ? structuredClone(operation) : undefined, semantic: tool === 'fz3b_semantic' ? structuredClone(run.semantic) : undefined,
        export: tool === 'fz3b_export' ? structuredClone(run.export) : undefined } };
  });
  return run;
}
function plan(root: string): Fz3bInstalledPlan {
  const resourceHashes = Object.fromEntries(['app.asar', 'codex/codex.exe', 'codex/codex-code-mode-host.exe', 'codex/codex-command-runner.exe',
    'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe', 'fz3b/manifest.json', 'fz3b/fixture/host-fixture.json', 'fz3b/remote/remote.py', 'fz3b/remote/wire.py'].map(name => [`resources/${name}`, sha('a')]));
  return { schemaVersion: 1, scope: FZ3B_INSTALLED_SCOPE, runId: 'fz3b-installed-1792132000000-abcdef', version: '0.5.0', runtimeCommit: 'a'.repeat(40),
    projectRoot: path.join(root, 'output/hardware/fz3b-fixed-project'), nativeOperator: 'coordinator-delegated-visible-ui', model: 'gpt-6.1-sol',
    installedExe: path.join(root, 'install/ForgeDesk.exe'), installerPath: path.join(root, 'release/ForgeDesk-0.5.0-x64-setup.exe'), dataDir: path.join(root, '.runtime/app'),
    resourceHashes, executableSha256: sha('a'), installerSha256: sha('b'), fixture: structuredClone(fixture), profileSha256: fz3bProfileSha256(fixture), preparedAt: '2026-10-16T06:00:00.000Z' };
}

test('FZ3B positive fixture accepts real-text first-rank match while preserving classification unknown', () => {
  const run = completed(); assertFz3bCompletion(run, fixture); assert.equal(run.semantic!.classificationUnknown, true); assert.equal(run.semantic!.thresholdHit, false);
});
test('manual/synthetic, missing/model-switched/reordered/replayed tool chains and bad grants are rejected', () => {
  const cases: Array<(run: Fz3bRunView) => void> = [
    run => { run.model = 'manual'; }, run => { run.calls = []; }, run => { run.calls.reverse(); }, run => { run.calls[2].callId = run.calls[1].callId; },
    run => { run.calls[3].status = 'replayed'; }, run => { run.calls[4].result!.ok = false; }, run => { run.nativeApproval = 'cancelled'; },
    run => { run.grant!.consumedBy = 'other-operation'; }, run => { run.grant!.planSha256 = sha('f'); }, run => { run.grant!.approvedAt = '2026-10-16T06:06:00.000Z'; },
    run => { run.identity!.bootId = 'wrong'; }, run => { run.artifact!.deployed = true as false; }, run => { run.operations[2].nonce = run.operations[1].nonce; },
    run => { run.operations[2].status = 'unknown'; }, run => { run.semantic!.synthetic = true as false; }, run => { run.semantic!.semanticInput = 'synthetic' as any; },
    run => { run.semantic!.expectedLabelMatched = false; }, run => { run.semantic!.thresholdHit = true; }, run => { run.semantic!.ranking[0].score = NaN; },
  ];
  for (const mutate of cases) { const run = completed(); mutate(run); assert.throws(() => assertFz3bCompletion(run, fixture)); }
});
test('unknown operations, active planner and remote-not-quiescent cannot be normal-close proof', () => {
  const run = completed(); assertFz3bCloseSafe(run, 'stopped');
  for (const status of ['prepared', 'running', 'unknown'] as const) { const bad = completed(); bad.operations[2].status = status; assert.throws(() => assertFz3bCloseSafe(bad, 'stopped')); }
  assert.throws(() => assertFz3bCloseSafe(run, 'ready')); assert.throws(() => assertFz3bCloseSafe(run, 'stopped', run.runId));
  const bad = completed(); bad.hardwareBusy = true; assert.throws(() => assertFz3bCloseSafe(bad, 'stopped'));
  const notRemote = completed(); notRemote.operations[2].remoteQuiescent = false; assert.throws(() => assertFz3bCloseSafe(notRemote, 'stopped'));
});
test('restart compares JSON persistence without ignoring arbitrary progress, calls or approval changes', () => {
  const before = completed(), after = JSON.parse(JSON.stringify(before)); assertFz3bNoReplay(before, after);
  for (const mutate of [(run: Fz3bRunView) => { run.calls[0].status = 'replayed'; }, (run: Fz3bRunView) => { run.nativeApproval = 'expired'; },
    (run: Fz3bRunView) => { (run.artifact as any).progress = 1; }]) { const bad = structuredClone(after); mutate(bad); assert.throws(() => assertFz3bNoReplay(before, bad)); }
});
test('scope accepts only fixed installed primary home and rejects overrides/manual scope/traversal', () => {
  const root = path.resolve('offline-fixture-root'), good = plan(root); fz3bPlanScope(root, good, {});
  for (const mutate of [(value: any) => { value.scope = 'real-model-fixed-target-installed-T2'; }, (value: any) => { value.dataDir = path.join(root, '.runtime/copied-auth'); },
    (value: any) => { value.installedExe = path.join(root, 'dist/ForgeDesk.exe'); }, (value: any) => { value.resourceHashes['resources/../private'] = sha('a'); },
    (value: any) => { delete value.resourceHashes['resources/fz3b/remote/remote.py']; }, (value: any) => { value.projectRoot = value.dataDir; }]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => fz3bPlanScope(root, bad, {}));
  }
  for (const env of [{ CODEX_HOME: 'copied' }, { FORGEDESK_FZ3B_NATIVE_RESPONSE: 'yes' }, { ELECTRON_RUN_AS_NODE: '1' }]) assert.throws(() => fz3bPlanScope(root, good, env));
});
test('effective policy must be actual isolated FZ3B tool inventory, never prior STM32 policy', () => {
  const policy = { schemaVersion: 1, profile: 'restricted-fz3b', model: 'gpt-6.1-sol', tools: [...FZ3B_TOOLS], environments: [], externalMcp: 'disabled', freshThreadOnly: true,
    executableSha256: sha('a'), protocolVersion: 'fixture', bundledCatalogSha256: sha('b'), catalogSha256: sha('c'), effectiveConfigSha256: sha('d') };
  assertFz3bPolicy(policy, sha('a')); assert.throws(() => assertFz3bPolicy({ ...policy, profile: 'restricted-hardware' }, sha('a')));
  assert.throws(() => assertFz3bPolicy({ ...policy, tools: [...policy.tools, 'shell'] }, sha('a'))); assert.throws(() => assertFz3bPolicy({ ...policy, externalMcp: 'enabled' }, sha('a')));
});
test('native observer transparently forwards actual answers and refuses restore while operator pending', async () => {
  const runId = 'fz3b-installed-1792132000000-abcdef'; let finish!: (value: any) => void, invoked = 0;
  const original = async (...args: any[]) => { invoked++; assert.equal(args[0].title, 'ForgeDesk Zynq 单图语义授权'); return new Promise(resolve => { finish = resolve; }); };
  const dialog: any = { showMessageBox: original }; installFz3bNativeObserver({ dialog }, { runId });
  try {
    const pending = dialog.showMessageBox({ type: 'warning', title: 'ForgeDesk Zynq 单图语义授权', message: 'fixture-only', buttons: ['取消', '授权本次固定测试'], checkboxChecked: false });
    assert.equal(invoked, 1); assert.equal(readFz3bNativeObserver({ dialog }, { runId }).calls[0].phase, 'started');
    assert.throws(() => restoreFz3bNativeObserver({ dialog }, { runId })); const answer = { response: 0, checkboxChecked: false }; finish(answer); assert.equal(await pending, answer);
    assert.equal(readFz3bNativeObserver({ dialog }, { runId }).calls[0].response, 0);
  } finally { restoreFz3bNativeObserver({ dialog }, { runId }); }
  assert.equal(dialog.showMessageBox, original);
});
test('native evidence requires both real fulfilled dialogs, checked approval and exact displayed pins', () => {
  const receipt: any = { runId: 'fixture', mechanism: 'fixture-only', calls: [
    { kind: 'close-warning', phase: 'fulfilled', startedAt: '2026-10-16T06:00:00Z', finishedAt: '2026-10-16T06:00:01Z', response: 0, options: { type: 'warning', message: '设备进程退出未确认，不能直接退出。请先复核设备操作状态。' } },
    { kind: 'approval', phase: 'fulfilled', startedAt: '2026-10-16T06:00:02Z', finishedAt: '2026-10-16T06:00:03Z', response: 1, checkboxChecked: true,
      options: { type: 'warning', title: 'ForgeDesk Zynq 单图语义授权', detail: 'target-hash fixture-hash', checkboxChecked: false, checkboxLabel: 'actual checkbox', buttons: ['取消', '授权本次固定测试'] } } ] };
  assertFz3bNativeReceipt(receipt, ['target-hash', 'fixture-hash']);
  for (const mutate of [(r: any) => { r.calls[1].checkboxChecked = false; }, (r: any) => { r.calls[1].phase = 'started'; }, (r: any) => { r.calls.pop(); },
    (r: any) => { r.calls[1].options.detail = 'other'; }, (r: any) => { r.calls[0].finishedAt = '2026-10-16T06:00:04Z'; }]) {
    const bad = structuredClone(receipt); mutate(bad); assert.throws(() => assertFz3bNativeReceipt(bad, ['target-hash']));
  }
});

test('offline file fixture verifies copied export, deterministic PS package and real-envelope parser; tampering fails closed', async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = path.join(repository, 'output/hardware/2026-10-16-next/product', `smoke-helper-fixture-${randomUUID()}`);
  const installedResources = path.join(directory, 'install/resources/fz3b'), source = path.join(repository, 'engineering/fz3b/product/resources');
  const resources = new Map<string, Buffer>();
  async function copy(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); if (entry.isDirectory()) { await copy(file); continue; }
      const relative = path.relative(source, file).split(path.sep).join('/'), bytes = await readFile(file);
      resources.set(relative, bytes); await mkdir(path.dirname(path.join(installedResources, relative)), { recursive: true }); await writeFile(path.join(installedResources, relative), bytes);
    }
  }
  await copy(source); const run = completed(), prepared = plan(directory);
  for (const [relative, bytes] of resources) prepared.resourceHashes[`resources/fz3b/${relative}`] = fz3bDigest(bytes);
  const built = deterministicPsPackage([...resources].filter(([name]) => name.startsWith('ps-src/') || name.startsWith('fixture/') || name.startsWith('licenses/')).map(([name, bytes]) => ({ path: name, bytes })));
  const receipts: Record<string, any> = {}, copied: Array<{ path: string; bytes: number; sha256: string }> = [];
  const dataDir = path.join(directory, 'data'), exportRoot = path.join(dataDir, 'exports/fz3b-agent', run.runId);
  for (const operation of run.operations) {
    const context = { schemaVersion: 1, operationId: operation.id, nonce: operation.nonce, profileSha256: run.profileSha256 };
    let evidence: any;
    const common = { ...context, kind: operation.kind, status: 'succeeded', processExited: true, remoteQuiescent: true, remoteOutcomeUnknown: false };
    if (operation.kind === 'build') {
      evidence = { ...context, action: 'build', resourceManifestSha256: prepared.resourceHashes['resources/fz3b/manifest.json'], kind: 'fixed-ps-fixture-package',
        packageSha256: fz3bDigest(built.archive), packageManifestSha256: fz3bDigest(built.manifest), bytes: built.archive.length, newPlBuilt: false, deployed: false };
      receipts[operation.id] = { ...common, sourceManifestSha256: run.artifact!.sourceManifestSha256, fixtureManifestSha256: fixture.manifestSha256,
        queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256, packageSha256: evidence.packageSha256, packageManifestSha256: evidence.packageManifestSha256, newPlBuilt: false, deployed: false };
    } else {
      const { hostKeySha256: _host, transport: _transport, helloAuthenticated: _hello, ...identity } = run.identity!;
      const remote = { ...context, status: 'succeeded', remoteQuiescent: true, remoteOutcomeUnknown: false, identity,
        ...(operation.kind === 'inspect' ? { readOnly: true } : { grantId: run.grant!.id, semantic: run.semantic }) };
      evidence = { ...context, action: operation.kind, resourceManifestSha256: prepared.resourceHashes['resources/fz3b/manifest.json'],
        transport: { processExited: true, exitCode: 0, timedOut: false, stderr: '' }, remoteStdout: JSON.stringify(remote) + '\n', remote,
        authenticatedTransport: 'pinned-ssh', helloAuthenticated: false };
      receipts[operation.id] = { ...common, identity: run.identity,
        ...(operation.kind === 'inspect' ? { readOnly: true } : { grantId: run.grant!.id, semantic: run.semantic }) };
    }
    const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n'); operation.evidenceSha256 = fz3bDigest(bytes); receipts[operation.id].evidenceSha256 = operation.evidenceSha256;
    const outputs = [['evidence.json', bytes], ...(operation.kind === 'build' ? [['ps-acceptance.tar', built.archive], ['package-manifest.json', built.manifest]] : [])] as Array<[string, Buffer]>;
    for (const [name, data] of outputs) {
      const relative = `workers/${operation.id}/${name}`; copied.push({ path: relative, bytes: data.length, sha256: fz3bDigest(data) });
      for (const file of [path.join(dataDir, 'fz3b-worker', operation.id, name), path.join(exportRoot, relative)]) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data); }
    }
  }
  run.artifact!.packageSha256 = fz3bDigest(built.archive); run.artifact!.packageManifestSha256 = fz3bDigest(built.manifest); run.artifact!.buildEvidenceSha256 = run.operations[0].evidenceSha256!;
  const { id: _artifact, ...body } = run.artifact!; run.artifact!.id = fz3bDigest(JSON.stringify(body)); run.grant!.artifactId = run.artifact!.id;
  const { planSha256: _plan, approvedAt: _approval, consumedBy: _consumed, ...preview } = run.grant!; run.grant!.planSha256 = fz3bDigest(JSON.stringify(preview));
  for (const call of run.calls) if (call.operationId) call.result!.operation = structuredClone(run.operations.find(operation => operation.id === call.operationId)!);
  const snapshot = structuredClone(run); snapshot.export = undefined; snapshot.status = 'active'; snapshot.active = true; snapshot.hardwareBusy = true; snapshot.phase = 'exporting'; snapshot.currentTool = 'fz3b_export';
  snapshot.calls[5].status = 'running'; snapshot.calls[5].completedAt = undefined; snapshot.calls[5].result = undefined;
  const manifest = { schemaVersion: 1, scope: FZ3B_PROFILE.id, exportKind: 'model-tool', profile: FZ3B_PROFILE, fixture, run: snapshot, receipts, files: copied };
  const manifestFile = path.join(exportRoot, 'manifest.json'), manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(manifestFile, manifestBytes); run.export = { path: exportRoot, sha256: fz3bDigest(manifestBytes) }; run.calls[5].result!.export = structuredClone(run.export);
  const accepted = await verifyFz3bArtifacts(dataDir, run, prepared); assert.equal(accepted.fileCount, 6); assert.equal(accepted.operationCount, 3); assert.equal(accepted.referencedFileCount, 11);
  const copyFile = path.join(exportRoot, copied[0].path), original = await readFile(copyFile); await writeFile(copyFile, Buffer.concat([original, Buffer.from('tamper')]));
  await assert.rejects(verifyFz3bArtifacts(dataDir, run, prepared)); await writeFile(copyFile, original);
  const originalFile = path.join(dataDir, 'fz3b-worker', run.operations[2].id, 'evidence.json'), old = await readFile(originalFile);
  await writeFile(originalFile, Buffer.concat([old, Buffer.from('tamper')])); await assert.rejects(verifyFz3bArtifacts(dataDir, run, prepared)); await writeFile(originalFile, old);
  await writeFile(path.join(exportRoot, 'unlisted.json'), '{}'); await assert.rejects(verifyFz3bArtifacts(dataDir, run, prepared));
});
