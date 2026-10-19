import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requireDeviceAuthorization } from "./authorization.js";
import {
  DEVICE_SCHEMA_VERSION,
  deviceKey,
  sha256,
  validateFlashRequest,
  type AuthorizationLookup,
  type DeviceAdapter,
  type DeviceOperation,
  type FlashRequest,
  type OperationStatus,
} from "./types.js";

function argsDigest(request: FlashRequest): string {
  return sha256(JSON.stringify({
    taskId: request.taskId,
    artifactId: request.artifactId,
    artifactSha256: request.artifactSha256.toLowerCase(),
    buildId: request.buildId,
    profileId: request.profile.id,
    profileRevision: request.profile.revision,
    deviceKey: deviceKey(request.identity),
    acceptanceDigest: request.acceptanceDigest.toLowerCase(),
    policyVersion: request.policyVersion,
    authorizationId: request.authorizationId,
  }));
}

async function durableWrite(path: string, operation: DeviceOperation): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx");
  try {
    await handle.writeFile(JSON.stringify(operation, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  // Windows directory fsync is not portable. The state file is flushed before rename.
}

export class DeviceOperationCoordinator {
  constructor(
    private readonly root: string,
    private readonly authorizations: AuthorizationLookup,
    private readonly adapter: DeviceAdapter,
  ) {}

  private operationDir(requestKey: string): string {
    return join(this.root, "operations", sha256(requestKey));
  }

  private lockDir(key: string): string {
    return join(this.root, "locks", sha256(key));
  }

  async get(requestKey: string): Promise<DeviceOperation | undefined> {
    try {
      return JSON.parse(await readFile(join(this.operationDir(requestKey), "state.json"), "utf8")) as DeviceOperation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async flash(request: FlashRequest): Promise<DeviceOperation> {
    validateFlashRequest(request);
    if (!this.adapter.available || this.adapter.id !== request.profile.adapterId) {
      throw new Error(this.adapter.reason ?? "Selected device adapter is unavailable");
    }
    const digest = argsDigest(request);
    const old = await this.get(request.requestKey);
    if (old) return this.existing(old, digest);

    // Permission is checked again immediately before any possible device action.
    await requireDeviceAuthorization(this.authorizations, request);
    await mkdir(join(this.root, "operations"), { recursive: true });
    await mkdir(join(this.root, "locks"), { recursive: true });
    const directory = this.operationDir(request.requestKey);
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const competing = await this.get(request.requestKey);
      if (!competing) throw new Error("Operation claim exists without durable state; manual recovery required");
      return this.existing(competing, digest);
    }

    const now = new Date().toISOString();
    const operation: DeviceOperation = {
      schemaVersion: DEVICE_SCHEMA_VERSION,
      id: randomUUID(),
      requestKey: request.requestKey,
      argsDigest: digest,
      deviceKey: deviceKey(request.identity),
      status: "prepared",
      createdAt: now,
      updatedAt: now,
    };
    const statePath = join(directory, "state.json");
    await durableWrite(statePath, operation);
    const lock = this.lockDir(operation.deviceKey);
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.update(statePath, operation, "failed", "Device is already held; no flash started");
    }

    // A lock is never reclaimed by clock age. Recovery needs explicit process-exit proof.
    await writeFile(join(lock, "owner.json"), JSON.stringify({ operationId: operation.id, requestKey: request.requestKey }), { flag: "wx" });
    await this.update(statePath, operation, "authorized");
    try {
      await requireDeviceAuthorization(this.authorizations, request);
    } catch (error) {
      const final = await this.update(statePath, operation, "failed", `Authorization changed before start: ${String(error)}`);
      await rm(lock, { recursive: true });
      return final;
    }
    await this.update(statePath, operation, "running");
    try {
      const outcome = await this.adapter.flash(request);
      if (!outcome.processExited) {
        return this.update(statePath, operation, "unknown", outcome.detail ?? "Device process exit unconfirmed");
      }
      const final = await this.update(statePath, operation, outcome.status, outcome.detail, outcome.receipt);
      await rm(lock, { recursive: true });
      return final;
    } catch (error) {
      return this.update(statePath, operation, "unknown", `Adapter ended without confirmed process exit: ${String(error)}`);
    }
  }

  /** Call only after the runner verifies that the prior process has actually exited. */
  async releaseAfterConfirmedExit(requestKey: string, exitEvidence: string): Promise<DeviceOperation> {
    if (!exitEvidence.trim()) throw new Error("Process exit evidence is required");
    const operation = await this.get(requestKey);
    if (!operation) throw new Error("Unknown operation");
    if (operation.status === "prepared" || operation.status === "authorized" || operation.status === "running") {
      operation.status = "unknown";
    }
    if (!await this.adapter.confirmProcessExited(operation)) throw new Error("Device process exit is not confirmed");
    const lock = this.lockDir(operation.deviceKey);
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as { operationId: string };
    if (owner.operationId !== operation.id) throw new Error("Device lock owner mismatch");
    await rm(lock, { recursive: true });
    const statePath = join(this.operationDir(requestKey), "state.json");
    if (operation.status === "succeeded" || operation.status === "failed") return operation;
    return this.update(statePath, operation, "unknown", `Process exit confirmed: ${exitEvidence}; hardware outcome remains unknown`);
  }

  /** Run once at startup before accepting new device requests. This never replays an action. */
  async recoverInterrupted(): Promise<DeviceOperation[]> {
    const operations = await this.list();
    for (const operation of operations) {
      if (operation.status !== "unknown" || !operation.detail?.startsWith("Runner restarted")) continue;
      await this.update(join(this.operationDir(operation.requestKey), "state.json"), operation, "unknown", operation.detail);
    }
    return this.list();
  }

  async list(): Promise<DeviceOperation[]> {
    const base = join(this.root, "operations");
    let directories: string[];
    try {
      directories = await readdir(base);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: DeviceOperation[] = [];
    for (const directory of directories) {
      try {
        const item = JSON.parse(await readFile(join(base, directory, "state.json"), "utf8")) as DeviceOperation;
        if (item.status === "running" || item.status === "authorized" || item.status === "prepared") {
          result.push({ ...item, status: "unknown", detail: "Runner restarted before device action reached a final state" });
        } else {
          result.push(item);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return result;
  }

  private existing(operation: DeviceOperation, digest: string): DeviceOperation {
    if (operation.argsDigest !== digest) throw new Error("Request key reused with different arguments");
    return operation;
  }

  private async update(path: string, operation: DeviceOperation, status: OperationStatus, detail?: string, receipt?: string): Promise<DeviceOperation> {
    operation.status = status;
    operation.updatedAt = new Date().toISOString();
    if (detail !== undefined) operation.detail = detail;
    if (receipt !== undefined) operation.receipt = receipt;
    await durableWrite(path, operation);
    return operation;
  }
}
