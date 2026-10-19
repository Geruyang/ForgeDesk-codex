import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import App from './App';

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('./App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function compile(text: string) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
function saved(raw: string) {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'readSaved');
  assert.ok(declaration);
  return runInNewContext(`${compile(declaration.getText(source))}\nreadSaved();`, { STORAGE_KEY: 'fixture', localStorage: { getItem: () => raw } });
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function subscriptionEffect(context: Record<string, unknown>) {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
  const effect = declaration?.body?.statements.find((node): node is ts.ExpressionStatement => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === 'useEffect');
  assert.ok(effect && ts.isCallExpression(effect.expression));
  return runInNewContext(`${compile(`const invoke = ${effect.expression.arguments[0].getText(source)};`)}\ninvoke;`, context) as () => (() => void);
}

test('invalid saved UI JSON cannot crash the initial renderer', () => {
  const descriptors = new Map(['window', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    for (const raw of ['null', 'false', '3', '[]', '"text"', '{broken']) {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => raw } });
      assert.doesNotThrow(() => renderToStaticMarkup(createElement(App)), raw);
    }
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('saved selectors and draft/model maps retain only valid strings and known modes', () => {
  const value = saved(JSON.stringify({ projectId: { bad: true }, sessionId: 4, tab: 'unknown', hardwarePlatform: [],
    drafts: { good: 'keep draft', bad: 5, empty: '', nested: {} }, models: { good: 'model', bad: null }, ignored: 'not UI' }));
  assert.equal(value.projectId, undefined); assert.equal(value.sessionId, undefined);
  assert.equal(value.tab, undefined); assert.equal(value.hardwarePlatform, undefined);
  assert.equal(value.drafts.good, 'keep draft'); assert.equal(value.drafts.empty, '');
  assert.equal(value.drafts.bad, undefined); assert.equal(value.drafts.nested, undefined);
  assert.equal(value.models.good, 'model'); assert.equal(value.models.bad, undefined);
  assert.equal(value.ignored, undefined);
  const valid = saved(JSON.stringify({ projectId: 'project', sessionId: 'session', tab: 'embedded', hardwarePlatform: 'fz3b', drafts: { session: 'hello' }, models: { session: 'model' } }));
  assert.equal(valid.projectId, 'project'); assert.equal(valid.sessionId, 'session');
  assert.equal(valid.tab, 'embedded'); assert.equal(valid.hardwarePlatform, 'fz3b');
  for (const raw of ['null', '[]', 'false', '{broken']) assert.equal(Object.keys(saved(raw)).length, 0);
});

test('cleaned-up subscription cannot publish its old initial snapshot after a new setup', async () => {
  const requests = [deferred<string>(), deferred<string>()], listeners: Array<(value: string) => void> = [];
  const states: string[] = [], notices: unknown[] = []; let unsubscribed = 0;
  const effect = subscriptionEffect({ api: { subscribe: (listener: (value: string) => void) => { listeners.push(listener); return () => { unsubscribed++; }; }, snapshot: () => requests.shift()!.promise },
    mounted: { current: false }, setSnapshot: (value: string) => states.push(value), setNotice: (value: unknown) => notices.push(value), errorText: String });
  const old = requests[0], current = requests[1];
  const cleanup = effect(); cleanup(); const cleanupCurrent = effect();
  listeners[1]('fresh subscription'); old.resolve('obsolete initial snapshot'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states, ['fresh subscription']);
  listeners[0]('obsolete subscription callback'); assert.deepEqual(states, ['fresh subscription']);
  current.resolve('superseded initial snapshot'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states, ['fresh subscription']); assert.equal(notices.length, 0);
  cleanupCurrent(); assert.equal(unsubscribed, 2);
});

test('cleaned-up initial snapshot rejection cannot post an error in the new lifecycle', async () => {
  const old = deferred<string>(), current = deferred<string>(); const requests = [old, current], notices: unknown[] = [];
  const effect = subscriptionEffect({ api: { subscribe: () => () => {}, snapshot: () => requests.shift()!.promise },
    mounted: { current: false }, setSnapshot() {}, setNotice: (value: unknown) => notices.push(value), errorText: String });
  const cleanup = effect(); cleanup(); const cleanupCurrent = effect();
  old.reject(new Error('obsolete failure')); await new Promise(resolve => setImmediate(resolve)); assert.equal(notices.length, 0);
  current.reject(new Error('current failure')); await new Promise(resolve => setImmediate(resolve)); assert.equal(notices.length, 1);
  cleanupCurrent();
});
