"""Fixed, read-only FZ3B sshd authentication audit (Python 3.6 stdin source)."""
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


SSHD = '/usr/sbin/sshd'
CONFIG = '/etc/ssh/sshd_config'
DROPINS = '/etc/ssh/sshd_config.d'
AUTHORIZED = '/root/.ssh/authorized_keys'
HOST_PUBLIC = '/etc/ssh/ssh_host_ed25519_key.pub'
PROJECT_KEY_BLOB_SHA = '08afbf42081b285b9ebbdfda5df75480e39279e38cd71614abe8580908c15381'
HOST_KEY_BLOB_SHA = '79e0d629cb33138802fda202e606a542871d8d33d9bfda28820f299bcdab5a2c'
MATCH = 'user=root,host=169.254.142.174,addr=169.254.142.174,laddr=169.254.220.254,lport=22'
EXPECTED_CONNECTION = ('169.254.142.174', '169.254.220.254', '22')
AUTH_FIELDS = ('pubkeyauthentication', 'passwordauthentication', 'kbdinteractiveauthentication',
               'challengeresponseauthentication', 'permitrootlogin', 'authenticationmethods',
               'authorizedkeysfile', 'usepam', 'permitemptypasswords')
COMMANDS = (('version', (SSHD, '-V')),
            ('syntax', (SSHD, '-t', '-f', CONFIG)),
            ('effectiveRoot', (SSHD, '-T', '-f', CONFIG, '-C', MATCH)))
MAX_FILE = 128 * 1024
MAX_DROPINS = 24
MAX_TOTAL = 384 * 1024
MAX_COMMAND_OUTPUT = 64 * 1024
COMMAND_TIMEOUT = 5
TOTAL_DEADLINE = 25
EXEC_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C'}
SAFE_VERSION = re.compile(r'OpenSSH_[0-9A-Za-z._-]{1,40}')
SAFE_DROPIN = re.compile(r'^[A-Za-z0-9_.-]{1,80}\.conf$')


class AuditError(Exception):
    pass


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size,
            getattr(info, 'st_mtime_ns', None) or info.st_mtime,
            getattr(info, 'st_ctime_ns', None) or info.st_ctime)


def _directory(parts):
    if not all(hasattr(os, key) for key in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK')):
        raise AuditError('safe-open-unavailable')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open('/', flags)
    try:
        for part in parts:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def _parts(path):
    if not isinstance(path, str) or not path.startswith('/') or '\\' in path or '\x00' in path:
        raise AuditError('unsafe-path')
    parts = path[1:].split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise AuditError('unsafe-path')
    return parts


def _read(path, cap, deadline):
    parts = _parts(path)
    parent = _directory(parts[:-1])
    try:
        prior = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(prior.st_mode) or prior.st_nlink != 1 or prior.st_size > cap:
            raise AuditError('not-regular-or-over-limit')
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        if _identity(prior) != _identity(before) or not stat.S_ISREG(before.st_mode):
            raise AuditError('file-changed-before-read')
        chunks = bytearray()
        while len(chunks) <= cap:
            if time.monotonic() >= deadline:
                raise AuditError('audit-deadline')
            chunk = os.read(fd, min(8192, cap + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
        if len(chunks) > cap or _identity(before) != _identity(os.fstat(fd)):
            raise AuditError('file-changed-or-over-limit')
        return bytes(chunks), before
    finally:
        os.close(fd)


def _list_dropins():
    fd = _directory(_parts(DROPINS))
    try:
        names = os.listdir(fd)
    finally:
        os.close(fd)
    if len(names) > MAX_DROPINS or any(not SAFE_DROPIN.fullmatch(name) for name in names):
        raise AuditError('unreviewed-dropin-directory')
    return sorted(names)


def _command(argv, deadline):
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=dict(EXEC_ENV), shell=False,
                               close_fds=True)
    selector = selectors.DefaultSelector()
    output = bytearray()
    error = bytearray()
    try:
        for stream, target in ((process.stdout, output), (process.stderr, error)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, target)
        end = min(deadline, time.monotonic() + COMMAND_TIMEOUT)
        while selector.get_map():
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise AuditError('command-deadline')
            for key, unused in selector.select(min(remaining, 0.2)):
                target = key.data
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                target.extend(chunk)
                if len(output) + len(error) > MAX_COMMAND_OUTPUT:
                    raise AuditError('command-output-limit')
        remaining = end - time.monotonic()
        if remaining <= 0:
            raise AuditError('command-deadline')
        return process.wait(timeout=remaining), bytes(output), bytes(error)
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


def _public_blob_sha(line):
    fields = line.strip().split()
    for index, field in enumerate(fields[:-1]):
        if field in (b'ssh-ed25519', b'ssh-rsa', b'ecdsa-sha2-nistp256',
                     b'ecdsa-sha2-nistp384', b'ecdsa-sha2-nistp521'):
            try:
                blob = base64.b64decode(fields[index + 1], validate=True)
            except (ValueError, binascii.Error):
                return None
            if 16 <= len(blob) <= 8192:
                return hashlib.sha256(blob).hexdigest()
    return None


def _file_summary(path, data, info):
    return {'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'mode': oct(stat.S_IMODE(info.st_mode)), 'uid': info.st_uid, 'gid': info.st_gid}


def _effective(data):
    result = {}
    for raw in data.decode('utf-8').splitlines():
        key, space, value = raw.partition(' ')
        if key not in AUTH_FIELDS or not space:
            continue
        value = value.strip()
        if len(value) > 256 or any(ord(char) < 32 or ord(char) > 126 for char in value):
            raise AuditError('unsafe-effective-value')
        if key in result:
            raise AuditError('duplicate-effective-field')
        if key in ('authorizedkeysfile', 'authenticationmethods'):
            result[key] = {'sha256': hashlib.sha256(value.encode('ascii')).hexdigest(),
                           'matchesDefault': value in ('.ssh/authorized_keys .ssh/authorized_keys2',
                                                       '.ssh/authorized_keys', 'any', 'publickey')}
        else:
            if not re.fullmatch(r'[A-Za-z0-9,._+-]{1,80}', value):
                raise AuditError('unexpected-effective-token')
            result[key] = value
    return result


def _session_matches(value):
    if not isinstance(value, str):
        return False
    fields = value.split()
    return (len(fields) == 4 and fields[0] == EXPECTED_CONNECTION[0] and
            fields[2:] == list(EXPECTED_CONNECTION[1:]) and fields[1].isdigit() and
            1 <= int(fields[1]) <= 65535)


def collect(reader=_read, listing=_list_dropins, runner=_command, now=time.monotonic,
            session=None):
    deadline = now() + TOTAL_DEADLINE
    if session is None:
        session = os.environ.get('SSH_CONNECTION')
    result = {'schemaVersion': 1, 'scope': 'fz3b-ssh-auth-readonly-audit',
              'host': '169.254.220.254', 'readOnly': True, 'configurationChanged': False,
              'serviceActions': 'not-attempted', 'passwordOrShadowRead': False,
              'privateKeyRead': False, 'files': [], 'commands': {}, 'issues': [],
              'expectedConnection': {'sourceAddress': EXPECTED_CONNECTION[0],
                                     'destinationAddress': EXPECTED_CONNECTION[1],
                                     'destinationPort': int(EXPECTED_CONNECTION[2])},
              'currentSessionMatchesExpectedConnection': _session_matches(session)}
    if not result['currentSessionMatchesExpectedConnection']:
        result['issues'].append('session-context-unverified')
    used = 0
    def safe_read(path, cap):
        nonlocal used
        if now() >= deadline or used + cap > MAX_TOTAL:
            raise AuditError('audit-budget')
        data, info = reader(path, cap, deadline)
        used += len(data)
        return data, info
    for path, cap in ((CONFIG, 65536), (AUTHORIZED, MAX_FILE), (HOST_PUBLIC, 8192)):
        try:
            data, info = safe_read(path, cap)
            item = _file_summary(path, data, info)
            if path == AUTHORIZED:
                lines = data.splitlines()
                if len(lines) > 128 or any(len(line) > 8192 for line in lines):
                    raise AuditError('authorized-keys-structure-limit')
                matches = [_public_blob_sha(line) for line in lines if line.strip() and not line.lstrip().startswith(b'#')]
                item['validPublicKeyCount'] = sum(value is not None for value in matches)
                item['projectPublicKeyCount'] = matches.count(PROJECT_KEY_BLOB_SHA)
                item['contentOmitted'] = True
                if item['projectPublicKeyCount'] < 1:
                    result['issues'].append('project-public-key-not-in-fixed-authorized-keys')
            if path == HOST_PUBLIC:
                item['matchesPinnedHostPublicKey'] = _public_blob_sha(data) == HOST_KEY_BLOB_SHA
                item['contentOmitted'] = True
                if not item['matchesPinnedHostPublicKey']:
                    result['issues'].append('host-public-key-pin-mismatch')
            if path == CONFIG:
                item['contentOmitted'] = True
                item['includeDirectiveCount'] = sum(line.strip().lower().startswith(b'include ') for line in data.splitlines())
            result['files'].append(item)
        except Exception as error:
            result['issues'].append('file:' + path + ':' + (str(error) if isinstance(error, AuditError) else type(error).__name__))
    try:
        names = listing()
        if len(names) > MAX_DROPINS or any(not SAFE_DROPIN.fullmatch(name) for name in names):
            raise AuditError('unreviewed-dropin-directory')
        result['dropInNames'] = names
        for name in names:
            path = DROPINS + '/' + name
            data, info = safe_read(path, 8192)
            item = _file_summary(path, data, info)
            item['contentOmitted'] = True
            result['files'].append(item)
    except FileNotFoundError:
        result['dropInNames'] = []
    except Exception as error:
        result['issues'].append('dropins:' + (str(error) if isinstance(error, AuditError) else type(error).__name__))
    for label, argv in COMMANDS:
        try:
            code, stdout, stderr = runner(argv, deadline)
            item = {'exitCode': code, 'stdoutBytes': len(stdout), 'stderrBytes': len(stderr),
                    'stderrSha256': hashlib.sha256(stderr).hexdigest()}
            if label == 'version':
                match = SAFE_VERSION.search((stdout + stderr).decode('ascii', 'replace'))
                item['opensshVersion'] = match.group(0) if match else None
            if label == 'syntax':
                item['valid'] = code == 0
            if label == 'effectiveRoot' and code == 0:
                item['matchContext'] = MATCH
                item['auth'] = _effective(stdout)
                if not all(key in item['auth'] for key in
                           ('pubkeyauthentication', 'passwordauthentication',
                            'permitrootlogin', 'authorizedkeysfile')):
                    result['issues'].append('effective-auth-fields-incomplete')
            if code != 0 and label != 'version':
                result['issues'].append('command-failed:' + label)
            result['commands'][label] = item
        except Exception as error:
            result['issues'].append('command:' + label + ':' + (str(error) if isinstance(error, AuditError) else type(error).__name__))
    result['result'] = 'audit-collected' if not result['issues'] else 'audit-incomplete'
    result['limitations'] = ['This audit does not prove password login rejection or rotate any account password.',
                             'A key-preserving, reversible change requires separate live review and test.']
    return result


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        raise SystemExit('no arguments accepted')
    print(json.dumps(collect(), sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
