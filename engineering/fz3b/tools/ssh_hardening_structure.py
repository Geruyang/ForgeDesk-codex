"""One-shot, read-only sshd_config structure report for the pinned FZ3B image."""
from __future__ import print_function

import hashlib
import json
import os
import re
import stat
import sys


CONFIG_SHA256 = 'bae6f2e66ff600c41e1b8acb3ab4ce083a5908781f0b0f0ba38da86d4fdef216'
CONFIG_BYTES = 3248
AUTH_KEYS = frozenset(('pubkeyauthentication', 'passwordauthentication',
                       'challengeresponseauthentication', 'kbdinteractiveauthentication',
                       'permitrootlogin', 'authenticationmethods', 'authorizedkeysfile',
                       'usepam', 'permitemptypasswords'))
EXPECTED_CONNECTION = ('169.254.142.174', '169.254.220.254', '22')
KEY = re.compile(r'^[A-Za-z][A-Za-z0-9]*$')
SAFE_VALUE = re.compile(r'^[A-Za-z0-9,._/+*@:=!%-]{1,256}(?: [A-Za-z0-9,._/+*@:=!%-]{1,256})*$')


def read_config():
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory = os.open('/', flags)
    try:
        for part in ('etc', 'ssh'):
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        prior = os.stat('sshd_config', dir_fd=directory, follow_symlinks=False)
        if (not stat.S_ISREG(prior.st_mode) or prior.st_nlink != 1 or
                prior.st_uid != 0 or prior.st_gid != 0 or prior.st_size != CONFIG_BYTES):
            raise ValueError('config-metadata-mismatch')
        fd = os.open('sshd_config', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory)
        try:
            opened = os.fstat(fd)
            if (opened.st_dev, opened.st_ino, opened.st_size) != (prior.st_dev, prior.st_ino, prior.st_size):
                raise ValueError('config-changed-before-read')
            data = os.read(fd, CONFIG_BYTES + 1)
            if (len(data) != CONFIG_BYTES or os.read(fd, 1) or
                    hashlib.sha256(data).hexdigest() != CONFIG_SHA256):
                raise ValueError('config-sha-or-size-mismatch')
            after = os.fstat(fd)
            if (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
                    opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns):
                raise ValueError('config-changed-during-read')
            return data
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def session_matches(value):
    if not isinstance(value, str):
        return False
    parts = value.split()
    return (len(parts) == 4 and parts[0] == EXPECTED_CONNECTION[0] and
            parts[2:] == list(EXPECTED_CONNECTION[1:]) and parts[1].isdigit() and
            1 <= int(parts[1]) <= 65535)


def describe(data, session):
    if len(data) != CONFIG_BYTES or hashlib.sha256(data).hexdigest() != CONFIG_SHA256:
        raise ValueError('config-sha-or-size-mismatch')
    directives = []
    for number, raw in enumerate(data.splitlines(), 1):
        try:
            line = raw.decode('ascii').strip()
        except UnicodeDecodeError:
            raise ValueError('non-ascii-config')
        if not line or line.startswith('#'):
            continue
        name, separator, value = line.partition(' ')
        if not separator:
            name, separator, value = line.partition('\t')
        if not separator or not KEY.fullmatch(name):
            raise ValueError('unexpected-directive-shape')
        value = value.strip()
        if not value:
            raise ValueError('empty-directive-value')
        item = {'line': number, 'key': name.lower(),
                'valueSha256': hashlib.sha256(value.encode('ascii')).hexdigest()}
        if item['key'] == 'match':
            if not SAFE_VALUE.fullmatch(value):
                raise ValueError('unsafe-match-value')
            item['matchCriteria'] = value
        elif item['key'] in AUTH_KEYS:
            if SAFE_VALUE.fullmatch(value):
                item['authValue'] = value
            else:
                item['authValueOmitted'] = True
        directives.append(item)
    matches = [entry for entry in directives if entry['key'] == 'match']
    return {'schemaVersion': 1, 'scope': 'fz3b-sshd-config-structure-readonly',
            'readOnly': True, 'configurationChanged': False, 'configSha256': CONFIG_SHA256,
            'configBytes': CONFIG_BYTES, 'sessionContextMatches': session_matches(session),
            'matchCount': len(matches),
            'includeCount': sum(entry['key'] == 'include' for entry in directives),
            'directives': directives, 'contentOmittedExceptMatchAndAuthValues': True}


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        raise SystemExit('no arguments accepted')
    result = describe(read_config(), os.environ.get('SSH_CONNECTION'))
    print(json.dumps(result, sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
