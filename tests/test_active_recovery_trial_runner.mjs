import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { root, output, sha, canonical, phase1Policy, validatePlan, validateNativeFacts, nativeScriptSha256, main } from '../engineering/fz3b/tools/active_recovery_trial.mjs';

const runId = 'active-recovery-01234567-89ab-4cde-8fab-0123456789ab';
const relative = `${output}/${runId}/plan.json`;
const baselineFile = 'output/qa/2026-10-16-fz3b-051/fz3b-installed-1792159422714-b14c06/evidence.json';
const sourceFile = 'engineering/fz3b/tools/active_recovery_trial.py';
function fixture() {
  const policy = phase1Policy(); const files = new Map();
  for (const filename of [...Object.keys(policy.sourcePins), sourceFile, baselineFile]) files.set(filename, fs.readFileSync(path.join(root, filename)));
  const report = JSON.parse(files.get(baselineFile)); const run = report.run; const operation = run.operations.find(op => op.kind === 'semantic');
  const source = files.get(sourceFile); const script = Buffer.concat([source.subarray(0, source.indexOf(Buffer.from('\nif __name__ == '))),
    Buffer.from("\nraise SystemExit('PHASE1_EXECUTION_DISABLED: no runtime adapter/finalization/quarantine')\n")]);
  const plan = { schemaVersion: 1, method: 'fz3b-active-recovery-maintenance-v1', runId, action: 'upload-cancel',
    jobId: 'fd-recovery-0123456789ab4cde8fab0123456789ab', bootId: '5ceb45a3-8903-4efc-9484-ec75c17280df',
    appRoot: '/root/fz3b-vision-console-20261009-001', endpoint: { host: '127.0.0.1', port: 8765 }, fixture: policy.fixture,
    baseline: { relativeFile: baselineFile, sha256: sha(files.get(baselineFile)), operationId: operation.id, nonce: operation.nonce, grantId: run.grant.id,
      profileSha256: run.profileSha256, semanticSha256: sha(canonical(run.semantic)), jobId: run.semantic.jobId, queryRevision: run.semantic.queryRevision, completedFrames: 1 },
    sourcePins: policy.sourcePins, toolSha256: sha(source), stdinRelativeFile: `${output}/${runId}/phase1-disabled.py`, stdinSha256: sha(script),
    nativeApprovalRequired: true, automaticRetry: false, changesPL: false, mayPrepareExistingCandidate: true, statusMayWriteR5Telemetry: true,
    executionEnabled: false, blocker: policy.blockers.join(';'), executionBlockers: policy.blockers,
    crossEntrypointDurableQuarantineImplemented: false, strictFinalizationImplemented: false,
    purpose: 'independent-native-qa-not-product-grant', executed: false };
  files.set(plan.stdinRelativeFile, script); files.set(relative, Buffer.concat([canonical(plan), Buffer.from('\n')]));
  const read = (filename, limit) => { assert.ok(files.has(filename), filename); const raw = files.get(filename); assert.ok(raw.length <= limit); return raw; };
  return { plan, files, read };
}

function nativeFixture(plan) {
  const now = Date.parse('2026-10-17T00:01:00.000Z');
  const intent = { schemaVersion: 1, method: 'fz3b-active-recovery-native-v1', purpose: 'independent-native-qa-not-product-grant',
    runId: plan.runId, action: plan.action, jobId: plan.jobId, planRelativeFile: relative, planSha256: 'a'.repeat(64),
    approvalId: 'abcdefab-cdef-4abc-8def-abcdefabcdef', approvalNonce: 'b'.repeat(64), issuedAt: '2026-10-17T00:00:00.0000000+00:00',
    expiresAt: '2026-10-17T00:05:00.0000000+00:00', ttlSeconds: 300, scriptSha256: nativeScriptSha256 };
  const raw = canonical(intent);
  const receipt = { ...intent, intentSha256: sha(raw), approved: true, acknowledged: true, decision: 'approve', decidedAt: '2026-10-17T00:00:30.0000000+00:00',
    ui: { framework: 'WinForms', dialogShown: true, processId: 123, windowHandle: '456', defaultDecision: 'cancel', ackInitiallyChecked: false, buttonClickObserved: true } };
  return { now, raw, receipt };
}

test('phase1 verifies exact public baseline, pins and byte-reconstructed disabled template offline', () => {
  const f = fixture(); assert.equal(validatePlan(f.plan, relative, f.read), f.plan);
  assert.equal(main(['--plan', relative], f.read).executionEnabled, false);
});

test('plan cannot broaden action, fixture, endpoint, lease gates or source set', () => {
  const f = fixture();
  for (const change of [p => { p.action = 'stop'; }, p => { p.fixture.imageCount = 2; }, p => { p.endpoint.host = 'example.com'; },
    p => { p.executionEnabled = true; }, p => { p.blocker = null; }, p => { p.crossEntrypointDurableQuarantineImplemented = true; },
    p => { p.automaticRetry = true; }, p => { p.sourcePins.extra = '0'.repeat(64); }, p => { p.jobId = 'existing-job'; },
    p => { p.baseline.queryRevision++; }, p => { p.baseline.operationId = 'other'; }]) {
    const plan = structuredClone(f.plan); change(plan); assert.throws(() => validatePlan(plan, relative, f.read));
  }
});

test('arbitrary stdin cannot masquerade as a disabled template by updating its hash', () => {
  const f = fixture(); f.files.set(f.plan.stdinRelativeFile, Buffer.from('print("not the reviewed template")\n'));
  f.plan.stdinSha256 = sha(f.files.get(f.plan.stdinRelativeFile)); assert.throws(() => validatePlan(f.plan, relative, f.read));
});

test('modified baseline or sources are rejected rather than looking for a newer successful job', () => {
  const f = fixture(); f.files.set(baselineFile, Buffer.from('{}'));
  assert.throws(() => validatePlan(f.plan, relative, f.read));
  const g = fixture(); const name = Object.keys(g.plan.sourcePins)[0]; g.files.set(name, Buffer.from('changed'));
  assert.throws(() => validatePlan(g.plan, relative, g.read));
});

test('all execution requests fail before any plan, native receipt, key or transport read', () => {
  let reads = 0;
  assert.throws(() => main(['--plan', relative, '--execute-reviewed', 'a'.repeat(64)], () => { reads++; throw new Error('must not read'); }), /PHASE1_EXECUTION_DISABLED/);
  assert.equal(reads, 0);
});

test('duplicate or unknown plan fields cannot pass the dry entry', () => {
  const f = fixture(); const raw = Buffer.from('{"schemaVersion":1,"schemaVersion":1}\n');
  assert.throws(() => main(['--plan', relative], () => raw));
  f.plan.extra = null; assert.throws(() => validatePlan(f.plan, relative, f.read));
});

test('native fact validator preserves exact absolute five-minute TTL and never grants execution', () => {
  const f = fixture(); const n = nativeFixture(f.plan);
  const result = validateNativeFacts(f.plan, relative, 'a'.repeat(64), n.raw, n.receipt, n.now);
  assert.equal(result.validFactsOnly, true); assert.equal(result.executionAuthorized, false);
});

test('native refusal, unknown UI, unchecked box, changed binding or script fail fact validation', () => {
  const f = fixture();
  for (const change of [r => { r.approved = false; }, r => { r.acknowledged = false; }, r => { r.decision = 'cancel'; },
    r => { r.action = 'tcp-close'; }, r => { r.jobId = 'other'; }, r => { r.planSha256 = 'c'.repeat(64); },
    r => { r.scriptSha256 = '0'.repeat(64); }, r => { r.ui.dialogShown = false; }, r => { r.ui.buttonClickObserved = false; },
    r => { r.ui.ackInitiallyChecked = true; }, r => { r.ui.windowHandle = '0'; }, r => { r.extra = true; }]) {
    const n = nativeFixture(f.plan); change(n.receipt);
    assert.throws(() => validateNativeFacts(f.plan, relative, 'a'.repeat(64), n.raw, n.receipt, n.now));
  }
});

test('queued or late decision cannot reset TTL, and intent byte changes are refused', () => {
  const f = fixture(); const n = nativeFixture(f.plan);
  assert.throws(() => validateNativeFacts(f.plan, relative, 'a'.repeat(64), n.raw, n.receipt, n.now + 300000));
  assert.throws(() => validateNativeFacts(f.plan, relative, 'a'.repeat(64), Buffer.concat([n.raw, Buffer.from(' ')]), n.receipt, n.now));
  n.receipt.decidedAt = '2026-10-17T00:05:00.0000000+00:00';
  assert.throws(() => validateNativeFacts(f.plan, relative, 'a'.repeat(64), n.raw, n.receipt, n.now));
});

test('native source pin still matches the separate empty-allowlist approval script', () => {
  assert.equal(sha(fs.readFileSync(path.join(root, 'scripts/fz3b-recovery-native-approval.ps1'))), nativeScriptSha256);
});
