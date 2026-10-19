import assert from "node:assert/strict";
import { createConnection, createServer, type Socket } from "node:net";
import test from "node:test";
import { probeFz3bClaimedStatus } from "./index.js";
import { probeStatusOnSocket } from "./internal.js";

const bootId = "5ceb45a3-8903-4efc-9484-ec75c17280df";
const contractId = "332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e";
const status = { type: "status", protocol: 1, platform: "A0005", boot_id: bootId,
  contract_id: contractId, camera: { frames: 0 }, inference: { state: "STOPPED", frames: 0 } };

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function frame(value: unknown, payload = Buffer.from(JSON.stringify(value), "utf8")): Buffer {
  const header = Buffer.alloc(16);
  header.write("FZVA", 0, "ascii");
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(crc32(payload), 12);
  return Buffer.concat([header, payload]);
}

type RequestHandler = (request: Record<string, unknown>, socket: Socket) => void;

async function fixture(handler: RequestHandler, deadlineMs = 500, onClient?: (socket: Socket) => void) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(socket => {
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 16) {
        assert.equal(buffer.toString("ascii", 0, 4), "FZVA");
        assert.equal(buffer.readUInt8(4), 1);
        assert.equal(buffer.readUInt8(5), 1);
        const size = buffer.readUInt32LE(8);
        if (buffer.length < 16 + size) return;
        const payload = buffer.subarray(16, 16 + size);
        assert.equal(buffer.readUInt32LE(12), crc32(payload));
        buffer = buffer.subarray(16 + size);
        const request = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
        requests.push(request);
        handler(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const client = createConnection({ host: "127.0.0.1", port: address.port });
    onClient?.(client);
    const result = await probeStatusOnSocket(client, deadlineMs);
    return { result, requests, client };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("fixed status probe sends only hello and status and labels unauthenticated observation", async () => {
  const { result, requests } = await fixture((request, socket) => {
    if (request.op === "hello") {
      const hello = frame({ ...status, type: "hello", ok: true });
      socket.write(hello.subarray(0, 7));
      socket.write(Buffer.concat([hello.subarray(7), frame(status)]));
    } else if (request.op === "status") {
      socket.write(frame({ type: "ack", op: "status", ok: true,
        request_id: request.request_id, result: status }));
    }
  });
  assert.deepEqual(requests.map(value => value.op), ["hello", "status"]);
  assert.deepEqual(requests[0], { op: "hello" });
  assert.equal(typeof requests[1].request_id, "string");
  assert.equal(result.bootId, bootId);
  assert.equal(result.contractId, contractId);
  assert.equal(result.reportedStatus.type, "status");
  assert.equal(result.identityAuthenticated, false);
  assert.equal(result.helloIsUnauthenticated, true);
  assert.equal(result.statusTriggersR5Telemetry, true);
  assert.equal(result.disconnectMayStopLastCameraInference, true);
});

test("fixed status probe refuses unknown wire format, CRC, UTF-8, JSON, and length", async () => {
  const malformed = [
    { name: "magic", bytes: (() => { const item = frame(status); item.write("NOPE", 0); return item; })() },
    { name: "high-bit magic", bytes: (() => { const item = frame(status); item[0] |= 0x80; return item; })() },
    { name: "version", bytes: (() => { const item = frame(status); item.writeUInt8(2, 4); return item; })() },
    { name: "kind", bytes: (() => { const item = frame(status); item.writeUInt8(2, 5); return item; })() },
    { name: "flags", bytes: (() => { const item = frame(status); item.writeUInt16LE(1, 6); return item; })() },
    { name: "CRC", bytes: (() => { const item = frame(status); item.writeUInt32LE(0, 12); return item; })() },
    { name: "UTF-8", bytes: frame({}, Buffer.from([0xff])) },
    { name: "JSON", bytes: frame({}, Buffer.from("{", "utf8")) },
    { name: "length", bytes: (() => { const item = frame(status); item.writeUInt32LE(65537, 8); return item; })() },
  ];
  for (const invalid of malformed) {
    await assert.rejects(fixture((request, socket) => {
      if (request.op === "hello") socket.write(invalid.bytes);
    }), /FZVA/, invalid.name);
  }
});

test("status probe rejects wrong contract, request, boot transition, and unexpected replies", async () => {
  await assert.rejects(fixture((request, socket) => {
    if (request.op === "hello") socket.write(frame({ ...status, type: "hello", ok: true, contract_id: "0".repeat(64) }));
  }), /contract/);
  await assert.rejects(fixture((request, socket) => {
    if (request.op === "hello") socket.write(frame({ ...status, type: "hello", ok: true }));
    if (request.op === "status") socket.write(frame({ type: "ack", op: "status", ok: true,
      request_id: "stale", result: status }));
  }), /Unexpected/);
  await assert.rejects(fixture((request, socket) => {
    if (request.op === "hello") socket.write(frame({ ...status, type: "hello", ok: true }));
    if (request.op === "status") socket.write(frame({ ...status,
      boot_id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" }));
  }), /boot ID changed/);
  await assert.rejects(fixture((request, socket) => {
    if (request.op === "hello") socket.write(frame({ ...status, type: "hello", ok: true }));
    if (request.op === "status") socket.write(frame({ type: "result", frame_id: 1 }));
  }), /Unexpected/);
});

test("status probe has an absolute deadline and terminal ACK ignores trailing bytes regardless of packet layout", async () => {
  await assert.rejects(fixture(() => {}, 30), /deadline/);
  for (const fragmentedAck of [false, true]) {
    const { result } = await fixture((request, socket) => {
      if (request.op === "hello") socket.write(frame({ ...status, type: "hello", ok: true }));
      if (request.op === "status") {
        const ack = frame({ type: "ack", op: "status", ok: true,
          request_id: request.request_id, result: status });
        if (fragmentedAck) socket.write(ack.subarray(0, 7));
        socket.write(Buffer.concat([fragmentedAck ? ack.subarray(7) : ack,
          Buffer.from("NOPE"), frame(status).subarray(0, 7)]));
      }
    });
    assert.equal(result.bootId, bootId);
  }
  await assert.rejects(fixture((request, socket) => {
    if (request.op === "hello") socket.write(frame({ ...status, type: "hello", ok: true }));
    if (request.op === "status") socket.write(Buffer.concat([
      Buffer.from("NOPE"), frame({ type: "ack", op: "status", ok: true,
        request_id: request.request_id, result: status }),
    ]));
  }), /FZVA/);
});

test("a terminal socket absorbs a late error after success or rejected frame", async () => {
  const success = await fixture((request, socket) => {
    if (request.op === "hello") socket.write(frame({ ...status, type: "hello", ok: true }));
    if (request.op === "status") socket.write(frame({ type: "ack", op: "status", ok: true,
      request_id: request.request_id, result: status }));
  });
  assert.doesNotThrow(() => success.client.emit("error", new Error("late success error")));
  const rejectedClient: { current?: Socket } = {};
  await assert.rejects(fixture((request, socket) => {
    if (request.op === "hello") socket.write(frame({ type: "unexpected" }));
  }, 500, socket => { rejectedClient.current = socket; }), /hello rejected/);
  const client = rejectedClient.current;
  assert.ok(client);
  assert.doesNotThrow(() => client.emit("error", new Error("late rejected error")));
});

test("production entry requires explicit disconnect-effect acknowledgement without a configurable endpoint", () => {
  assert.throws(() => probeFz3bClaimedStatus({ acknowledgeControlDisconnectEffect: false as true }), /acknowledged/);
});
