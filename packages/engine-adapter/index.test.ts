import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CodexAdapter, redact, type EngineEvent } from "./index";
import { digestSnapshotPolicyValue } from "./snapshot-isolation";
import { WORKSPACE_PERMISSION_PROFILE, WORKSPACE_PERMISSION_PROFILE_ID } from "./workspace-policy";

const root = dirname(fileURLToPath(import.meta.url));
const suiteRoot = (async () => {
  await mkdir(join(root, ".test-output"), { recursive: true });
  return mkdtemp(join(root, ".test-output", "suite-"));
})();

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${description}`);
    await delay(10);
  }
}

class TestAdapter extends CodexAdapter {
  constructor(home: string, onEvent: (event: EngineEvent) => void, private scenario = "normal", timeout = 10_000) {
    super({ executable: process.execPath, home, onEvent, requestTimeoutMs: timeout, env: { FORGEDESK_RUNNER_PATH: "product-runner" } });
  }
  protected override createProcess(env: NodeJS.ProcessEnv) {
    return spawn(process.execPath, [join(root, "test-engine.mjs")], {
      env: { ...env, FORGEDESK_TEST_SCENARIO: this.scenario }, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true,
    });
  }
}
async function setup(scenario = "normal", timeout = 10_000) {
  const folder = await mkdtemp(join(await suiteRoot, "case-"));
  const home = join(folder, "engine");
  const workspace = join(folder, "workspace");
  await mkdir(workspace);
  const events: EngineEvent[] = [];
  const adapter = new TestAdapter(home, (event) => events.push(event), scenario, timeout);
  return { adapter, home, workspace, events };
}

test("handshake is nonexperimental, event order is sequenced, and engine env is isolated", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-inherited-secret";
  const { adapter, home, events } = await setup();
  try {
    await Promise.all([adapter.start(), adapter.start()]);
    const result = await adapter.models() as any;
    assert.equal(adapter.state, "ready");
    assert.equal(result.engineHome, home);
    assert.equal(result.inheritedPresent, false);
    assert.equal(result.runnerValue, "product-runner");
    assert.equal(result.requests[0].params.clientInfo.name, "forgedesktop");
    assert.equal(result.requests[0].params.capabilities.experimentalApi, false);
    assert.equal(result.requests[1].method, "initialized");
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
    assert.ok(events.every((event) => event.generation === events[0].generation));
  } finally {
    await adapter.stop();
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
  }
});

test("effective unsafe policy fails initialization", async () => {
  const { adapter } = await setup("bad-policy");
  await assert.rejects(adapter.start(), /policy/);
  assert.equal(adapter.state, "failed");
  await adapter.stop();
});

for (const scenario of ["bad-permission-default", "bad-permission-profile", "bad-permission-requirements"]) {
  test(`fixed permission profile rejects ${scenario} before the adapter becomes ready`, async () => {
    const { adapter, events } = await setup(scenario);
    try {
      await assert.rejects(adapter.start(), /permission profile/);
      assert.equal(adapter.state, "failed");
      assert.ok(!events.some((event) => event.method === "engine/state" && (event.params as any)?.state === "ready"));
    } finally { await adapter.stop(); }
  });
}

test("snapshot effective digest includes the selected default and exact merged permission profile", async () => {
  const { adapter, workspace, home } = await setup();
  try {
    await adapter.start();
    const policy = await adapter.snapshotPolicy(workspace);
    assert.equal(policy.generation, adapter.connectionGeneration);
    assert.equal(policy.home, home);
    assert.equal(policy.effectivePolicySha256, digestSnapshotPolicyValue({
      approval_policy: "on-request", approvals_reviewer: "user", sandbox_mode: "workspace-write",
      sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
      default_permissions: WORKSPACE_PERMISSION_PROFILE_ID,
      permissions: { [WORKSPACE_PERMISSION_PROFILE_ID]: WORKSPACE_PERMISSION_PROFILE }, windows: null, features: null,
    }));
  } finally { await adapter.stop(); }
});

test("engine version mismatch fails before sending initialized", async () => {
  const { adapter } = await setup("wrong-version");
  await assert.rejects(adapter.start(), /version does not match/);
  await adapter.stop();
});

test("approval ID types, allowed decisions, generation and duplicate responses are enforced", async () => {
  const { adapter, workspace } = await setup();
  try {
    await adapter.start(); await adapter.startThread(workspace); await adapter.send("thread-1", "approvals");
    await waitFor(() => adapter.pendingApprovals().length === 2, "both approval requests");
    const pending = adapter.pendingApprovals();
    assert.equal(pending.length, 2);
    await assert.rejects(adapter.approve(pending[0].generation + 1, 7, "accept"), /expired/);
    await assert.rejects(adapter.approve(pending[0].generation, "7", "accept"), /not allowed/);
    pending[0].decisions.push("unsafe");
    await assert.rejects(adapter.approve(pending[0].generation, 7, "unsafe"), /not allowed/);
    await adapter.approve(pending[0].generation, 7, "accept");
    await assert.rejects(adapter.approve(pending[0].generation, 7, "accept"), /no longer pending/);
    await adapter.approve(pending[0].generation, "7", "decline");
    assert.equal(adapter.pendingApprovals().length, 0);
    const result = await adapter.models() as any;
    assert.deepEqual(result.responses, [{ id: 7, result: { decision: "accept" } }, { id: "7", result: { decision: "decline" } }]);
    await adapter.stop(); await adapter.start();
    await assert.rejects(adapter.approve(pending[0].generation, 7, "accept"), /expired/);
  } finally { await adapter.stop(); }
});

test("server resolution notification removes pending approval", async () => {
  const { adapter, workspace, events } = await setup();
  try {
    await adapter.start(); await adapter.startThread(workspace); await adapter.send("thread-1", "resolved");
    await waitFor(() => events.some((event) => event.method === "serverRequest/resolved"), "server approval-resolution event");
    assert.equal(adapter.pendingApprovals().length, 0);
  } finally { await adapter.stop(); }
});

test("unsupported server requests, user input and elicitation always receive an answer", async () => {
  const { adapter } = await setup("unknown");
  try {
    await adapter.start(); const result = await adapter.models() as any;
    assert.deepEqual(result.responses.map((response: any) => response.id), ["unknown", "elicitation", "permissions", "user-input"]);
    assert.equal(result.responses[0].error.code, -32601);
    assert.equal(result.responses[1].result.action, "cancel");
    assert.deepEqual(result.responses[2].result, { permissions: {}, scope: "turn" });
    assert.equal(result.responses[3].error.code, -32601);
  } finally { await adapter.stop(); }
});

test("elicitation probe records bounded redacted structure and grants no permission", async () => {
  const { adapter, events } = await setup("elicitation-diagnostic");
  try {
    await adapter.start();
    const result = await adapter.models() as any;
    assert.deepEqual(result.responses, [{ id: "probe-form", result: { action: "cancel", content: null, _meta: null } }]);
    const diagnostic = events.find((event) => event.method === "engine/diagnostic" && (event.params as any).details?.id === "probe-form") as any;
    assert.equal(diagnostic.params.details.serverName, "engineering");
    assert.equal(diagnostic.params.details.mode, "form");
    assert.deepEqual(diagnostic.params.details.requestedSchema, { type: "object", properties: {} });
    assert.equal(diagnostic.params.details._meta.codex_approval_kind, "mcp_tool_call");
    assert.ok(!JSON.stringify(events).includes("hidden-elicitation-secret"));
    assert.ok(!JSON.stringify(events).includes("private-task-value"));
    assert.ok(Buffer.byteLength(JSON.stringify(diagnostic.params.details)) < 8192);
    assert.equal(adapter.pendingApprovals().length, 0);
  } finally { await adapter.stop(); }
});

test("elicitation probe waits for cancellation delayed beyond the legacy 30ms window", async () => {
  const { adapter } = await setup("elicitation-diagnostic-delayed");
  try {
    await adapter.start();
    const result = await adapter.models() as any;
    assert.deepEqual(result.responses, [{ id: "probe-form", result: { action: "cancel", content: null, _meta: null } }]);
    assert.ok(result.responseRecordedAfterMs > 30);
    assert.equal(adapter.pendingApprovals().length, 0);
  } finally { await adapter.stop(); }
});

test("recognized MCP tool confirmations use one-shot actions without persist grants", async () => {
  const { adapter, workspace } = await setup();
  try {
    await adapter.start(); await adapter.startThread(workspace); await adapter.send("thread-1", "mcp-consents");
    await waitFor(() => adapter.pendingApprovals().length === 3, "MCP confirmation requests");
    const approvals = adapter.pendingApprovals();
    assert.deepEqual(approvals.map((approval) => approval.id), [0, "0", 2]);
    assert.ok(approvals.every((approval) => approval.method === "mcpServer/elicitation/request"));
    assert.ok(approvals.every((approval) => JSON.stringify(approval.decisions) === JSON.stringify(["accept", "decline", "cancel"])));
    await assert.rejects(adapter.approve(approvals[0].generation, 0, "acceptForSession"), /not allowed/);
    await adapter.approve(approvals[0].generation, 0, "accept");
    await adapter.approve(approvals[1].generation, "0", "decline");
    await adapter.approve(approvals[2].generation, 2, "cancel");
    const result = await adapter.models() as any;
    assert.deepEqual(result.responses, [
      { id: 0, result: { action: "accept", content: {}, _meta: null } },
      { id: "0", result: { action: "decline", content: null, _meta: null } },
      { id: 2, result: { action: "cancel", content: null, _meta: null } },
    ]);
    await assert.rejects(adapter.approve(approvals[0].generation, 0, "accept"), /no longer pending/);
    await adapter.stop(); await adapter.start(); await adapter.startThread(workspace); await adapter.send("thread-1", "mcp-consents");
    await waitFor(() => adapter.pendingApprovals().length === 3, "MCP confirmations after restart");
    await assert.rejects(adapter.approve(approvals[0].generation, 0, "accept"), /expired/);
    assert.equal(adapter.pendingApprovals().length, 3);
  } finally { await adapter.stop(); }
});

test("MCP forms with data fields, unknown origins or standalone turns fail closed", async () => {
  const { adapter, workspace, events } = await setup();
  try {
    await adapter.start(); await adapter.startThread(workspace); await adapter.send("thread-1", "mcp-unsupported");
    await waitFor(() => events.filter((event) => event.method === "engine/diagnostic" && (event.params as any).details?.id?.startsWith?.("unsupported-")).length === 16, "unsupported form diagnostics");
    const result = await adapter.models() as any;
    assert.equal(result.responses.length, 16);
    assert.ok(result.responses.every((response: any) => JSON.stringify(response.result) === JSON.stringify({ action: "cancel", content: null, _meta: null })));
    assert.equal(adapter.pendingApprovals().length, 0);
  } finally { await adapter.stop(); }
});

test("server resolution removes MCP confirmation and duplicate callback IDs fail connection", async () => {
  const first = await setup();
  try {
    await first.adapter.start(); await first.adapter.startThread(first.workspace); await first.adapter.send("thread-1", "mcp-resolved");
    await waitFor(() => first.events.some((event) => event.method === "serverRequest/resolved"), "MCP resolution notification");
    assert.equal(first.adapter.pendingApprovals().length, 0);
  } finally { await first.adapter.stop(); }
  const second = await setup();
  try {
    await second.adapter.start(); await second.adapter.startThread(second.workspace);
    await second.adapter.send("thread-1", "mcp-duplicate");
    await waitFor(() => second.adapter.state === "failed", "duplicate MCP callback rejection");
    assert.equal(second.adapter.pendingApprovals().length, 0);
  } finally { await second.adapter.stop(); }
});

test("MCP approval quota cancels excess callbacks rather than silently hanging them", async () => {
  const { adapter, workspace } = await setup();
  try {
    await adapter.start(); await adapter.startThread(workspace); await adapter.send("thread-1", "mcp-quota");
    await waitFor(() => adapter.pendingApprovals().length === 128, "bounded MCP approval queue");
    const result = await adapter.models() as any;
    assert.deepEqual(result.responses, [{ id: 128, result: { action: "cancel", content: null, _meta: null } }]);
    assert.equal(adapter.pendingApprovals().length, 128);
  } finally { await adapter.stop(); }
});

test("request timeout is reported without replaying the request", async () => {
  const { home } = await setup();
  await mkdir(home);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(?:CODEX|OPENAI|CHATGPT|ANTHROPIC|CLAUDE|TOKEN|SECRET|PASSWORD|API.?KEY|CREDENTIAL)/i.test(key)) env[key] = value;
  }
  const child = spawn(process.execPath, [join(root, "test-engine.mjs")], {
    env: { ...env, CODEX_HOME: home, FORGEDESK_TEST_SCENARIO: "timeout" },
    stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true, shell: false,
  });
  assert.ok(child.stdin && child.stdout && child.stderr);
  const adapter = new class extends CodexAdapter {
    protected override createProcess() { return child as ChildProcessWithoutNullStreams; }
  }({ executable: process.execPath, home, onEvent: () => {}, requestTimeoutMs: 700 });
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout fixture did not become ready")), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("message", (message) => {
        clearTimeout(timer);
        try { assert.deepEqual(message, { type: "fixtureReady" }); resolveReady(); }
        catch (error) { reject(error); }
      });
    });
    await adapter.start();
    await assert.rejects(adapter.models(), /timed out.*not replayed/);
    assert.equal(adapter.state, "ready");
  } finally { await adapter.stop(); if (child.exitCode === null) child.kill(); }
});

test("engine exit rejects pending calls and clears live state", async () => {
  const { adapter } = await setup("exit");
  try {
    await adapter.start(); await assert.rejects(adapter.models(), /exited/);
    assert.equal(adapter.state, "failed"); assert.deepEqual(adapter.pendingApprovals(), []);
  } finally { await adapter.stop(); }
});

test("malformed stdout fails initialization and terminates its engine", async () => {
  const { adapter } = await setup("bad-json");
  await assert.rejects(adapter.start(), /invalid JSON/); await adapter.stop();
});

test("oversized JSONL fails pending calls and unknown notification samples remain bounded", async () => {
  const first = await setup("oversized");
  try { await first.adapter.start(); await assert.rejects(first.adapter.models(), /size limit/); }
  finally { await first.adapter.stop(); }
  const second = await setup("unknown-flood");
  try {
    await second.adapter.start(); await second.adapter.models();
    assert.equal(second.events.filter((event) => event.method === "engine/diagnostic").length, 100);
    assert.equal(second.events.filter((event) => event.method === "unrecognized/event").length, 0);
  } finally { await second.adapter.stop(); }
});

test("turns retain controlled workspace and steer uses the current-turn precondition", async () => {
  const { adapter, workspace, events } = await setup();
  try {
    await adapter.start(); await assert.rejects(adapter.send("foreign", "hi"), /started or resumed/);
    await adapter.startThread(workspace, "fake-model", "App-owned project/task context"); await adapter.send("thread-1", "hello");
    const steer = await adapter.steer("thread-1", "turn-1", "change direction") as any;
    assert.equal(steer.params.expectedTurnId, "turn-1");
    await adapter.interrupt("thread-1", "turn-1");
    await waitFor(() => events.some((event) => event.method === "turn/completed"), "terminal turn event");
    const result = await adapter.models() as any;
    const turn = result.requests.find((request: any) => request.method === "turn/start").params;
    assert.equal(result.requests.find((request: any) => request.method === "thread/start").params.developerInstructions, "App-owned project/task context");
    assert.equal(turn.cwd, workspace); assert.equal(turn.approvalPolicy, "on-request");
    assert.equal(turn.sandboxPolicy.type, "workspaceWrite"); assert.equal(turn.sandboxPolicy.networkAccess, false);
    assert.deepEqual(turn.sandboxPolicy.writableRoots, [workspace]);
    assert.deepEqual(turn.input, [{ type: "text", text: "hello", text_elements: [] }]);
    await adapter.resumeThread("thread-1", workspace, "Restored app-owned task context");
    const resumed = await adapter.models() as any;
    assert.equal(resumed.requests.find((request: any) => request.method === "thread/resume").params.developerInstructions, "Restored app-owned task context");
    const completed = events.find((event) => event.method === "turn/completed") as any;
    assert.equal(completed.params.turn.status, "interrupted");
  } finally { await adapter.stop(); }
});

test("account/login return only public data and untrusted URL is rejected", async () => {
  const { adapter } = await setup();
  try {
    await adapter.start();
    assert.deepEqual(await adapter.account(), { account: { type: "chatgpt", email: "user@example.test", planType: "plus" }, requiresOpenaiAuth: true });
    assert.deepEqual(await adapter.login(), { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/oauth/authorize?state=public" });
  } finally { await adapter.stop(); }
  const bad = await setup("bad-login-url");
  try { await bad.adapter.start(); await assert.rejects(bad.adapter.login(), /untrusted/); }
  finally { await bad.adapter.stop(); }
});

test("workspace cannot contain engine data and env cannot override authentication", async () => {
  const { adapter, home } = await setup();
  try { await adapter.start(); await assert.rejects(adapter.startThread(home), /must not overlap/); }
  finally { await adapter.stop(); }
  assert.throws(() => new CodexAdapter({ executable: process.execPath, home, onEvent: () => {}, env: { OPENAI_API_KEY: "forbidden" } }), /not allowed/);
});

test("redaction removes token fields, bearer credentials, API keys and JWTs", () => {
  assert.deepEqual(redact({ accessToken: "secret", nested: [{ refresh_token: "secret", text: "Bearer abc.defghi sk-longsecretkey" }] }), {
    accessToken: "[redacted]", nested: [{ refresh_token: "[redacted]", text: "Bearer [redacted] [redacted]" }],
  });
  assert.equal(redact('config {"FORGEDESK_RUNNER_TOKEN":"sample-secret-123"}', 0, ["sample-secret-123"]), 'config {"FORGEDESK_RUNNER_TOKEN":"[redacted]"}');
  assert.equal(redact("unlabeled sample-secret-123", 0, ["sample-secret-123"]), "unlabeled [redacted]");
  assert.equal(redact('{"access_token":"plain-access-token-qa"}'), '{"access_token":"[redacted]"}');
});
