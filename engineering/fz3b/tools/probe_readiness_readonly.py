"""Fixed FZ3B readiness metadata/source probe, Python 3.6 standard library.

Root may run reviewed bytes through SSH with python3 -B - on stdin. No arbitrary
arguments, service action, application import, network, compute or programming.
"""
from __future__ import print_function

import argparse
import hashlib
import ipaddress
import json
import os
import re
import stat
import subprocess
import sys

PROJECT = '/root/fz3b-vision-console-20261009-001'
CONTENT_FILES = ('/etc/systemd/system/fz3b-vision-console.service', PROJECT + '/run.sh',
                 PROJECT + '/vision_app/link_setup.py',
                 '/root/workspace/network10-v10.5-pl-loader/fz3b_pl_loader.py')
APP_FILES = tuple(PROJECT + '/vision_app/' + name for name in
                  ('board_agent.py', 'protocol.py', 'camera.py', 'upload_source.py',
                   'image_boundary.py', 'board_runtime.py', 'semantic-contract.json'))
CONFIG = PROJECT + '/config.json'
BOOT_ID = '/proc/sys/kernel/random/boot_id'
SINGLE_LIMIT = 256 * 1024
TOTAL_LIMIT = 512 * 1024
CONFIG_LIMIT = 64 * 1024
SYSTEMCTL_LIMIT = 64 * 1024
PROPERTIES = ('ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths',
              'ExecStart', 'ExecStartPre', 'Requires', 'After', 'TimeoutStopUSec', 'SendSIGKILL')
SYSTEMCTL = ('/bin/systemctl', 'show', 'fz3b-vision-console.service', '--no-pager',
             '--property=' + ','.join(PROPERTIES))
CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C',
             'SYSTEMD_PAGER': 'cat', 'SYSTEMD_COLORS': '0'}
FILE_LIMITS = dict((path, SINGLE_LIMIT) for path in CONTENT_FILES + APP_FILES)
FILE_LIMITS.update({CONFIG: CONFIG_LIMIT, BOOT_ID: 4096})


class ProbeError(Exception):
    pass


def _directory(parts):
    if any(not hasattr(os, name) for name in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK')):
        raise ProbeError('safe-linux-open-unavailable')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    current = os.open('/', flags)
    try:
        for part in parts:
            opened = os.open(part, flags, dir_fd=current)
            os.close(current)
            current = opened
        return current
    except Exception:
        os.close(current)
        raise


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, getattr(info, 'st_mtime_ns', info.st_mtime),
            getattr(info, 'st_ctime_ns', info.st_ctime))


def read_fixed(path, limit):
    if path not in FILE_LIMITS or not 0 < limit <= FILE_LIMITS[path]:
        raise ProbeError('path-or-limit-not-allowed')
    parts = path.strip('/').split('/')
    parent = _directory(parts[:-1])
    leaf = None
    try:
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(leaf)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ProbeError('regular-unlinked-file-required')
        if before.st_size < 0 or before.st_size > limit:
            raise ProbeError('file-limit-exceeded')
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(leaf, min(16384, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > limit:
            raise ProbeError('file-limit-exceeded')
        if _identity(before) != _identity(os.fstat(leaf)):
            raise ProbeError('file-changed')
        return bytes(data)
    finally:
        if leaf is not None:
            os.close(leaf)
        os.close(parent)


def service_show():
    result = subprocess.run(list(SYSTEMCTL), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=dict(CHILD_ENV), shell=False,
                            close_fds=True, timeout=5, check=False)
    if result.returncode != 0:
        raise ProbeError('systemctl-show-failed')
    if len(result.stdout) > SYSTEMCTL_LIMIT:
        raise ProbeError('systemctl-output-too-large')
    try:
        text = result.stdout.decode('utf-8')
    except UnicodeError:
        raise ProbeError('systemctl-invalid-utf8')
    properties = {}
    for line in text.splitlines():
        key, separator, value = line.partition('=')
        if key in PROPERTIES and separator:
            if key in properties:
                raise ProbeError('systemctl-duplicate-property')
            properties[key] = value
    return {'status': 'collected', 'properties': properties,
            'missingProperties': [key for key in PROPERTIES if key not in properties]}


def config_summary(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ProbeError('duplicate-config-key')
            result[key] = value
        return result

    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=pairs)
    except (UnicodeError, ValueError, RecursionError):
        raise ProbeError('invalid-config-json')
    result = {'jsonType': 'object' if isinstance(value, dict) else 'non-object', 'fields': {}, 'otherContentOmitted': True}
    if not isinstance(value, dict):
        return result
    for key in ('bind', 'control_host', 'video_host'):
        if key in value:
            field = {'type': type(value[key]).__name__}
            try:
                if not isinstance(value[key], str):
                    raise ValueError()
                if key != 'bind' and value[key] == 'localhost':
                    field['value'] = 'localhost'
                else:
                    field['value'] = str(ipaddress.ip_address(value[key]))
            except ValueError:
                field['valueOmitted'] = True
            result['fields'][key] = field
    for key in ('control_port', 'video_port'):
        if key in value:
            field = {'type': type(value[key]).__name__}
            if type(value[key]) is int and 1 <= value[key] <= 65535:
                field['value'] = value[key]
            else:
                field['valueOmitted'] = True
            result['fields'][key] = field
    return result


class SystemAccess(object):
    def read(self, path, limit):
        return read_fixed(path, limit)

    def service(self):
        return service_show()

    def uname(self):
        info = os.uname()
        return {'sysname': info.sysname, 'release': info.release, 'machine': info.machine}

    def disk(self):
        directory = _directory(PROJECT.strip('/').split('/'))
        try:
            info = os.fstatvfs(directory)
            return {'path': PROJECT, 'totalBytes': info.f_blocks * info.f_frsize,
                    'availableBytes': info.f_bavail * info.f_frsize, 'freeBytes': info.f_bfree * info.f_frsize}
        finally:
            os.close(directory)


def error_summary(error):
    if isinstance(error, ProbeError):
        return {'status': 'unavailable', 'code': str(error)}
    if isinstance(error, FileNotFoundError):
        return {'status': 'absent'}
    return {'status': 'unavailable', 'code': type(error).__name__, 'errno': getattr(error, 'errno', None)}


def collect(access=None):
    access = SystemAccess() if access is None else access
    result = {'schemaVersion': 1, 'scope': 'fixed-fz3b-readonly-readiness', 'result': 'collected-readonly',
              'compute': 'not-attempted', 'programming': 'not-attempted', 'serviceActions': 'not-attempted',
              'applicationImported': False, 'contentFiles': [], 'applicationHashes': [],
              'limits': {'singleFileBytes': SINGLE_LIMIT, 'totalFileReadBytes': TOTAL_LIMIT},
              'limitations': ['Readiness metadata/source only; not compute, programming, deployment or installed-product acceptance.',
                              'Only explicitly fixed code/unit files have content; config/environment/auth/license bodies are not emitted.']}
    used = [0]

    def read(path):
        remaining = TOTAL_LIMIT - used[0]
        if remaining <= 0:
            raise ProbeError('aggregate-file-budget-exhausted')
        limit = min(FILE_LIMITS[path], remaining)
        data = access.read(path, limit)
        if not isinstance(data, bytes) or len(data) > limit:
            raise ProbeError('file-limit-exceeded')
        used[0] += len(data)
        return data

    for key, method in (('uname', access.uname), ('disk', access.disk), ('service', access.service)):
        try:
            result[key] = method()
        except Exception as error:
            result[key] = error_summary(error)
    for path in CONTENT_FILES + APP_FILES + (CONFIG, BOOT_ID):
        item = {'path': path}
        try:
            data = read(path)
            item.update(status='present', bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            if path in CONTENT_FILES:
                item['content'] = data.decode('utf-8')
            elif path == CONFIG:
                item['config'] = config_summary(data)
            elif path == BOOT_ID:
                text = data.decode('ascii').strip()
                if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', text):
                    raise ProbeError('invalid-boot-id')
                item['value'] = text
        except Exception as error:
            item.update(error_summary(error))
        if path in CONTENT_FILES:
            result['contentFiles'].append(item)
        elif path in APP_FILES:
            result['applicationHashes'].append(item)
        else:
            result['config' if path == CONFIG else 'bootId'] = item
    result['totalFileReadBytes'] = used[0]
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(argv)
    print(json.dumps(collect(), sort_keys=True, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
