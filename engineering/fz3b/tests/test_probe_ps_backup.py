"""Offline fixtures only: no target filesystem, service, SSH or device access."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import types
import unittest
from unittest import mock


PROJECT = Path(__file__).resolve().parents[3]
SOURCE = PROJECT / 'engineering/fz3b/tools/probe_ps_backup.py'
SPEC = importlib.util.spec_from_file_location('fixed_ps_backup_probe', SOURCE)
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
EXECUTION = PROJECT / 'output/hardware/2026-10-16-continuation/live-plan/ps-security-1792122514610/execution.json'


def execution_deploy():
    document = json.loads(EXECUTION.read_text(encoding='utf-8'))
    phases = [phase for phase in document['phases'] if phase['phase'] == 'deploy']
    if len(phases) != 1 or phases[0]['receipt']['observation']['status'] != 'deployed':
        raise AssertionError('fixture must use one actual successful deployment')
    return phases[0]['receipt']['observation']


class FakeReader(object):
    def __init__(self):
        observed = execution_deploy()
        self.raw_manifest = P.canonical_json(observed['manifest'])
        self.files, self.reads = {}, []
        self.absent = True
        self.closed = False
        self.on_read = None
        for index, entry in enumerate(observed['manifest']['entries']):
            self.files[P.APP + '/' + entry['path']] = {
                'sha256': entry['new_sha256'], 'bytes': index + 100,
                'mode': entry['mode'], 'uid': entry['uid'], 'gid': entry['gid'],
                'stamp': (1, index + 10, 0)}
            if entry['backup'] is not None:
                self.files[P.BACKUP_ROOT + '/' + entry['backup']] = {
                    'sha256': entry['old_sha256'], 'bytes': index + 50,
                    'mode': 0o600, 'uid': 0, 'gid': 0, 'stamp': (1, index + 30, 0)}

    def manifest(self):
        self.reads.append(P.MANIFEST_PATH)
        return self.raw_manifest

    def hash_file(self, path):
        self.reads.append(path)
        if self.on_read:
            self.on_read(self, path)
        return copy.deepcopy(self.files[path])

    def absent_new_original(self):
        self.reads.append(P.NEW_FILE_BACKUP)
        if not self.absent:
            raise P.ProbeError('new-file-original-backup-must-be-absent')
        return True

    def assert_directories(self):
        pass

    def close(self):
        self.closed = True


class BackupProbeTests(unittest.TestCase):
    def test_constants_match_successful_local_execution_not_self_attestation(self):
        observed = execution_deploy()
        self.assertEqual(P.RUN_ID, observed['run_id'])
        self.assertEqual(P.BACKUP_ROOT, observed['backup_directory'])
        self.assertEqual(P.MANIFEST_SHA256, observed['manifest_sha256'])
        self.assertEqual(P.MANIFEST_SHA256, hashlib.sha256(P.canonical_json(observed['manifest'])).hexdigest())
        self.assertEqual(observed['manifest'], P.expected_manifest())

    def test_pass_is_readability_not_actual_recovery(self):
        reader = FakeReader()
        result = P.probe(lambda: reader)
        self.assertEqual('passed-backup-readable-hash-consistency', result['result'], result)
        self.assertEqual(6, len(result['files']))
        self.assertFalse(result['rollbackAttempted'])
        self.assertFalse(result['actualRecoveryVerified'])
        self.assertFalse(result['historicalAbsenceIndependentlyRecreated'])
        for key in ('serviceQueried', 'subprocessStarted', 'applicationImported',
                    'authenticationFilesRead', 'deviceOpened', 'networkAccessed'):
            self.assertFalse(result[key])
        self.assertTrue(reader.closed)
        self.assertEqual(set(P.HASH_PATHS + (P.MANIFEST_PATH, P.NEW_FILE_BACKUP)), set(reader.reads))
        self.assertEqual(2 * len(P.HASH_PATHS) + 5, len(reader.reads))
        self.assertNotIn('stamp', json.dumps(result))

    def test_every_current_and_backup_hash_is_required(self):
        for path in P.HASH_PATHS:
            reader = FakeReader()
            reader.files[path]['sha256'] = '0' * 64
            result = P.probe(lambda: reader)
            self.assertEqual('blocked', result['result'], path)

    def test_current_or_backup_missing_is_blocked(self):
        for path in P.HASH_PATHS:
            reader = FakeReader()
            del reader.files[path]
            self.assertEqual('blocked', P.probe(lambda: reader)['result'])

    def test_permissions_owner_and_gid_are_bound(self):
        for path in P.HASH_PATHS:
            for key, value in (('mode', 0o664), ('uid', 1000), ('gid', 1000)):
                reader = FakeReader()
                reader.files[path][key] = value
                self.assertEqual('blocked', P.probe(lambda: reader)['result'])

    def test_new_image_historical_absence_and_current_presence_are_distinct(self):
        reader = FakeReader()
        reader.absent = False
        self.assertEqual('blocked', P.probe(lambda: reader)['result'])
        reader = FakeReader()
        del reader.files[P.APP + '/vision_app/image_boundary.py']
        self.assertEqual('blocked', P.probe(lambda: reader)['result'])
        result = P.probe(FakeReader)
        image = result['files'][2]
        self.assertTrue(image['originalAbsenceRecorded'])
        self.assertTrue(image['originalBackupAbsentNow'])
        self.assertNotIn('originalBackup', image)

    def test_tampered_or_other_run_manifest_is_blocked_before_file_reads(self):
        for mutate in (lambda value: value.update(run_id='other-run'),
                       lambda value: value.update(app='/root/other'),
                       lambda value: value['entries'][0].update(backup='../elsewhere'),
                       lambda value: value['entries'][2].update(old_sha256='0' * 64),
                       lambda value: value.update(extra='SECRET-MUST-NOT-BE-EMITTED')):
            reader = FakeReader()
            value = json.loads(reader.raw_manifest.decode('ascii'))
            mutate(value)
            reader.raw_manifest = P.canonical_json(value)
            result = P.probe(lambda: reader)
            self.assertEqual('blocked', result['result'])
            self.assertEqual([P.MANIFEST_PATH], reader.reads)
            self.assertNotIn('SECRET-MUST-NOT-BE-EMITTED', json.dumps(result))

    def test_schema_is_strict_independent_of_manifest_digest(self):
        reader = FakeReader()
        value = json.loads(reader.raw_manifest.decode('ascii'))
        value['schema'] = True
        raw = P.canonical_json(value)
        with mock.patch.object(P, 'MANIFEST_SHA256', P.sha256(raw)):
            with self.assertRaisesRegex(P.ProbeError, 'schema'):
                P.validate_manifest(raw)

    def test_duplicate_json_and_nonfinite_are_rejected(self):
        for raw in (b'{"schema":1,"schema":1}', b'{"schema":NaN}'):
            with mock.patch.object(P, 'MANIFEST_SHA256', P.sha256(raw)):
                with self.assertRaises(P.ProbeError):
                    P.validate_manifest(raw)

    def test_manifest_size_bound_is_checked_before_decode(self):
        with self.assertRaises(P.ProbeError):
            P.validate_manifest(b'\xff' * (P.MAX_MANIFEST_BYTES + 1))

    def test_second_pass_detects_inode_change_even_with_matching_bytes(self):
        reader = FakeReader()
        target = P.APP + '/vision_app/camera.py'
        count = [0]
        def change(access, path):
            if path == target:
                count[0] += 1
                if count[0] == 2:
                    access.files[path]['stamp'] = (9, 99, 99)
        reader.on_read = change
        result = P.probe(lambda: reader)
        self.assertEqual('blocked', result['result'])
        self.assertIn('between-verification', result['error'])

    def test_final_manifest_change_does_not_report_pass(self):
        reader = FakeReader()
        calls = [0]
        def manifest():
            calls[0] += 1
            return reader.raw_manifest if calls[0] < 3 else b'{}'
        reader.manifest = manifest
        self.assertEqual('blocked', P.probe(lambda: reader)['result'])

    def test_close_error_blocks_success(self):
        reader = FakeReader()
        reader.close = mock.Mock(side_effect=OSError('fd error'))
        self.assertEqual('blocked', P.probe(lambda: reader)['result'])

    def test_no_cli_override_and_python36_standalone_imports(self):
        with mock.patch.object(P.sys, 'argv', ['-', '--root', '/elsewhere']), \
                mock.patch.object(P, 'probe', side_effect=AssertionError('must not run')), \
                mock.patch('builtins.print') as printed:
            self.assertEqual(1, P.main())
            self.assertIn('no-arguments', printed.call_args[0][0])
        parsed = ast.parse(SOURCE.read_text(encoding='utf-8'), feature_version=(3, 6))
        imports = set()
        for node in ast.walk(parsed):
            if isinstance(node, ast.Import):
                imports.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imports.add(node.module)
        self.assertEqual({'__future__', 'sys', 'hashlib', 'json', 'os', 'stat'}, imports)


class SafeReadPrimitiveTests(unittest.TestCase):
    @staticmethod
    def info(mode=stat.S_IFREG | 0o600, size=3):
        return types.SimpleNamespace(st_mode=mode, st_nlink=1, st_uid=0, st_gid=0,
                                     st_size=size, st_dev=1, st_ino=2, st_mtime_ns=3, st_ctime_ns=4)

    def reader(self):
        reader = object.__new__(P.FixedReader)
        reader.fds, reader.anchors = [], []
        reader.parents = {P.BACKUP_ROOT: 7, P.APP: 8, P.APP + '/vision_app': 9}
        reader.assert_directories = mock.Mock()
        return reader

    def flags(self):
        return mock.patch.multiple(P.os, O_DIRECTORY=0x10000, O_NOFOLLOW=0x20000,
                                   O_NONBLOCK=0x800, O_NOATIME=0x40000, create=True)

    def test_directory_opens_are_readonly_dirfd_nofollow_noatime(self):
        reader = self.reader()
        value = self.info(stat.S_IFDIR | 0o700)
        with self.flags(), mock.patch.object(P.os, 'open', return_value=123) as opened, \
                mock.patch.object(P.os, 'fstat', return_value=value):
            reader._directory('fixed', 7)
            opened.assert_called_once_with('fixed', P.os.O_RDONLY | P.os.O_DIRECTORY | P.os.O_NOFOLLOW
                                           | P.os.O_NONBLOCK | P.os.O_NOATIME, dir_fd=7)

    def test_file_read_is_bounded_readonly_nofollow_singlelink_and_hashed(self):
        reader = self.reader()
        value = self.info()
        with self.flags(), mock.patch.object(P.os, 'open', return_value=123) as opened, \
                mock.patch.object(P.os, 'fstat', return_value=value), \
                mock.patch.object(P.os, 'stat', return_value=value), \
                mock.patch.object(P.os, 'read', side_effect=[b'abc', b'']) as read, \
                mock.patch.object(P.os, 'close') as close:
            raw, observed = reader._inspect(P.BACKUP_ROOT + '/0.original', 3)
            opened.assert_called_once_with('0.original', P.os.O_RDONLY | P.os.O_NOFOLLOW
                                           | P.os.O_NONBLOCK | P.os.O_NOATIME, dir_fd=7)
        self.assertEqual(b'', raw)
        self.assertEqual(hashlib.sha256(b'abc').hexdigest(), observed['sha256'])
        self.assertEqual(3, observed['bytes'])
        self.assertEqual([mock.call(123, 4), mock.call(123, 1)], read.call_args_list)
        close.assert_called_once_with(123)

    def test_links_special_file_oversize_modes_and_nonroot_fail_before_read(self):
        variants = ({'st_mode': stat.S_IFLNK | 0o777}, {'st_nlink': 2},
                    {'st_mode': stat.S_IFCHR | 0o600}, {'st_mode': stat.S_IFIFO | 0o600},
                    {'st_size': 4}, {'st_uid': 9}, {'st_gid': 9},
                    {'st_mode': stat.S_IFREG | 0o664}, {'st_mode': stat.S_IFREG | 0o4600})
        for change in variants:
            reader = self.reader()
            value = self.info()
            for key, child in change.items():
                setattr(value, key, child)
            with self.flags(), mock.patch.object(P.os, 'open', return_value=123), \
                    mock.patch.object(P.os, 'stat', return_value=value), \
                    mock.patch.object(P.os, 'fstat', return_value=value), \
                    mock.patch.object(P.os, 'read') as read, mock.patch.object(P.os, 'close'):
                with self.assertRaises(P.ProbeError):
                    reader._inspect(P.BACKUP_ROOT + '/0.original', 3)
                read.assert_not_called()

    def test_growth_and_read_identity_change_fail(self):
        reader = self.reader()
        value = self.info()
        with self.flags(), mock.patch.object(P.os, 'open', return_value=123), \
                mock.patch.object(P.os, 'stat', return_value=value), \
                mock.patch.object(P.os, 'fstat', return_value=value), \
                mock.patch.object(P.os, 'read', return_value=b'abcd'), mock.patch.object(P.os, 'close'):
            with self.assertRaisesRegex(P.ProbeError, 'grew'):
                reader._inspect(P.BACKUP_ROOT + '/0.original', 3)
        changed = self.info()
        changed.st_ino = 99
        with self.flags(), mock.patch.object(P.os, 'open', return_value=123), \
                mock.patch.object(P.os, 'fstat', return_value=value), \
                mock.patch.object(P.os, 'stat', side_effect=[value, changed]), \
                mock.patch.object(P.os, 'read', side_effect=[b'abc', b'']), mock.patch.object(P.os, 'close'):
            with self.assertRaisesRegex(P.ProbeError, 'changed'):
                reader._inspect(P.BACKUP_ROOT + '/0.original', 3)

    def test_special_file_is_rejected_before_open_and_regular_swap_before_read(self):
        reader = self.reader()
        special = self.info(stat.S_IFCHR | 0o600)
        with self.flags(), mock.patch.object(P.os, 'stat', return_value=special), \
                mock.patch.object(P.os, 'open') as opened:
            with self.assertRaises(P.ProbeError):
                reader._inspect(P.BACKUP_ROOT + '/0.original', 3)
            opened.assert_not_called()
        old, changed = self.info(), self.info()
        changed.st_ino = 99
        with self.flags(), mock.patch.object(P.os, 'stat', return_value=old), \
                mock.patch.object(P.os, 'open', return_value=123), \
                mock.patch.object(P.os, 'fstat', return_value=changed), \
                mock.patch.object(P.os, 'read') as read, mock.patch.object(P.os, 'close'):
            with self.assertRaisesRegex(P.ProbeError, 'before-open'):
                reader._inspect(P.BACKUP_ROOT + '/0.original', 3)
            read.assert_not_called()

    def test_arbitrary_path_and_absence_only_open_rejected_before_syscall(self):
        reader = self.reader()
        with mock.patch.object(P.os, 'open') as opened:
            for path in ('/root/.ssh/id_rsa', P.APP + '/run.sh', P.BACKUP_PARENT + '/other/manifest.json',
                         P.BACKUP_ROOT + '/../manifest.json', P.NEW_FILE_BACKUP):
                with self.assertRaises(P.ProbeError):
                    reader._inspect(path, 100)
            opened.assert_not_called()

    def test_absence_uses_nofollow_stat_not_open_and_dangling_link_is_not_absence(self):
        reader = self.reader()
        with mock.patch.object(P.os, 'stat', side_effect=FileNotFoundError()) as checked, \
                mock.patch.object(P.os, 'open') as opened:
            self.assertTrue(reader.absent_new_original())
            checked.assert_called_once_with('2.original', dir_fd=7, follow_symlinks=False)
            opened.assert_not_called()
        with mock.patch.object(P.os, 'stat', return_value=self.info(stat.S_IFLNK | 0o777)):
            with self.assertRaises(P.ProbeError):
                reader.absent_new_original()

    def test_directory_replacement_or_permission_change_fails(self):
        reader = self.reader()
        del reader.assert_directories
        old = self.info(stat.S_IFDIR | 0o700)
        reader.anchors = [(7, 'fixed', old)]
        for kind in ('inode', 'symlink', 'mode', 'uid'):
            current = copy.copy(old)
            if kind == 'inode':
                current.st_ino = 9
            elif kind == 'symlink':
                current.st_mode = stat.S_IFLNK | 0o700
            elif kind == 'mode':
                current.st_mode = stat.S_IFDIR | 0o777
            else:
                current.st_uid = 9
            with mock.patch.object(P.os, 'stat', return_value=current):
                with self.assertRaises(P.ProbeError):
                    reader.assert_directories()


if __name__ == '__main__':
    unittest.main(verbosity=2)
