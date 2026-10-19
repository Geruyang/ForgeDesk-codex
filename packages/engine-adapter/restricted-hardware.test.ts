import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RestrictedHardwareAdapter, RESTRICTED_HARDWARE_TOOLS, type RestrictedHardwareToolContext } from "./restricted-hardware";
import type { EngineEvent } from "./index";

const root = resolve(import.meta.dirname, "../..");
const output = resolve(root, "output/hardware/2026-10-16/restricted-hardware/test-fixtures");
async function temporaryHome(prefix = "restricted-") { await mkdir(output, { recursive: true }); return mkdtemp(resolve(output, prefix)); }
class Fixture extends RestrictedHardwareAdapter {
  launches: string[][] = [];
  constructor(home: string, private readonly scenario: string, events: EngineEvent[], callback: (context: RestrictedHardwareToolContext) => Promise<unknown>, timeout = 10000) {
    super({ executable: resolve(root, "vendor/codex/codex.exe"), home, onEvent: value => events.push(value), onToolCall: context => callback(context), requestTimeoutMs: timeout });
  }
  protected override async prepareRuntime(): Promise<void> { /* Transport fixture never runs the engine. */ }
  protected override createProcess(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
    this.launches.push(args);
    return spawn(process.execPath, [resolve(import.meta.dirname, "restricted-hardware-fixture.mjs"), this.scenario, ...args], { env, stdio: "pipe", windowsHide: true });
  }
}
async function setup(scenario = "normal", callback: (context: RestrictedHardwareToolContext) => Promise<unknown> = async () => ({ ok: true }), timeout?: number) {
  const home = await temporaryHome();
  const events: EngineEvent[] = [];
  const adapter = new Fixture(home, scenario, events, callback, timeout);
  try { await adapter.start(); } catch (error) { await adapter.stop(); await rm(home, { recursive: true, force: true }); throw error; }
  return { adapter, events, async close() { await adapter.stop(); await rm(home, { recursive: true, force: true }); } };
}
async function waitFor(events: EngineEvent[], method: string): Promise<EngineEvent> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const event = events.find(item => item.method === method); if (event) return event; await delay(10); }
  throw new Error(`Missing event ${method}`);
}
async function begin(adapter: Fixture) { const threadId = await adapter.startThread("gpt-6.1-sol", "App-owned fixed test context"); await adapter.send(threadId, "Run the fixed flow"); return threadId; }
function replies(events: EngineEvent[]): Array<{ id: string | number; result?: unknown; error?: unknown }> {
  return JSON.parse((events.find(event => event.method === "item/agentMessage/delta")!.params as { delta: string }).delta);
}

test("restricted policy is fixed, public account is projected, and external MCP is disabled before a thread", async () => {
  const value = await setup("mcp");
  try {
    assert.equal(value.adapter.launches.length, 2);
    assert.ok(value.adapter.launches[1].includes("mcp_servers.engineering.enabled=false"));
    assert.deepEqual(value.adapter.policySnapshot().tools, RESTRICTED_HARDWARE_TOOLS);
    assert.deepEqual(value.adapter.policySnapshot().environments, []);
    assert.equal(JSON.stringify(await value.adapter.account()).includes("must-not-leak"), false);
    await assert.rejects(value.adapter.startThread("unknown-fallback", "context"), /pinned model/);
    const threadId = await value.adapter.startThread("gpt-6.1-sol", "context");
    await assert.rejects(value.adapter.startThread("gpt-6.1-sol", "context"), /one fresh thread/);
    await assert.rejects(value.adapter.send(threadId, "test", "unknown"), /pinned model/);
  } finally { await value.close(); }
});
test("restricted dynamic call binds thread, turn, generation, and call ID with typed RPC deduplication", async () => {
  const contexts: RestrictedHardwareToolContext[] = [];
  const value = await setup("duplicate", async context => { contexts.push(context); await delay(50); return { outcome: "ok" }; });
  try {
    await begin(value.adapter); await waitFor(value.events, "turn/completed");
    assert.equal(contexts.length, 1);
    assert.deepEqual(contexts[0], { generation: value.adapter.connectionGeneration, threadId: "thread-1", turnId: "turn-1", callId: "call-1" });
    assert.deepEqual(replies(value.events).map(value => value.id), [0, "0"]);
    assert.deepEqual(replies(value.events)[0].result, replies(value.events)[1].result);
    await assert.rejects(value.adapter.send("thread-1", "again"), /one turn/);
  } finally { await value.close(); }
});
test("restricted invalid schemas and foreign bindings never reach the host", async () => {
  let count = 0; const value = await setup("invalid", async () => { ++count; return {}; });
  try { await begin(value.adapter); await waitFor(value.events, "turn/completed"); assert.equal(count, 0); assert.equal(replies(value.events).length, 7); assert.ok(replies(value.events).every(value => value.error)); }
  finally { await value.close(); }
});
test("restricted same call ID with a different fixed tool is rejected without replay", async () => {
  let count = 0; const value = await setup("conflict", async () => { ++count; return {}; });
  try { await begin(value.adapter); await waitFor(value.events, "turn/completed"); assert.equal(count, 1); assert.ok(replies(value.events).find(value => value.id === "other")?.error); }
  finally { await value.close(); }
});
test("restricted completed duplicate server ID reuses the result without executing again", async () => {
  let count = 0; const value = await setup("duplicate-completed", async () => { ++count; return {}; });
  try { await begin(value.adapter); await waitFor(value.events, "turn/completed"); assert.equal(count, 1); assert.equal(replies(value.events).length, 2); assert.deepEqual(replies(value.events)[0], replies(value.events)[1]); }
  finally { await value.close(); }
});
test("restricted unknown, shell approval, and MCP requests fail closed", async () => {
  const value = await setup("unknown");
  try { await begin(value.adapter); await waitFor(value.events, "turn/completed"); const results = replies(value.events); assert.deepEqual(results.find(value => value.id === "cmd")?.result, { decision: "cancel" }); assert.deepEqual(results.find(value => value.id === "mcp")?.result, { action: "cancel", content: null, _meta: null }); assert.ok(results.find(value => value.id === "unknown")?.error); }
  finally { await value.close(); }
});
test("restricted long host callbacks do not use the outbound request deadline", async () => {
  const value = await setup("normal", async () => { await delay(120); return { access_token: "secret-value", message: "ok" }; });
  Reflect.set(value.adapter, "timeout", 80);
  try { await begin(value.adapter); await waitFor(value.events, "turn/completed"); assert.equal(value.events.some(value => value.method === "engine/requestTimeout"), false); assert.equal(JSON.stringify(replies(value.events)).includes("secret-value"), false); }
  finally { await value.close(); }
});
test("restricted stop invalidates late callbacks and confirms the child is closed", async () => {
  let finish!: (value: unknown) => void;
  const value = await setup("normal", () => new Promise(resolve => { finish = resolve; }));
  try {
    await begin(value.adapter); await waitFor(value.events, "engine/restrictedTool");
    const generation = value.adapter.connectionGeneration; await value.adapter.stop();
    assert.equal(value.adapter.state, "stopped"); assert.ok(value.adapter.connectionGeneration > generation);
    finish({ ok: true }); await delay(20);
    assert.equal(value.events.filter(value => value.method === "engine/restrictedTool").length, 1);
    assert.throws(() => value.adapter.policySnapshot(), /not verified/);
  } finally { await value.close(); }
});
test("restricted foreign completion cannot end the bound turn", async () => {
  const value = await setup("foreign");
  try { await begin(value.adapter); await waitFor(value.events, "turn/completed"); assert.equal(value.events.filter(value => value.method === "turn/completed").length, 1); }
  finally { await value.close(); }
});
test("restricted same-chunk protocol failure revokes a queued host call", async () => {
  let count = 0; const value = await setup("malformed", async () => { ++count; return {}; });
  try { await begin(value.adapter); await waitFor(value.events, "engine/error"); await delay(20); assert.equal(count, 0); assert.equal(value.adapter.state, "failed"); }
  finally { await value.close(); }
});
test("restricted model rerouting fails closed instead of accepting fallback metadata", async () => {
  const value = await setup("rerouted");
  try { await begin(value.adapter); await waitFor(value.events, "engine/error"); assert.equal(value.adapter.state, "failed"); }
  finally { await value.close(); }
});
test("restricted engine rejects an unpinned executable before starting it", async () => {
  const home = await temporaryHome("restricted-pin-");
  const adapter = new RestrictedHardwareAdapter({ executable: process.execPath, home, onEvent: () => {}, onToolCall: async () => ({}) });
  try { await assert.rejects(adapter.start(), /binary hash mismatch/); }
  finally { await adapter.stop(); await rm(home, { recursive: true, force: true }); }
});
test("restricted stop during preparation cannot start a late engine", async () => {
  const home = await temporaryHome(); const events: EngineEvent[] = [];
  let entered!: () => void; let release!: () => void;
  const enteredPromise = new Promise<void>(done => { entered = done; });
  const barrier = new Promise<void>(done => { release = done; });
  class SlowFixture extends Fixture { protected override async prepareRuntime() { entered(); await barrier; } }
  const adapter = new SlowFixture(home, "normal", events, async () => ({}));
  const startup = adapter.start();
  await enteredPromise;
  const stopping = adapter.stop(); release();
  await assert.rejects(startup, /cancelled/); await stopping;
  assert.equal(adapter.launches.length, 0); assert.equal(adapter.state, "stopped");
  await rm(home, { recursive: true, force: true });
});

class FakeUtility extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills = 0;
  constructor(private readonly signal: () => boolean) { super(); }
  kill() { ++this.kills; return this.signal(); }
}
function utilityFixture(utility: FakeUtility) {
  const events: EngineEvent[] = [];
  class UtilityOnlyAdapter extends RestrictedHardwareAdapter {
    preparations = 0;
    protected override async prepareRuntime(): Promise<void> { ++this.preparations; throw new Error("Unexpected runtime preparation"); }
  }
  const adapter = new UtilityOnlyAdapter({ executable: process.execPath, home: resolve(output, "pure-utility-home"), onEvent: event => events.push(event), onToolCall: async () => { throw new Error("Unexpected host call"); } });
  const ledger = new Map([["held-call", { outcome: "unknown" }]]);
  Reflect.set(adapter, "utility", utility);
  Reflect.set(adapter, "calls", ledger);
  Reflect.set(adapter, "threadId", "held-thread");
  Reflect.set(adapter, "phase", "starting");
  return { adapter, events, ledger };
}
for (const signalAccepted of [false, true]) {
  test(`restricted utility kill=${signalAccepted} without close fails within five seconds and preserves unknown state`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const utility = new FakeUtility(() => signalAccepted);
    const { adapter, events, ledger } = utilityFixture(utility);
    const generation = adapter.connectionGeneration;
    const stopping = adapter.stop();
    const rejected = assert.rejects(stopping, /Restricted utility exit was not confirmed/);
    t.mock.timers.tick(4999); await Promise.resolve();
    assert.equal(adapter.state, "stopping");
    t.mock.timers.tick(1); await rejected;
    assert.equal(adapter.state, "failed");
    assert.equal(adapter.connectionGeneration, generation);
    assert.equal(Reflect.get(adapter, "utility"), utility);
    assert.equal(Reflect.get(adapter, "threadId"), "held-thread");
    assert.equal(Reflect.get(adapter, "calls"), ledger);
    assert.equal(ledger.size, 1);
    assert.equal(utility.kills, 1);
    assert.equal(events.some(event => event.method === "engine/state" && (event.params as { state: string }).state === "stopped"), false);
    utility.emit("close", 0, null);
    assert.equal(adapter.state, "failed");
    await adapter.stop();
    assert.equal(adapter.state, "stopped");
  });
}
test("restricted utility exit code alone cannot substitute for close confirmation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const utility = new FakeUtility(() => false); utility.exitCode = 0;
  const { adapter } = utilityFixture(utility);
  const rejected = assert.rejects(adapter.stop(), /utility exit was not confirmed/);
  t.mock.timers.tick(5000); await rejected;
  assert.equal(adapter.state, "failed");
  assert.equal(Reflect.get(adapter, "utility"), utility);
  utility.emit("close", 0, null); await adapter.stop();
});
test("restricted utility close, not kill return value, permits a successful stop", async () => {
  const utility = new FakeUtility(() => false);
  const { adapter } = utilityFixture(utility);
  const generation = adapter.connectionGeneration;
  const stopping = adapter.stop();
  assert.equal(adapter.state, "stopping");
  utility.emit("close", 0, null); await stopping;
  assert.equal(adapter.state, "stopped");
  assert.ok(adapter.connectionGeneration > generation);
  assert.equal(Reflect.get(adapter, "utility"), undefined);
});
test("restricted utility kill throwing preserves its error and unresolved process reference", async () => {
  const original = new Error("Fixture signal denied");
  const utility = new FakeUtility(() => { throw original; });
  const { adapter, ledger } = utilityFixture(utility);
  await assert.rejects(adapter.stop(), error => error === original);
  assert.equal(adapter.state, "failed");
  assert.equal(Reflect.get(adapter, "utility"), utility);
  assert.equal(ledger.size, 1);
  assert.equal(utility.listenerCount("close"), 1);
  utility.emit("close", null, "SIGTERM");
  assert.equal(adapter.state, "failed");
  await adapter.stop();
});
test("restricted utility retries remain bounded without spawning or losing late-close tracking", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const utility = new FakeUtility(() => true);
  const { adapter } = utilityFixture(utility);
  const first = adapter.stop();
  assert.equal(adapter.stop(), first);
  const firstRejected = assert.rejects(first, /utility exit was not confirmed/);
  t.mock.timers.tick(5000); await firstRejected;
  const retryRejected = assert.rejects(adapter.start(), /utility exit was not confirmed/);
  t.mock.timers.tick(5000); await retryRejected;
  assert.equal(adapter.preparations, 0);
  assert.equal(adapter.state, "failed");
  assert.equal(Reflect.get(adapter, "utility"), utility);
  assert.equal(utility.kills, 2);
  assert.equal(utility.listenerCount("close"), 1);
  utility.emit("close", 0, null);
  assert.equal(adapter.state, "failed");
  await adapter.stop();
});
