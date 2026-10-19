import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FZ3B_PROFILE, fz3bCanonicalJson, fz3bDigest } from './profile.js';
import { fixedFz3bPayload } from './payload.js';
import { FZ3B_PREFLIGHT_REFUSAL_PINS as pins, verifyFz3bPreflightRefusal, type Fz3bPreflightRefusalInput } from './preflight-refusal-proof.js';
import type { Fz3bArtifact, Fz3bOperation, Fz3bRunView } from './types.js';

const resource = (name: string) => readFileSync(new URL(`../../../engineering/fz3b/product/resources/${name}`, import.meta.url));
const actualResources = { manifest: resource('manifest.json'), remote: resource('remote/remote.py'), wire: resource('remote/wire.py'), fixture: resource('fixture/host-fixture.json') };
const digest = (value: unknown) => fz3bDigest(fz3bCanonicalJson(value));
const encode = (value: unknown, newline = false) => Buffer.from(JSON.stringify(value, null, 2) + (newline ? '\n' : ''));
const hostFailure = 'Error: FZ3B receipt is not terminal and quiescent';
function seal(input: Fz3bPreflightRefusalInput) {
  input.anchor.runSha256 = digest(input.run); input.anchor.operationSha256 = digest(input.run.operations[1]);
  for (const name of ['evidence', 'intent', 'transport', 'actualClose'] as const) input.anchor[`${name}Sha256`] = fz3bDigest(input.files[name]);
}
function rebindEvidence(input: Fz3bPreflightRefusalInput) {
  input.run.operations[1].evidenceSha256 = fz3bDigest(input.files.evidence);
  input.run.calls[2].result!.operation = structuredClone(input.run.operations[1]); seal(input);
}
function rewrite(input: Fz3bPreflightRefusalInput, name: keyof Fz3bPreflightRefusalInput['files'], mutate: (value: any) => void) {
  const value = JSON.parse(input.files[name].toString()); mutate(value); input.files[name] = encode(value, name === 'evidence'); rebindEvidence(input);
}
function rewriteStdout(input: Fz3bPreflightRefusalInput, change: (remote: any) => void, text?: (value: string) => string) {
  const evidence = JSON.parse(input.files.evidence.toString()); change(evidence.remote);
  evidence.remoteStdout = (text ?? (value => value))(fz3bCanonicalJson(evidence.remote) + '\n');
  evidence.remote = JSON.parse(evidence.remoteStdout);
  evidence.transport.stdoutBytes = Buffer.byteLength(evidence.remoteStdout); evidence.transport.stdoutSha256 = fz3bDigest(evidence.remoteStdout);
  const transport = JSON.parse(input.files.transport.toString()); transport.transport = structuredClone(evidence.transport);
  const close = JSON.parse(input.files.actualClose.toString()); close.outputSha256 = evidence.transport.stdoutSha256;
  input.files.evidence = encode(evidence, true); input.files.transport = encode(transport); input.files.actualClose = encode(close); rebindEvidence(input);
}

/** Public 48ea12 IDs/worker bytes, with an explicitly synthetic host-sealed run fixture. No private ledger or native execution. */
function fixture(): Fz3bPreflightRefusalInput {
  const owner = { runId: '07427a29-0eae-44c7-ac35-34d6650eebee', sessionId: '9309dc73-fb48-4d29-9226-c5496ca2640d',
    taskId: '9309dc73-fb48-4d29-9226-c5496ca2640d', model: 'gpt-6.1-sol', generation: 1792223279715745,
    threadId: '01a148d5-03a5-7911-ab77-08888c07e2a2', turnId: '01a148d5-0884-7d03-9e9d-de97bd68a3b8' };
  const build: Fz3bOperation = { id: 'f5ac2cc5-2dbe-49f1-8145-34873c48c368', requestKey: 'fz3b-7ff9e036050785693c3e10ca3ee8f1c7af3fe66e017014979463909c39936f09',
    nonce: '538b861dce966cb516d2e50ce63fb9e453b69d2740a4b99cea802956ce8aa765', kind: 'build', status: 'succeeded', dispatchPhase: 'may-have-started',
    createdAt: '2026-10-17T07:48:08.268Z', updatedAt: '2026-10-17T07:48:08.385Z', processExited: true, remoteQuiescent: true,
    evidenceSha256: 'e95ce95945e6aa1fd0eadc2e2232a54fa961c6f35a8d590f5dead924a70a92f0' };
  const inspect: Fz3bOperation = { id: 'c6a3e027-abd8-40f7-b64e-d1b8e1a4620b', requestKey: 'fz3b-ef051ca6640a7af7815e4383af2d972b448021d603e0712a6157d18d5bb96de7',
    nonce: '4d67dddacca4e468e6870c9df3c75601e11b6c9cbf10ec477b4181d5a0ac3d49', kind: 'inspect', status: 'unknown', dispatchPhase: 'may-have-started',
    createdAt: '2026-10-17T07:48:10.779Z', updatedAt: '2026-10-17T07:48:12.466Z', processExited: true, remoteQuiescent: false,
    evidenceSha256: '0'.repeat(64), detail: hostFailure };
  const body = { kind: 'fixed-ps-fixture-package' as const, buildId: build.id, profileSha256: pins.profile,
    sourceManifestSha256: FZ3B_PROFILE.deployedManifestSha256, fixtureManifestSha256: FZ3B_PROFILE.semanticManifestSha256,
    queriesSha256: FZ3B_PROFILE.queriesSha256, imageSha256: FZ3B_PROFILE.imageSha256, buildEvidenceSha256: build.evidenceSha256!,
    packageSha256: 'ec1d60ae621e74d341fd393c9e5cc846b0e7b2075f4b4bfcd47cbcbaaa6a6f94',
    packageManifestSha256: 'cb177831310e29ef6f60117a093a4292fdd5e7887e72696bc1da379f86c1deb8', newPlBuilt: false as const, deployed: false as const };
  const artifact: Fz3bArtifact = { id: fz3bDigest(JSON.stringify(body)), ...body };
  const run: Fz3bRunView = { ...owner, schemaVersion: 1, profileId: FZ3B_PROFILE.id, profileSha256: pins.profile, status: 'needs_attention', phase: 'needs_attention',
    active: false, hardwareBusy: true, stopRequested: true, nativeApproval: 'not_requested', createdAt: '2026-10-17T07:48:03.313Z', updatedAt: '2026-10-17T07:48:12.473Z',
    calls: [
      { callId: 'call_status', tool: 'fz3b_status', receivedAt: '2026-10-17T07:48:06.024Z', completedAt: '2026-10-17T07:48:06.024Z', status: 'succeeded',
        result: { runId: owner.runId, callId: 'call_status', tool: 'fz3b_status', ok: true, result: 'status', phase: 'ready' } },
      { callId: 'call_build', tool: 'fz3b_build', receivedAt: '2026-10-17T07:48:07.206Z', completedAt: '2026-10-17T07:48:08.385Z', status: 'succeeded', operationId: build.id,
        result: { runId: owner.runId, callId: 'call_build', tool: 'fz3b_build', ok: true, result: 'succeeded', phase: 'ready', operation: structuredClone(build), artifact: structuredClone(artifact) } },
      { callId: 'call_inspect', tool: 'fz3b_inspect', receivedAt: '2026-10-17T07:48:09.739Z', completedAt: '2026-10-17T07:48:12.466Z', status: 'unknown', operationId: inspect.id,
        error: hostFailure, result: { runId: owner.runId, callId: 'call_inspect', tool: 'fz3b_inspect', ok: false, result: 'unknown', phase: 'needs_attention', operation: structuredClone(inspect), message: hostFailure } },
    ], operations: [build, inspect], currentTool: 'fz3b_inspect', artifact, failure: hostFailure };
  const remoteStdout = fz3bCanonicalJson({ schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile,
    status: 'failed', remoteQuiescent: false, remoteOutcomeUnknown: false, detail: 'ValueError:boot-changed' }) + '\n';
  const transport = { processExited: true, exitCode: 0, timedOut: false, spawned: true, stdoutBytes: Buffer.byteLength(remoteStdout), stdoutSha256: fz3bDigest(remoteStdout), stderr: '' };
  const context = { schemaVersion: 1, operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile, action: 'inspect' };
  const payload = fixedFz3bPayload({ manifestSha256: pins.manifest, fixture: JSON.parse(actualResources.fixture.toString()), files: new Map([
    ['remote/remote.py', actualResources.remote], ['remote/wire.py', actualResources.wire] ]) },
    { schemaVersion: 1, action: 'inspect', operationId: inspect.id, nonce: inspect.nonce, profileSha256: pins.profile });
  const input: Fz3bPreflightRefusalInput = { run, anchor: { owner, operationId: inspect.id, runSha256: '', operationSha256: '', evidenceSha256: '', intentSha256: '', transportSha256: '', actualCloseSha256: '' },
    resources: Object.fromEntries(Object.entries(actualResources).map(([name, bytes]) => [name, Buffer.from(bytes)])) as Fz3bPreflightRefusalInput['resources'], files: {
      evidence: encode({ ...context, transport, remoteStdout, remote: JSON.parse(remoteStdout), resourceManifestSha256: pins.manifest, authenticatedTransport: 'pinned-ssh', helloAuthenticated: false }, true),
      intent: encode({ ...context, resourceManifestSha256: pins.manifest, payloadSha256: fz3bDigest(payload), dispatchPhase: 'may-have-started' }),
      transport: encode({ ...context, resourceManifestSha256: pins.manifest, observedAt: '2026-10-17T07:48:12.457Z', transport }),
      actualClose: encode({ schemaVersion: 1, observedClose: true, exitCode: 0, at: '2026-10-17T07:48:12.457Z', outputSha256: fz3bDigest(remoteStdout) }),
    } };
  rebindEvidence(input); return input;
}

test('exact pinned public 48ea12 worker bytes classify only the inspect preflight branch without changing original unknown', () => {
  const input = fixture(); const before = fz3bCanonicalJson(input.run), rawFiles = Object.fromEntries(Object.entries(input.files).map(([name, value]) => [name, Buffer.from(value)]));
  const proof = verifyFz3bPreflightRefusal(input);
  assert.equal(proof.payloadSha256, '09f9c9ff2e43d9fdfee736ea54f7f3f4cf29d7558c9d6f2d96e2270c1d62faaa');
  assert.deepEqual(proof.files, { evidenceSha256: '85e658c19cebd39040ed2352948aaadb1b5612443a0b879456bb6744079d2a72',
    intentSha256: '0f88e4eeeebf5ac13db8827ee2978631c4a1025211082f64847e31d1b544d2fd', transportSha256: '49e4cb0f9e3901319cd6e4576a4f477864880e1ed884908ed412dcb168f594fe',
    actualCloseSha256: '1acea923364eae8d5c2bfa48e6dd58c1ee3fdb527930b23f71061f09cba9d6ef' });
  assert.equal(proof.stdoutSha256, '65898b69d81d3cc1ca903fb7e91606156e4a1f30fe3f95cde00e29752b7f1002'); assert.equal(proof.stdoutBytes, 337);
  assert.equal(proof.proofScope, 'exact-preflight-branch-only'); assert.equal(proof.originalOperationStatus, 'unknown'); assert.equal(proof.originalUnknownPreserved, true);
  assert.equal(proof.remoteQuiescence, 'not-established'); assert.equal(proof.newBootIdentity, 'not-observed-or-adopted'); assert.equal(proof.releaseAuthority, 'none');
  assert.equal(proof.integration, 'pure-unintegrated'); assert.equal(proof.closeEvidenceFormat, 'v1-observed-close-without-pid-or-process-args');
  for (const field of ['status', 'releaseAllowed', 'lockReleased', 'newBootId', 'currentQuiescent']) assert.equal(Object.hasOwn(proof, field), false);
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.owner) && Object.isFrozen(proof.files) && Object.isFrozen(proof.limitations));
  assert.equal(fz3bCanonicalJson(input.run), before); assert.deepEqual(input.files, rawFiles);
  const { proofSha256, ...body } = proof; assert.equal(proofSha256, digest(body));
});

for (const name of ['manifest', 'remote', 'wire', 'fixture'] as const) test(`actual ${name} bytes must match fixed pins rather than self-reported hashes`, () => {
  const input = fixture(); input.resources[name] = Buffer.concat([input.resources[name], Buffer.from('\n# altered')]);
  assert.throws(() => verifyFz3bPreflightRefusal(input), /PINNED_RESOURCE_BYTES/);
});

for (const name of ['runSha256', 'operationSha256', 'evidenceSha256', 'intentSha256', 'transportSha256', 'actualCloseSha256'] as const) test(`host-sealed ${name} mismatch is refused`, () => {
  const input = fixture(); input.anchor[name] = 'f'.repeat(64); assert.throws(() => verifyFz3bPreflightRefusal(input));
});

for (const field of ['runId', 'sessionId', 'taskId', 'threadId', 'turnId', 'model', 'generation'] as const) test(`foreign owner ${field} cannot be substituted`, () => {
  const input = fixture(); (input.anchor.owner as any)[field] = field === 'generation' ? input.anchor.owner.generation + 1 : 'foreign-owner';
  assert.throws(() => verifyFz3bPreflightRefusal(input));
});

test('a rewritten original run or operation is refused without a new trusted host anchor', () => {
  const run = fixture(); run.run.updatedAt = '2026-10-17T07:48:13.000Z'; assert.throws(() => verifyFz3bPreflightRefusal(run), /SEALED_RUN_CHANGED/);
  const op = fixture(); op.run.operations[1].detail = 'rewritten'; assert.throws(() => verifyFz3bPreflightRefusal(op), /SEALED_RUN_CHANGED/);
});

for (const bad of ['grant', 'identity', 'semantic', 'export', 'reconciliations', 'maintenanceExit'] as const) test(`even resealed ${bad} records do not qualify for never-authorized inspect refusal`, () => {
  const input = fixture(); (input.run as any)[bad] = {}; seal(input); assert.throws(() => verifyFz3bPreflightRefusal(input));
});

for (const bad of ['active', 'released', 'approved', 'semantic-op', 'second-unknown', 'extra-call', 'retry-call', 'result-op', 'result-extra', 'not-string-owner'] as const) test(`resealed ${bad} state remains unsupported`, () => {
  const input = fixture();
  if (bad === 'active') input.run.active = true;
  if (bad === 'released') input.run.hardwareBusy = false;
  if (bad === 'approved') input.run.nativeApproval = 'approved';
  if (bad === 'semantic-op') input.run.operations[1].kind = 'semantic';
  if (bad === 'second-unknown') input.run.operations.push({ ...input.run.operations[1], id: 'second-op' });
  if (bad === 'extra-call') input.run.calls.push({ ...input.run.calls[2], callId: 'new-call', tool: 'fz3b_request_semantic' });
  if (bad === 'retry-call') input.run.calls[2].status = 'replayed';
  if (bad === 'result-op') input.run.calls[2].result!.operation!.nonce = 'f'.repeat(64);
  if (bad === 'result-extra') (input.run.calls[2].result as any).semantic = {};
  if (bad === 'not-string-owner') { (input.anchor.owner as any).runId = null; (input.run as any).runId = null; }
  seal(input); assert.throws(() => verifyFz3bPreflightRefusal(input));
});

for (const bad of ['action', 'nonce', 'manifest', 'payload', 'dispatch', 'extra-field'] as const) test(`resealed intent ${bad} cannot replace reconstructed fixed inspect payload`, () => {
  const input = fixture(); rewrite(input, 'intent', value => {
    if (bad === 'action') value.action = 'semantic'; if (bad === 'nonce') value.nonce = 'f'.repeat(64);
    if (bad === 'manifest') value.resourceManifestSha256 = '951b6ec48562e56b67b158c237b2f0317e3cd9f965db981e78d2a003c2675dfa';
    if (bad === 'payload') value.payloadSha256 = 'f'.repeat(64); if (bad === 'dispatch') value.dispatchPhase = 'not-started'; if (bad === 'extra-field') value.grant = {};
  }); assert.throws(() => verifyFz3bPreflightRefusal(input));
});

for (const bad of ['other-error', 'unknown-outcome', 'quiescent', 'success', 'identity', 'semantic', 'nonce'] as const) test(`fully rehashed remote ${bad} is not the exact preflight refusal`, () => {
  const input = fixture(); rewriteStdout(input, remote => {
    if (bad === 'other-error') remote.detail = 'ValueError:device-not-idle'; if (bad === 'unknown-outcome') remote.remoteOutcomeUnknown = true;
    if (bad === 'quiescent') remote.remoteQuiescent = true; if (bad === 'success') remote.status = 'succeeded';
    if (bad === 'identity') remote.identity = { bootId: 'new-boot-must-not-be-adopted' }; if (bad === 'semantic') remote.semantic = {};
    if (bad === 'nonce') remote.nonce = 'f'.repeat(64);
  }); assert.throws(() => verifyFz3bPreflightRefusal(input));
});

test('fully rehashed duplicate JSON keys or extra stdout lines are rejected', () => {
  const duplicate = fixture(); rewriteStdout(duplicate, () => {}, text => text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
  assert.throws(() => verifyFz3bPreflightRefusal(duplicate), /STDOUT_ENCODING_OR_DUPLICATE/);
  const extra = fixture(), evidence = JSON.parse(extra.files.evidence.toString()); evidence.remoteStdout += '{}\n';
  evidence.transport.stdoutBytes = Buffer.byteLength(evidence.remoteStdout); evidence.transport.stdoutSha256 = fz3bDigest(evidence.remoteStdout);
  extra.files.evidence = encode(evidence, true); rewrite(extra, 'transport', value => { value.transport = evidence.transport; });
  rewrite(extra, 'actualClose', value => { value.outputSha256 = evidence.transport.stdoutSha256; });
  assert.throws(() => verifyFz3bPreflightRefusal(extra), /STDOUT_ENVELOPE/);
  const worker = fixture(); worker.files.intent = Buffer.from(worker.files.intent.toString().replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "schemaVersion": 1,'));
  rebindEvidence(worker); assert.throws(() => verifyFz3bPreflightRefusal(worker), /JSON_ENCODING_OR_DUPLICATE/);
});

for (const bad of ['missing', 'exit-only', 'not-observed', 'wrong-output', 'nonzero', 'extra-pid', 'before-created'] as const) test(`actual close ${bad} is refused even with exit-like evidence`, () => {
  const input = fixture();
  if (bad === 'missing') input.files.actualClose = Buffer.alloc(0);
  else rewrite(input, 'actualClose', value => {
    if (bad === 'exit-only') delete value.observedClose; if (bad === 'not-observed') value.observedClose = false;
    if (bad === 'wrong-output') value.outputSha256 = 'f'.repeat(64); if (bad === 'nonzero') value.exitCode = 1;
    if (bad === 'extra-pid') value.pid = 1234; if (bad === 'before-created') value.at = '2026-10-17T07:00:00.000Z';
  }); seal(input); assert.throws(() => verifyFz3bPreflightRefusal(input));
});

for (const bad of ['timeout', 'not-exited', 'not-spawned', 'stderr', 'hash', 'count', 'transport-mismatch'] as const) test(`transport ${bad} cannot establish the limited local observation`, () => {
  const input = fixture(); rewrite(input, 'evidence', value => {
    if (bad === 'timeout') value.transport.timedOut = true; if (bad === 'not-exited') value.transport.processExited = false;
    if (bad === 'not-spawned') value.transport.spawned = false; if (bad === 'stderr') value.transport.stderr = 'unexpected output';
    if (bad === 'hash') value.transport.stdoutSha256 = 'f'.repeat(64); if (bad === 'count') value.transport.stdoutBytes++;
  });
  if (bad !== 'transport-mismatch') rewrite(input, 'transport', value => { value.transport = JSON.parse(input.files.evidence.toString()).transport; });
  else rewrite(input, 'transport', value => { value.transport.stdoutBytes++; });
  assert.throws(() => verifyFz3bPreflightRefusal(input));
});

test('new boot adoption, accessors and unbounded byte inputs are not accepted as proof extensions', () => {
  const boot = fixture(); (boot.anchor as any).newBootId = 'another-boot'; assert.throws(() => verifyFz3bPreflightRefusal(boot), /KEYS/);
  const getter = fixture(); let called = false; Object.defineProperty(getter.run, 'instruction', { enumerable: true, get() { called = true; throw new Error('must not execute'); } });
  assert.throws(() => verifyFz3bPreflightRefusal(getter), /JSON_DESCRIPTOR/); assert.equal(called, false);
  const huge = fixture(); huge.files.evidence = Buffer.alloc(131073); assert.throws(() => verifyFz3bPreflightRefusal(huge), /BYTES/);
});

test('implementation is pure and unintegrated, with no runtime/backend/process/file actions imported', () => {
  const source = readFileSync(new URL('./preflight-refusal-proof.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:from|import\()\s*['"](?:node:(?:fs|child_process|net|http|https)|\.\/backend|\.\/worker|\.\/reconciliation-worker)/);
  assert.doesNotMatch(source, /\b(?:unlink|spawn|execFile|finalizeInspectReconciliation|releaseAllowed)\s*\(/);
});
