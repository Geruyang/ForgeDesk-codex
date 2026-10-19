import { createInterface } from "node:readline";

const scenario = process.env.FORGEDESK_TEST_SCENARIO;
const requests = [];
const responses = [];
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (id, result) => output({ id, result });
const config = {
  approval_policy: "on-request", sandbox_mode: "workspace-write", approvals_reviewer: "user",
  sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
  default_permissions: "forgedesk_workspace_v1",
  permissions: { forgedesk_workspace_v1: { extends: ":workspace", filesystem: { ":tmpdir": "read", ":slash_tmp": "read" }, network: { enabled: false } } },
};
let threadCwd;
let pendingProbe;
const recordResponse = (message) => {
  responses.push(message);
  if (pendingProbe && message.id === "probe-form") {
    const pending = pendingProbe;
    pendingProbe = undefined;
    reply(pending.id, { responses, responseRecordedAfterMs: Number(process.hrtime.bigint() - pending.startedAt) / 1_000_000 });
  }
};
const consent = (overrides = {}) => ({
  threadId: "thread-1", turnId: "turn-1", serverName: "engineering", mode: "form",
  message: 'Allow the engineering MCP server to run tool "engineering.test"?',
  requestedSchema: { type: "object", properties: {} },
  _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { taskId: "task-1", verifierId: "numbers", requestKey: "check-1" } },
  ...overrides,
});
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    if (scenario === "elicitation-diagnostic-delayed" && message.id === "probe-form") {
      return setTimeout(() => recordResponse(message), 75);
    }
    recordResponse(message);
    return;
  }
  requests.push(message);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    if (scenario === "bad-json") return process.stdout.write("not-json\n");
    return reply(message.id, { codexHome: process.env.CODEX_HOME, userAgent: `forgedesktop/${scenario === "wrong-version" ? "0.0.0" : "0.162.0-alpha.17.2"} (test)` });
  }
  if (message.method === "config/read") {
    if (scenario === "bad-permission-default") return reply(message.id, { config: { ...config, default_permissions: ":workspace" } });
    if (scenario === "bad-permission-profile") return reply(message.id, { config: { ...config, permissions: { forgedesk_workspace_v1: {
      ...config.permissions.forgedesk_workspace_v1, filesystem: { ...config.permissions.forgedesk_workspace_v1.filesystem, "C:/ambient-extra-grant": "write" },
    } } } });
    return reply(message.id, { config: scenario === "bad-policy" ? { ...config, sandbox_mode: "danger-full-access" } : config });
  }
  if (message.method === "configRequirements/read") return reply(message.id, { requirements:
    scenario === "bad-permission-requirements" ? { allowedPermissionProfiles: { ":workspace": true } } : null });
  if (message.method === "windowsSandbox/readiness") return reply(message.id, { status: "ready" });
  if (message.method === "model/list") {
    if (scenario === "exit") return process.exit(23);
    if (scenario === "timeout") return;
    if (scenario === "elicitation-diagnostic" || scenario === "elicitation-diagnostic-delayed") {
      pendingProbe = { id: message.id, startedAt: process.hrtime.bigint() };
      output({ id: "probe-form", method: "mcpServer/elicitation/request", params: {
        threadId: "thread-1", turnId: "turn-1", serverName: "engineering", mode: "form",
        message: 'Confirm tool with api_key="hidden-elicitation-secret"',
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { token: "hidden-elicitation-secret", taskId: "private-task-value" },
          large: Array.from({ length: 40 }, () => Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`property-${index}`, { nested: { value: "private-task-value" } }]))),
        },
      } });
      return;
    }
    if (scenario === "unknown") {
      output({ id: "unknown", method: "new/server/method", params: { token: "internal" } });
      output({ id: "elicitation", method: "mcpServer/elicitation/request", params: {} });
      output({ id: "permissions", method: "item/permissions/requestApproval", params: {} });
      output({ id: "user-input", method: "item/tool/requestUserInput", params: {} });
      return setTimeout(() => reply(message.id, { responses, requests }), 30);
    }
    if (scenario === "oversized") return process.stdout.write("x".repeat(4 * 1024 * 1024 + 10));
    if (scenario === "unknown-flood") {
      for (let index = 0; index < 1000; index++) output({ method: "unrecognized/event", params: { index } });
    }
    return reply(message.id, { data: [{ id: "fake-model" }], requests, responses, engineHome: process.env.CODEX_HOME,
      inheritedPresent: Boolean(process.env.OPENAI_API_KEY), runnerValue: process.env.FORGEDESK_RUNNER_PATH ?? null });
  }
  if (message.method === "account/read") return reply(message.id, { account: { type: "chatgpt", email: "user@example.test", planType: "plus", accessToken: "must-not-leak" }, requiresOpenaiAuth: true, refreshToken: "must-not-leak" });
  if (message.method === "account/login/start") return reply(message.id, { type: "chatgpt", loginId: "login-1", authUrl: scenario === "bad-login-url" ? "https://example.com/login" : "https://auth.openai.com/oauth/authorize?state=public", accessToken: "must-not-leak" });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadCwd = message.params.cwd;
    return reply(message.id, { thread: { id: "thread-1", turns: [] }, cwd: threadCwd,
      approvalPolicy: "on-request", approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [threadCwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
  }
  if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-1", status: "inProgress" } });
    if (message.params.input[0].text === "mcp-consents") {
      for (const id of [0, "0", 2]) output({ id, method: "mcpServer/elicitation/request", params: consent() });
    }
    if (message.params.input[0].text === "mcp-resolved") {
      output({ id: 0, method: "mcpServer/elicitation/request", params: consent() });
      output({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 0 } });
    }
    if (message.params.input[0].text === "mcp-unsupported") {
      const variants = [
        { mode: "url", url: "https://example.test/authorize", elicitationId: "unknown" },
        { mode: "openai/form" }, { mode: "openaiForm" },
        { requestedSchema: { type: "object", properties: { confirmation: { type: "boolean" } } } },
        { requestedSchema: { type: "object", properties: {}, required: ["confirmation"] } },
        { requestedSchema: { type: "object", properties: {}, $ref: "https://example.test/schema" } },
        { _meta: {} }, { _meta: { codex_approval_kind: "browser_auth" } },
        { _meta: { codex_approval_kind: "mcp_tool_call", codex_requires_user_input: true } },
        { _meta: { codex_approval_kind: "mcp_tool_call", codex_request_type: "unknown" } },
        { serverName: "other-server" }, { threadId: "foreign-thread" }, { turnId: null },
        { requestedSchema: null }, { mode: {} }, { message: "x".repeat(33000) },
      ];
      variants.forEach((params, index) => output({ id: `unsupported-${index}`, method: "mcpServer/elicitation/request", params: consent(params) }));
    }
    if (message.params.input[0].text === "mcp-duplicate") {
      output({ id: 0, method: "mcpServer/elicitation/request", params: consent() });
      output({ id: 0, method: "mcpServer/elicitation/request", params: consent() });
    }
    if (message.params.input[0].text === "mcp-quota") {
      for (let id = 0; id < 129; id++) output({ id, method: "mcpServer/elicitation/request", params: consent() });
    }
    if (message.params.input[0].text === "approvals") {
      const params = { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "echo hello" };
      output({ id: 7, method: "item/commandExecution/requestApproval", params });
      output({ id: "7", method: "item/fileChange/requestApproval", params: { ...params, availableDecisions: ["decline"] } });
    }
    if (message.params.input[0].text === "resolved") {
      output({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" } });
      output({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 7 } });
    }
    return;
  }
  if (message.method === "turn/steer") return reply(message.id, { turnId: message.params.expectedTurnId, params: message.params });
  if (message.method === "turn/interrupt") {
    reply(message.id, {});
    return output({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } } });
  }
  output({ id: message.id, error: { code: -32601, message: "Unsupported test method" } });
}).on("close", () => process.exit(0));
process.send?.({ type: "fixtureReady" });
