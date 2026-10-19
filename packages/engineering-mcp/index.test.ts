import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ENGINEERING_TOOLS, handleMcpMessage, startRunnerBridge } from './index.js';

const token = 'a'.repeat(64);
const pipeName = process.platform === 'win32'
  ? `\\\\.\\pipe\\forgedesk-test-${randomUUID()}`
  : join(tmpdir(), `forgedesk-test-${randomUUID()}.sock`);

function request(payload: string, destination = pipeName): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(destination);
    let text = '';
    socket.on('connect', () => socket.write(`${payload}\n`));
    socket.on('data', chunk => { text += chunk.toString(); });
    socket.on('end', () => {
      try { resolve(JSON.parse(text.trim())); } catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}

test('MCP exposes exactly seven constrained engineering tools', async () => {
  assert.deepEqual(ENGINEERING_TOOLS.map(tool => tool.name), [
    'engineering.inspect', 'engineering.build', 'engineering.test',
    'device.bind', 'device.flash', 'device.verify', 'engineering.export',
  ]);
  const init = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, async () => null);
  assert.match(JSON.stringify(init), /runner-recorded checks and evidence/);
  const list = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, async () => null);
  assert.equal((list?.result as { tools: unknown[] }).tools.length, 7);
});

test('MCP validates arguments and returns explicit tool errors', async () => {
  let called = 0;
  const invoke = async () => { called++; throw new Error('secret credential here'); };
  const bad = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'engineering.build', arguments: { taskId: 'task', profileRevision: 1, requestKey: 'intent-1', command: 'powershell -Command evil' },
  } }, invoke);
  assert.equal((bad?.error as { code: number }).code, -32602);
  assert.equal(called, 0);
  const failed = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'engineering.export', arguments: { taskId: 'task' },
  } }, invoke);
  assert.equal((failed?.result as { isError: boolean }).isError, true);
  assert.doesNotMatch(JSON.stringify(failed), /secret credential/);
  assert.equal(called, 1);
});

test('MCP rejects inherited schema names and non-finite request IDs without dispatch', async () => {
  let called = 0;
  const invoke = async () => { called++; return null; };
  for (const key of ['toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'engineering.export', arguments: { taskId: 'task', [key]: 'not-a-declared-field' },
    } }, invoke);
    assert.equal((response?.error as { code?: number } | undefined)?.code, -32602, key);
  }
  for (const id of [NaN, Infinity, -Infinity]) {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'engineering.export', arguments: { taskId: 'task' },
    } }, invoke);
    assert.equal((response?.error as { code?: number } | undefined)?.code, -32600);
  }
  assert.equal(called, 0);
});

test('build requires requestKey and forwards an unchanged intent to the runner', async () => {
  const missing = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'engineering.build', arguments: { taskId: 'task', profileRevision: 2 },
  } }, async () => { throw new Error('must not run'); });
  assert.equal((missing?.error as { code: number }).code, -32602);

  const buildPipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\forgedesk-test-${randomUUID()}`
    : join(tmpdir(), `forgedesk-test-${randomUUID()}.sock`);
  const received: unknown[] = [];
  const bridge = await startRunnerBridge({ pipeName: buildPipe, token, handle: async (name, args) => {
    received.push({ name, args });
    return { status: 'accepted' };
  } });
  try {
    const args = { taskId: 'task', profileRevision: 2, requestKey: 'build-intent-1' };
    const payload = JSON.stringify({ id: 'x', token, name: 'engineering.build', args });
    assert.deepEqual(await request(payload, buildPipe), { id: 'x', ok: true, result: { status: 'accepted' } });
    assert.deepEqual(await request(payload, buildPipe), { id: 'x', ok: true, result: { status: 'accepted' } });
    assert.deepEqual(received, [
      { name: 'engineering.build', args },
      { name: 'engineering.build', args },
    ]);
  } finally {
    await bridge.close();
  }
});

test('runner pipe requires token, validates frame, and redacts handler errors', async () => {
  let called = 0;
  const bridge = await startRunnerBridge({ pipeName, token, handle: async () => { called++; throw new Error('sensitive path and token'); } });
  try {
    const denied = await request(JSON.stringify({ id: 'x', token: 'wrong', name: 'engineering.export', args: { taskId: 't' } }));
    assert.deepEqual(denied, { id: 'x', ok: false, error: 'UNAUTHORIZED' });
    const poisoned = await request('{"id":"x","token":"' + token + '","name":"engineering.export","args":{"taskId":"t","__proto__":{}}}');
    assert.deepEqual(poisoned, { id: '', ok: false, error: 'INVALID_REQUEST' });
    const rejected = await request(JSON.stringify({ id: 'x', token, name: 'engineering.export', args: { taskId: 't', command: 'cmd.exe' } }));
    assert.deepEqual(rejected, { id: 'x', ok: false, error: 'INVALID_ARGUMENTS' });
    const inherited = await request(JSON.stringify({ id: 'x', token, name: 'engineering.export', args: { taskId: 't', toString: 'undeclared' } }));
    assert.deepEqual(inherited, { id: 'x', ok: false, error: 'INVALID_ARGUMENTS' });
    const failed = await request(JSON.stringify({ id: 'x', token, name: 'engineering.export', args: { taskId: 't' } }));
    assert.deepEqual(failed, { id: 'x', ok: false, error: 'RUNNER_ERROR' });
    assert.equal(called, 1);
  } finally {
    await bridge.close();
  }
});

test('stdio child completes MCP initialize, list, and runner-backed call', async () => {
  const childPipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\forgedesk-test-${randomUUID()}`
    : join(tmpdir(), `forgedesk-test-${randomUUID()}.sock`);
  const bridge = await startRunnerBridge({ pipeName: childPipe, token, handle: async (name, args) => ({ name, taskId: args.taskId }) });
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./index.ts', import.meta.url)), '--mcp-stdio'], {
    cwd: process.cwd(), env: { ...process.env, FORGEDESK_RUNNER_PIPE: childPipe, FORGEDESK_RUNNER_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const responses = await new Promise<unknown[]>((resolve, reject) => {
      let output = '';
      const values: unknown[] = [];
      const timer = setTimeout(() => reject(new Error('stdio MCP did not respond')), 10_000);
      child.once('error', reject);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        let newline = output.indexOf('\n');
        while (newline >= 0) {
          values.push(JSON.parse(output.slice(0, newline)));
          output = output.slice(newline + 1);
          if (values.length === 3) { clearTimeout(timer); resolve(values); return; }
          newline = output.indexOf('\n');
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'engineering.export', arguments: { taskId: 't' } } }) + '\n');
    });
    assert.equal((responses[0] as { id: number }).id, 1);
    assert.equal(((responses[1] as { result: { tools: unknown[] } }).result.tools).length, 7);
    assert.match(JSON.stringify(responses[2]), /engineering.export/);
  } finally {
    child.kill();
    await bridge.close();
  }
});
