import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { EmbeddedStatusView, FlashProgress, embeddedAvailability, flashTelemetry, selectFlashOperation } from './EmbeddedPanel';
import { EMBEDDED_PROGRESS_STAGES, type EmbeddedBuild, type EmbeddedOperation, type EmbeddedProgress, type EmbeddedStatus } from '../../../packages/engineering-runner/embedded/types';

const stamp = '2026-10-15T01:00:00Z';
const digest = 'a'.repeat(64);
const artifact: EmbeddedBuild = {
  id: 'fixture-artifact', buildId: 'fixture-build-42', hexPath: 'E:/fixture/firmware.hex', axfPath: 'E:/fixture/firmware.axf',
  hexSha256: digest, axfSha256: digest, sourceSha256: digest, profileSha256: digest, createdAt: stamp,
  sourceRoot: 'E:/fixture/source', projectSourceBefore: digest, projectSourceAfter: digest,
  snapshotSourceBefore: digest, snapshotSourceAfter: digest, files: [], toolHashes: {}, templateSha256: digest,
  logPath: 'E:/fixture/build.log', logSha256: digest, processExit: 0,
};
function operation(id: string, kind: EmbeddedOperation['kind'], status: EmbeddedOperation['status'] = 'succeeded'): EmbeddedOperation {
  return { id, requestKey: `fixture-key-${id}`, kind, status, argsDigest: digest, nonce: `fixture-nonce-${id}`, createdAt: stamp, updatedAt: stamp, artifactId: artifact.id, processExited: true };
}
function state(): EmbeddedStatus {
  return { configured: true, taskId: 'fixture-task', profileId: 'fixture-profile', profileSha256: digest,
    limitation: 'UI fixture only; no device was accessed', projectRoot: 'E:/fixture/source', artifact,
    operations: [operation('build', 'build'), operation('inspect', 'inspect')], hardwareAvailable: true };
}
function granted(): EmbeddedStatus {
  const current = state();
  current.grant = { id: 'fixture-grant', taskId: current.taskId, artifactId: artifact.id, buildId: artifact.buildId,
    hexSha256: artifact.hexSha256, axfSha256: artifact.axfSha256, sourceSha256: artifact.sourceSha256,
    profileId: current.profileId, profileSha256: current.profileSha256, backupSha256: digest,
    identity: { probeSerial: 'FIXTURE-PROBE', uid: 'FIXTURE-UID', chipId: 0, flashKiB: 0, cdcSerial: 'FIXTURE-CDC' },
    scope: 'flash-and-verify-once', approvedAt: stamp, expiresAt: new Date(Date.now() + 60000).toISOString() };
  return current;
}
function view(status: EmbeddedStatus | undefined, overrides: Partial<Parameters<typeof EmbeddedStatusView>[0]> = {}) {
  return renderToStaticMarkup(createElement(EmbeddedStatusView, { status, loading: false, readFailed: false, busy: false,
    available: true, modeActive: true, error: '', notice: '', refresh() {}, run() {}, ...overrides }));
}
function button(html: string, name: string) { return html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`))?.[0] || ''; }
function progressing(progress: Partial<EmbeddedProgress> = {}, status: EmbeddedOperation['status'] = 'running') {
  const current = state();
  const flash = operation('progress-flash', 'flash', status);
  flash.progress = { schemaVersion: 1, operationId: flash.id, action: 'flash', stage: 'erase_program', updatedAt: stamp, sequence: 1, ...progress };
  current.operations.push(flash);
  return { current, flash };
}

test('pending flash selects only its own request, never a previous result or another action', () => {
  const current = state();
  const previous = operation('old-flash', 'flash', 'unknown');
  current.operations.push(previous, operation('newer-inspection', 'inspect'));
  assert.equal(selectFlashOperation(current), previous);
  assert.equal(selectFlashOperation(current, 'flash', 'new-request'), undefined);
  assert.equal(selectFlashOperation(current, 'flash'), undefined);
  const accepted = { ...operation('new-flash', 'flash', 'running'), requestKey: 'new-request' };
  current.operations.push(accepted);
  assert.equal(selectFlashOperation(current, 'flash', 'new-request'), accepted);
  assert.equal(selectFlashOperation({ ...current, operations: [] }, 'flash', 'new-request'), undefined);
});

test('new flash intent scrolls its progress into view once, never on polling or terminal updates', () => {
  const source = ts.createSourceFile('EmbeddedPanel.tsx', readFileSync(new URL('./EmbeddedPanel.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'EmbeddedStatusView');
  assert.ok(component?.body);
  const effect = component.body.statements.find((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect');
  assert.ok(effect && ts.isCallExpression(effect.expression));
  const call = effect.expression;
  assert.equal(call.arguments[1].getText(source), '[intent, pendingRequestKey]');
  const calls: unknown[] = [];
  const refs = { progressRef: { current: null as null | { scrollIntoView(options: unknown): void } }, scrolledFlashRequest: { current: undefined as string | undefined } };
  const context = { ...refs, intent: 'inspect', pendingRequestKey: 'first-flash' as string | undefined };
  const invoke = runInNewContext(`(${call.arguments[0].getText(source)})`, context) as () => void;
  invoke(); assert.equal(calls.length, 0);
  context.intent = 'flash'; invoke(); assert.equal(calls.length, 0);
  refs.progressRef.current = { scrollIntoView: options => calls.push(options) };
  invoke(); assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { block: 'start', inline: 'nearest', behavior: 'auto' });
  invoke(); invoke(); assert.equal(calls.length, 1, 'Repeated rendering/polling of the same request cannot jump');
  context.pendingRequestKey = undefined; invoke(); assert.equal(calls.length, 1);
  context.pendingRequestKey = 'second-flash'; invoke(); assert.equal(calls.length, 2);
  context.intent = 'verify'; invoke(); assert.equal(calls.length, 2);
});

test('worker erase/program passes are Chinese and explicitly independent, not overall percentages', () => {
  const { flash } = progressing({ completed: 1, total: 2, unit: 'steps' });
  for (const [message, translated] of [['Erasing sectors', '擦除扇区'], ['Programming pages', '写入页面']]) {
    flash.progress!.message = message;
    const html = renderToStaticMarkup(createElement(FlashProgress, { operation: flash, pending: true, stale: false }));
    assert.match(html, new RegExp(translated));
    assert.match(html, /当前阶段 50%/);
    assert.match(html, /各阶段独立计数，不代表整体烧录进度/);
    assert.ok(!html.includes(message));
    assert.equal(flash.progress!.message, message, 'Retain original telemetry for the operation record');
  }
});

test('real stage counts produce a stage-only accessible percentage, not a manufactured overall result', () => {
  const { current, flash } = progressing({ completed: 3, total: 8, unit: 'bytes' });
  assert.equal(flashTelemetry(flash)?.percent, 37.5);
  const html = view(current);
  assert.match(html, /擦除与写入/); assert.match(html, /当前阶段 37.5%/);
  assert.match(html, /aria-valuenow="37.5"/); assert.match(html, /width:37.5%/);
  assert.match(html, /worker 当前阶段计数/); assert.doesNotMatch(html, /烧录操作已成功/);
  flash.progress!.completed = 0;
  assert.equal(flashTelemetry(flash)?.percent, 0);
  flash.progress!.completed = 7.999;
  assert.equal(flashTelemetry(flash)?.percent, 99.9, 'Do not round an unfinished stage up to 100%');
});

test('all contract stages have readable labels and missing or invalid counts stay indeterminate', () => {
  const { current, flash } = progressing();
  for (const stage of EMBEDDED_PROGRESS_STAGES) {
    flash.progress!.stage = stage;
    assert.ok(flashTelemetry(flash)?.stage);
  }
  for (const counts of [{}, { completed: 1 }, { completed: 1, total: 0, unit: 'bytes' }, { completed: -1, total: 8, unit: 'bytes' }, { completed: 9, total: 8, unit: 'bytes' }, { completed: Number.NaN, total: 8, unit: 'bytes' }, { completed: 1, total: Number.POSITIVE_INFINITY, unit: 'bytes' }, { completed: 1, total: 8 }, { completed: 1, total: 8, unit: 'fraction' }] as Partial<EmbeddedProgress>[]) {
    flash.progress = { schemaVersion: 1, operationId: flash.id, action: 'flash', stage: 'reset', updatedAt: stamp, sequence: 2, ...counts };
    assert.equal(flashTelemetry(flash)?.percent, undefined);
    const html = view(current);
    assert.match(html, /复位目标/); assert.match(html, /进度未知/);
    assert.doesNotMatch(html, /aria-valuenow=|width:[\d.]+%/);
  }
});

test('telemetry must match the operation, action and schema before being displayed', () => {
  const { current, flash } = progressing({ completed: 1, total: 1, unit: 'fraction' });
  const valid = flash.progress!;
  for (const changed of [{ operationId: 'another-operation' }, { action: 'inspect' }, { schemaVersion: 99 }, { sequence: -1 }, { updatedAt: 'bad-date' }, { stage: '<script>unknown-stage</script>' }]) {
    flash.progress = { ...valid, ...changed } as EmbeddedProgress;
    assert.equal(flashTelemetry(flash), undefined);
    const html = view(current);
    assert.match(html, /阶段未上报/); assert.doesNotMatch(html, /aria-valuenow=|<script>/);
  }
});

test('100 percent telemetry never overrides unknown, failed or running outcomes; flash error remains visible', () => {
  const { current, flash } = progressing({ completed: 1, total: 1, unit: 'fraction', message: '<img src=x onerror=bad()>' }, 'unknown');
  flash.detail = 'FlashFailure target was not halted after flash algorithm (IPSR=3)';
  let html = view(current);
  assert.match(html, /最后上报 100%/); assert.match(html, /写入结果尚未确认，未自动重试/);
  assert.match(html, /FlashFailure target was not halted after flash algorithm \(IPSR=3\)/);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x|烧录操作已成功/);
  assert.match(button(html, '授权并烧录'), /disabled/);
  flash.status = 'failed'; html = view(current);
  assert.match(html, /烧录失败，未自动重试/); assert.doesNotMatch(html, /烧录操作已成功/);
  flash.status = 'running'; html = view(current);
  assert.match(html, /当前阶段 100%/); assert.match(html, /设备操作尚未完成/);
  assert.doesNotMatch(html, /烧录操作已成功/);
  flash.status = 'succeeded'; html = view(current, { busy: true, intent: 'flash', pendingRequestKey: flash.requestKey });
  assert.match(html, /烧录操作已成功；实机验证单独记录/);
  assert.match(html, /正在等待本次调用返回/); assert.match(button(html, '授权并烧录'), /disabled/);
});

test('waiting for a new flash and a failed read never present stale progress as fresh', () => {
  const { current } = progressing({ completed: 1, total: 1, unit: 'fraction' }, 'unknown');
  let html = view(current, { busy: true, intent: 'flash', pendingRequestKey: 'new-request' });
  assert.match(html, /尚无本次烧录操作记录，未确认开始写入/);
  assert.doesNotMatch(html, /aria-valuenow=/);
  html = view(current, { readFailed: true });
  assert.match(html, /以上为上次记录，进度可能已变化/);
});

test('software mode permits explicit configure but never opens device write controls', () => {
  const gates = embeddedAvailability(state(), false, false, false);
  assert.equal(gates.configure, true);
  for (const name of ['build', 'inspect', 'flash', 'verify', 'export', 'recover', 'leave'] as const) assert.equal(gates[name], false);
  const html = view(state(), { modeActive: false });
  assert.match(html, /软件模式/); assert.match(button(html, '授权并烧录'), /disabled/);
  assert.match(html, /模型设备工具未开放/);
});

test('unknown result requires explicit service recovery even when its process has exited', () => {
  const current = state(); current.operations.push(operation('unknown-flash', 'flash', 'unknown'));
  const gates = embeddedAvailability(current, true, false, false);
  assert.equal(gates.unknown, true); assert.equal(gates.unresolved, true); assert.equal(gates.recover, true);
  assert.equal(gates.flash, false); assert.equal(gates.leave, false);
  const html = view(current);
  assert.match(html, /需人工核查/); assert.match(button(html, '授权并烧录'), /disabled/);
  assert.match(button(html, '返回软件模式'), /disabled/);
  assert.doesNotMatch(button(html, '核查进程退出'), /disabled/);
});

test('recovery preserves unknown history, allows mode exit and requires a newer inspection before another flash', () => {
  const current = state(); current.operations.push({ ...operation('unknown-flash', 'flash', 'unknown'), recoveredAt: stamp });
  let gates = embeddedAvailability(current, true, false, false);
  assert.equal(gates.unknown, true); assert.equal(gates.unresolved, false); assert.equal(gates.recover, false);
  assert.equal(gates.leave, true); assert.equal(gates.flash, false);
  const html = view(current);
  assert.match(html, /历史操作结果仍未知/); assert.match(html, /结果未知/);
  assert.doesNotMatch(button(html, '返回软件模式'), /disabled/);
  current.operations.push(operation('fresh-inspection', 'inspect'));
  gates = embeddedAvailability(current, true, false, false);
  assert.equal(gates.flash, true, 'The next flash still invokes the original native authorization API');
  assert.equal(gates.verify, false, 'Recovery never manufactures a successful flash or authorization');
});

test('flash needs matching historical build inputs and a new successful inspection after any earlier flash', () => {
  const current = state(); assert.equal(embeddedAvailability(current, true, false, false).flash, true);
  const changed = { ...current, artifact: { ...artifact, projectSourceAfter: 'changed-input' } };
  assert.equal(embeddedAvailability(changed, true, false, false).flash, false);
  assert.equal(embeddedAvailability({ ...current, artifact: { ...artifact, hexSha256: '' } }, true, false, false).flash, false);
  current.operations.push(operation('first-flash', 'flash'));
  assert.equal(embeddedAvailability(current, true, false, false).flash, false);
  current.operations.push(operation('new-inspection', 'inspect'));
  assert.equal(embeddedAvailability(current, true, false, false).flash, true);
});

test('verification requires a current approved grant bound to this exact artifact and successful flash', () => {
  const current = granted(); current.operations.push(operation('successful-flash', 'flash'));
  assert.equal(embeddedAvailability(current, true, false, false).verify, true);
  current.grant!.expiresAt = '2020-01-01T00:00:00Z';
  assert.equal(embeddedAvailability(current, true, false, false).verify, false);
  assert.match(view(current), /授权已过期/);
  current.operations.push(operation('new-inspection', 'inspect'));
  assert.equal(embeddedAvailability(current, true, false, false).flash, true, 'A new explicit native grant may be requested; the expired grant is not reused');
  current.grant!.expiresAt = new Date(Date.now() + 60000).toISOString(); current.grant!.artifactId = 'another-artifact';
  assert.equal(embeddedAvailability(current, true, false, false).verify, false);
  assert.match(view(current), /授权与当前产物不匹配/);
});

test('a pending original IPC intent keeps all commands disabled even with terminal status', () => {
  const html = view(state(), { busy: true, intent: 'flash' });
  assert.match(html, /aria-busy="true"/); assert.match(html, /data-pending-intent="flash"/);
  for (const name of ['配置工程', '固件构建', '设备检查', '授权并烧录', '实机验证', '导出证据', '返回软件模式']) assert.match(button(html, name), /disabled/);
  const unknown = state(); unknown.operations.push(operation('pending-unknown', 'flash', 'unknown'));
  assert.match(button(view(unknown, { busy: true, intent: 'recover' }), '核查进程退出'), /disabled/);
  const readFailure = view(state(), { readFailed: true });
  assert.match(button(readFailure, '授权并烧录'), /disabled/);
});

test('identities, hashes and receipts remain escaped text and no whole-task T2 success is manufactured', () => {
  const current = granted(); current.grant!.identity.uid = '<script>not-a-device</script>';
  current.operations.push({ ...operation('receipt', 'inspect'), receipt: '<img src=x onerror=bad()>' });
  const html = view(current);
  assert.match(html, /fixture-build-42/); assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>/); assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /T2.*通过|当前源码已验证/);
});
