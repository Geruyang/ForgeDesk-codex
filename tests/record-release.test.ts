import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const { collectInstalledHardware, parseReleaseArguments, pendingT2Evidence, readT2Evidence, validateT2Evidence,
  readHardwareAgentEvidence, validateHardwareAgentEvidence, validateHardwareAgentContinuation, recordRelease } = await import(new URL('../scripts/record-release.mjs', import.meta.url).href);
const commit = 'a'.repeat(40);
const hash = 'b'.repeat(64);
const controls = ['build', 'inspect', 'flash', 'verify', 'export', 'restartDedup', 'modeGate', 'concurrentTask', 'duringFlashClose'];
const expected = { version: '0.3.0', runtimeSourceCommit: commit, installerSha256: hash, resourceHashes: { 'resources/hardware-worker.py': hash } };
function evidence(): any {
  return { schemaVersion: 1, runId: 't2-1792000000000-abcd', scope: 'user-driven-fixed-target-installed-T2', result: 'passed',
    runtimeCommit: commit, realModel: false, secondUser: false, release: { version: '0.3.0', suppliedRuntimeCommit: commit, installerSha256: hash,
      resourceHashes: { 'resources/hardware-worker.py': hash } }, failures: [], pageErrors: [],
    controls: { ...Object.fromEntries(controls.map(control => [control, 'passed'])), tamper: 'not-requested' } };
}
async function fixture(t: test.TestContext) {
  const base = path.resolve('tests/.tmp'); await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'record-release-'));
  t.after(async () => { assert.ok(root.startsWith(base + path.sep)); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function file(root: string, relative: string, contents: string) {
  const filename = path.join(root, relative); await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, contents); return filename;
}

test('release arguments retain runtime-source and reject missing, duplicate or unknown options', () => {
  assert.deepEqual(parseReleaseArguments([]), { runtimeRef: 'HEAD', t2Evidence: undefined });
  assert.deepEqual(parseReleaseArguments(['--t2-evidence', 'output/t2/run/evidence.json', '--runtime-source', commit]), { runtimeRef: commit, t2Evidence: 'output/t2/run/evidence.json' });
  for (const args of [['--runtime-source'], ['--runtime-source', 'main'], ['--runtime-source', commit, '--runtime-source', commit], ['--t2-evidence', '--runtime-source'], ['--unknown', 'x']]) assert.throws(() => parseReleaseArguments(args));
});

test('release acceptance without explicit evidence remains pending and makes no full-matrix claim', () => {
  const value = pendingT2Evidence();
  assert.equal(value.result, 'pending'); assert.equal(value.evidence, null); assert.equal(value.scope, 'user-driven-fixed-target-installed-T2');
  assert.ok(value.limitations.includes('Not autonomous-model acceptance')); assert.ok(value.limitations.includes('Not a complete physical fault-injection matrix'));
});

test('T2 release acceptance validates the exact current controls and projects no raw evidence fields', () => {
  const value = evidence(); value.privateUnrelatedField = 'must-not-project';
  const accepted = validateT2Evidence(value, expected);
  assert.equal(accepted.result, 'passed'); assert.equal(accepted.realModel, false); assert.equal(accepted.secondUser, false);
  assert.equal(JSON.stringify(accepted).includes('must-not-project'), false);
  value.controls.tamper = 'passed'; assert.equal(validateT2Evidence(value, expected).result, 'passed');
});

test('T2 rejects every missing or unpassed required control, including the final harness additions', () => {
  for (const control of controls) for (const status of [undefined, 'pending', 'failed', 'unknown', 'not-requested']) {
    const value = evidence(); value.controls[control] = status;
    assert.throws(() => validateT2Evidence(value, expected), /Required T2 control did not pass/);
  }
  const value = evidence(); value.controls.additional = 'not-requested'; assert.throws(() => validateT2Evidence(value, expected), /T2 control did not pass/);
});

test('T2 rejects failed, broader, wrong-version, wrong-commit, cleanup and artifact-mismatch evidence', () => {
  const changes: Array<(value: any) => void> = [value => { value.result = 'failed'; }, value => { value.scope = 'full-matrix'; },
    value => { value.release.version = '0.2.1'; }, value => { value.version = '0.2.1'; }, value => { value.runtimeCommit = 'c'.repeat(40); },
    value => { value.release.suppliedRuntimeCommit = 'c'.repeat(40); }, value => { value.realModel = true; }, value => { value.secondUser = true; },
    value => { value.failures = ['failure']; }, value => { value.pageErrors = ['failure']; }, value => { value.needsHumanClose = true; },
    value => { value.release.installerSha256 = 'c'.repeat(64); }, value => { value.release.resourceHashes['resources/hardware-worker.py'] = 'c'.repeat(64); },
    value => { value.release = undefined; }, value => { value.controls = []; }];
  for (const change of changes) { const value = evidence(); change(value); assert.throws(() => validateT2Evidence(value, expected)); }
});

test('T2 evidence path is confined before reading and its digest binds the parsed bytes', async t => {
  const root = await fixture(t); const value = evidence();
  const relative = `output/t2/${value.runId}/evidence.json`; const contents = JSON.stringify(value);
  await file(root, relative, contents);
  const result = await readT2Evidence(relative, expected, root);
  assert.equal(result.evidence.file, relative); assert.equal(result.evidence.bytes, Buffer.byteLength(contents));
  assert.equal(result.evidence.sha256, createHash('sha256').update(contents).digest('hex'));
  for (const wrong of ['.runtime/auth.json', 'output/hardware/evidence.json', '../evidence.json', 'output/t2/not-a-reviewed-run/evidence.json']) {
    await assert.rejects(readT2Evidence(wrong, expected, root), /repository output\/t2/);
  }
  value.runId = 't2-1792000000001-abcd'; await file(root, relative, JSON.stringify(value));
  await assert.rejects(readT2Evidence(relative, expected, root), /run ID mismatch/);
});

test('installed hardware artifacts retain file records and recursively include overlay manifest plus four sources', async t => {
  const root = await fixture(t);
  const overlay = 'install/resources/templates/gesturescreen-v1';
  const names = ['App/Inc/forgedesk_build_id.h', 'BSP/Src/gs_usb_capture.c', 'Modules/UsbCapture/Inc/gs_usb_protocol.h', 'Modules/UsbCapture/Src/gs_usb_protocol.c'];
  await file(root, 'install/resources/hardware/manifest.json', '{}');
  await file(root, 'install/resources/hardware/python/python.exe', 'fake portable runtime fixture');
  await file(root, 'install/resources/hardware-worker.py', '# fixture only');
  await file(root, `${overlay}/overlay-manifest.json`, '{}');
  for (const name of names) await file(root, `${overlay}/${name}`, `fixture ${name}`);
  const result = await collectInstalledHardware(root);
  assert.equal(result.artifacts.length, 5); assert.equal(result.overlayManifest.file, `${overlay}/overlay-manifest.json`);
  assert.equal(result.worker.file, 'install/resources/hardware-worker.py');
  assert.deepEqual(result.artifacts.map((item: any) => item.file).sort(), [...names.map(name => `${overlay}/${name}`), `${overlay}/overlay-manifest.json`].sort());
  for (const item of [result.manifest, result.pythonExecutable, result.worker, ...result.artifacts]) {
    const bytes = await readFile(path.join(root, item.file)); assert.equal(item.bytes, bytes.length); assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});

const modelControls = ['publicLogin', 'policy', 'modelCalls', 'build', 'inspect', 'nativeAuthorization', 'flash', 'verify', 'export', 'restartNoReplay', 'normalClose'];
const modelTools = ['embedded_status', 'embedded_build', 'embedded_inspect', 'embedded_request_flash', 'embedded_verify', 'embedded_export'];
const modelExpected = { ...expected, version: '0.4.0', resourceHashes: { ...expected.resourceHashes, 'resources/codex/codex.exe': hash } };
function modelEvidence(): any {
  const stamp = '2026-10-15T01:00:00Z';
  const operations = ['build', 'inspect', 'flash', 'verify'].map(kind => ({ id: `${kind}-op`, requestKey: `${kind}-key`, kind,
    status: 'succeeded', processExited: true, artifactId: 'build-op', createdAt: stamp, updatedAt: stamp }));
  const artifact = { id: 'build-op', buildId: hash, hexSha256: hash, axfSha256: hash, sourceSha256: hash, profileSha256: hash };
  const exported = { path: 'fixture-export/evidence.json', sha256: hash };
  const run: any = { schemaVersion: 1, runId: 'actual-controller-run', sessionId: 'session', taskId: 'task', model: 'gpt-6.1-sol',
    generation: 1, threadId: 'thread', turnId: 'turn', status: 'completed', phase: 'completed', active: false, hardwareBusy: false,
    stopRequested: false, nativeApproval: 'approved', createdAt: stamp, updatedAt: stamp, artifact, export: exported, calls: [] };
  run.calls = modelTools.map((tool, index) => {
    const operation = operations[index - 1];
    return { callId: `actual-${index}`, tool, receivedAt: stamp, completedAt: stamp, status: 'succeeded',
      ...(operation ? { operationId: operation.id, requestKey: operation.requestKey } : {}),
      result: { callId: `actual-${index}`, runId: run.runId, tool, ok: true, result: index ? 'succeeded' : 'status',
        ...(operation ? { operation } : tool === 'embedded_export' ? { export: exported } : {}) } };
  });
  const hardware = { configured: true, taskId: run.taskId, profileId: 'gesturescreen-challenger-v1', profileSha256: hash, operations, artifact,
    grant: { scope: 'flash-and-verify-once', taskId: run.taskId, artifactId: artifact.id, consumedBy: 'flash-op', profileId: 'gesturescreen-challenger-v1',
      buildId: hash, hexSha256: hash, axfSha256: hash, sourceSha256: hash, profileSha256: hash, backupSha256: hash, approvedAt: stamp,
      expiresAt: '2026-10-15T01:05:00Z', identity: { probeSerial: '594AC1D7613FED24', uid: '0037001b3133510432383236', chipId: 0x419, flashKiB: 1024, cdcSerial: '326F32513133' } } };
  return { schemaVersion: 1, runId: 'hardware-agent-1792000000000-abcdef', scope: 'real-model-fixed-target-installed-T2', result: 'passed',
    model: 'gpt-6.1-sol', runtimeCommit: commit, realModel: true, secondUser: false, publicAccount: { loggedIn: true },
    release: { version: '0.4.0', suppliedRuntimeCommit: commit, installerSha256: hash, executableSha256: hash, resourceHashes: { ...modelExpected.resourceHashes } },
    failures: [], pageErrors: [], controls: Object.fromEntries(modelControls.map(name => [name, 'passed'])),
    nativeConfirmation: { automatedResponse: true, synthesizedDialogResponse: false, mechanism: 'Fixture only, no native UI executed' },
    policy: { schemaVersion: 1, profile: 'restricted-hardware', model: 'gpt-6.1-sol', tools: [...modelTools], environments: [], externalMcp: 'disabled',
      freshThreadOnly: true, executableSha256: hash, protocolVersion: 'fixture', bundledCatalogSha256: hash, catalogSha256: hash, effectiveConfigSha256: hash },
    run, hardware, callAssociations: run.calls.map((call: any) => ({ runId: run.runId, sessionId: run.sessionId, taskId: run.taskId,
      generation: run.generation, threadId: run.threadId, turnId: run.turnId, callId: call.callId, tool: call.tool,
      ...(call.requestKey ? { requestKey: call.requestKey, operationId: call.operationId } : {}) })),
    export: { ...exported, fileCount: 1, operationCount: 4, files: [{ path: 'fixture', bytes: 1, sha256: hash }] },
    restart: { before: structuredClone(run), after: structuredClone(run), hardwareBefore: structuredClone(hardware), hardwareAfter: structuredClone(hardware) },
    launches: [{ electronMain: { pid: 1234, type: 'browser', execPath: 'fixture/install/ForgeDesk.exe' } },
      { electronMain: { pid: 5678, type: 'browser', execPath: 'fixture/install/ForgeDesk.exe' } }],
    closes: [{ normalClose: true, installedGuiAbsent: true }, { normalClose: true, installedGuiAbsent: true }] };
}

test('real-model release option is explicit and cannot be combined with manual evidence', () => {
  assert.deepEqual(parseReleaseArguments(['--hardware-agent-evidence', 'model.json', '--runtime-source', commit]),
    { runtimeRef: commit, t2Evidence: undefined, hardwareAgentEvidence: 'model.json' });
  for (const args of [['--hardware-agent-evidence'], ['--hardware-agent-evidence', 'a', '--hardware-agent-evidence', 'b'],
    ['--t2-evidence', 'manual', '--hardware-agent-evidence', 'model']]) assert.throws(() => parseReleaseArguments(args));
});

test('real-model acceptance is independent and projects only reviewed model/scope/runtime fields', () => {
  const value = modelEvidence(); value.privateAccountLabel = 'must-not-project';
  const result = validateHardwareAgentEvidence(value, modelExpected);
  assert.equal(result.scope, 'real-model-fixed-target-installed-T2'); assert.equal(result.model, 'gpt-6.1-sol');
  assert.equal(result.runtimeSourceCommit, commit); assert.equal(result.realModel, true);
  assert.equal(JSON.stringify(result).includes('must-not-project'), false);
  assert.throws(() => validateT2Evidence(value, modelExpected), /T2 scope/);
  assert.throws(() => validateHardwareAgentEvidence(evidence(), expected), /scope/);
  const relabeled = evidence(); relabeled.scope = value.scope; relabeled.realModel = true; relabeled.model = value.model;
  assert.throws(() => validateHardwareAgentEvidence(relabeled, modelExpected));
});

test('real-model acceptance rejects every missing or failed model-specific control', () => {
  for (const control of modelControls) for (const status of [undefined, 'pending', 'failed', 'unknown', 'not-requested']) {
    const value = modelEvidence(); value.controls[control] = status;
    assert.throws(() => validateHardwareAgentEvidence(value, modelExpected));
  }
});

test('real-model evidence rejects missing calls, mismatched associations, approval, worker and restart claims', () => {
  const mutations: Array<(value: any) => void> = [
    x => { x.result = 'failed'; }, x => { x.realModel = false; }, x => { x.model = 'other'; }, x => { x.run.model = 'other'; },
    x => { x.publicAccount.loggedIn = false; }, x => { x.secondUser = true; }, x => { x.failures.push('failure'); },
    x => { x.pageErrors.push('failure'); }, x => { x.needsHumanClose = true; }, x => { x.cleanupError = 'blocked'; },
    x => { x.runtimeCommit = 'c'.repeat(40); }, x => { x.release.suppliedRuntimeCommit = 'c'.repeat(40); },
    x => { x.release.version = '0.3.4'; }, x => { x.release.installerSha256 = 'c'.repeat(64); },
    x => { x.policy.tools.push('shell'); }, x => { x.policy.externalMcp = 'enabled'; }, x => { x.policy.environments.push('workspace'); },
    x => { x.policy.freshThreadOnly = false; }, x => { x.policy.executableSha256 = 'c'.repeat(64); },
    x => { x.nativeConfirmation.synthesizedDialogResponse = true; }, x => { x.run.calls = []; },
    x => { x.run.calls.reverse(); }, x => { x.run.calls[1].callId = x.run.calls[0].callId; },
    x => { x.run.calls[2].status = 'replayed'; }, x => { x.run.calls[2].result.ok = false; },
    x => { x.run.calls[2].result.callId = 'foreign'; }, x => { x.run.calls[2].operationId = 'foreign'; },
    x => { x.callAssociations.pop(); }, x => { x.callAssociations[2].turnId = 'foreign'; },
    x => { x.callAssociations[2].requestKey = 'foreign'; }, x => { x.run.nativeApproval = 'pending'; },
    x => { x.run.status = 'active'; }, x => { x.run.hardwareBusy = true; }, x => { x.run.stopRequested = true; },
    x => { x.hardware.operations.pop(); }, x => { x.hardware.operations[2].status = 'unknown'; },
    x => { x.hardware.operations[2].processExited = false; }, x => { x.hardware.grant.consumedBy = 'foreign'; },
    x => { x.hardware.grant.identity.uid = 'f'.repeat(24); }, x => { x.hardware.grant.approvedAt = '2026-10-15T01:06:00Z'; },
    x => { x.export.operationCount = 3; }, x => { x.export.sha256 = 'c'.repeat(64); }, x => { x.export.files = []; },
    x => { x.restart.after.calls.push(x.restart.after.calls[0]); }, x => { x.restart.hardwareAfter.operations[2].id = 'replayed'; },
    x => { x.restart.hardwareAfter.artifact.buildId = 'c'.repeat(64); }, x => { x.closes[1].normalClose = false; },
    x => { x.launches = []; }, x => { x.launches[1].electronMain.type = 'renderer'; },
    x => { x.run.calls[3].receivedAt = '2026-10-14T00:00:00Z'; },
  ];
  for (const mutate of mutations) { const value = modelEvidence(); mutate(value); assert.throws(() => validateHardwareAgentEvidence(value, modelExpected)); }
});

test('real-model evidence uses its own confined path and digest; manual paths remain rejected', async t => {
  const root = await fixture(t), value = modelEvidence();
  const relative = `output/hardware-agent/${value.runId}/evidence.json`, contents = JSON.stringify(value);
  await file(root, relative, contents);
  const accepted = await readHardwareAgentEvidence(relative, modelExpected, root);
  assert.equal(accepted.evidence.sha256, createHash('sha256').update(contents).digest('hex'));
  assert.equal(accepted.evidence.bytes, Buffer.byteLength(contents));
  for (const wrong of ['output/t2/t2-1792000000000-abcd/evidence.json', '.runtime/app/auth.json', '../evidence.json', 'output/hardware-agent/invalid/evidence.json'])
    await assert.rejects(readHardwareAgentEvidence(wrong, modelExpected, root), /output\/hardware-agent/);
  await assert.rejects(readT2Evidence(relative, modelExpected, root), /output\/t2/);
  value.runId = 'hardware-agent-1792000000001-abcdef'; await file(root, relative, JSON.stringify(value));
  await assert.rejects(readHardwareAgentEvidence(relative, modelExpected, root), /run ID mismatch/);
});

test('recording real-model fixture writes a separate manifest without replacing historical manual files', async t => {
  const root = await fixture(t), contents = 'offline fixture only', digest = createHash('sha256').update(contents).digest('hex');
  const resources = ['app.asar', 'hardware/manifest.json', 'hardware/python/python.exe', 'hardware-worker.py',
    'templates/gesturescreen-v1/overlay-manifest.json', 'codex/codex.exe', 'codex/codex-code-mode-host.exe',
    'codex/codex-command-runner.exe', 'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe'];
  await file(root, 'package.json', JSON.stringify({ version: '0.4.0' }));
  for (const filename of ['release/ForgeDesk-0.4.0-x64-setup.exe', 'release/ForgeDesk-source-hardware-agent-0.4.0.zip', 'install/ForgeDesk.exe', 'package-lock.json',
    'install/resources/templates/node-software-v1/main.mjs', ...resources.map(name => `install/resources/${name}`)]) await file(root, filename, contents);
  for (const name of ['vendor/codex/manifest.json', 'vendor/process-host/manifest.json']) await file(root, name, '{}');
  await file(root, 'release/manifest.json', 'historical manual manifest'); await file(root, 'release/SHA256SUMS.txt', 'historical manual sums');
  await file(root, 'release/ForgeDesk-source.zip', 'historical manual source archive');
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).trim();
  git(['init', '--quiet']); git(['add', 'package.json']);
  git(['-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture only']);
  const runtimeCommit = git(['rev-parse', 'HEAD']), value = modelEvidence();
  value.runtimeCommit = runtimeCommit; value.release.suppliedRuntimeCommit = runtimeCommit;
  value.release.installerSha256 = digest; value.release.executableSha256 = digest;
  value.release.resourceHashes = Object.fromEntries(resources.map(name => [`resources/${name}`, digest]));
  value.policy.executableSha256 = digest;
  for (const launch of value.launches) launch.electronMain.execPath = path.join(root, 'install/ForgeDesk.exe');
  const relative = `output/hardware-agent/${value.runId}/evidence.json`; await file(root, relative, JSON.stringify(value));
  const manifest = await recordRelease(['--runtime-source', runtimeCommit, '--hardware-agent-evidence', relative], root);
  assert.equal(manifest.scope, 'real-model-fixed-target-installed-T2'); assert.equal(manifest.model, 'gpt-6.1-sol');
  assert.equal(manifest.runtimeSourceCommit, runtimeCommit); assert.equal(manifest.acceptanceEvidence.T2.realModel, true);
  assert.equal(manifest.source.file, 'release/ForgeDesk-source-hardware-agent-0.4.0.zip'); assert.equal(manifest.source.sha256, digest);
  assert.equal(await readFile(path.join(root, 'release/manifest.json'), 'utf8'), 'historical manual manifest');
  assert.equal(await readFile(path.join(root, 'release/SHA256SUMS.txt'), 'utf8'), 'historical manual sums');
  assert.equal(await readFile(path.join(root, 'release/ForgeDesk-source.zip'), 'utf8'), 'historical manual source archive');
  assert.equal(await readFile(path.join(root, 'release/SHA256SUMS-hardware-agent.txt'), 'utf8'),
    `${digest}  ForgeDesk-0.4.0-x64-setup.exe\n${digest}  ForgeDesk-source-hardware-agent-0.4.0.zip\n`);
  assert.equal(JSON.parse(await readFile(path.join(root, 'release/manifest-hardware-agent.json'), 'utf8')).scope, manifest.scope);
});

const knownSerializationFailure = 'AssertionError [ERR_ASSERTION]: Restart must not resume or fabricate controller calls\n+ actual - expected\n... Skipped lines\n'
  + '-         artifact: undefined,\n-         message: undefined,\n-           detail: undefined,\n-           progress: undefined,\n';

function continuationFixture(expired = false): { source: any; continued: any } {
  const source = modelEvidence(); source.result = 'failed'; source.failures = [knownSerializationFailure];
  source.controls.restartNoReplay = source.controls.normalClose = 'pending';
  source.failureRun = structuredClone(source.run); source.failureHardware = structuredClone(source.hardware); delete source.restart;
  const continued = structuredClone(source); continued.result = 'passed'; continued.failures = [];
  continued.controls.restartNoReplay = continued.controls.normalClose = 'passed';
  continued.continuationId = 'readonly-continuation-1792000100000';
  continued.sourceExecutionEvidence = { path: `output/hardware-agent/${source.runId}/evidence.json`, sha256: hash,
    result: 'failed', originalFailures: [...source.failures] };
  continued.readOnlyCheck = { modelTurnsSubmitted: 0, hardwareActionsSubmitted: 0, connectedExplicitly: false,
    roundTrips: [0, 1].map(index => {
      const observedAt = `2026-10-15T01:0${expired ? 6 : 1}:${index}0Z`, run = structuredClone(source.run);
      if (expired) run.nativeApproval = 'expired';
      return { observedAt, run, hardware: structuredClone(source.hardware), session: { id: run.sessionId, taskId: run.taskId, status: 'completed' },
        engineState: 'stopped', launchIndex: index, closeIndex: index, normalClose: true,
        ...(expired ? { derivedApprovalExpiry: { from: 'approved', to: 'expired', expiresAt: source.hardware.grant.expiresAt, observedAt } } : {}) };
    }) };
  continued.restart = { before: structuredClone(source.run), after: structuredClone(continued.readOnlyCheck.roundTrips[1].run),
    hardwareBefore: structuredClone(source.hardware), hardwareAfter: structuredClone(continued.readOnlyCheck.roundTrips[1].hardware) };
  return { source, continued };
}

test('read-only continuation preserves original failure and accepts only read-back state with no replay', () => {
  const { source, continued } = continuationFixture(); const original = JSON.stringify(source);
  const result = validateHardwareAgentContinuation(continued, source, modelExpected);
  assert.equal(result.result, 'passed'); assert.equal(result.sourceExecutionEvidence.result, 'failed');
  assert.equal(result.acceptanceMethod, 'original-execution-plus-readonly-continuation');
  assert.deepEqual(result.sourceExecutionEvidence.originalFailures, [knownSerializationFailure]);
  assert.equal(result.readOnlyCheck.roundTrips, 2); assert.equal(result.readOnlyCheck.hardwareActionsSubmitted, 0);
  assert.equal(JSON.stringify(source), original);
});

test('read-only continuation retains actual expired approval and normalizes only a temporary comparison view', () => {
  const { source, continued } = continuationFixture(true);
  continued.readOnlyCheck.roundTrips[0].hardware.operations[0].progress = { sequence: 99 };
  continued.readOnlyCheck.roundTrips[0].run.calls[1].result.operation.progress = { sequence: 100 };
  const result = validateHardwareAgentContinuation(continued, source, modelExpected);
  assert.equal(result.readOnlyCheck.derivedApprovalExpiries.length, 2);
  assert.equal(continued.readOnlyCheck.roundTrips[0].run.nativeApproval, 'expired');
  assert.equal(continued.restart.after.nativeApproval, 'expired'); assert.equal(source.run.nativeApproval, 'approved');
});

test('continuation ignores only the two defined operation telemetry paths, never other progress fields', () => {
  const changes: Array<(source: any, value: any) => void> = [
    (_, value) => { value.run.progress = { changed: true }; },
    (_, value) => { value.run.artifact.progress = { changed: true }; },
    (_, value) => { value.run.calls[0].progress = { changed: true }; },
    (_, value) => { value.run.calls[0].result.progress = { changed: true }; },
    (_, value) => { value.run.calls[1].result.operation.nested = { progress: { changed: true } }; },
    (_, value) => { value.hardware.progress = { changed: true }; },
    (_, value) => { value.hardware.artifact.progress = { changed: true }; },
    (_, value) => { value.hardware.grant.progress = { changed: true }; },
    (_, value) => { value.hardware.operations[0].nested = { progress: { changed: true } }; },
    (_, value) => { value.policy.progress = { changed: true }; },
    (_, value) => { value.release.progress = { changed: true }; },
    (_, value) => { value.readOnlyCheck.roundTrips[0].run.artifact.progress = { changed: true }; },
    (_, value) => { value.readOnlyCheck.roundTrips[0].run.calls[1].result.progress = { changed: true }; },
    (_, value) => { value.readOnlyCheck.roundTrips[0].hardware.artifact.progress = { changed: true }; },
    source => { source.failureRun.progress = { changed: true }; },
    source => { source.failureRun.artifact.progress = { changed: true }; },
    source => { source.failureHardware.grant.progress = { changed: true }; },
  ];
  for (const mutate of changes) {
    const f = continuationFixture(true); mutate(f.source, f.continued);
    assert.throws(() => validateHardwareAgentContinuation(f.continued, f.source, modelExpected));
  }
});

test('continuation rejects unrelated failures, changed source facts and relabeled successful sources', () => {
  const changes: Array<(source: any, value: any) => void> = [
    source => { source.result = 'passed'; }, source => { source.failures = []; }, source => { source.failures.push('another error'); },
    source => { source.failures[0] = 'AssertionError: another error'; },
    source => { source.failures[0] = knownSerializationFailure.replace('message: undefined', 'message: null'); },
    source => { source.failures[0] = knownSerializationFailure.replace('progress: undefined', 'nativeApproval: undefined'); },
    source => { source.failureRun.calls[0].result.phase = 'flashing'; }, source => { source.failureHardware.operations[0].requestKey = 'foreign'; },
    source => { source.pageErrors.push('error'); }, source => { source.controls.build = 'pending'; },
    (_, value) => { value.sourceExecutionEvidence.result = 'passed'; }, (_, value) => { value.sourceExecutionEvidence.originalFailures = []; },
    (_, value) => { value.run.calls[0].callId = 'foreign'; }, (_, value) => { value.hardware.grant.consumedBy = 'foreign'; },
    (_, value) => { value.policy.catalogSha256 = 'c'.repeat(64); }, (_, value) => { value.release.installerSha256 = 'c'.repeat(64); },
    (_, value) => { value.nativeConfirmation.mechanism = 'forged'; }, (_, value) => { value.callAssociations[0].threadId = 'foreign'; },
  ];
  for (const mutate of changes) { const f = continuationFixture(); mutate(f.source, f.continued); assert.throws(() => validateHardwareAgentContinuation(f.continued, f.source, modelExpected)); }
});

test('continuation rejects submitted turns/actions, changed round-trip state and incomplete GUI checks', () => {
  const changes: Array<(value: any) => void> = [
    x => { x.readOnlyCheck.modelTurnsSubmitted = 1; }, x => { x.readOnlyCheck.hardwareActionsSubmitted = 1; },
    x => { x.readOnlyCheck.connectedExplicitly = true; }, x => { x.readOnlyCheck.roundTrips.pop(); },
    x => { x.readOnlyCheck.roundTrips[0].run.calls.push(x.run.calls[0]); },
    x => { x.readOnlyCheck.roundTrips[0].hardware.operations[2].requestKey = 'replayed'; },
    x => { x.readOnlyCheck.roundTrips[0].hardware.grant.consumedBy = 'new-flash'; },
    x => { x.readOnlyCheck.roundTrips[0].engineState = 'running'; }, x => { x.readOnlyCheck.roundTrips[0].activeRunId = 'new'; },
    x => { x.readOnlyCheck.roundTrips[0].session.turnId = x.run.turnId; }, x => { x.readOnlyCheck.roundTrips[0].session.status = 'running'; },
    x => { x.readOnlyCheck.roundTrips[1].closeIndex = 0; }, x => { x.readOnlyCheck.roundTrips[1].normalClose = false; },
    x => { x.restart.after.calls.push(x.run.calls[0]); }, x => { x.closes[1].normalClose = false; },
  ];
  for (const mutate of changes) { const f = continuationFixture(); mutate(f.continued); assert.throws(() => validateHardwareAgentContinuation(f.continued, f.source, modelExpected)); }
});

test('continuation expiry exception rejects early dates, wrong metadata and every other state change', () => {
  const changes: Array<(value: any) => void> = [
    x => { const trip = x.readOnlyCheck.roundTrips[0]; trip.observedAt = trip.derivedApprovalExpiry.observedAt = '2026-10-15T01:01:00Z'; },
    x => { x.readOnlyCheck.roundTrips[0].derivedApprovalExpiry.expiresAt = '2026-10-15T01:04:00Z'; },
    x => { x.readOnlyCheck.roundTrips[0].derivedApprovalExpiry.observedAt = '2026-10-15T01:08:00Z'; },
    x => { x.readOnlyCheck.roundTrips[0].observedAt = 'not-a-date'; },
    x => { delete x.readOnlyCheck.roundTrips[0].derivedApprovalExpiry; },
    x => { x.readOnlyCheck.roundTrips[0].derivedApprovalExpiry.from = 'pending'; },
    x => { x.readOnlyCheck.roundTrips[0].run.phase = 'ready'; },
    x => { x.readOnlyCheck.roundTrips[0].run.calls[3].result.phase = 'expired'; },
    x => { x.readOnlyCheck.roundTrips[0].hardware.grant.approvedAt = '2026-10-15T01:03:00Z'; },
  ];
  for (const mutate of changes) { const f = continuationFixture(true); mutate(f.continued); assert.throws(() => validateHardwareAgentContinuation(f.continued, f.source, modelExpected)); }
});

test('continuation reader binds the unchanged failed execution bytes and rejects wrong paths or hashes', async t => {
  const root = await fixture(t), f = continuationFixture(true), original = JSON.stringify(f.source);
  const sourcePath = f.continued.sourceExecutionEvidence.path;
  await file(root, sourcePath, original);
  f.continued.sourceExecutionEvidence.sha256 = createHash('sha256').update(original).digest('hex');
  const relative = `output/hardware-agent/${f.source.runId}/${f.continued.continuationId}/evidence.json`;
  await file(root, relative, JSON.stringify(f.continued));
  const result = await readHardwareAgentEvidence(relative, modelExpected, root);
  assert.equal(result.sourceExecutionEvidence.sha256, f.continued.sourceExecutionEvidence.sha256);
  assert.equal(await readFile(path.join(root, sourcePath), 'utf8'), original);
  for (const patch of [{ continuationId: 'readonly-continuation-1792000100001' },
    { sourceExecutionEvidence: { ...f.continued.sourceExecutionEvidence, path: '../evidence.json' } },
    { sourceExecutionEvidence: { ...f.continued.sourceExecutionEvidence, sha256: 'c'.repeat(64) } }]) {
    await file(root, relative, JSON.stringify({ ...f.continued, ...patch }));
    await assert.rejects(readHardwareAgentEvidence(relative, modelExpected, root));
  }
  await file(root, relative, JSON.stringify(f.continued)); await file(root, sourcePath, original + '\n');
  await assert.rejects(readHardwareAgentEvidence(relative, modelExpected, root), /bytes changed/);
  for (const wrong of [relative.replace('readonly-continuation-1792000100000', 'readonly-continuation-invalid'),
    relative.replace('/evidence.json', '/extra/evidence.json')]) await assert.rejects(readHardwareAgentEvidence(wrong, modelExpected, root));
});
