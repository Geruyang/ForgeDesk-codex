import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import type { AppSnapshot } from '../packages/shared/contracts';
import type { Fz3bRunView } from '../packages/engineering-runner/fz3b/types';
import { FZ3B_HOST_KEY_SHA256, FZ3B_PROFILE, fz3bDigest, fz3bProfileSha256 } from '../packages/engineering-runner/fz3b/profile';
import type { Fz3b051Plan } from './helpers/fz3b-051-installed';
import { assertCancelDispatch, assertCancelDrained, verifyCancelExport } from './helpers/fz3b-cancel-installed';

const fixture = JSON.parse(await readFile(new URL('../engineering/fz3b/product/resources/fixture/host-fixture.json', import.meta.url), 'utf8'));
const plan = { model: 'gpt-6.1-sol', fixture } as Fz3b051Plan;
function running(): Fz3bRunView {
  const run: Fz3bRunView = { schemaVersion: 1, runId: 'pure-run', taskId: 'pure-task', sessionId: 'pure-session', threadId: 'pure-thread', turnId: 'pure-turn', generation: 1,
    model: 'gpt-6.1-sol', profileId: FZ3B_PROFILE.id, profileSha256: fz3bProfileSha256(fixture), status: 'active', phase: 'semantic', active: true, hardwareBusy: true,
    stopRequested: false, nativeApproval: 'approved', currentTool: 'fz3b_semantic', createdAt: '2026-10-17T00:00:00.000Z', updatedAt: '2026-10-17T00:00:10.000Z', operations: [], calls: [] };
  run.operations = (['build', 'inspect', 'semantic'] as const).map((kind, index) => ({ id: `${index + 1}0000000-0000-4000-8000-000000000000`, kind,
    requestKey: `fz3b-${fz3bDigest(`${run.runId}:fz3b_${kind}`)}`, nonce: String(index + 1).repeat(64), status: index === 2 ? 'running' : 'succeeded',
    dispatchPhase: 'may-have-started', ...(index < 2 ? { processExited: true, remoteQuiescent: true } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt }));
  run.grant = { id: 'pure-grant', runId: run.runId, taskId: run.taskId, sessionId: run.sessionId, consumedBy: run.operations[2].id, fixture } as Fz3bRunView['grant'];
  run.identity = { hostKeySha256: FZ3B_HOST_KEY_SHA256, bootId: FZ3B_PROFILE.bootId, appRoot: FZ3B_PROFILE.appRoot, platform: 'A0005',
    contractId: fixture.encoderIdentity.contractId, deployedManifestSha256: FZ3B_PROFILE.deployedManifestSha256, existingPlSha256: FZ3B_PROFILE.existingPlSha256, transport: 'pinned-ssh', helloAuthenticated: false };
  run.calls = (['fz3b_status', 'fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic', 'fz3b_semantic'] as const).map((tool, index) => ({ callId: `pure-call-${index}`, tool,
    receivedAt: run.createdAt, status: index === 4 ? 'running' : 'succeeded', operationId: run.operations.find(op => tool === `fz3b_${op.kind}`)?.id,
    ...(index < 4 ? { result: { runId: run.runId, callId: `pure-call-${index}`, tool, ok: true, result: 'succeeded' as const, phase: 'ready' as const } } : {}) }));
  return run;
}
function drained(before = running()) {
  const run = structuredClone(before); run.active = false; run.hardwareBusy = false; run.stopRequested = true; run.status = 'stopped'; run.phase = 'stopped';
  const op = run.operations[2]; Object.assign(op, { status: 'succeeded', processExited: true, remoteQuiescent: true, evidenceSha256: 'a'.repeat(64), updatedAt: '2026-10-17T00:00:20.000Z' });
  run.semantic = { jobId: `fd-semantic-${op.id.replaceAll('-', '')}`, inferenceStopped: true, semanticInput: 'real-text-encoder', synthetic: false, completedFrames: 1,
    fixtureManifestSha256: fixture.manifestSha256, queriesSha256: fixture.queriesSha256, imageSha256: fixture.imageSha256, encoderIdentity: fixture.encoderIdentity, newPlLoaded: false } as Fz3bRunView['semantic'];
  run.calls[4].status = 'succeeded'; run.calls[4].result = { runId: run.runId, callId: run.calls[4].callId, tool: 'fz3b_semantic', ok: true, result: 'succeeded', phase: 'stopped', operation: structuredClone(op), semantic: structuredClone(run.semantic) };
  return run;
}
function state(run: Fz3bRunView): AppSnapshot { return { fz3bAgent: { engineState: 'stopped', runs: [run] }, sessions: [{ id: run.sessionId, status: 'interrupted' }] } as AppSnapshot; }
const stopAt = Date.parse('2026-10-17T00:00:12.000Z');
test('only durable same fixed semantic dispatch can trigger a one-shot UI stop', () => {
  assert.equal(assertCancelDispatch(running(), plan).kind, 'semantic');
  for (const mutate of [
    (r: Fz3bRunView) => { r.operations[2].status = 'prepared'; }, (r: Fz3bRunView) => { r.operations[2].status = 'succeeded'; },
    (r: Fz3bRunView) => { r.grant!.consumedBy = 'wrong'; }, (r: Fz3bRunView) => { r.calls[0].status = 'failed'; },
    (r: Fz3bRunView) => { r.operations[2].requestKey = 'wrong'; }, (r: Fz3bRunView) => { r.stopRequested = true; },
    (r: Fz3bRunView) => { r.calls.push({ ...r.calls[0], tool: 'fz3b_export' }); },
  ]) { const r = running(); mutate(r); assert.throws(() => assertCancelDispatch(r, plan)); }
});
test('planner stop alone, local engine exit and unknown cannot establish original worker drain', () => {
  const before = running(), after = drained(before); assertCancelDrained(before, after, state(after), stopAt);
  for (const mutate of [
    (r: Fz3bRunView) => { r.hardwareBusy = true; }, (r: Fz3bRunView) => { r.operations[2].remoteQuiescent = false; },
    (r: Fz3bRunView) => { r.operations[2].processExited = false; }, (r: Fz3bRunView) => { r.operations[2].status = 'unknown'; },
    (r: Fz3bRunView) => { r.operations[2].status = 'failed'; }, (r: Fz3bRunView) => { r.calls.push({ ...r.calls[0], tool: 'fz3b_export' }); },
    (r: Fz3bRunView) => { r.grant!.consumedBy = 'different'; }, (r: Fz3bRunView) => { r.operations[2].nonce = 'b'.repeat(64); },
    (r: Fz3bRunView) => { r.semantic!.synthetic = true as false; },
  ]) { const r = drained(before); mutate(r); assert.throws(() => assertCancelDrained(before, r, state(r), stopAt)); }
  const held = state(after); held.fz3bAgent!.activeRunId = after.runId; assert.throws(() => assertCancelDrained(before, after, held, stopAt));
  assert.throws(() => assertCancelDrained(before, after, state(after), Date.parse('2026-10-17T00:00:21.000Z')));
});
test('local export refuses paths outside the exact per-run snapshot parent before reads', async () => {
  await assert.rejects(verifyCancelExport('E:/pure-data', 'E:/foreign/path', drained(), plan));
});
test('new harness retains original native path and uses exactly one actual UI Stop, never an API stop or replay', async () => {
  const text = await readFile(new URL('./fz3b-051-cancel-smoke.ts', import.meta.url), 'utf8');
  assert.ok(text.includes("name: '停止 FZ3B 模型任务', exact: true")); assert.ok(text.includes('await stop.click({ timeout: 10000 })'));
  assert.equal((text.match(/await stop\.click\(/g) ?? []).length, 1); assert.ok(text.includes('assertCancelDispatch(current, plan)'));
  assert.equal(/window\.forgeDesk\.(?:fz3bAgentStop|fz3bRecover|fz3bReconcileInspect)\(/.test(text), false);
  assert.ok(text.includes('installFz3bNativeObserver')); assert.ok(text.includes('readFz3bCancelStopObserver'));
  assert.ok(text.includes('verifyFz3b051PlanBytes')); assert.ok(text.includes("mode === '--preflight-only'"));
  assert.ok(text.includes('assertFz3bNoReplay(run, restored)')); assert.equal(text.includes('SIGKILL'), false);
});
