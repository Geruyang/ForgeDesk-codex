import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';

const MAX_FRAME_BYTES = 1024 * 1024;
const BRIDGE_TIMEOUT_MS = 355_000;
const TOOL_NAMES = [
  'engineering.inspect', 'engineering.build', 'engineering.test',
  'device.bind', 'device.flash', 'device.verify', 'engineering.export',
] as const;
export type EngineeringToolName = typeof TOOL_NAMES[number];

type JsonObject = Record<string, unknown>;
type ToolDefinition = { name: EngineeringToolName; description: string; inputSchema: JsonObject };
const str = { type: 'string', minLength: 1, maxLength: 256 };
const schema = (required: string[], properties: JsonObject): JsonObject => ({
  type: 'object', additionalProperties: false, required, properties,
});
export const ENGINEERING_TOOLS: readonly ToolDefinition[] = [
  { name: 'engineering.inspect', description: 'Inspect a registered project and trusted engineering profile.', inputSchema: schema(['projectId', 'profileId'], { projectId: str, profileId: str }) },
  { name: 'engineering.build', description: 'Build only with the stored, user-approved profile. Use a new requestKey for each intended build; reuse it only to retry the same invocation.', inputSchema: schema(['taskId', 'profileRevision', 'requestKey'], { taskId: str, profileRevision: { type: 'integer', minimum: 1, maximum: 2147483647 }, requestKey: str }) },
  { name: 'engineering.test', description: 'Run a stored verifier. Use a new requestKey for each intended check after edits; reuse it only to retry the same invocation.', inputSchema: schema(['taskId', 'verifierId', 'requestKey'], { taskId: str, verifierId: str, requestKey: str, artifactId: str }) },
  { name: 'device.bind', description: 'Bind a device selected from the runner inventory; a port name alone is not a stable identity.', inputSchema: schema(['profileId', 'deviceIdentityId'], { profileId: str, deviceIdentityId: str }) },
  { name: 'device.flash', description: 'Flash a known artifact to an authorized, exclusively held device.', inputSchema: schema(['taskId', 'artifactId', 'deviceBindingId', 'requestKey'], { taskId: str, artifactId: str, deviceBindingId: str, requestKey: str }) },
  { name: 'device.verify', description: 'Run a stored hardware verifier against a bound device.', inputSchema: schema(['taskId', 'verifierId', 'deviceBindingId'], { taskId: str, verifierId: str, deviceBindingId: str }) },
  { name: 'engineering.export', description: 'Export the runner-authored delivery package and evidence manifest.', inputSchema: schema(['taskId'], { taskId: str }) },
];

const instructions = 'Engineering tools access the authoritative local runner. Only runner-recorded checks and evidence can establish acceptance; assistant text and tool progress cannot. Device bind, flash, and verification require separate hardware authorization enforced by the runner. Tool-supplied task IDs are untrusted and must be bound by the host to the active task. Build and test commands come only from stored user-approved profiles and acceptance rules.';

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeJson(raw: string): unknown {
  const parsed: unknown = JSON.parse(raw);
  function inspect(value: unknown, depth: number): void {
    if (depth > 16) throw new Error('INVALID_INPUT');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('INVALID_INPUT');
      inspect(child, depth + 1);
    }
  }
  inspect(parsed, 0);
  return parsed;
}

function validArgs(tool: ToolDefinition, value: unknown): value is JsonObject {
  if (!isObject(value)) return false;
  const shape = tool.inputSchema;
  const required = shape.required as string[];
  const properties = shape.properties as JsonObject;
  if (required.some(key => !Object.hasOwn(value, key))) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!Object.hasOwn(properties, key)) return false;
    const rule = properties[key] as JsonObject | undefined;
    if (!rule) return false;
    if (rule.type === 'integer') return typeof item === 'number' && Number.isInteger(item) && item >= (rule.minimum as number) && item <= (rule.maximum as number);
    return typeof item === 'string' && item.trim().length > 0 && Buffer.byteLength(item, 'utf8') <= 256;
  });
}

function equalSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = createHash('sha256').update(actual).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function writeLine(stream: { write(chunk: string): boolean }, value: unknown): void {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE');
  stream.write(`${line}\n`);
}

type BridgeRequest = { id: string; token: string; name: EngineeringToolName; args: JsonObject };
type BridgeResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export async function startRunnerBridge(options: {
  pipeName: string;
  token: string;
  handle: (name: EngineeringToolName, args: JsonObject) => Promise<unknown>;
}): Promise<{ pipeName: string; close: () => Promise<void> }> {
  if (!options.pipeName || !options.token || options.token.length < 32) throw new Error('Invalid bridge configuration');
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(BRIDGE_TIMEOUT_MS + 5_000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { socket.destroy(); return; }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      handled = true;
      let request: unknown;
      try { request = safeJson(buffer.subarray(0, end).toString('utf8')); }
      catch { writeLine(socket, { id: '', ok: false, error: 'INVALID_REQUEST' }); socket.end(); return; }
      void (async () => {
        if (!isObject(request)) return { id: '', ok: false, error: 'INVALID_REQUEST' };
        const candidate = request as Partial<BridgeRequest>;
        const id = typeof candidate.id === 'string' && candidate.id.length <= 128 ? candidate.id : '';
        if (!equalSecret(candidate.token, options.token)) return { id, ok: false, error: 'UNAUTHORIZED' };
        const tool = ENGINEERING_TOOLS.find(item => item.name === candidate.name);
        if (!tool || !validArgs(tool, candidate.args)) return { id, ok: false, error: 'INVALID_ARGUMENTS' };
        const args = candidate.args;
        let timer: NodeJS.Timeout | undefined;
        try {
          const result = await Promise.race([
            Promise.resolve().then(() => options.handle(tool.name, args)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), BRIDGE_TIMEOUT_MS); }),
          ]);
          return { id, ok: true, result };
        } catch (error) {
          return { id, ok: false, error: error instanceof Error && error.message === 'TIMEOUT' ? 'TIMEOUT' : 'RUNNER_ERROR' };
        } finally {
          if (timer) clearTimeout(timer);
        }
      })().then(response => {
        try { writeLine(socket, response); }
        catch { try { writeLine(socket, { id: response.id, ok: false, error: 'RESULT_TOO_LARGE' }); } catch { /* closed socket */ } }
        socket.end();
      }).catch(() => socket.destroy());
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => { /* Request fails closed on a broken pipe. */ });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.pipeName, () => { server.off('error', reject); resolve(); });
  });
  return {
    pipeName: options.pipeName,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function callRunner(pipeName: string, token: string, name: EngineeringToolName, args: JsonObject): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName);
    let buffer = Buffer.alloc(0);
    let finished = false;
    const fail = (reason: string) => { if (!finished) { finished = true; socket.destroy(); reject(new Error(reason)); } };
    socket.setTimeout(BRIDGE_TIMEOUT_MS + 5_000, () => fail('RUNNER_TIMEOUT'));
    socket.on('connect', () => {
      try { writeLine(socket, { id: '1', token, name, args }); }
      catch { fail('REQUEST_TOO_LARGE'); }
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) { fail('RESPONSE_TOO_LARGE'); return; }
      const end = buffer.indexOf(10);
      if (end < 0 || finished) return;
      try {
        const response = safeJson(buffer.subarray(0, end).toString('utf8')) as BridgeResponse;
        if (!isObject(response) || response.id !== '1' || typeof response.ok !== 'boolean') { fail('INVALID_RESPONSE'); return; }
        finished = true;
        socket.end();
        if (response.ok) resolve(response.result);
        else reject(new Error(typeof response.error === 'string' && /^[A-Z_]+$/.test(response.error) ? response.error : 'RUNNER_ERROR'));
      } catch { fail('INVALID_RESPONSE'); }
    });
    socket.on('error', () => fail('RUNNER_UNAVAILABLE'));
    socket.on('close', () => fail('RUNNER_DISCONNECTED'));
  });
}

type McpRequest = { jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown };
function mcpError(id: string | number | null, code: number, message: string): JsonObject {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleMcpMessage(message: unknown, invoke: (name: EngineeringToolName, args: JsonObject) => Promise<unknown>): Promise<JsonObject | null> {
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return mcpError(null, -32600, 'Invalid Request');
  const request = message as McpRequest;
  const id = typeof request.id === 'string' || typeof request.id === 'number' && Number.isFinite(request.id) ? request.id : null;
  if (request.id !== undefined && id === null) return mcpError(null, -32600, 'Invalid Request');
  if (id === null) return null;
  if (request.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'forgedesk-engineering', version: '0.1.0' }, instructions } };
  if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: ENGINEERING_TOOLS } };
  if (request.method === 'tools/call') {
    const params = request.params;
    if (!isObject(params) || typeof params.name !== 'string') return mcpError(id, -32602, 'Invalid params');
    const tool = ENGINEERING_TOOLS.find(item => item.name === params.name);
    if (!tool || !validArgs(tool, params.arguments)) return mcpError(id, -32602, 'Invalid params');
    try {
      const result = await invoke(tool.name, params.arguments);
      const rendered = JSON.stringify(result ?? null);
      if (Buffer.byteLength(rendered, 'utf8') > MAX_FRAME_BYTES / 2) throw new Error('RESULT_TOO_LARGE');
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: rendered }] } };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'RUNNER_ERROR';
      return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: code }] } };
    }
  }
  return mcpError(id, -32601, 'Method not found');
}

export async function runMcpStdio(): Promise<void> {
  const pipeName = process.env.FORGEDESK_RUNNER_PIPE;
  const token = process.env.FORGEDESK_RUNNER_TOKEN;
  if (!pipeName || !token) throw new Error('Runner bridge is not configured');
  const lines = createInterface({ input: stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) { writeLine(stdout, mcpError(null, -32700, 'Parse error')); continue; }
    try {
      const response = await handleMcpMessage(safeJson(line), (name, args) => callRunner(pipeName, token, name, args));
      if (response) writeLine(stdout, response);
    } catch {
      writeLine(stdout, mcpError(null, -32700, 'Parse error'));
    }
  }
}

if (process.argv.includes('--mcp-stdio')) {
  runMcpStdio().catch(() => { process.exitCode = 1; });
}
