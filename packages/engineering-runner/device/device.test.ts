import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeviceOperationCoordinator } from "./operations.js";
import { DeviceUnavailableAdapter, deviceKey, sha256, type DeviceAdapter, type DeviceAuthorization, type FlashOutcome, type FlashRequest } from "./types.js";
import { UartVerificationSession } from "./uart.js";

const artifactSha256 = "a".repeat(64);
const acceptanceDigest = "b".repeat(64);

function fixtureRequest(requestKey = "fixture-request"): FlashRequest {
  return {
    taskId: "fixture-task",
    artifactId: "fixture-artifact",
    artifactSha256,
    buildId: "fixture-build",
    profile: { schemaVersion: 1, id: "fixture-profile", revision: "r1", chipTarget: "fixture-chip", adapterId: "fixture-simulation", enabled: true },
    identity: { usbVid: "1234", usbPid: "ABCD", probeSerial: "SIM-001", chipTarget: "fixture-chip", serialPort: "COM99", identityEvidence: "simulation only" },
    acceptanceDigest,
    policyVersion: "fixture-policy-v1",
    requestKey,
    authorizationId: "fixture-user-grant",
  };
}

function fixtureGrant(request: FlashRequest): DeviceAuthorization {
  return {
    schemaVersion: 1,
    id: request.authorizationId,
    taskId: request.taskId,
    artifactSha256: request.artifactSha256,
    deviceKey: deviceKey(request.identity),
    chipTarget: request.identity.chipTarget,
    profileId: request.profile.id,
    profileRevision: request.profile.revision,
    acceptanceDigest: request.acceptanceDigest,
    policyVersion: request.policyVersion,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedBy: "user",
  };
}

class FixtureSimulationAdapter implements DeviceAdapter {
  readonly id = "fixture-simulation";
  readonly available = true;
  calls = 0;
  exited = false;
  outcome: FlashOutcome = { status: "succeeded", processExited: true, receipt: "SIMULATED; no hardware written" };

  async flash(): Promise<FlashOutcome> {
    this.calls++;
    return this.outcome;
  }

  async confirmProcessExited(): Promise<boolean> {
    return this.exited;
  }
}

async function fixture(callback: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "forgedesk-device-fixture-"));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("default adapter is unavailable and cannot start a device operation", async () => fixture(async root => {
  const request = fixtureRequest();
  const coordinator = new DeviceOperationCoordinator(root, { get: async () => fixtureGrant(request) }, new DeviceUnavailableAdapter());
  await assert.rejects(coordinator.flash(request), /unavailable|No real board/);
  assert.deepEqual(await coordinator.list(), []);
}));

test("fixture simulation deduplicates requests and rejects key reuse with changed arguments", async () => fixture(async root => {
  const request = fixtureRequest();
  const adapter = new FixtureSimulationAdapter();
  const coordinator = new DeviceOperationCoordinator(root, { get: async () => fixtureGrant(request) }, adapter);
  const first = await coordinator.flash(request);
  assert.equal(first.status, "succeeded");
  assert.equal(first.receipt, "SIMULATED; no hardware written");
  assert.equal((await coordinator.flash(request)).id, first.id);
  assert.equal(adapter.calls, 1);
  await assert.rejects(coordinator.flash({ ...request, artifactSha256: "c".repeat(64) }), /different arguments/);
}));

test("authorization binds artifact, target, profile revision and expiry", async () => fixture(async root => {
  const request = fixtureRequest();
  const adapter = new FixtureSimulationAdapter();
  const grant = fixtureGrant(request);
  const coordinator = new DeviceOperationCoordinator(root, { get: async () => grant }, adapter);
  await assert.rejects(coordinator.flash({ ...request, profile: { ...request.profile, revision: "r2" } }), /profileRevision/);
  await assert.rejects(coordinator.flash({ ...request, identity: { ...request.identity, probeSerial: "OTHER" } }), /deviceKey/);
  grant.expiresAt = "2000-01-01T00:00:00.000Z";
  await assert.rejects(coordinator.flash(request), /expired/);
  assert.equal(adapter.calls, 0);
}));

test("unknown outcome blocks another request until adapter confirms process exit", async () => fixture(async root => {
  const firstRequest = fixtureRequest("first");
  const secondRequest = fixtureRequest("second");
  const adapter = new FixtureSimulationAdapter();
  adapter.outcome = { status: "unknown", processExited: false, detail: "fixture timeout" };
  const coordinator = new DeviceOperationCoordinator(root, { get: async () => fixtureGrant(firstRequest) }, adapter);
  const first = await coordinator.flash(firstRequest);
  assert.equal(first.status, "unknown");
  assert.equal((await coordinator.flash(secondRequest)).status, "failed");
  await assert.rejects(coordinator.releaseAfterConfirmedExit("first", "fixture process query"), /not confirmed/);
  adapter.exited = true;
  const reconciled = await coordinator.releaseAfterConfirmedExit("first", "fixture process exited");
  assert.equal(reconciled.status, "unknown");
  adapter.outcome = { status: "succeeded", processExited: true, receipt: "SIMULATED" };
  const third = await coordinator.flash(fixtureRequest("third"));
  assert.equal(third.status, "succeeded");
  assert.equal(adapter.calls, 2);
}));

test("startup recovery persists unknown without replaying a running operation", async () => fixture(async root => {
  const request = fixtureRequest("interrupted");
  const adapter = new FixtureSimulationAdapter();
  const directory = join(root, "operations", sha256(request.requestKey));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "state.json"), JSON.stringify({
    schemaVersion: 1,
    id: "interrupted-operation",
    requestKey: request.requestKey,
    argsDigest: "recorded-digest",
    deviceKey: deviceKey(request.identity),
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const coordinator = new DeviceOperationCoordinator(root, { get: async () => fixtureGrant(request) }, adapter);
  const recovered = await coordinator.recoverInterrupted();
  assert.equal(recovered[0]?.status, "unknown");
  assert.equal(JSON.parse(await readFile(join(directory, "state.json"), "utf8")).status, "unknown");
  assert.equal(adapter.calls, 0);
}));

test("UART parser rejects old, wrong and oversized responses", () => {
  const session = new UartVerificationSession("build-7", 1024);
  assert.throws(() => session.parseLine("{}"), /before this session/);
  const command = JSON.parse(session.request()) as { nonce: string; buildId: string };
  assert.equal(command.buildId, "build-7");
  assert.throws(() => session.parseLine(JSON.stringify({ type: "forge.verify.response", nonce: "old", buildId: "build-7", result: true })), /Stale or wrong/);
  assert.throws(() => session.parseLine(JSON.stringify({ type: "forge.verify.response", nonce: command.nonce, buildId: "old-build", result: true })), /Stale or wrong/);
  const valid = session.parseLine(JSON.stringify({ type: "forge.verify.response", nonce: command.nonce, buildId: "build-7", result: { ok: true } }));
  assert.deepEqual(valid.result, { ok: true });
  assert.throws(() => session.parseLine(JSON.stringify(valid)), /already complete/);
  const limited = new UartVerificationSession("build-7", 10);
  limited.request();
  assert.throws(() => limited.parseLine("x".repeat(11)), /size limit/);
});
