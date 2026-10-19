"""Fixed read-only identity, authorized-key and SSH service probe (Python 3.6)."""
from __future__ import print_function

import base64
import binascii
import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import time
import traceback


EXPECTED_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
EXPECTED_AUTH_SHA = 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f'
EXPECTED_AUTH_BYTES = 221
EXPECTED_BACKUP_SHA = '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b'
PROJECT_BLOB_SHA = '08afbf42081b285b9ebbdfda5df75480e39279e38cd71614abe8580908c15381'
RECOVERY_BLOB_SHA = '599b26c1132227e26669f782ed447b65f9fe7e8ef5612138b78655ce3eb54c80'
EXPECTED_CONNECTION = ('169.254.142.174', '169.254.220.254', '22')
SYSTEMCTL = '/bin/systemctl'
PROPERTIES = ('Id', 'Names', 'FragmentPath', 'ExecReload', 'MainPID', 'ActiveState', 'LoadState')
OUTPUT_CAP = 8192
COMMAND_SECONDS = 5
MAX_PROPERTY_LINES = 24
MAX_RELOAD_ENTRIES = 8


class PropertyError(ValueError):
    def __init__(self, code, key, line, value_length, duplicate_count):
        ValueError.__init__(self, code)
        self.property_key = key if key in PROPERTIES else 'unknown'
        self.property_line = line
        self.value_length = value_length
        self.duplicate_count = duplicate_count


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _directory(parts):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory = os.open('/', flags)
    try:
        for part in parts:
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise


def _read_regular(parts, size, expected_sha):
    directory = _directory(parts[:-1])
    try:
        prior = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(prior.st_mode) or prior.st_nlink != 1 or
                prior.st_uid != 0 or prior.st_gid != 0 or prior.st_size != size):
            raise ValueError('fixed-file-metadata-mismatch')
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            opened = os.fstat(fd)
            before = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            if before != (prior.st_dev, prior.st_ino, prior.st_size, prior.st_mtime_ns):
                raise ValueError('fixed-file-changed-before-read')
            data = os.read(fd, size + 1)
            after = os.fstat(fd)
            if (len(data) != size or _sha(data) != expected_sha or
                    before != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
                raise ValueError('fixed-file-sha-or-race-mismatch')
            return data
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def _boot():
    directory = _directory(('proc', 'sys', 'kernel', 'random'))
    try:
        fd = os.open('boot_id', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            value = os.read(fd, 64).decode('ascii').strip()
        finally:
            os.close(fd)
    finally:
        os.close(directory)
    if value != EXPECTED_BOOT:
        raise ValueError('boot-id-mismatch')
    return value


def _blob_sha(line):
    fields = line.split()
    if len(fields) != 3 or fields[0] != b'ssh-ed25519':
        return None
    try:
        blob = base64.b64decode(fields[1], validate=True)
    except (ValueError, binascii.Error):
        return None
    return _sha(blob) if 16 <= len(blob) <= 8192 else None


def _connection_ok(value):
    fields = value.split() if isinstance(value, str) else []
    return (len(fields) == 4 and fields[0] == EXPECTED_CONNECTION[0] and
            fields[2:] == list(EXPECTED_CONNECTION[1:]) and fields[1].isdigit() and
            1 <= int(fields[1]) <= 65535)


def _command(argv):
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, shell=False, close_fds=True,
                               env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C'})
    selector = selectors.DefaultSelector()
    out = bytearray()
    err = bytearray()
    try:
        for stream, target in ((process.stdout, out), (process.stderr, err)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, target)
        deadline = time.monotonic() + COMMAND_SECONDS
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('systemctl-deadline')
            for key, unused in selector.select(min(remaining, 0.2)):
                piece = os.read(key.fileobj.fileno(), 4096)
                if not piece:
                    selector.unregister(key.fileobj)
                    continue
                key.data.extend(piece)
                if len(out) + len(err) > OUTPUT_CAP:
                    raise ValueError('systemctl-output-limit')
        return process.wait(timeout=max(0.1, deadline - time.monotonic())), bytes(out), _sha(bytes(err))
    except BaseException:
        try:
            process.kill()
            process.wait(timeout=1)
        except Exception:
            pass
        raise
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()


def _service(argv_runner, name):
    argv = (SYSTEMCTL, 'show', name) + tuple('--property=' + field for field in PROPERTIES)
    code, raw, stderr_sha = argv_runner(argv)
    if code != 0:
        return {'available': False, 'exitCode': code, 'stderrSha256': stderr_sha}
    values = {}
    reload_entries = []
    for line_number, line in enumerate(raw.decode('ascii').splitlines(), 1):
        key, separator, value = line.partition('=')
        seen = len(reload_entries) if key == 'ExecReload' else int(key in values)
        if (line_number > MAX_PROPERTY_LINES or not separator or key not in PROPERTIES or
                len(value) > 1024 or
                any(ord(character) < 32 or ord(character) > 126 for character in value)):
            raise PropertyError('unsafe-systemctl-property', key, line_number,
                                len(value), seen)
        if key == 'ExecReload':
            if len(reload_entries) >= MAX_RELOAD_ENTRIES:
                raise PropertyError('too-many-reload-entries', key, line_number,
                                    len(value), len(reload_entries))
            reload_entries.append(value)
            continue
        if key in values:
            raise PropertyError('duplicate-systemctl-property', key, line_number,
                                len(value), seen)
        values[key] = value
    if set(values) != set(PROPERTIES) - {'ExecReload'} or not reload_entries:
        raise ValueError('missing-systemctl-property')
    safe = {}
    for key, value in values.items():
        if key == 'MainPID':
            if not value.isdigit():
                raise ValueError('unsafe-service-pid')
            safe[key] = int(value)
        else:
            if not re.fullmatch(r'[A-Za-z0-9_./ @:+-]{0,512}', value):
                raise ValueError('unsafe-systemctl-property')
            safe[key] = value
    safe['ExecReloadCount'] = len(reload_entries)
    safe['ExecReloadEntrySha256'] = [_sha(value.encode('ascii')) for value in reload_entries]
    safe['ExecReloadEntries'] = [
        value if re.fullmatch(r'[A-Za-z0-9_./;$(){}\[\] =:+-]{0,1024}', value) else None
        for value in reload_entries]
    safe['exitCode'] = code
    safe['stderrSha256'] = stderr_sha
    safe['available'] = True
    return safe


def collect(reader=_read_regular, boot=_boot, runner=_command, session=None):
    if session is None:
        session = os.environ.get('SSH_CONNECTION')
    if not _connection_ok(session) or os.geteuid() != 0:
        raise ValueError('root-or-session-identity-mismatch')
    auth = reader(('root', '.ssh', 'authorized_keys'), EXPECTED_AUTH_BYTES, EXPECTED_AUTH_SHA)
    backup = reader(('root', '.ssh', 'authorized_keys.fz3b-prehardening-20261016'), 107,
                    EXPECTED_BACKUP_SHA)
    keys = [_blob_sha(line) for line in auth.splitlines()]
    if keys != [PROJECT_BLOB_SHA, RECOVERY_BLOB_SHA] or _blob_sha(backup.strip()) != PROJECT_BLOB_SHA:
        raise ValueError('authorized-key-set-mismatch')
    boot_id = boot()
    services = {name: _service(runner, name) for name in ('ssh.service', 'sshd.service')}
    if not any(service.get('available') is True and service.get('ActiveState') == 'active' and
               service.get('LoadState') == 'loaded' and service.get('MainPID', 0) > 0
               for service in services.values()):
        raise ValueError('ssh-service-unidentified')
    return {'schemaVersion': 1, 'scope': 'fz3b-key-login-service-readonly',
            'readOnly': True, 'serviceActions': False, 'filesWritten': False,
            'user': 'root', 'uid': 0, 'bootId': boot_id,
            'connectionSource': EXPECTED_CONNECTION[0], 'connectionDestination': EXPECTED_CONNECTION[1],
            'authorizedSha256': EXPECTED_AUTH_SHA, 'authorizedBytes': EXPECTED_AUTH_BYTES,
            'backupSha256': EXPECTED_BACKUP_SHA,
            'projectPublicKeyCount': 1, 'recoveryPublicKeyCount': 1,
            'services': services, 'passwordOrShadowRead': False,
            'privateKeyRead': False}


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        raise SystemExit('no arguments accepted')
    try:
        result = collect()
    except Exception as error:
        frames = traceback.extract_tb(sys.exc_info()[2])
        own = [frame for frame in frames if frame.filename == '<stdin>']
        last = own[-1] if own else None
        code = str(error) if isinstance(error, ValueError) else None
        known = frozenset(('fixed-file-metadata-mismatch', 'fixed-file-changed-before-read',
                           'fixed-file-sha-or-race-mismatch', 'boot-id-mismatch',
                           'authorized-key-set-mismatch', 'root-or-session-identity-mismatch',
                           'systemctl-deadline', 'systemctl-output-limit',
                           'unsafe-systemctl-property', 'duplicate-systemctl-property',
                           'too-many-reload-entries', 'missing-systemctl-property',
                           'unsafe-service-pid', 'ssh-service-unidentified'))
        diagnostic = {'schemaVersion': 1, 'scope': 'fz3b-key-service-diagnostic',
                      'result': 'failed', 'errorType': type(error).__name__,
                      'errorCode': code if code in known else 'unclassified',
                      'function': last.name if last and last.name in
                      ('_directory', '_read_regular', '_boot', '_command', '_service', 'collect') else 'unknown',
                      'line': last.lineno if last else None,
                      'errno': error.errno if isinstance(error, OSError) else None,
                      'readOnly': True, 'serviceActions': False, 'filesWritten': False}
        if isinstance(error, PropertyError):
            diagnostic.update({'propertyKey': error.property_key,
                               'propertyLine': error.property_line,
                               'valueLength': error.value_length,
                               'duplicateCount': error.duplicate_count})
        print(json.dumps(diagnostic, sort_keys=True, separators=(',', ':')))
        return 1
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
