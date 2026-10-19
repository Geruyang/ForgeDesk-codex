"""Fixed post-single-image FZ3B quiescence probe, Python 3.6 standard library.

Standalone reviewed bytes may be sent to ``python3 -B -`` on existing SSH.
Only HELLO/status, systemctl show, fixed-file reads and proc metadata are used.
No service action, application import, device open, compute, or file write.
The safe read/proc routines match the frozen service_lifecycle.py by AST tests.
"""
from __future__ import print_function

import argparse
import errno
import hashlib
import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import time
import zlib

sys.dont_write_bytecode = True
PROJECT = '/root/fz3b-vision-console-20261009-001'
UNIT = 'fz3b-vision-console.service'
UNIT_PATH = '/etc/systemd/system/' + UNIT
UNIT_SHA256 = '1089e63bb0138e9c0f0c45f22ad8f95a74bcc92fca998fa541f37836844d599b'
DEPENDENCIES = ('fz3b-pl-loader.service', 'fz3b-app-r5.service', 'fz3b-app-cpu-clock.service')
EXPECTED_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
EXPECTED_QUERY, EXPECTED_FRAMES = 1, 1
EXPECTED_JOB = 'fz3b-one-image-97e500d59a104983ae19a4f67e853b12'
BOOT_PATH = '/proc/sys/kernel/random/boot_id'
CONFIG_PATH = PROJECT + '/config.json'
DEVICE = '/dev/network10_v10_signed40'
CONTRACT_ID = '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e'
CONTRACT_SHA256 = '5f2f281ff7d3f92539a96f42728bd0dcdf5e70d07c98a00cff7f07fdb64aac87'
APPROVED_HASHES = {
    'board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
    'camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
    'image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
    'protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
    'upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
}
CODE_PATHS = (PROJECT + '/run.sh', PROJECT + '/vision_app/link_setup.py',
              PROJECT + '/vision_app/board_runtime.py', PROJECT + '/vision_app/semantic-contract.json') + tuple(
                  PROJECT + '/vision_app/' + name for name in sorted(APPROVED_HASHES))
READ_LIMITS = dict((path, 256 * 1024) for path in CODE_PATHS)
READ_LIMITS.update({UNIT_PATH: 64 * 1024, CONFIG_PATH: 64 * 1024, BOOT_PATH: 4096})
PROPERTIES = ('ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths',
              'SendSIGKILL', 'TimeoutStopUSec', 'NeedDaemonReload', 'Transient',
              'WorkingDirectory', 'Restart')
CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C',
             'SYSTEMD_PAGER': 'cat', 'SYSTEMD_COLORS': '0'}
HEADER = struct.Struct('<4sBBHII')
ENDPOINT = ('127.0.0.1', 8765)
MAX_JSON = 256 * 1024
MAX_PROCESSES, MAX_FDS = 16384, 262144


class LifecycleError(Exception):
    def __init__(self, code, command=None):
        super(LifecycleError, self).__init__(code)
        self.code, self.command = code, command


def require(condition, code):
    if not condition:
        raise LifecycleError(code)


def unique_pairs(items):
    result = {}
    for key, value in items:
        require(key not in result, 'duplicate-json-key')
        result[key] = value
    return result


def json_object(data):
    require(type(data) is bytes and len(data) <= MAX_JSON, 'json-byte-budget')
    def invalid_constant(_):
        raise LifecycleError('nonfinite-json')
    try:
        value = json.loads(data.decode('utf-8'), object_pairs_hook=unique_pairs, parse_constant=invalid_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise LifecycleError('invalid-json')
    require(type(value) is dict, 'json-object-required')
    pending, count = [(value, 1)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        require(depth <= 24 and count <= 12000, 'json-structure-budget')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    return value


def read_fixed(path):
    require(path in READ_LIMITS, 'file-path-not-allowed')
    for name in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK'):
        require(hasattr(os, name), 'linux-safe-open-unavailable')
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory, leaf = os.open('/', flags | os.O_DIRECTORY), None
    try:
        parts = path.strip('/').split('/')
        for component in parts[:-1]:
            opened = os.open(component, flags | os.O_DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = opened
        leaf = os.open(parts[-1], flags, dir_fd=directory)
        before = os.fstat(leaf)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, 'fixed-file-not-single-regular')
        limit = READ_LIMITS[path]
        require(0 <= before.st_size <= limit, 'fixed-file-budget')
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(leaf, min(16384, limit + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        require(len(data) <= limit, 'fixed-file-budget')
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime, info.st_ctime)
        require(identity(before) == identity(os.fstat(leaf)), 'fixed-file-changed')
        return bytes(data)
    finally:
        if leaf is not None:
            os.close(leaf)
        os.close(directory)


def show_service(unit, popen=subprocess.Popen):
    require(unit in (UNIT,) + DEPENDENCIES, 'unit-not-allowed')
    args = ['/bin/systemctl', 'show', unit, '--no-pager', '--property=' + ','.join(PROPERTIES)]
    child = popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                  env=dict(CHILD_ENV), shell=False, close_fds=True)
    try:
        stdout, _ = child.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        raise LifecycleError('systemctl-show-timeout')
    require(child.returncode == 0, 'systemctl-show-failed')
    require(type(stdout) is bytes and len(stdout) <= 64 * 1024, 'systemctl-output-budget')
    try:
        lines = stdout.decode('utf-8').splitlines()
    except UnicodeError:
        raise LifecycleError('systemctl-invalid-utf8')
    properties = {}
    for line in lines:
        key, separator, value = line.partition('=')
        require(separator and key in PROPERTIES and key not in properties, 'systemctl-property-envelope')
        properties[key] = value
    require(set(properties) == set(PROPERTIES), 'systemctl-missing-property')
    return properties


def checked_status(value, expected_boot):
    require(expected_boot == EXPECTED_BOOT, 'expected-boot-not-fixed')
    require(value.get('type') in ('hello', 'status') and type(value.get('protocol')) is int
            and value['protocol'] == 1 and value.get('platform') == 'A0005', 'unexpected-status-protocol')
    require(value.get('contract_id') == CONTRACT_ID and value.get('boot_id') == EXPECTED_BOOT, 'status-identity-mismatch')
    inference = value.get('inference')
    require(type(inference) is dict and inference.get('state') == 'STOPPED'
            and 'error' in inference and inference['error'] is None, 'inference-not-clean-stopped')
    require(type(inference.get('frames')) is int and inference['frames'] == EXPECTED_FRAMES
            and type(value.get('query_revision')) is int and value['query_revision'] == EXPECTED_QUERY,
            'post-compute-query-or-frame-mismatch')
    require(value.get('cpu_frequency_changing') is False and value.get('input_source') == 'upload', 'post-compute-input-or-cpu-mismatch')
    upload = value.get('upload')
    require(type(upload) is dict and upload.get('job_id') == EXPECTED_JOB
            and upload.get('finished') is True and upload.get('cancelled') is False
            and 'error' in upload and upload['error'] is None, 'upload-not-clean-finished')
    for key, expected in (('received', 1), ('completed', 1), ('queued', 0)):
        require(type(upload.get(key)) is int and upload[key] == expected, 'upload-count-mismatch')
    return {'bootId': EXPECTED_BOOT, 'contractId': CONTRACT_ID, 'platform': 'A0005',
            'inference': {'state': 'STOPPED', 'error': None, 'frames': EXPECTED_FRAMES},
            'queryRevision': EXPECTED_QUERY, 'inputSource': 'upload', 'cpuFrequencyChanging': False,
            'upload': {'jobId': EXPECTED_JOB, 'finished': True, 'cancelled': False, 'error': None,
                       'received': 1, 'completed': 1, 'queued': 0}}


def query_status(expected_boot, socket_factory=socket.socket, monotonic=time.monotonic):
    end, link, received = monotonic() + 8, None, [0, 0]
    def remaining():
        value = end - monotonic()
        require(value > 0, 'status-deadline')
        return value
    def exact(size):
        data = bytearray()
        while len(data) < size:
            link.settimeout(remaining())
            part = link.recv(size - len(data))
            require(bool(part), 'status-truncated')
            data.extend(part)
            received[0] += len(part)
            require(received[0] <= 1024 * 1024, 'status-total-byte-budget')
        return bytes(data)
    def receive():
        magic, version, kind, flags, size, crc = HEADER.unpack(exact(HEADER.size))
        require(magic == b'FZVA' and version == 1 and kind == 1 and flags == 0, 'status-frame-header')
        require(size <= MAX_JSON, 'status-frame-budget')
        payload = exact(size)
        require(zlib.crc32(payload) & 0xffffffff == crc, 'status-frame-crc')
        received[1] += 1
        require(received[1] <= 16, 'status-message-budget')
        return json_object(payload)
    def send(value):
        payload = json.dumps(value, separators=(',', ':')).encode('utf-8')
        link.settimeout(remaining())
        link.sendall(HEADER.pack(b'FZVA', 1, 1, 0, len(payload), zlib.crc32(payload) & 0xffffffff) + payload)
    try:
        link = socket_factory(socket.AF_INET, socket.SOCK_STREAM)
        link.settimeout(remaining())
        link.connect(ENDPOINT)
        send({'op': 'hello'})
        hello = receive()
        require(hello.get('type') == 'hello' and hello.get('ok') is True, 'hello-not-accepted')
        first = checked_status(hello, expected_boot)
        request_id = 'fixed-lifecycle-status'
        send({'op': 'status', 'request_id': request_id})
        for _ in range(15):
            value = receive()
            if value.get('type') == 'status':
                checked_status(value, expected_boot)
                continue
            require(value.get('type') == 'ack' and value.get('op') == 'status'
                    and value.get('request_id') == request_id and value.get('ok') is True
                    and type(value.get('result')) is dict, 'status-ack-envelope')
            second = checked_status(value['result'], expected_boot)
            return {'hello': first, 'status': second, 'probeSocketClosedBeforeFdScan': True,
                    'receivedBytes': received[0], 'receivedMessages': received[1]}
        raise LifecycleError('status-ack-absent')
    except socket.timeout:
        raise LifecycleError('status-deadline')
    finally:
        if link is not None:
            link.close()


def tcp_rows(data, family):
    require(type(data) is bytes and len(data) <= 2 * 1024 * 1024, 'tcp-table-budget')
    rows = []
    try:
        lines = data.decode('ascii').splitlines()
        require(lines and 'local_address' in lines[0] and len(lines) <= 16385, 'tcp-table-envelope')
        for line in lines[1:]:
            fields = line.split()
            require(len(fields) >= 10, 'tcp-table-row')
            local, remote, state = fields[1], fields[2], fields[3]
            width = 8 if family == 'tcp' else 32
            require(re.fullmatch(r'[0-9A-F]{%d}:[0-9A-F]{4}' % width, local) is not None
                    and re.fullmatch(r'[0-9A-F]{%d}:[0-9A-F]{4}' % width, remote) is not None
                    and state in ('01', '02', '03', '04', '05', '06', '07', '08', '09', '0A', '0B', '0C')
                    and fields[9].isdigit(), 'tcp-table-row')
            if int(local.rsplit(':', 1)[1], 16) == ENDPOINT[1] or int(remote.rsplit(':', 1)[1], 16) == ENDPOINT[1]:
                rows.append({'family': family, 'state': state, 'inode': int(fields[9])})
    except UnicodeError:
        raise LifecycleError('tcp-table-encoding')
    return rows


def scan_quiescence():
    # Only metadata is inspected: never open the device, another process's fd,
    # command line, environment, memory or any authentication/configuration file.
    device = os.lstat(DEVICE)
    require(stat.S_ISCHR(device.st_mode), 'a0005-node-not-character-device')
    require(os.stat('/proc/1/ns/net').st_ino == os.stat('/proc/%d/ns/net' % os.getpid()).st_ino,
            'not-host-network-namespace')
    rows = []
    for family in ('tcp', 'tcp6'):
        path = '/proc/%d/net/%s' % (os.getpid(), family)
        try:
            with open(path, 'rb') as stream:
                rows.extend(tcp_rows(stream.read(2 * 1024 * 1024 + 1), family))
        except OSError as error:
            if not (family == 'tcp6' and error.errno == errno.ENOENT):
                raise
    listeners = [dict(row, owners=[]) for row in rows if row['state'] == '0A']
    active = [row for row in rows if row['state'] not in ('06', '07', '0A')]
    processes = sorted(name for name in os.listdir('/proc') if name.isdigit())
    require(len(processes) <= MAX_PROCESSES, 'proc-count-budget')
    owners, scanned = [], 0
    for name in processes:
        directory = '/proc/' + name + '/fd'
        try:
            fds = os.listdir(directory)
        except OSError as error:
            if error.errno == errno.ENOENT:
                continue
            raise
        for fd in fds:
            require(fd.isdigit(), 'proc-fd-envelope')
            scanned += 1
            require(scanned <= MAX_FDS, 'proc-fd-budget')
            path = directory + '/' + fd
            try:
                target = os.readlink(path)
                info = os.stat(path)
            except OSError as error:
                if error.errno == errno.ENOENT:
                    continue
                raise
            owner = {'pid': int(name), 'fd': int(fd)}
            if stat.S_ISCHR(info.st_mode) and info.st_rdev == device.st_rdev:
                owners.append(owner)
            match = re.fullmatch(r'socket:\[(\d+)\]', target)
            if match:
                for listener in listeners:
                    if listener['inode'] == int(match.group(1)):
                        listener['owners'].append(owner)
    return {'active8765': active, 'listeners8765': listeners, 'a0005Owners': owners,
            'fdCount': scanned, 'deviceOpened': False, 'ignoredTcpStates': ['TIME_WAIT', 'CLOSE']}


def checked_service(value):
    require(type(value) is dict and set(value) == set(PROPERTIES), 'service-property-set')
    require(value['FragmentPath'] == UNIT_PATH and value['DropInPaths'] == '', 'service-fragment-or-dropins')
    require(value['SendSIGKILL'] == 'no' and value['TimeoutStopUSec'] == '6min', 'service-stop-policy')
    require(value['NeedDaemonReload'] == 'no' and value['Transient'] == 'no', 'service-manager-not-current')
    require(value['WorkingDirectory'] == PROJECT and value['Restart'] == 'no', 'service-execution-policy')
    require(re.fullmatch(r'0|[1-9][0-9]*', value['MainPID']) is not None, 'service-pid-envelope')
    return {'activeState': value['ActiveState'], 'subState': value['SubState'], 'mainPid': int(value['MainPID']),
            'fragmentPath': UNIT_PATH, 'dropIns': [], 'sendSIGKILL': 'no', 'timeoutStopSeconds': 360,
            'needDaemonReload': False, 'transient': False}


def dependencies(access):
    result = {}
    for unit in DEPENDENCIES:
        value = access.show(unit)
        require(value.get('ActiveState') == 'active', 'dependency-not-already-active')
        result[unit] = {'activeState': 'active', 'subState': value.get('SubState'), 'mainPid': value.get('MainPID')}
    return result


def quiescence(access, service_pid):
    for attempt in range(10):
        value = access.scan()
        require(value.get('deviceOpened') is False, 'device-open-not-permitted')
        require(value.get('a0005Owners') == [], 'a0005-device-owned')
        listeners = value.get('listeners8765')
        require(type(listeners) is list, 'listener-evidence-missing')
        if service_pid:
            require(bool(listeners) and all(item.get('owners') and all(
                owner.get('pid') == service_pid for owner in item['owners']) for item in listeners), 'foreign-or-unowned-8765-listener')
        else:
            require(listeners == [], '8765-listener-before-start-or-after-stop')
        if value.get('active8765') == []:
            return dict(value, scanAttempts=attempt + 1)
        if attempt < 9:
            access.sleep(.2)
    raise LifecycleError('active-8765-connection')


def read_metadata(access):
    result = {'bootId': EXPECTED_BOOT, 'unit': {}, 'codeHashes': {}, 'config': {}}
    for path in (BOOT_PATH, UNIT_PATH, CONFIG_PATH) + CODE_PATHS:
        data = access.read(path)
        require(type(data) is bytes and len(data) <= READ_LIMITS[path], 'read-byte-budget')
        item = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        if path == BOOT_PATH:
            require(data.decode('ascii').strip() == EXPECTED_BOOT, 'boot-id-changed')
        elif path == UNIT_PATH:
            require(item['sha256'] == UNIT_SHA256, 'unit-hash-mismatch')
            result['unit'] = dict(item, path=UNIT_PATH)
        elif path == CONFIG_PATH:
            config = json_object(data)
            require(config.get('bind') == '127.0.0.1', 'config-not-explicit-ipv4-loopback')
            for key, expected in (('control_port', 8765), ('video_port', 8766)):
                require(type(config.get(key, expected)) is int and config.get(key, expected) == expected, 'config-port-mismatch')
            result['config'] = dict(item, bind='127.0.0.1', controlPort=8765, videoPort=8766, otherContentOmitted=True)
        else:
            result['codeHashes'][path] = item
    require(result['codeHashes'][PROJECT + '/vision_app/semantic-contract.json']['sha256'] == CONTRACT_SHA256,
            'contract-file-hash-mismatch')
    for name, expected in APPROVED_HASHES.items():
        require(result['codeHashes'][PROJECT + '/vision_app/' + name]['sha256'] == expected, 'deployed-python-hash-mismatch')
    return result


class SystemAccess(object):
    def check_environment(self):
        require(sys.platform.startswith('linux') and os.geteuid() == 0, 'linux-root-required-for-complete-proc-scan')

    def read(self, path):
        return read_fixed(path)

    def show(self, unit):
        return show_service(unit)

    def status(self, boot):
        return query_status(boot)

    def scan(self):
        return scan_quiescence()

    def sleep(self, seconds):
        time.sleep(seconds)


def collect(access=None):
    result = {'schemaVersion': 1, 'scope': 'fixed-fz3b-post-single-image-quiescence', 'result': 'blocked',
              'expectedBootId': EXPECTED_BOOT, 'expectedQueryRevision': EXPECTED_QUERY,
              'expectedInferenceFrames': EXPECTED_FRAMES, 'expectedUploadJob': EXPECTED_JOB,
              'serviceActions': 'not-attempted', 'compute': 'not-attempted', 'deviceOpened': False,
              'applicationImported': False, 'authenticationFilesRead': False, 'filesWritten': False,
              'limitations': ['Point-in-time observations are not a lock against concurrent changes.',
                              'HELLO proves compatibility, not authentication; status can refresh existing R5 telemetry.',
                              'The preceding synthetic-image compute evidence is not semantic accuracy or a new compute run.']}
    access = SystemAccess() if access is None else access
    try:
        access.check_environment()
        result['preRead'] = read_metadata(access)
        before = checked_service(access.show(UNIT))
        require(before['activeState'] == 'active' and before['subState'] == 'running' and before['mainPid'] > 0,
                'application-not-active-running')
        result['applicationBefore'] = before
        result['dependenciesBefore'] = dependencies(access)
        result['status'] = access.status(EXPECTED_BOOT)
        require(result['status'].get('probeSocketClosedBeforeFdScan') is True, 'status-probe-not-confirmed-closed')
        result['quiescence'] = quiescence(access, before['mainPid'])
        result['postRead'] = read_metadata(access)
        require(result['preRead'] == result['postRead'], 'fixed-files-or-boot-changed')
        result['applicationAfter'] = checked_service(access.show(UNIT))
        require(result['applicationAfter'] == before, 'application-changed-during-probe')
        result['dependenciesAfter'] = dependencies(access)
        require(result['dependenciesAfter'] == result['dependenciesBefore'], 'dependencies-changed-during-probe')
        result['finalQuiescence'] = quiescence(access, before['mainPid'])
        result['result'] = 'passed'
    except Exception as error:
        result['error'] = {'code': error.code if isinstance(error, LifecycleError) else type(error).__name__,
                           'errno': getattr(error, 'errno', None)}
    return result


def main(argv=None):
    argparse.ArgumentParser(description=__doc__).parse_args(argv)
    result = collect()
    print(json.dumps(result, sort_keys=True, indent=2))
    return 0 if result['result'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
