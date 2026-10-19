"""Offline export fixtures; never open a board path."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'export_known_good_pl.py'
spec = importlib.util.spec_from_file_location('export_known_good_pl', PATH)
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class ExportTests(unittest.TestCase):
    def fixture(self):
        parts = [('one.bin', '/root/fixed/one.bin', b'one'),
                 ('two.bin', '/root/fixed/two.bin', b'two'),
                 ('three.bin', '/root/fixed/three.bin', b'three')]
        records = tuple((name, path, len(data), digest(data)) for name, path, data in parts)
        data = {path: value for _, path, value in parts}
        reads = []

        def reader(path, length, deadline):
            reads.append(path)
            return data[path]

        return records, data, reads, reader

    def test_all_three_verified_before_bounded_payload(self):
        records, data, reads, reader = self.fixture()
        with mock.patch.object(export, 'ARTIFACTS', records):
            result = json.loads(export.prepare(reader=reader))
        self.assertEqual(reads, [record[1] for record in records])
        self.assertEqual(result['scope'], 'fz3b-known-good-pl-readonly')
        self.assertTrue(result['readOnly'])
        self.assertFalse(result['deployed'])
        self.assertEqual([entry['name'] for entry in result['entries']],
                         [record[0] for record in records])

    def test_hash_or_length_mismatch_emits_no_payload(self):
        records, data, reads, reader = self.fixture()
        data[records[-1][1]] = b'longer'
        with mock.patch.object(export, 'ARTIFACTS', records):
            with self.assertRaisesRegex(export.ExportError, 'fixed-file-size-mismatch'):
                export.prepare(reader=reader)
        self.assertEqual(len(reads), 3)
        records, data, reads, reader = self.fixture()
        data[records[-1][1]] = b'WRONG'
        with mock.patch.object(export, 'ARTIFACTS', records):
            with self.assertRaisesRegex(export.ExportError, 'fixed-file-hash-mismatch'):
                export.prepare(reader=reader)

    def test_output_bound_and_argument_rejection(self):
        records, data, reads, reader = self.fixture()
        with mock.patch.object(export, 'ARTIFACTS', records), \
             mock.patch.object(export, 'MAX_OUTPUT', 10):
            with self.assertRaisesRegex(export.ExportError, 'output-size-or-deadline'):
                export.prepare(reader=reader)
        with mock.patch.object(export, 'prepare', side_effect=AssertionError('no board read')):
            with self.assertRaises(SystemExit):
                export.main(['--path', '/dev/mem'])

    def test_fixed_paths_and_no_application_or_device_calls(self):
        self.assertEqual(len(export.ARTIFACTS), 3)
        self.assertEqual([item[0] for item in export.ARTIFACTS],
                         ['cnn_rtl.bit', 'cnn_rtl.native.bin', 'cnn_rtl.pcap.bin'])
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('import socket', source)
        self.assertNotIn('import vision_app', source)
        self.assertNotIn('/dev/', source)
        self.assertNotIn('subprocess', source)

    def test_nofollow_regular_single_link_and_descriptor_cleanup(self):
        for mode, links in ((stat.S_IFREG, 2), (stat.S_IFLNK, 1), (stat.S_IFCHR, 1)):
            prior = SimpleNamespace(st_mode=mode, st_nlink=links, st_size=3)
            with mock.patch.object(export.os, 'O_DIRECTORY', 65536, create=True), \
                 mock.patch.object(export.os, 'O_NOFOLLOW', 131072, create=True), \
                 mock.patch.object(export.os, 'O_NONBLOCK', 2048, create=True), \
                 mock.patch.object(export.os, 'open', side_effect=[71, 72]) as opened, \
                 mock.patch.object(export.os, 'stat', return_value=prior) as observed, \
                 mock.patch.object(export.os, 'fstat') as post_open, \
                 mock.patch.object(export.os, 'close') as closed:
                with self.assertRaisesRegex(export.ExportError, 'fixed-file-type-or-size-mismatch'):
                    export.read_exact('/root/one.bin', 3, 9999999999)
            self.assertTrue(all(call.args[1] & 131072 for call in opened.call_args_list))
            self.assertFalse(observed.call_args.kwargs['follow_symlinks'])
            post_open.assert_not_called()
            self.assertEqual(closed.call_args_list, [mock.call(71), mock.call(72)])

    def test_preopen_and_postopen_identity_must_match(self):
        prior = SimpleNamespace(st_mode=stat.S_IFREG, st_nlink=1, st_size=3,
                                st_dev=1, st_ino=11, st_mtime_ns=1, st_ctime_ns=1,
                                st_mtime=1, st_ctime=1)
        after = SimpleNamespace(st_mode=stat.S_IFREG, st_nlink=1, st_size=3,
                                st_dev=1, st_ino=12, st_mtime_ns=1, st_ctime_ns=1,
                                st_mtime=1, st_ctime=1)
        with mock.patch.object(export.os, 'O_DIRECTORY', 65536, create=True), \
             mock.patch.object(export.os, 'O_NOFOLLOW', 131072, create=True), \
             mock.patch.object(export.os, 'O_NONBLOCK', 2048, create=True), \
             mock.patch.object(export.os, 'open', side_effect=[71, 72, 73]), \
             mock.patch.object(export.os, 'stat', return_value=prior), \
             mock.patch.object(export.os, 'fstat', return_value=after), \
             mock.patch.object(export.os, 'read') as read, \
             mock.patch.object(export.os, 'close') as closed:
            with self.assertRaisesRegex(export.ExportError, 'fixed-file-type-or-size-mismatch'):
                export.read_exact('/root/one.bin', 3, 9999999999)
        read.assert_not_called()
        self.assertEqual(closed.call_args_list, [mock.call(71), mock.call(72), mock.call(73)])


if __name__ == '__main__':
    unittest.main()
