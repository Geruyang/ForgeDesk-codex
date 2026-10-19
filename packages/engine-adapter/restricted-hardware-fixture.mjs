import { createInterface } from 'node:readline';
const scenario = process.argv[2];
const config = Object.fromEntries(process.argv.slice(3).flatMap((value, index, args) => args[index - 1] === '-c' ? [[value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]] : []));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, result) => send({ id, result });
let expected = 0;
let responses = [];
const base = { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null, tool: 'embedded_status', arguments: {} };
function finish() {
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: JSON.stringify(responses) } });
  send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return result(message.id, { userAgent: 'forgedesktop/0.162.0-alpha.17.2 (fixture)', codexHome: process.env.CODEX_HOME });
  if (message.method === 'config/read') {
    const features = Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith('features.')).map(([key, value]) => [key.slice(9), value === 'true']));
    return result(message.id, { config: { model: 'gpt-6.1-sol', model_provider: 'openai', approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled', model_catalog_json: JSON.parse(config.model_catalog_json), model_providers: {}, chatgpt_base_url: 'https://chatgpt.com/backend-api/', openai_base_url: null, notify: [], features,
      mcp_servers: scenario === 'mcp' ? { engineering: { enabled: config['mcp_servers.engineering.enabled'] !== 'false', required: true, command: 'fixture-only' } } : {},
    } });
  }
  if (message.method === 'account/read') return result(message.id, { account: { type: 'chatgpt', email: 'qa@example.invalid', planType: 'plus', accessToken: 'must-not-leak' }, requiresOpenaiAuth: true });
  if (message.method === 'thread/start') {
    send({ method: 'thread/started', params: { thread: { id: 'thread-1' } } });
    return result(message.id, { model: message.params.model, modelProvider: 'openai', cwd: message.params.cwd, thread: { id: 'thread-1', environments: message.params.environments }, approvalPolicy: message.params.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false } });
  }
  if (message.method === 'turn/interrupt') return result(message.id, {});
  if (message.method === 'turn/start') {
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    result(message.id, { turn: { id: 'turn-1' } });
    if (scenario === 'exit') return process.exit(7);
    if (scenario === 'rerouted') return send({ method: 'model/rerouted', params: { threadId: 'thread-1', model: 'unknown-fallback' } });
    if (scenario === 'foreign') {
      send({ method: 'turn/completed', params: { threadId: 'foreign', turn: { id: 'turn-1' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'foreign' } } });
      return finish();
    }
    if (scenario === 'invalid') {
      const mutations = [{ threadId: 'foreign' }, { turnId: 'foreign' }, { namespace: 'functions' }, { tool: 'exec_command' }, { arguments: { path: 'forbidden' } }, { arguments: [] }, { extra: true }];
      expected = mutations.length;
      return mutations.forEach((mutation, index) => send({ id: index, method: 'item/tool/call', params: { ...base, ...mutation } }));
    }
    if (scenario === 'unknown') { expected = 3; send({ id: 'cmd', method: 'item/commandExecution/requestApproval', params: {} }); send({ id: 'mcp', method: 'mcpServer/elicitation/request', params: {} }); return send({ id: 'unknown', method: 'unknown/anything', params: {} }); }
    if (scenario === 'malformed') return process.stdout.write(JSON.stringify({ id: 10, method: 'item/tool/call', params: base }) + '\nnot-json\n');
    expected = scenario === 'duplicate' || scenario === 'duplicate-completed' || scenario === 'conflict' ? 2 : 1;
    send({ id: 0, method: 'item/tool/call', params: base });
    if (scenario === 'duplicate') send({ id: '0', method: 'item/tool/call', params: base });
    if (scenario === 'conflict') send({ id: 'other', method: 'item/tool/call', params: { ...base, tool: 'embedded_build' } });
    return;
  }
  if (message.id !== undefined && ('result' in message || 'error' in message)) {
    responses.push(message);
    if (scenario === 'duplicate-completed' && responses.length === 1) return send({ id: 0, method: 'item/tool/call', params: base });
    if (responses.length === expected) finish();
  }
});
