"""Fixed FZ3B loopback acceptance. Python 3.6; stdout JSON; root runs explicitly.

HELLO checks compatibility, not authentication. No service management, shell,
device access or file writes. The only network destination is 127.0.0.1:8765.
"""
import base64
import hashlib
import json
import math
import os
import socket
import stat
import struct
import sys
import time
import uuid
import zlib

sys.dont_write_bytecode = True
DEFAULT_MODE = 'status'
APP_ROOT = '/root/fz3b-vision-console-20261009-001'
ENDPOINT = ('127.0.0.1', 8765)
CONTRACT_ID = '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e'
HEADER = struct.Struct('<4sBBHII')
JSON, INPUT_FRAME = 1, 5
MAX_JSON = 1024 * 1024
MAX_MESSAGES = 256
MAX_RECEIVED = 8 * 1024 * 1024
MODE_SECONDS = {'status': 12, 'negative': 100, 'one-image': 240}
ALLOWED_OPS = frozenset(('hello', 'status', 'settings', 'queries', 'upload_begin', 'upload_finish', 'stop'))
JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5hooor0jhP//Z'


def require(value, message):
    if not value:
        raise ValueError(message)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def invalid_constant(value):
    raise ValueError('nonfinite JSON constant')


def finite_float(value):
    require(len(value) <= 64, 'JSON number too long')
    result = float(value)
    require(math.isfinite(result), 'nonfinite JSON number')
    return result


def bounded_int(value):
    require(len(value) <= 64, 'JSON integer too long')
    return int(value)


def json_object(payload):
    require(len(payload) <= MAX_JSON, 'JSON payload too large')
    value = json.loads(payload.decode('utf-8'), object_pairs_hook=unique_pairs,
                       parse_constant=invalid_constant, parse_float=finite_float, parse_int=bounded_int)
    require(type(value) is dict, 'JSON object required')
    pending, nodes = [(value, 1)], 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        require(depth <= 32 and nodes <= 20000, 'JSON structure exceeds budget')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    return value


def frame(value, kind=JSON):
    payload = json_bytes(value) if isinstance(value, dict) else bytes(value)
    require(kind in (JSON, INPUT_FRAME), 'unsupported outgoing frame kind')
    require(len(payload) <= MAX_JSON, 'outgoing payload exceeds fixed budget')
    return HEADER.pack(b'FZVA', 1, kind, 0, len(payload), zlib.crc32(payload) & 0xffffffff) + payload


def read_assets():
    hashes, contract = {}, None
    for name in ('semantic-contract.json', 'board_agent.py', 'protocol.py', 'state.py', 'contract.py'):
        path = os.path.join(APP_ROOT, 'vision_app', name)
        require(stat.S_ISREG(os.lstat(path).st_mode), 'source is not a regular file: ' + name)
        with open(path, 'rb') as source:
            data = source.read(MAX_JSON + 1)
        require(len(data) <= MAX_JSON, 'source file exceeds budget: ' + name)
        hashes[name] = hashlib.sha256(data).hexdigest()
        if name == 'semantic-contract.json':
            contract = json_object(data)
    identity = dict(contract)
    expected = identity.pop('contract_id')
    actual = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')).hexdigest()
    require(expected == actual == CONTRACT_ID, 'fixed semantic contract digest mismatch')
    require(contract['model'] == 'mobileclip_s1' and contract['dimension'] == 512 and contract['normalization'] == 'l2-float32-v1', 'fixed contract fields mismatch')
    return contract, hashes


class Deadline:
    def __init__(self, seconds, end=None):
        self.end = time.monotonic() + seconds if end is None else end

    def remaining(self):
        remaining = self.end - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('fixed acceptance total deadline exceeded')
        return remaining

    def within(self, seconds):
        return Deadline(0, min(self.end, time.monotonic() + seconds))


class ProbeFailure(Exception):
    def __init__(self, message, evidence):
        super().__init__(message)
        self.evidence = evidence


def checked_status(value):
    require(value.get('type') in ('hello', 'status') and type(value.get('protocol')) is int and value['protocol'] == 1, 'unexpected status protocol')
    require(value.get('contract_id') == CONTRACT_ID, 'service contract mismatch')
    inference = value.get('inference')
    require(type(inference) is dict and type(inference.get('frames')) is int and inference['frames'] >= 0, 'invalid inference status')
    require(type(value.get('query_revision')) is int and value['query_revision'] >= 0, 'invalid query revision')
    require(type(value.get('boot_id')) is str and 1 <= len(value['boot_id']) <= 64, 'boot identity missing')
    require(inference.get('state') in ('STOPPED', 'STARTING', 'RUNNING', 'DRAINING', 'FAILED'), 'invalid inference state')
    require('error' in inference and (inference['error'] is None or type(inference['error']) is str), 'invalid inference error')
    require(type(inference.get('max_in_flight')) is int and 1 <= inference['max_in_flight'] <= 4, 'invalid in-flight status')
    threshold = value.get('threshold')
    require(type(threshold) in (float, int) and math.isfinite(threshold) and -1 <= threshold <= 1, 'invalid threshold status')
    require(type(value.get('result_delivery_drops')) is int and value['result_delivery_drops'] >= 0, 'invalid delivery-drop status')
    return value


def stopped(value):
    value = checked_status(value)
    require(value['inference'].get('state') == 'STOPPED' and value['inference']['error'] is None, 'inference not cleanly STOPPED')
    return value


def summary(value):
    return {key: value.get(key) for key in ('boot_id', 'contract_id', 'inference', 'query_revision', 'threshold', 'result_delivery_drops', 'input_source', 'upload', 'cpu', 'cpu_frequency_changing', 'camera', 'r5')}


class Client:
    def __init__(self, deadline):
        self.deadline = deadline
        self.sock = socket.create_connection(ENDPOINT, timeout=min(3, deadline.remaining()))
        self.messages, self.bytes_received, self.last_status, self.results = 0, 0, None, []
        self.last_status_sequence = 0
        self.result_sequence = 0

    def close(self):
        self.sock.close()

    def send(self, value, kind=JSON):
        self.sock.settimeout(min(2, self.deadline.remaining()))
        self.sock.sendall(frame(value, kind))

    def raw(self, data):
        self.sock.settimeout(min(2, self.deadline.remaining()))
        self.sock.sendall(data)

    def exact(self, size, deadline):
        result = bytearray()
        while len(result) < size:
            self.sock.settimeout(min(.5, deadline.remaining(), self.deadline.remaining()))
            try:
                part = self.sock.recv(size - len(result))
            except socket.timeout:
                continue
            if not part:
                raise EOFError('peer closed connection')
            result.extend(part)
            self.bytes_received += len(part)
            require(self.bytes_received <= MAX_RECEIVED, 'receive byte budget exceeded')
        return bytes(result)

    def receive(self, deadline=None):
        deadline = deadline or self.deadline
        header = self.exact(HEADER.size, deadline)
        magic, version, kind, flags, size, crc = HEADER.unpack(header)
        require(magic == b'FZVA' and version == 1 and kind == JSON and flags == 0, 'invalid incoming frame header')
        require(size <= MAX_JSON, 'incoming JSON frame too large')
        payload = self.exact(size, deadline)
        require(zlib.crc32(payload) & 0xffffffff == crc, 'incoming CRC mismatch')
        value = json_object(payload)
        self.messages += 1
        require(self.messages <= MAX_MESSAGES, 'receive message budget exceeded')
        if value.get('type') in ('hello', 'status'):
            self.last_status = checked_status(value)
            self.last_status_sequence = self.messages
        if value.get('type') == 'result':
            require(len(self.results) < 2, 'too many result messages')
            self.results.append(value)
            self.result_sequence = self.messages
        return value

    def hello(self):
        self.send({'op': 'hello'})
        value = self.receive(self.deadline.within(6))
        require(value.get('type') == 'hello' and value.get('ok') is True, 'compatibility HELLO rejected')
        return checked_status(value)

    def command(self, op, expected=True, **fields):
        require(op in ALLOWED_OPS and op != 'hello', 'operation is not allowlisted')
        request_id = 'fz3b-check-' + uuid.uuid4().hex
        request = dict(fields, op=op, request_id=request_id)
        self.send(request)
        deadline = self.deadline.within(10)
        while True:
            value = self.receive(deadline)
            if value.get('type') == 'ack' and value.get('request_id') == request_id:
                require(value.get('op') == op and value.get('ok') is expected, 'unexpected operation acknowledgment: ' + op)
                return value

    def status(self):
        value = checked_status(self.command('status')['result'])
        self.last_status, self.last_status_sequence = value, self.messages
        return value


def status_probe(deadline, require_idle=True):
    client = Client(deadline)
    try:
        client.hello()
        value = client.status()
        if require_idle:
            stopped(value)
            require(not client.results, 'unexpected inference result in idle status probe')
        return value
    finally:
        client.close()


def unchanged(before, after):
    stopped(after)
    for key in ('boot_id', 'contract_id', 'query_revision', 'threshold', 'result_delivery_drops'):
        require(before.get(key) == after.get(key), 'negative test changed state: ' + key)
    for key in ('frames', 'max_in_flight'):
        require(before['inference'].get(key) == after['inference'].get(key), 'negative test changed inference: ' + key)


def query_fields(contract, revision, wrong_contract=False):
    identity = {key: contract[key] for key in ('contract_id', 'weight_sha256', 'normalization', 'bpe_sha256')}
    if wrong_contract:
        identity['contract_id'] = '0' * 64
    values = struct.pack('<512f', *([1.0] + [0.0] * 511))
    return dict(items=[{'id': 'synthetic-unit-vector', 'label': 'synthetic-unit-vector; not semantic text', 'text': 'synthetic-unit-vector; computation probe only'}], features_f32_b64=base64.b64encode(values).decode('ascii'), identity=identity, revision=revision)


def wait_for_close(client, seconds, minimum=0):
    started = time.monotonic()
    deadline = client.deadline.within(seconds)
    try:
        while True:
            value = client.receive(deadline)
            require(value.get('type') == 'status', 'invalid request received an unexpected reply')
            stopped(value)
    except (EOFError, ConnectionResetError):
        elapsed = time.monotonic() - started
        require(elapsed >= minimum, 'connection closed before partial-frame deadline could be established')
        return elapsed


def negative_probe(contract, deadline):
    baseline = status_probe(deadline)
    cases = []
    for name in ('badhello', 'duplicate-json', 'partial-header-5s', 'partial-body-30s', 'wrong-contract', 'threshold-2', 'max-in-flight-0'):
        client = Client(deadline)
        record = {'case': name}
        cases.append(record)
        failure = None
        try:
            if name == 'badhello':
                client.send({'op': 'status', 'request_id': 'no-hello'})
                record['closed_after_s'] = wait_for_close(client, 7)
            elif name == 'duplicate-json':
                client.raw(frame(b'{"op":"status","op":"hello"}'))
                record['closed_after_s'] = wait_for_close(client, 7)
            else:
                unchanged(baseline, stopped(client.hello()))
                if name == 'partial-header-5s':
                    client.raw(frame({'op': 'status'})[:6])
                    record['closed_after_s'] = wait_for_close(client, 9, minimum=4)
                elif name == 'partial-body-30s':
                    client.raw(frame({'op': 'status'})[:HEADER.size + 1])
                    record['closed_after_s'] = wait_for_close(client, 35, minimum=29)
                elif name == 'wrong-contract':
                    record['rejection'] = client.command('queries', expected=False, **query_fields(contract, baseline['query_revision'] + 1, True))
                elif name == 'threshold-2':
                    record['rejection'] = client.command('settings', expected=False, threshold=2)
                else:
                    record['rejection'] = client.command('settings', expected=False, max_in_flight=0)
        except Exception as error:
            failure = type(error).__name__ + ': ' + str(error)
        finally:
            client.close()
        try:
            after = status_probe(deadline)
            record['after'] = summary(after)
            unchanged(baseline, after)
        except Exception as error:
            failure = (failure + '; ' if failure else '') + 'after-status: ' + type(error).__name__ + ': ' + str(error)
        record['ok'] = failure is None
        if failure:
            record['error'] = failure
            raise ProbeFailure(name + ': ' + failure, {'before': summary(baseline), 'cases': cases})
    return {'before': summary(baseline), 'cases': cases, 'scope': 'bounded protocol rejection checks; inference never requested; no CPU frequency command'}


def cleanup_stop(client, deadline, boot_id):
    result = {'attempted': True, 'confirmed_stopped': False}
    client.deadline = deadline
    recovered = None
    try:
        try:
            client.command('stop')
        except Exception as first_error:
            result['original_connection_error'] = type(first_error).__name__ + ': ' + str(first_error)
            recovered = Client(deadline)
            hello = recovered.hello()
            require(hello.get('boot_id') == boot_id, 'boot changed; cleanup identity is unknown')
            recovered.command('stop')
            client = recovered
        value = client.status()
        while True:
            result['last_status'] = summary(value)
            require(value.get('boot_id') == boot_id, 'boot changed during cleanup')
            if value['inference'].get('state') == 'STOPPED' and value['inference']['error'] is None:
                result['confirmed_stopped'] = True
                return result
            if value['inference'].get('state') == 'FAILED' or value['inference'].get('error'):
                result['error'] = 'inference cleanup reported failure; no service kill requested'
                return result
            message = client.receive()
            if message.get('type') == 'status':
                value = checked_status(message)
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
        return result
    finally:
        if recovered:
            recovered.close()


def checked_single_result(value, job_id, revision, identity):
    require(value.get('type') == 'result' and value.get('source') == 'upload' and value.get('job_id') == job_id, 'result job/source mismatch')
    require(type(value.get('frame_id')) is int and value['frame_id'] == 0 and type(value.get('video_time_s')) in (int, float) and value['video_time_s'] == 0, 'result frame/time mismatch')
    require(type(value.get('source_width')) is int and value['source_width'] == 16 and type(value.get('source_height')) is int and value['source_height'] == 16, 'result image extent mismatch')
    require(type(value.get('query_revision')) is int and value['query_revision'] == revision and value.get('identity') == identity, 'result query identity mismatch')
    ranking = value.get('ranking')
    require(type(ranking) is list and len(ranking) == 1 and ranking[0].get('id') == 'synthetic-unit-vector', 'single synthetic result missing')
    score = ranking[0].get('score')
    require(type(score) in (int, float) and math.isfinite(score) and -1 <= score <= 1, 'result score is not finite within [-1,1]')
    for key in ('capture_monotonic', 'completed_monotonic'):
        stamp = value.get(key)
        require(type(stamp) in (int, float) and math.isfinite(stamp), 'result timestamp missing')
    require(value['completed_monotonic'] >= value['capture_monotonic'], 'result timestamps reversed')
    return value


def one_image_probe(contract, total_deadline):
    # Keep 35 seconds inside the fixed total bound for a best-effort stop/drain.
    work_deadline = Deadline(0, total_deadline.end - 35)
    client = Client(work_deadline)
    start_requested = False
    evidence = {'scope': 'single uploaded image runtime computation only; synthetic-unit-vector is not semantic text or semantic accuracy', 'query_state_effect': 'if queries is accepted, replaces the snapshot with synthetic data; previous contents are not exposed or restored by this protocol', 'query_update_acknowledged': False, 'input': {'kind': 'fixed synthetic JPEG', 'width': 16, 'height': 16}, 'upload_begin_requested': False, 'input_frame_send_completed': False}
    before = None
    try:
        client.hello()
        before = client.status()
        evidence['before'] = summary(before)
        stopped(before)
        require(not before.get('cpu_frequency_changing'), 'CPU frequency transition is active; no inference requested')
        require(not client.results, 'unexpected result before this job')
        revision = before['query_revision'] + 1
        fields = query_fields(contract, revision)
        evidence['query'] = {'id': 'synthetic-unit-vector', 'dimension': 512, 'meaning': 'unit vector e0; not a text embedding', 'identity': fields['identity'], 'revision': revision}
        answer = client.command('queries', **fields)['result']
        require(answer.get('query_revision') == revision and answer.get('count') == 1, 'query acknowledgment mismatch')
        evidence['query_update_acknowledged'] = True
        job_id = 'fz3b-one-image-' + uuid.uuid4().hex
        evidence['job_id'] = job_id
        start_requested = True
        evidence['upload_begin_requested'] = True
        answer = client.command('upload_begin', job_id=job_id)['result']
        require(answer.get('job_id') == job_id and type(answer.get('credits')) is int and 1 <= answer['credits'] <= 16, 'upload admission mismatch')
        jpeg = base64.b64decode(JPEG_B64)
        require(len(jpeg) == 633 and hashlib.sha256(jpeg).hexdigest() == '78929f4908dd246d96bb1471556262d794e343914ae5ad87586b2aaa4154e027', 'fixed JPEG integrity mismatch')
        evidence['input'].update(bytes=len(jpeg), sha256=hashlib.sha256(jpeg).hexdigest())
        metadata = json_bytes(dict(job_id=job_id, frame_id=0, video_time_s=0.0, width=16, height=16))
        client.send(struct.pack('<I', len(metadata)) + metadata + jpeg, INPUT_FRAME)
        evidence['input_frame_send_completed'] = True
        finish = client.command('upload_finish', job_id=job_id, frame_count=1)['result']
        require(finish.get('job_id') == job_id and type(finish.get('received')) is int and finish['received'] == 1 and finish.get('finished') is True and finish.get('cancelled') is False and 'error' in finish and finish['error'] is None, 'upload finish mismatch')
        finish_sequence = client.messages
        client.status()
        while True:
            require(len(client.results) <= 1, 'duplicate/extra result for one image')
            value = client.last_status
            require(value.get('boot_id') == before.get('boot_id'), 'boot changed during one-image computation')
            require(value['inference'].get('state') != 'FAILED' and not value['inference'].get('error'), 'inference failed: ' + str(value['inference'].get('error')))
            if len(client.results) == 1 and client.last_status_sequence > max(client.result_sequence, finish_sequence) and value['inference'].get('state') == 'STOPPED':
                result = checked_single_result(client.results[0], job_id, revision, fields['identity'])
                upload = value.get('upload') or {}
                require(value['inference']['frames'] == 1 and value['query_revision'] == revision, 'final inference/query count mismatch')
                require(upload.get('job_id') == job_id and all(type(upload.get(key)) is int and upload[key] == expected for key, expected in (('received', 1), ('completed', 1), ('queued', 0))) and upload.get('finished') is True and upload.get('cancelled') is False and 'error' in upload and upload['error'] is None, 'upload did not complete exactly once')
                require(value.get('result_delivery_drops') == before.get('result_delivery_drops'), 'result delivery drop count changed')
                evidence.update(result=result, result_messages_received=1, after=summary(stopped(value)), cleanup={'attempted': False, 'confirmed_stopped': True})
                return evidence
            client.receive()
    except BaseException as error:
        evidence['result_messages_received'] = len(client.results)
        evidence['cleanup'] = cleanup_stop(client, total_deadline.within(35), before.get('boot_id')) if start_requested and before else {'attempted': False, 'confirmed_stopped': False}
        raise ProbeFailure(type(error).__name__ + ': ' + str(error), evidence)
    finally:
        client.close()


def execute(mode):
    require(mode in MODE_SECONDS, 'unsupported fixed mode')
    deadline = Deadline(MODE_SECONDS[mode])
    contract, hashes = read_assets()
    report = {'mode': mode, 'endpoint': '127.0.0.1:8765', 'contract_id': contract['contract_id'], 'source_sha256': hashes, 'hello_is_authentication': False}
    try:
        if mode == 'status':
            value = status_probe(deadline, require_idle=False)
            report.update(status=summary(value), scope='read-only compatibility HELLO and explicit status')
            stopped(value)
            report['ok'] = True
        elif mode == 'negative':
            report.update(negative_probe(contract, deadline), ok=True)
        else:
            report.update(one_image_probe(contract, deadline), ok=True)
    except Exception as error:
        if isinstance(error, ProbeFailure):
            report.update(error.evidence)
        report.update(ok=False, error=type(error).__name__ + ': ' + str(error), outcome='failed-or-unknown; service was not killed')
    return report


def main(args=None):
    args = sys.argv[1:] if args is None else args
    mode = args[0] if len(args) == 1 else DEFAULT_MODE
    try:
        require(len(args) <= 1, 'only the fixed mode argument is accepted')
        result = execute(mode)
    except Exception as error:
        result = {'ok': False, 'mode': mode, 'error': type(error).__name__ + ': ' + str(error), 'hello_is_authentication': False}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, sort_keys=True, allow_nan=False) + '\n')
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
