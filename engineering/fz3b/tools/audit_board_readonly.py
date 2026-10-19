"""Fixed-path metadata audit for root to execute over normal SSH on Python 3.6.

No application/loader imports, child processes, service actions, TCP or devices.
The optional Unix status query reaches the existing daemon; it starts no daemon.
"""
from __future__ import print_function

import argparse
import hashlib
import ipaddress
import json
import os
import re
import socket
import stat
import sys
import time

PROJECT = '/root/fz3b-vision-console-20261009-001'
PATCH_NAMES = ('board_agent.py', 'protocol.py', 'camera.py', 'upload_source.py',
               'image_boundary.py', 'board_runtime.py', 'semantic-contract.json')
PATCH_PATHS = tuple(PROJECT + '/vision_app/' + name for name in PATCH_NAMES)
CONFIG_PATH = PROJECT + '/config.json'
MODEL_PATH = '/sys/firmware/devicetree/base/model'
COMPATIBLE_PATH = '/sys/firmware/devicetree/base/compatible'
DEVICE_TREE_ALIASES = {MODEL_PATH: '/proc/device-tree/model', COMPATIBLE_PATH: '/proc/device-tree/compatible'}
BOOT_PATH = '/proc/sys/kernel/random/boot_id'
FPGA_PATH = '/sys/class/fpga_manager/fpga0/state'
SOCKET_PATH = '/run/fz3b-pl-loader/control.sock'
FILE_LIMIT = 512 * 1024
CONFIG_LIMIT = 64 * 1024
TEXT_LIMIT = 4096
LOADER_LIMIT = 64 * 1024
LOADER_SECONDS = 5.0
STATUS_REQUEST = b'{"command":"status"}\n'
ALLOWED_FILES = frozenset(PATCH_PATHS + (CONFIG_PATH, MODEL_PATH, COMPATIBLE_PATH, BOOT_PATH, FPGA_PATH))


class ProbeError(Exception):
    pass


def _snapshot(info):
    return (info.st_dev, info.st_ino, info.st_size,
            getattr(info, 'st_mtime_ns', info.st_mtime),
            getattr(info, 'st_ctime_ns', info.st_ctime))


def read_allowed_file(path, limit):
    """Walk exact approved components with O_NOFOLLOW; never resolve kernel aliases."""
    if path not in ALLOWED_FILES:
        raise ProbeError('path-not-allowed')
    expected_limit = FILE_LIMIT if path in PATCH_PATHS else CONFIG_LIMIT if path == CONFIG_PATH else TEXT_LIMIT
    if limit != expected_limit:
        raise ProbeError('read-limit-not-allowed')
    required = ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK')
    if any(not hasattr(os, flag) for flag in required):
        raise ProbeError('linux-safe-open-unavailable')
    directory = None
    leaf = None
    try:
        directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        parts = path.strip('/').split('/')
        for component in parts[:-1]:
            opened = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory)
            os.close(directory)
            directory = opened
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(leaf)
        if not stat.S_ISREG(before.st_mode):
            raise ProbeError('not-regular-file')
        if before.st_size < 0 or before.st_size > limit:
            raise ProbeError('file-too-large')
        if path.startswith(PROJECT + '/') and before.st_nlink != 1:
            raise ProbeError('linked-project-file')
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(leaf, min(16384, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > limit:
            raise ProbeError('file-too-large')
        if _snapshot(before) != _snapshot(os.fstat(leaf)):
            raise ProbeError('file-changed-during-read')
        return bytes(data)
    finally:
        if leaf is not None:
            os.close(leaf)
        if directory is not None:
            os.close(directory)


def _unique_object(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ProbeError('duplicate-json-key')
        result[key] = value
    return result


def _json(data):
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ProbeError('nonfinite-json')))
    except (UnicodeError, ValueError, RecursionError):
        raise ProbeError('invalid-json')


def config_summary(data):
    value = _json(data)
    summary = {'jsonType': 'object' if isinstance(value, dict) else 'non-object',
               'fields': {}, 'otherContentOmitted': True}
    if not isinstance(value, dict):
        return summary
    if 'bind' in value:
        bind = value['bind']
        field = {'type': type(bind).__name__}
        try:
            if not isinstance(bind, str):
                raise ValueError()
            address = ipaddress.ip_address(bind)
            field.update(value=str(address), loopback=address.is_loopback, unspecified=address.is_unspecified)
        except ValueError:
            field['validLiteralIp'] = False
        summary['fields']['bind'] = field
    for key in ('control_port', 'video_port'):
        if key in value:
            port = value[key]
            field = {'type': type(port).__name__, 'validPort': type(port) is int and 1 <= port <= 65535}
            if field['validPort']:
                field['value'] = port
            summary['fields'][key] = field
    return summary


def _check_socket():
    if os.path.realpath(SOCKET_PATH) != SOCKET_PATH or not stat.S_ISSOCK(os.lstat(SOCKET_PATH).st_mode):
        raise ProbeError('unexpected-loader-socket')


def query_loader_status(socket_factory=socket.socket, monotonic=time.monotonic, check_socket=_check_socket):
    deadline = monotonic() + LOADER_SECONDS
    link = None

    def remaining():
        seconds = deadline - monotonic()
        if seconds <= 0:
            raise ProbeError('loader-deadline')
        return seconds

    try:
        check_socket()
        remaining()
        link = socket_factory(socket.AF_UNIX, socket.SOCK_STREAM)
        link.settimeout(remaining())
        link.connect(SOCKET_PATH)
        link.settimeout(remaining())
        link.sendall(STATUS_REQUEST)
        data = bytearray()
        while True:
            link.settimeout(remaining())
            chunk = link.recv(min(4096, LOADER_LIMIT + 1 - len(data)))
            remaining()
            if not chunk:
                raise ProbeError('loader-truncated-reply')
            data.extend(chunk)
            if len(data) > LOADER_LIMIT:
                raise ProbeError('loader-reply-too-large')
            if b'\n' in data:
                if data.find(b'\n') != len(data) - 1:
                    raise ProbeError('loader-extra-data')
                break
        value = _json(bytes(data))
        remaining()
        if not isinstance(value, dict) or type(value.get('ok')) is not bool or not isinstance(value.get('result'), dict):
            raise ProbeError('loader-invalid-envelope')
        original = value['result']
        result = {'ok': value['ok'], 'responseBytes': len(data),
                  'responseSha256': hashlib.sha256(data).hexdigest(), 'otherContentOmitted': True}
        # Exclude raw errors, asset paths, lease details and all unknown fields.
        for key in ('schema', 'status', 'target'):
            item = original.get(key)
            if isinstance(item, str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', item):
                result[key] = item
        if type(original.get('ready')) is bool:
            result['ready'] = original['ready']
        observed = original.get('observed')
        if isinstance(observed, dict):
            for key in ('detected_target', 'manager_state'):
                item = observed.get(key)
                if isinstance(item, str) and re.fullmatch(r'[a-zA-Z0-9 _.-]{1,80}', item):
                    result[key] = item
        result['reportedFailure'] = original.get('failure') is not None
        result['observedError'] = original.get('observed_error') is not None
        return result
    except socket.timeout:
        raise ProbeError('loader-deadline')
    finally:
        if link is not None:
            link.close()


class SystemAccess(object):
    def uname(self):
        info = os.uname()
        return {'sysname': info.sysname, 'release': info.release, 'machine': info.machine}

    def read_file(self, path, limit):
        return read_allowed_file(path, limit)

    def loader_status(self):
        return query_loader_status()


def _error(error):
    # Error strings can contain config/daemon data; emit fixed codes and errno only.
    if isinstance(error, ProbeError):
        return {'status': 'error', 'code': str(error)}
    if isinstance(error, FileNotFoundError):
        return {'status': 'absent'}
    return {'status': 'error', 'code': type(error).__name__, 'errno': getattr(error, 'errno', None)}


def collect(include_loader_status=False, access=None):
    access = SystemAccess() if access is None else access
    result = {'schemaVersion': 1, 'scope': 'fixed-fz3b-ssh-metadata-audit', 'result': 'collected-readonly',
              'compute': 'not-attempted', 'programming': 'not-attempted', 'applicationImported': False,
              'serviceActions': 'not-attempted', 'serviceStatus': 'not-collected',
              'authenticationFilesRead': False, 'loaderStatusRequested': include_loader_status,
              'files': [], 'limitations': ['Metadata is not authenticated chip/firmware identity.',
                                         'No compute, deployment, programming or installed-product acceptance.',
                                         'Optional status reaches the existing loader daemon and may perform daemon-side hardware reads.']}
    try:
        result['uname'] = access.uname()
    except Exception as error:
        result['uname'] = _error(error)
    for key, path in (('model', MODEL_PATH), ('compatible', COMPATIBLE_PATH), ('bootId', BOOT_PATH), ('fpgaManagerState', FPGA_PATH)):
        try:
            data = access.read_file(path, TEXT_LIMIT)
            text = data.decode('utf-8').strip('\0\r\n')
            if key == 'bootId' and not re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', text):
                raise ProbeError('invalid-boot-id')
            if len(text) > 1024 or any(ord(char) < 32 and char != '\0' for char in text):
                raise ProbeError('invalid-system-text')
            result[key] = {'path': path, 'status': 'present', 'value': text.split('\0') if key == 'compatible' else text}
        except Exception as error:
            result[key] = dict(_error(error), path=path)
            result[key]['status'] = 'unavailable'
        if path in DEVICE_TREE_ALIASES:
            result[key].update(requestedAlias=DEVICE_TREE_ALIASES[path], aliasUsed=False)
    for path in PATCH_PATHS + (CONFIG_PATH,):
        item = {'path': path}
        try:
            data = access.read_file(path, CONFIG_LIMIT if path == CONFIG_PATH else FILE_LIMIT)
            item.update(status='present', bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            if path == CONFIG_PATH:
                item['config'] = config_summary(data)
        except Exception as error:
            item.update(_error(error))
        if path.endswith('/image_boundary.py'):
            item['baselineAbsenceAllowed'] = True
        result['files'].append(item)
    if include_loader_status:
        try:
            result['loader'] = dict(access.loader_status(), statusQuery='completed')
        except Exception as error:
            result['loader'] = _error(error)
    else:
        result['loader'] = {'statusQuery': 'not-requested'}
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--include-loader-status', action='store_true',
                        help='Send one bounded status-only request to the existing fixed Unix socket')
    args = parser.parse_args(argv)
    print(json.dumps(collect(args.include_loader_status), sort_keys=True, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
