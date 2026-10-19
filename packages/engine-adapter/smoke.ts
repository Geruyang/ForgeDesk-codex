import { mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAdapter, type EngineEvent } from "./index";

const executable = process.argv[2];
if (!executable) throw new Error("Pass an absolute official Codex executable path");
const root = dirname(fileURLToPath(import.meta.url));
const home = await mkdtemp(join(resolve(root, ".protocol-home"), "smoke-"));
const events: EngineEvent[] = [];
const adapter = new CodexAdapter({ executable, home, processHost: process.argv[3], onEvent: (event) => {
  if (events.length < 30) events.push(event);
} });
try {
  await adapter.start();
  const models = await adapter.models();
  const account = await adapter.account();
  process.stdout.write(`${JSON.stringify({ home, state: adapter.state, models, account, events }, null, 2)}\n`);
} finally {
  await adapter.stop();
}
