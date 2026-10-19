"""Synthetic parser/path refusal tests; not real conversion or hardware qualification."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / 'engineering/fz3b/tools/verify_pl_conversion.py'
TEST_ROOT = ROOT / 'output/hardware/2026-10-16-continuation/pl-conversion-verifier-tests'
TEST_ROOT.mkdir(parents=True, exist_ok=True)
BLOCKED = []
GUARD_ACTIVE = False


def audit(event, args):
    if not GUARD_ACTIVE:
        return
    if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system':
        BLOCKED.append(event)
        raise RuntimeError('Conversion tests prohibit network/process/device work')
    if event == 'import' and any(name in args[0].split('.') for name in ('serial', 'pyocd', 'paramiko', 'board_runtime', 'board_agent')):
        BLOCKED.append('import:' + args[0])
        raise RuntimeError('Conversion tests prohibit hardware/application imports')


sys.addaudithook(audit)
tool = None


def setUpModule():
    global GUARD_ACTIVE, tool
    GUARD_ACTIVE = True
    try:
        spec = importlib.util.spec_from_file_location('verify_pl_conversion_fixture_test', str(TOOL))
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
    except BaseException:
        GUARD_ACTIVE = False
        raise


def tearDownModule():
    global GUARD_ACTIVE
    GUARD_ACTIVE = False


def bit(payload=None, part=None, design='cnn_rtl_platform_wrapper;UserID=0XFFFFFFFF', date='2026/10/10', time='12:34:56'):
    if payload is None:
        payload = b'\xff' * 80 + tool.NATIVE_SYNC + bytes(range(44))
    fields = ((b'a', design), (b'b', part or tool.TARGET_PART), (b'c', date), (b'd', time))
    header = struct.pack('>H', len(tool.BIT_MAGIC)) + tool.BIT_MAGIC + b'\x00\x01'
    for tag, value in fields:
        data = value.encode('ascii') + b'\0'
        header += tag + struct.pack('>H', len(data)) + data
    return header + b'e' + struct.pack('>I', len(payload)) + payload


def triplet():
    data = bit()
    native = data[-128:]
    pcap = b''.join(native[index:index + 4][::-1] for index in range(0, len(native), 4))
    return {'cnn_rtl.bit': data, 'cnn_rtl.native.bin': native, 'cnn_rtl.pcap.bin': pcap}


def pins(files):
    return {name: (len(data), hashlib.sha256(data).hexdigest()) for name, data in files.items()}


class HeaderTests(unittest.TestCase):
    def test_exact_tlv_payload(self):
        parsed = tool.parse_bit(bit())
        self.assertEqual(parsed['payload_bytes'], 128)
        self.assertEqual(parsed['fields']['part'], tool.TARGET_PART)
        self.assertEqual(parsed['payload'][80:84], tool.NATIVE_SYNC)

    def test_truncations(self):
        data = bit()
        for end in (0, 1, 10, 12, 14, 20, len(data) - 1):
            with self.subTest(end=end), self.assertRaises(tool.ConversionError):
                tool.parse_bit(data[:end])

    def test_bad_magic_and_first_marker(self):
        for offset in (0, 2, 12):
            data = bytearray(bit()); data[offset] ^= 1
            with self.subTest(offset=offset), self.assertRaises(tool.ConversionError):
                tool.parse_bit(bytes(data))

    def test_wrong_order_or_duplicate_tag(self):
        data = bit()
        for tag in (b'b', b'e'):
            wrong = data[:13] + tag + data[14:]
            with self.subTest(tag=tag), self.assertRaises(tool.ConversionError):
                tool.parse_bit(wrong)

    def test_wrong_header_length(self):
        data = bit()
        for length in (0, 1, 1025, 65535):
            with self.subTest(length=length), self.assertRaises(tool.ConversionError):
                tool.parse_bit(data[:14] + struct.pack('>H', length) + data[16:])

    def test_missing_or_embedded_null(self):
        data = bit()
        length = struct.unpack_from('>H', data, 14)[0]
        for offset, value in ((16, 0), (16 + length - 1, 65)):
            wrong = bytearray(data); wrong[offset] = value
            with self.subTest(offset=offset), self.assertRaises(tool.ConversionError):
                tool.parse_bit(bytes(wrong))

    def test_device_design_date_time_refusals(self):
        for kwargs in ({'part': 'xczu9eg-ffvb1156-2-e'}, {'design': 'other_top'},
                       {'date': '2026/02/30'}, {'date': '26/10/10'}, {'time': '25:00:00'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(tool.ConversionError):
                tool.parse_bit(bit(**kwargs))

    def test_payload_extent_and_trailing_bytes(self):
        data = bit(); payload_tag = len(data) - 128 - 5
        for length in (0, 127, 132, 0xffffffff):
            wrong = data[:payload_tag + 1] + struct.pack('>I', length) + data[payload_tag + 5:]
            with self.subTest(length=length), self.assertRaises(tool.ConversionError):
                tool.parse_bit(wrong)
        with self.assertRaises(tool.ConversionError):
            tool.parse_bit(data + b'\0\0\0\0')

    def test_wrong_payload_tag_and_endianness(self):
        data = bit(); offset = len(data) - 128 - 5
        with self.assertRaises(tool.ConversionError):
            tool.parse_bit(data[:offset] + b'd' + data[offset + 1:])
        swapped = b''.join(data[-128:][i:i + 4][::-1] for i in range(0, 128, 4))
        with self.assertRaises(tool.ConversionError):
            tool.parse_bit(bit(payload=swapped))

    def test_type_and_size(self):
        for data in ('text', bytearray(bit()), b'x' * (tool.MAX_INPUT_BYTES + 1)):
            with self.subTest(kind=type(data).__name__), self.assertRaises(tool.ConversionError):
                tool.parse_bit(data)


class IdentityTests(unittest.TestCase):
    def test_synthetic_is_never_real_known_good(self):
        with self.assertRaises(tool.ConversionError):
            tool.validate_triplet(triplet())

    def test_synthetic_positive_uses_test_only_pin_patch(self):
        files = triplet()
        with mock.patch.dict(tool.KNOWN_FILES, pins(files), clear=True):
            result = tool.validate_triplet(files)
        self.assertTrue(result['complete_word_swap_verified'])
        self.assertFalse(result['hardware_validated'])
        self.assertFalse(result['new_bit_accepted'])
        self.assertFalse(result['bootgen_executed'])

    def test_wrong_sha_and_size_for_each_member(self):
        original = triplet()
        with mock.patch.dict(tool.KNOWN_FILES, pins(original), clear=True):
            for name in original:
                for replacement in (original[name] + b'x', original[name][:-1] + b'X'):
                    changed = dict(original); changed[name] = replacement
                    with self.subTest(name=name), self.assertRaises(tool.ConversionError):
                        tool.validate_triplet(changed)

    def test_swap_relationship_and_exact_payload_are_independent_checks(self):
        for name, offset in (('cnn_rtl.native.bin', 124), ('cnn_rtl.pcap.bin', 124)):
            changed = triplet(); value = bytearray(changed[name]); value[offset] ^= 1; changed[name] = bytes(value)
            with mock.patch.dict(tool.KNOWN_FILES, pins(changed), clear=True):
                with self.subTest(name=name), self.assertRaises(tool.ConversionError):
                    tool.validate_triplet(changed)

    def test_native_pcap_swapped_or_double_swapped_refused(self):
        for kind in ('both-swapped', 'pcap-native'):
            changed = triplet()
            if kind == 'both-swapped':
                changed['cnn_rtl.native.bin'], changed['cnn_rtl.pcap.bin'] = changed['cnn_rtl.pcap.bin'], changed['cnn_rtl.native.bin']
            else:
                changed['cnn_rtl.pcap.bin'] = changed['cnn_rtl.native.bin']
            with mock.patch.dict(tool.KNOWN_FILES, pins(changed), clear=True), self.assertRaises(tool.ConversionError):
                tool.validate_triplet(changed)

    def test_exact_members_and_byte_types(self):
        for changed in ({}, dict(triplet(), extra=b'x'), dict(triplet(), **{'cnn_rtl.bit': bytearray(bit())})):
            with self.assertRaises(tool.ConversionError):
                tool.validate_triplet(changed)


class PathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='fixture-', dir=str(TEST_ROOT))
        self.base = Path(self.temp.name)
        self.assertEqual(self.base.resolve().parent, TEST_ROOT.resolve())
        self.patch = mock.patch.object(tool, 'FIXTURE_ROOT', self.base)
        self.patch.start()
        self.folder = self.base / 'run-001'; self.folder.mkdir()
        self.files = triplet()
        for name, data in self.files.items():
            (self.folder / name).write_bytes(data)

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_fixed_directory_positive_with_test_only_pins(self):
        (self.folder / 'receipt.json').write_text('{"not_a_trust_anchor":true}')
        with mock.patch.dict(tool.KNOWN_FILES, pins(self.files), clear=True):
            result = tool.verify_run('run-001')
        self.assertEqual(result['fixture_run_id'], 'run-001')
        self.assertFalse(result['receipt_used_as_trust_anchor'])

    def test_run_id_rejects_remote_absolute_parent_and_shell_values(self):
        for value in ('../run-001', 'C:/x', '//host/share', '\\\\host\\share', 'sftp://host/x', '.', 'run/001', 'run;cmd', '-run', '', 'x' * 97):
            with self.subTest(value=value), self.assertRaises(tool.ConversionError):
                tool.verify_run(value)

    def test_extra_file_directory_and_missing_file(self):
        (self.folder / 'unknown').write_bytes(b'x')
        with self.assertRaises(tool.ConversionError): tool.verify_run('run-001')
        (self.folder / 'unknown').unlink()
        (self.folder / 'receipt.json').mkdir()
        with self.assertRaises(tool.ConversionError): tool.verify_run('run-001')
        (self.folder / 'receipt.json').rmdir()
        (self.folder / 'cnn_rtl.native.bin').unlink()
        with self.assertRaises(tool.ConversionError): tool.verify_run('run-001')

    def test_actual_files_cannot_bypass_real_length_pins(self):
        with self.assertRaises(tool.ConversionError): tool.verify_run('run-001')

    def test_file_hardlink_rejected(self):
        path = self.folder / 'cnn_rtl.bit'; copy = self.base / 'linked-bit'
        os.link(str(path), str(copy))
        with mock.patch.dict(tool.KNOWN_FILES, pins(self.files), clear=True), self.assertRaises(tool.ConversionError):
            tool.verify_run('run-001')

    def test_reparse_and_symlink_flags(self):
        for mode, flags in ((stat.S_IFLNK, 0), (stat.S_IFREG, 0x400)):
            fake = types.SimpleNamespace(st_mode=mode, st_file_attributes=flags)
            with mock.patch.object(Path, 'lstat', return_value=fake), self.assertRaises(tool.ConversionError):
                tool._no_link(self.folder)

    def test_optional_receipt_bound(self):
        (self.folder / 'receipt.json').write_bytes(b'x' * (256 * 1024 + 1))
        with self.assertRaises(tool.ConversionError): tool.verify_run('run-001')

    def test_cli_refuses_without_writing(self):
        output = io.StringIO()
        before = set(self.folder.iterdir())
        with contextlib.redirect_stdout(output):
            code = tool.main(['--run-id', 'run-001'])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())['result'], 'REFUSED')
        self.assertEqual(set(self.folder.iterdir()), before)

    def test_no_forbidden_operations(self):
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
