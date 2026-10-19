"""Pure socket/clock mocks for the fixed acceptance script; no real TCP or Agent."""
import ast
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import stat
import sys
import time
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
TOOL = ROOT / 'engineering/fz3b/tools/fixed_tcp_acceptance.py'
SOURCE = ROOT / 'engineering/fz3b/source/PS/vision_app'
BLOCKED = []


def audit(event, args):
    if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system':
        BLOCKED.append(event)
        raise RuntimeError('Fixed acceptance tests prohibit real sockets and processes')
    if event == 'import' and any(part in args[0].split('.') for part in ('board_agent', 'board_runtime', 'serial', 'pyocd', 'paramiko', 'PySide6')):
        BLOCKED.append('import:' + args[0])
        raise RuntimeError('Fixed acceptance tests prohibit hardware/runtime imports')


sys.addaudithook(audit)
spec = importlib.util.spec_from_file_location('fixed_fz3b_acceptance_fixture', str(TOOL))
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)
CONTRACT = json.loads((SOURCE / 'semantic-contract.json').read_text(encoding='utf-8'))


class Clock:
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now


def state():
    return dict(type='status', protocol=1, contract_id=tool.CONTRACT_ID, boot_id='fixture-boot', inference=dict(state='STOPPED', error=None, frames=7, max_in_flight=4), query_revision=3, threshold=.2, result_delivery_drops=0, input_source='camera', upload=None, cpu={'current_khz': 1199999}, cpu_frequency_changing=False)


class FakeSocket:
    def __init__(self, server):
        self.server = server
        self.buffer = bytearray()
        self.timeout = .5
        self.closed = False
        self.partial_end = None
        self.handshaken = False
        self.received = []

    def settimeout(self, value):
        assert value > 0
        self.timeout = value

    def close(self):
        self.closed = True

    def queue(self, value):
        self.buffer.extend(tool.frame(value))

    def recv(self, count):
        if self.buffer:
            size = min(count, 7, len(self.buffer))
            result = bytes(self.buffer[:size])
            del self.buffer[:size]
            return result
        if self.closed:
            return b''
        self.server.clock.now += self.timeout
        if self.partial_end is not None and self.server.clock.now >= self.partial_end:
            self.closed = True
            return b''
        raise socket.timeout()

    def sendall(self, data):
        if self.closed:
            raise ConnectionResetError('fixture connection is closed')
        self.server.writes.append(data)
        if len(data) < tool.HEADER.size:
            self.partial_end = self.server.clock.now + 5
            return
        magic, version, kind, flags, size, crc = tool.HEADER.unpack(data[:tool.HEADER.size])
        if len(data) < tool.HEADER.size + size:
            self.partial_end = self.server.clock.now + 30
            return
        if kind == tool.INPUT_FRAME:
            assert self.server.one_image
            payload = data[tool.HEADER.size:]
            extent = tool.struct.unpack('<I', payload[:4])[0]
            metadata = tool.json_object(payload[4:4 + extent])
            jpeg = payload[4 + extent:]
            assert metadata == dict(job_id=self.server.job_id, frame_id=0, video_time_s=0.0, width=16, height=16)
            assert hashlib.sha256(jpeg).hexdigest() == '78929f4908dd246d96bb1471556262d794e343914ae5ad87586b2aaa4154e027'
            self.server.input_frames.append(metadata)
            self.server.status['upload']['received'] = 1
            return
        assert kind == tool.JSON
        try:
            request = tool.json_object(data[tool.HEADER.size:])
        except ValueError:
            self.closed = True
            return
        self.received.append(request)
        self.server.ops.append(request['op'])
        if not self.handshaken:
            if request['op'] != 'hello':
                self.closed = True
                return
            self.handshaken = True
            self.queue(dict(self.server.status, type='hello', ok=True))
            return
        self.queue(copy.deepcopy(self.server.status))  # Asynchronous status before ACK.
        if request['op'] == 'status':
            ok, result = True, copy.deepcopy(self.server.status)
        elif request['op'] == 'queries':
            if self.server.one_image:
                assert request['identity'] == {key: CONTRACT[key] for key in ('contract_id', 'weight_sha256', 'normalization', 'bpe_sha256')}
                values = tool.struct.unpack('<512f', tool.base64.b64decode(request['features_f32_b64']))
                assert values == tuple([1.0] + [0.0] * 511)
                assert request['items'][0]['id'] == 'synthetic-unit-vector'
                self.server.query = request
                self.server.status['query_revision'] = request['revision']
                ok, result = True, dict(query_revision=request['revision'], count=1)
            else:
                ok, result = self.server.accept_bad_contract, {}
        elif request['op'] == 'settings':
            assert request.get('threshold') == 2 or request.get('max_in_flight') == 0
            ok, result = False, {}
        elif request['op'] == 'upload_begin':
            assert self.server.one_image
            self.server.job_id = request['job_id']
            self.server.status['inference'].update(state='RUNNING', frames=0)
            self.server.status.update(input_source='upload', upload=dict(job_id=request['job_id'], received=0, completed=0, queued=0, finished=False, cancelled=False, error=None))
            if self.server.disconnect_on_begin:
                self.closed = True
                return
            ok, result = True, dict(job_id=request['job_id'], credits=16, state='STARTING')
        elif request['op'] == 'upload_finish':
            assert self.server.one_image and request['job_id'] == self.server.job_id and request['frame_count'] == 1
            assert len(self.server.input_frames) == 1
            if self.server.fail_finish:
                ok, result = False, {}
            else:
                self.server.status['upload'].update(completed=1, finished=True)
                self.server.status['inference'].update(state='STOPPED', frames=1)
                result = copy.deepcopy(self.server.status['upload'])
                event = dict(type='result', source='upload', job_id=self.server.job_id, frame_id=0, video_time_s=0.0, source_width=16, source_height=16, query_revision=self.server.query['revision'], identity=self.server.query['identity'], ranking=[dict(self.server.query['items'][0], score=.25)], capture_monotonic=1000.0, completed_monotonic=1000.1)
                if self.server.bad_result_identity:
                    event['identity'] = {'contract_id': 'wrong'}
                self.queue(event)  # Result deliberately arrives before upload_finish ACK.
                if self.server.duplicate_result:
                    self.queue(event)
                if self.server.fail_runtime:
                    self.server.status['inference'].update(state='FAILED', error='fixture runtime cleanup failed')
                ok = True
        elif request['op'] == 'stop':
            assert self.server.one_image
            if self.server.hold_stop:
                self.server.status['inference']['state'] = 'DRAINING'
            elif not self.server.fail_runtime:
                self.server.status['inference']['state'] = 'STOPPED'
            ok, result = True, dict(state=self.server.status['inference']['state'])
        else:
            raise AssertionError('Unexpected operation in fixed mock: ' + request['op'])
        answer = dict(type='ack', op=request['op'], request_id=request['request_id'], ok=ok)
        answer.update(result=result) if ok else answer.update(error='fixture: invalid input rejected')
        self.queue(answer)


class FakeServer:
    def __init__(self):
        self.clock = Clock()
        self.status = state()
        self.connections, self.writes, self.ops = [], [], []
        self.accept_bad_contract = False
        self.one_image = False
        self.query, self.job_id = None, None
        self.input_frames = []
        self.duplicate_result = self.bad_result_identity = False
        self.fail_finish = self.fail_runtime = self.disconnect_on_begin = self.hold_stop = False

    def connect(self, endpoint, timeout):
        assert endpoint == ('127.0.0.1', 8765)
        assert 0 < timeout <= 3
        sock = FakeSocket(self)
        self.connections.append(sock)
        return sock


class FixedAcceptance(unittest.TestCase):
    def test_python36_stdlib_and_fixed_command_surface(self):
        tree = ast.parse(TOOL.read_text(encoding='utf-8'), feature_version=(3, 6))
        imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
        names = {item.name.split('.')[0] for node in imports if isinstance(node, ast.Import) for item in node.names}
        self.assertFalse(names & {'subprocess', 'importlib', 'numpy', 'PIL', 'serial', 'paramiko'})
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                self.assertNotIn(node.func.id, ('exec', 'eval', 'compile'))
                if node.func.id == 'open':
                    self.assertEqual(ast.literal_eval(node.args[1]), 'rb')
        self.assertEqual(tool.ENDPOINT, ('127.0.0.1', 8765))
        self.assertEqual(tool.DEFAULT_MODE, 'status')
        self.assertNotIn('cpu_frequency', tool.ALLOWED_OPS)
        self.assertNotIn('start', tool.ALLOWED_OPS)

    def test_assets_are_fixed_read_only_sources_and_exact_contract(self):
        files = {tool.os.path.join(tool.APP_ROOT, 'vision_app', name): (SOURCE / name).read_bytes() for name in ('semantic-contract.json', 'board_agent.py', 'protocol.py', 'state.py', 'contract.py')}

        def read(path, mode):
            self.assertEqual(mode, 'rb')
            self.assertTrue(path in files, 'unexpected fixed source read path')
            return io.BytesIO(files[path])

        with mock.patch('builtins.open', side_effect=read), mock.patch.object(tool.os, 'lstat', return_value=types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600)):
            contract, hashes = tool.read_assets()
        self.assertEqual(contract['contract_id'], tool.CONTRACT_ID)
        self.assertEqual(hashes['state.py'], hashlib.sha256((SOURCE / 'state.py').read_bytes()).hexdigest())

    def test_status_is_default_read_only_and_handles_fragmented_frames_async_status(self):
        server = FakeServer()
        out = io.StringIO()
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {'fixture': 'not-deployed'})), mock.patch.object(tool.sys, 'stdout', out):
            code = tool.main([])
        report = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertTrue(report['ok'])
        self.assertEqual(report['mode'], 'status')
        self.assertFalse(report['hello_is_authentication'])
        self.assertEqual(report['status']['inference']['frames'], 7)
        self.assertEqual(server.ops, ['hello', 'status'])
        self.assertTrue(all(sock.closed for sock in server.connections))

    def test_negative_is_low_volume_sequential_and_checks_status_after_every_case(self):
        server = FakeServer()
        baseline = copy.deepcopy(server.status)
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {})):
            report = tool.execute('negative')
        self.assertTrue(report['ok'], report)
        self.assertEqual(len(report['cases']), 7)
        self.assertTrue(all(case['ok'] and case['after']['inference']['state'] == 'STOPPED' for case in report['cases']))
        self.assertEqual(len(server.connections), 15)
        self.assertEqual(server.ops.count('status'), 9)  # Baseline + badhello + seven fresh after probes.
        self.assertEqual([case['closed_after_s'] for case in report['cases'][2:4]], [5, 30])
        self.assertEqual(server.status, baseline)
        self.assertFalse(set(server.ops) & {'start', 'upload_begin', 'cpu_frequency', 'stop'})
        self.assertTrue(all(sock.closed for sock in server.connections))

    def test_status_failure_still_returns_observed_error_frames_and_query_revision_without_stop(self):
        server = FakeServer()
        server.status['inference'].update(state='FAILED', error='fixture cleanup error')
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {})):
            report = tool.execute('status')
        self.assertFalse(report['ok'])
        self.assertEqual(report['status']['inference']['error'], 'fixture cleanup error')
        self.assertEqual(report['status']['inference']['frames'], 7)
        self.assertEqual(report['status']['query_revision'], 3)
        self.assertEqual(server.ops, ['hello', 'status'])

    def test_negative_failure_still_checks_legitimate_status_and_records_failed_case(self):
        server = FakeServer()
        server.accept_bad_contract = True
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {})):
            report = tool.execute('negative')
        self.assertFalse(report['ok'])
        self.assertEqual(report['cases'][-1]['case'], 'wrong-contract')
        self.assertFalse(report['cases'][-1]['ok'])
        self.assertEqual(report['cases'][-1]['after']['inference']['state'], 'STOPPED')
        self.assertEqual(len(server.connections), 11)

    def test_receive_rejects_bad_crc_or_header_before_unbounded_reads(self):
        for raw in (tool.HEADER.pack(b'FZVA', 1, 1, 0, tool.MAX_JSON + 1, 0), tool.HEADER.pack(b'FZVA', 1, 1, 0, 2, 0) + b'{}', tool.HEADER.pack(b'BAD!', 1, 1, 0, 0, 0)):
            with self.subTest(raw=raw[:16]):
                server = FakeServer()
                with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect):
                    client = tool.Client(tool.Deadline(10))
                    client.sock.buffer.extend(raw)
                    with self.assertRaises(ValueError):
                        client.receive()
                    client.close()

    def test_one_image_keeps_owner_and_accepts_result_before_finish_ack_as_computation_only(self):
        server = FakeServer()
        server.one_image = True
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {})):
            report = tool.execute('one-image')
        self.assertTrue(report['ok'], report)
        self.assertEqual(len(server.connections), 1)
        self.assertEqual(len(server.input_frames), 1)
        self.assertEqual(server.ops, ['hello', 'status', 'queries', 'upload_begin', 'upload_finish', 'status'])
        self.assertEqual(report['query']['id'], 'synthetic-unit-vector')
        self.assertIn('not semantic', report['scope'])
        self.assertEqual(report['after']['inference']['frames'], 1)
        self.assertEqual(report['after']['inference']['state'], 'STOPPED')
        self.assertTrue(report['cleanup']['confirmed_stopped'])
        self.assertFalse(report['cleanup']['attempted'])
        self.assertFalse(set(server.ops) & {'start', 'cpu_frequency', 'stop'})

    def test_one_image_failures_try_stop_but_never_claim_a_failed_runtime_was_drained(self):
        for defect in ('duplicate_result', 'bad_result_identity', 'fail_finish', 'fail_runtime', 'disconnect_on_begin'):
            with self.subTest(defect=defect):
                server = FakeServer()
                server.one_image = True
                setattr(server, defect, True)
                with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {})):
                    report = tool.execute('one-image')
                self.assertFalse(report['ok'], report)
                self.assertTrue(report['cleanup']['attempted'])
                self.assertIn('stop', server.ops)
                self.assertEqual(report['cleanup']['confirmed_stopped'], defect != 'fail_runtime')
                self.assertNotIn('cpu_frequency', server.ops)
                self.assertLessEqual(len(server.connections), 2)
                self.assertTrue(all(sock.closed for sock in server.connections))

    def test_one_image_invalid_precondition_never_installs_queries_or_requests_stop(self):
        server = FakeServer()
        server.one_image = True
        server.status['inference'].update(state='FAILED', error='preexisting fixture error')
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {})):
            report = tool.execute('one-image')
        self.assertFalse(report['ok'])
        self.assertEqual(server.ops, ['hello', 'status'])
        self.assertFalse(report['upload_begin_requested'])
        self.assertFalse(report['cleanup']['attempted'])
        self.assertEqual(report['before']['inference']['error'], 'preexisting fixture error')

    def test_single_result_requires_exact_types_and_bound_identity_not_just_truthy_values(self):
        value = dict(type='result', source='upload', job_id='fixture-job', frame_id=0, video_time_s=0.0, source_width=16, source_height=16, query_revision=1, identity={'fixture': True}, ranking=[dict(id='synthetic-unit-vector', score=.25)], capture_monotonic=1.0, completed_monotonic=2.0)
        self.assertIs(tool.checked_single_result(value, 'fixture-job', 1, {'fixture': True}), value)
        for changes in ({'frame_id': False}, {'video_time_s': False}, {'source_width': 16.0}, {'query_revision': True}, {'identity': {}}, {'job_id': 'other'}, {'capture_monotonic': float('nan')}, {'ranking': [dict(id='synthetic-unit-vector', score=True)]}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                tool.checked_single_result(dict(value, **changes), 'fixture-job', 1, {'fixture': True})

    def test_unknown_cleanup_has_a_deadline_and_does_not_kill_or_restart_service(self):
        server = FakeServer()
        server.one_image = server.fail_finish = server.hold_stop = True
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect), mock.patch.object(tool, 'read_assets', return_value=(CONTRACT, {})):
            report = tool.execute('one-image')
        self.assertFalse(report['ok'])
        self.assertFalse(report['cleanup']['confirmed_stopped'])
        self.assertIn('TimeoutError', report['cleanup']['error'])
        self.assertLessEqual(server.clock.now, 1240)
        self.assertEqual(server.ops.count('upload_begin'), 1)
        self.assertEqual(server.ops.count('stop'), 1)
        self.assertNotIn('start', server.ops)

    def test_total_deadline_and_json_budget_fail_closed(self):
        server = FakeServer()
        with mock.patch.object(tool, 'time', server.clock), mock.patch.object(tool.socket, 'create_connection', side_effect=server.connect):
            client = tool.Client(tool.Deadline(2))
            with self.assertRaises(TimeoutError):
                client.receive()
            self.assertLessEqual(server.clock.now, 1002)
            client.close()
        for payload in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e999}', b'[]', b'{"x":' + b'[' * 33 + b'0' + b']' * 33 + b'}'):
            with self.subTest(payload=payload[:40]), self.assertRaises(ValueError):
                tool.json_object(payload)

    def test_bad_mode_endpoint_or_commands_never_connect(self):
        for args in (['--host', '8.8.8.8'], ['shell'], ['cpu_frequency']):
            with self.subTest(args=args), mock.patch.object(tool.socket, 'create_connection') as connect, mock.patch.object(tool.sys, 'stdout', io.StringIO()):
                self.assertEqual(tool.main(args), 1)
                connect.assert_not_called()

    def test_z_no_real_network_runtime_or_process_events(self):
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(FixedAcceptance))
    output = stream.getvalue()
    print(output, end='')
    evidence = ROOT / 'output/hardware/2026-10-16-continuation/fixed-tcp-acceptance'
    evidence.mkdir(parents=True, exist_ok=True)
    report = dict(fixtureOnly=True, realTcp=False, hardwareAccessed=False, sshExecuted=False, testsRun=result.testsRun, successful=result.wasSuccessful(), blockedEvents=BLOCKED, sourceSha256=hashlib.sha256(TOOL.read_bytes()).hexdigest(), testSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), output=output)
    (evidence / ('mock-%d.json' % int(time.time() * 1000))).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    sys.exit(0 if result.wasSuccessful() else 1)
