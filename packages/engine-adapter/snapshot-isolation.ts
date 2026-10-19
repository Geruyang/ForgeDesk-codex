import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { workspaceSandboxArgs } from "./workspace-policy";

export type SnapshotPolicyEvidence = {
  schemaVersion: 1;
  method: "app-server/config-read";
  generation: number;
  observedAt: string;
  projectRoot: string;
  home: string;
  effectivePolicySha256: string;
  managedPolicySha256: string;
};

export type SnapshotIsolationReceipt = {
  schemaVersion: 1;
  method: "engine-sandbox-write-denial";
  policyDigest: string;
  projectRoot: string;
  protectedRoot: string;
  verifiedAt: string;
  probeLogRef: string;
  probeLogSha256: string;
};

export type SnapshotIsolationOptions = {
  projectRoot: string;
  protectedRoot: string;
  dataDir: string;
  home: string;
  executable: string;
  processHost: string;
  nodeExecutable: string;
  policy: SnapshotPolicyEvidence;
  currentGeneration: () => number;
  expectedExecutableSha256?: string;
  expectedProcessHostSha256?: string;
  timeoutMs?: number;
};

export const SNAPSHOT_SANDBOX_ARGS: readonly string[] = Object.freeze(workspaceSandboxArgs());

const CODEX_SHA256 = "e98c516f1c8935789aabe9122ee7e05ec4c3efd1ba6acf179242e031c495b99e";
const HOST_SHA256 = "722cfcd0d9ea9d187663c2f58b2e31f3dde2a00500a9aec3471d7ecedbe8d4ab";
const HASH = /^[a-f0-9]{64}$/;
const PROBE_CODE = [
  'const fs=require("node:fs");',
  'const [nonce,workspacePath,protectedPath]=process.argv.slice(1);',
  'const result={schemaVersion:1,nonce,pid:process.pid,nodeVersion:process.versions.node,workspace:{path:workspacePath,allowed:false,code:null},protected:{path:protectedPath,attempted:false,allowed:false,code:null}};',
  'try{fs.writeFileSync(workspacePath,"WORKSPACE:"+nonce,{flag:"wx"});result.workspace.allowed=true;}catch(error){result.workspace.code=error.code||"UNKNOWN";}',
  'try{result.protected.attempted=true;fs.writeFileSync(protectedPath,"OVERWRITE:"+nonce);result.protected.allowed=true;}catch(error){result.protected.code=error.code||"UNKNOWN";}',
  'process.stdout.write(JSON.stringify(result)+"\\n");',
  'process.exitCode=result.workspace.allowed&&!result.protected.allowed&&["EPERM","EACCES"].includes(result.protected.code)?0:13;',
].join("\n");

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function same(left: string, right: string): boolean { return relative(left, right) === ""; }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
export function digestSnapshotPolicyValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
function hashBytes(value: string): string { return createHash("sha256").update(value).digest("hex"); }
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Snapshot probe paths must be absolute");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Snapshot probe root must be a directory");
  return canonical;
}
async function executable(path: string): Promise<{ path: string; sha256: string }> {
  if (!isAbsolute(path)) throw new Error("Snapshot executable paths must be absolute");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error("Snapshot executable must be a regular file");
  return { path: canonical, sha256: await hashFile(canonical) };
}

type DigestOptions = Omit<SnapshotIsolationOptions, "currentGeneration" | "timeoutMs">;
async function binding(options: DigestOptions) {
  const [projectRoot, protectedRoot, dataDir, home] = await Promise.all([
    directory(options.projectRoot), directory(options.protectedRoot), directory(options.dataDir), directory(options.home),
  ]);
  if (inside(projectRoot, dataDir) || inside(dataDir, projectRoot) || inside(projectRoot, protectedRoot) || inside(protectedRoot, projectRoot)) {
    throw new Error("Model workspace must not overlap product data or snapshot roots");
  }
  if (!inside(dataDir, home) || !inside(dataDir, protectedRoot) ||
    !same(protectedRoot, await realpath(join(dataDir, "engineering", "snapshots")))) {
    throw new Error("Snapshot root or engine home is outside the controlled product directory");
  }
  const policy = options.policy;
  if (policy?.schemaVersion !== 1 || policy.method !== "app-server/config-read" || !HASH.test(policy.effectivePolicySha256) ||
    !HASH.test(policy.managedPolicySha256) || !same(projectRoot, resolve(policy.projectRoot)) || !same(home, resolve(policy.home))) {
    throw new Error("Snapshot policy evidence does not match the real project and product home");
  }
  const [cli, host, node] = await Promise.all([executable(options.executable), executable(options.processHost), executable(options.nodeExecutable)]);
  if (cli.sha256 !== (options.expectedExecutableSha256 ?? CODEX_SHA256).toLowerCase() ||
    host.sha256 !== (options.expectedProcessHostSha256 ?? HOST_SHA256).toLowerCase()) {
    throw new Error("Snapshot probe executable does not match the trusted engine manifest");
  }
  const values = {
    schemaVersion: 1, method: "engine-sandbox-write-denial", projectRoot, protectedRoot, dataDir, home,
    effectivePolicySha256: policy.effectivePolicySha256, managedPolicySha256: policy.managedPolicySha256,
    cli, host, node, sandboxArgs: SNAPSHOT_SANDBOX_ARGS, probeCodeSha256: hashBytes(PROBE_CODE),
  };
  return { ...values, policyDigest: digestSnapshotPolicyValue(values) };
}

export async function calculateSnapshotPolicyDigest(options: DigestOptions): Promise<string> {
  return (await binding(options)).policyDigest;
}

function fresh(options: SnapshotIsolationOptions): void {
  const observed = Date.parse(options.policy.observedAt);
  if (!Number.isFinite(observed) || Date.now() - observed > 60_000 || observed > Date.now() + 5000 ||
    options.currentGeneration() !== options.policy.generation) {
    throw new Error("Snapshot probe requires fresh policy evidence from the current connection");
  }
}

function probeEnvironment(home: string): NodeJS.ProcessEnv {
  const allowed = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMW6432", "PROGRAMFILES(X86)"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase())) env[key] = value;
  return { ...env, CODEX_HOME: home, ELECTRON_RUN_AS_NODE: "1" };
}

async function runProbe(ready: Awaited<ReturnType<typeof binding>>, nonce: string, workspaceFile: string, protectedFile: string, timeoutMs: number) {
  const started = Date.now();
  const args = ["--", ready.cli.path, ...SNAPSHOT_SANDBOX_ARGS, ready.node.path, "-e", PROBE_CODE, nonce, workspaceFile, protectedFile];
  return new Promise<{ code: number | null; signal: string | null; timedOut: boolean; overflow: boolean; hostPid: number | null; durationMs: number; report: unknown; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number }>((resolveResult, reject) => {
    const child = spawn(ready.host.path, args, { cwd: ready.projectRoot, env: probeEnvironment(ready.home), stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    let stdoutBytes = 0; let stderrBytes = 0; let timedOut = false; let overflow = false;
    const stdoutHash = createHash("sha256"); const stderrHash = createHash("sha256"); const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length; stdoutHash.update(chunk);
      if (stdoutBytes <= 65536) chunks.push(chunk); else { overflow = true; child.kill(); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; stderrHash.update(chunk); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(new Error("Snapshot sandbox process could not start")); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      let report: unknown = null;
      try { report = JSON.parse(Buffer.concat(chunks).toString("utf8").trim()); } catch { /* Unrecognized engine output is never evidence. */ }
      // Store only a validated fixed-probe JSON report, never arbitrary engine diagnostics.
      if (!object(report) || report.schemaVersion !== 1 || report.nonce !== nonce || !object(report.workspace) ||
        !object(report.protected) || report.workspace.path !== workspaceFile || report.protected.path !== protectedFile) report = null;
      resolveResult({ code, signal, timedOut, overflow, hostPid: child.pid ?? null, durationMs: Date.now() - started, report,
        stdoutSha256: stdoutHash.digest("hex"), stderrSha256: stderrHash.digest("hex"), stdoutBytes, stderrBytes });
    });
  });
}

export async function probeSnapshotIsolation(options: SnapshotIsolationOptions): Promise<SnapshotIsolationReceipt> {
  if (process.platform !== "win32") throw new Error("Snapshot OS isolation is currently verified only on Windows");
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error("Invalid snapshot probe timeout");
  fresh(options);
  const ready = await binding(options);
  fresh(options);
  const nonce = randomUUID();
  const prefix = `.forgedesk-snapshot-isolation-${nonce}`;
  const workspaceFile = join(ready.projectRoot, `${prefix}.workspace`);
  const protectedFile = join(ready.protectedRoot, `${prefix}.protected`);
  const logRoot = join(ready.dataDir, "engineering", "isolation-probes");
  await mkdir(logRoot, { recursive: true });
  const canonicalLogRoot = await realpath(logRoot);
  if (!inside(ready.dataDir, canonicalLogRoot) || inside(ready.projectRoot, canonicalLogRoot)) throw new Error("Snapshot proof log is not protected from the model workspace");
  const probeLogRef = join(canonicalLogRoot, `${nonce}.json`);
  const original = `PROTECTED:${nonce}`;
  const originalSha256 = hashBytes(original);
  let protectedCreated = false; let cleanupComplete = true; let failure: string | null = null;
  let result: Awaited<ReturnType<typeof runProbe>> | null = null;
  let workspaceWritten = false; let writeDenied = false; let protectedAfterSha256: string | null = null;
  try {
    await writeFile(protectedFile, original, { flag: "wx", encoding: "utf8" }); protectedCreated = true;
    result = await runProbe(ready, nonce, workspaceFile, protectedFile, timeoutMs);
    const workspaceBytes = await readFile(workspaceFile, "utf8").catch(() => null);
    const protectedBytes = await readFile(protectedFile, "utf8").catch(() => null);
    protectedAfterSha256 = protectedBytes === null ? null : hashBytes(protectedBytes);
    const report = object(result.report) ? result.report : {};
    const workspace = object(report.workspace) ? report.workspace : {};
    const denied = object(report.protected) ? report.protected : {};
    workspaceWritten = workspace.allowed === true && workspaceBytes === `WORKSPACE:${nonce}`;
    writeDenied = denied.attempted === true && denied.allowed === false && (denied.code === "EPERM" || denied.code === "EACCES") && protectedBytes === original;
    fresh(options);
    if ((await binding(options)).policyDigest !== ready.policyDigest) failure = "Snapshot binary or policy binding changed during probe";
    if (result.code !== 0 || result.timedOut || result.overflow || !workspaceWritten || !writeDenied) failure = "Native snapshot write-denial probe was not confirmed";
  } catch (error) { failure = error instanceof Error ? error.message : "Snapshot probe failed"; }
  finally {
    if (protectedCreated) try { await unlink(protectedFile); } catch { cleanupComplete = false; }
    try {
      const bytes = await readFile(workspaceFile, "utf8");
      if (bytes === `WORKSPACE:${nonce}`) await unlink(workspaceFile); else cleanupComplete = false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupComplete = false; }
  }
  if (!cleanupComplete) failure = "Snapshot probe could not clean up its unique files";
  const verifiedAt = new Date().toISOString();
  const log = {
    schemaVersion: 1, method: "engine-sandbox-write-denial", policyDigest: ready.policyDigest,
    projectRoot: ready.projectRoot, protectedRoot: ready.protectedRoot, verifiedAt,
    attemptedPath: protectedFile, writeDenied: writeDenied && failure === null, observedWriteDenied: writeDenied, workspaceWritten, cleanupComplete, nonce,
    connectionGeneration: options.policy.generation, observedAt: options.policy.observedAt,
    originalSha256, protectedAfterSha256, binding: ready, probe: result, failure,
    limits: "One native filesystem probe only; no malicious same-user process, arbitrary script, device, or network isolation guarantee.",
  };
  await writeFile(probeLogRef, JSON.stringify(log, null, 2), { flag: "wx", encoding: "utf8" });
  if (failure || !result || !writeDenied || !workspaceWritten) throw new Error(`Snapshot isolation remains disabled: ${failure ?? "unconfirmed probe"}`);
  return { schemaVersion: 1, method: "engine-sandbox-write-denial", policyDigest: ready.policyDigest,
    projectRoot: ready.projectRoot, protectedRoot: ready.protectedRoot, verifiedAt, probeLogRef, probeLogSha256: await hashFile(probeLogRef) };
}
