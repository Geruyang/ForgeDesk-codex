"""Fixed idle-client recovery probes; Python 3.6 stdlib, root invokes over SSH.

No SSH, service control, application import, device open, file write or retries.
Only normal close, HELLO/status and one fixed rejected settings request are used.
"""
import argparse
import hashlib
import json
import math
import os
import re
import socket
import stat
import struct
import sys
import time
import zlib

sys.dont_write_bytecode = True
APP = '/root/fz3b-vision-console-20261009-001'
BOOT_PATH = '/proc/sys/kernel/random/boot_id'
EXPECTED_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
CONTRACT_ID = '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e'
CONTRACT_SHA = '5f2f281ff7d3f92539a96f42728bd0dcdf5e70d07c98a00cff7f07fdb64aac87'
APPROVED_HASHES = {
    'board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
    'camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
    'image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
    'protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
    'upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
}
CONFIG = APP + '/config.json'
CONTRACT = APP + '/vision_app/semantic-contract.json'
READ_LIMITS = {BOOT_PATH: 4096, CONFIG: 65536, CONTRACT: 262144}
READ_LIMITS.update((APP + '/vision_app/' + name, 262144) for name in APPROVED_HASHES)
ENDPOINT = ('127.0.0.1', 8765)
HEADER = struct.Struct('<4sBBHII')
MAX_JSON, MAX_RECEIVED, MAX_MESSAGES = 262144, 2 * 1024 * 1024, 32
SCENARIOS = ('disconnect', 'rejection', 'checkpoint')


class ProbeError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise ProbeError(code)


def json_object(raw):
    require(type(raw) is bytes and len(raw) <= MAX_JSON, 'json-budget')
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'duplicate-json-key')
            value[key] = item
        return value
    def number(text):
        require(len(text) <= 64, 'number-budget')
        value = float(text)
        require(math.isfinite(value), 'nonfinite-json')
        return value
    def integer(text):
        require(len(text) <= 64, 'number-budget')
        return int(text)
    def invalid(_):
        raise ProbeError('nonfinite-json')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                       parse_constant=invalid, parse_float=number, parse_int=integer)
    require(type(value) is dict, 'json-object-required')
    pending, nodes = [(value, 1)], 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        require(depth <= 24 and nodes <= 12000, 'json-structure-budget')
        if type(item) is dict:
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            pending.extend((child, depth + 1) for child in item)
    return value


def frame(value):
    raw = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf-8')
    require(len(raw) <= MAX_JSON, 'outbound-budget')
    return HEADER.pack(b'FZVA', 1, 1, 0, len(raw), zlib.crc32(raw) & 0xffffffff) + raw


def read_fixed(path):
    require(path in READ_LIMITS, 'read-path-not-allowed')
    require(all(hasattr(os, name) for name in ('O_NOFOLLOW', 'O_DIRECTORY', 'O_NONBLOCK')),
            'linux-safe-open-required')
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory, leaf = os.open('/', flags | os.O_DIRECTORY), None
    try:
        parts = path.strip('/').split('/')
        for name in parts[:-1]:
            opened = os.open(name, flags | os.O_DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = opened
        leaf = os.open(parts[-1], flags, dir_fd=directory)
        before = os.fstat(leaf)
        limit = READ_LIMITS[path]
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == 0
                and not before.st_mode & 0o022 and before.st_size <= limit, 'unsafe-fixed-file')
        raw = bytearray()
        while len(raw) <= limit:
            part = os.read(leaf, min(16384, limit + 1 - len(raw)))
            if not part:
                break
            raw.extend(part)
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime, info.st_ctime)
        require(len(raw) <= limit and identity(before) == identity(os.fstat(leaf)), 'fixed-file-changed')
        return bytes(raw)
    finally:
        if leaf is not None:
            os.close(leaf)
        os.close(directory)


def seal(access):
    result = {}
    for path in sorted(READ_LIMITS):
        raw = access.read(path)
        require(type(raw) is bytes and len(raw) <= READ_LIMITS[path], 'fixed-read-budget')
        result[path] = dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        if path == BOOT_PATH:
            require(raw.decode('ascii').strip() == EXPECTED_BOOT, 'boot-changed')
        elif path == CONFIG:
            value = json_object(raw)
            require(value.get('bind') == '127.0.0.1', 'config-bind-mismatch')
            for key, port in (('control_port', 8765), ('video_port', 8766)):
                require(type(value.get(key, port)) is int and value.get(key, port) == port, 'config-port-mismatch')
        else:
            expected = CONTRACT_SHA if path == CONTRACT else APPROVED_HASHES[path.rsplit('/', 1)[-1]]
            require(result[path]['sha256'] == expected, 'deployed-source-pin-mismatch')
    return result


def snapshot(value):
    require(type(value) is dict and value.get('type') in ('hello', 'status')
            and type(value.get('protocol')) is int and value['protocol'] == 1
            and value.get('platform') == 'A0005' and value.get('contract_id') == CONTRACT_ID
            and value.get('boot_id') == EXPECTED_BOOT, 'status-identity-mismatch')
    inference = value.get('inference')
    require(type(inference) is dict and inference.get('state') == 'STOPPED'
            and 'error' in inference and inference['error'] is None, 'inference-not-clean-stopped')
    for item, key, low, high in ((inference, 'frames', 0, 2 ** 63 - 1),
                                (inference, 'max_in_flight', 1, 4),
                                (value, 'query_revision', 0, 2 ** 63 - 1),
                                (value, 'result_delivery_drops', 0, 2 ** 63 - 1)):
        require(type(item.get(key)) is int and low <= item[key] <= high, 'status-counter-invalid')
    threshold = value.get('threshold')
    require(type(threshold) in (float, int) and math.isfinite(threshold) and -1 <= threshold <= 1,
            'status-threshold-invalid')
    require(value.get('cpu_frequency_changing') is False and value.get('input_source') in ('camera', 'upload'),
            'input-or-clock-state-invalid')
    require('upload' in value, 'upload-status-absent')
    upload = value['upload']
    if upload is not None:
        require(type(upload) is dict and set(upload) == {'job_id', 'received', 'completed', 'queued', 'finished', 'cancelled', 'error'},
                'upload-envelope-invalid')
        require(type(upload['job_id']) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', upload['job_id']) is not None,
                'upload-job-invalid')
        require(upload['finished'] is True and upload['cancelled'] is False and upload['error'] is None,
                'upload-not-clean-finished')
        require(all(type(upload[key]) is int and 0 <= upload[key] <= 2 ** 63 - 1 for key in ('received', 'completed', 'queued'))
                and upload['received'] == upload['completed'] and upload['queued'] == 0, 'upload-not-drained')
    cpu = value.get('cpu')
    require(type(cpu) is dict and cpu.get('verified') is True
            and all(type(cpu.get(key)) is int and cpu[key] > 0 for key in ('current_khz', 'actual_hz')),
            'cpu-readback-unverified')
    return dict(boot_id=EXPECTED_BOOT, contract_id=CONTRACT_ID, protocol=1, platform='A0005',
                inference={key: inference[key] for key in ('state', 'error', 'frames', 'max_in_flight')},
                query_revision=value['query_revision'], threshold=threshold,
                result_delivery_drops=value['result_delivery_drops'], input_source=value['input_source'],
                upload=None if upload is None else dict(upload), cpu_frequency_changing=False,
                cpu={key: cpu[key] for key in ('verified', 'current_khz', 'actual_hz')})


class Client:
    def __init__(self, access, deadline):
        self.link, self.deadline = None, deadline
        self.received, self.messages, self.sequence = 0, 0, 0
        self.baseline = None
        self.clock = access.monotonic
        self.link = access.connect(self.remaining())

    def remaining(self):
        value = self.deadline - self.clock()
        require(value > 0, 'total-deadline')
        return min(value, 5)

    def close(self):
        if self.link is not None:
            link, self.link = self.link, None
            link.close()

    def send(self, value):
        self.link.settimeout(self.remaining())
        self.link.sendall(frame(value))

    def exact(self, size):
        result = bytearray()
        while len(result) < size:
            self.link.settimeout(self.remaining())
            part = self.link.recv(size - len(result))
            require(bool(part), 'peer-closed')
            result.extend(part)
            self.received += len(part)
            require(self.received <= MAX_RECEIVED, 'receive-byte-budget')
        return bytes(result)

    def receive(self):
        magic, version, kind, flags, size, crc = HEADER.unpack(self.exact(HEADER.size))
        require((magic, version, kind, flags) == (b'FZVA', 1, 1, 0) and size <= MAX_JSON, 'frame-envelope-invalid')
        raw = self.exact(size)
        require(zlib.crc32(raw) & 0xffffffff == crc, 'frame-crc-invalid')
        self.messages += 1
        require(self.messages <= MAX_MESSAGES, 'receive-message-budget')
        value = json_object(raw)
        if value.get('type') in ('hello', 'status'):
            observed = snapshot(value)
            require(self.baseline is None or self.baseline == observed, 'unsolicited-state-changed')
        return value

    def hello(self):
        self.send({'op': 'hello'})
        value = self.receive()
        require(value.get('type') == 'hello' and value.get('ok') is True, 'hello-not-accepted')
        self.baseline = snapshot(value)
        return self.baseline

    def command(self, op):
        require(op in ('status', 'settings'), 'operation-not-fixed')
        self.sequence += 1
        request_id = 'recovery-' + str(self.sequence)
        request = dict(op=op, request_id=request_id)
        if op == 'settings':
            request['threshold'] = 2
        self.send(request)
        while True:
            value = self.receive()
            if value.get('type') == 'status':
                continue
            require(value.get('type') == 'ack' and value.get('request_id') == request_id and value.get('op') == op,
                    'ack-not-exact-request')
            if op == 'settings':
                require(value.get('ok') is False and value.get('error') == 'threshold must be finite in [-1,1]',
                        'fixed-rejection-not-confirmed')
                return dict(op=op, request_id=request_id, ok=False, error=value['error'])
            require(value.get('ok') is True, 'status-not-accepted')
            observed = snapshot(value.get('result'))
            require(self.baseline == observed, 'state-changed')
            return observed


class SystemAccess:
    def check_environment(self):
        require(sys.platform.startswith('linux') and os.geteuid() == 0, 'linux-root-required')

    def read(self, path):
        return read_fixed(path)

    def monotonic(self):
        return time.monotonic()

    def connect(self, timeout):
        link = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            link.settimeout(min(timeout, 3))
            link.connect(ENDPOINT)
            return link
        except BaseException:
            link.close()
            raise


def collect(scenario, access=None):
    report = dict(schema='fz3b-idle-client-recovery-v1', scenario=scenario, result='blocked', stage='preflight',
                  endpoint='127.0.0.1:8765', connections_attempted=0, normal_closes_confirmed=0,
                  compute_requested=False, service_actions=False, device_opened=False, files_written=False,
                  application_imported=False, retries=0, replay_attempted=False, network_fault_injected=False,
                  hello_is_authentication=False, human_review_required=False,
                  scope='idle client/protocol recovery only; not SSH loss, compute recovery or lifecycle acceptance')
    client = None
    access = SystemAccess() if access is None else access
    try:
        require(scenario in SCENARIOS, 'scenario-not-allowed')
        access.check_environment()
        report['before_files'] = seal(access)
        deadline = access.monotonic() + 40
        report['stage'] = 'first-connection'
        report['connections_attempted'] += 1
        client = Client(access, deadline)
        client.hello()
        before = client.command('status')
        report['before'] = before
        if scenario == 'rejection':
            report['stage'] = 'fixed-negative-ack'
            report['rejection'] = client.command('settings')
            report['stage'] = 'next-legal-transaction'
            report['same_connection_after'] = client.command('status')
        report['stage'] = 'normal-close'
        client.close()
        client = None
        report['normal_closes_confirmed'] += 1
        if scenario != 'checkpoint':
            report['stage'] = 'fresh-connection'
            report['connections_attempted'] += 1
            client = Client(access, deadline)
            require(client.hello() == before, 'fresh-hello-state-changed')
            report['fresh_connection_after'] = client.command('status')
            client.close()
            client = None
            report['normal_closes_confirmed'] += 1
        report['stage'] = 'post-seal'
        report['after_files'] = seal(access)
        require(report['before_files'] == report['after_files'], 'files-or-config-changed')
        require(access.monotonic() < deadline, 'total-deadline')
        report.update(result='passed', stage='complete')
    except Exception as error:
        report.update(result='failed-or-unknown' if report['connections_attempted'] else 'blocked',
                      error={'code': str(error) if isinstance(error, ProbeError) else type(error).__name__,
                             'errno': getattr(error, 'errno', None)}, human_review_required=True)
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                report.update(result='failed-or-unknown', human_review_required=True, cleanup_close_failed=True)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', choices=SCENARIOS, required=True)
    args = parser.parse_args(argv)
    result = collect(args.scenario)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
    return 0 if result['result'] == 'passed' else 2


if __name__ == '__main__':
    sys.exit(main())
