import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RestrictedFz3bAdapter, RESTRICTED_FZ3B_TOOLS, type RestrictedFz3bToolContext } from "./restricted-fz3b";
import { presetTools, presetToolSpecs, RESTRICTED_HARDWARE_TOOLS } from "./restricted-presets";
import type { EngineEvent } from "./index";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, "output/hardware/2026-10-16-next/product/engine-fixtures");
class Fixture extends RestrictedFz3bAdapter {
  constructor(home: string, private readonly scenario: string, events: EngineEvent[], callback: (context: RestrictedFz3bToolContext, name: string) => Promise<unknown>) {
    super({ executable: resolve(root, "vendor/codex/codex.exe"), home, onEvent: event => events.push(event), onToolCall: callback });
  }
  protected override async prepareRuntime(): Promise<void> { /* No engine, auth, model or hardware in this transport fixture. */ }
  protected override createProcess(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, [resolve(import.meta.dirname, "restricted-fz3b-fixture.mjs"), this.scenario, ...args], { env, stdio: "pipe", windowsHide: true, shell: false });
  }
}
async function scenario(name: string) {
  await mkdir(output, { recursive: true });
  const home = await mkdtemp(resolve(output, "home-"));
  const events: EngineEvent[] = [], calls: Array<{ context: RestrictedFz3bToolContext; name: string }> = [];
  const adapter = new Fixture(home, name, events, async (context, name) => { calls.push({ context, name }); return { offline: true }; });
  try {
    await adapter.start();
    const thread = await adapter.startThread("gpt-6.1-sol", "Host-owned bounded FZ3B context.");
    await adapter.send(thread, "Request the fixed tools only.");
    const end = Date.now() + 10000;
    while (!events.some(event => event.method === "turn/completed") && Date.now() < end) await delay(10);
    assert.ok(events.some(event => event.method === "turn/completed"));
    const result = JSON.parse((events.find(event => event.method === "item/agentMessage/delta")!.params as { delta: string }).delta);
    return { calls, result, policy: adapter.policySnapshot(), generation: adapter.connectionGeneration };
  } finally { await adapter.stop(); await rm(home, { recursive: true, force: true }); }
}

test("FZ3B inventory is an immutable closed preset distinct from unchanged STM32 tools", () => {
  assert.deepEqual(RESTRICTED_HARDWARE_TOOLS, ["embedded_status", "embedded_build", "embedded_inspect", "embedded_request_flash", "embedded_verify", "embedded_export"]);
  assert.deepEqual(RESTRICTED_FZ3B_TOOLS, ["fz3b_status", "fz3b_build", "fz3b_inspect", "fz3b_request_semantic", "fz3b_semantic", "fz3b_export"]);
  assert.ok(Object.isFrozen(RESTRICTED_FZ3B_TOOLS));
  assert.throws(() => presetTools("other" as never), /Unknown restricted/);
  assert.ok(presetToolSpecs("fz3b").every(value => JSON.stringify(value.inputSchema) === '{"type":"object","properties":{},"required":[],"additionalProperties":false}'));
});
test("FZ3B thread and policy use only six fixed parameterless tools", async () => {
  const { result, policy, calls, generation } = await scenario("normal");
  assert.equal(policy.profile, "restricted-fz3b");
  assert.deepEqual(policy.tools, RESTRICTED_FZ3B_TOOLS);
  assert.deepEqual(result.specs.map((value: { name: string }) => value.name), RESTRICTED_FZ3B_TOOLS);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { name: "fz3b_status", context: { generation, threadId: "thread-fz3b", turnId: "turn-fz3b", callId: "call-fz3b" } });
});
test("FZ3B rejects STM32 shell paths nonempty arguments and foreign binding", async () => {
  const { result, calls } = await scenario("invalid");
  assert.equal(calls.length, 0);
  assert.equal(result.responses.length, 8);
  assert.ok(result.responses.every((value: { error: unknown }) => value.error));
});
test("FZ3B typed request duplicates execute once and changed tool under same callId fails", async () => {
  const duplicate = await scenario("duplicate");
  assert.equal(duplicate.calls.length, 1);
  assert.deepEqual(duplicate.result.responses.map((value: { id: unknown }) => value.id), [0, "0"]);
  assert.deepEqual(duplicate.result.responses[0].result, duplicate.result.responses[1].result);
  const conflict = await scenario("conflict");
  assert.equal(conflict.calls.length, 1);
  assert.ok(conflict.result.responses.find((value: { id: string }) => value.id === "other").error);
});
test("FZ3B does not convert shell MCP or unknown requests into generic authorization", async () => {
  const { result, calls } = await scenario("approvals");
  assert.equal(calls.length, 0);
  assert.deepEqual(result.responses.find((value: { id: string }) => value.id === "shell").result, { decision: "cancel" });
  assert.deepEqual(result.responses.find((value: { id: string }) => value.id === "mcp").result, { action: "cancel", content: null, _meta: null });
  assert.ok(result.responses.find((value: { id: string }) => value.id === "unknown").error);
});
