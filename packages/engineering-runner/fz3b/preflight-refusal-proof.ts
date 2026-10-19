import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest, fz3bProfileSha256, validateFz3bFixture } from './profile.js';
import { fixedFz3bPayload } from './payload.js';
import type { Fz3bBinding, Fz3bOperation, Fz3bRunView, Fz3bSemanticFixture } from './types.js';

export const FZ3B_PREFLIGHT_REFUSAL_PINS = Object.freeze({
  manifest: 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07',
  remote: '7a675f09af5973e6fa69ad832a424df06ed7b9f04b45ed3ebd2b5c2851faf516',
  wire: '460bae822a42262c610541ef5e2b45423e588d3b43e749327a98aed8cc818710',
  fixture: '5b97805ca3a99aac311fe04d3835052c45acfcefb725857ed82478f8586c06dc',
  profile: '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd',
  oldBoot: '5ceb45a3-8903-4efc-9484-ec75c17280df',
});
type Owner = Required<Pick<Fz3bBinding, 'runId' | 'sessionId' | 'taskId' | 'model' | 'generation' | 'threadId' | 'turnId'>>;
export interface Fz3bPreflightRefusalAnchor {
  /** Trusted host-sealed original context, never hashes supplied as authority by a model/renderer. */
  owner: Owner; operationId: string; runSha256: string; operationSha256: string;
  evidenceSha256: string; intentSha256: string; transportSha256: string; actualCloseSha256: string;
}
export interface Fz3bPreflightRefusalInput {
  /** Plain JSON read from the sealed original run, not a mutable current view. */
  run: Fz3bRunView; anchor: Fz3bPreflightRefusalAnchor;
  resources: { manifest: Buffer; remote: Buffer; wire: Buffer; fixture: Buffer };
  files: { evidence: Buffer; intent: Buffer; transport: Buffer; actualClose: Buffer };
}
export interface Fz3bPreflightRefusalProof {
  schemaVersion: 1; proofScope: 'exact-preflight-branch-only'; classification: 'inspect-preflight-refusal-observed';
  owner: Owner; ownerSha256: string; runSha256: string; operationId: string; operationSha256: string;
  originalOperationStatus: 'unknown'; originalUnknownPreserved: true; originalHardwareBusy: true;
  pins: typeof FZ3B_PREFLIGHT_REFUSAL_PINS;
  files: { evidenceSha256: string; intentSha256: string; transportSha256: string; actualCloseSha256: string };
  requestSha256: string; payloadSha256: string; stdoutSha256: string; stdoutBytes: number;
  originalCloseObservedAt: string; transportObservedAt: string;
  closeEvidenceFormat: 'v1-observed-close-without-pid-or-process-args';
  inspectDeviceBranch: 'not-entered-by-this-bound-request'; remoteQuiescence: 'not-established';
  newBootIdentity: 'not-observed-or-adopted'; leaseDisposition: 'unchanged-not-authorized'; releaseAuthority: 'none';
  integration: 'pure-unintegrated'; limitations: readonly string[]; proofSha256: string;
}

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const id = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);
const hostFailure = 'Error: FZ3B receipt is not terminal and quiescent';
const digest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(`FZ3B_PREFLIGHT_REFUSAL_${label}`); }
function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'OBJECT');
  const names = Reflect.ownKeys(value); check(names.every(name => typeof name === 'string' && [...required, ...optional].includes(name)) && required.every(name => names.includes(name)), 'KEYS');
}
function plain(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  check(depth <= 24 && ++budget.nodes <= 20000, 'JSON_BUDGET');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value), 'FINITE'); return; }
  if (typeof value === 'string') { check(value.length <= 65536, 'STRING_BUDGET'); return; }
  check(value && typeof value === 'object' && [Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value)), 'PLAIN_JSON');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Object.getOwnPropertySymbols(value).length === 0, 'SYMBOLS');
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && name === 'length') continue;
    check(descriptor.enumerable && 'value' in descriptor && descriptor.value !== undefined, 'JSON_DESCRIPTOR'); plain(descriptor.value, depth + 1, budget);
  }
  if (Array.isArray(value)) check(Object.keys(value).length === value.length, 'SPARSE_ARRAY');
}
function bytes(value: Buffer, limit: number): Buffer { check(Buffer.isBuffer(value) && value.length > 0 && value.length <= limit, 'BYTES'); return Buffer.from(value); }
function json(value: Buffer, newline: boolean): Record<string, any> {
  const text = value.toString('utf8'); check(Buffer.from(text, 'utf8').equals(value), 'UTF8');
  const parsed = JSON.parse(text); plain(parsed); check(JSON.stringify(parsed, null, 2) + (newline ? '\n' : '') === text, 'JSON_ENCODING_OR_DUPLICATE'); return parsed;
}
function at(value: unknown): number {
  check(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'TIME'); return Date.parse(value);
}
function equal(actual: unknown, expected: unknown, label: string) { check(fz3bCanonicalJson(actual) === fz3bCanonicalJson(expected), label); }
function operation(value: Fz3bOperation, kind: 'build' | 'inspect') {
  shape(value, ['id', 'requestKey', 'nonce', 'kind', 'status', 'dispatchPhase', 'createdAt', 'updatedAt', 'processExited', 'remoteQuiescent', 'evidenceSha256'], kind === 'inspect' ? ['detail'] : []);
  check(id(value.id) && id(value.requestKey) && hash(value.nonce) && hash(value.evidenceSha256), 'OPERATION_BINDING');
  check(value.kind === kind && value.dispatchPhase === 'may-have-started' && value.processExited === true, 'OPERATION_DISPATCH');
  check(value.status === (kind === 'inspect' ? 'unknown' : 'succeeded') && value.remoteQuiescent === (kind === 'build'), 'ORIGINAL_STATUS');
  check(at(value.createdAt) <= at(value.updatedAt) && (kind !== 'inspect' || value.detail === hostFailure), 'OPERATION_DETAIL');
}

/**
 * Pure, unintegrated evidence classifier. It does not authenticate the supplied host anchor,
 * inspect a lease/process/board, establish current quiescence, or authorize any release.
 * The caller must authenticate and seal the original context independently before calling.
 */
export function verifyFz3bPreflightRefusal(input: Fz3bPreflightRefusalInput): Fz3bPreflightRefusalProof {
  shape(input, ['run', 'anchor', 'resources', 'files']); plain(input.run); plain(input.anchor);
  shape(input.anchor, ['owner', 'operationId', 'runSha256', 'operationSha256', 'evidenceSha256', 'intentSha256', 'transportSha256', 'actualCloseSha256']);
  const { run, anchor } = input;
  shape(anchor.owner, ['runId', 'sessionId', 'taskId', 'model', 'generation', 'threadId', 'turnId']);
  for (const name of ['runId', 'sessionId', 'taskId', 'threadId', 'turnId'] as const) check(id(anchor.owner[name]), 'OWNER_ID');
  check(anchor.owner.model === FZ3B_PROFILE.model && Number.isSafeInteger(anchor.owner.generation) && anchor.owner.generation > 0 && id(anchor.operationId), 'OWNER');
  for (const name of ['runSha256', 'operationSha256', 'evidenceSha256', 'intentSha256', 'transportSha256', 'actualCloseSha256'] as const) check(hash(anchor[name]), 'ANCHOR_HASH');
  check(Buffer.byteLength(fz3bCanonicalJson(run)) <= 2097152 && digest(run) === anchor.runSha256, 'SEALED_RUN_CHANGED');
  shape(run, ['schemaVersion', 'runId', 'sessionId', 'taskId', 'model', 'generation', 'threadId', 'turnId', 'profileId', 'profileSha256', 'status', 'phase',
    'active', 'hardwareBusy', 'stopRequested', 'nativeApproval', 'createdAt', 'updatedAt', 'calls', 'operations', 'artifact', 'failure'], ['instruction', 'currentTool']);
  const owner: Owner = { runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, model: run.model, generation: run.generation, threadId: run.threadId, turnId: run.turnId! };
  equal(owner, anchor.owner, 'FOREIGN_OWNER');
  check(run.schemaVersion === 1 && run.profileId === FZ3B_PROFILE.id && run.profileSha256 === FZ3B_PREFLIGHT_REFUSAL_PINS.profile &&
    FZ3B_PROFILE.bootId === FZ3B_PREFLIGHT_REFUSAL_PINS.oldBoot && run.status === 'needs_attention' && run.phase === 'needs_attention' &&
    run.active === false && run.hardwareBusy === true && run.stopRequested === true && run.nativeApproval === 'not_requested' && run.failure === hostFailure &&
    (run.currentTool === undefined || run.currentTool === 'fz3b_inspect') &&
    (run.instruction === undefined || typeof run.instruction === 'string' && run.instruction.length <= 12000 && !run.instruction.includes('\0')), 'HELD_INSPECT_ONLY');
  check(Array.isArray(run.operations) && run.operations.length === 2 && Array.isArray(run.calls) && run.calls.length === 3, 'OPERATION_OR_CALL_COUNT');
  const [build, inspect] = run.operations; operation(build, 'build'); operation(inspect, 'inspect');
  check(inspect.id === anchor.operationId && inspect.id !== build.id && inspect.nonce !== build.nonce && inspect.requestKey !== build.requestKey &&
    digest(inspect) === anchor.operationSha256 && inspect.evidenceSha256 === anchor.evidenceSha256, 'SEALED_OPERATION_CHANGED');
  const artifact = run.artifact!;
  shape(artifact, ['id', 'kind', 'buildId', 'profileSha256', 'sourceManifestSha256', 'fixtureManifestSha256', 'queriesSha256', 'imageSha256',
    'buildEvidenceSha256', 'packageSha256', 'packageManifestSha256', 'newPlBuilt', 'deployed']);
  const artifactBody = { kind: artifact.kind, buildId: artifact.buildId, profileSha256: artifact.profileSha256, sourceManifestSha256: artifact.sourceManifestSha256,
    fixtureManifestSha256: artifact.fixtureManifestSha256, queriesSha256: artifact.queriesSha256, imageSha256: artifact.imageSha256,
    buildEvidenceSha256: artifact.buildEvidenceSha256, packageSha256: artifact.packageSha256, packageManifestSha256: artifact.packageManifestSha256, newPlBuilt: artifact.newPlBuilt, deployed: artifact.deployed };
  check(artifact.id === fz3bDigest(JSON.stringify(artifactBody)) && artifact.kind === 'fixed-ps-fixture-package' && artifact.buildId === build.id && artifact.profileSha256 === run.profileSha256 &&
    artifact.sourceManifestSha256 === FZ3B_PROFILE.deployedManifestSha256 && artifact.fixtureManifestSha256 === FZ3B_PROFILE.semanticManifestSha256 &&
    artifact.queriesSha256 === FZ3B_PROFILE.queriesSha256 && artifact.imageSha256 === FZ3B_PROFILE.imageSha256 && artifact.buildEvidenceSha256 === build.evidenceSha256 &&
    hash(artifact.packageSha256) && hash(artifact.packageManifestSha256) && artifact.newPlBuilt === false && artifact.deployed === false, 'ARTIFACT');
  const tools = ['fz3b_status', 'fz3b_build', 'fz3b_inspect'];
  check(new Set(run.calls.map(call => call.callId)).size === 3, 'DUPLICATE_CALL');
  for (const [index, call] of run.calls.entries()) {
    shape(call, ['callId', 'tool', 'receivedAt', 'completedAt', 'status', 'result'], index === 0 ? [] : index === 1 ? ['operationId'] : ['operationId', 'error']);
    check(id(call.callId) && call.tool === tools[index] && call.status === (index === 2 ? 'unknown' : 'succeeded') && at(call.receivedAt) <= at(call.completedAt), 'CALL');
    const result = call.result!;
    shape(result, ['runId', 'callId', 'tool', 'ok', 'result', 'phase'], index === 0 ? [] : index === 1 ? ['operation', 'artifact'] : ['operation', 'message']);
    check(result.runId === run.runId && result.callId === call.callId && result.tool === call.tool && result.ok === (index !== 2) &&
      result.result === (index === 0 ? 'status' : index === 1 ? 'succeeded' : 'unknown') && result.phase === (index === 2 ? 'needs_attention' : 'ready'), 'CALL_RESULT');
    if (index > 0) { const op = index === 1 ? build : inspect; check(call.operationId === op.id, 'CALL_OPERATION'); equal(result.operation, op, 'CALL_OPERATION_CHANGED'); }
    if (index === 1) equal(result.artifact, artifact, 'CALL_ARTIFACT_CHANGED');
    if (index === 2) check(call.error === hostFailure && result.message === hostFailure, 'CALL_FAILURE');
  }
  shape(input.resources, ['manifest', 'remote', 'wire', 'fixture']);
  const resource = Object.fromEntries(Object.entries(input.resources).map(([name, value]) => [name, bytes(value, name === 'manifest' || name === 'fixture' ? 65536 : 1048576)])) as Fz3bPreflightRefusalInput['resources'];
  for (const name of ['manifest', 'remote', 'wire', 'fixture'] as const) check(fz3bDigest(resource[name]) === FZ3B_PREFLIGHT_REFUSAL_PINS[name], 'PINNED_RESOURCE_BYTES');
  const manifest = JSON.parse(resource.manifest.toString('utf8'));
  shape(manifest, ['schemaVersion', 'scope', 'sourceManifestSha256', 'files']);
  check(manifest.schemaVersion === 1 && manifest.scope === 'fixed-fz3b-product-resources-v1' && manifest.sourceManifestSha256 === FZ3B_PROFILE.deployedManifestSha256 &&
    Array.isArray(manifest.files) && manifest.files.length === 46, 'MANIFEST');
  for (const [name, relative] of [['remote', 'remote/remote.py'], ['wire', 'remote/wire.py'], ['fixture', 'fixture/host-fixture.json']] as const) {
    const listed = manifest.files.filter((file: { path: string }) => file.path === relative); check(listed.length === 1 && listed[0].sha256 === FZ3B_PREFLIGHT_REFUSAL_PINS[name] && listed[0].bytes === resource[name].length, 'MANIFEST_CODE_BINDING');
  }
  const fixture = JSON.parse(resource.fixture.toString('utf8')) as Fz3bSemanticFixture; validateFz3bFixture(fixture);
  check(fz3bProfileSha256(fixture) === run.profileSha256, 'PROFILE');
  const request = { schemaVersion: 1, action: 'inspect', operationId: inspect.id, nonce: inspect.nonce, profileSha256: run.profileSha256 };
  const payload = fixedFz3bPayload({ fixture, manifestSha256: FZ3B_PREFLIGHT_REFUSAL_PINS.manifest, files: new Map([['remote/remote.py', resource.remote], ['remote/wire.py', resource.wire]]) }, request);
  check(payload.length <= 1048576, 'PAYLOAD_BUDGET');
  shape(input.files, ['evidence', 'intent', 'transport', 'actualClose']);
  const files = Object.fromEntries(Object.entries(input.files).map(([name, value]) => [name, bytes(value, 131072)])) as Fz3bPreflightRefusalInput['files'];
  for (const name of ['evidence', 'intent', 'transport', 'actualClose'] as const) check(fz3bDigest(files[name]) === anchor[`${name}Sha256`], 'SEALED_FILE_CHANGED');
  const evidence = json(files.evidence, true), intent = json(files.intent, false), transport = json(files.transport, false), close = json(files.actualClose, false);
  shape(evidence, ['schemaVersion', 'operationId', 'nonce', 'profileSha256', 'action', 'transport', 'remoteStdout', 'remote', 'resourceManifestSha256', 'authenticatedTransport', 'helloAuthenticated']);
  shape(intent, ['schemaVersion', 'operationId', 'nonce', 'profileSha256', 'action', 'resourceManifestSha256', 'payloadSha256', 'dispatchPhase']);
  shape(transport, ['schemaVersion', 'operationId', 'nonce', 'profileSha256', 'action', 'resourceManifestSha256', 'observedAt', 'transport']);
  shape(close, ['schemaVersion', 'observedClose', 'exitCode', 'at', 'outputSha256']);
  for (const value of [evidence, intent, transport]) check(value.schemaVersion === 1 && value.operationId === inspect.id && value.nonce === inspect.nonce &&
    value.profileSha256 === run.profileSha256 && value.action === 'inspect' && value.resourceManifestSha256 === FZ3B_PREFLIGHT_REFUSAL_PINS.manifest, 'FILE_CONTEXT');
  check(intent.dispatchPhase === 'may-have-started' && intent.payloadSha256 === fz3bDigest(payload), 'RECONSTRUCTED_PAYLOAD');
  check(evidence.authenticatedTransport === 'pinned-ssh' && evidence.helloAuthenticated === false, 'TRANSPORT_KIND');
  const observed = evidence.transport;
  shape(observed, ['processExited', 'exitCode', 'timedOut', 'spawned', 'stdoutBytes', 'stdoutSha256', 'stderr']); equal(transport.transport, observed, 'TRANSPORT_CHANGED');
  check(observed.processExited === true && observed.exitCode === 0 && observed.timedOut === false && observed.spawned === true && observed.stderr === '', 'ACTUAL_TRANSPORT');
  check(typeof evidence.remoteStdout === 'string' && evidence.remoteStdout.endsWith('\n') && evidence.remoteStdout.trim().split('\n').length === 1, 'STDOUT_ENVELOPE');
  const stdout = Buffer.from(evidence.remoteStdout, 'utf8');
  check(stdout.length > 0 && stdout.length <= 131072 && observed.stdoutBytes === stdout.length && observed.stdoutSha256 === fz3bDigest(stdout), 'STDOUT_HASH');
  const remote = JSON.parse(evidence.remoteStdout);
  shape(remote, ['schemaVersion', 'operationId', 'nonce', 'profileSha256', 'status', 'remoteOutcomeUnknown', 'remoteQuiescent', 'detail']);
  check(evidence.remoteStdout === fz3bCanonicalJson(remote) + '\n', 'STDOUT_ENCODING_OR_DUPLICATE'); equal(evidence.remote, remote, 'REMOTE_CHANGED');
  check(remote.schemaVersion === 1 && remote.operationId === inspect.id && remote.nonce === inspect.nonce && remote.profileSha256 === run.profileSha256 && remote.status === 'failed' &&
    remote.detail === 'ValueError:boot-changed' && remote.remoteOutcomeUnknown === false && remote.remoteQuiescent === false, 'EXACT_PREFLIGHT_REFUSAL');
  check(close.schemaVersion === 1 && close.observedClose === true && close.exitCode === 0 && close.outputSha256 === fz3bDigest(stdout), 'ACTUAL_CLOSE');
  const originalCloseObservedAt = close.at, transportObservedAt = transport.observedAt;
  check(typeof originalCloseObservedAt === 'string' && typeof transportObservedAt === 'string', 'TIME');
  const timeline = [run.createdAt, run.calls[0].receivedAt, run.calls[0].completedAt, run.calls[1].receivedAt, build.createdAt, build.updatedAt,
    run.calls[1].completedAt, run.calls[2].receivedAt, inspect.createdAt, close.at, transport.observedAt, inspect.updatedAt, run.calls[2].completedAt, run.updatedAt].map(at);
  check(timeline.every((value, index) => index === 0 || value >= timeline[index - 1]), 'CHRONOLOGY');
  const body: Omit<Fz3bPreflightRefusalProof, 'proofSha256'> = {
    schemaVersion: 1, proofScope: 'exact-preflight-branch-only', classification: 'inspect-preflight-refusal-observed', owner: { ...owner }, ownerSha256: digest(owner),
    runSha256: anchor.runSha256, operationId: inspect.id, operationSha256: anchor.operationSha256, originalOperationStatus: 'unknown', originalUnknownPreserved: true,
    originalHardwareBusy: true, pins: FZ3B_PREFLIGHT_REFUSAL_PINS, files: { evidenceSha256: anchor.evidenceSha256, intentSha256: anchor.intentSha256, transportSha256: anchor.transportSha256, actualCloseSha256: anchor.actualCloseSha256 },
    requestSha256: fz3bDigest(JSON.stringify(request)), payloadSha256: fz3bDigest(payload), stdoutSha256: fz3bDigest(stdout), stdoutBytes: stdout.length,
    originalCloseObservedAt, transportObservedAt, closeEvidenceFormat: 'v1-observed-close-without-pid-or-process-args',
    inspectDeviceBranch: 'not-entered-by-this-bound-request', remoteQuiescence: 'not-established', newBootIdentity: 'not-observed-or-adopted',
    leaseDisposition: 'unchanged-not-authorized', releaseAuthority: 'none', integration: 'pure-unintegrated', limitations: [
      'The supplied anchor requires independent trusted-host sealing/authentication; matching self-reported hashes alone confer no trust.',
      'Pinned source control flow and captured local bytes are not remote-root or chip/loaded-image attestation.',
      'Only manifest, remote, wire and fixture bytes were supplied; other resource assets and the successful build are not independently revalidated.',
      'This close schema records observedClose/exitCode/output hash, not a PID, command-line identity or current process-tree census.',
      'No new boot identity, current board quiescence, recovery eligibility, lease release or future compute authorization is established.',
    ],
  };
  Object.freeze(body.owner); Object.freeze(body.files); Object.freeze(body.limitations);
  return Object.freeze({ ...body, proofSha256: digest(body) });
}
