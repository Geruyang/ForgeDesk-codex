// Phase 1: offline verification only. Deliberately no child-process/network imports.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const output = 'output/qa/2026-10-17-fz3b-recovery';
export const nativeScriptSha256 = 'efed1b1dffb3fc364c0a3ffe741c6b0d97814290edc090351d2cba21c1c2619b';
const METHOD = 'fz3b-active-recovery-maintenance-v1';
const BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df';
const APP = '/root/fz3b-vision-console-20261009-001';
const PROFILE = '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd';
const BLOCKERS = ['STRICT_FINALIZATION_NOT_IMPLEMENTED', 'CROSS_ENTRYPOINT_DURABLE_QUARANTINE_NOT_IMPLEMENTED'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const RUN = /^active-recovery-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const PINS = {
  'engineering/fz3b/product/resources/manifest.json': 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07',
  'engineering/fz3b/product/resources/remote/remote.py': '7a675f09af5973e6fa69ad832a424df06ed7b9f04b45ed3ebd2b5c2851faf516',
  'engineering/fz3b/product/resources/remote/wire.py': '460bae822a42262c610541ef5e2b45423e588d3b43e749327a98aed8cc818710',
  'engineering/fz3b/product/resources/ps-src/vision_app/board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
  'engineering/fz3b/product/resources/ps-src/vision_app/board_runtime.py': 'd637298882c6f65a172e07e8c7ed65a816c49922e005a567f633c5d4364eb95e',
  'engineering/fz3b/product/resources/ps-src/vision_app/protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
  'engineering/fz3b/product/resources/ps-src/vision_app/upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
  'engineering/fz3b/product/resources/ps-src/vision_app/r5_bridge.py': 'c1695156be3ab7622dcd9af91824606da3600f1d1fd0fac7206e7fd49d93642d',
};
const FIXTURE = {
  id: 'fz3b-pillow-scene-v1', imageCount: 1, width: 914, height: 512,
  manifestSha256: 'febcb9d93517f3c98eadb5d98eea6808f243fb6a1d4b61215cd981503de98e56',
  queriesSha256: '0d10e566bb1c167d3987e8d782f1c0c6f87ee3c1aaba9983afe1f8a134e106e9',
  imageSha256: '06dd779d1450c835255833be19c84f6636c2de99313713d80c850fa572c25967',
  queryIds: ['pillow', 'cup', 'mobile-phone', 'bottle'],
  encoderIdentity: { contractId: '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e', normalization: 'l2-float32-v1',
    weightSha256: '1270fab6ea23bacbd61cea564bd521a7e875fdb0fcb6d31382bccf4d973b71a6',
    bpeSha256: '924691ac288e54409236115652ad4aa250f48203de50a9e4722a6ecd48d6804a' },
};
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const sha = raw => createHash('sha256').update(raw).digest('hex');
export const canonical = value => Buffer.from(JSON.stringify(sorted(value)));
const exact = (value, keys) => assert.deepEqual(Object.keys(value ?? {}).sort(), [...keys].sort());
export const phase1Policy = () => structuredClone({ sourcePins: PINS, fixture: FIXTURE, blockers: BLOCKERS });

export function readPublic(relative, limit) {
  assert.ok(typeof relative === 'string' && !path.isAbsolute(relative) && !relative.includes('\\'));
  let filename = root;
  for (const part of relative.split('/')) {
    assert.ok(part && part !== '.' && part !== '..'); filename = path.join(filename, part);
    const info = fs.lstatSync(filename); assert.equal(info.isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(filename).toLowerCase(), filename.toLowerCase());
  }
  const before = fs.statSync(filename); assert.ok(before.isFile() && before.nlink === 1 && before.size <= limit);
  const fd = fs.openSync(filename, 'r');
  try {
    const identity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    const held = fs.fstatSync(fd); assert.deepEqual(identity(before), identity(held));
    const raw = fs.readFileSync(fd); assert.ok(raw.length <= limit && raw.length === before.size);
    assert.deepEqual(identity(held), identity(fs.fstatSync(fd))); assert.deepEqual(identity(before), identity(fs.lstatSync(filename))); return raw;
  } finally { fs.closeSync(fd); }
}

export function validatePlan(plan, relative, read = readPublic) {
  exact(plan, ['schemaVersion', 'method', 'runId', 'action', 'jobId', 'bootId', 'appRoot', 'endpoint', 'fixture', 'baseline', 'sourcePins',
    'toolSha256', 'stdinRelativeFile', 'stdinSha256', 'nativeApprovalRequired', 'automaticRetry', 'changesPL', 'mayPrepareExistingCandidate',
    'statusMayWriteR5Telemetry', 'executionEnabled', 'blocker', 'executionBlockers', 'crossEntrypointDurableQuarantineImplemented',
    'strictFinalizationImplemented', 'purpose', 'executed']);
  assert.equal(plan.schemaVersion, 1); assert.equal(plan.method, METHOD); assert.match(plan.runId, RUN);
  assert.ok(['upload-cancel', 'tcp-close'].includes(plan.action));
  assert.equal(relative, `${output}/${plan.runId}/plan.json`);
  assert.equal(plan.jobId, `fd-recovery-${plan.runId.slice('active-recovery-'.length).replaceAll('-', '')}`);
  assert.equal(plan.bootId, BOOT); assert.equal(plan.appRoot, APP); assert.deepEqual(plan.endpoint, { host: '127.0.0.1', port: 8765 });
  assert.deepEqual(plan.fixture, FIXTURE); assert.deepEqual(plan.sourcePins, PINS);
  assert.equal(plan.nativeApprovalRequired, true); assert.equal(plan.automaticRetry, false); assert.equal(plan.changesPL, false);
  assert.equal(plan.mayPrepareExistingCandidate, true); assert.equal(plan.statusMayWriteR5Telemetry, true);
  assert.equal(plan.executionEnabled, false); assert.equal(plan.blocker, BLOCKERS.join(';')); assert.deepEqual(plan.executionBlockers, BLOCKERS);
  assert.equal(plan.crossEntrypointDurableQuarantineImplemented, false); assert.equal(plan.strictFinalizationImplemented, false);
  assert.equal(plan.purpose, 'independent-native-qa-not-product-grant'); assert.equal(plan.executed, false);
  assert.equal(plan.stdinRelativeFile, `${output}/${plan.runId}/phase1-disabled.py`);
  assert.match(plan.stdinSha256, HEX); assert.match(plan.toolSha256, HEX);
  for (const [name, pin] of Object.entries(PINS)) assert.equal(sha(read(name, 1048576)), pin);
  const source = read('engineering/fz3b/tools/active_recovery_trial.py', 131072);
  assert.equal(sha(source), plan.toolSha256);
  const cliStart = source.indexOf(Buffer.from('\nif __name__ == ')); assert.ok(cliStart > 0);
  const template = Buffer.concat([source.subarray(0, cliStart), Buffer.from("\nraise SystemExit('PHASE1_EXECUTION_DISABLED: no runtime adapter/finalization/quarantine')\n")]);
  const stdin = read(plan.stdinRelativeFile, 131072); assert.equal(sha(stdin), plan.stdinSha256); assert.deepEqual(stdin, template);
  const baseline = plan.baseline;
  exact(baseline, ['relativeFile', 'sha256', 'operationId', 'nonce', 'grantId', 'profileSha256', 'semanticSha256', 'jobId', 'queryRevision', 'completedFrames']);
  assert.ok(baseline.relativeFile.startsWith('output/qa/2026-10-16-fz3b-051/') || baseline.relativeFile.startsWith(`${output}/`));
  assert.ok(baseline.relativeFile.endsWith('/evidence.json')); assert.match(baseline.sha256, HEX);
  const raw = read(baseline.relativeFile, 4 * 1048576); assert.equal(sha(raw), baseline.sha256);
  const report = JSON.parse(raw); const run = report.run;
  assert.equal(report.result, 'passed'); assert.deepEqual(report.failures, []); assert.deepEqual(report.pageErrors, []);
  assert.equal(run.active, false); assert.equal(run.hardwareBusy, false); assert.equal(run.profileSha256, PROFILE);
  assert.ok(Array.isArray(run.operations) && run.operations.length <= 16 && run.operations.every(op => op.status === 'succeeded' && op.processExited === true && op.remoteQuiescent === true));
  const semantics = run.operations.filter(op => op.kind === 'semantic'); assert.equal(semantics.length, 1);
  assert.match(semantics[0].id, UUID); assert.match(semantics[0].nonce, HEX); assert.match(run.grant.id, UUID);
  assert.equal(baseline.operationId, semantics[0].id); assert.equal(baseline.nonce, semantics[0].nonce);
  assert.equal(baseline.grantId, run.grant.id); assert.equal(run.grant.consumedBy, semantics[0].id);
  assert.equal(baseline.profileSha256, PROFILE); assert.equal(run.grant.profileSha256, PROFILE); assert.equal(run.nativeApproval, 'approved');
  assert.equal(baseline.semanticSha256, sha(canonical(run.semantic))); assert.equal(baseline.jobId, run.semantic.jobId);
  assert.equal(baseline.jobId, `fd-semantic-${baseline.operationId.replaceAll('-', '')}`);
  assert.ok(Number.isSafeInteger(baseline.queryRevision) && baseline.queryRevision > 0); assert.equal(baseline.queryRevision, run.semantic.queryRevision);
  assert.equal(baseline.completedFrames, 1); assert.equal(run.semantic.completedFrames, 1);
  assert.equal(run.semantic.inferenceStopped, true); assert.equal(run.semantic.synthetic, false); assert.equal(run.semantic.newPlLoaded, false);
  assert.equal(run.semantic.semanticInput, 'real-text-encoder'); assert.deepEqual(run.semantic.encoderIdentity, FIXTURE.encoderIdentity);
  for (const [key, fixed] of [['fixtureManifestSha256', 'manifestSha256'], ['queriesSha256', 'queriesSha256'], ['imageSha256', 'imageSha256']]) assert.equal(run.semantic[key], FIXTURE[fixed]);
  assert.equal(run.identity.bootId, BOOT); assert.equal(run.identity.appRoot, APP); assert.equal(run.identity.contractId, FIXTURE.encoderIdentity.contractId);
  assert.equal(run.identity.deployedManifestSha256, 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09');
  assert.equal(run.identity.existingPlSha256, '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726');
  return plan;
}

// Fact validation is not authentication and never enables execution in phase 1.
export function validateNativeFacts(plan, planRelativeFile, planSha256, intentRaw, receipt, now = Date.now()) {
  const intent = JSON.parse(intentRaw);
  const common = ['schemaVersion', 'method', 'purpose', 'runId', 'action', 'jobId', 'planRelativeFile', 'planSha256', 'approvalId', 'approvalNonce',
    'issuedAt', 'expiresAt', 'ttlSeconds', 'scriptSha256'];
  exact(intent, common); exact(receipt, [...common, 'intentSha256', 'approved', 'acknowledged', 'decision', 'decidedAt', 'ui']);
  for (const name of common) assert.deepEqual(receipt[name], intent[name]);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.method, 'fz3b-active-recovery-native-v1');
  assert.equal(receipt.purpose, 'independent-native-qa-not-product-grant');
  assert.equal(receipt.runId, plan.runId); assert.equal(receipt.action, plan.action); assert.equal(receipt.jobId, plan.jobId);
  assert.equal(receipt.planRelativeFile, planRelativeFile); assert.equal(receipt.planSha256, planSha256); assert.equal(receipt.scriptSha256, nativeScriptSha256);
  assert.match(receipt.approvalId, UUID); assert.match(receipt.approvalNonce, HEX); assert.equal(receipt.intentSha256, sha(intentRaw));
  assert.equal(receipt.approved, true); assert.equal(receipt.acknowledged, true); assert.equal(receipt.decision, 'approve'); assert.equal(receipt.ttlSeconds, 300);
  for (const field of ['issuedAt', 'expiresAt', 'decidedAt']) assert.match(receipt[field], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}(?:Z|\+00:00)$/);
  const issued = Date.parse(receipt.issuedAt), expires = Date.parse(receipt.expiresAt), decided = Date.parse(receipt.decidedAt);
  assert.ok(Number.isFinite(issued) && Number.isFinite(expires) && Number.isFinite(decided) && expires - issued === 300000 &&
    issued <= decided && decided < expires && issued <= now && decided <= now && now < expires, 'Native absolute TTL is invalid or expired');
  exact(receipt.ui, ['framework', 'dialogShown', 'processId', 'windowHandle', 'defaultDecision', 'ackInitiallyChecked', 'buttonClickObserved']);
  assert.equal(receipt.ui.framework, 'WinForms'); assert.equal(receipt.ui.dialogShown, true); assert.equal(receipt.ui.buttonClickObserved, true);
  assert.equal(receipt.ui.defaultDecision, 'cancel'); assert.equal(receipt.ui.ackInitiallyChecked, false);
  assert.ok(Number.isSafeInteger(receipt.ui.processId) && receipt.ui.processId > 0); assert.match(receipt.ui.windowHandle, /^[1-9][0-9]{0,19}$/);
  return { validFactsOnly: true, executionAuthorized: false, absoluteExpiresAt: receipt.expiresAt };
}

export function refuseExecution() {
  throw new Error('PHASE1_EXECUTION_DISABLED: strict finalization, durable cross-entrypoint quarantine and runtime adapter are not implemented');
}

export function main(argv = process.argv.slice(2), read = readPublic) {
  assert.ok(argv.length === 2 || argv.length === 4); assert.equal(argv[0], '--plan');
  // A real execution request is refused before reading a receipt/key or invoking any seam.
  if (argv.length === 4) { assert.equal(argv[2], '--execute-reviewed'); refuseExecution(); }
  const raw = read(argv[1], 65536); const plan = JSON.parse(raw);
  assert.equal(Buffer.concat([canonical(plan), Buffer.from('\n')]).equals(raw), true, 'Plan must be canonical duplicate-free JSON');
  validatePlan(plan, argv[1], read);
  return { result: 'prepared-offline-execution-disabled', runId: plan.runId, action: plan.action,
    planSha256: sha(raw), executionEnabled: false, executed: false, blockers: BLOCKERS };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main())); }
  catch (error) { console.error(String(error?.message ?? error)); process.exitCode = 1; }
}
