"""Fixed Challenger V1 lab CDC sample; never product T2/build identity evidence.

Only metadata and the first validated frame's SHA-256 are persisted. Opening the
CDC device and GSCT writes are active hardware operations. No probe is accessed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import secrets
import struct
import sys
import time
import zlib

ROOT = Path(__file__).resolve().parents[1]
USB_VID, USB_PID = 0x0483, 0x5740
USB_SERIAL = "326F32513133"
FORBIDDEN_PORT = "COM3"
HEADER = struct.Struct("<4sHHIIIIHHIIIII")
FRAME_BYTES = 153600
BUFFER_LIMIT = FRAME_BYTES + HEADER.size + 16384
SAMPLE_SECONDS = 10.0
HEARTBEAT_SECONDS = 0.5
CONTROL_TTL_SECONDS = 1.5
PARTIAL_TIMEOUT_SECONDS = 3.5


def validate_uid(value):
    if not re.fullmatch(r"[0-9a-fA-F]{24}", value):
        raise ValueError("expected UID must be three SWD words concatenated as 24 hex digits")
    value = value.lower()
    if value in ("0" * 24, "f" * 24):
        raise ValueError("blank UID is forbidden")
    return value


def select_port(ports):
    """Resolve the current COM name from the fixed USB identity; no fallback."""
    ports = list(ports)
    if any(p.serial_number == USB_SERIAL and (p.vid, p.pid) != (USB_VID, USB_PID)
           for p in ports):
        raise ValueError("selected USB serial has a mismatched VID/PID")
    candidates = [p for p in ports if (p.vid, p.pid) == (USB_VID, USB_PID)]
    if len(candidates) != 1:
        raise ValueError("exactly one STM32 CDC candidate is required")
    port = candidates[0]
    if port.serial_number != USB_SERIAL:
        raise ValueError("STM32 CDC USB serial does not match the fixed board")
    if not port.device or port.device.upper() == FORBIDDEN_PORT:
        raise ValueError("COM3 is reserved for fireDAP and must never be opened")
    return port.device


def encode_control(enabled, epoch, cookie):
    packet = struct.pack("<4sIIII", b"GSCT", int(enabled), 200, epoch, cookie)
    return packet + struct.pack("<I", zlib.crc32(packet))


def advances(current, previous):
    return 0 < ((current - previous) & 0xFFFFFFFF) < 0x80000000


class FrameDecoder:
    """Fail closed on malformed or foreign frames; retain no decoded pixels."""

    def __init__(self, uid, epoch):
        self.uid = validate_uid(uid)
        self.epoch = epoch
        self.buffer = bytearray()
        self.partial_since = None
        self.previous = None
        self.first_frame_sha256 = None

    def expire(self, now):
        if self.partial_since is not None and now - self.partial_since > PARTIAL_TIMEOUT_SECONDS:
            raise ValueError("partial GSFR frame timed out")

    def feed(self, data, now):
        self.expire(now)
        if len(self.buffer) + len(data) > BUFFER_LIMIT:
            raise ValueError("CDC input exceeds bounded frame buffer")
        self.buffer.extend(data)
        frames = []
        while self.buffer:
            if bytes(self.buffer[:min(4, len(self.buffer))]) != b"GSFR"[:min(4, len(self.buffer))]:
                raise ValueError("invalid GSFR magic")
            if len(self.buffer) < HEADER.size:
                break
            (magic, version, header_bytes, payload_bytes, frame_id, capture_ms,
             epoch, width, height, pixel_format, crc, *words) = HEADER.unpack_from(self.buffer)
            if (version, header_bytes, payload_bytes, width, height, pixel_format) != (
                    1, 48, FRAME_BYTES, 320, 240, 1):
                raise ValueError("invalid GSFR header or payload size")
            uid = "".join(f"{word:08x}" for word in words)
            if uid != self.uid or epoch != self.epoch:
                raise ValueError("GSFR UID or epoch mismatch")
            end = HEADER.size + payload_bytes
            if len(self.buffer) < end:
                break
            raw = memoryview(self.buffer)[HEADER.size:end]
            try:
                if zlib.crc32(raw) != crc:
                    raise ValueError("GSFR payload CRC mismatch")
                if self.previous is not None and not all(
                        advances(new, old) for new, old in zip((frame_id, capture_ms), self.previous)):
                    raise ValueError("GSFR frame id and capture time must both advance")
                if self.first_frame_sha256 is None:
                    self.first_frame_sha256 = hashlib.sha256(raw).hexdigest()
            finally:
                raw.release()
            self.previous = (frame_id, capture_ms)
            frames.append(dict(frameId=frame_id, captureMs=capture_ms, epoch=epoch,
                               uid=uid, payloadBytes=payload_bytes, payloadCrc32=f"{crc:08x}"))
            del self.buffer[:end]
            self.partial_since = None
        if self.buffer and self.partial_since is None:
            self.partial_since = now
        return frames


def sample(expected_uid, *, comports, serial_factory, monotonic=time.monotonic,
           randbits=secrets.randbits):
    """Dependency injection is exclusively for hardware-free tests."""
    expected_uid = validate_uid(expected_uid)
    epoch, cookie = (randbits(32) or 1), (randbits(32) or 1)
    decoder = FrameDecoder(expected_uid, epoch)
    evidence = dict(scope="external-lab-cdc-not-product-T2", result="failed",
                    startedAt=datetime.now(timezone.utc).isoformat(),
                    usbIdentity=dict(vid="0483", pid="5740", serial=USB_SERIAL),
                    expectedUid=expected_uid, epoch=epoch, cookie=cookie,
                    durationSeconds=SAMPLE_SECONDS, heartbeatMs=500, controlTtlMs=1500,
                    frames=[], firstFrameSha256=None, cameraImagesSaved=False,
                    limitations=["Only a 32-bit epoch is echoed by GSFR; it is not a 128-bit nonce.",
                                 "GSFR has no cookie echo or build ID; neither is verified.",
                                 "GSCT has no acknowledgement; stopping cannot be confirmed."],
                    shutdown=dict(disableAttempted=False, disableWriteCompleted=False,
                                  closed=False, acknowledgement="not-provable",
                                  expectedFallback="firmware control TTL expires after 1500ms without valid controls",
                                  ttlExpiryObserved=False))
    link = None
    last_control = None
    try:
        port = select_port(comports())
        evidence["port"] = port
        link = serial_factory(port=port, baudrate=115200, timeout=0.05,
                              write_timeout=0.25, rtscts=False, dsrdtr=False)
        link.reset_input_buffer()
        start = monotonic()
        deadline = start + SAMPLE_SECONDS
        next_control = start
        while True:
            now = monotonic()
            if now >= deadline:
                break
            if last_control is not None and now - last_control >= CONTROL_TTL_SECONDS:
                raise TimeoutError("host missed the 1500ms control TTL")
            if now >= next_control:
                packet = encode_control(True, epoch, cookie)
                if link.write(packet) != len(packet):
                    raise OSError("truncated GSCT enable write")
                last_control = monotonic()
                next_control = now + HEARTBEAT_SECONDS
            chunk = link.read(min(16384, max(1, link.in_waiting)))
            received_at = monotonic()
            if received_at > deadline:
                break
            evidence["frames"].extend(decoder.feed(chunk, received_at))
        evidence["elapsedSeconds"] = monotonic() - start
        if len(evidence["frames"]) < 2:
            raise ValueError("at least two validated advancing frames are required within 10 seconds")
        evidence["result"] = "passed"
    except Exception as error:
        evidence["error"] = f"{type(error).__name__}: {error}"
    finally:
        evidence["firstFrameSha256"] = decoder.first_frame_sha256
        evidence["validatedFrameCount"] = len(evidence["frames"])
        if link is not None:
            evidence["shutdown"]["disableAttempted"] = True
            try:
                packet = encode_control(False, epoch, cookie)
                if link.write(packet) != len(packet):
                    raise OSError("truncated GSCT disable write")
                evidence["shutdown"]["disableWriteCompleted"] = True
            except Exception as error:
                evidence["shutdown"]["disableError"] = f"{type(error).__name__}: {error}"
                evidence["result"] = "failed"
            finally:
                try:
                    link.close()
                    evidence["shutdown"]["closed"] = True
                except Exception as error:
                    evidence["shutdown"]["closeError"] = f"{type(error).__name__}: {error}"
                    evidence["result"] = "failed"
        decoder.buffer.clear()
        evidence["finishedAt"] = datetime.now(timezone.utc).isoformat()
    return evidence


def output_directory(value):
    output = Path(value).resolve()
    boundary = ROOT / "output" / "hardware"
    if output == boundary or not output.is_relative_to(boundary):
        raise ValueError("output must be a new subdirectory inside project output/hardware")
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-uid", required=True,
                        help="three SWD UID words concatenated as 24 hex digits")
    parser.add_argument("--output", required=True, help="new project output/hardware subdirectory")
    args = parser.parse_args(argv)
    uid = validate_uid(args.expected_uid)
    output = output_directory(args.output)
    output.mkdir(parents=True, exist_ok=False)
    import serial
    from serial.tools.list_ports import comports
    evidence = sample(uid, comports=comports, serial_factory=serial.Serial)
    (output / "evidence.json").write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps(evidence, indent=2))
    return 0 if evidence["result"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
