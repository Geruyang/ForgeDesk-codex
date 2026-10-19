import { createInterface } from 'node:readline';
const scenario = process.argv[2];
const config = Object.fromEntries(process.argv.slice(3).flatMap((value, index, args) => args[index - 1] === '-c' ? [[value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]] : []));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, result) => send({ id, result });
const base = { threadId: 'thread-fz3b', turnId: 'turn-fz3b', callId: 'call-fz3b', namespace: null, tool: 'fz3b_status', arguments: {} };
let specs, expected = 0;
const responses = [];
function finish() {
  send({ method: 'item/agentMessage/delta', params: { threadId: base.threadId, turnId: base.turnId, delta: JSON.stringify({ specs, responses }) } });
  send({ method: 'turn/completed', params: { threadId: base.threadId, turn: { id: base.turnId, status: 'completed' } } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return result(message.id, { userAgent: 'forgedesktop/0.162.0-alpha.17.2 (fixture)', codexHome: process.env.CODEX_HOME });
  if (message.method === 'config/read') {
    const features = Object.fromEntries(Object.entries(config).filter(([key]) => key.startsWith('features.')).map(([key, value]) => [key.slice(9), value === 'true']));
    return result(message.id, { config: { model: 'gpt-6.1-sol', model_provider: 'openai', approval_policy: 'never', sandbox_mode: 'read-only', web_search: 'disabled', model_catalog_json: JSON.parse(config.model_catalog_json), model_providers: {}, chatgpt_base_url: 'https://chatgpt.com/backend-api/', openai_base_url: null, notify: [], features, mcp_servers: {} } });
  }
  if (message.method === 'thread/start') {
    specs = message.params.dynamicTools;
    return result(message.id, { model: message.params.model, modelProvider: 'openai', cwd: message.params.cwd, thread: { id: base.threadId, environments: message.params.environments }, approvalPolicy: message.params.approvalPolicy, sandbox: { type: 'readOnly', networkAccess: false } });
  }
  if (message.method === 'turn/start') {
    send({ method: 'turn/started', params: { threadId: base.threadId, turn: { id: base.turnId } } });
    result(message.id, { turn: { id: base.turnId } });
    if (scenario === 'invalid') {
      const mutations = [{ tool: 'embedded_request_flash' }, { tool: 'exec_command' }, { arguments: { host: '127.0.0.1' } }, { arguments: [] }, { threadId: 'foreign' }, { turnId: 'foreign' }, { namespace: 'mcp' }, { extra: true }];
      expected = mutations.length;
      return mutations.forEach((mutation, index) => send({ id: index, method: 'item/tool/call', params: { ...base, ...mutation } }));
    }
    if (scenario === 'approvals') {
      expected = 3;
      send({ id: 'shell', method: 'item/commandExecution/requestApproval', params: {} });
      send({ id: 'mcp', method: 'mcpServer/elicitation/request', params: {} });
      return send({ id: 'unknown', method: 'unknown/tool', params: {} });
    }
    expected = scenario === 'duplicate' || scenario === 'conflict' ? 2 : 1;
    send({ id: 0, method: 'item/tool/call', params: base });
    if (scenario === 'duplicate') send({ id: '0', method: 'item/tool/call', params: base });
    if (scenario === 'conflict') send({ id: 'other', method: 'item/tool/call', params: { ...base, tool: 'fz3b_semantic' } });
    return;
  }
  if (message.id !== undefined && ('result' in message || 'error' in message)) {
    responses.push(message);
    if (responses.length === expected) finish();
  }
});
