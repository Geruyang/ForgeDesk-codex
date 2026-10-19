"""Pure offline tests. No SSH, APP connection, Linux device, or journal changes."""
import importlib.util
import io
from pathlib import Path
import stat
import sys
import types
import unittest
from unittest.mock import patch

if sys.platform == 'win32':
    sys.modules.setdefault('fcntl', types.SimpleNamespace())
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('reconciliation_test_remote', str(ROOT / 'remote.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
exec(compile((ROOT / 'reconciliation.py').read_bytes(), 'reconciliation.py', 'exec'), worker.__dict__)


class ReconciliationTests(unittest.TestCase):
    def request(self):
        return {'schemaVersion': 1, 'action': 'reconcile_inspect', 'id': 'new-reconciliation', 'originalOperationId': 'old-inspect',
                'nonce': 'a' * 64, 'contextSha256': 'b' * 64, 'profileSha256': 'c' * 64}

    def run_clean(self, **changes):
        defaults = {'metadata': {'bootId': worker.BOOT}, 'idle_scan': {'deviceOwners': [], 'controlConnections': 0},
                    'stdin_inspectors': [], 'readonly_journal_scan': 0}
        defaults.update(changes)
        with patch.multiple(worker, **{name: unittest.mock.DEFAULT for name in defaults}) as mocks, patch.object(worker.time, 'sleep'):
            for name, value in defaults.items():
                mocks[name].return_value = value
            return worker.reconcile_readonly(self.request())

    def test_clean_proof_is_two_readonly_scans_without_protocol_or_journal_write(self):
        with patch.object(worker, 'acquire_journal', side_effect=AssertionError('not read-only')), patch.object(worker, 'write_journal', side_effect=AssertionError('not read-only')):
            answer = self.run_clean()
        self.assertTrue(answer['remote']['readOnly'])
        self.assertEqual(answer['remote']['scanCount'], 2)
        self.assertTrue(answer['remote']['originalInspectorAbsent'])

    def test_any_device_owner_blocks(self):
        with self.assertRaisesRegex(ValueError, 'not-quiescent'):
            self.run_clean(idle_scan={'deviceOwners': [123], 'controlConnections': 0})

    def test_any_stdin_inspector_blocks(self):
        with self.assertRaisesRegex(ValueError, 'not-quiescent'):
            self.run_clean(stdin_inspectors=[456])

    def test_any_unfinished_journal_blocks(self):
        with self.assertRaisesRegex(ValueError, 'not-quiescent'):
            self.run_clean(readonly_journal_scan=1)

    def test_inspector_scan_detects_stdin_and_c_but_excludes_self_and_module_service(self):
        commands = {'11': b'/usr/bin/python3\0-B\0-\0', '12': b'python3.6\0-c\0anything\0',
                    '13': b'/usr/bin/python3\0-m\0vision_app.board_agent\0'}
        with patch.object(worker.os, 'listdir', return_value=['self', '10', '11', '12', '13']), patch.object(worker.os, 'getpid', return_value=10), patch.object(worker, 'proc_is_inspector', side_effect=lambda pid: worker.stdin_from_prefix(lambda stream=io.BytesIO(commands[str(pid)]): stream.read(1))):
            self.assertEqual(worker.stdin_inspectors(), [11, 12])

    def test_incomplete_proc_scan_raises_not_false_clean(self):
        with patch.object(worker.os, 'listdir', return_value=['11']), patch.object(worker.os, 'getpid', return_value=10), patch.object(worker, 'proc_is_inspector', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                worker.stdin_inspectors()

    def test_missing_journal_is_readonly_and_not_created(self):
        with patch.object(worker.os, 'lstat', side_effect=FileNotFoundError()), patch.object(worker.os, 'open') as opened:
            self.assertEqual(worker.readonly_journal_scan(), 0)
            opened.assert_not_called()

    def test_linked_journal_is_rejected(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o700, st_uid=0)
        with patch.object(worker.os, 'lstat', return_value=info):
            with self.assertRaisesRegex(ValueError, 'untrusted'):
                worker.readonly_journal_scan()

    def test_c_body_and_module_or_script_arguments_are_not_read(self):
        for raw, expected, maximum in [(b'python3\0-c\0SECRET_BODY\0', True, 11),
                                       (b'/usr/bin/python3\0-B\0-m\0private.module\0', False, 23),
                                       (b'python3\0/root/private-script\0SECRET_ARGS\0', False, 11),
                                       (b'python3\0-B\0-\0SECRET_STDIN_IS_NOT_ARGV\0', True, 13)]:
            stream = io.BytesIO(raw)
            self.assertEqual(worker.stdin_from_prefix(lambda: stream.read(1)), expected)
            self.assertLessEqual(stream.tell(), maximum)

    def test_unknown_python_flags_are_fail_closed_without_reading_payload(self):
        stream = io.BytesIO(b'python3\0-u\0-c\0SECRET_BODY\0')
        with self.assertRaisesRegex(ValueError, 'unknown-python-prefix'):
            worker.stdin_from_prefix(lambda: stream.read(1))
        self.assertLessEqual(stream.tell(), 11)


if __name__ == '__main__':
    unittest.main()
