"""One-shot root-only sshd policy transaction for the pinned FZ3B image (Python 3.6)."""
from __future__ import print_function

import hashlib
import json
import os
import re
import selectors
import stat
import subprocess
import sys
import time


BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
CONFIG_SHA = 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216'
CONFIG_SIZE = 3248
AUTH_SHA = 'ba18a23cd4ed6bde2b7bb0de3828af28e5e4613034739ef743ba8c64e2de5e7f'
AUTH_SIZE = 221
ORIGINAL_KEY_SHA = '271e1dda4bf551e051d19276be62b835530bd2a56570c2dcda4c1609e2f0672b'
BACKUP = 'sshd_config.fz3b-prehardening-20261016'
STAGE = '.sshd_config.fz3b-root-policy-stage-20261016'
ROLLBACK_STAGE = '.sshd_config.fz3b-rollback-stage-20261016'
SUFFIX = (b'\nMatch User root\n'
          b'    AuthenticationMethods publickey\n'
          b'    PasswordAuthentication no\n'
          b'    KbdInteractiveAuthentication no\n'
          b'    PermitRootLogin prohibit-password\n')
SSHD = '/usr/sbin/sshd'
SYSTEMCTL = '/bin/systemctl'
CONTEXTS = (
    ('root', '169.254.142.174', '169.254.142.174', '169.254.220.254'),
    ('root', 'host.example.invalid', '192.0.2.1', '169.254.220.254'),
    ('fz3b-nonroot-probe', '169.254.142.174', '169.254.142.174', '169.254.220.254'),
    ('fz3b-nonroot-probe', 'host.example.invalid', '192.0.2.1', '169.254.220.254'),
)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _flags():
    required = ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK')
    if not all(hasattr(os, name) for name in required):
        raise ValueError('safe-open-unavailable')
    return (os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK)


def _directory(parts):
    fd = os.open('/', _flags()[1])
    try:
        for part in parts:
            next_fd = os.open(part, _flags()[1], dir_fd=fd)
            os.close(fd)
            fd = next_fd
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError('unsafe-directory')
        return fd
    except BaseException:
        os.close(fd)
        raise


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _snapshot(directory, name, size, digest, mode):
    prior = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if (not stat.S_ISREG(prior.st_mode) or prior.st_nlink != 1 or prior.st_uid != 0 or
            prior.st_gid != 0 or stat.S_IMODE(prior.st_mode) != mode or prior.st_size != size):
        raise ValueError('file-metadata-mismatch')
    fd = os.open(name, _flags()[0], dir_fd=directory)
    try:
        opened = os.fstat(fd)
        if _identity(opened) != _identity(prior):
            raise ValueError('file-changed-before-read')
        data = bytearray()
        while len(data) <= size:
            piece = os.read(fd, size + 1 - len(data))
            if not piece:
                break
            data.extend(piece)
        if len(data) != size or _sha(data) != digest or _identity(os.fstat(fd)) != _identity(opened):
            raise ValueError('file-sha-or-race-mismatch')
        return bytes(data), opened
    finally:
        os.close(fd)


def _write_exclusive(directory, name, data, mode):
    fd = os.open(name, _flags()[2], mode, dir_fd=directory)
    try:
        os.fchmod(fd, mode)
        offset = 0
        while offset < len(data):
            count = os.write(fd, data[offset:])
            if count <= 0:
                raise OSError('short-write')
            offset += count
        os.fsync(fd)
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or
                stat.S_IMODE(info.st_mode) != mode or info.st_size != len(data)):
            raise ValueError('written-file-metadata-mismatch')
    finally:
        os.close(fd)


def _absent(directory, name):
    try:
        os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise ValueError('transaction-artifact-already-exists')


def _session_ok(value):
    parts = value.split() if isinstance(value, str) else []
    return (len(parts) == 4 and parts[0] == '169.254.142.174' and
            parts[2:] == ['169.254.220.254', '22'] and parts[1].isdigit() and
            1 <= int(parts[1]) <= 65535)


def _boot():
    fd = _directory(('proc', 'sys', 'kernel', 'random'))
    try:
        leaf = os.open('boot_id', _flags()[0], dir_fd=fd)
        try:
            value = os.read(leaf, 64).decode('ascii').strip()
        finally:
            os.close(leaf)
    finally:
        os.close(fd)
    if value != BOOT:
        raise ValueError('boot-mismatch')


def planned_bytes(original):
    if len(original) != CONFIG_SIZE or _sha(original) != CONFIG_SHA:
        raise ValueError('config-preimage-mismatch')
    active = [line.strip().split(None, 1)[0].lower() for line in original.splitlines()
              if line.strip() and not line.lstrip().startswith(b'#')]
    if b'match' in active or b'include' in active:
        raise ValueError('unexpected-config-structure')
    return original + SUFFIX


def _command(argv, seconds=5, limit=65536):
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
        deadline = time.monotonic() + seconds
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('command-deadline')
            for key, unused in selector.select(min(remaining, 0.2)):
                piece = os.read(key.fileobj.fileno(), 4096)
                if not piece:
                    selector.unregister(key.fileobj)
                    continue
                key.data.extend(piece)
                if len(out) + len(err) > limit:
                    raise ValueError('command-output-limit')
        code = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        return code, bytes(out), _sha(err)
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


def _service(runner):
    code, raw, ignored = runner((SYSTEMCTL, 'show', 'ssh.service', '--property=Id',
                                 '--property=FragmentPath', '--property=MainPID',
                                 '--property=ActiveState', '--property=LoadState',
                                 '--property=ExecReload'), 5, 8192)
    if code != 0:
        raise ValueError('service-query-failed')
    fields = {}
    reloads = []
    for line_number, line in enumerate(raw.decode('ascii').splitlines(), 1):
        key, separator, value = line.partition('=')
        if (line_number > 24 or not separator or len(value) > 1024 or
                any(ord(character) < 32 or ord(character) > 126 for character in value) or key not in (
                'Id', 'FragmentPath', 'MainPID', 'ActiveState', 'LoadState', 'ExecReload')):
            raise ValueError('unsafe-service-property')
        if key == 'ExecReload':
            reloads.append(value)
        elif key in fields:
            raise ValueError('duplicate-service-property')
        else:
            fields[key] = value
    if (set(fields) != {'Id', 'FragmentPath', 'MainPID', 'ActiveState', 'LoadState'} or
            fields['Id'] != 'ssh.service' or
            fields['FragmentPath'] != '/lib/systemd/system/ssh.service' or
            fields['ActiveState'] != 'active' or fields['LoadState'] != 'loaded' or
            not fields['MainPID'].isdigit() or int(fields['MainPID']) <= 0 or len(reloads) != 2 or
            not re.fullmatch(r'\{ path=/usr/sbin/sshd ; argv\[\]=/usr/sbin/sshd -t ; ignore_errors=no ; .{1,850} \}', reloads[0]) or
            not re.fullmatch(r'\{ path=/bin/kill ; argv\[\]=/bin/kill -HUP \$MAINPID ; ignore_errors=no ; .{1,850} \}', reloads[1])):
        raise ValueError('service-identity-mismatch')
    return int(fields['MainPID'])


def _effective(raw):
    values = {}
    if len(raw) > 65536:
        raise ValueError('effective-output-limit')
    for line_number, line in enumerate(raw.decode('ascii').splitlines(), 1):
        key, sep, value = line.partition(' ')
        if (line_number > 256 or not sep or not re.fullmatch(r'[a-z][a-z0-9]*', key) or
                not value or len(value) > 4096 or
                any(ord(character) < 32 or ord(character) > 126 for character in value)):
            raise ValueError('unsafe-effective-output')
        values.setdefault(key, []).append(value)
    return values


def _one(values, key):
    found = values.get(key, [])
    return found[0] if len(found) == 1 else None


def _context_arg(context):
    user, host, address, local_address = context
    return 'user={},host={},addr={},laddr={},lport=22'.format(user, host, address, local_address)


def _verify_candidate(runner, original_path, candidate_path):
    for path in (original_path, candidate_path):
        code, ignored, ignored_sha = runner((SSHD, '-t', '-f', path), 5, 8192)
        if code != 0:
            raise ValueError('sshd-syntax-failed')
    before_hashes = []
    after_hashes = []
    for context in CONTEXTS:
        outputs = []
        for path in (original_path, candidate_path):
            code, raw, ignored = runner((SSHD, '-T', '-f', path, '-C', _context_arg(context)),
                                        5, 65536)
            if code != 0:
                raise ValueError('sshd-effective-failed')
            outputs.append(raw)
        before, after = outputs
        if context[0] == 'root':
            base = _effective(before)
            changed = _effective(after)
            if (_one(base, 'pubkeyauthentication') != 'yes' or
                    _one(base, 'passwordauthentication') != 'yes' or
                    _one(base, 'permitrootlogin') != 'yes' or
                    _one(changed, 'pubkeyauthentication') != 'yes' or
                    _one(changed, 'authenticationmethods') != 'publickey' or
                    _one(changed, 'passwordauthentication') != 'no' or
                    _one(changed, 'kbdinteractiveauthentication') != 'no' or
                    _one(changed, 'permitrootlogin') not in ('without-password', 'prohibit-password')):
                raise ValueError('root-effective-policy-mismatch')
            allowed = {'authenticationmethods', 'passwordauthentication',
                       'kbdinteractiveauthentication', 'permitrootlogin'}
            if any(base.get(key) != changed.get(key) for key in set(base) | set(changed) if key not in allowed):
                raise ValueError('unplanned-root-effective-change')
        elif before != after:
            raise ValueError('nonroot-effective-change')
        before_hashes.append(_sha(before))
        after_hashes.append(_sha(after))
    return {'before': before_hashes, 'after': after_hashes}


def run(state, runner=_command, session=None):
    if session is None:
        session = os.environ.get('SSH_CONNECTION')
    if not _session_ok(session) or os.geteuid() != 0:
        raise ValueError('session-context-unverified')
    _boot()
    configdir = _directory(('etc', 'ssh'))
    try:
        sshdir = _directory(('root', '.ssh'))
        try:
            _snapshot(sshdir, 'authorized_keys', AUTH_SIZE, AUTH_SHA, 0o600)
            _snapshot(sshdir, 'authorized_keys.fz3b-prehardening-20261016',
                      107, ORIGINAL_KEY_SHA, 0o600)
        finally:
            os.close(sshdir)
        original, original_info = _snapshot(configdir, 'sshd_config', CONFIG_SIZE,
                                            CONFIG_SHA, 0o644)
        candidate = planned_bytes(original)
        candidate_sha = _sha(candidate)
        state['candidateSha256'] = candidate_sha
        _absent(configdir, BACKUP)
        _absent(configdir, STAGE)
        before_pid = _service(runner)
        state['phase'] = 'preflight-verified'
        _write_exclusive(configdir, BACKUP, original, 0o600)
        os.fsync(configdir)
        _snapshot(configdir, BACKUP, CONFIG_SIZE, CONFIG_SHA, 0o600)
        state['phase'] = 'backup-durable'
        _write_exclusive(configdir, STAGE, candidate, 0o644)
        _snapshot(configdir, STAGE, len(candidate), candidate_sha, 0o644)
        effective_hashes = _verify_candidate(runner, '/etc/ssh/sshd_config',
                                             '/etc/ssh/' + STAGE)['after']
        state['phase'] = 'candidate-validated'
        _snapshot(configdir, 'sshd_config', CONFIG_SIZE, CONFIG_SHA, 0o644)
        if _identity(os.stat('sshd_config', dir_fd=configdir, follow_symlinks=False)) != _identity(original_info):
            raise ValueError('config-changed-before-commit')
        _service(runner)
        state['phase'] = 'replace-started'
        os.replace(STAGE, 'sshd_config', src_dir_fd=configdir, dst_dir_fd=configdir)
        os.fsync(configdir)
        _snapshot(configdir, 'sshd_config', len(candidate), candidate_sha, 0o644)
        state['phase'] = 'config-replaced-durable'
        code, ignored, ignored_sha = runner((SSHD, '-t', '-f', '/etc/ssh/sshd_config'), 5, 8192)
        if code != 0:
            raise ValueError('committed-syntax-failed')
        for context, expected in zip(CONTEXTS, effective_hashes):
            code, raw, ignored_sha = runner((SSHD, '-T', '-f', '/etc/ssh/sshd_config',
                                             '-C', _context_arg(context)), 5, 65536)
            if code != 0 or _sha(raw) != expected:
                raise ValueError('committed-effective-mismatch')
        state['phase'] = 'reload-started'
        code, ignored, ignored_sha = runner((SYSTEMCTL, 'reload', 'ssh.service'), 15, 8192)
        if code != 0:
            raise ValueError('service-reload-failed')
        after_pid = _service(runner)
        _snapshot(configdir, 'sshd_config', len(candidate), candidate_sha, 0o644)
        _snapshot(configdir, BACKUP, CONFIG_SIZE, CONFIG_SHA, 0o600)
        sshdir = _directory(('root', '.ssh'))
        try:
            _snapshot(sshdir, 'authorized_keys', AUTH_SIZE, AUTH_SHA, 0o600)
        finally:
            os.close(sshdir)
        state['phase'] = 'reload-confirmed'
        return {'schemaVersion': 1, 'scope': 'fz3b-root-publickey-only-policy',
                'result': 'committed-reloaded', 'bootId': BOOT,
                'originalConfigSha256': CONFIG_SHA, 'originalConfigBytes': CONFIG_SIZE,
                'backupPath': '/etc/ssh/' + BACKUP, 'backupSha256': CONFIG_SHA,
                'candidateSha256': candidate_sha, 'candidateBytes': len(candidate),
                'authorizedSha256': AUTH_SHA, 'rootContextsChecked': 2,
                'nonrootContextsUnchanged': 2, 'serviceId': 'ssh.service',
                'serviceFragment': '/lib/systemd/system/ssh.service',
                'serviceAction': 'reload', 'servicePidBefore': before_pid,
                'servicePidAfter': after_pid, 'passwordRotated': False,
                'consolePasswordUnchanged': True, 'remotePasswordLoginPostchecked': False}
    finally:
        os.close(configdir)


def rollback(state, runner=_command, session=None):
    if session is None:
        session = os.environ.get('SSH_CONNECTION')
    if not _session_ok(session) or os.geteuid() != 0:
        raise ValueError('session-context-unverified')
    _boot()
    configdir = _directory(('etc', 'ssh'))
    try:
        sshdir = _directory(('root', '.ssh'))
        try:
            _snapshot(sshdir, 'authorized_keys', AUTH_SIZE, AUTH_SHA, 0o600)
            _snapshot(sshdir, 'authorized_keys.fz3b-prehardening-20261016',
                      107, ORIGINAL_KEY_SHA, 0o600)
        finally:
            os.close(sshdir)
        original, ignored = _snapshot(configdir, BACKUP, CONFIG_SIZE, CONFIG_SHA, 0o600)
        candidate = planned_bytes(original)
        candidate_sha = _sha(candidate)
        state['candidateSha256'] = candidate_sha
        current, current_info = _snapshot(configdir, 'sshd_config', len(candidate),
                                          candidate_sha, 0o644)
        if current != candidate:
            raise ValueError('rollback-preimage-mismatch')
        _absent(configdir, ROLLBACK_STAGE)
        before_pid = _service(runner)
        state['phase'] = 'rollback-preflight-verified'
        _write_exclusive(configdir, ROLLBACK_STAGE, original, 0o644)
        _snapshot(configdir, ROLLBACK_STAGE, CONFIG_SIZE, CONFIG_SHA, 0o644)
        baseline_hashes = _verify_candidate(runner, '/etc/ssh/' + ROLLBACK_STAGE,
                                            '/etc/ssh/sshd_config')['before']
        state['phase'] = 'rollback-stage-validated'
        _snapshot(configdir, 'sshd_config', len(candidate), candidate_sha, 0o644)
        if _identity(os.stat('sshd_config', dir_fd=configdir, follow_symlinks=False)) != _identity(current_info):
            raise ValueError('config-changed-before-commit')
        _service(runner)
        state['phase'] = 'rollback-replace-started'
        os.replace(ROLLBACK_STAGE, 'sshd_config', src_dir_fd=configdir, dst_dir_fd=configdir)
        os.fsync(configdir)
        _snapshot(configdir, 'sshd_config', CONFIG_SIZE, CONFIG_SHA, 0o644)
        state['phase'] = 'rollback-config-replaced-durable'
        code, ignored, ignored_sha = runner((SSHD, '-t', '-f', '/etc/ssh/sshd_config'), 5, 8192)
        if code != 0:
            raise ValueError('committed-syntax-failed')
        for context, expected_baseline in zip(CONTEXTS, baseline_hashes):
            code, raw, ignored_sha = runner((SSHD, '-T', '-f', '/etc/ssh/sshd_config',
                                             '-C', _context_arg(context)), 5, 65536)
            if code != 0:
                raise ValueError('committed-effective-mismatch')
            if _sha(raw) != expected_baseline:
                raise ValueError('rollback-restored-effective-mismatch')
            if context[0] == 'root':
                restored = _effective(raw)
                if (_one(restored, 'passwordauthentication') != 'yes' or
                        _one(restored, 'permitrootlogin') != 'yes' or
                        _one(restored, 'pubkeyauthentication') != 'yes'):
                    raise ValueError('rollback-root-effective-mismatch')
        state['phase'] = 'rollback-reload-started'
        code, ignored, ignored_sha = runner((SYSTEMCTL, 'reload', 'ssh.service'), 15, 8192)
        if code != 0:
            raise ValueError('service-reload-failed')
        after_pid = _service(runner)
        _snapshot(configdir, 'sshd_config', CONFIG_SIZE, CONFIG_SHA, 0o644)
        _snapshot(configdir, BACKUP, CONFIG_SIZE, CONFIG_SHA, 0o600)
        sshdir = _directory(('root', '.ssh'))
        try:
            _snapshot(sshdir, 'authorized_keys', AUTH_SIZE, AUTH_SHA, 0o600)
        finally:
            os.close(sshdir)
        state['phase'] = 'rollback-reload-confirmed'
        return {'schemaVersion': 1, 'scope': 'fz3b-root-policy-rollback',
                'result': 'original-restored-reloaded', 'bootId': BOOT,
                'restoredConfigSha256': CONFIG_SHA, 'restoredConfigBytes': CONFIG_SIZE,
                'backupPath': '/etc/ssh/' + BACKUP, 'backupSha256': CONFIG_SHA,
                'priorCandidateSha256': candidate_sha, 'priorCandidateBytes': len(candidate),
                'authorizedSha256': AUTH_SHA, 'rootContextsChecked': 2,
                'nonrootContextsUnchanged': 2, 'serviceId': 'ssh.service',
                'serviceFragment': '/lib/systemd/system/ssh.service',
                'serviceAction': 'reload', 'servicePidBefore': before_pid,
                'servicePidAfter': after_pid, 'passwordRotated': False,
                'remoteRootPasswordRouteRestored': True,
                'independentLoginPostchecked': False}
    finally:
        os.close(configdir)


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv not in ([], ['--rollback']):
        raise SystemExit('no arguments accepted')
    state = {'phase': 'start', 'candidateSha256': None}
    try:
        result = rollback(state) if argv == ['--rollback'] else run(state)
    except Exception as error:
        allowed = {'session-context-unverified', 'boot-mismatch', 'file-metadata-mismatch',
                   'file-changed-before-read', 'file-sha-or-race-mismatch',
                   'config-preimage-mismatch', 'unexpected-config-structure',
                   'transaction-artifact-already-exists', 'service-query-failed',
                   'unsafe-service-property', 'duplicate-service-property',
                   'service-identity-mismatch', 'sshd-syntax-failed',
                   'sshd-effective-failed', 'root-effective-policy-mismatch',
                   'unplanned-root-effective-change', 'nonroot-effective-change',
                   'config-changed-before-commit', 'committed-syntax-failed',
                   'committed-effective-mismatch', 'service-reload-failed',
                   'command-deadline', 'command-output-limit', 'unsafe-effective-output',
                   'effective-output-limit', 'safe-open-unavailable', 'unsafe-directory',
                   'written-file-metadata-mismatch', 'rollback-preimage-mismatch',
                   'rollback-restored-effective-mismatch', 'rollback-root-effective-mismatch'}
        code = str(error) if isinstance(error, ValueError) and str(error) in allowed else 'unclassified'
        result = {'schemaVersion': 1, 'scope': 'fz3b-root-policy-diagnostic',
                  'result': 'failed-or-unknown', 'phase': state['phase'],
                  'candidateSha256': state['candidateSha256'], 'errorType': type(error).__name__,
                  'errorCode': code, 'operation': 'rollback' if argv else 'apply',
                  'automaticRetry': False, 'automaticRollback': False}
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
        return 1
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
