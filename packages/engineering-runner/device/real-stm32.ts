import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { GESTURESCREEN_PROFILE, GESTURESCREEN_PROFILE_SHA256 } from "../embedded/profile.js";
import { EMBEDDED_PROGRESS_STAGES, type EmbeddedProgress, type EmbeddedHardwareAdapter, type EmbeddedHardwareContext } from "../embedded/types.js";
import { noLinks } from "../embedded/files.js";
import type { FlashOutcome } from "./types.js";

const HEX_LIMIT = 8 * 1024 * 1024;
const FLASH_BYTES = 1024 * 1024;
const WORKER_STDOUT_LIMIT = 16 * 1024;
const WORKER_STDERR_LIMIT = 64 * 1024;
const WORKER_PROGRESS_LIMIT = 4096;

export interface FixedStm32HardwareOptions {
  processHost: string;
  pythonExecutable: string;
  workerScript: string;
  /** A visibility deadline, never a termination deadline for active hardware actions. */
  inspectDeadlineMs?: number;
  flashDeadlineMs?: number;
  verifyDeadlineMs?: number;
}

export interface FixedWorkerReceipt {
  schemaVersion: 1;
  action: "inspect" | "flash" | "verify";
  operationId: string;
  status: "succeeded" | "failed" | "unknown";
  stage: string;
  backup?: { path: string; sha256: string; bytes: number; doubleReadMatch: boolean };
  artifactSha256?: string;
  backupSha256?: string;
  preflashReadSha256?: string;
  definedBytes?: number;
  preflashDifferentBytes?: number;
  readbackSha256?: string;
  readbackDefinedBytes?: number;
  readbackMismatchBytes?: number;
  verify?: {
    expectedBuildId: string; expectedUid96: string; frameDelta: number; uptimeDeltaMs: number;
    challenges: Array<{ nonceHex: string; responseHex: string; receivedAtUtc: string; decoded: {
      flags: number; cameraFrames: number; cameraErrors: number; cameraTimeouts: number;
      displayErrors: number; sysclkHz: number; pll48Hz: number; uptimeMs: number;
    } }>;
  };
  error?: string;
}

type Action = FixedWorkerReceipt["action"];
type HardwareContext = EmbeddedHardwareContext & { backup?: { path: string; sha256: string } };

export function parseFixedWorkerProgress(value: string, action: Action, operationId: string): EmbeddedProgress {
  if (Buffer.byteLength(value) > WORKER_PROGRESS_LIMIT) throw new Error("Worker progress exceeds bounds");
  const progress = JSON.parse(value) as Partial<EmbeddedProgress>;
  if (!progress || progress.schemaVersion !== 1 || progress.operationId !== operationId || progress.action !== action ||
      !EMBEDDED_PROGRESS_STAGES.includes(progress.stage as EmbeddedProgress['stage']) ||
      typeof progress.updatedAt !== "string" || !Number.isFinite(Date.parse(progress.updatedAt)) ||
      !Number.isSafeInteger(progress.sequence) || progress.sequence! < 0 ||
      (progress.message !== undefined && (typeof progress.message !== "string" || progress.message.length > 240))) {
    throw new Error("Worker progress identity or schema is invalid");
  }
  const counted = progress.completed !== undefined || progress.total !== undefined || progress.unit !== undefined;
  if (counted && (typeof progress.completed !== "number" || typeof progress.total !== "number" ||
      !Number.isFinite(progress.completed) || !Number.isFinite(progress.total) || progress.total <= 0 ||
      progress.completed < 0 || progress.completed > progress.total || !["bytes", "fraction", "steps"].includes(progress.unit ?? "") ||
      (progress.unit === "fraction" ? progress.total !== 1 : !Number.isSafeInteger(progress.completed) || !Number.isSafeInteger(progress.total)))) {
    throw new Error("Worker progress counts are invalid");
  }
  return { schemaVersion: 1, operationId, action, stage: progress.stage!, updatedAt: progress.updatedAt,
    sequence: progress.sequence!, ...(counted ? { completed: progress.completed, total: progress.total, unit: progress.unit } : {}),
    ...(progress.message !== undefined ? { message: progress.message } : {}) };
}

interface ProcessIdentityMarker {
  schemaVersion: 1;
  operationId: string;
  worker: { pid: number; createTime: string; creationFiletime100ns: string | null };
  host: { pid: number; createTime: string; creationFiletime100ns: string | null };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} must be a SHA-256 digest`);
  return value.toLowerCase();
}

function absolute(path: string, label: string): void {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be absolute`);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifyAuditableReceipt(value: FixedWorkerReceipt["verify"], expectedBuildId?: string): boolean {
  if (!value || !/^[a-f0-9]{64}$/.test(value.expectedBuildId) || /^0+$/.test(value.expectedBuildId) ||
      value.expectedUid96 !== "0037001b3133510432383236" ||
      (expectedBuildId && value.expectedBuildId !== expectedBuildId.toLowerCase()) ||
      !Array.isArray(value.challenges) || value.challenges.length !== 2) return false;
  const decoded: NonNullable<FixedWorkerReceipt["verify"]>["challenges"][number]["decoded"][] = [];
  for (const challenge of value.challenges) {
    if (!/^[a-f0-9]{32}$/.test(challenge.nonceHex) || !/^[a-f0-9]{200}$/.test(challenge.responseHex) ||
        !Number.isFinite(Date.parse(challenge.receivedAtUtc))) return false;
    const frame = Buffer.from(challenge.responseHex, "hex");
    if (frame.toString("ascii", 0, 4) !== "FDR1" ||
        frame.subarray(4, 20).toString("hex") !== challenge.nonceHex ||
        frame.subarray(20, 52).toString("hex") !== value.expectedBuildId ||
        crc32(frame.subarray(0, 96)) !== frame.readUInt32LE(96)) return false;
    const uid = [52, 56, 60].map(offset => frame.readUInt32LE(offset).toString(16).padStart(8, "0")).join("");
    if (uid !== value.expectedUid96) return false;
    const fields = Array.from({ length: 8 }, (_, index) => frame.readUInt32LE(64 + index * 4));
    const actual = { flags: fields[0], cameraFrames: fields[1], cameraErrors: fields[2],
      cameraTimeouts: fields[3], displayErrors: fields[4], sysclkHz: fields[5], pll48Hz: fields[6], uptimeMs: fields[7] };
    if ((actual.flags & 31) !== 31 || actual.sysclkHz !== 168000000 || actual.pll48Hz !== 48000000 ||
        Object.entries(actual).some(([key, field]) => field !== challenge.decoded?.[key as keyof typeof actual])) return false;
    decoded.push(actual);
  }
  const framesDelta = (decoded[1].cameraFrames - decoded[0].cameraFrames) >>> 0;
  const uptimeDelta = (decoded[1].uptimeMs - decoded[0].uptimeMs) >>> 0;
  return value.challenges[0].nonceHex !== value.challenges[1].nonceHex &&
    framesDelta > 0 && framesDelta < 0x80000000 && uptimeDelta > 0 && uptimeDelta < 0x80000000 &&
    value.frameDelta === framesDelta && value.uptimeDeltaMs === uptimeDelta &&
    decoded[0].cameraErrors === decoded[1].cameraErrors &&
    decoded[0].cameraTimeouts === decoded[1].cameraTimeouts &&
    decoded[0].displayErrors === decoded[1].displayErrors;
}

async function fileDigest(path: string, maxBytes: number, label: string): Promise<{ bytes: number; sha256: string }> {
  absolute(path, label);
  const bytes = await readFile(path);
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`${label} size is invalid`);
  return { bytes: bytes.length, sha256: digest(bytes) };
}

export async function prepareFixedWorkerInput(action: Action, context: HardwareContext): Promise<Record<string, unknown>> {
  if (context.profile !== GESTURESCREEN_PROFILE &&
      digest(Buffer.from(JSON.stringify(context.profile))) !== GESTURESCREEN_PROFILE_SHA256) {
    throw new Error("Fixed hardware profile differs from pinned profile");
  }
  if (!/^[0-9a-f-]{36}$/i.test(context.operationId)) throw new Error("Invalid hardware operation ID");
  absolute(context.operationDir, "Operation directory");
  const operationDir = await realpath(context.operationDir);
  const input: Record<string, unknown> = { action, operationId: context.operationId, operationDir };
  if (action === "flash" || action === "verify") {
    const artifact = context.artifact;
    if (!artifact) throw new Error("A bound embedded artifact is required");
    if (!/^[0-9a-f]{64}$/i.test(artifact.buildId)) throw new Error("Build ID must be 64 hex digits");
    absolute(artifact.hexPath, "HEX path");
    absolute(artifact.axfPath, "AXF path");
    if (sha(artifact.profileSha256, "Profile") !== GESTURESCREEN_PROFILE_SHA256) {
      throw new Error("Artifact was built with another profile");
    }
    const hex = await fileDigest(artifact.hexPath, HEX_LIMIT, "HEX artifact");
    if (hex.sha256 !== sha(artifact.hexSha256, "HEX")) throw new Error("HEX artifact SHA-256 mismatch");
    const axf = await fileDigest(artifact.axfPath, 64 * 1024 * 1024, "AXF artifact");
    if (axf.sha256 !== sha(artifact.axfSha256, "AXF")) throw new Error("AXF artifact SHA-256 mismatch");
    input.artifact = {
      id: artifact.id, buildId: artifact.buildId.toLowerCase(), hexPath: await realpath(artifact.hexPath),
      axfPath: await realpath(artifact.axfPath), hexSha256: hex.sha256, axfSha256: axf.sha256,
      sourceSha256: sha(artifact.sourceSha256, "Source"), profileSha256: GESTURESCREEN_PROFILE_SHA256,
    };
  }
  if (action === "flash") {
    if (!context.backup) throw new Error("A bound complete pre-flash backup is required");
    const backup = await fileDigest(context.backup.path, FLASH_BYTES, "Flash backup");
    if (backup.bytes !== FLASH_BYTES || backup.sha256 !== sha(context.backup.sha256, "Backup")) {
      throw new Error("Flash backup length or SHA-256 mismatch");
    }
    input.backup = { path: await realpath(context.backup.path), sha256: backup.sha256 };
  }
  return input;
}

export function parseFixedWorkerReceipt(value: string, action: Action, operationId: string, expectedBuildId?: string): FixedWorkerReceipt {
  if (Buffer.byteLength(value) > WORKER_STDOUT_LIMIT || !value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw new Error("Worker must emit one bounded JSON receipt line");
  }
  const receipt = JSON.parse(value) as Partial<FixedWorkerReceipt>;
  if (!receipt || receipt.schemaVersion !== 1 || receipt.action !== action || receipt.operationId !== operationId ||
      !["succeeded", "failed", "unknown"].includes(receipt.status ?? "") || typeof receipt.stage !== "string") {
    throw new Error("Worker receipt identity or schema is invalid");
  }
  if (receipt.status === "succeeded" && action === "inspect" &&
      (!receipt.backup || receipt.backup.bytes !== FLASH_BYTES || receipt.backup.doubleReadMatch !== true ||
       !/^[a-f0-9]{64}$/.test(receipt.backup.sha256))) {
    throw new Error("Inspect receipt lacks a complete double-read backup");
  }
  if (receipt.status === "succeeded" && action === "flash" &&
      (receipt.readbackMismatchBytes !== 0 || !receipt.definedBytes ||
       receipt.readbackDefinedBytes !== receipt.definedBytes || !receipt.preflashDifferentBytes ||
       !receipt.readbackSha256 || !receipt.backupSha256 ||
       receipt.preflashReadSha256 !== receipt.backupSha256 || receipt.stage !== "reset_and_exited")) {
    throw new Error("Flash receipt lacks real programming and full defined-byte readback");
  }
  if (receipt.status === "succeeded" && action === "verify" &&
      (receipt.stage !== "cdc_verified" || !verifyAuditableReceipt(receipt.verify, expectedBuildId))) {
    throw new Error("Verify receipt lacks CDC acceptance");
  }
  return receipt as FixedWorkerReceipt;
}

interface RunningWorker { child: ChildProcessByStdio<null, Readable, Readable>; closed: boolean }

export class FixedStm32HardwareService implements EmbeddedHardwareAdapter {
  readonly id = "fixed-stm32-pyocd";
  readonly available = true;
  private readonly running = new Map<string, RunningWorker>();
  private readonly exited = new Set<string>();
  private openInput = open;

  constructor(private readonly options: FixedStm32HardwareOptions) {
    for (const [name, path] of Object.entries({
      processHost: options.processHost, pythonExecutable: options.pythonExecutable, workerScript: options.workerScript,
    })) absolute(path, name);
    if (process.platform === "win32" && !options.processHost) throw new Error("Hardware worker requires Windows Job Object host");
  }

  inspect(context: HardwareContext): Promise<FlashOutcome> { return this.run("inspect", context); }
  flash(context: HardwareContext): Promise<FlashOutcome> { return this.run("flash", context); }
  verify(context: HardwareContext): Promise<FlashOutcome> { return this.run("verify", context); }

  async readProgress(action: Action, operationId: string, operationDir: string): Promise<EmbeddedProgress | undefined> {
    try {
      if (!/^[0-9a-f-]{36}$/i.test(operationId) || !isAbsolute(operationDir)) return undefined;
      const directory = await noLinks(operationDir);
      const file = join(directory, "progress.json");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > WORKER_PROGRESS_LIMIT) return undefined;
      await noLinks(file);
      return parseFixedWorkerProgress(await readFile(file, "utf8"), action, operationId);
    } catch {
      // Telemetry is optional; invalid or missing progress never changes the hardware result.
      return undefined;
    }
  }

  async confirmProcessExited(operationId: string, operationDir?: string): Promise<boolean> {
    if (this.running.has(operationId)) return false;
    if (this.exited.has(operationId)) return true;
    if (!operationDir || !isAbsolute(operationDir)) return false;
    try {
      const directory = await realpath(operationDir);
      const path = join(directory, "worker-process.json");
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
      const canonical = await realpath(path);
      if (!canonical.startsWith(directory + sep)) return false;
      const marker = JSON.parse(await readFile(canonical, "utf8")) as ProcessIdentityMarker;
      const valid = (item: ProcessIdentityMarker["worker"]) =>
        item && Number.isSafeInteger(item.pid) && item.pid > 0 && /^\d+\.\d{6}$/.test(item.createTime) &&
        (process.platform !== "win32" || /^\d+$/.test(item.creationFiletime100ns ?? ""));
      if (marker.schemaVersion !== 1 || marker.operationId !== operationId || !valid(marker.worker) || !valid(marker.host) ||
          marker.worker.pid === marker.host.pid) return false;
      return await new Promise<boolean>(resolve => {
        execFile(this.options.pythonExecutable,
          ["-I", "-B", this.options.workerScript, "--check-exit", canonical],
          { cwd: directory, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 2048,
            env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
              TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONNOUSERSITE: "1" } },
          (error, stdout) => {
            if (error || !stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) return resolve(false);
            try {
              const result = JSON.parse(stdout) as { schemaVersion?: number; kind?: string; confirmed?: boolean };
              resolve(result.schemaVersion === 1 && result.kind === "process-exit-check" && result.confirmed === true);
            } catch { resolve(false); }
          });
      });
    } catch { return false; }
  }

  async run(action: Action, context: HardwareContext): Promise<FlashOutcome> {
    let input: Record<string, unknown>;
    try { input = await prepareFixedWorkerInput(action, context); }
    catch (error) { return { status: "failed", processExited: true, detail: String(error) }; }
    if (this.running.has(context.operationId)) return { status: "unknown", processExited: false, detail: "Operation already has a live worker" };
    const inputPath = join(context.operationDir, "worker-input.json");
    try {
      const handle = await this.openInput(inputPath, "wx");
      try { await handle.writeFile(JSON.stringify(input), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) {
      return { status: "failed", processExited: true, detail: `Hardware worker input could not be persisted; no process was started: ${String(error)}` };
    }
    return this.spawnWorker(action, context.operationId, context.operationDir, inputPath, context.artifact?.buildId);
  }

  private spawnWorker(action: Action, operationId: string, cwd: string, inputPath: string, expectedBuildId?: string): Promise<FlashOutcome> {
    const { processHost, pythonExecutable, workerScript } = this.options;
    const command = process.platform === "win32" ? processHost : pythonExecutable;
    const args = process.platform === "win32"
      ? ["--", pythonExecutable, "-I", "-B", workerScript, "--input", inputPath]
      : ["-I", "-B", workerScript, "--input", inputPath];
    const child = spawn(command, args, { cwd, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      TEMP: process.env.TEMP, TMP: process.env.TMP, PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1" },
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const state: RunningWorker = { child, closed: false };
    this.running.set(operationId, state);
    return new Promise(resolve => {
      let completed = false;
      let stdout = "";
      let stderrBytes = 0;
      let outputExceeded = false;
      const finish = (outcome: FlashOutcome) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + chunk.length <= WORKER_STDOUT_LIMIT) stdout += chunk.toString("utf8");
        else outputExceeded = true;
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > WORKER_STDERR_LIMIT) outputExceeded = true;
      });
      child.on("error", () => { /* close will follow; no unverified PID-based release */ });
      child.on("close", async code => {
        state.closed = true;
        this.running.delete(operationId);
        this.exited.add(operationId);
        if (completed) return;
        try {
          if (outputExceeded) throw new Error("Worker output exceeded bounds");
          const receipt = parseFixedWorkerReceipt(stdout, action, operationId, expectedBuildId);
          const onDisk = await readFile(join(cwd, "receipt.json"), "utf8");
          if (JSON.stringify(JSON.parse(onDisk)) !== JSON.stringify(receipt)) throw new Error("Worker receipt file differs from stdout");
          const status = receipt.status === "succeeded" && code === 0 ? "succeeded"
            : receipt.status === "failed" && code === 2 ? "failed" : "unknown";
          finish({ status, processExited: true, receipt: JSON.stringify(receipt), detail: receipt.error ?? receipt.stage });
        } catch (error) {
          finish({ status: "unknown", processExited: true, detail: `Worker exited without trustworthy receipt: ${String(error)}` });
        }
      });
      const timeoutMs = action === "flash" ? this.options.flashDeadlineMs ?? 300000
        : action === "inspect" ? this.options.inspectDeadlineMs ?? 180000
        : this.options.verifyDeadlineMs ?? 20000;
      const timer = setTimeout(() => {
        // Deliberately never kill or close the Job Object while flash may be active.
        finish({ status: "unknown", processExited: false, detail: "Hardware worker deadline reached; process remains active until observed exit" });
      }, timeoutMs);
    });
  }
}
