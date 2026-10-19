import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

const MAGIC = "FZVA";
const MAGIC_BYTES = Buffer.from(MAGIC, "ascii");
const HEADER_BYTES = 16;
const MAX_STATUS_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 256 * 1024;
const CONTRACT_ID = "332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e";
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

export function encodeJsonFrame(value: { op: "hello" } | { op: "status"; request_id: string }): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  header.write(MAGIC, 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(crc32(payload), 12);
  return Buffer.concat([header, payload]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeJsonFrame(frame: Buffer): Record<string, unknown> {
  if (frame.length < HEADER_BYTES || !frame.subarray(0, 4).equals(MAGIC_BYTES) ||
      frame.readUInt8(4) !== 1 || frame.readUInt8(5) !== 1 || frame.readUInt16LE(6) !== 0) {
    throw new Error("Invalid FZVA frame header");
  }
  const size = frame.readUInt32LE(8);
  if (size === 0 || size > MAX_STATUS_BYTES || frame.length !== HEADER_BYTES + size) {
    throw new Error("Invalid FZVA payload length");
  }
  const payload = frame.subarray(HEADER_BYTES);
  if (crc32(payload) !== frame.readUInt32LE(12)) throw new Error("FZVA CRC mismatch");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new Error("Invalid FZVA JSON or UTF-8");
  }
  if (!isObject(value)) throw new Error("FZVA JSON object required");
  return value;
}

function assertedIdentity(value: Record<string, unknown>, bootId?: string): string {
  if (value.protocol !== 1 || value.platform !== "A0005" ||
      value.contract_id !== CONTRACT_ID || typeof value.boot_id !== "string" ||
      !BOOT_ID.test(value.boot_id)) {
    throw new Error("FZ3B application claim does not match fixed contract");
  }
  if (bootId !== undefined && value.boot_id !== bootId) {
    throw new Error("FZ3B boot ID changed during status probe");
  }
  return value.boot_id;
}

export interface Fz3bStatusObservation {
  observedAtUtc: string;
  bootId: string;
  contractId: typeof CONTRACT_ID;
  platform: "A0005";
  protocol: 1;
  reportedStatus: Readonly<Record<string, unknown>>;
  identityAuthenticated: false;
  helloIsUnauthenticated: true;
  statusTriggersR5Telemetry: true;
  disconnectMayStopLastCameraInference: true;
}

// Test-only socket injection lives in this internal module. The production API
// creates its own socket for one fixed address and exposes no transport options.
export function probeStatusOnSocket(socket: Socket, deadlineMs = 5000): Promise<Fz3bStatusObservation> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000) {
    throw new Error("Invalid FZ3B deadline");
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let state: "hello" | "status" = "hello";
    let bootId: string | undefined;
    let buffer = Buffer.alloc(0);
    let receivedBytes = 0;
    let unsolicitedStatuses = 0;
    const requestId = randomUUID();
    const timer = setTimeout(() => fail(new Error("FZ3B status deadline exceeded")), deadlineMs);

    function cleanup() {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onClose);
      socket.on("error", absorbLateError);
      socket.off("error", onError);
      socket.destroy();
    }
    function absorbLateError() { /* A terminal socket can still emit an asynchronous error. */ }
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function finish(status: Record<string, unknown>) {
      if (settled) return;
      settled = true;
      const result: Fz3bStatusObservation = {
        observedAtUtc: new Date().toISOString(), bootId: bootId!, contractId: CONTRACT_ID,
        platform: "A0005", protocol: 1, reportedStatus: status,
        identityAuthenticated: false, helloIsUnauthenticated: true,
        statusTriggersR5Telemetry: true, disconnectMayStopLastCameraInference: true,
      };
      cleanup();
      resolve(result);
    }
    function onConnect() {
      socket.write(encodeJsonFrame({ op: "hello" }));
    }
    function onEnd() { fail(new Error("FZ3B control socket ended before status acknowledgement")); }
    function onClose() { fail(new Error("FZ3B control socket closed before status acknowledgement")); }
    function onError(error: Error) { fail(error); }
    function consume(value: Record<string, unknown>) {
      if (state === "hello") {
        if (value.type !== "hello" || value.ok !== true) throw new Error("FZ3B hello rejected");
        bootId = assertedIdentity(value);
        state = "status";
        socket.write(encodeJsonFrame({ op: "status", request_id: requestId }));
        return;
      }
      if (value.type === "status") {
        assertedIdentity(value, bootId);
        if (++unsolicitedStatuses > 16) throw new Error("Excess FZ3B unsolicited status frames");
        return;
      }
      if (value.type !== "ack" || value.op !== "status" || value.ok !== true ||
          value.request_id !== requestId ||
          !isObject(value.result) || value.result.type !== "status") {
        throw new Error("Unexpected FZ3B control reply");
      }
      assertedIdentity(value.result, bootId);
      // This probe observes one matched ACK, not the remainder of the TCP stream.
      finish(value.result);
    }
    function onData(chunk: Buffer) {
      if (settled) return;
      try {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_STREAM_BYTES) throw new Error("FZ3B stream budget exceeded");
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= HEADER_BYTES && !settled) {
          if (!buffer.subarray(0, 4).equals(MAGIC_BYTES) || buffer.readUInt8(4) !== 1 ||
              buffer.readUInt8(5) !== 1 || buffer.readUInt16LE(6) !== 0) {
            throw new Error("Invalid FZVA frame header");
          }
          const size = buffer.readUInt32LE(8);
          if (size === 0 || size > MAX_STATUS_BYTES) throw new Error("Invalid FZVA payload length");
          const frameBytes = HEADER_BYTES + size;
          if (buffer.length < frameBytes) break;
          const frame = buffer.subarray(0, frameBytes);
          buffer = buffer.subarray(frameBytes);
          consume(decodeJsonFrame(frame));
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("FZ3B frame rejected"));
      }
    }

    socket.on("connect", onConnect);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("close", onClose);
    socket.on("error", onError);
    if (!socket.connecting && !socket.destroyed) onConnect();
  });
}
