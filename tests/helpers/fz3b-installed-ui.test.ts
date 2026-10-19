import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import FZ3BPanel, { HardwarePlatformTabs } from '../../apps/desktop/renderer/FZ3BPanel';
import App from '../../apps/desktop/renderer/App';
import { FZ3B_UI, fz3bInstalledUi } from './fz3b-installed-ui';
import { assertFz3bStartupIdle, connectFz3bInstalledStartup } from './fz3b-installed-startup';
import type { AppSnapshot } from '../../packages/shared/contracts';

function idle(engineState = 'stopped'): AppSnapshot {
  return { schemaVersion: 1, version: '0.5.0', projects: [], sessions: [], tasks: [], approvals: [], diagnostics: [], models: [],
    engine: { state: engineState, executable: 'fixture-only', home: 'fixture-only' }, account: { loggedIn: true, label: 'fixture-only' },
    hardware: { enabled: false, modeActive: false, reason: 'fixture-only' }, dataDir: 'fixture-only',
    fz3bAgent: { available: true, status: 'available', resourcesVerified: true, keyImportAllowed: true, engineState: 'stopped', runs: [] } };
}

test('actual renderer SSR markup makes the FZ3B platform a tab, never a button role', () => {
  const markup = renderToStaticMarkup(createElement(HardwarePlatformTabs, { platform: 'stm32', onChange() {} }));
  assert.equal(FZ3B_UI.platformRole, 'tab'); assert.match(markup, new RegExp(`role="tablist" aria-label="${FZ3B_UI.platformTabs}"`));
  const fz3b = markup.match(/<button\b[^>]*>[\s\S]*?FZ3B · Zynq<\/button>/)?.[0]; assert.ok(fz3b);
  const tabs = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const target = tabs.filter(item => item[2].includes(FZ3B_UI.platformTab)); assert.equal(target.length, 1);
  assert.match(target[0][1], new RegExp(`role="${FZ3B_UI.platformRole}"`)); assert.doesNotMatch(target[0][1], /role="button"/);
});

test('Windows slash-equivalent plan selects only the exact observed renderer project title', () => {
  const calls: Array<{ title: string; exact: boolean }> = [];
  const page: any = { getByRole: () => page, getByLabel: () => page, locator: () => page, filter: () => page, and: () => page,
    getByTitle: (title: string, options: { exact: boolean }) => { calls.push({ title, exact: options.exact }); return page; } };
  const ui = fz3bInstalledUi(page), observed = 'E:\\AiProject\\agent-design\\ForgeDesk-codex\\output\\hardware\\fz3b-project';
  ui.project({ root: observed }, 'E:/AiProject/agent-design/ForgeDesk-codex/output/hardware/fz3b-project');
  assert.deepEqual(calls, [{ title: observed, exact: true }]);
  ui.project({ root: 'E:/AiProject/agent-design/ForgeDesk-codex/output/hardware/fz3b-project' }, observed);
  assert.equal(calls[1].title, 'E:/AiProject/agent-design/ForgeDesk-codex/output/hardware/fz3b-project');
  assert.throws(() => ui.project({ root: observed + '-other' }, observed)); assert.equal(calls.length, 2);
});

test('actual renderer project button binds title to imported item.root, not a planned spelling', async () => {
  const filename = fileURLToPath(new URL('../../apps/desktop/renderer/App.tsx', import.meta.url));
  const text = await readFile(filename, 'utf8'), source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.JsxOpeningElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button') {
      const className = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(source) === 'className');
      if (className?.getText(source).includes('project-button')) matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source); assert.equal(matches.length, 1);
  const title = matches[0].attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(source) === 'title');
  assert.ok(title && ts.isJsxAttribute(title) && title.initializer && ts.isJsxExpression(title.initializer));
  assert.equal(title.initializer.expression?.getText(source), 'item.root'); assert.equal(FZ3B_UI.project, '.project-button');
});

test('actual App markup exposes the scoped task tablist and hardware workflow tab', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  try {
    const markup = renderToStaticMarkup(createElement(App));
    assert.match(markup, new RegExp(`role="tablist" aria-label="${FZ3B_UI.taskTabs}"`));
    const tabs = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter(item => item[2].includes(FZ3B_UI.taskTab));
    assert.equal(tabs.length, 1); assert.match(tabs[0][1], /role="tab"/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('actual fresh FZ3B panel markup matches region, instruction, pinned model and start accessibility labels', () => {
  const markup = renderToStaticMarkup(createElement(FZ3BPanel, { taskId: 'fixture-task', sessionId: 'fixture-session', state: idle().fz3bAgent,
    loggedIn: true, fresh: true, modeActive: false, softwareBusy: false, otherHardwareBusy: false, starting: false,
    onStart: async () => false, onStop() {} }));
  assert.match(markup, new RegExp(`<section[^>]*aria-label="${FZ3B_UI.region}"`));
  assert.match(markup, new RegExp(`<textarea[^>]*aria-label="${FZ3B_UI.instruction}"`));
  assert.match(markup, new RegExp(`<select[^>]*aria-label="${FZ3B_UI.model}"[^>]*disabled=""`));
  assert.match(markup, /<option value="gpt-6\.1-sol" selected="">/);
  assert.match(markup, new RegExp(`<button[^>]*aria-label="${FZ3B_UI.start}"[^>]*disabled=""`));
  assert.match(markup, /aria-busy="false" data-task-id="fixture-task" data-pending-intent=""/);
  // SSR has no API/effects. The actual control must stay disabled, never bypass its readiness gates.
});

test('stopped ordinary engine connects explicitly instead of waiting for optional auto-start', async () => {
  let state = idle(), connects = 0, waits = 0; const observations: unknown[] = [];
  const after = await connectFz3bInstalledStartup({ snapshot: async () => state,
    connect: async () => { connects++; state = idle('ready'); }, wait: async () => { waits++; }, observe: async item => { observations.push(item); } });
  assert.equal(after.engine.state, 'ready'); assert.equal(connects, 1); assert.equal(waits, 0); assert.equal(observations.length, 2);
});

test('real auto-start is allowed to settle before one explicit public account refresh', async () => {
  let state = idle('starting'), waits = 0, connects = 0, now = 0;
  await connectFz3bInstalledStartup({ snapshot: async () => state, now: () => now,
    wait: async ms => { waits++; now += ms; state = idle('ready'); },
    connect: async () => { connects++; assert.equal(state.engine.state, 'ready'); }, observe: async () => {} });
  assert.equal(waits, 1); assert.equal(connects, 1);
});

test('mode, active/no-run/unknown ownership, uncertain turns and failed engines never trigger connect', async () => {
  const mutations: Array<(state: AppSnapshot) => void> = [
    state => { state.hardware.modeActive = true; }, state => { state.fz3bAgent!.activeRunId = 'held'; },
    state => { state.fz3bAgent!.recoveryTaskId = 'no-run-held'; }, state => { state.fz3bAgent!.engineState = 'ready'; },
    state => { state.hardwareAgent = { engineState: 'ready', runs: [] }; },
    state => { state.sessions.push({ id: 's', taskId: 't', projectId: 'p', title: 'fixture', messages: [], status: 'needs_attention', engineUncertain: true }); },
    state => { state.approvals.push({ generation: 1, id: 1, method: 'fixture', params: {}, decisions: [] }); },
    state => { state.engine.state = 'failed'; }, state => { state.engine.state = 'stopping'; },
  ];
  for (const mutate of mutations) {
    const state = idle(); mutate(state); let connects = 0;
    await assert.rejects(connectFz3bInstalledStartup({ snapshot: async () => state, connect: async () => { connects++; }, wait: async () => {}, observe: async () => {} }));
    assert.equal(connects, 0);
  }
  const unknown = idle(); unknown.fz3bAgent!.runs = [{ active: false, hardwareBusy: false, nativeApproval: 'approved', operations: [{ status: 'unknown' }] } as any];
  assert.throws(() => assertFz3bStartupIdle(unknown));
});

test('starting timeout is bounded; only exact read-only routing timeout permits a second connection', async () => {
  let now = 0, connects = 0;
  await assert.rejects(connectFz3bInstalledStartup({ snapshot: async () => idle('starting'), timeoutMs: 150, now: () => now,
    wait: async ms => { now += ms; }, connect: async () => { connects++; }, observe: async () => {} }), /auto-start did not settle/);
  assert.equal(connects, 0);
  await connectFz3bInstalledStartup({ snapshot: async () => idle('ready'), wait: async () => {}, observe: async () => {},
    connect: async () => { connects++; if (connects === 1) throw new Error('Engine account/read: workspace routing discovery timed out'); } });
  assert.equal(connects, 2);
  connects = 0;
  await assert.rejects(connectFz3bInstalledStartup({ snapshot: async () => idle('ready'), wait: async () => {}, observe: async () => {},
    connect: async () => { connects++; throw new Error('unrelated failure'); } }), /unrelated failure/);
  assert.equal(connects, 1);
});
