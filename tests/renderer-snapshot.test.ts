import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvidenceRecord, SnapshotPanel, snapshotBuildRetryKey } from '../apps/desktop/renderer/SnapshotPanel';
import { AcceptanceEditor } from '../apps/desktop/renderer/App';
import type { TaskView } from '../packages/shared/contracts';

const emptyTask: TaskView = { id: 'ui-test', status: 'draft', acceptance: [], operations: [], evidence: [] };
const profile = { id: 'forgedesk.node-software.v1', revision: 3, nodeExecutable: 'C:/trusted/node.exe', isolation: { verifiedAt: '2026-10-14T12:00:00Z', method: 'test-isolation-record' } };
function panel(task: TaskView, props: Partial<{ enabling: boolean; building: boolean; busy: boolean; unavailable: boolean }> = {}) {
  return renderToStaticMarkup(createElement(SnapshotPanel, { task, enabling: false, building: false, busy: false, unavailable: false, onEnable() {}, onBuild() {}, ...props }));
}
function button(markup: string, name: string): string { return markup.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`))?.[0] || ''; }

test('snapshot setup names only the supported arithmetic template and never invents verification', () => {
  const html = panel(emptyTask);
  assert.match(html, /Node 算术示例 v1/); assert.match(html, /numbers\.mjs · average 算术示例/);
  assert.match(html, /尚无 B 级证据/); assert.doesNotMatch(html, /已验证/);
  assert.ok(button(html, '启用快照模板')); assert.doesNotMatch(button(html, '启用快照模板'), /disabled/);
  assert.equal(button(html, '快照构建'), '');
});

test('only a supported stored profile with a recorded probe enables snapshot building', () => {
  const html = panel({ ...emptyTask, snapshotProfile: profile });
  assert.match(html, /forgedesk\.node-software\.v1/); assert.match(html, /C:\/trusted\/node\.exe/);
  assert.match(html, /隔离探针：已验证/); assert.doesNotMatch(button(html, '快照构建'), /disabled/);
  assert.equal(button(html, '启用快照模板'), '');
  const missingProbe = panel({ ...emptyTask, snapshotProfile: { ...profile, isolation: {} } });
  assert.match(missingProbe, /隔离探针：未记录/); assert.match(button(missingProbe, '快照构建'), /disabled/); assert.doesNotMatch(missingProbe, /已验证/);
  const unknown = panel({ ...emptyTask, snapshotProfile: { ...profile, id: 'another.template' } });
  assert.match(unknown, /未支持的快照模板/); assert.match(button(unknown, '快照构建'), /disabled/);
});

test('busy or disconnected states disable commands without showing a fabricated profile', () => {
  assert.match(button(panel(emptyTask, { enabling: true }), '启用快照模板'), /disabled/);
  assert.match(button(panel(emptyTask, { busy: true }), '启用快照模板'), /disabled/);
  assert.match(button(panel(emptyTask, { unavailable: true }), '启用快照模板'), /disabled/);
  assert.match(button(panel({ ...emptyTask, snapshotProfile: profile }, { building: true }), '快照构建'), /disabled/);
  assert.match(button(panel({ ...emptyTask, snapshotProfile: profile }, { busy: true }), '快照构建'), /disabled/);
});

test('evidence retains its real level and missing B metadata remains visible', () => {
  const a = renderToStaticMarkup(createElement(EvidenceRecord, { evidence: { evidenceLevel: 'A', result: 'passed', inputDigest: 'old-a' } }));
  assert.match(a, /A · 通过/); assert.doesNotMatch(a, /B 级任务快照证据/);
  const b = renderToStaticMarkup(createElement(EvidenceRecord, { evidence: { evidenceLevel: 'B', result: 'stale', snapshotId: 'snapshot-42', snapshot: { id: 'snapshot-42', manifestDigest: 'manifest-42' }, inputDigest: 'input-42' } }));
  assert.match(b, /B · 证据过期/); assert.match(b, /snapshot-42/); assert.match(b, /manifest-42/); assert.match(b, /B 级任务快照证据/);
  const missing = renderToStaticMarkup(createElement(EvidenceRecord, { evidence: { evidenceLevel: 'B', result: 'unknown', inputDigest: 'incomplete' } }));
  assert.match(missing, /B · 待核验/); assert.match(missing, /快照元数据未记录/);
});

test('profile and evidence text remain escaped, including URLs and model-like HTML', () => {
  const html = panel({ ...emptyTask, snapshotProfile: { ...profile, nodeExecutable: '<img src=x onerror=alert(1)> https://example.test' } });
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/); assert.doesNotMatch(html, /<a /);
  const evidence = renderToStaticMarkup(createElement(EvidenceRecord, { evidence: { evidenceLevel: 'B', result: 'failed', snapshotId: '<script>bad</script>', snapshot: { id: '<script>bad</script>' } } }));
  assert.match(evidence, /&lt;script&gt;/); assert.doesNotMatch(evidence, /<script>/);
});

test('fixed snapshot acceptance cannot be edited or deleted by the acceptance editor', () => {
  const html = renderToStaticMarkup(createElement(AcceptanceEditor, { task: { ...emptyTask, acceptance: [
    { id: 'snapshot-software', title: 'Protected snapshot verifier', kind: 'automated', status: 'pending' },
    { id: 'ordinary', title: 'Ordinary check', kind: 'manual', status: 'pending' },
  ] }, save: async () => true, done() {} }));
  assert.match(html, /不可编辑或删除/); assert.match(html, /value="Ordinary check"/);
  assert.doesNotMatch(html, /value="Protected snapshot verifier"/);
  assert.equal((html.match(/aria-label="删除验收/g) || []).length, 1);
});

test('uncertain snapshot retries retain their scope only for the same task and profile revision/digest', () => {
  const configured = { ...emptyTask, snapshotProfile: { ...profile, profileDigest: 'profile-digest-3' } };
  const original = snapshotBuildRetryKey(configured);
  assert.equal(snapshotBuildRetryKey(structuredClone(configured)), original);
  assert.notEqual(snapshotBuildRetryKey({ ...configured, snapshotProfile: { ...configured.snapshotProfile, revision: 4 } }), original);
  assert.notEqual(snapshotBuildRetryKey({ ...configured, snapshotProfile: { ...configured.snapshotProfile, profileDigest: 'updated-policy-digest' } }), original);
  assert.notEqual(snapshotBuildRetryKey({ ...configured, id: 'different-task' }), original);
  assert.notEqual(snapshotBuildRetryKey(emptyTask), original);
});
