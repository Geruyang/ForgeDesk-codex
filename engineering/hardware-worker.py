"""Fixed Challenger V1 hardware worker. Invoked only by the trusted local service.

No command-line hardware selection is accepted. Importing this module has no device effects.
The sole stdout line is a JSON receipt; pyOCD/serial diagnostics go to stderr.
"""

import argparse
import contextlib
import ctypes
from ctypes import wintypes
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import struct
import sys
import time
import zlib

FLASH_START = 0x08000000
FLASH_SIZE = 1024 * 1024
FLASH_END = FLASH_START + FLASH_SIZE
PROBE_VID_PID = (0x1FC9, 0x5601)
PROBE_SERIAL = "594AC1D7613FED24"
CHIP_ID = 0x419
UID_CANONICAL = "0037001b3133510432383236"
CDC_VID_PID = (0x0483, 0x5740)
CDC_SERIAL = "326F32513133"
SECTORS = (0x08000000, 0x08004000, 0x08008000, 0x0800C000,
           0x08010000, 0x08020000, 0x08040000, 0x08060000,
           0x08080000, 0x080A0000, 0x080C0000, 0x080E0000)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def parse_hex(data):
    """Return sorted, non-overlapping (absolute address, bytes) records."""
    require(isinstance(data, bytes) and 0 < len(data) <= 8 * 1024 * 1024,
            "HEX size is invalid")
    text = data.decode("ascii")
    require("\r" not in text.replace("\r\n", ""), "HEX line ending")
    text = text.replace("\r\n", "\n")
    lines = text.split("\n")
    require(len(lines) > 1 and lines[-1] == "", "HEX needs final newline")
    lines.pop()
    upper = 0
    eof = False
    entry = None
    records = []
    for line in lines:
        require(not eof, "HEX has records after EOF")
        require(bool(re.fullmatch(r":[0-9A-Fa-f]+", line)) and len(line) >= 11
                and len(line) % 2 == 1, "HEX record syntax")
        row = bytes.fromhex(line[1:])
        count = row[0]
        require(len(row) == count + 5, "HEX byte count")
        require(sum(row) & 0xFF == 0, "HEX checksum")
        offset = (row[1] << 8) | row[2]
        kind = row[3]
        payload = row[4:-1]
        if kind == 0:
            require(count > 0 and offset + count <= 0x10000,
                    "HEX data crosses 64 KiB window")
            address = upper + offset
            require(FLASH_START <= address and address + count <= FLASH_END,
                    "HEX outside fixed 1 MiB Flash")
            records.append((address, payload))
        elif kind == 1:
            require(count == 0 and offset == 0, "HEX EOF record")
            eof = True
        elif kind == 4:
            require(count == 2 and offset == 0, "HEX upper address record")
            upper = int.from_bytes(payload, "big") << 16
        elif kind == 5:
            require(count == 4 and offset == 0 and entry is None, "HEX entry record")
            entry = int.from_bytes(payload, "big")
            require(entry & 1 and FLASH_START <= entry - 1 < FLASH_END - 1,
                    "HEX entry outside Thumb Flash")
        else:
            raise ValueError("unsupported HEX record type")
    require(eof and records, "HEX requires data and final EOF")
    records.sort()
    for previous, current in zip(records, records[1:]):
        require(previous[0] + len(previous[1]) <= current[0],
                "overlapping HEX records")
    values = {address + i: byte for address, payload in records
              for i, byte in enumerate(payload)}
    require(all(FLASH_START + i in values for i in range(8)),
            "HEX lacks vector table")
    sp = int.from_bytes(bytes(values[FLASH_START + i] for i in range(4)), "little")
    reset = int.from_bytes(bytes(values[FLASH_START + i] for i in range(4, 8)), "little")
    valid_sp = ((0x20000000 < sp <= 0x20030000) or
                (0x10000000 < sp <= 0x10010000)) and sp % 8 == 0
    require(valid_sp, "invalid initial stack pointer")
    require(reset & 1 and reset - 1 in values and reset in values,
            "invalid or truncated Thumb reset vector")
    if entry is not None:
        require(entry - 1 in values and entry in values,
                "unprogrammed HEX entry")
    return records


def compare_defined(records, image):
    require(len(image) == FLASH_SIZE, "Flash backup/readback must be 1 MiB")
    defined = 0
    mismatches = 0
    for address, payload in records:
        start = address - FLASH_START
        defined += len(payload)
        mismatches += sum(a != b for a, b in zip(payload, image[start:start + len(payload)]))
    return defined, mismatches


def coalesce_records(records):
    """Bound builder operations without filling sparse gaps or crossing Flash regions."""
    boundaries = (0x08010000, 0x08020000, FLASH_END)
    chunks = []
    start = None
    block = bytearray()
    for address, payload in records:
        offset = 0
        while offset < len(payload):
            current = address + offset
            region_end = next(end for end in boundaries if current < end)
            if (start is None or current != start + len(block) or
                    len(block) == 65536 or current in boundaries[:-1]):
                if block:
                    chunks.append((start, bytes(block)))
                start = current
                block = bytearray()
            count = min(len(payload) - offset, 65536 - len(block), region_end - current)
            block.extend(payload[offset:offset + count])
            offset += count
    if block:
        chunks.append((start, bytes(block)))
    return chunks


def atomic_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp")
    with open(temp, "x", encoding="utf-8") as file:
        json.dump(value, file, separators=(",", ":"))
        file.flush()
        os.fsync(file.fileno())
    os.replace(temp, target)


def atomic_bytes(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + ".tmp")
    with open(temp, "xb") as file:
        file.write(value)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temp, target)


def atomic_progress_json(path, value):
    target = Path(path)
    temp = target.with_name(target.name + "." + secrets.token_hex(8) + ".tmp")
    try:
        with open(temp, "x", encoding="utf-8") as file:
            json.dump(value, file, separators=(",", ":"))
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, target)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


class ProgressWriter:
    """Durable, bounded telemetry; never used as an operation result."""

    def __init__(self, directory, operation_id, action):
        self.path = Path(directory) / "progress.json"
        self.operation_id = operation_id
        self.action = action
        self.sequence = -1
        self.last_stage = None
        self.last_completed = None
        self.last_write = 0.0

    def update(self, stage, completed=None, total=None, unit=None, message=None, force=False):
        require(stage in {"preflight", "probe_discovery", "connecting", "identifying",
                          "backup_read_1", "backup_read_2", "backup_saved",
                          "preflash_compare", "erase_program", "readback", "reset",
                          "cdc_discovery", "cdc_challenge_1", "cdc_challenge_2",
                          "finalizing"}, "invalid progress stage")
        if completed is not None:
            require(unit in ("bytes", "fraction", "steps") and total is not None,
                    "incomplete progress count")
            require(0 <= completed <= total and total > 0, "invalid progress count")
        else:
            require(total is None and unit is None, "incomplete progress count")
        now = time.monotonic()
        threshold = 65536 if unit == "bytes" else 0.02
        if (not force and stage == self.last_stage and
                completed is not None and self.last_completed is not None and
                completed < total and completed - self.last_completed < threshold and
                now - self.last_write < 0.25):
            return
        value = {"schemaVersion": 1, "operationId": self.operation_id,
                 "action": self.action, "stage": stage, "sequence": self.sequence + 1,
                 "updatedAt": datetime.now(timezone.utc).isoformat()}
        if completed is not None:
            value.update(completed=completed, total=total, unit=unit)
        if message is not None:
            value["message"] = message[:240]
        try:
            atomic_progress_json(self.path, value)
        except OSError:
            return
        self.sequence += 1
        self.last_stage = stage
        self.last_completed = completed
        self.last_write = now


def creation_filetime_100ns(pid):
    if os.name != "nt":
        return None

    class Filetime(ctypes.Structure):
        _fields_ = (("low", wintypes.DWORD), ("high", wintypes.DWORD))

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = (wintypes.HANDLE, ctypes.POINTER(Filetime),
                                       ctypes.POINTER(Filetime), ctypes.POINTER(Filetime),
                                       ctypes.POINTER(Filetime))
    kernel.GetProcessTimes.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        raise OSError("cannot query process creation time")
    try:
        created, exited, kernel_time, user_time = Filetime(), Filetime(), Filetime(), Filetime()
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                      ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise OSError("cannot query process times")
        return str((created.high << 32) | created.low)
    finally:
        kernel.CloseHandle(handle)


def process_identity(process):
    return {"pid": process.pid, "createTime": f"{process.create_time():.6f}",
            "creationFiletime100ns": creation_filetime_100ns(process.pid)}


def record_process_identity(operation_id, operation_dir):
    import psutil
    worker = psutil.Process(os.getpid())
    host = worker.parent()
    require(host is not None, "hardware worker host process is absent")
    marker = {"schemaVersion": 1, "operationId": operation_id,
              "worker": process_identity(worker), "host": process_identity(host)}
    atomic_json(Path(operation_dir) / "worker-process.json", marker)
    return marker


def check_exit_file(path):
    import psutil
    marker = json.loads(Path(path).read_text(encoding="utf-8"))
    require(marker.get("schemaVersion") == 1 and
            bool(re.fullmatch(r"[0-9a-fA-F-]{36}", marker.get("operationId", ""))),
            "invalid process identity marker")
    for role in ("worker", "host"):
        item = marker.get(role)
        require(isinstance(item, dict) and type(item.get("pid")) is int and item["pid"] > 0 and
                bool(re.fullmatch(r"\d+\.\d{6}", item.get("createTime", ""))) and
                (os.name != "nt" or bool(re.fullmatch(r"\d+", item.get("creationFiletime100ns", "")))),
                "invalid process identity marker")
        try:
            current = process_identity(psutil.Process(item["pid"]))
        except psutil.NoSuchProcess:
            continue
        except (psutil.Error, OSError):
            return False
        if (current["createTime"] == item["createTime"] and
                current["creationFiletime100ns"] == item["creationFiletime100ns"]):
            return False
    return True


def canonical_uid(raw):
    require(len(raw) == 12, "STM32 UID must be 96 bits")
    return "".join(f"{int.from_bytes(raw[index:index + 4], 'little'):08x}"
                   for index in (0, 4, 8))


def find_probe():
    from pyocd.core.helpers import ConnectHelper
    from pyocd.probe.cmsis_dap_probe import CMSISDAPProbe
    matches = []
    for probe in ConnectHelper.get_all_connected_probes(blocking=False):
        if (isinstance(probe, CMSISDAPProbe) and
                probe.unique_id.upper() == PROBE_SERIAL and
                tuple(probe._link.vidpid) == PROBE_VID_PID):
            matches.append(probe)
    require(len(matches) == 1, "fixed fireDAP probe absent or ambiguous")
    return matches[0]


def session(probe, target, operation_dir, resume_on_disconnect):
    from pyocd.core.session import Session
    class IsolatedSession(Session):
        def _load_user_script(self):
            return None

    return IsolatedSession(probe, options={
        "target_override": target, "connect_mode": "attach",
        "auto_unlock": False, "no_config": True, "user_script": None,
        "project_dir": str(operation_dir),
        "chip_erase": "sector", "smart_flash": False,
        "cache.enable_memory": False, "hide_programming_progress": True,
        "frequency": 1000000, "resume_on_disconnect": resume_on_disconnect,
    })


def identify(target):
    chip = target.read32(0xE0042000) & 0xFFF
    size = target.read16(0x1FFF7A22)
    uid = canonical_uid(bytes(target.read_memory_block8(0x1FFF7A10, 12)))
    require(chip == CHIP_ID and size == 1024 and uid == UID_CANONICAL,
            "fixed STM32 chip ID, size or UID mismatch")
    return {"chipId": chip, "flashSizeKiB": size, "uid96": uid}


def read_flash(target, progress=None, stage=None):
    chunks = bytearray()
    for offset in range(0, FLASH_SIZE, 4096):
        block = bytes(target.read_memory_block8(FLASH_START + offset, 4096))
        require(len(block) == 4096, "short SWD Flash read")
        chunks.extend(block)
        if progress is not None:
            progress.update(stage, len(chunks), FLASH_SIZE, "bytes")
    return bytes(chunks)


def require_backup_unchanged(target, backup, progress=None):
    current = read_flash(target, progress, "preflash_compare")
    require(len(backup) == FLASH_SIZE and current == backup,
            "target Flash changed since inspected backup; refusing to program")
    return sha256(current)


def prepare_flash_target(target, backup, progress, receipt):
    from pyocd.core.target import Target

    # A running application may be in handler mode with enabled interrupts. Start
    # the RAM flash algorithm from a reset, halted thread-mode core instead.
    progress.update("reset")
    target.reset_and_halt(Target.ResetType.SYSRESETREQ)
    require(target.get_state() == Target.State.HALTED, "target did not halt after reset")
    require(target.read_core_register("ipsr") == 0,
            "target is not in thread mode after reset")
    require(identify(target) == receipt["target"], "target identity changed after reset")
    progress.update("preflash_compare", 0, FLASH_SIZE, "bytes")
    post_reset_hash = require_backup_unchanged(target, backup, progress)
    receipt["precommitReset"] = {"type": "SYSRESETREQ", "halted": True,
                                  "ipsr": 0, "flashSha256": post_reset_hash}


def capture_flash_fault(target):
    """Read only bounded fault evidence; never resume or clear a faulted core."""
    evidence = {}
    try:
        state = target.get_state()
        evidence["state"] = state.name
    except Exception:
        evidence["state"] = "unavailable"
    if evidence["state"] == "HALTED":
        for name in ("pc", "lr", "sp", "msp", "psp", "xpsr", "ipsr", "control"):
            try:
                evidence[name] = f"0x{target.read_core_register(name) & 0xffffffff:08x}"
            except Exception:
                pass
    for name, address in (("dhcsr", 0xE000EDF0), ("cfsr", 0xE000ED28),
                          ("hfsr", 0xE000ED2C), ("dfsr", 0xE000ED30),
                          ("mmfar", 0xE000ED34), ("bfar", 0xE000ED38),
                          ("vtor", 0xE000ED08), ("flashSr", 0x40023C0C),
                          ("flashCr", 0x40023C10)):
        try:
            evidence[name] = f"0x{target.read32(address) & 0xffffffff:08x}"
        except Exception:
            pass
    return evidence


def subscribe_flash_progress(connection, progress):
    from pyocd.core.target import Target

    pass_name = {"value": "erase"}

    def on_event(notification):
        event = notification.event
        if event == Target.Event.PRE_FLASH_ERASE:
            pass_name["value"] = "erase"
        elif event == Target.Event.PRE_FLASH_PROGRAM:
            if pass_name["value"] != "program":
                progress.update("erase_program", 0, 1, "fraction",
                                "Programming pages", force=True)
            pass_name["value"] = "program"

    def on_fraction(amount):
        if not isinstance(amount, (int, float)) or not math.isfinite(amount):
            return
        fraction = min(1.0, max(0.0, amount))
        progress.update("erase_program", fraction, 1, "fraction",
                        "Erasing sectors" if pass_name["value"] == "erase"
                        else "Programming pages")

    connection.subscribe(on_event, (Target.Event.PRE_FLASH_ERASE,
                                    Target.Event.PRE_FLASH_PROGRAM))
    return on_fraction


def inspect(input_data, receipt, progress):
    progress.update("probe_discovery")
    probe = find_probe()
    progress.update("connecting")
    with session(probe, "cortex_m", input_data["operationDir"], False) as connection:
        progress.update("identifying")
        receipt["target"] = identify(connection.target)
        progress.update("backup_read_1", 0, FLASH_SIZE, "bytes")
        first = read_flash(connection.target, progress, "backup_read_1")
        progress.update("backup_read_2", 0, FLASH_SIZE, "bytes")
        second = read_flash(connection.target, progress, "backup_read_2")
    require(first == second, "two independent Flash backups differ")
    output = Path(input_data["operationDir"]) / "flash-backup.bin"
    atomic_bytes(output, first)
    receipt["backup"] = {"path": str(output), "sha256": sha256(first),
                         "bytes": len(first), "doubleReadMatch": True}
    progress.update("backup_saved")
    receipt["stage"] = "inspected"


def flash(input_data, receipt, progress):
    artifact = input_data["artifact"]
    data = Path(artifact["hexPath"]).read_bytes()
    require(sha256(data) == artifact["hexSha256"].lower(), "HEX SHA-256 mismatch")
    records = parse_hex(data)
    backup_data = Path(input_data["backup"]["path"]).read_bytes()
    require(len(backup_data) == FLASH_SIZE and
            sha256(backup_data) == input_data["backup"]["sha256"].lower(),
            "complete inspected Flash backup SHA-256 mismatch")
    defined, changes = compare_defined(records, backup_data)
    require(changes > 0, "new HEX already matches backup; refusing no-op flash")
    receipt["artifactSha256"] = sha256(data)
    receipt["backupSha256"] = sha256(backup_data)
    receipt["definedBytes"] = defined
    receipt["preflashDifferentBytes"] = changes
    receipt["programmingMode"] = {"erase": "sector", "smartFlash": False,
                                    "keepUnwritten": True}
    progress.update("probe_discovery")
    probe = find_probe()
    progress.update("connecting")
    with session(probe, "cortex_m", input_data["operationDir"], False) as connection:
        progress.update("identifying")
        receipt["target"] = identify(connection.target)
    progress.update("probe_discovery")
    probe = find_probe()
    progress.update("connecting")
    with session(probe, "stm32f429xg", input_data["operationDir"], False) as connection:
        identify(connection.target)
        progress.update("preflash_compare", 0, FLASH_SIZE, "bytes")
        receipt["preflashReadSha256"] = require_backup_unchanged(
            connection.target, backup_data, progress)
        prepare_flash_target(connection.target, backup_data, progress, receipt)
        from pyocd.flash.loader import MemoryLoader
        flash_progress = subscribe_flash_progress(connection, progress)
        loader = MemoryLoader(connection, progress=flash_progress,
                              chip_erase="sector", smart_flash=False,
                              trust_crc=False, keep_unwritten=True)
        for address, payload in coalesce_records(records):
            loader.add_data(address, payload)
        receipt["stage"] = "erase_or_program_started"
        atomic_json(Path(input_data["operationDir"]) / "phase.json",
                    {"operationId": receipt["operationId"],
                     "stage": receipt["stage"], "dangerous": True})
        progress.update("erase_program", 0, 1, "fraction", "Erasing sectors", force=True)
        try:
            loader.commit()
        except Exception:
            receipt["flashFault"] = capture_flash_fault(connection.target)
            raise
        receipt["stage"] = "programmed"
        progress.update("readback", 0, FLASH_SIZE, "bytes")
        readback = read_flash(connection.target, progress, "readback")
        programmed, mismatch = compare_defined(records, readback)
        receipt["readbackSha256"] = sha256(readback)
        receipt["readbackDefinedBytes"] = programmed
        receipt["readbackMismatchBytes"] = mismatch
        require(mismatch == 0, "programmed Flash readback differs from HEX")
        receipt["stage"] = "readback_verified"
        progress.update("reset")
        connection.target.reset()
        receipt["stage"] = "reset_and_exited"
        progress.update("finalizing")


def locate_serial_port():
    from serial.tools import list_ports
    found = [port.device for port in list_ports.comports()
             if port.vid == CDC_VID_PID[0] and port.pid == CDC_VID_PID[1]
             and (port.serial_number or "").upper() == CDC_SERIAL]
    require(len(found) == 1, "fixed board CDC port absent or ambiguous")
    return found[0]


def request_frame(nonce):
    require(len(nonce) == 16, "nonce length")
    body = b"FDQ1" + nonce
    return body + struct.pack("<I", zlib.crc32(body) & 0xFFFFFFFF)


def parse_response(frame, nonce, build_id):
    require(len(frame) == 100 and frame[:4] == b"FDR1", "response framing")
    require((zlib.crc32(frame[:96]) & 0xFFFFFFFF) == struct.unpack_from("<I", frame, 96)[0],
            "response CRC32")
    require(frame[4:20] == nonce and frame[20:52] == build_id and
            canonical_uid(frame[52:64]) == UID_CANONICAL,
            "stale or wrong response nonce, build ID or UID")
    flags, frames, errors, timeouts, display_errors, sysclk, pll48, uptime = struct.unpack_from("<8I", frame, 64)
    require(flags & 31 == 31 and sysclk == 168000000 and pll48 == 48000000,
            "firmware flags or clocks are invalid")
    return {"flags": flags, "cameraFrames": frames, "cameraErrors": errors,
            "cameraTimeouts": timeouts, "displayErrors": display_errors,
            "sysclkHz": sysclk, "pll48Hz": pll48, "uptimeMs": uptime}


def read_response(port, nonce, build_id, deadline):
    stream = bytearray()
    total = 0
    next_retry = time.monotonic() + 0.5
    while time.monotonic() < deadline and total < 512 * 1024:
        if time.monotonic() >= next_retry:
            require(port.write(request_frame(nonce)) == 24, "short CDC challenge write")
            next_retry = time.monotonic() + 0.5
        chunk = port.read(256)
        total += len(chunk)
        stream.extend(chunk)
        while True:
            pos = stream.find(b"FDR1")
            if pos < 0:
                del stream[:-3]
                break
            if pos:
                del stream[:pos]
            if len(stream) < 100:
                break
            frame = bytes(stream[:100])
            try:
                return {"decoded": parse_response(frame, nonce, build_id),
                        "responseHex": frame.hex(),
                        "receivedAtUtc": datetime.now(timezone.utc).isoformat()}
            except ValueError:
                del stream[0]
    raise ValueError("timed out waiting for bounded valid FDR1 response")


def verify(input_data, receipt, progress):
    import serial
    build_text = input_data["artifact"]["buildId"]
    require(bool(re.fullmatch(r"[0-9A-Fa-f]{64}", build_text)), "build ID must be 64 hex digits")
    build_id = bytes.fromhex(build_text)
    require(any(build_id), "all-zero build ID is not valid")
    progress.update("cdc_discovery")
    port_name = locate_serial_port()
    deadline = time.monotonic() + 12.0
    challenges = []
    with serial.Serial(port_name, baudrate=115200, timeout=0.05, write_timeout=1) as port:
        for index in range(2):
            progress.update("cdc_challenge_1" if index == 0 else "cdc_challenge_2")
            if index:
                time.sleep(min(0.3, max(0, deadline - time.monotonic())))
                require(time.monotonic() < deadline, "CDC verification deadline exceeded")
            # Drain stale GSFR and FDR1 traffic before issuing each independent challenge.
            port.reset_input_buffer()
            nonce = secrets.token_bytes(16)
            if challenges:
                require(nonce != bytes.fromhex(challenges[0]["nonceHex"]),
                        "CDC challenge nonce collision")
            require(port.write(request_frame(nonce)) == 24, "short CDC challenge write")
            response = read_response(port, nonce, build_id, deadline)
            challenges.append({"nonceHex": nonce.hex(), **response})
    first, second = (item["decoded"] for item in challenges)
    frames_delta = (second["cameraFrames"] - first["cameraFrames"]) & 0xFFFFFFFF
    uptime_delta = (second["uptimeMs"] - first["uptimeMs"]) & 0xFFFFFFFF
    require(0 < frames_delta < 0x80000000, "camera frames did not increase")
    require(0 < uptime_delta < 0x80000000, "firmware uptime did not increase")
    for field in ("cameraErrors", "cameraTimeouts", "displayErrors"):
        require(second[field] == first[field], field + " increased")
    receipt["verify"] = {"challenges": challenges, "first": first, "second": second,
                         "frameDelta": frames_delta, "uptimeDeltaMs": uptime_delta,
                         "expectedBuildId": build_text.lower(),
                         "expectedUid96": UID_CANONICAL,
                         "independentNonces": challenges[0]["nonceHex"] != challenges[1]["nonceHex"],
                         "deadlineSeconds": 12}
    receipt["stage"] = "cdc_verified"
    progress.update("finalizing")


def run(input_data):
    action = input_data.get("action")
    require(action in ("inspect", "flash", "verify"), "unknown worker action")
    require(bool(re.fullmatch(r"[0-9a-fA-F-]{36}", input_data.get("operationId", ""))),
            "invalid operation ID")
    directory = Path(input_data["operationDir"]).resolve(strict=True)
    require(directory.is_dir(), "operation directory absent")
    receipt = {"schemaVersion": 1, "action": action, "operationId": input_data["operationId"],
               "status": "failed", "stage": "preflight"}
    try:
        record_process_identity(input_data["operationId"], directory)
        progress = ProgressWriter(directory, input_data["operationId"], action)
        progress.update("preflight")
        if action == "inspect":
            inspect(input_data, receipt, progress)
        elif action == "flash":
            flash(input_data, receipt, progress)
        else:
            verify(input_data, receipt, progress)
        receipt["status"] = "succeeded"
    except Exception as error:
        receipt["status"] = ("unknown" if (directory / "phase.json").exists()
                             else "failed")
        receipt["error"] = type(error).__name__ + ": " + str(error)[:240]
    atomic_json(directory / "receipt.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--input")
    mode.add_argument("--check-exit")
    args = parser.parse_args()
    original_stdout = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        try:
            if args.check_exit:
                receipt = {"schemaVersion": 1, "kind": "process-exit-check",
                           "confirmed": check_exit_file(args.check_exit)}
            else:
                input_data = json.loads(Path(args.input).read_text(encoding="utf-8"))
                receipt = run(input_data)
        except Exception as error:
            if args.check_exit:
                receipt = {"schemaVersion": 1, "kind": "process-exit-check",
                           "confirmed": False}
            else:
                receipt = {"schemaVersion": 1, "status": "failed", "stage": "invocation",
                           "error": type(error).__name__ + ": " + str(error)[:240]}
    original_stdout.write(json.dumps(receipt, separators=(",", ":")) + "\n")
    if args.check_exit:
        return 0 if receipt["confirmed"] else 2
    return {"succeeded": 0, "failed": 2, "unknown": 3}[receipt["status"]]


if __name__ == "__main__":
    sys.exit(main())
