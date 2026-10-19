"""Pure lab CDC tests. No serial module import, port opening, or probes."""
import hashlib
import importlib.util
from pathlib import Path
import struct
from types import SimpleNamespace
import unittest
import zlib

spec = importlib.util.spec_from_file_location(
    "hardware_cdc_sample", Path(__file__).resolve().parents[1] / "scripts" / "hardware-cdc-sample.py")
cdc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cdc)
UID = "1234567890abcdef00112233"
EPOCH = 73
PIXELS = bytes(cdc.FRAME_BYTES)


def packet(frame_id=1, capture_ms=10, epoch=EPOCH, uid=UID, **overrides):
    fields = dict(magic=b"GSFR", version=1, header_bytes=48, payload_bytes=cdc.FRAME_BYTES,
                  frame_id=frame_id, capture_ms=capture_ms, epoch=epoch, width=320,
                  height=240, pixel_format=1, crc=zlib.crc32(PIXELS))
    fields.update(overrides)
    return cdc.HEADER.pack(*fields.values(), *(int(uid[n:n + 8], 16) for n in (0, 8, 16))) + PIXELS


def port(device="COM4", vid=0x0483, pid=0x5740, serial=cdc.USB_SERIAL):
    return SimpleNamespace(device=device, vid=vid, pid=pid, serial_number=serial)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class FakeLink:
    def __init__(self, clock, data=b"", read_error=False, disable_error=False):
        self.clock, self.data = clock, bytearray(data)
        self.read_error, self.disable_error = read_error, disable_error
        self.controls = []
        self.closed = self.reset = False

    @property
    def in_waiting(self):
        return len(self.data)

    def reset_input_buffer(self):
        self.reset = True

    def write(self, data):
        self.controls.append((self.clock.now, data))
        if self.disable_error and struct.unpack_from("<I", data, 4)[0] == 0:
            raise OSError("disable disconnected")
        return len(data)

    def read(self, count):
        self.clock.now += 0.05
        if self.read_error:
            raise OSError("disconnected")
        chunk = bytes(self.data[:count])
        del self.data[:count]
        return chunk

    def close(self):
        self.closed = True


class DecoderTests(unittest.TestCase):
    def decode(self, raw):
        decoder = cdc.FrameDecoder(UID, EPOCH)
        frames = []
        for index in range(0, len(raw), 4096):
            frames.extend(decoder.feed(raw[index:index + 4096], index / 1000000))
        return decoder, frames

    def test_fragmented_frames_and_hash(self):
        decoder, frames = self.decode(packet() + packet(2, 11))
        self.assertEqual(len(frames), 2)
        self.assertEqual(decoder.first_frame_sha256, hashlib.sha256(PIXELS).hexdigest())
        self.assertFalse(decoder.buffer)
        self.assertEqual(set(frames[0]), {"frameId", "captureMs", "epoch", "uid", "payloadBytes", "payloadCrc32"})

    def test_all_header_contracts_fail_closed(self):
        for field, value in (("magic", b"BAD!"), ("version", 2), ("header_bytes", 64),
                             ("payload_bytes", 0xFFFFFFFF), ("width", 240),
                             ("height", 320), ("pixel_format", 2), ("crc", 0)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.decode(packet(**{field: value}))

    def test_foreign_uid_and_stale_epoch(self):
        for raw in (packet(uid="a" * 24), packet(epoch=EPOCH - 1)):
            with self.assertRaises(ValueError):
                self.decode(raw)

    def test_both_counters_must_advance(self):
        for frame_id, ms in ((1, 10), (1, 11), (2, 10), (0, 11), (2, 9), (0x80000001, 11)):
            with self.subTest(frame_id=frame_id, ms=ms), self.assertRaises(ValueError):
                self.decode(packet() + packet(frame_id, ms))

    def test_counter_rollover(self):
        _, frames = self.decode(packet(0xFFFFFFFF, 0xFFFFFFFF) + packet(0, 0))
        self.assertEqual(len(frames), 2)

    def test_partial_and_oversized_input_are_bounded(self):
        decoder = cdc.FrameDecoder(UID, EPOCH)
        decoder.feed(b"G", 0)
        with self.assertRaises(ValueError):
            decoder.feed(b"", 3.51)
        with self.assertRaises(ValueError):
            cdc.FrameDecoder(UID, EPOCH).feed(bytes(cdc.BUFFER_LIMIT + 1), 0)


class IdentityTests(unittest.TestCase):
    def test_reenumerated_exact_device_and_firedap_excluded(self):
        self.assertEqual(cdc.select_port([port("COM19"), port("COM3", 0x1FC9, 0x5601, "probe")]), "COM19")

    def test_missing_multiple_foreign_and_wrong_vid_rejected(self):
        for ports in ([], [port(), port("COM8")], [port(serial="other")],
                      [port(vid=0x1FC9)], [port("COM3")],
                      [port(), port("COM8", serial="other")]):
            with self.subTest(ports=ports), self.assertRaises(ValueError):
                cdc.select_port(ports)

    def test_uid_validation_and_output_boundary(self):
        self.assertEqual(cdc.validate_uid(UID.upper()), UID)
        for uid in ("", "1" * 23, "g" * 24, "0" * 24, "f" * 24):
            with self.assertRaises(ValueError):
                cdc.validate_uid(uid)
        valid = cdc.ROOT / "output" / "hardware" / "pure-test-never-created"
        self.assertEqual(cdc.output_directory(str(valid)), valid.resolve())
        for invalid in (cdc.ROOT, cdc.ROOT / "output" / "hardware", cdc.ROOT / "output" / "hardware-other"):
            with self.assertRaises(ValueError):
                cdc.output_directory(str(invalid))


class SamplingTests(unittest.TestCase):
    def run_sample(self, data=b"", **options):
        clock = FakeClock()
        link = FakeLink(clock, data, **options)
        opened = []

        def factory(**kwargs):
            opened.append(kwargs)
            return link

        evidence = cdc.sample(UID, comports=lambda: [port()], serial_factory=factory,
                              monotonic=clock, randbits=lambda _: EPOCH)
        return evidence, link, opened

    def test_success_ten_seconds_heartbeats_and_no_pixels_saved(self):
        evidence, link, opened = self.run_sample(packet() + packet(2, 11))
        self.assertEqual(evidence["result"], "passed")
        self.assertGreaterEqual(evidence["elapsedSeconds"], 10)
        self.assertLess(evidence["elapsedSeconds"], 10.1)
        self.assertEqual(evidence["validatedFrameCount"], 2)
        self.assertEqual(opened[0]["port"], "COM4")
        self.assertEqual(opened[0]["timeout"], 0.05)
        controls = link.controls
        for _, command in controls:
            self.assertEqual(command[:4], b"GSCT")
            self.assertEqual(len(command), 24)
            self.assertEqual(struct.unpack_from("<I", command, 20)[0], zlib.crc32(command[:20]))
        self.assertTrue(all(0.5 <= b[0] - a[0] < 0.56 for a, b in zip(controls[:-2], controls[1:-1])))
        self.assertEqual(struct.unpack_from("<I", controls[-1][1], 4)[0], 0)
        self.assertTrue(link.closed and link.reset)
        self.assertEqual(evidence["shutdown"]["acknowledgement"], "not-provable")
        self.assertFalse(evidence["shutdown"]["ttlExpiryObserved"])
        self.assertFalse(evidence["cameraImagesSaved"])

    def test_missing_second_frame_and_disconnect_close_and_disable(self):
        for data, options in ((packet(), {}), (b"", {"read_error": True}),
                              (packet(crc=0), {}), (packet(epoch=2), {})):
            with self.subTest(options=options):
                evidence, link, _ = self.run_sample(data, **options)
                self.assertEqual(evidence["result"], "failed")
                self.assertTrue(evidence["shutdown"]["disableAttempted"])
                self.assertTrue(link.closed)

    def test_disable_failure_still_closes(self):
        evidence, link, _ = self.run_sample(packet() + packet(2, 11), disable_error=True)
        self.assertEqual(evidence["result"], "failed")
        self.assertIn("disableError", evidence["shutdown"])
        self.assertTrue(link.closed)

    def test_bad_identity_never_opens_port(self):
        def forbidden_factory(**kwargs):
            self.fail("identity rejection must precede port open")

        evidence = cdc.sample(UID, comports=lambda: [port("COM3")], serial_factory=forbidden_factory)
        self.assertEqual(evidence["result"], "failed")
        self.assertFalse(evidence["shutdown"]["disableAttempted"])


if __name__ == "__main__":
    unittest.main()
