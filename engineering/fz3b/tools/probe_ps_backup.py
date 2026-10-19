"""Read-only verification of one fixed successful PS backup (Python 3.6 stdin)."""
from __future__ import print_function

import sys
sys.dont_write_bytecode = True

import hashlib
import json
import os
import stat


APP = '/root/fz3b-vision-console-20261009-001'
RUN_ID = 'ps-security-1792122514610'
UNIT = 'fz3b-vision-console.service'
BACKUP_PARENT = APP + '/.forgedesk-ps-backups'
BACKUP_ROOT = BACKUP_PARENT + '/' + RUN_ID
MANIFEST_PATH = BACKUP_ROOT + '/manifest.json'
MANIFEST_SHA256 = 'a478fd7f12b15bc5a39d84e074d0d929b049a4a862c7a618c2d8edaffa9df1d1'
APPROVED_MANIFEST_SHA256 = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09'
MAX_SOURCE_BYTES = 256 * 1024
MAX_CONFIG_BYTES = 64 * 1024
MAX_MANIFEST_BYTES = 32 * 1024
ENTRIES = (
    ('vision_app/board_agent.py', '0.original',
     '705ae83c7bb150655f098b6355da44c322ce441670037f3d4e15db28d05cc61e',
     '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a', 0o644),
    ('vision_app/camera.py', '1.original',
     '0e1c93f16e234aa12bc93646a4bf69d3f59286714b2e0b775a3fe603bfc8a914',
     'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2', 0o644),
    ('vision_app/image_boundary.py', None, None,
     '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057', 0o644),
    ('vision_app/protocol.py', '3.original',
     'e127737f5c7cc3f29a6975afd6bf9066ecce5ca59c791637dd16bff0e37b4ec3',
     'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37', 0o644),
    ('vision_app/upload_source.py', '4.original',
     '1aba54e47006d24688577cd8cb1b057dc872fe956a62169a51398aef6441981b',
     'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249', 0o644),
    ('config.json', '5.original',
     'd20110909e8e4c578f85bfbc200383e349df6f01b1db8c47822647ca93e3b452',
     'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2', 0o600),
)
NEW_FILE_BACKUP = BACKUP_ROOT + '/2.original'
HASH_PATHS = tuple(APP + '/' + entry[0] for entry in ENTRIES) + tuple(
    BACKUP_ROOT + '/' + entry[1] for entry in ENTRIES if entry[1] is not None)


class ProbeError(Exception):
    pass


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def expected_manifest():
    return {'schema': 1, 'app': APP, 'unit': UNIT, 'run_id': RUN_ID,
            'approved_manifest_sha256': APPROVED_MANIFEST_SHA256,
            'config_change': {'bind': '127.0.0.1'},
            'entries': [{'path': path, 'backup': backup, 'old_sha256': old,
                         'new_sha256': new, 'mode': mode, 'uid': 0, 'gid': 0}
                        for path, backup, old, new, mode in ENTRIES]}


def canonical_json(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True,
                       allow_nan=False) + '\n').encode('ascii')


def _unique_pairs(pairs):
    value = {}
    for key, child in pairs:
        if key in value:
            raise ProbeError('duplicate-manifest-key')
        value[key] = child
    return value


def _reject_constant(unused):
    raise ProbeError('non-finite-manifest-number')


def validate_manifest(raw):
    if type(raw) is not bytes or len(raw) > MAX_MANIFEST_BYTES or sha256(raw) != MANIFEST_SHA256:
        raise ProbeError('fixed-manifest-sha-mismatch')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_pairs,
                       parse_constant=_reject_constant)
    if canonical_json(value) != canonical_json(expected_manifest()):
        raise ProbeError('fixed-manifest-schema-mismatch')
    return value


class FixedReader(object):
    """No writes, process execution, application imports, or caller-defined roots."""

    def __init__(self):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise ProbeError('linux-root-read-only-probe-required')
        if not all(hasattr(os, flag) for flag in ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK', 'O_NOATIME')):
            raise ProbeError('required-safe-open-flags-unavailable')
        self.fds, self.anchors, self.parents = [], [], {}
        try:
            root = self._directory('/')
            self.parents['/'] = root
            directories = (APP, APP + '/vision_app', BACKUP_PARENT, BACKUP_ROOT)
            for absolute in directories:
                current, parent = '', root
                for part in absolute.strip('/').split('/'):
                    current += '/' + part
                    if current not in self.parents:
                        child = self._directory(part, parent)
                        value = os.fstat(child)
                        self.anchors.append((parent, part, value))
                        self.parents[current] = child
                    parent = self.parents[current]
                if absolute in (BACKUP_PARENT, BACKUP_ROOT):
                    if stat.S_IMODE(os.fstat(parent).st_mode) != 0o700:
                        raise ProbeError('backup-directory-mode-must-be-700')
        except Exception:
            self.close()
            raise

    @staticmethod
    def identity(value):
        return (value.st_dev, value.st_ino, value.st_size, value.st_mode, value.st_nlink,
                value.st_uid, value.st_gid, value.st_mtime_ns, value.st_ctime_ns)

    @staticmethod
    def _protected_directory(value):
        if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
            raise ProbeError('unsafe-directory-type-owner-or-mode')

    def _directory(self, name, parent=None):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOATIME,
                     dir_fd=parent)
        self.fds.append(fd)
        self._protected_directory(os.fstat(fd))
        return fd

    def assert_directories(self):
        for parent, name, old in self.anchors:
            actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            self._protected_directory(actual)
            if (actual.st_dev, actual.st_ino) != (old.st_dev, old.st_ino):
                raise ProbeError('directory-anchor-changed')
            # Directory timestamps/size need not be frozen: the running app is not stopped.
            if stat.S_IMODE(actual.st_mode) != stat.S_IMODE(old.st_mode):
                raise ProbeError('directory-mode-changed')

    def _mapping(self, path):
        if path not in HASH_PATHS + (MANIFEST_PATH, NEW_FILE_BACKUP):
            raise ProbeError('path-is-not-fixed-allowlisted')
        parent, leaf = path.rsplit('/', 1)
        return self.parents[parent], leaf

    @staticmethod
    def _regular(value, cap):
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_uid != 0
                or value.st_gid != 0 or value.st_mode & 0o7022
                or value.st_size < 0 or value.st_size > cap):
            raise ProbeError('unsafe-file-type-links-owner-mode-or-size')

    def _inspect(self, path, cap, collect=False):
        parent, leaf = self._mapping(path)
        if path == NEW_FILE_BACKUP:
            raise ProbeError('absence-only-path-cannot-be-opened')
        self.assert_directories()
        named_before = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        self._regular(named_before, cap)
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOATIME, dir_fd=parent)
        try:
            before = os.fstat(fd)
            self._regular(before, cap)
            if self.identity(before) != self.identity(named_before):
                raise ProbeError('file-changed-before-open')
            digest, count, chunks = hashlib.sha256(), 0, []
            while True:
                raw = os.read(fd, min(65536, cap + 1 - count))
                if not raw:
                    break
                count += len(raw)
                if count > cap:
                    raise ProbeError('file-grew-beyond-limit')
                digest.update(raw)
                if collect:
                    chunks.append(raw)
            after = os.fstat(fd)
            named = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            if (self.identity(before) != self.identity(after)
                    or self.identity(after) != self.identity(named) or count != before.st_size):
                raise ProbeError('file-changed-during-read')
            metadata = {'bytes': count, 'sha256': digest.hexdigest(), 'mode': stat.S_IMODE(before.st_mode),
                        'uid': before.st_uid, 'gid': before.st_gid, 'stamp': self.identity(before)}
            return (b''.join(chunks), metadata)
        finally:
            os.close(fd)

    def manifest(self):
        raw, metadata = self._inspect(MANIFEST_PATH, MAX_MANIFEST_BYTES, collect=True)
        if metadata['mode'] != 0o600:
            raise ProbeError('manifest-mode-must-be-600')
        return raw

    def hash_file(self, path):
        if path not in HASH_PATHS:
            raise ProbeError('hash-path-is-not-fixed-allowlisted')
        cap = MAX_CONFIG_BYTES if path in (APP + '/config.json', BACKUP_ROOT + '/5.original') else MAX_SOURCE_BYTES
        return self._inspect(path, cap)[1]

    def absent_new_original(self):
        self.assert_directories()
        parent, leaf = self._mapping(NEW_FILE_BACKUP)
        try:
            os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return True
        raise ProbeError('new-file-original-backup-must-be-absent')

    def close(self):
        errors = []
        for fd in reversed(self.fds):
            try:
                os.close(fd)
            except OSError as error:
                errors.append(error)
        self.fds = []
        if errors:
            raise ProbeError('reader-fd-close-failed')


def verify_snapshot(reader):
    validate_manifest(reader.manifest())
    reader.absent_new_original()
    result = []
    for path, backup, old, new, mode in ENTRIES:
        current = reader.hash_file(APP + '/' + path)
        if current['sha256'] != new or current['mode'] != mode or current['uid'] != 0 or current['gid'] != 0:
            raise ProbeError('current-deployed-file-mismatch: ' + path)
        item = {'target': path, 'current': current}
        if backup is not None:
            original = reader.hash_file(BACKUP_ROOT + '/' + backup)
            if original['sha256'] != old or original['mode'] != 0o600 or original['uid'] != 0 or original['gid'] != 0:
                raise ProbeError('original-backup-mismatch: ' + backup)
            item['originalBackup'] = original
        else:
            item['originalAbsenceRecorded'] = True
            item['originalBackupAbsentNow'] = True
        result.append(item)
    reader.assert_directories()
    return result


def probe(reader_factory=FixedReader):
    reader = None
    try:
        reader = reader_factory()
        first = verify_snapshot(reader)
        second = verify_snapshot(reader)
        if first != second:
            raise ProbeError('files-changed-between-verification-passes')
        validate_manifest(reader.manifest())
        for entry in second:
            entry['current'].pop('stamp', None)
            if 'originalBackup' in entry:
                entry['originalBackup'].pop('stamp', None)
        result = {'result': 'passed-backup-readable-hash-consistency', 'files': second}
    except Exception as error:
        result = {'result': 'blocked', 'error': str(error)[:500]}
    finally:
        if reader is not None:
            try:
                reader.close()
            except Exception:
                result = {'result': 'blocked', 'error': 'reader-cleanup-failed'}
    result.update(schemaVersion=1, scope='fixed-successful-PS-transaction-backup-read-only',
                  runId=RUN_ID, backupRoot=BACKUP_ROOT, manifestSha256=MANIFEST_SHA256,
                  readOnly=True, rollbackAttempted=False, actualRecoveryVerified=False,
                  historicalAbsenceIndependentlyRecreated=False,
                  serviceQueried=False, subprocessStarted=False, applicationImported=False,
                  authenticationFilesRead=False, deviceOpened=False, networkAccessed=False,
                  limitation='Hash-consistent readable backups are not a tested rollback. Point-in-time reads do not lock out concurrent root changes.')
    return result


def main():
    if len(sys.argv) != 1:
        result = {'result': 'blocked', 'error': 'this-fixed-probe-accepts-no-arguments'}
    else:
        result = probe()
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0 if result['result'] == 'passed-backup-readable-hash-consistency' else 1


if __name__ == '__main__':
    sys.exit(main())
