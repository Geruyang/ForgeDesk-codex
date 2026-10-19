import assert from 'node:assert/strict';
import test from 'node:test';
import type { Session } from '../packages/shared/contracts';
import { refusedMcpItem } from './helpers/second-user-controls';

const expected = {
  type: 'mcpToolCall', server: 'engineering', tool: 'engineering.test',
  arguments: { taskId: 'task', verifierId: 'qa-controls-verifier', requestKey: 'fixture-key' },
  status: 'failed', result: null, error: { message: 'user rejected MCP tool call' },
};

function session(extra?: string): Session {
  const messages: Session['messages'] = [{ id: 'mcp-1', role: 'tool', text: JSON.stringify(expected), timestamp: 'fixture', status: 'failed' }];
  if (extra !== undefined) messages.push({ id: 'tool-2', role: 'tool', text: extra, timestamp: 'fixture' });
  return { id: 'task', taskId: 'task', projectId: 'project', title: 'refusal', status: 'completed', messages };
}

test('one exact failed MCP refusal is accepted', () => {
  assert.deepEqual(refusedMcpItem(session(), 'fixture-key'), expected);
});

test('refusal rejects every additional tool item, including retries and non-JSON builtins', () => {
  const extras = [
    JSON.stringify({ ...expected, arguments: { ...expected.arguments, requestKey: 'retry-key' } }),
    JSON.stringify({ ...expected, arguments: { ...expected.arguments, verifierId: 'other-verifier' } }),
    JSON.stringify({ ...expected, tool: 'engineering.inspect' }),
    JSON.stringify({ type: 'commandExecution', command: 'echo fixture', status: 'completed' }),
    'built-in command output without JSON',
  ];
  for (const extra of extras) {
    assert.throws(() => refusedMcpItem(session(extra), 'fixture-key'), /Exactly one tool item/, `Additional tool item escaped: ${extra}`);
  }
});
