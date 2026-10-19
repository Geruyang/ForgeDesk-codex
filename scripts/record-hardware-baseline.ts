import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareStm32FlashReadback, requiredStm32EraseSectors, validateStm32FlashCandidate } from "../packages/engineering-runner/device/stm32-target.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = join(root, "output/hardware/2026-10-15");
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const inspection = await readJson(join(base, "inspection-01/evidence.json"));
const health = await readJson(join(base, "health-01/evidence.json"));
const cdc = await readJson(join(base, "cdc-sample-01/evidence.json"));
assert.equal(inspection.result, "passed");
assert.equal(health.result, "passed");
assert.equal(health.diagnostics.result, "passed");
assert.equal(inspection.uid, health.uid);
assert.equal(cdc.result, "passed");
assert.equal(cdc.expectedUid, inspection.uid);
assert.equal(cdc.shutdown.closed, true);
assert.ok(cdc.validatedFrameCount >= 2);
const hex = await readFile(join(base, "GestureScreen/firmware/GestureScreen.hex"));
const backup = await readFile(join(base, "inspection-01/internal-flash-before.bin"));
const after = await readFile(join(base, "health-01/internal-flash-before.bin"));
assert.equal(sha256(backup), inspection.backupSha256);
assert.equal(sha256(after), health.backupSha256);
assert.equal(sha256(backup), sha256(after), "Flash must remain unchanged across lab observations");
const candidate = validateStm32FlashCandidate({
  observation: {
    probe: { usbVid: "1FC9", usbPid: "5601", serial: inspection.probeSerial },
    chip: { dbgMcuIdcode: Number(inspection.debugMcuId), flashSizeKiB: inspection.flashKiB, uid96: inspection.uid },
    board: { confirmedV1: true, source: "user", confirmationId: "human-response-call_afed72fa641340c0b12514069c4b7096" },
  },
  expectedUid96: "0037001b3133510432383236", artifactHex: hex,
  expectedArtifactSha256: "2a654ebc9243906abf8466266a79af1c5233e05d978654d0dcfa2ae3cbb9327f",
  eraseMode: "sectors", eraseSectorStarts: requiredStm32EraseSectors(hex),
});
const readback = compareStm32FlashReadback(hex, backup);
assert.equal(readback.mismatchBytes, 0);
const testLog = await readFile(join(base, "full-suite.log"), "utf8");
const summaryValue = (key: string) => {
  const found = testLog.match(new RegExp(`^(?:#|\\u2139) ${key} (\\d+)\\r?$`, "m"));
  assert.ok(found, `Missing completed regression summary: ${key}`);
  return Number(found[1]);
};
const total = summaryValue("tests");
assert.ok(total > 0);
assert.equal(summaryValue("pass"), total);
assert.equal(summaryValue("fail"), 0);
assert.equal(summaryValue("cancelled"), 0);
assert.equal(summaryValue("skipped"), 0);
assert.doesNotMatch(await readFile(join(base, "typecheck-final.log"), "utf8"), /error TS\d+/);
const cdcTestLog = await readFile(join(base, "cdc-unit.log"), "utf8");
const cdcTestCount = cdcTestLog.match(/Ran (\d+) tests/);
assert.ok(cdcTestCount);
assert.match(cdcTestLog, /(?:^|\n)OK\r?\n/);
const files = [
  "inspection-01/evidence.json", "inspection-01/internal-flash-before.bin",
  "health-01/evidence.json", "cdc-sample-01/evidence.json", "diagnostic-layout.json",
  "GestureScreen/firmware/GestureScreen.hex", "GestureScreen/firmware/GestureScreen.axf",
  "GestureScreen/Build/keil-build.log", "GestureScreen/Build/artifact-audit.json",
  "full-suite.log", "typecheck.log", "typecheck-final.log", "cdc-unit.log",
];
const manifest = [];
for (const path of files) {
  const data = await readFile(join(base, path));
  manifest.push({ path, bytes: data.length, sha256: sha256(data) });
}
const evidence = {
  schemaVersion: 1, recordedAt: new Date().toISOString(),
  scope: "real-board-prerequisites-plus-source-gate-regression-not-installed-T2",
  result: "baseline-passed-product-T2-incomplete",
  repository: "https://github.com/Geruyang/GestureScreen", firmwareCommit: "c8ae2c906b3d8845b5d5b757099a43332bd6b985",
  candidateValidation: candidate, erasePlanExecuted: false, flashWritten: false, readback,
  usbValidatedFrameCount: cdc.validatedFrameCount, usbElapsedSeconds: cdc.elapsedSeconds,
  healthCheckCount: health.diagnostics.checks.length,
  regression: { nodeTests: total, nodeFailures: 0, cdcPureTests: Number(cdcTestCount[1]), typecheckFinalExitCode: 0,
    initialTypecheck: "One new test getter inferred void; corrected to never. Original failure log retained." },
  applicationRuntimeChanged: false, secondAccountValidation: "paused",
  limitations: [
    "No flash/erase/reset/halt was performed; existing firmware already matches the rebuilt HEX.",
    "Source candidate validation is not an installed application grant or device adapter.",
    "CDC 32-bit epoch and SWD flash comparison are not the product 128-bit nonce/build-ID verifier.",
    "Product device routes remain disabled; general approved shell access is not an OS device-access isolation claim.",
    "No visual LCD/gesture accuracy, disconnect-during-flash, installed grant/restart or hardware contention acceptance.",
  ],
  manifest,
};
await writeFile(join(base, "baseline.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ result: evidence.result, readback, usbFrames: cdc.validatedFrameCount,
  healthChecks: evidence.healthCheckCount, evidence: join(base, "baseline.json") }, null, 2));
