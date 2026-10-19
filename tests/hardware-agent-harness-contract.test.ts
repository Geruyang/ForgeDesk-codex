import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

function descendants(node: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (item: ts.Node) => { result.push(item); item.forEachChild(visit); };
  visit(node); return result;
}
function hasString(node: ts.Node, value: string) {
  return descendants(node).some(item => ts.isStringLiteral(item) && item.text === value);
}
function hasProperty(node: ts.Node, value: string) {
  return descendants(node).some(item => ts.isPropertyAccessExpression(item) && item.name.text === value);
}
function assertHostPreparation(source: string) {
  const ast = ts.createSourceFile('hardware-agent-installed-smoke.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nodes = descendants(ast);
  const awaitedCalls = nodes.filter((node): node is ts.AwaitExpression => ts.isAwaitExpression(node) && ts.isCallExpression(node.expression));
  const click = (label: string) => {
    const matches = awaitedCalls.filter(node => {
      const call = node.expression as ts.CallExpression;
      return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'click' && hasString(call.expression.expression, label);
    });
    assert.equal(matches.length, 1, `Exactly one awaited actual ${label} button click is required`); return matches[0];
  };
  const configure = click('配置工程'), start = click('启动模型实机任务');
  const preparation = awaitedCalls.filter(node => {
    const call = node.expression as ts.CallExpression;
    return ts.isIdentifier(call.expression) && call.expression.text === 'waitFor' && hasProperty(call, 'configured');
  });
  assert.equal(preparation.length, 1, 'A public configured-state wait is required');
  const fills = awaitedCalls.filter(node => {
    const call = node.expression as ts.CallExpression;
    return ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'fill' && hasString(call.expression.expression, '模型实机任务指令');
  });
  assert.equal(fills.length, 1);
  const checks = nodes.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.pos > preparation[0].end && node.end < fills[0].pos &&
    ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'assert' && node.expression.name.text === 'equal');
  assert.ok(checks.some(call => hasProperty(call.arguments[0], 'operations') && hasProperty(call.arguments[0], 'length') && ts.isNumericLiteral(call.arguments[1]) && call.arguments[1].text === '0'), 'Host preparation cannot execute a worker operation');
  assert.ok(checks.some(call => hasProperty(call.arguments[0], 'engine') && ts.isStringLiteral(call.arguments[1]) && call.arguments[1].text === 'stopped'), 'Ordinary engine must be stopped');
  assert.ok(checks.some(call => hasProperty(call.arguments[0], 'modeActive') && call.arguments[1].kind === ts.SyntaxKind.TrueKeyword), 'Controlled mode must be active');
  const increments = nodes.filter(node => (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
    node.operator === ts.SyntaxKind.PlusPlusToken && ts.isPropertyAccessExpression(node.operand) &&
    ts.isIdentifier(node.operand.expression) && node.operand.expression.text === 'report' && node.operand.name.text === 'uiSubmitCount');
  assert.equal(increments.length, 1, 'Only one UI submission count increment is allowed');
  assert.ok(configure.pos < preparation[0].pos && preparation[0].pos < fills[0].pos && fills[0].pos < start.pos && start.end < increments[0].pos,
    'Host preparation must finish before instruction/start; submission is counted only after the awaited click succeeds');
  assert.ok(nodes.some(node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'report' && node.name.text === 'hostPreparation'));
  const prohibited = new Set(['hardwareAgentStart', 'hardwareBuild', 'hardwareInspect', 'hardwareFlash', 'hardwareVerify', 'hardwareExport']);
  assert.equal(nodes.some(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && prohibited.has(node.expression.name.text)), false,
    'Installed real-model actions must come from the actual model, not direct host API substitutes');
}

function assertProjectButtonSelection(source: string) {
  const ast = ts.createSourceFile('hardware-agent-installed-smoke.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const clicks = descendants(ast).filter((node): node is ts.AwaitExpression => {
    if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression) || !ts.isPropertyAccessExpression(node.expression.expression) || node.expression.expression.name.text !== 'click') return false;
    return descendants(node.expression.expression.expression).some(item => ts.isCallExpression(item) && ts.isPropertyAccessExpression(item.expression) &&
      item.expression.name.text === 'getByTitle' && !!item.arguments[0] && hasProperty(item.arguments[0], 'projectRoot'));
  });
  assert.equal(clicks.length, 1, 'Select the exact prepared project once');
  const calls = descendants(clicks[0]).filter((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression));
  assert.ok(calls.some(call => (call.expression as ts.PropertyAccessExpression).name.text === 'and'), 'Project selection must intersect the title with the button role');
  assert.ok(calls.some(call => (call.expression as ts.PropertyAccessExpression).name.text === 'getByRole' && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === 'button'));
  assert.ok(calls.some(call => (call.expression as ts.PropertyAccessExpression).name.text === 'getByTitle' && call.arguments[1] && ts.isObjectLiteralExpression(call.arguments[1]) &&
    call.arguments[1].properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(ast) === 'exact' && property.initializer.kind === ts.SyntaxKind.TrueKeyword)));
  assert.equal(calls.some(call => (call.expression as ts.PropertyAccessExpression).name.text === 'first'), false, 'Never hide duplicate-title ambiguity with first()');
}

test('offline AST contract requires host-only UI configuration before the single real-model UI submission', async () => {
  assertHostPreparation(await readFile(new URL('./hardware-agent-installed-smoke.ts', import.meta.url), 'utf8'));
});

test('offline AST contract rejects missing preparation, premature counting and direct action substitutes', () => {
  const valid = `
    await page.getByRole('button', { name: '配置工程' }).click();
    const prepared = await waitFor(hardware, state => state.configured);
    const preparedApp = await snapshot();
    assert.equal(prepared.operations.length, 0); assert.equal(preparedApp.engine.state, 'stopped'); assert.equal(preparedApp.hardware.modeActive, true);
    report.hostPreparation = { modelCall: false };
    await section.getByLabel('模型实机任务指令').fill(instruction);
    await section.getByRole('button', { name: '启动模型实机任务' }).click();
    report.uiSubmitCount++;
  `;
  assertHostPreparation(valid);
  for (const changed of [valid.replace("name: '配置工程'", "name: '刷新实机状态'"), valid.replace('state.configured', 'true'), valid.replace('prepared.operations.length, 0', 'prepared.operations.length, 1'),
    valid.replace('report.uiSubmitCount++;', '').replace("await section.getByRole('button'", "report.uiSubmitCount++; await section.getByRole('button'"),
    `${valid}\nawait window.forgeDesk.hardwareBuild(taskId, 'substitute');`]) assert.throws(() => assertHostPreparation(changed));
});

test('offline AST contract scopes the project title to a button rather than the duplicate header span', async () => {
  assertProjectButtonSelection(await readFile(new URL('./hardware-agent-installed-smoke.ts', import.meta.url), 'utf8'));
  const valid = `await page.getByRole('button').and(page.getByTitle(plan.projectRoot, { exact: true })).click();`;
  assertProjectButtonSelection(valid);
  for (const source of [`await page.getByTitle(plan.projectRoot, { exact: true }).click();`,
    valid.replace("'button'", "'generic'"), valid.replace('exact: true', 'exact: false'), valid.replace('.click()', '.first().click()')])
    assert.throws(() => assertProjectButtonSelection(source));
});
