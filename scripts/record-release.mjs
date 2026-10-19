import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, lstat, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t2Scope = 'user-driven-fixed-target-installed-T2';
const requiredControls = ['build', 'inspect', 'flash', 'verify', 'export', 'restartDedup', 'modeGate', 'concurrentTask', 'duringFlashClose'];
const limitations = ['Not autonomous-model acceptance', 'Not a complete physical fault-injection matrix', 'Not second-user acceptance'];
const hardwareAgentScope = 'real-model-fixed-target-installed-T2';
const hardwareAgentModel = 'gpt-6.1-sol';
const hardwareAgentControls = ['publicLogin', 'policy', 'modelCalls', 'build', 'inspect', 'nativeAuthorization', 'flash', 'verify', 'export', 'restartNoReplay', 'normalClose'];
const hardwareAgentActions = ['embedded_build', 'embedded_inspect', 'embedded_request_flash', 'embedded_verify', 'embedded_export'];
const hardwareAgentTools = ['embedded_status', ...hardwareAgentActions];
const hardwareAgentLimitations = ['Fixed target and restricted tools only', 'Not unrestricted autonomous-agent or OS-isolation acceptance', 'Not a complete physical fault-injection matrix', 'Not second-user acceptance'];

async function artifact(file, root) {
  const filename = path.resolve(root, file);
  const info = await lstat(filename);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Artifact must be a regular file: ${file}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return { file, bytes: info.size, sha256: hash.digest('hex') };
}

async function treeArtifacts(directory, root) {
  const result = [];
  const info = await lstat(path.resolve(root, directory));
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `Artifact directory must not be a link: ${directory}`);
  for (const item of (await readdir(path.resolve(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = `${directory}/${item.name}`;
    assert.ok(!item.isSymbolicLink(), `Artifact links are forbidden: ${file}`);
    if (item.isDirectory()) result.push(...await treeArtifacts(file, root));
    else result.push(await artifact(file, root));
  }
  return result;
}

export async function collectInstalledHardware(root = repository) {
  const overlayRoot = 'install/resources/templates/gesturescreen-v1';
  return {
    manifest: await artifact('install/resources/hardware/manifest.json', root),
    pythonExecutable: await artifact('install/resources/hardware/python/python.exe', root),
    worker: await artifact('install/resources/hardware-worker.py', root),
    overlayManifest: await artifact(`${overlayRoot}/overlay-manifest.json`, root),
    artifacts: await treeArtifacts(overlayRoot, root),
  };
}

export function parseReleaseArguments(args) {
  const result = { runtimeRef: 'HEAD', t2Evidence: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    assert.ok(['--runtime-source', '--t2-evidence', '--hardware-agent-evidence'].includes(name) && !seen.has(name) && value && !value.startsWith('--'), 'Use each supported release argument at most once with a value');
    seen.add(name);
    if (name === '--runtime-source') result.runtimeRef = value;
    else if (name === '--t2-evidence') result.t2Evidence = value;
    else result.hardwareAgentEvidence = value;
  }
  assert.ok(result.runtimeRef === 'HEAD' || /^[a-f0-9]{40}$/.test(result.runtimeRef), 'Provide a full runtime source commit');
  assert.ok(!(result.t2Evidence && result.hardwareAgentEvidence), 'Manual and real-model evidence must be recorded separately');
  return result;
}

export function validateT2Evidence(value, expected) {
  assert.equal(value?.schemaVersion, 1, 'T2 evidence schema');
  assert.equal(value.scope, t2Scope, 'T2 scope must be the user-driven fixed target');
  assert.equal(value.result, 'passed', 'T2 evidence did not pass');
  assert.equal(value.realModel, false, 'This acceptance does not claim a model-driven run');
  assert.equal(value.secondUser, false, 'This acceptance does not resume second-user testing');
  assert.equal(value.release?.version, expected.version, 'T2 evidence release version mismatch');
  if (value.version !== undefined) assert.equal(value.version, expected.version, 'Conflicting T2 version');
  assert.match(value.runtimeCommit ?? '', /^[a-f0-9]{40}$/i, 'T2 runtime commit');
  assert.equal(value.runtimeCommit.toLowerCase(), expected.runtimeSourceCommit.toLowerCase(), 'T2 runtime source commit mismatch');
  assert.equal(value.release.suppliedRuntimeCommit?.toLowerCase(), expected.runtimeSourceCommit.toLowerCase(), 'T2 release runtime source commit mismatch');
  assert.ok(Array.isArray(value.failures) && value.failures.length === 0, 'T2 failures must be empty');
  assert.ok(Array.isArray(value.pageErrors) && value.pageErrors.length === 0, 'T2 page errors must be empty');
  assert.ok(!value.needsHumanClose, 'T2 application cleanup needs human attention');
  assert.ok(value.controls && typeof value.controls === 'object' && !Array.isArray(value.controls), 'T2 controls required');
  for (const control of requiredControls) assert.equal(value.controls[control], 'passed', `Required T2 control did not pass: ${control}`);
  for (const [control, status] of Object.entries(value.controls)) {
    assert.ok(status === 'passed' || (control === 'tamper' && status === 'not-requested'), `T2 control did not pass: ${control}`);
  }
  if (expected.installerSha256) assert.equal(value.release.installerSha256?.toLowerCase(), expected.installerSha256, 'T2 installer hash mismatch');
  for (const [file, hash] of Object.entries(expected.resourceHashes ?? {})) {
    assert.equal(value.release.resourceHashes?.[file]?.toLowerCase(), hash, `T2 installed resource hash mismatch: ${file}`);
  }
  return { result: 'passed', scope: t2Scope, version: expected.version, runtimeSourceCommit: expected.runtimeSourceCommit,
    realModel: false, secondUser: false, controls: { ...value.controls }, limitations: [...limitations] };
}

export function pendingT2Evidence() {
  return { result: 'pending', scope: t2Scope, evidence: null, limitations: [...limitations] };
}

export function validateHardwareAgentEvidence(value, expected) {
  assert.equal(value?.schemaVersion, 1, 'Hardware-agent evidence schema');
  assert.equal(value.scope, hardwareAgentScope, 'Hardware-agent scope must be explicitly real-model');
  assert.match(value.runId ?? '', /^hardware-agent-\d{13}-[a-f0-9]{6}$/, 'Hardware-agent harness run ID');
  assert.equal(value.result, 'passed'); assert.equal(value.realModel, true); assert.equal(value.secondUser, false);
  assert.equal(value.model, hardwareAgentModel, 'Hardware-agent selected model');
  assert.equal(value.publicAccount?.loggedIn, true, 'Existing public product login required');
  assert.equal(value.release?.version, expected.version, 'Hardware-agent release version mismatch');
  if (value.version !== undefined) assert.equal(value.version, expected.version);
  assert.match(value.runtimeCommit ?? '', /^[a-f0-9]{40}$/i);
  assert.equal(value.runtimeCommit.toLowerCase(), expected.runtimeSourceCommit.toLowerCase());
  assert.equal(value.release.suppliedRuntimeCommit?.toLowerCase(), expected.runtimeSourceCommit.toLowerCase());
  if (expected.installerSha256) assert.equal(value.release.installerSha256?.toLowerCase(), expected.installerSha256);
  if (expected.executableSha256) assert.equal(value.release.executableSha256?.toLowerCase(), expected.executableSha256);
  for (const [file, hash] of Object.entries(expected.resourceHashes ?? {})) {
    assert.equal(value.release.resourceHashes?.[file]?.toLowerCase(), hash, `Hardware-agent installed resource mismatch: ${file}`);
  }
  for (const key of ['failures', 'pageErrors']) assert.deepEqual(value[key], [], `Hardware-agent ${key} must be empty`);
  assert.ok(!value.needsHumanClose && !value.cleanupError, 'Hardware-agent cleanup incomplete');
  assert.ok(value.controls && typeof value.controls === 'object' && !Array.isArray(value.controls));
  assert.deepEqual(Object.keys(value.controls).sort(), [...hardwareAgentControls].sort(), 'Hardware-agent control set');
  for (const name of hardwareAgentControls) assert.equal(value.controls[name], 'passed', `Required hardware-agent control: ${name}`);
  assert.equal(value.nativeConfirmation?.synthesizedDialogResponse, false, 'Native dialog results must not be synthesized');
  assert.equal(typeof value.nativeConfirmation.mechanism, 'string'); assert.ok(value.nativeConfirmation.mechanism);
  assert.ok(Array.isArray(value.closes) && value.closes.length >= 2, 'Initial and restarted installed app must close');
  for (const close of value.closes) assert.ok(close.normalClose === true && close.installedGuiAbsent === true, 'Normal installed close required');
  assert.ok(Array.isArray(value.launches) && value.launches.length >= 2, 'Installed launch and restart observations required');
  for (const launch of value.launches) {
    assert.ok(Number.isSafeInteger(launch.electronMain?.pid) && launch.electronMain.pid > 0);
    assert.equal(launch.electronMain.type, 'browser');
    assert.equal(typeof launch.electronMain.execPath, 'string'); assert.ok(launch.electronMain.execPath);
    if (expected.installedExe) assert.equal(path.resolve(launch.electronMain.execPath).toLowerCase(), path.resolve(expected.installedExe).toLowerCase(), 'Actual installed main executable required');
  }

  const policy = value.policy;
  assert.equal(policy?.schemaVersion, 1); assert.equal(policy.profile, 'restricted-hardware'); assert.equal(policy.model, hardwareAgentModel);
  assert.deepEqual(policy.tools, hardwareAgentTools); assert.deepEqual(policy.environments, []);
  assert.equal(policy.externalMcp, 'disabled'); assert.equal(policy.freshThreadOnly, true);
  assert.equal(policy.executableSha256, value.release.resourceHashes?.['resources/codex/codex.exe'], 'Restricted policy executable pin');
  assert.equal(typeof policy.protocolVersion, 'string'); assert.ok(policy.protocolVersion);
  for (const key of ['executableSha256', 'bundledCatalogSha256', 'catalogSha256', 'effectiveConfigSha256']) assert.match(policy[key] ?? '', /^[a-f0-9]{64}$/);

  const run = value.run, hardware = value.hardware;
  assert.equal(run?.schemaVersion, 1); assert.equal(run.model, hardwareAgentModel);
  for (const key of ['runId', 'sessionId', 'taskId', 'threadId', 'turnId']) assert.ok(typeof run[key] === 'string' && run[key], `Missing model ${key}`);
  assert.ok(Number.isSafeInteger(run.generation) && run.generation > 0);
  assert.equal(run.status, 'completed'); assert.equal(run.phase, 'completed');
  for (const key of ['active', 'hardwareBusy', 'stopRequested']) assert.equal(run[key], false);
  assert.equal(run.nativeApproval, 'approved'); assert.equal(run.failure, undefined);
  assert.equal(hardware?.configured, true); assert.equal(hardware.taskId, run.taskId);
  assert.equal(hardware.profileId, 'gesturescreen-challenger-v1');
  assert.ok(Array.isArray(hardware.operations) && hardware.operations.length === 4, 'Exactly four actual worker operations required');
  const operations = new Map(); const operationIds = new Set(); const requestKeys = new Set();
  for (const operation of hardware.operations) {
    assert.ok(['build', 'inspect', 'flash', 'verify'].includes(operation.kind) && !operations.has(operation.kind));
    assert.ok(operation.id && !operationIds.has(operation.id)); operationIds.add(operation.id);
    assert.ok(operation.requestKey && !requestKeys.has(operation.requestKey)); requestKeys.add(operation.requestKey);
    assert.equal(operation.status, 'succeeded'); assert.equal(operation.processExited, true);
    operations.set(operation.kind, operation);
  }
  const artifact = hardware.artifact;
  assert.ok(artifact); assert.equal(artifact.id, operations.get('build').id);
  assert.equal(operations.get('build').artifactId, artifact.id);
  for (const key of ['buildId', 'hexSha256', 'axfSha256', 'sourceSha256', 'profileSha256']) assert.match(artifact[key] ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(artifact.buildId, '0'.repeat(64)); assert.equal(artifact.profileSha256, hardware.profileSha256);
  for (const key of ['id', 'buildId', 'hexSha256', 'axfSha256', 'sourceSha256', 'profileSha256']) assert.equal(run.artifact?.[key], artifact[key]);

  assert.ok(Array.isArray(run.calls) && run.calls.length >= 6, 'Actual model calls are required');
  assert.equal(run.calls[0]?.tool, 'embedded_status');
  assert.ok(Array.isArray(value.callAssociations) && value.callAssociations.length === run.calls.length, 'Complete call associations required');
  const callIds = new Set(); let lastAction = -1, previousActionCompletedAt = 0;
  for (const [index, call] of run.calls.entries()) {
    assert.ok(hardwareAgentTools.includes(call.tool), 'Unexpected model tool');
    assert.ok(call.callId && !callIds.has(call.callId), 'Actual dynamic calls must have unique IDs'); callIds.add(call.callId);
    assert.equal(call.status, 'succeeded'); assert.equal(call.error, undefined); assert.equal(call.replayedFromCallId, undefined);
    assert.ok(Number.isFinite(Date.parse(call.receivedAt)) && Number.isFinite(Date.parse(call.completedAt)));
    assert.ok(Date.parse(call.completedAt) >= Date.parse(call.receivedAt));
    assert.equal(call.result?.ok, true); assert.equal(call.result.callId, call.callId);
    assert.equal(call.result.runId, run.runId); assert.equal(call.result.tool, call.tool);
    const association = value.callAssociations[index];
    for (const key of ['runId', 'sessionId', 'taskId', 'generation', 'threadId', 'turnId']) assert.equal(association?.[key], run[key], `Call ${key} binding`);
    for (const key of ['callId', 'tool', 'requestKey', 'operationId']) assert.equal(association?.[key], call[key], `Call ${key} association`);
    if (call.tool === 'embedded_status') { assert.equal(call.result.result, 'status'); continue; }
    const actionIndex = hardwareAgentActions.indexOf(call.tool);
    assert.ok(actionIndex > lastAction, 'Five action calls must be unique and ordered'); lastAction = actionIndex;
    assert.ok(Date.parse(call.receivedAt) >= previousActionCompletedAt, 'Action call timestamps must follow completed predecessors');
    previousActionCompletedAt = Date.parse(call.completedAt);
    assert.equal(call.result.result, 'succeeded');
    if (call.tool === 'embedded_export') { assert.deepEqual(call.result.export, run.export); continue; }
    const operation = operations.get(call.tool === 'embedded_request_flash' ? 'flash' : call.tool.slice('embedded_'.length));
    assert.equal(call.operationId, operation.id); assert.equal(call.requestKey, operation.requestKey);
    assert.equal(call.result.operation?.id, operation.id); assert.equal(call.result.operation?.status, 'succeeded');
    assert.equal(call.result.operation?.kind, operation.kind); assert.equal(call.result.operation?.processExited, true);
  }
  for (const tool of hardwareAgentActions) assert.equal(run.calls.filter(call => call.tool === tool).length, 1, `Exactly one ${tool} required`);
  const grant = hardware.grant, flash = operations.get('flash');
  assert.equal(grant?.scope, 'flash-and-verify-once'); assert.equal(grant.taskId, run.taskId);
  assert.equal(grant.consumedBy, flash.id); assert.equal(grant.profileId, hardware.profileId);
  assert.equal(grant.artifactId, artifact.id);
  for (const key of ['buildId', 'hexSha256', 'axfSha256', 'sourceSha256', 'profileSha256']) assert.equal(grant[key], artifact[key]);
  assert.deepEqual(grant.identity, { probeSerial: '594AC1D7613FED24', uid: '0037001b3133510432383236', chipId: 0x419, flashKiB: 1024, cdcSerial: '326F32513133' });
  assert.match(grant.backupSha256 ?? '', /^[a-f0-9]{64}$/);
  const approvedAt = Date.parse(grant.approvedAt), expiresAt = Date.parse(grant.expiresAt), flashAt = Date.parse(flash.createdAt);
  assert.ok(Number.isFinite(approvedAt) && approvedAt <= flashAt && flashAt < expiresAt, 'Native approval must precede flash within its lifetime');
  assert.equal(value.export?.path, run.export?.path); assert.equal(value.export?.sha256, run.export?.sha256);
  assert.ok(typeof value.export.path === 'string' && value.export.path); assert.match(value.export.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.equal(value.export.operationCount, 4); assert.ok(value.export.fileCount > 0);
  assert.ok(Array.isArray(value.export.files) && value.export.files.length === value.export.fileCount);
  for (const item of value.export.files) assert.match(item.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(value.restart?.before, run); assert.deepEqual(value.restart?.after, run, 'Restart must not resume or add model calls');
  for (const side of ['hardwareBefore', 'hardwareAfter']) {
    const restored = value.restart[side]; assert.equal(restored?.taskId, hardware.taskId);
    const persistent = operations => operations.map(({ progress: _telemetry, ...item }) => item);
    assert.deepEqual(persistent(restored.operations), persistent(hardware.operations), 'Restart must not replay hardware');
    assert.deepEqual(restored.artifact, artifact);
  }
  return { result: 'passed', scope: hardwareAgentScope, model: hardwareAgentModel, version: expected.version,
    runtimeSourceCommit: expected.runtimeSourceCommit, realModel: true, secondUser: false,
    runId: value.runId, modelRunId: run.runId, controls: { ...value.controls }, limitations: [...hardwareAgentLimitations] };
}

export async function readHardwareAgentEvidence(filename, expected, root = repository) {
  const base = await realpath(root), resolved = path.resolve(base, filename);
  const parts = path.relative(base, resolved).split(path.sep);
  const continuation = parts.length === 5 && /^readonly-continuation-\d{13}$/.test(parts[3]) && parts[4] === 'evidence.json';
  assert.ok(parts[0] === 'output' && parts[1] === 'hardware-agent' && /^hardware-agent-\d{13}-[a-f0-9]{6}$/.test(parts[2])
    && ((parts.length === 4 && parts[3] === 'evidence.json') || continuation), 'Real-model evidence must be repository output/hardware-agent/<run>/evidence.json or its strict readonly-continuation directory');
  const contents = await readBoundedHardwareAgentFile(base, parts);
  const value = JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, ''));
  let acceptance;
  if (continuation) {
    assert.equal(value.continuationId, parts[3], 'Read-only continuation directory ID mismatch');
    const sourcePath = `${parts.slice(0, 3).join('/')}/evidence.json`;
    assert.equal(value.sourceExecutionEvidence?.path, sourcePath, 'Continuation source must be its original run evidence');
    const originalBytes = await readBoundedHardwareAgentFile(base, parts.slice(0, 3).concat('evidence.json'));
    const sourceHash = createHash('sha256').update(originalBytes).digest('hex');
    assert.equal(value.sourceExecutionEvidence.sha256, sourceHash, 'Original execution evidence bytes changed');
    const source = JSON.parse(originalBytes.toString('utf8').replace(/^\uFEFF/, ''));
    acceptance = validateHardwareAgentContinuation(value, source, expected);
  } else {
    for (const key of ['continuationId', 'sourceExecutionEvidence', 'readOnlyCheck']) assert.equal(value[key], undefined, 'Continuation claims require a separately bound continuation path');
    acceptance = validateHardwareAgentEvidence(value, expected);
  }
  assert.equal(value.runId, parts[2], 'Real-model evidence run ID mismatch');
  return { ...acceptance, evidence: { file: parts.join('/'), bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') } };
}

async function readBoundedHardwareAgentFile(base, parts) {
  const resolved = path.join(base, ...parts);
  let current = base;
  for (const part of parts) { current = path.join(current, part); assert.ok(!(await lstat(current)).isSymbolicLink(), 'Real-model evidence path must not contain links'); }
  assert.equal(path.relative(resolved, await realpath(resolved)), '', 'Real-model evidence must resolve inside its repository location');
  assert.ok((await lstat(resolved)).size <= 32 * 1024 * 1024, 'Real-model evidence exceeds bounded size');
  const contents = await readFile(resolved); assert.ok(contents.length <= 32 * 1024 * 1024, 'Real-model evidence exceeds bounded size');
  return contents;
}

function operationWithoutTelemetry(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return operation;
  const { progress: _telemetry, ...persistent } = operation;
  return persistent;
}

function hardwareWithoutTelemetry(hardware) {
  if (!Array.isArray(hardware?.operations)) return hardware;
  return { ...hardware, operations: hardware.operations.map(operationWithoutTelemetry) };
}

function runWithoutTelemetry(run) {
  if (!Array.isArray(run?.calls)) return run;
  return { ...run, calls: run.calls.map(call => {
    if (!call?.result?.operation) return call;
    return { ...call, result: { ...call.result, operation: operationWithoutTelemetry(call.result.operation) } };
  }) };
}

function assertSamePersistent(actual, expected, message, shape) {
  const normalize = shape === 'run' ? runWithoutTelemetry : shape === 'hardware' ? hardwareWithoutTelemetry : value => value;
  assert.deepEqual(normalize(actual), normalize(expected), message);
}

export function validateHardwareAgentContinuation(value, source, expected) {
  assert.equal(source?.scope, hardwareAgentScope); assert.equal(source.result, 'failed', 'Continuation must retain a failed execution report');
  assert.equal(source.runId, value.runId); assert.equal(source.realModel, true);
  assert.deepEqual(source.pageErrors, []); assert.ok(!source.needsHumanClose && !source.cleanupError);
  assert.ok(Array.isArray(source.failures) && source.failures.length === 1, 'Only the known restart serialization assertion may be continued');
  const failure = source.failures[0];
  assert.equal(typeof failure, 'string');
  assert.ok(failure.startsWith('AssertionError [ERR_ASSERTION]: Restart must not resume or fabricate controller calls\n+ actual - expected\n'), 'Unexpected original execution failure');
  const deleted = failure.split('\n').filter(line => line.startsWith('-'));
  assert.equal(deleted.length, 4, 'Only the four known omitted undefined fields are allowed');
  assert.deepEqual(deleted.map(line => {
    const match = /^-\s+(artifact|message|detail|progress): undefined,$/.exec(line);
    assert.ok(match, 'Original failure changed a value other than an omitted undefined field'); return match[1];
  }).sort(), ['artifact', 'detail', 'message', 'progress']);
  assertSamePersistent(source.failureRun, source.run, 'Original restart observation differs from its completed model run', 'run');
  assertSamePersistent(source.failureHardware, source.hardware, 'Original restart observation changed authoritative hardware', 'hardware');
  assert.equal(source.run?.status, 'completed'); assert.equal(source.run.nativeApproval, 'approved');
  for (const name of hardwareAgentControls) {
    assert.equal(source.controls?.[name], ['restartNoReplay', 'normalClose'].includes(name) ? 'pending' : 'passed', 'Original control history must remain intact');
  }
  const provenance = value.sourceExecutionEvidence;
  assert.equal(provenance?.result, 'failed'); assert.match(provenance.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(provenance.originalFailures, source.failures, 'Original failure text must be preserved');
  for (const key of ['schemaVersion', 'runId', 'scope', 'realModel', 'secondUser', 'model', 'runtimeCommit', 'publicAccount', 'policy',
    'run', 'hardware', 'callAssociations', 'nativeConfirmation', 'release', 'export', 'taskId', 'sessionId', 'protocolBoundary',
    'dataDir', 'projectRoot', 'planSha256', 'policyProvenance']) {
    assertSamePersistent(value[key], source[key], `Continuation changed original ${key}`, key);
  }
  const check = value.readOnlyCheck;
  assert.equal(check?.modelTurnsSubmitted, 0); assert.equal(check.hardwareActionsSubmitted, 0); assert.equal(check.connectedExplicitly, false);
  assert.ok(Array.isArray(check.roundTrips) && check.roundTrips.length === 2, 'Exactly two read-only installed round trips required');
  const normalizedRuns = [];
  for (const [index, trip] of check.roundTrips.entries()) {
    assert.ok(Number.isFinite(Date.parse(trip.observedAt)) && Date.parse(trip.observedAt) >= Date.parse(source.run.updatedAt));
    assert.equal(trip.engineState, 'stopped'); assert.equal(trip.activeRunId, undefined, 'A read-only continuation cannot own an active run');
    assert.equal(trip.launchIndex, index); assert.equal(trip.closeIndex, index); assert.equal(trip.normalClose, true);
    assert.equal(trip.session?.id, source.run.sessionId); assert.equal(trip.session.taskId, source.run.taskId);
    assert.equal(trip.session.status, 'completed'); assert.equal(trip.session.turnId, undefined, 'Completed continuation session must have no active turn');
    const normalized = structuredClone(trip.run);
    if (trip.run?.nativeApproval === 'expired') {
      const expiry = trip.derivedApprovalExpiry;
      assert.deepEqual(Object.keys(expiry ?? {}).sort(), ['expiresAt', 'from', 'observedAt', 'to']);
      assert.equal(expiry.from, 'approved'); assert.equal(expiry.to, 'expired');
      assert.equal(expiry.expiresAt, source.hardware.grant.expiresAt); assert.equal(expiry.observedAt, trip.observedAt);
      assert.ok(Number.isFinite(Date.parse(expiry.expiresAt)) && Date.parse(trip.observedAt) >= Date.parse(expiry.expiresAt), 'Grant expiry cannot be derived early');
      normalized.nativeApproval = 'approved';
    } else assert.equal(trip.derivedApprovalExpiry, undefined, 'Expiry metadata requires an actual expired approval view');
    assertSamePersistent(normalized, source.run, 'Read-only round trip changed completed model state beyond derived approval expiry', 'run');
    assertSamePersistent(trip.hardware, source.hardware, 'Read-only round trip replayed or changed hardware', 'hardware');
    normalizedRuns.push(normalized);
  }
  assertSamePersistent(value.restart?.before, source.run, undefined, 'run');
  assertSamePersistent(value.restart?.after, check.roundTrips[1].run, undefined, 'run');
  assertSamePersistent(value.restart?.hardwareBefore, source.hardware, undefined, 'hardware');
  assertSamePersistent(value.restart?.hardwareAfter, check.roundTrips[1].hardware, undefined, 'hardware');
  const normalizedReport = { ...value, run: runWithoutTelemetry(source.run), hardware: hardwareWithoutTelemetry(source.hardware),
    restart: { before: runWithoutTelemetry(source.run), after: runWithoutTelemetry(normalizedRuns[1]),
      hardwareBefore: hardwareWithoutTelemetry(source.hardware), hardwareAfter: hardwareWithoutTelemetry(check.roundTrips[1].hardware) } };
  // Only temporary comparison views normalize the terminal TTL display field.
  const acceptance = validateHardwareAgentEvidence(normalizedReport, expected);
  return { ...acceptance, acceptanceMethod: 'original-execution-plus-readonly-continuation', continuationId: value.continuationId,
    sourceExecutionEvidence: { path: provenance.path, sha256: provenance.sha256,
    result: 'failed', originalFailures: [...provenance.originalFailures] },
    readOnlyCheck: { modelTurnsSubmitted: 0, hardwareActionsSubmitted: 0, connectedExplicitly: false, roundTrips: 2,
      derivedApprovalExpiries: check.roundTrips.flatMap(trip => trip.derivedApprovalExpiry ? [{ ...trip.derivedApprovalExpiry }] : []) } };
}

export async function readT2Evidence(filename, expected, root = repository) {
  const base = await realpath(root);
  const resolved = path.resolve(base, filename);
  const parts = path.relative(base, resolved).split(path.sep);
  assert.ok(parts.length === 4 && parts[0] === 'output' && parts[1] === 't2' && /^t2-\d{13}-[a-z0-9]{4,12}$/.test(parts[2]) && parts[3] === 'evidence.json', 'T2 evidence must be a repository output/t2/<run>/evidence.json');
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    assert.ok(!(await lstat(current)).isSymbolicLink(), 'T2 evidence path must not contain links');
  }
  assert.equal(path.relative(resolved, await realpath(resolved)), '', 'T2 evidence path must resolve inside its repository location');
  assert.ok((await lstat(resolved)).size <= 32 * 1024 * 1024, 'T2 evidence exceeds the bounded size');
  const contents = await readFile(resolved);
  assert.ok(contents.length <= 32 * 1024 * 1024, 'T2 evidence exceeds the bounded size');
  const value = JSON.parse(contents.toString('utf8').replace(/^\uFEFF/, ''));
  const acceptance = validateT2Evidence(value, expected);
  assert.equal(value.runId, parts[2], 'T2 evidence run ID mismatch');
  return { ...acceptance, evidence: { file: parts.join('/'), bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') } };
}

export async function recordRelease(args = process.argv.slice(2), root = repository) {
  const options = parseReleaseArguments(args);
  const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const runtimeSourceCommit = git(['rev-parse', `${options.runtimeRef}^{commit}`]);
  const installer = await artifact(`release/ForgeDesk-${packageInfo.version}-x64-setup.exe`, root);
  const source = await artifact(options.hardwareAgentEvidence ? `release/ForgeDesk-source-hardware-agent-${packageInfo.version}.zip` : 'release/ForgeDesk-source.zip', root);
  const installedApp = await artifact('install/resources/app.asar', root);
  const templates = [];
  for (const name of (await readdir(path.join(root, 'install/resources/templates/node-software-v1'))).sort()) {
    if (name.endsWith('.mjs')) templates.push(await artifact(`install/resources/templates/node-software-v1/${name}`, root));
  }
  const installedHardware = await collectInstalledHardware(root);
  const resources = [installedApp, installedHardware.manifest, installedHardware.pythonExecutable, installedHardware.worker, ...installedHardware.artifacts];
  const resourceHashes = Object.fromEntries(resources.map(item => [item.file.replace(/^install\//, ''), item.sha256]));
  let t2;
  if (options.hardwareAgentEvidence) {
    const installedExecutable = await artifact('install/ForgeDesk.exe', root);
    const runtimeFiles = ['codex/codex.exe', 'codex/codex-code-mode-host.exe', 'codex/codex-command-runner.exe', 'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe'];
    for (const file of runtimeFiles) resourceHashes[`resources/${file}`] = (await artifact(`install/resources/${file}`, root)).sha256;
    t2 = await readHardwareAgentEvidence(options.hardwareAgentEvidence, { version: packageInfo.version, runtimeSourceCommit, installerSha256: installer.sha256, executableSha256: installedExecutable.sha256, installedExe: path.join(root, 'install/ForgeDesk.exe'), resourceHashes }, root);
  } else {
    t2 = options.t2Evidence ? await readT2Evidence(options.t2Evidence, { version: packageInfo.version, runtimeSourceCommit, installerSha256: installer.sha256, resourceHashes }, root)
      : pendingT2Evidence();
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    product: 'ForgeDesk',
    version: packageInfo.version,
    sourceCommit: git(['rev-parse', 'HEAD']),
    runtimeSourceCommit,
    ...(options.hardwareAgentEvidence ? { scope: hardwareAgentScope, model: hardwareAgentModel } : {}),
    installer, source, installedApp, templates,
    installedHardware,
    lockfile: await artifact('package-lock.json', root),
    signature: 'Unsigned; no signing certificate configured',
    engine: JSON.parse((await readFile(path.join(root, 'vendor/codex/manifest.json'), 'utf8')).replace(/^\uFEFF/, '')),
    processHost: JSON.parse((await readFile(path.join(root, 'vendor/process-host/manifest.json'), 'utf8')).replace(/^\uFEFF/, '')),
    acceptance: { T1: 'See docs/ACCEPTANCE.md and docs/QA.md for version-bound software regression',
      T2: options.hardwareAgentEvidence ? (t2.sourceExecutionEvidence
        ? 'Scoped real-model fixed-target acceptance combines the retained failed execution report with a passed read-only continuation. See docs/HARDWARE_AGENT_ACCEPTANCE.md; not unrestricted autonomy, OS isolation or the complete fault-injection matrix.'
        : 'Scoped installed real-model fixed-target run passed. See docs/HARDWARE_AGENT_ACCEPTANCE.md; not unrestricted autonomy, OS isolation or the complete fault-injection matrix.')
        : `${t2.result === 'passed' ? 'Scoped installed user-driven fixed-target run passed' : 'Pending installed user-driven fixed-target evidence'}. See docs/T2_INSTALLED_RESULT.md; not autonomous-model acceptance or the complete fault-injection matrix.`,
      T3: 'Scoped distinct-SID results are documented in docs/SECOND_USER_RESULT.md; additional second-account validation is paused and the full matrix remains incomplete.' },
    acceptanceEvidence: { T2: t2 },
  };
  await writeFile(path.join(root, options.hardwareAgentEvidence ? 'release/manifest-hardware-agent.json' : 'release/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(path.join(root, options.hardwareAgentEvidence ? 'release/SHA256SUMS-hardware-agent.txt' : 'release/SHA256SUMS.txt'), `${installer.sha256}  ${installer.file.split('/').at(-1)}\n${source.sha256}  ${source.file.split('/').at(-1)}\n`);
  console.log(JSON.stringify({ installer: installer.file, sourceCommit: manifest.sourceCommit, sha256: installer.sha256, T2: t2.result }));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await recordRelease();
