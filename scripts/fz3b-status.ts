import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeFz3bClaimedStatus } from "../packages/engineering-runner/fz3b/index.js";

// This acknowledgement concerns known application-control side effects. It is
// not a native programming grant and cannot enable any programming operation.
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--acknowledge-control-effects") {
  throw new Error("Use --acknowledge-control-effects: status updates R5 telemetry and disconnect may stop orphaned camera inference. No programming is supported.");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = `status-${Date.now()}`;
const directory = join(root, "output", "hardware", "fz3b-status", runId);
await mkdir(directory, { recursive: true });
const sourceFiles = ["scripts/fz3b-status.ts", "packages/engineering-runner/fz3b/index.ts", "packages/engineering-runner/fz3b/internal.ts"];
async function sourceHashes() {
  const hashes: Record<string, string> = {};
  for (const file of sourceFiles) hashes[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
  return hashes;
}
const before = await sourceHashes();
const startedAtUtc = new Date().toISOString();
let record: Record<string, unknown>;
try {
  const observation = await probeFz3bClaimedStatus({ acknowledgeControlDisconnectEffect: true });
  if (JSON.stringify(before) !== JSON.stringify(await sourceHashes())) throw new Error("Probe source changed during execution");
  record = {
    schemaVersion: 1, result: "passed-status-only", runId,
    scope: "ForgeDesk fixed FZ3B application status client; not installed-app or model acceptance",
    boardProgramming: "not-attempted", computeAcceptance: "not-attempted",
    observation,
  };
} catch (error) {
  record = {
    schemaVersion: 1, result: "failed", runId,
    scope: "ForgeDesk fixed FZ3B application status client",
    error: error instanceof Error ? error.message : "Unknown status failure",
    boardProgramming: "not-attempted", computeAcceptance: "not-attempted",
  };
  process.exitCode = 1;
}
Object.assign(record, { startedAtUtc, endpoint: "169.254.220.254:8765", sourceSha256: before });
const evidence = join(directory, "evidence.json");
const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
await writeFile(evidence, bytes, { flag: "wx" });
console.log(JSON.stringify({ result: record.result, evidence, sha256: createHash("sha256").update(bytes).digest("hex") }));
