import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { GESTURESCREEN_PROFILE, GESTURESCREEN_PROFILE_SHA256 } from "../embedded/profile.js";
import { FixedStm32HardwareService, parseFixedWorkerReceipt, prepareFixedWorkerInput } from "./real-stm32.js";

const repo = resolve(".");
const testRoot = join(repo, "output", "hardware", "offline-adapter-tests");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function receipt(action: "inspect" | "flash" | "verify", extra: Record<string, unknown> = {}) {
  return JSON.stringify({ schemaVersion: 1, action, operationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    status: "succeeded", stage: action === "inspect" ? "inspected" : action === "flash" ? "reset_and_exited" : "cdc_verified",
    ...extra }) + "\n";
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function verifyFrame(nonceHex: string, buildId: string, frames: number, uptime: number) {
  const frame = Buffer.alloc(100);
  frame.write("FDR1", 0, "ascii");
  Buffer.from(nonceHex, "hex").copy(frame, 4);
  Buffer.from(buildId, "hex").copy(frame, 20);
  Buffer.from("1b0037000451333136323832", "hex").copy(frame, 52);
  const fields = [31, frames, 0, 0, 0, 168000000, 48000000, uptime];
  fields.forEach((value, index) => frame.writeUInt32LE(value, 64 + index * 4));
  frame.writeUInt32LE(crc32(frame.subarray(0, 96)), 96);
  return { nonceHex, responseHex: frame.toString("hex"), receivedAtUtc: new Date().toISOString(),
    decoded: { flags: 31, cameraFrames: frames, cameraErrors: 0, cameraTimeouts: 0,
      displayErrors: 0, sysclkHz: 168000000, pll48Hz: 48000000, uptimeMs: uptime } };
}

test("receipt parser requires action, operation and complete proof", () => {
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  assert.throws(() => parseFixedWorkerReceipt(receipt("flash"), "flash", id), /real programming/);
  assert.throws(() => parseFixedWorkerReceipt(receipt("verify"), "flash", id), /identity/);
  assert.throws(() => parseFixedWorkerReceipt(receipt("verify"), "verify", randomUUID()), /identity/);
  assert.throws(() => parseFixedWorkerReceipt(receipt("verify") + "{}\n", "verify", id), /one bounded/);
  const valid = parseFixedWorkerReceipt(receipt("flash", { definedBytes: 32, preflashDifferentBytes: 1,
    backupSha256: "b".repeat(64), preflashReadSha256: "b".repeat(64),
    readbackDefinedBytes: 32, readbackMismatchBytes: 0, readbackSha256: "a".repeat(64) }), "flash", id);
  assert.equal(valid.status, "succeeded");
});

test("verify receipt independently checks raw FDR1 frames, CRC, nonce, build and UID", () => {
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const buildId = "7".repeat(64);
  const verify = { expectedBuildId: buildId, expectedUid96: "0037001b3133510432383236",
    frameDelta: 2, uptimeDeltaMs: 300,
    challenges: [verifyFrame("01".repeat(16), buildId, 100, 1000), verifyFrame("02".repeat(16), buildId, 102, 1300)] };
  assert.equal(parseFixedWorkerReceipt(receipt("verify", { verify }), "verify", id, buildId).status, "succeeded");
  assert.throws(() => parseFixedWorkerReceipt(receipt("verify", { verify }), "verify", id, "8".repeat(64)), /CDC acceptance/);
  const secondHex = verify.challenges[1].responseHex;
  const wrongCrc = { ...verify, challenges: [verify.challenges[0], { ...verify.challenges[1],
    responseHex: secondHex.slice(0, -2) + (secondHex.endsWith("00") ? "01" : "00") }] };
  assert.throws(() => parseFixedWorkerReceipt(receipt("verify", { verify: wrongCrc }), "verify", id, buildId), /CDC acceptance/);
  const staleNonce = { ...verify, challenges: [verify.challenges[0], { ...verify.challenges[1], nonceHex: "01".repeat(16) }] };
  assert.throws(() => parseFixedWorkerReceipt(receipt("verify", { verify: staleNonce }), "verify", id, buildId), /CDC acceptance/);
});

test("fixed worker input rechecks artifact and complete backup, never accepts missing bindings", async () => {
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "case-"));
  try {
    const hex = Buffer.from(":00000001FF\n");
    const axf = Buffer.from("synthetic AXF fixture");
    const backup = Buffer.alloc(1024 * 1024, 0xff);
    const hexPath = join(directory, "fixture.hex");
    const axfPath = join(directory, "fixture.axf");
    const backupPath = join(directory, "backup.bin");
    await Promise.all([writeFile(hexPath, hex), writeFile(axfPath, axf), writeFile(backupPath, backup)]);
    const context = { taskId: "test", operationId: randomUUID(), operationDir: directory, nonce: "fixture",
      profile: GESTURESCREEN_PROFILE, artifact: { id: "fixture", buildId: "1".repeat(64),
        hexPath, axfPath, hexSha256: hash(hex), axfSha256: hash(axf), sourceSha256: "2".repeat(64),
        profileSha256: GESTURESCREEN_PROFILE_SHA256 }, backup: { path: backupPath, sha256: hash(backup) } };
    const input = await prepareFixedWorkerInput("flash", context);
    assert.deepEqual(input.backup, { path: backupPath, sha256: hash(backup) });
    await assert.rejects(prepareFixedWorkerInput("flash", { ...context, backup: undefined }), /backup/);
    await assert.rejects(prepareFixedWorkerInput("flash", { ...context, backup: { path: backupPath, sha256: "0".repeat(64) } }), /SHA-256 mismatch/);
    await assert.rejects(prepareFixedWorkerInput("flash", { ...context, artifact: { ...context.artifact, hexSha256: "0".repeat(64) } }), /HEX artifact SHA-256 mismatch/);
    await writeFile(backupPath, backup.subarray(0, backup.length - 1));
    await assert.rejects(prepareFixedWorkerInput("flash", context), /backup length or SHA-256 mismatch/i);
  } finally {
    if (!directory.startsWith(testRoot + "\\") && !directory.startsWith(testRoot + "/")) throw new Error("Unsafe test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});

test("Python worker pure parsers enforce CRC, exact response identity and sparse HEX", () => {
  const python = join(repo, "output", "hardware", "tooling", "pyocd-venv", "Scripts", "python.exe");
  if (!existsSync(python)) return;
  const code = `import importlib.util,struct,zlib
spec=importlib.util.spec_from_file_location('worker',r'${join(repo, "engineering", "hardware-worker.py").replaceAll("\\", "\\\\")}')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
uid=bytes.fromhex('1b0037000451333136323832')
assert w.canonical_uid(uid)=='0037001b3133510432383236'
assert w.canonical_uid(bytes.fromhex(w.UID_CANONICAL))!=w.UID_CANONICAL
class Target:
 def read32(self,a):return 0x10006419
 def read16(self,a):return 1024
 def read_memory_block8(self,a,n):return uid
assert w.identify(Target())['uid96']==w.UID_CANONICAL
class WrongTarget(Target):
 def read_memory_block8(self,a,n):return bytes.fromhex(w.UID_CANONICAL)
try:w.identify(WrongTarget());assert False
except ValueError:pass
def row(t,a,d=b''):
 b=bytes([len(d),a>>8,a&255,t])+d;return ':'+(b+bytes([-sum(b)&255])).hex().upper()+'\\n'
vec=(0x20030000).to_bytes(4,'little')+(0x08000011).to_bytes(4,'little')+bytes(8)
h=(row(4,0,bytes([8,0]))+row(0,0,vec)+row(0,16,bytes([0x42,0x43]))+row(1,0)).encode()
records=w.parse_hex(h);image=bytearray([255])*w.FLASH_SIZE
assert w.parse_hex(h.replace(b'\\n',b'\\r\\n'))==records
assert w.coalesce_records(records)==[(w.FLASH_START,vec+bytes([0x42,0x43]))]
edge=w.coalesce_records([(0x0800fffe,b'abcd'),(0x08010004,b'xy')])
assert edge==[(0x0800fffe,b'ab'),(0x08010000,b'cd'),(0x08010004,b'xy')]
big=w.coalesce_records([(w.FLASH_START,bytes(65537))])
assert list(map(lambda item:len(item[1]),big))==[65536,1]
for a,d in records:image[a-w.FLASH_START:a-w.FLASH_START+len(d)]=d
assert w.compare_defined(records,image)==(18,0)
image[0x80]=0;assert w.compare_defined(records,image)==(18,0)
image[0x11]=0;assert w.compare_defined(records,image)==(18,1)
backup=bytes(image)
class Flash:
 def __init__(self,data):self.data=data
 def read_memory_block8(self,address,n):return self.data[address-w.FLASH_START:address-w.FLASH_START+n]
assert w.require_backup_unchanged(Flash(backup),backup)==w.sha256(backup)
changed=bytearray(backup);changed[0x40000]^=1
try:w.require_backup_unchanged(Flash(changed),backup);assert False
except ValueError:pass
nonce=bytes(range(16));build=bytes([7])*32
body=b'FDR1'+nonce+build+uid+struct.pack('<8I',31,10,0,0,0,168000000,48000000,1000)
frame=body+struct.pack('<I',zlib.crc32(body)&0xffffffff)
assert len(frame)==100 and w.parse_response(frame,nonce,build)['cameraFrames']==10
request=w.request_frame(nonce)
assert len(request)==24 and request[:4]==b'FDQ1' and int.from_bytes(request[20:],'little')==zlib.crc32(request[:20])&0xffffffff
class Stream:
 def __init__(self):self.data=bytearray(b'GSFR'+bytes(153644)+frame)
 def read(self,n):chunk=bytes(self.data[:n]);del self.data[:n];return chunk
 def write(self,data):return len(data)
assert w.read_response(Stream(),nonce,build,__import__('time').monotonic()+5)['responseHex']==frame.hex()
for invalid in (frame[:-1]+b'X',frame[:4]+bytes(16)+frame[20:]):
 try:w.parse_response(invalid,nonce,build);assert False
 except ValueError:pass
for wrong_nonce,wrong_build in ((bytes(16),build),(nonce,bytes(32))):
 try:w.parse_response(frame,wrong_nonce,wrong_build);assert False
 except ValueError:pass
wrong_uid=body[:52]+bytes(12)+body[64:]
wrong_uid+=struct.pack('<I',zlib.crc32(wrong_uid)&0xffffffff)
try:w.parse_response(wrong_uid,nonce,build);assert False
except ValueError:pass
print('offline worker parsers ok')`;
  const output = execFileSync(python, ["-c", code], { cwd: repo, encoding: "utf8", timeout: 15000 });
  assert.match(output, /offline worker parsers ok/);
});

test("process host visibility timeout remains unknown until the same worker closes", async () => {
  const python = join(repo, "output", "hardware", "tooling", "pyocd-venv", "Scripts", "python.exe");
  const host = join(repo, "vendor", "process-host", "process-host.exe");
  if (!existsSync(python) || !existsSync(host)) return;
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(join(testRoot, "host-"));
  let active: FixedStm32HardwareService | undefined;
  let activeOperationId: string | undefined;
  try {
    const script = join(directory, "offline worker with spaces.py");
    const workerPath = join(repo, "engineering", "hardware-worker.py").replaceAll("\\", "\\\\");
    await writeFile(script, `import importlib.util,json,pathlib,sys,time\ns=importlib.util.spec_from_file_location('w',r'${workerPath}');w=importlib.util.module_from_spec(s);s.loader.exec_module(w)\np=json.loads(pathlib.Path(sys.argv[2]).read_text())\nw.record_process_identity(p['operationId'],p['operationDir'])\nrelease=pathlib.Path(p['operationDir'],'release.fixture')\nwhile not release.exists():time.sleep(.02)\nr={'schemaVersion':1,'action':p['action'],'operationId':p['operationId'],'status':'failed','stage':'offline-fixture'}\npathlib.Path(p['operationDir'],'receipt.json').write_text(json.dumps(r,separators=(',',':')))\nprint(json.dumps(r,separators=(',',':')))\nsys.exit(2)\n`);
    const operationId = randomUUID();
    const adapter = new FixedStm32HardwareService({ processHost: host, pythonExecutable: python,
      workerScript: script, inspectDeadlineMs: 20 });
    active = adapter;
    activeOperationId = operationId;
    const context = { taskId: "test", operationId, operationDir: directory, nonce: "fixture", profile: GESTURESCREEN_PROFILE };
    const result = await adapter.inspect(context);
    assert.equal(result.status, "unknown");
    assert.equal(result.processExited, false);
    assert.equal(await adapter.confirmProcessExited(operationId), false);
    const markerPath = join(directory, "worker-process.json");
    const markerDeadline = Date.now() + 10000;
    while (!existsSync(markerPath) && Date.now() < markerDeadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(markerPath), true);
    const restarted = new FixedStm32HardwareService({ processHost: host, pythonExecutable: python,
      workerScript: join(repo, "engineering", "hardware-worker.py") });
    assert.equal(await restarted.confirmProcessExited(operationId, directory), false);
    await writeFile(join(directory, "release.fixture"), "exit");
    const stop = Date.now() + 10000;
    while (!await adapter.confirmProcessExited(operationId) && Date.now() < stop) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await adapter.confirmProcessExited(operationId), true);
    assert.equal(await restarted.confirmProcessExited(operationId, directory), true);
    assert.equal(await adapter.confirmProcessExited(randomUUID()), false);
    assert.equal(await restarted.confirmProcessExited(randomUUID(), directory), false);
  } finally {
    await writeFile(join(directory, "release.fixture"), "exit");
    if (active && activeOperationId) {
      const deadline = Date.now() + 10000;
      while (!await active.confirmProcessExited(activeOperationId) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    if (!directory.startsWith(testRoot + "\\") && !directory.startsWith(testRoot + "/")) throw new Error("Unsafe test cleanup path");
    await rm(directory, { recursive: true, force: true });
  }
});
