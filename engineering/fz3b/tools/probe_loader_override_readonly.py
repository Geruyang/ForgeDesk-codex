"""Fixed read-only diagnosis of the retained RTL loader override (Python 3.6)."""
from __future__ import print_function

import hashlib
import json
import math
import os
import re
import stat
import subprocess
import sys


UNIT = '/etc/systemd/system/fz3b-pl-loader.service'
DROPIN = '/etc/systemd/system/fz3b-pl-loader.service.d/rtl-optim-retained.conf'
LOADER = '/root/workspace/network10-v10.5-pl-loader/fz3b_pl_loader.py'
CONFIG = '/root/rtl_optim-board-20261010/candidate008/rtl-loader-config.json'
LOG = '/root/rtl_optim-board-20261010/candidate008/deployment/loader-events.jsonl'
CONFIG_SHA_PUBLISHED = '10d5878bcc40278f47995453662099fdc5814ed42fbd68973c1161a5664c81c8'
EXPECTED_DROPIN = ('[Service]\nExecStart=\nExecStart=/usr/bin/python3 -B ' + LOADER +
                   ' daemon --config ' + CONFIG + ' --auto-target a0005 --log ' + LOG + '\n')
EXPECTED_ARGV = ('/usr/bin/python3 -B ' + LOADER + ' daemon --config ' + CONFIG +
                 ' --auto-target a0005 --log ' + LOG)
ASSET_LABELS = ('a0005_driver_ko', 'a0005_dtbo', 'a0005_firmware', 'a0005_native_bin',
                'a0005_source_bit', 'admission', 'combined_manifest', 'factory_driver_ko',
                'factory_firmware', 'factory_native_source', 'lease_ko', 'range_proof')
SHA = re.compile(r'^[0-9a-f]{64}$')
SHOW = ('/bin/systemctl', 'show', 'fz3b-pl-loader.service', '--no-pager',
        '--property=ActiveState,SubState,MainPID,FragmentPath,DropInPaths,ExecStart')
SHOW_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C',
            'SYSTEMD_PAGER': 'cat', 'SYSTEMD_COLORS': '0'}


class ProbeError(Exception):
    pass


def read_fixed(path, cap):
    if not all(hasattr(os, flag) for flag in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK')):
        raise ProbeError('safe-open-unavailable')
    parts = path[1:].split('/')
    if not path.startswith('/') or any(part in ('', '.', '..') for part in parts):
        raise ProbeError('unsafe-fixed-path')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    parent = os.open('/', flags)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, flags, dir_fd=parent)
            os.close(parent)
            parent = next_fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > cap:
            raise ProbeError('regular-file-or-limit-required')
        data = bytearray()
        while len(data) <= cap:
            chunk = os.read(fd, min(65536, cap + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > cap:
            raise ProbeError('file-limit-exceeded')
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise ProbeError('file-changed')
        return bytes(data)
    finally:
        os.close(fd)


def service():
    completed = subprocess.run(list(SHOW), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=dict(SHOW_ENV), shell=False,
                               close_fds=True, timeout=5, check=False)
    if completed.returncode or len(completed.stdout) > 32768:
        raise ProbeError('service-show-failed')
    result = {}
    for line in completed.stdout.decode('utf-8').splitlines():
        key, sep, value = line.partition('=')
        if sep and key in ('ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths', 'ExecStart'):
            if key in result:
                raise ProbeError('duplicate-service-property')
            result[key] = value
    return result


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ProbeError('duplicate-json-key')
        result[key] = value
    return result


def _constant(value):
    raise ProbeError('nonfinite-json')


def _float(value):
    if len(value) > 64:
        raise ProbeError('json-number-limit')
    result = float(value)
    if not math.isfinite(result):
        raise ProbeError('nonfinite-json')
    return result


def _int(value):
    if len(value) > 64:
        raise ProbeError('json-number-limit')
    return int(value)


def summarize_config(data):
    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=_pairs,
                           parse_constant=_constant, parse_float=_float, parse_int=_int)
    except (UnicodeError, ValueError, RecursionError):
        raise ProbeError('invalid-config-json')
    if not isinstance(value, dict) or not isinstance(value.get('assets'), dict):
        raise ProbeError('invalid-config-schema')
    assets = value['assets']
    records = []
    for label in ASSET_LABELS:
        item = assets.get(label)
        if not isinstance(item, dict):
            raise ProbeError('missing-asset:' + label)
        path, size, digest = item.get('path'), item.get('bytes'), item.get('sha256')
        if (type(path) is not str or not path.startswith('/') or len(path) > 256 or
                any(ord(char) < 32 or ord(char) > 126 for char in path) or
                type(size) is not int or size < 0 or type(digest) is not str or
                not SHA.fullmatch(digest.lower())):
            raise ProbeError('invalid-asset:' + label)
        records.append({'label': label, 'path': path, 'bytes': size, 'sha256': digest.lower()})
    return {'schema': value.get('schema') if type(value.get('schema')) is str else None,
            'assetSetMatchesPublished': set(assets) == set(ASSET_LABELS), 'assets': records,
            'otherConfigContentOmitted': True}


def collect(reader=read_fixed, show=service):
    result = {'schemaVersion': 1, 'scope': 'fixed-loader-override-readonly',
              'serviceActions': 'not-attempted', 'programming': 'not-attempted',
              'deviceOpen': False, 'issues': []}
    try:
        state = show()
        result['service'] = {key: state.get(key) for key in
                             ('ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths')}
        if state.get('FragmentPath') != UNIT or state.get('DropInPaths') != DROPIN:
            raise ProbeError('unreviewed-unit-or-dropins')
        command = state.get('ExecStart', '')
        result['service']['effectiveExecStartSha256'] = hashlib.sha256(command.encode('utf-8')).hexdigest()
        result['service']['effectiveExecStartMatchesPublished'] = (
            len(command) <= 4096 and all(32 <= ord(char) < 127 for char in command) and
            ('argv[]=' + EXPECTED_ARGV + ' ;') in command)
        if result['service']['effectiveExecStartMatchesPublished']:
            result['service']['effectiveExecStart'] = command
        else:
            result['issues'].append('effective-execstart-not-published')
        data = reader(DROPIN, 8192)
        sha = hashlib.sha256(data).hexdigest()
        result['dropIn'] = {'path': DROPIN, 'bytes': len(data), 'sha256': sha,
                            'matchesPublishedTemplate': data == EXPECTED_DROPIN.encode('ascii')}
        if result['dropIn']['matchesPublishedTemplate']:
            result['dropIn']['content'] = EXPECTED_DROPIN
        else:
            result['issues'].append('dropin-not-published-template-content-omitted')
        if not result['service']['effectiveExecStartMatchesPublished']:
            raise ProbeError('config-read-held-by-effective-execstart')
        data = reader(CONFIG, 65536)
        sha = hashlib.sha256(data).hexdigest()
        result['config'] = {'path': CONFIG, 'bytes': len(data), 'sha256': sha,
                            'matchesPublishedSha256': sha == CONFIG_SHA_PUBLISHED}
        result['config'].update(summarize_config(data))
        if not result['config']['matchesPublishedSha256'] or not result['config']['assetSetMatchesPublished']:
            result['issues'].append('config-not-published')
    except Exception as error:
        result['issues'].append(str(error) if isinstance(error, ProbeError) else type(error).__name__)
    result['result'] = 'diagnostic-matches-published' if not result['issues'] else 'hold'
    result['limitations'] = ['This is a read-only diagnostic, not approval of a systemd override.',
                             'No loader command, service action, PL programming, or inference was attempted.']
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
