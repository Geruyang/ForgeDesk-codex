import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  compareStm32FlashReadback,
  describeStm32TargetCandidate,
  requiredStm32EraseSectors,
  validateStm32FlashCandidate,
  type Stm32FlashCandidate,
  type Stm32Observation,
} from "./stm32-target.js";

function record(type: number, address: number, data: number[] = []): string {
  const bytes = [data.length, address >> 8, address & 0xff, type, ...data];
  bytes.push((-bytes.reduce((sum, value) => sum + value, 0)) & 0xff);
  return `:${bytes.map(value => value.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

function word(value: number): number[] {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return [...bytes];
}

function image(options: { stack?: number; reset?: number; entry?: number; body?: number[]; extra?: string[]; eof?: boolean } = {}): Buffer {
  const vector = [...word(options.stack ?? 0x20030000), ...word(options.reset ?? 0x08000011), ...Array(8).fill(0)];
  const entry = options.entry ?? 0x08000011;
  return Buffer.from([
    record(4, 0, [0x08, 0x00]),
    record(0, 0, vector),
    record(0, 0x10, options.body ?? Array(16).fill(0x42)),
    ...(options.extra ?? []),
    record(5, 0, [(entry >>> 24) & 0xff, (entry >>> 16) & 0xff, (entry >>> 8) & 0xff, entry & 0xff]),
    ...(options.eof === false ? [] : [record(1, 0)]),
  ].join("\n") + "\n", "ascii");
}

function observation(): Stm32Observation {
  return {
    probe: { usbVid: "1FC9", usbPid: "5601", serial: "594AC1D7613FED24" },
    chip: { dbgMcuIdcode: 0x10006419, flashSizeKiB: 1024, uid96: "00112233445566778899AABB" },
    board: { confirmedV1: true, source: "user", confirmationId: "trusted-ui-confirmation-1" },
  };
}

function candidate(hex = image()): Stm32FlashCandidate {
  return {
    observation: observation(), expectedUid96: "00112233445566778899AABB",
    artifactHex: hex, expectedArtifactSha256: createHash("sha256").update(hex).digest("hex"),
    eraseMode: "sectors", eraseSectorStarts: [0x08000000],
  };
}

test("describes only this human-confirmed Challenger V1, chip and fireDAP", () => {
  const result = describeStm32TargetCandidate(observation());
  assert.equal(result.target, "STM32F429xG");
  assert.equal(result.chipId, 0x419);
  assert.equal(result.flashSizeKiB, 1024);
  assert.equal(result.probe.serial, "594AC1D7613FED24");
  assert.equal(result.boardConfirmation, "user");
  assert.throws(() => describeStm32TargetCandidate({ ...observation(), probe: { ...observation().probe, serial: "594AC1D7613FED25" } }), /Wrong fireDAP/);
  assert.throws(() => describeStm32TargetCandidate({ ...observation(), probe: { ...observation().probe, usbPid: "5602" } }), /Wrong fireDAP/);
  assert.throws(() => describeStm32TargetCandidate({ ...observation(), chip: { ...observation().chip, dbgMcuIdcode: 0x10006413 } }), /Wrong STM32 chip ID/);
  assert.throws(() => describeStm32TargetCandidate({ ...observation(), chip: { ...observation().chip, flashSizeKiB: 2048 } }), /Wrong STM32 Flash size/);
  assert.throws(() => describeStm32TargetCandidate({ ...observation(), chip: { ...observation().chip, uid96: "FFFFFFFFFFFFFFFFFFFFFFFF" } }), /Unusable STM32 UID96/);
  assert.throws(() => describeStm32TargetCandidate({ ...observation(), board: { ...observation().board, confirmationId: "" } }), /human confirmation/);
});

test("validates checksum, vectors, SHA and exact sector plan for a small image", () => {
  const result = validateStm32FlashCandidate(candidate());
  assert.equal(result.addressStart, 0x08000000);
  assert.equal(result.addressEndExclusive, 0x08000020);
  assert.equal(result.initialStackPointer, 0x20030000);
  assert.equal(result.resetHandler, 0x08000011);
  assert.equal(result.startLinearAddress, 0x08000011);
  assert.deepEqual(result.eraseSectorStarts, [0x08000000]);
  assert.equal(result.bytesProgrammed, 32);
  assert.deepEqual(requiredStm32EraseSectors(image()), [0x08000000]);
});

test("rejects wrong UID, artifact digest and erase addresses/mode", () => {
  assert.throws(() => validateStm32FlashCandidate({ ...candidate(), expectedUid96: "00112233445566778899AABC" }), /UID96 differs/);
  assert.throws(() => validateStm32FlashCandidate({ ...candidate(), expectedArtifactSha256: "0".repeat(64) }), /SHA-256 mismatch/);
  assert.throws(() => validateStm32FlashCandidate({ ...candidate(), eraseSectorStarts: [0x08004000] }), /Erase plan/);
  assert.throws(() => validateStm32FlashCandidate({ ...candidate(), eraseSectorStarts: [0x08000000, 0x08100000] }), /Erase plan/);
  assert.throws(() => validateStm32FlashCandidate({ ...candidate(), eraseMode: "mass" as "sectors" }), /Erase plan/);
});

test("rejects malformed Intel HEX, missing EOF, overlap and out-of-range programming", () => {
  const good = image();
  const corrupt = Buffer.from(good);
  corrupt[14] = corrupt[14] === 0x30 ? 0x31 : 0x30;
  assert.throws(() => validateStm32FlashCandidate(candidate(corrupt)), /checksum|Flash range/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ eof: false }))), /EOF/);
  const afterEof = Buffer.from(good.toString("ascii") + record(0, 0x20, [0x42]) + "\n", "ascii");
  assert.throws(() => validateStm32FlashCandidate(candidate(afterEof)), /after EOF/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ extra: [record(0, 0x18, [1, 2])] }))), /Overlapping/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ extra: [record(4, 0, [0x08, 0x10]), record(0, 0, [0x42])] }))), /Flash range/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ extra: [record(2, 0, [0x08, 0x00])] }))), /Unsupported/);
});

test("rejects invalid SRAM/CCM stack, reset Thumb bit or unprogrammed entry", () => {
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ stack: 0x30000000 }))), /stack pointer/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ stack: 0x20000000 }))), /stack pointer/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ stack: 0x10000000 }))), /stack pointer/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ stack: 0x10000004 }))), /stack pointer/);
  assert.equal(validateStm32FlashCandidate(candidate(image({ stack: 0x10010000 }))).initialStackPointer, 0x10010000);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ reset: 0x08000010 }))), /Thumb reset/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ reset: 0x08000101 }))), /Thumb reset/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ body: [0x42] }))), /Thumb reset/);
  assert.throws(() => validateStm32FlashCandidate(candidate(image({ entry: 0x08010001 }))), /program address/);
});

test("compares only defined HEX bytes against a complete Flash readback", () => {
  const hex = image({ extra: [record(0, 0x100, [0xab, 0xcd])] });
  const backup = Buffer.alloc(1024 * 1024, 0xff);
  const expected = [...word(0x20030000), ...word(0x08000011), ...Array(8).fill(0), ...Array(16).fill(0x42)];
  expected.forEach((byte, index) => { backup[index] = byte; });
  backup[0x100] = 0xab;
  backup[0x101] = 0xcd;
  const matching = compareStm32FlashReadback(hex, backup);
  assert.equal(matching.definedBytes, 34);
  assert.equal(matching.mismatchBytes, 0);
  assert.equal(matching.readbackSha256, createHash("sha256").update(backup).digest("hex"));

  backup[0x80] = 0;
  assert.equal(compareStm32FlashReadback(hex, backup).mismatchBytes, 0);
  backup[0x101] = 0;
  assert.equal(compareStm32FlashReadback(hex, backup).mismatchBytes, 1);
  backup[0x10] = 0;
  assert.equal(compareStm32FlashReadback(hex, backup).mismatchBytes, 2);
});

test("readback comparison rejects incomplete backups and malformed HEX", () => {
  assert.throws(() => compareStm32FlashReadback(image(), Buffer.alloc(1024 * 1024 - 1)), /exactly 1048576/);
  assert.throws(() => compareStm32FlashReadback(image(), Buffer.alloc(1024 * 1024 + 1)), /exactly 1048576/);
  assert.throws(() => compareStm32FlashReadback(image({ eof: false }), Buffer.alloc(1024 * 1024)), /EOF/);
  assert.throws(() => compareStm32FlashReadback(image({ extra: [record(0, 0x18, [1])] }), Buffer.alloc(1024 * 1024)), /Overlapping/);
});
