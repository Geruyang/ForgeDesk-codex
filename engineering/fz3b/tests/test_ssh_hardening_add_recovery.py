"""Offline-only recovery-key transaction tests; no SSH or board writes."""
import ast
import base64
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'ssh_hardening_add_recovery.py'
PUB = Path(__file__).resolve().parents[3] / '.runtime/fz3b-private/fz3b_recovery_ed25519.pub'
spec = importlib.util.spec_from_file_location('ssh_hardening_add_recovery', PATH)
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


def sha(value):
    return hashlib.sha256(value).hexdigest()


class RecoveryTests(unittest.TestCase):
    def original_fixture(self):
        blob = b'fixture-project-public-blob'
        line = b'ssh-ed25519 ' + base64.b64encode(blob) + b' fixture-project\n'
        patches = (mock.patch.object(stage, 'AUTHORIZED_BYTES', len(line)),
                   mock.patch.object(stage, 'AUTHORIZED_SHA256', sha(line)),
                   mock.patch.object(stage, 'PROJECT_BLOB_SHA256', sha(blob)))
        return line, patches

    def test_local_public_file_matches_pinned_recovery_only(self):
        self.assertEqual(PUB.read_bytes().strip(), stage.RECOVERY_LINE)
        self.assertEqual(stage._blob_sha(stage.RECOVERY_LINE), stage.RECOVERY_BLOB_SHA256)
        self.assertEqual(stage.RECOVERY_BLOB_SHA256,
                         '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80')

    def test_candidate_preserves_every_original_byte_then_adds_one_key(self):
        original, patches = self.original_fixture()
        with patches[0], patches[1], patches[2]:
            candidate = stage.planned_bytes(original)
        self.assertTrue(candidate.startswith(original))
        self.assertEqual(candidate[len(original):], stage.RECOVERY_LINE + b'\n')
        self.assertEqual(len(candidate.splitlines()), 2)

    def test_missing_trailing_newline_is_added_without_changing_original(self):
        original, patches = self.original_fixture()
        original = original[:-1]
        with mock.patch.object(stage, 'AUTHORIZED_BYTES', len(original)), \
             mock.patch.object(stage, 'AUTHORIZED_SHA256', sha(original)), patches[2]:
            candidate = stage.planned_bytes(original)
        self.assertEqual(candidate, original + b'\n' + stage.RECOVERY_LINE + b'\n')

    def test_preimage_or_recovery_pin_change_refuses_candidate(self):
        original, patches = self.original_fixture()
        with patches[0], patches[1], patches[2]:
            with self.assertRaisesRegex(ValueError, 'authorized-preimage-mismatch'):
                stage.planned_bytes(original + b'changed')
            with mock.patch.object(stage, 'RECOVERY_BLOB_SHA256', '0' * 64):
                with self.assertRaisesRegex(ValueError, 'recovery-public-key-pin-mismatch'):
                    stage.planned_bytes(original)

    def test_transaction_orders_backup_before_atomic_replace_and_no_reload(self):
        original, patches = self.original_fixture()
        info = SimpleNamespace(st_dev=1, st_ino=2, st_size=len(original),
                               st_mtime_ns=3, st_ctime_ns=4)
        events = []
        expected_candidate = original + stage.RECOVERY_LINE + b'\n'

        def directory(parts):
            return 10 if parts[0] == 'root' else 20

        def snapshot(directory, name, size, digest, mode):
            events.append(('snapshot', name, digest, mode))
            if name == 'sshd_config':
                return b'fixture-config', info
            if name == 'authorized_keys' and digest == sha(expected_candidate):
                return expected_candidate, info
            return original, info

        def write(directory, name, data):
            events.append(('write', name, data))

        with patches[0], patches[1], patches[2], \
             mock.patch.object(stage, '_directory', side_effect=directory), \
             mock.patch.object(stage, '_snapshot', side_effect=snapshot), \
             mock.patch.object(stage, '_write_exclusive', side_effect=write), \
             mock.patch.object(stage.os, 'stat', return_value=info), \
             mock.patch.object(stage.os, 'replace', side_effect=lambda *args, **kwargs: events.append(('replace', args))), \
             mock.patch.object(stage.os, 'fsync', side_effect=lambda fd: events.append(('fsync', fd))), \
             mock.patch.object(stage.os, 'close'):
            result = stage.run('169.254.142.174 51000 169.254.220.254 22')
        self.assertEqual(result['authorizedSha256'], sha(expected_candidate))
        self.assertFalse(result['sshdReloaded'])
        self.assertFalse(result['independentRecoveryLoginVerified'])
        self.assertLess(events.index(('write', stage.BACKUP, original)),
                        next(index for index, event in enumerate(events) if event[0] == 'replace'))
        self.assertEqual([event[1] for event in events if event[0] == 'write'],
                         [stage.BACKUP, stage.STAGE])

    def test_fsync_after_replace_failure_never_returns_success(self):
        original, patches = self.original_fixture()
        info = SimpleNamespace(st_dev=1, st_ino=2, st_size=len(original),
                               st_mtime_ns=3, st_ctime_ns=4)
        replaced = []
        def fsync(fd):
            if replaced:
                raise OSError('post-replace-fsync-unknown')
        with patches[0], patches[1], patches[2], \
             mock.patch.object(stage, '_directory', side_effect=[10, 20]), \
             mock.patch.object(stage, '_snapshot', return_value=(original, info)), \
             mock.patch.object(stage, '_write_exclusive'), \
             mock.patch.object(stage.os, 'stat', return_value=info), \
             mock.patch.object(stage.os, 'replace', side_effect=lambda *a, **k: replaced.append(True)), \
             mock.patch.object(stage.os, 'fsync', side_effect=fsync), \
             mock.patch.object(stage.os, 'close'):
            with self.assertRaisesRegex(OSError, 'post-replace-fsync-unknown'):
                stage.run('169.254.142.174 51000 169.254.220.254 22')
        self.assertTrue(replaced)

    def test_static_scope_and_python36(self):
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('/etc/shadow', source)
        self.assertNotIn('ssh_host_ed25519_key', source)
        self.assertNotIn('systemctl', source)
        self.assertNotIn('sshd -', source)
        with mock.patch.object(stage, 'run', side_effect=AssertionError('no writes')):
            with self.assertRaises(SystemExit):
                stage.main(['--retry'])


if __name__ == '__main__':
    unittest.main()
