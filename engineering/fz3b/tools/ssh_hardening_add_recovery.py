"""One-shot FZ3B recovery public-key addition; never changes sshd policy."""
from __future__ import print_function

import base64
import binascii
import hashlib
import json
import os
import stat
import sys


CONFIG_SHA256 = 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216'
CONFIG_BYTES = 3248
AUTHORIZED_SHA256 = '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b'
AUTHORIZED_BYTES = 107
PROJECT_BLOB_SHA256 = '08afbf42081b285b9ebbdfda5df75480e39279e38cd71614abe8580908c15381'
RECOVERY_BLOB_SHA256 = '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80'
RECOVERY_LINE = (b'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOk77u5TKT7Alrjg2L+oM8cHBHUvPrYZCDEPecIx3UOi '
                 b'forgedesk-fz3b-recovery-20261016')
BACKUP = 'authorized_keys.fz3b-prehardening-20261016'
STAGE = '.authorized_keys.fz3b-recovery-stage-20261016'
EXPECTED_CONNECTION = ('169.254.142.174', '169.254.220.254', '22')


def _flags():
    if not all(hasattr(os, name) for name in ('O_NOFOLLOW', 'O_NONBLOCK', 'O_DIRECTORY')):
        raise ValueError('safe-open-unavailable')
    return (os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _session_matches(value):
    fields = value.split() if isinstance(value, str) else []
    return (len(fields) == 4 and fields[0] == EXPECTED_CONNECTION[0] and
            fields[2:] == list(EXPECTED_CONNECTION[1:]) and fields[1].isdigit() and
            1 <= int(fields[1]) <= 65535)


def _directory(parts):
    directory_flags = _flags()[1]
    directory = os.open('/', directory_flags)
    try:
        for part in parts:
            child = os.open(part, directory_flags, dir_fd=directory)
            os.close(directory)
            directory = child
        info = os.fstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError('unsafe-directory-metadata')
        return directory
    except BaseException:
        os.close(directory)
        raise


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _snapshot(directory, name, expected_size, expected_sha, expected_mode):
    prior = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if (not stat.S_ISREG(prior.st_mode) or prior.st_nlink != 1 or prior.st_uid != 0 or
            prior.st_gid != 0 or stat.S_IMODE(prior.st_mode) != expected_mode or
            prior.st_size != expected_size):
        raise ValueError('source-metadata-mismatch')
    fd = os.open(name, _flags()[0], dir_fd=directory)
    try:
        opened = os.fstat(fd)
        if _identity(opened) != _identity(prior):
            raise ValueError('source-changed-before-read')
        chunks = bytearray()
        while len(chunks) <= expected_size:
            piece = os.read(fd, expected_size + 1 - len(chunks))
            if not piece:
                break
            chunks.extend(piece)
        data = bytes(chunks)
        if (len(data) != expected_size or _sha(data) != expected_sha or
                _identity(os.fstat(fd)) != _identity(opened)):
            raise ValueError('source-sha-or-race-mismatch')
        return data, opened
    finally:
        os.close(fd)


def _blob_sha(line):
    words = line.split()
    if len(words) != 3 or words[0] != b'ssh-ed25519':
        return None
    try:
        blob = base64.b64decode(words[1], validate=True)
    except (ValueError, binascii.Error):
        return None
    if not 16 <= len(blob) <= 8192:
        return None
    return _sha(blob)


def planned_bytes(original):
    if len(original) != AUTHORIZED_BYTES or _sha(original) != AUTHORIZED_SHA256:
        raise ValueError('authorized-preimage-mismatch')
    lines = original.splitlines()
    if len(lines) != 1 or _blob_sha(lines[0]) != PROJECT_BLOB_SHA256:
        raise ValueError('unexpected-original-key-set')
    if _blob_sha(RECOVERY_LINE) != RECOVERY_BLOB_SHA256:
        raise ValueError('recovery-public-key-pin-mismatch')
    result = original + (b'' if original.endswith(b'\n') else b'\n') + RECOVERY_LINE + b'\n'
    if [_blob_sha(line) for line in result.splitlines()] != [PROJECT_BLOB_SHA256, RECOVERY_BLOB_SHA256]:
        raise ValueError('unexpected-candidate-key-set')
    return result


def _write_exclusive(directory, name, data):
    fd = os.open(name, _flags()[2], 0o600, dir_fd=directory)
    try:
        os.fchmod(fd, 0o600)
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            if written <= 0:
                raise OSError('short-write')
            offset += written
        os.fsync(fd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != len(data)):
            raise ValueError('written-file-metadata-mismatch')
    finally:
        os.close(fd)


def run(session=None):
    if session is None:
        session = os.environ.get('SSH_CONNECTION')
    if not _session_matches(session):
        raise ValueError('session-context-unverified')
    sshdir = _directory(('root', '.ssh'))
    try:
        configdir = _directory(('etc', 'ssh'))
        try:
            _snapshot(configdir, 'sshd_config', CONFIG_BYTES, CONFIG_SHA256, 0o644)
        finally:
            os.close(configdir)
        original, original_info = _snapshot(sshdir, 'authorized_keys', AUTHORIZED_BYTES,
                                            AUTHORIZED_SHA256, 0o600)
        next_bytes = planned_bytes(original)
        # Both names are exclusive. A leftover from any prior attempt requires manual review.
        _write_exclusive(sshdir, BACKUP, original)
        os.fsync(sshdir)
        _snapshot(sshdir, BACKUP, AUTHORIZED_BYTES, AUTHORIZED_SHA256, 0o600)
        _write_exclusive(sshdir, STAGE, next_bytes)
        _snapshot(sshdir, 'authorized_keys', AUTHORIZED_BYTES, AUTHORIZED_SHA256, 0o600)
        if _identity(os.stat('authorized_keys', dir_fd=sshdir, follow_symlinks=False)) != _identity(original_info):
            raise ValueError('authorized-file-changed-before-commit')
        os.replace(STAGE, 'authorized_keys', src_dir_fd=sshdir, dst_dir_fd=sshdir)
        os.fsync(sshdir)
        _snapshot(sshdir, 'authorized_keys', len(next_bytes), _sha(next_bytes), 0o600)
        configdir = _directory(('etc', 'ssh'))
        try:
            _snapshot(configdir, 'sshd_config', CONFIG_BYTES, CONFIG_SHA256, 0o644)
        finally:
            os.close(configdir)
        return {'schemaVersion': 1, 'scope': 'fz3b-recovery-key-added', 'sshdConfigChanged': False,
                'sshdReloaded': False, 'passwordAuthenticationChanged': False,
                'passwordRotated': False, 'originalAuthorizedSha256': AUTHORIZED_SHA256,
                'backupPath': '/root/.ssh/' + BACKUP, 'backupSha256': AUTHORIZED_SHA256,
                'authorizedSha256': _sha(next_bytes), 'authorizedBytes': len(next_bytes),
                'projectPublicKeyCount': 1, 'recoveryPublicKeyCount': 1,
                'recoveryPublicKeyBlobSha256': RECOVERY_BLOB_SHA256,
                'independentRecoveryLoginVerified': False}
    finally:
        os.close(sshdir)


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        raise SystemExit('no arguments accepted')
    print(json.dumps(run(), sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
