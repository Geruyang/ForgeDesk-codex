import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { FZ3B_PROFILE, fz3bDigest, fz3bProfileSha256, validateFz3bFixture, validateFz3bIdentity } from '../../packages/engineering-runner/fz3b/profile';
import { FZ3B_TOOLS, type Fz3bAdapterContext, type Fz3bRunView, type Fz3bSemanticFixture } from '../../packages/engineering-runner/fz3b/types';
import { deterministicPsPackage } from '../../packages/engineering-runner/fz3b/package';
import { parseFz3bRemoteResult } from '../../packages/engineering-runner/fz3b/worker';
import { fileSha256, inside, plainPath, samePath } from './embedded-installed';
import { sanitizeHardwareAgentEvidence } from './hardware-agent-installed';

export { sanitizeHardwareAgentEvidence as sanitizeFz3bEvidence };
export const FZ3B_INSTALLED_SCOPE = 'real-model-fixed-existing-fz3b-installed-single-image' as const;
export const FZ3B_PRODUCT_OUTPUT = 'output/hardware/2026-10-16-next/product';
export const FZ3B_INSTRUCTION = 'Use the six supplied FZ3B tools exactly once in their specified order, each with {}: status, build the fixed PS acceptance package, inspect the exact existing target, request native semantic consent and wait for the operator, run the fixed real-text single-image semantic test, then export. Do not supply consent yourself. The operator must verify the fresh target and approve the original native checkbox dialog. Stop on refusal, failure, timeout or unknown; never retry an action. Do not edit source, deploy, restart a service, load a different bitstream, use arbitrary SSH/shell/MCP, or claim broad accuracy. Report ranking, threshold and classification-unknown separately.';
const SHA = /^[a-f0-9]{64}$/;
export const FZ3B_CONTROLS = ['publicLogin', 'policy', 'modelCalls', 'build', 'inspect', 'nativeAuthorization', 'semantic', 'export', 'activeCloseGuard', 'restartNoReplay', 'normalClose'] as const;

export interface Fz3bInstalledRequest {
  schemaVersion: 1; scope: typeof FZ3B_INSTALLED_SCOPE; runId: string; version: string;
  runtimeCommit: string; projectRoot: string; nativeOperator: 'coordinator-delegated-visible-ui';
}
export interface Fz3bInstalledPlan extends Fz3bInstalledRequest {
  model: 'gpt-6.1-sol'; installedExe: string; installerPath: string; dataDir: string;
  executableSha256: string; installerSha256: string; resourceHashes: Record<string, string>;
  fixture: Fz3bSemanticFixture; profileSha256: string; preparedAt: string;
}
function assertRequest(root: string, value: Fz3bInstalledRequest) {
  assert.equal(value?.schemaVersion, 1); assert.equal(value.scope, FZ3B_INSTALLED_SCOPE);
  assert.match(value.runId, /^fz3b-installed-\d{13}-[a-f0-9]{6}$/); assert.equal(value.version, '0.5.0');
  assert.match(value.runtimeCommit, /^[a-f0-9]{40}$/); assert.equal(value.nativeOperator, 'coordinator-delegated-visible-ui');
  assert.ok(path.isAbsolute(value.projectRoot) && inside(path.join(root, 'output/hardware'), value.projectRoot));
}
export function fz3bPlanScope(root: string, value: unknown, env: NodeJS.ProcessEnv) {
  const plan = value as Fz3bInstalledPlan;
  assert.ok(path.isAbsolute(root)); assertRequest(root, plan);
  assert.match(plan.runtimeCommit, /^[a-f0-9]{40}$/); assert.equal(plan.model, FZ3B_PROFILE.model);
  assert.equal(plan.nativeOperator, 'coordinator-delegated-visible-ui');
  assert.ok(samePath(plan.installedExe, path.join(root, 'install/ForgeDesk.exe')));
  assert.ok(samePath(plan.dataDir, path.join(root, '.runtime/app')), 'Use the existing official account, never copy authentication');
  assert.ok(samePath(plan.installerPath, path.join(root, `release/ForgeDesk-${plan.version}-x64-setup.exe`)));
  assert.ok(path.isAbsolute(plan.projectRoot) && inside(path.join(root, 'output/hardware'), plan.projectRoot));
  const output = path.join(root, FZ3B_PRODUCT_OUTPUT, plan.runId);
  for (const [a, b] of [[plan.projectRoot, plan.dataDir], [plan.projectRoot, path.dirname(plan.installedExe)], [plan.projectRoot, output], [output, plan.dataDir]]) {
    assert.equal(inside(a, b) || inside(b, a), false, 'Account, installation, project and evidence must be disjoint');
  }
  for (const key of ['FORGEDESK_DATA_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE']) assert.ok(!env[key], `Remove ambient ${key}`);
  for (const [key, item] of Object.entries(env)) if (item && /^FORGEDESK_(FZ3B|T2|HARDWARE_AGENT)_/.test(key)) assert.fail(`No acceptance override allowed: ${key}`);
  for (const key of ['resources/app.asar', 'resources/codex/codex.exe', 'resources/codex/codex-code-mode-host.exe',
    'resources/codex/codex-command-runner.exe', 'resources/codex/codex-windows-sandbox-setup.exe',
    'resources/process-host/process-host.exe', 'resources/fz3b/manifest.json', 'resources/fz3b/fixture/host-fixture.json',
    'resources/fz3b/remote/remote.py', 'resources/fz3b/remote/wire.py']) assert.match(plan.resourceHashes?.[key], SHA, `Missing installed pin ${key}`);
  for (const [relative, hash] of Object.entries(plan.resourceHashes)) {
    assert.match(relative, /^resources\/[A-Za-z0-9._/-]+$/); assert.ok(relative.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.match(hash, SHA);
  }
  for (const hash of [plan.executableSha256, plan.installerSha256, plan.profileSha256]) assert.match(hash, SHA);
  validateFz3bFixture(plan.fixture); assert.equal(plan.profileSha256, fz3bProfileSha256(plan.fixture));
  assert.ok(Number.isFinite(Date.parse(plan.preparedAt)));
  return { plan, root, output, dataDir: plan.dataDir, resourceRoot: path.join(path.dirname(plan.installedExe), 'resources/fz3b') };
}

async function bounded(file: string, max: number) {
  await plainPath(file); const info = await lstat(file);
  assert.ok(info.isFile() && info.nlink === 1 && info.size <= max, `Not a bounded regular file: ${file}`);
  const bytes = await readFile(file); assert.equal(bytes.length, info.size); assert.ok(bytes.length <= max); return bytes;
}
export async function readPinnedFz3bResources(plan: Fz3bInstalledPlan): Promise<Map<string, Buffer>> {
  const root = path.join(path.dirname(plan.installedExe), 'resources/fz3b');
  const raw = await bounded(path.join(root, 'manifest.json'), 65536);
  assert.equal(fz3bDigest(raw), plan.resourceHashes['resources/fz3b/manifest.json']);
  const manifest = JSON.parse(raw.toString('utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.scope, 'fixed-fz3b-product-resources-v1');
  assert.equal(manifest.sourceManifestSha256, FZ3B_PROFILE.deployedManifestSha256);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 10 && manifest.files.length <= 128);
  const files = new Map<string, Buffer>(); let total = 0;
  for (const item of manifest.files) {
    assert.match(item.path, /^[A-Za-z0-9][A-Za-z0-9_./-]{0,160}$/);
    assert.ok(item.path.split('/').every((part: string) => part && part !== '.' && part !== '..'));
    assert.ok(item.path !== 'manifest.json' && !files.has(item.path)); assert.match(item.sha256, SHA);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 1048576);
    const data = await bounded(path.join(root, item.path), 1048576); total += data.length; assert.ok(total <= 8 * 1048576);
    assert.equal(data.length, item.bytes); assert.equal(fz3bDigest(data), item.sha256);
    assert.equal(plan.resourceHashes[`resources/fz3b/${item.path}`], item.sha256); files.set(item.path, data);
  }
  async function walk(directory: string): Promise<void> {
    await plainPath(directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name); await plainPath(file);
      if (item.isDirectory()) await walk(file);
      else { assert.ok(item.isFile()); const relative = path.relative(root, file).split(path.sep).join('/'); assert.ok(relative === 'manifest.json' || files.has(relative), 'Unlisted installed resource'); }
    }
  }
  await walk(root);
  assert.deepEqual(JSON.parse(files.get('fixture/host-fixture.json')!.toString('utf8')), plan.fixture);
  for (const [name, hash] of [['encoding-manifest.json', plan.fixture.manifestSha256], ['query-template.json', plan.fixture.queriesSha256],
    ['input.jpg', plan.fixture.imageSha256], ['predeclared.json', plan.fixture.predeclaredSha256]]) assert.equal(fz3bDigest(files.get(`fixture/${name}`)!), hash);
  assert.equal(files.get('known_hosts')!.toString('utf8'), `${FZ3B_PROFILE.host} ${FZ3B_PROFILE.hostPublicKey}\n`);
  return files;
}

export async function prepareFz3bInstalledPlan(root: string, value: unknown): Promise<Fz3bInstalledPlan> {
  const request = value as Fz3bInstalledRequest;
  assertRequest(root, request);
  assert.deepEqual(Object.keys(request).sort(), ['schemaVersion', 'scope', 'runId', 'version', 'runtimeCommit', 'projectRoot', 'nativeOperator'].sort());
  const installedExe = path.join(root, 'install/ForgeDesk.exe'), installerPath = path.join(root, `release/ForgeDesk-${request.version}-x64-setup.exe`);
  const resourceRoot = path.join(path.dirname(installedExe), 'resources');
  const resourceHashes: Record<string, string> = {};
  for (const relative of ['app.asar', 'codex/codex.exe', 'codex/codex-code-mode-host.exe', 'codex/codex-command-runner.exe',
    'codex/codex-windows-sandbox-setup.exe', 'process-host/process-host.exe']) {
    await plainPath(path.join(resourceRoot, relative)); resourceHashes[`resources/${relative}`] = await fileSha256(path.join(resourceRoot, relative));
  }
  const fzRoot = path.join(resourceRoot, 'fz3b');
  async function pin(directory: string): Promise<void> {
    await plainPath(directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name); await plainPath(file);
      if (item.isDirectory()) await pin(file);
      else { assert.ok(item.isFile()); resourceHashes[`resources/${path.relative(resourceRoot, file).split(path.sep).join('/')}`] = await fileSha256(file); }
    }
  }
  await pin(fzRoot);
  const fixture = JSON.parse((await bounded(path.join(fzRoot, 'fixture/host-fixture.json'), 65536)).toString('utf8'));
  const plan: Fz3bInstalledPlan = { ...request, model: 'gpt-6.1-sol', installedExe, installerPath, dataDir: path.join(root, '.runtime/app'),
    executableSha256: await fileSha256(installedExe), installerSha256: await fileSha256(installerPath), resourceHashes,
    fixture, profileSha256: fz3bProfileSha256(fixture), preparedAt: new Date().toISOString() };
  fz3bPlanScope(root, plan, {}); await plainPath(request.projectRoot); await readPinnedFz3bResources(plan);
  return plan;
}

export function assertFz3bPolicy(value: unknown, executableSha256: string) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value)); const policy = value as Record<string, any>;
  assert.equal(policy.schemaVersion, 1); assert.equal(policy.profile, 'restricted-fz3b'); assert.equal(policy.model, 'gpt-6.1-sol');
  assert.deepEqual(policy.tools, [...FZ3B_TOOLS]); assert.deepEqual(policy.environments, []);
  assert.equal(policy.externalMcp, 'disabled'); assert.equal(policy.freshThreadOnly, true); assert.equal(policy.executableSha256, executableSha256);
  assert.equal(typeof policy.protocolVersion, 'string'); assert.ok(policy.protocolVersion);
  for (const key of ['bundledCatalogSha256', 'catalogSha256', 'effectiveConfigSha256']) assert.match(policy[key], SHA);
  return policy;
}
export function assertFz3bCompletion(run: Fz3bRunView, fixture: Fz3bSemanticFixture) {
  validateFz3bFixture(fixture);
  assert.equal(run.schemaVersion, 1); assert.equal(run.profileId, FZ3B_PROFILE.id); assert.equal(run.profileSha256, fz3bProfileSha256(fixture));
  assert.equal(run.model, 'gpt-6.1-sol'); assert.ok(run.runId && run.sessionId && run.taskId && run.threadId && run.turnId);
  assert.ok(Number.isSafeInteger(run.generation) && run.generation > 0);
  assert.equal(run.status, 'completed'); assert.equal(run.phase, 'completed'); assert.equal(run.active, false); assert.equal(run.hardwareBusy, false);
  assert.equal(run.stopRequested, false); assert.equal(run.failure, undefined); assert.equal(run.nativeApproval, 'approved');
  assert.deepEqual(run.calls.map(call => call.tool), [...FZ3B_TOOLS]);
  assert.equal(new Set(run.calls.map(call => call.callId)).size, 6);
  for (const call of run.calls) {
    assert.ok(call.callId); assert.equal(call.status, 'succeeded'); assert.equal(call.error, undefined);
    assert.ok(Number.isFinite(Date.parse(call.receivedAt)) && Number.isFinite(Date.parse(call.completedAt!)) && Date.parse(call.completedAt!) >= Date.parse(call.receivedAt));
    assert.ok(call.result?.ok); assert.equal(call.result.runId, run.runId); assert.equal(call.result.callId, call.callId); assert.equal(call.result.tool, call.tool);
    assert.equal(call.result.result, call.tool === 'fz3b_status' ? 'status' : 'succeeded');
  }
  assert.deepEqual(run.operations.map(op => op.kind), ['build', 'inspect', 'semantic']);
  assert.equal(new Set(run.operations.map(op => op.id)).size, 3); assert.equal(new Set(run.operations.map(op => op.nonce)).size, 3);
  for (const op of run.operations) {
    assert.match(op.id, /^[a-f0-9-]{36}$/i); assert.match(op.nonce, SHA); assert.match(op.evidenceSha256!, SHA);
    assert.equal(op.status, 'succeeded'); assert.equal(op.dispatchPhase, 'may-have-started'); assert.equal(op.processExited, true); assert.equal(op.remoteQuiescent, true);
    assert.equal(op.requestKey, `fz3b-${fz3bDigest(`${run.runId}:fz3b_${op.kind}`)}`);
    const call = run.calls.find(item => item.tool === `fz3b_${op.kind}`)!;
    assert.equal(call.operationId, op.id); assert.deepEqual(call.result?.operation, op);
  }
  const artifact = run.artifact!; assert.ok(artifact); assert.equal(artifact.kind, 'fixed-ps-fixture-package');
  assert.equal(artifact.buildId, run.operations[0].id); assert.equal(artifact.profileSha256, run.profileSha256);
  assert.equal(artifact.sourceManifestSha256, FZ3B_PROFILE.deployedManifestSha256); assert.equal(artifact.fixtureManifestSha256, fixture.manifestSha256);
  assert.equal(artifact.queriesSha256, fixture.queriesSha256); assert.equal(artifact.imageSha256, fixture.imageSha256);
  assert.equal(artifact.newPlBuilt, false); assert.equal(artifact.deployed, false); assert.equal(artifact.buildEvidenceSha256, run.operations[0].evidenceSha256);
  const { id, ...body } = artifact; assert.equal(id, fz3bDigest(JSON.stringify(body)));
  for (const hash of [artifact.packageSha256, artifact.packageManifestSha256]) assert.match(hash, SHA);
  validateFz3bIdentity(run.identity!);
  const grant = run.grant!; assert.ok(grant); assert.equal(grant.runId, run.runId); assert.equal(grant.taskId, run.taskId); assert.equal(grant.sessionId, run.sessionId);
  assert.equal(grant.artifactId, artifact.id); assert.equal(grant.profileSha256, run.profileSha256); assert.deepEqual(grant.identity, run.identity); assert.deepEqual(grant.fixture, fixture);
  assert.equal(grant.scope, 'existing-candidate008-real-text-single-image-once'); assert.deepEqual(grant.actions, FZ3B_PROFILE.actions);
  assert.equal(grant.consumedBy, run.operations[2].id);
  const { planSha256, approvedAt, consumedBy: _consumed, ...preview } = grant;
  assert.equal(planSha256, fz3bDigest(JSON.stringify(preview)));
  const created = Date.parse(grant.createdAt), approved = Date.parse(approvedAt!), expiry = Date.parse(grant.expiresAt);
  assert.ok(Number.isFinite(created) && Number.isFinite(approved) && Number.isFinite(expiry));
  assert.ok(created <= approved && approved <= Date.parse(run.operations[2].createdAt) && Date.parse(run.operations[2].createdAt) < expiry && expiry - created <= 600000);
  assert.deepEqual(run.calls[4].result?.semantic, run.semantic); assert.deepEqual(run.calls[5].result?.export, run.export);
  const semantic = run.semantic!; assert.ok(semantic); assert.equal(semantic.synthetic, false); assert.equal(semantic.semanticInput, 'real-text-encoder');
  assert.equal(semantic.fixtureManifestSha256, fixture.manifestSha256); assert.equal(semantic.queriesSha256, fixture.queriesSha256); assert.equal(semantic.imageSha256, fixture.imageSha256);
  assert.deepEqual(semantic.encoderIdentity, fixture.encoderIdentity); assert.equal(semantic.completedFrames, 1); assert.equal(semantic.frameId, 0);
  assert.equal(semantic.jobId, `fd-semantic-${run.operations[2].id.replaceAll('-', '')}`); assert.ok(Number.isSafeInteger(semantic.queryRevision) && semantic.queryRevision > 0);
  assert.equal(semantic.inferenceStopped, true); assert.equal(semantic.newPlLoaded, false); assert.equal(semantic.threshold, .2);
  assert.deepEqual(semantic.ranking.map(item => item.id).sort(), [...fixture.queryIds].sort());
  semantic.ranking.forEach((item, index) => { assert.equal(item.label, item.id); assert.ok(Number.isFinite(item.score) && Math.abs(item.score) <= 1); if (index) assert.ok(semantic.ranking[index - 1].score >= item.score); });
  assert.equal(semantic.bestId, semantic.ranking[0].id); assert.equal(semantic.thresholdHit, semantic.ranking[0].score >= .2);
  assert.equal(semantic.classificationUnknown, !semantic.thresholdHit); assert.equal(semantic.expectedLabel, 'pillow');
  assert.equal(semantic.expectedLabelMatched, semantic.bestId === 'pillow' && semantic.ranking.slice(1).every(item => semantic.ranking[0].score > item.score));
  assert.equal(semantic.expectedLabelMatched, true, 'Fixed-scene expected first rank must match; classificationUnknown is independently reported');
  assert.ok(run.export?.path); assert.match(run.export.sha256, SHA);
  return run;
}

export function assertFz3bNoReplay(before: Fz3bRunView, after: Fz3bRunView) {
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)), 'Restart must preserve all run facts; no model or hardware replay');
}
function assertPersistedEqual(actual: unknown, expected: unknown) {
  assert.deepEqual(JSON.parse(JSON.stringify({ value: actual })), JSON.parse(JSON.stringify({ value: expected })));
}
export function assertFz3bCloseSafe(run: Fz3bRunView | null | undefined, engineState: string, activeRunId?: string) {
  assert.equal(activeRunId, undefined); assert.equal(engineState, 'stopped');
  if (run) { assert.equal(run.active, false); assert.equal(run.hardwareBusy, false); assert.ok(run.operations.every(op => !['prepared', 'running', 'unknown'].includes(op.status) && op.processExited === true && op.remoteQuiescent === true)); }
}

export async function verifyFz3bArtifacts(dataDir: string, run: Fz3bRunView, plan: Fz3bInstalledPlan) {
  assertFz3bCompletion(run, plan.fixture); const installed = await readPinnedFz3bResources(plan);
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const read = async (file: string, hash: string, max: number) => { const bytes = await bounded(file, max); assert.equal(fz3bDigest(bytes), hash); files.push({ path: file, bytes: bytes.length, sha256: hash }); return bytes; };
  const exported = path.join(dataDir, 'exports/fz3b-agent', run.runId);
  assert.ok(samePath(run.export!.path, exported));
  const manifest = JSON.parse((await read(path.join(exported, 'manifest.json'), run.export!.sha256, 2 * 1048576)).toString('utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.scope, FZ3B_PROFILE.id); assert.equal(manifest.exportKind, 'model-tool');
  assert.deepEqual(manifest.profile, FZ3B_PROFILE); assert.deepEqual(manifest.fixture, plan.fixture);
  const saved = manifest.run as Fz3bRunView;
  for (const key of ['runId', 'sessionId', 'taskId', 'model', 'generation', 'threadId', 'turnId', 'profileId', 'profileSha256', 'artifact', 'identity', 'grant', 'semantic', 'operations'] as const) assertPersistedEqual(saved[key], run[key]);
  assert.equal(saved.phase, 'exporting'); assert.equal(saved.status, 'active'); assert.equal(saved.active, true); assert.equal(saved.stopRequested, false);
  assert.equal(saved.export, undefined); assert.equal(saved.calls.length, 6); assertPersistedEqual(saved.calls.slice(0, 5), run.calls.slice(0, 5));
  assert.equal(saved.calls[5].tool, 'fz3b_export'); assert.equal(saved.calls[5].callId, run.calls[5].callId); assert.equal(saved.calls[5].status, 'running');
  assert.equal(saved.calls[5].result, undefined); assert.equal(saved.calls[5].completedAt, undefined);
  assert.deepEqual(Object.keys(manifest.receipts).sort(), run.operations.map(op => op.id).sort());
  const expectedCopies = run.operations.flatMap(op => [{ path: `workers/${op.id}/evidence.json`, sha256: op.evidenceSha256! },
    ...(op.kind === 'build' ? [{ path: `workers/${op.id}/ps-acceptance.tar`, sha256: run.artifact!.packageSha256 },
      { path: `workers/${op.id}/package-manifest.json`, sha256: run.artifact!.packageManifestSha256 }] : [])]);
  assert.ok(Array.isArray(manifest.files)); assert.equal(manifest.files.length, 5);
  assert.deepEqual(manifest.files.map((item: any) => item.path).sort(), expectedCopies.map(item => item.path).sort());
  for (const copy of expectedCopies) {
    const index = manifest.files.find((item: any) => item.path === copy.path); assert.equal(index.sha256, copy.sha256);
    const max = copy.path.endsWith('.tar') ? 8 * 1048576 : 2 * 1048576;
    const bytes = await read(path.join(exported, copy.path), copy.sha256, max); assert.equal(index.bytes, bytes.length);
  }
  const actualExportNames: string[] = [];
  async function walkExport(directory: string): Promise<void> {
    await plainPath(directory);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name); await plainPath(file);
      if (item.isDirectory()) await walkExport(file);
      else { assert.ok(item.isFile()); actualExportNames.push(path.relative(exported, file).split(path.sep).join('/')); }
    }
  }
  await walkExport(exported); assert.deepEqual(actualExportNames.sort(), ['manifest.json', ...expectedCopies.map(item => item.path)].sort());
  for (const op of run.operations) {
    const receipt = manifest.receipts[op.id]; assert.equal(receipt.kind, op.kind); assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.operationId, op.id); assert.equal(receipt.nonce, op.nonce); assert.equal(receipt.profileSha256, run.profileSha256);
    assert.equal(receipt.processExited, true); assert.equal(receipt.remoteQuiescent, true); assert.equal(receipt.remoteOutcomeUnknown, false); assert.equal(receipt.evidenceSha256, op.evidenceSha256);
    const directory = path.join(dataDir, 'fz3b-worker', op.id);
    const evidence = JSON.parse((await read(path.join(directory, 'evidence.json'), op.evidenceSha256!, 2 * 1048576)).toString('utf8'));
    assert.equal(evidence.operationId, op.id); assert.equal(evidence.nonce, op.nonce); assert.equal(evidence.profileSha256, run.profileSha256);
    assert.equal(evidence.resourceManifestSha256, plan.resourceHashes['resources/fz3b/manifest.json']); assert.equal(evidence.action, op.kind);
    if (op.kind === 'build') {
      assert.equal(evidence.kind, 'fixed-ps-fixture-package'); assert.equal(evidence.newPlBuilt, false); assert.equal(evidence.deployed, false);
      assert.equal(evidence.packageSha256, run.artifact!.packageSha256); assert.equal(evidence.packageManifestSha256, run.artifact!.packageManifestSha256);
      const actualPackage = await read(path.join(directory, 'ps-acceptance.tar'), run.artifact!.packageSha256, 8 * 1048576);
      const actualManifest = await read(path.join(directory, 'package-manifest.json'), run.artifact!.packageManifestSha256, 65536);
      const expected = deterministicPsPackage([...installed].filter(([name]) => name.startsWith('ps-src/') || name.startsWith('fixture/') || name.startsWith('licenses/')).map(([name, bytes]) => ({ path: name, bytes })));
      assert.deepEqual(actualPackage, expected.archive); assert.deepEqual(actualManifest, expected.manifest);
      assert.equal(receipt.packageSha256, run.artifact!.packageSha256); assert.equal(receipt.packageManifestSha256, run.artifact!.packageManifestSha256);
    } else {
      assert.equal(evidence.authenticatedTransport, 'pinned-ssh'); assert.equal(evidence.helloAuthenticated, false);
      assert.equal(evidence.transport.processExited, true); assert.equal(evidence.transport.exitCode, 0); assert.equal(evidence.transport.timedOut, false);
      assert.equal(typeof evidence.remoteStdout, 'string', 'Retain real worker stdout; never synthesize a capture from parsed JSON');
      const context: Fz3bAdapterContext = { runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, operationId: op.id, requestKey: op.requestKey,
        nonce: op.nonce, profileSha256: run.profileSha256, fixture: plan.fixture, artifact: run.artifact, identity: run.identity, grant: run.grant };
      const parsed = parseFz3bRemoteResult(evidence.remoteStdout, context, op.kind);
      assert.deepEqual(parsed, evidence.remote); assert.equal(parsed.status, 'succeeded');
      assert.deepEqual(receipt.identity, run.identity);
      if (op.kind === 'semantic') { assert.deepEqual(parsed.semantic, run.semantic); assert.deepEqual(receipt.semantic, run.semantic); assert.equal(parsed.grantId, run.grant!.id); assert.equal(receipt.grantId, run.grant!.id); }
      else assert.equal(receipt.readOnly, true);
    }
  }
  return { path: exported, sha256: run.export!.sha256, files, fileCount: 6, referencedFileCount: files.length, operationCount: 3,
    rawRemoteStdoutReparsed: true, deterministicPackageRebuiltInMemory: true };
}
