import { createHash } from "node:crypto";

export const DEVICE_SCHEMA_VERSION = 1;

export interface DeviceIdentity {
  usbVid: string;
  usbPid: string;
  probeSerial: string;
  chipTarget: string;
  /** A COM port is a location hint, never part of the stable identity. */
  serialPort?: string;
  identityEvidence: string;
}

export interface DeviceProfile {
  schemaVersion: typeof DEVICE_SCHEMA_VERSION;
  id: string;
  revision: string;
  chipTarget: string;
  adapterId: string;
  enabled: boolean;
}

export interface FlashRequest {
  taskId: string;
  artifactId: string;
  artifactSha256: string;
  buildId: string;
  profile: DeviceProfile;
  identity: DeviceIdentity;
  acceptanceDigest: string;
  policyVersion: string;
  requestKey: string;
  authorizationId: string;
}

export interface DeviceAuthorization {
  schemaVersion: typeof DEVICE_SCHEMA_VERSION;
  id: string;
  taskId: string;
  artifactSha256: string;
  deviceKey: string;
  chipTarget: string;
  profileId: string;
  profileRevision: string;
  acceptanceDigest: string;
  policyVersion: string;
  expiresAt: string;
  approvedBy: "user";
}

export interface AuthorizationLookup {
  /** Must be backed by trusted runner state, outside renderer and model writable roots. */
  get(id: string): Promise<DeviceAuthorization | undefined>;
}

export type OperationStatus =
  | "prepared"
  | "authorized"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";

export interface DeviceOperation {
  schemaVersion: typeof DEVICE_SCHEMA_VERSION;
  id: string;
  requestKey: string;
  argsDigest: string;
  deviceKey: string;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  detail?: string;
  receipt?: string;
}

export interface FlashOutcome {
  status: "succeeded" | "failed" | "unknown";
  /** False means the process or hardware effect may still be active. */
  processExited: boolean;
  receipt?: string;
  detail?: string;
}

export interface DeviceAdapter {
  readonly id: string;
  readonly available: boolean;
  readonly reason?: string;
  flash(request: FlashRequest): Promise<FlashOutcome>;
  /** Required for releasing a lock left by an unknown outcome after restart. */
  confirmProcessExited(operation: DeviceOperation): Promise<boolean>;
}

export class DeviceUnavailableAdapter implements DeviceAdapter {
  readonly id = "unavailable";
  readonly available = false;
  readonly reason = "No real board, probe, profile and verified manual chain are selected";

  async flash(): Promise<never> {
    throw new Error(this.reason);
  }

  async confirmProcessExited(): Promise<boolean> {
    return false;
  }
}

export function deviceKey(identity: DeviceIdentity): string {
  const vid = identity.usbVid.toUpperCase();
  const pid = identity.usbPid.toUpperCase();
  if (!/^[0-9A-F]{4}$/.test(vid) || !/^[0-9A-F]{4}$/.test(pid)) {
    throw new Error("USB VID/PID must be four hexadecimal digits");
  }
  if (!identity.probeSerial.trim() || !identity.chipTarget.trim() || !identity.identityEvidence.trim()) {
    throw new Error("Probe serial, chip target and identity evidence are required");
  }
  return JSON.stringify([vid, pid, identity.probeSerial.trim(), identity.chipTarget.trim()]);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateFlashRequest(request: FlashRequest): void {
  if (!request.profile.enabled || request.profile.adapterId === "unavailable") {
    throw new Error("Device profile is disabled");
  }
  if (request.profile.schemaVersion !== DEVICE_SCHEMA_VERSION) {
    throw new Error("Unsupported device profile schema");
  }
  if (!request.profile.id || !request.profile.revision || !request.taskId || !request.artifactId || !request.buildId || !request.requestKey) {
    throw new Error("Incomplete flash request");
  }
  if (!/^[0-9a-f]{64}$/i.test(request.artifactSha256) || !/^[0-9a-f]{64}$/i.test(request.acceptanceDigest)) {
    throw new Error("Invalid artifact or acceptance digest");
  }
  if (request.profile.chipTarget !== request.identity.chipTarget) {
    throw new Error("Profile chip target differs from bound device");
  }
  deviceKey(request.identity);
}
