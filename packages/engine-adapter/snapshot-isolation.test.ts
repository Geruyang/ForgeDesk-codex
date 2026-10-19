import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CodexAdapter } from "./index";
import { calculateSnapshotPolicyDigest, digestSnapshotPolicyValue, probeSnapshotIsolation, SNAPSHOT_SANDBOX_ARGS, type SnapshotIsolationOptions, type SnapshotPolicyEvidence } from "./snapshot-isolation";
import { workspaceSandboxArgs, WORKSPACE_PERMISSION_PROFILE_ID } from "./workspace-policy";

const root = dirname(fileURLToPath(import.meta.url));
const project = resolve(root, "../..");
const cli = join(project, "vendor", "codex", "codex.exe");
const host = join(project, "vendor", "process-host", "process-host.exe");
async function folders() {
  const base = join(root, ".test-output");
  await mkdir(base, { recursive: true });
  const run = await mkdtemp(join(base, "snapshot-"));
  const projectRoot = join(run, "native workspace");
  const dataDir = join(run, "data");
  const home = join(dataDir, "engine");
  const protectedRoot = join(dataDir, "engineering", "snapshots");
  await mkdir(projectRoot); await mkdir(home, { recursive: true }); await mkdir(protectedRoot, { recursive: true });
  return { run, projectRoot, dataDir, home, protectedRoot };
}
function policy(projectRoot: string, home: string): SnapshotPolicyEvidence {
  return { schemaVersion: 1, method: "app-server/config-read", generation: 123, observedAt: new Date().toISOString(), projectRoot, home,
    effectivePolicySha256: digestSnapshotPolicyValue({ sandbox: "workspace-write" }), managedPolicySha256: digestSnapshotPolicyValue(null) };
}
async function digestOptions() {
  const paths = await folders();
  const fakeCli = join(paths.run, "fixture-codex.exe");
  const fakeHost = join(paths.run, "fixture-host.exe");
  await writeFile(fakeCli, "digest-only fake engine"); await writeFile(fakeHost, "digest-only fake host");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const options: SnapshotIsolationOptions = { ...paths, executable: fakeCli, processHost: fakeHost, nodeExecutable: process.execPath,
    policy: policy(paths.projectRoot, paths.home), currentGeneration: () => 123,
    expectedExecutableSha256: sha("digest-only fake engine"), expectedProcessHostSha256: sha("digest-only fake host") };
  return options;
}

test("snapshot digest is stable across reconnect timestamps and binds actual policy/root/binary changes", async () => {
  const options = await digestOptions();
  const original = await calculateSnapshotPolicyDigest(options);
  const reconnect = await calculateSnapshotPolicyDigest({ ...options, policy: { ...options.policy, generation: 999, observedAt: new Date().toISOString() } });
  assert.equal(original, reconnect);
  const changed = await calculateSnapshotPolicyDigest({ ...options, policy: { ...options.policy, effectivePolicySha256: digestSnapshotPolicyValue({ sandbox: "changed" }) } });
  assert.notEqual(original, changed);
  await assert.rejects(calculateSnapshotPolicyDigest({ ...options, expectedExecutableSha256: "0".repeat(64) }), /trusted engine manifest/);
  await assert.rejects(calculateSnapshotPolicyDigest({ ...options, policy: { ...options.policy, projectRoot: options.dataDir } }), /does not match/);
});

test("snapshot proof rejects overlapping roots, wrong snapshot location and stale generations before executing", async () => {
  const options = await digestOptions();
  await assert.rejects(calculateSnapshotPolicyDigest({ ...options, projectRoot: options.dataDir }), /must not overlap/);
  await assert.rejects(calculateSnapshotPolicyDigest({ ...options, protectedRoot: options.home }), /Snapshot root/);
  if (process.platform === "win32") {
    await assert.rejects(probeSnapshotIsolation({ ...options, currentGeneration: () => 124 }), /current connection/);
    await assert.rejects(probeSnapshotIsolation({ ...options, policy: { ...options.policy, observedAt: new Date(Date.now() - 61_000).toISOString() } }), /fresh policy/);
  }
  assert.ok(SNAPSHOT_SANDBOX_ARGS.includes("sandbox_workspace_write.writable_roots=[]"));
  assert.ok(SNAPSHOT_SANDBOX_ARGS.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(SNAPSHOT_SANDBOX_ARGS.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
  assert.ok(SNAPSHOT_SANDBOX_ARGS.includes("sandbox_workspace_write.exclude_slash_tmp=true"));
  assert.deepEqual(SNAPSHOT_SANDBOX_ARGS, workspaceSandboxArgs());
  assert.ok(SNAPSHOT_SANDBOX_ARGS.includes(WORKSPACE_PERMISSION_PROFILE_ID));
  assert.equal(SNAPSHOT_SANDBOX_ARGS[SNAPSHOT_SANDBOX_ARGS.indexOf("--permission-profile") + 1], WORKSPACE_PERMISSION_PROFILE_ID);
});

test("real pinned CLI produces an auditable native denial receipt and removes only unique probe files", {
  skip: process.platform !== "win32" || !existsSync(cli) || !existsSync(host),
}, async () => {
  const paths = await folders();
  const source = join(paths.projectRoot, "source.mjs");
  const sourceBytes = "export const value = 42;\n";
  await writeFile(source, sourceBytes);
  const adapter = new CodexAdapter({ executable: cli, processHost: host, home: paths.home, onEvent: () => {} });
  try {
    await adapter.start();
    const evidence = await adapter.snapshotPolicy(paths.projectRoot);
    assert.equal(evidence.generation, adapter.connectionGeneration);
    assert.equal(evidence.method, "app-server/config-read");
    const options: SnapshotIsolationOptions = { ...paths, executable: cli, processHost: host, nodeExecutable: process.execPath, policy: evidence,
      currentGeneration: () => adapter.connectionGeneration };
    const receipt = await probeSnapshotIsolation(options);
    assert.equal(receipt.policyDigest, await calculateSnapshotPolicyDigest(options));
    const bytes = await readFile(receipt.probeLogRef);
    assert.equal(receipt.probeLogSha256, createHash("sha256").update(bytes).digest("hex"));
    const log = JSON.parse(bytes.toString("utf8"));
    assert.equal(log.writeDenied, true); assert.equal(log.workspaceWritten, true); assert.equal(log.cleanupComplete, true);
    assert.equal(log.probe.code, 0); assert.equal(log.probe.timedOut, false);
    assert.ok(["EPERM", "EACCES"].includes(log.probe.report.protected.code));
    assert.equal(log.originalSha256, log.protectedAfterSha256);
    assert.equal(log.failure, null);
    assert.equal(await readFile(source, "utf8"), sourceBytes);
    assert.deepEqual(await readdir(paths.projectRoot), ["source.mjs"]);
    assert.deepEqual(await readdir(paths.protectedRoot), []);
    assert.ok(!bytes.toString("utf8").includes("FORGEDESK_RUNNER_TOKEN"));
    process.stdout.write(`Native snapshot probe receipt: ${receipt.probeLogRef}\n`);

    const beforeLogs = new Set(await readdir(dirname(receipt.probeLogRef)));
    const secondPolicy = await adapter.snapshotPolicy(paths.projectRoot);
    let generationReads = 0;
    await assert.rejects(probeSnapshotIsolation({ ...options, policy: secondPolicy, currentGeneration: () =>
      ++generationReads <= 2 ? adapter.connectionGeneration : adapter.connectionGeneration + 1 }), /current connection/);
    const newLog = (await readdir(dirname(receipt.probeLogRef))).find((name) => !beforeLogs.has(name));
    assert.ok(newLog);
    const invalidated = JSON.parse(await readFile(join(dirname(receipt.probeLogRef), newLog), "utf8"));
    assert.equal(invalidated.observedWriteDenied, true);
    assert.equal(invalidated.writeDenied, false);
    assert.equal(invalidated.cleanupComplete, true);
    assert.match(invalidated.failure, /current connection/);
    assert.deepEqual(await readdir(paths.projectRoot), ["source.mjs"]);
    assert.deepEqual(await readdir(paths.protectedRoot), []);
  } finally { await adapter.stop(); }
});
