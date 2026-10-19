import { createHash } from "node:crypto";

export const STM32_F429_FLASH_START = 0x08000000;
export const STM32_F429_FLASH_END = 0x08100000;
export const STM32_F429_CHIP_ID = 0x419;
export const STM32_F429_FLASH_KIB = 1024;
export const FIREDAP_VID = "1FC9";
export const FIREDAP_PID = "5601";
export const FIREDAP_SERIAL = "594AC1D7613FED24";

const MAX_HEX_BYTES = 8 * 1024 * 1024;
const SECTOR_STARTS = [
  0x08000000, 0x08004000, 0x08008000, 0x0800c000,
  0x08010000, 0x08020000, 0x08040000, 0x08060000,
  0x08080000, 0x080a0000, 0x080c0000, 0x080e0000,
] as const;

export interface Stm32Observation {
  probe: { usbVid: string; usbPid: string; serial: string };
  chip: { dbgMcuIdcode: number; flashSizeKiB: number; uid96: string };
  /** This is a trusted UI record, not a property inferred from silicon. */
  board: { confirmedV1: true; source: "user"; confirmationId: string };
}

export interface Stm32FlashCandidate {
  observation: Stm32Observation;
  expectedUid96: string;
  artifactHex: Uint8Array;
  expectedArtifactSha256: string;
  eraseMode: "sectors";
  eraseSectorStarts: number[];
}

export interface Stm32CandidateDescription {
  target: "STM32F429xG";
  board: "EmbedFire STM32F429IGT6 Challenger V1";
  boardConfirmation: "user";
  boardConfirmationId: string;
  probe: { usbVid: typeof FIREDAP_VID; usbPid: typeof FIREDAP_PID; serial: typeof FIREDAP_SERIAL };
  chipId: typeof STM32_F429_CHIP_ID;
  flashSizeKiB: typeof STM32_F429_FLASH_KIB;
  uid96: string;
  flashStart: typeof STM32_F429_FLASH_START;
  flashEndExclusive: typeof STM32_F429_FLASH_END;
}

export interface ValidatedStm32FlashPlan {
  candidate: Stm32CandidateDescription;
  artifactSha256: string;
  bytesProgrammed: number;
  addressStart: number;
  addressEndExclusive: number;
  initialStackPointer: number;
  resetHandler: number;
  startLinearAddress?: number;
  eraseSectorStarts: number[];
}

export interface Stm32FlashReadbackComparison {
  definedBytes: number;
  mismatchBytes: number;
  readbackSha256: string;
}

interface DataRecord { start: number; end: number; data: Uint8Array }

function canonicalHex(value: string, length: number, label: string): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value)) {
    throw new Error(`${label} must be ${length} hexadecimal digits`);
  }
  return value.toUpperCase();
}

function validU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${label} must be a uint32`);
}

/** Pure validation of values supplied by trusted, read-only inventory. No hardware access. */
export function describeStm32TargetCandidate(observation: Stm32Observation): Stm32CandidateDescription {
  if (!observation || !observation.probe || !observation.chip || !observation.board) throw new Error("Incomplete STM32 observation");
  const vid = canonicalHex(observation.probe.usbVid, 4, "Probe VID");
  const pid = canonicalHex(observation.probe.usbPid, 4, "Probe PID");
  const serial = canonicalHex(observation.probe.serial, FIREDAP_SERIAL.length, "Probe serial");
  if (vid !== FIREDAP_VID || pid !== FIREDAP_PID || serial !== FIREDAP_SERIAL) throw new Error("Wrong fireDAP probe identity");
  validU32(observation.chip.dbgMcuIdcode, "DBGMCU IDCODE");
  if ((observation.chip.dbgMcuIdcode & 0xfff) !== STM32_F429_CHIP_ID) throw new Error("Wrong STM32 chip ID");
  if (observation.chip.flashSizeKiB !== STM32_F429_FLASH_KIB) throw new Error("Wrong STM32 Flash size");
  const uid96 = canonicalHex(observation.chip.uid96, 24, "STM32 UID96");
  if (/^0+$/.test(uid96) || /^F+$/.test(uid96)) throw new Error("Unusable STM32 UID96 readback");
  if (observation.board.confirmedV1 !== true || observation.board.source !== "user" ||
      typeof observation.board.confirmationId !== "string" || !observation.board.confirmationId.trim()) {
    throw new Error("Challenger V1 needs a trusted human confirmation record");
  }
  return {
    target: "STM32F429xG", board: "EmbedFire STM32F429IGT6 Challenger V1",
    boardConfirmation: "user", boardConfirmationId: observation.board.confirmationId,
    probe: { usbVid: FIREDAP_VID, usbPid: FIREDAP_PID, serial: FIREDAP_SERIAL },
    chipId: STM32_F429_CHIP_ID, flashSizeKiB: STM32_F429_FLASH_KIB, uid96,
    flashStart: STM32_F429_FLASH_START, flashEndExclusive: STM32_F429_FLASH_END,
  };
}

function parseIntelHex(artifact: Uint8Array): { records: DataRecord[]; startLinearAddress?: number } {
  if (!(artifact instanceof Uint8Array) || artifact.byteLength === 0 || artifact.byteLength > MAX_HEX_BYTES) {
    throw new Error("Intel HEX artifact is empty or exceeds the 8 MiB parser limit");
  }
  const raw = Buffer.from(artifact).toString("ascii");
  if (!Buffer.from(raw, "ascii").equals(Buffer.from(artifact))) throw new Error("Intel HEX must be ASCII");
  const lines = raw.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  let upper = 0;
  let sawEof = false;
  let startLinearAddress: number | undefined;
  const records: DataRecord[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (sawEof) throw new Error("Intel HEX contains records after EOF");
    if (!/^:[0-9a-fA-F]+$/.test(line) || line.length < 11 || (line.length & 1) !== 1) {
      throw new Error(`Invalid Intel HEX record at line ${index + 1}`);
    }
    const bytes = Buffer.from(line.slice(1), "hex");
    const count = bytes[0];
    if (line.length !== 11 + count * 2) throw new Error(`Intel HEX byte count mismatch at line ${index + 1}`);
    if (bytes.reduce((sum, byte) => sum + byte, 0) % 256 !== 0) throw new Error(`Intel HEX checksum mismatch at line ${index + 1}`);
    const offset = (bytes[1] << 8) | bytes[2];
    const type = bytes[3];
    if (type === 0x00) {
      if (count === 0) throw new Error("Empty Intel HEX data record");
      if (offset + count > 0x10000) throw new Error("Intel HEX data record crosses a 64 KiB address window");
      const start = upper + offset;
      const end = start + count;
      if (start < STM32_F429_FLASH_START || end > STM32_F429_FLASH_END) throw new Error("Intel HEX data exceeds fixed 1 MiB Flash range");
      records.push({ start, end, data: bytes.subarray(4, 4 + count) });
    } else if (type === 0x01) {
      if (count !== 0 || offset !== 0) throw new Error("Invalid Intel HEX EOF record");
      sawEof = true;
    } else if (type === 0x04) {
      if (count !== 2 || offset !== 0) throw new Error("Invalid Intel HEX extended linear address record");
      upper = ((bytes[4] << 8) | bytes[5]) * 0x10000;
    } else if (type === 0x05) {
      if (count !== 4 || offset !== 0 || startLinearAddress !== undefined) throw new Error("Invalid Intel HEX start linear address record");
      startLinearAddress = bytes.readUInt32BE(4);
    } else {
      throw new Error(`Unsupported Intel HEX record type ${type}`);
    }
  }
  if (!sawEof || records.length === 0) throw new Error("Intel HEX requires data and one final EOF record");
  records.sort((a, b) => a.start - b.start);
  for (let index = 1; index < records.length; index++) {
    if (records[index].start < records[index - 1].end) throw new Error("Overlapping Intel HEX data records");
  }
  return { records, startLinearAddress };
}

function byteAt(records: DataRecord[], address: number): number | undefined {
  for (const record of records) if (record.start <= address && address < record.end) return record.data[address - record.start];
  return undefined;
}

function u32At(records: DataRecord[], address: number): number {
  const bytes = [0, 1, 2, 3].map(index => byteAt(records, address + index));
  if (bytes.some(byte => byte === undefined)) throw new Error("Intel HEX lacks a complete vector table at Flash base");
  return ((bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 0);
}

function programmed(records: DataRecord[], address: number): boolean {
  return byteAt(records, address) !== undefined;
}

function sectorFor(address: number): number {
  for (let index = SECTOR_STARTS.length - 1; index >= 0; index--) if (address >= SECTOR_STARTS[index]) return SECTOR_STARTS[index];
  throw new Error("Erase address is below Flash base");
}

function sectorsForRecords(records: DataRecord[]): number[] {
  const touched = new Set<number>();
  for (const record of records) {
    let address = record.start;
    while (address < record.end) {
      const sector = sectorFor(address);
      touched.add(sector);
      const index = SECTOR_STARTS.indexOf(sector as typeof SECTOR_STARTS[number]);
      address = Math.min(record.end, index === SECTOR_STARTS.length - 1 ? STM32_F429_FLASH_END : SECTOR_STARTS[index + 1]);
    }
  }
  return [...touched].sort((a, b) => a - b);
}

/** Propose selective sector starts from HEX contents; this does not authorize erasure. */
export function requiredStm32EraseSectors(artifactHex: Uint8Array): number[] {
  return sectorsForRecords(parseIntelHex(artifactHex).records);
}

/** Compare only programmed HEX bytes against a complete, caller-supplied Flash readback. */
export function compareStm32FlashReadback(
  artifactHex: Uint8Array,
  flashBackup: Uint8Array,
): Stm32FlashReadbackComparison {
  if (!(flashBackup instanceof Uint8Array) || flashBackup.byteLength !== STM32_F429_FLASH_KIB * 1024) {
    throw new Error("STM32 Flash readback must be exactly 1048576 bytes");
  }
  const { records } = parseIntelHex(artifactHex);
  let definedBytes = 0;
  let mismatchBytes = 0;
  for (const record of records) {
    const offset = record.start - STM32_F429_FLASH_START;
    definedBytes += record.data.length;
    for (let index = 0; index < record.data.length; index++) {
      if (flashBackup[offset + index] !== record.data[index]) mismatchBytes++;
    }
  }
  return {
    definedBytes,
    mismatchBytes,
    readbackSha256: createHash("sha256").update(flashBackup).digest("hex"),
  };
}

/** Validate one fixed-target candidate before any flash command is constructed. */
export function validateStm32FlashCandidate(input: Stm32FlashCandidate): ValidatedStm32FlashPlan {
  const candidate = describeStm32TargetCandidate(input.observation);
  if (canonicalHex(input.expectedUid96, 24, "Expected UID96") !== candidate.uid96) throw new Error("STM32 UID96 differs from binding");
  const expectedSha = canonicalHex(input.expectedArtifactSha256, 64, "Artifact SHA-256").toLowerCase();
  const actualSha = createHash("sha256").update(input.artifactHex).digest("hex");
  if (actualSha !== expectedSha) throw new Error("Artifact SHA-256 mismatch");
  const { records, startLinearAddress } = parseIntelHex(input.artifactHex);
  const initialStackPointer = u32At(records, STM32_F429_FLASH_START);
  const inSram = initialStackPointer > 0x20000000 && initialStackPointer <= 0x20030000;
  const inCcm = initialStackPointer > 0x10000000 && initialStackPointer <= 0x10010000;
  if ((initialStackPointer & 7) !== 0 || (!inSram && !inCcm)) throw new Error("Invalid STM32 vector initial stack pointer");
  const resetHandler = u32At(records, STM32_F429_FLASH_START + 4);
  const resetAddress = resetHandler - 1;
  if ((resetHandler & 1) !== 1 || resetAddress < STM32_F429_FLASH_START || resetAddress + 1 >= STM32_F429_FLASH_END ||
      !programmed(records, resetAddress) || !programmed(records, resetAddress + 1)) {
    throw new Error("Invalid STM32 Thumb reset vector or unprogrammed reset address");
  }
  if (startLinearAddress !== undefined) {
    const entry = startLinearAddress - 1;
    if ((startLinearAddress & 1) !== 1 || entry < STM32_F429_FLASH_START || entry + 1 >= STM32_F429_FLASH_END ||
        !programmed(records, entry) || !programmed(records, entry + 1)) {
      throw new Error("Invalid Intel HEX start linear program address");
    }
  }
  const needed = sectorsForRecords(records);
  if (input.eraseMode !== "sectors" || !Array.isArray(input.eraseSectorStarts) ||
      input.eraseSectorStarts.length !== needed.length ||
      input.eraseSectorStarts.some((sector, index) => sector !== needed[index])) {
    throw new Error("Erase plan must name exactly the programmed STM32 Flash sectors; mass erase and extra addresses are refused");
  }
  let addressEndExclusive = STM32_F429_FLASH_START;
  for (const record of records) if (record.end > addressEndExclusive) addressEndExclusive = record.end;
  return {
    candidate, artifactSha256: actualSha,
    bytesProgrammed: records.reduce((sum, record) => sum + record.data.length, 0),
    addressStart: records[0].start, addressEndExclusive,
    initialStackPointer, resetHandler, ...(startLinearAddress === undefined ? {} : { startLinearAddress }),
    eraseSectorStarts: needed,
  };
}
