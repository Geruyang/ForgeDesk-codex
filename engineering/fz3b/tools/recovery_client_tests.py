"""Offline fake-transport tests, never evidence of real disconnect/network faults."""
import ast
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import struct
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
SOURCE = Path(__file__).with_name('recovery_client_probe.py')
GUARD_ACTIVE = False
BLOCKED = []
tool = None


def audit(event, args):
    if GUARD_ACTIVE and (event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system'):
        BLOCKED.append(event)
        raise RuntimeError('Offline recovery tests prohibit network/process activity')
    if GUARD_ACTIVE and event == 'import' and any(part in args[0].split('.') for part in ('serial', 'pyocd', 'paramiko', 'vision_app')):
        BLOCKED.append(event)
        raise RuntimeError('Offline recovery tests prohibit hardware/application imports')


sys.addaudithook(audit)


def setUpModule():
    global GUARD_ACTIVE, tool
    GUARD_ACTIVE = True
    try:
        spec = importlib.util.spec_from_file_location('recovery_client_probe_test', str(SOURCE))
        tool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(tool)
    except BaseException:
        GUARD_ACTIVE = False
        raise


def tearDownModule():
    global GUARD_ACTIVE
    GUARD_ACTIVE = False


def status():
    return dict(type='status', protocol=1, platform='A0005', contract_id=tool.CONTRACT_ID,
                boot_id=tool.EXPECTED_BOOT, inference=dict(state='STOPPED', error=None, frames=1, max_in_flight=4),
                query_revision=1, threshold=.2, result_delivery_drops=0, input_source='upload',
                cpu_frequency_changing=False, cpu=dict(verified=True, current_khz=1199999, actual_hz=1199999988),
                upload=dict(job_id='prior-completed-job', received=1, completed=1, queued=0,
                            finished=True, cancelled=False, error=None))


class FakeSocket:
    def __init__(self, access, index):
        self.access, self.index = access, index
        self.pending = bytearray()
        self.closed, self.sent, self.timeouts = False, [], []

    def settimeout(self, seconds):
        assert 0 < seconds <= 5
        self.timeouts.append(seconds)

    def sendall(self, raw):
        assert not self.closed
        magic, version, kind, flags, size, crc = tool.HEADER.unpack(raw[:16])
        assert (magic, version, kind, flags, size) == (b'FZVA', 1, 1, 0, len(raw) - 16)
        request = tool.json_object(raw[16:])
        self.sent.append(request)
        op = request['op']
        assert op in ('hello', 'status', 'settings')
        if op == 'hello':
            response = dict(copy.deepcopy(self.access.state), type='hello', ok=True)
        elif op == 'status':
            response = dict(type='ack', op=op, request_id=request['request_id'], ok=True,
                            result=copy.deepcopy(self.access.state))
        else:
            assert request == dict(op='settings', request_id=request['request_id'], threshold=2)
            response = dict(type='ack', op=op, request_id=request['request_id'], ok=False,
                            error='threshold must be finite in [-1,1]')
        raw = self.access.respond(self, request, response)
        if raw is not None:
            self.pending.extend(raw)

    def recv(self, size):
        if not self.pending:
            raise socket.timeout('fake transport timeout, not a real network fault')
        size = min(size, self.access.chunk)
        part = bytes(self.pending[:size])
        del self.pending[:size]
        return part

    def close(self):
        self.closed = True
        if self.access.close_error:
            raise OSError('fake close failure')


class FakeAccess:
    def __init__(self):
        self.state = status()
        self.links, self.attempts = [], 0
        self.chunk = 7
        self.close_error, self.connect_error, self.read_error = False, 0, False
        self.clock, self.reads = 1.0, 0
        self.raw = {tool.BOOT_PATH: (tool.EXPECTED_BOOT + '\n').encode('ascii'),
                    tool.CONFIG: b'{"bind":"127.0.0.1","control_port":8765,"video_port":8766}',
                    tool.CONTRACT: b'fake-contract-byte-seal'}
        self.raw.update((tool.APP + '/vision_app/' + name, name.encode('ascii')) for name in tool.APPROVED_HASHES)
        self.respond = lambda link, request, response: tool.frame(response)

    def check_environment(self):
        pass

    def monotonic(self):
        return self.clock

    def read(self, path):
        self.reads += 1
        if self.read_error:
            raise OSError('fake read failure')
        return self.raw[path]

    def connect(self, seconds):
        self.attempts += 1
        if self.connect_error == self.attempts:
            raise socket.timeout('fake connect failure, not a real fault')
        link = FakeSocket(self, self.attempts)
        self.links.append(link)
        return link


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.access = FakeAccess()
        pins = {name: hashlib.sha256(self.access.raw[tool.APP + '/vision_app/' + name]).hexdigest()
                for name in tool.APPROVED_HASHES}
        self.pins = mock.patch.dict(tool.APPROVED_HASHES, pins, clear=True)
        self.contract = mock.patch.object(tool, 'CONTRACT_SHA', hashlib.sha256(self.access.raw[tool.CONTRACT]).hexdigest())
        self.pins.start()
        self.contract.start()
        self.addCleanup(self.pins.stop)
        self.addCleanup(self.contract.stop)

    def run_probe(self, scenario='disconnect'):
        result = tool.collect(scenario, self.access)
        self.assertFalse(result['compute_requested'])
        self.assertFalse(result['service_actions'])
        self.assertFalse(result['device_opened'])
        self.assertFalse(result['files_written'])
        self.assertFalse(result['network_fault_injected'])
        self.assertEqual(result['retries'], 0)
        self.assertFalse(result['replay_attempted'])
        self.assertTrue(all(link.closed for link in self.access.links))
        return result

    def test_disconnect_closes_then_opens_exactly_one_new_client(self):
        result = self.run_probe()
        self.assertEqual(result['result'], 'passed')
        self.assertEqual(result['connections_attempted'], 2)
        self.assertEqual(result['normal_closes_confirmed'], 2)
        self.assertEqual(result['before'], result['fresh_connection_after'])
        self.assertEqual([[item['op'] for item in link.sent] for link in self.access.links],
                         [['hello', 'status'], ['hello', 'status']])

    def test_rejection_then_same_and_fresh_legal_status(self):
        result = self.run_probe('rejection')
        self.assertEqual(result['result'], 'passed')
        self.assertEqual(result['rejection']['ok'], False)
        self.assertEqual(result['before'], result['same_connection_after'])
        self.assertEqual([[item['op'] for item in link.sent] for link in self.access.links],
                         [['hello', 'status', 'settings', 'status'], ['hello', 'status']])

    def test_checkpoint_has_only_one_connection(self):
        result = self.run_probe('checkpoint')
        self.assertEqual(result['result'], 'passed')
        self.assertEqual(result['connections_attempted'], 1)

    def test_null_upload_idle_accepted(self):
        self.access.state.update(upload=None, input_source='camera')
        self.assertEqual(self.run_probe()['result'], 'passed')

    def test_deployed_pin_mismatch_blocks_before_connect(self):
        self.access.raw[tool.APP + '/vision_app/protocol.py'] += b'changed'
        result = self.run_probe()
        self.assertEqual(result['result'], 'blocked')
        self.assertEqual(self.access.attempts, 0)

    def test_boot_config_or_contract_mismatch_blocks(self):
        for path, raw in ((tool.BOOT_PATH, b'wrong-boot'), (tool.CONFIG, b'{"bind":"0.0.0.0"}'),
                          (tool.CONFIG, b'{"bind":"127.0.0.1","control_port":true}'),
                          (tool.CONTRACT, b'wrong-contract')):
            with self.subTest(path=path):
                before = self.access.raw[path]
                self.access.raw[path] = raw
                self.assertEqual(self.run_probe()['result'], 'blocked')
                self.assertEqual(self.access.attempts, 0)
                self.access.raw[path] = before

    def test_read_failure_blocks_without_network(self):
        self.access.read_error = True
        self.assertEqual(self.run_probe()['result'], 'blocked')
        self.assertEqual(self.access.attempts, 0)

    def test_inference_active_failed_or_missing_error_blocks(self):
        for changes in ({'state': 'RUNNING'}, {'state': 'DRAINING'}, {'state': 'FAILED'}, {'error': 'failure'}):
            with self.subTest(changes=changes):
                self.access = FakeAccess()
                self.access.state['inference'].update(changes)
                self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')
                self.assertEqual(self.access.attempts, 1)

    def test_upload_unfinished_cancelled_queued_or_incomplete_blocks(self):
        for changes in ({'finished': False}, {'cancelled': True}, {'queued': 1}, {'completed': 0}, {'error': 'failure'}, {'received': True}):
            with self.subTest(changes=changes):
                self.access = FakeAccess()
                self.access.state['upload'].update(changes)
                self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')
                self.assertEqual(self.access.attempts, 1)

    def test_status_identity_and_clock_gate(self):
        for changes in ({'boot_id': 'foreign'}, {'contract_id': '0' * 64}, {'platform': 'other'}, {'protocol': True},
                        {'cpu_frequency_changing': True}, {'threshold': float('inf')}, {'cpu': {'verified': False}}):
            with self.subTest(changes=changes):
                self.access = FakeAccess()
                self.access.state.update(changes)
                self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')

    def test_changed_state_after_normal_close_is_not_repaired(self):
        respond = self.access.respond
        def changed(link, request, response):
            if link.index == 2 and request['op'] == 'hello':
                response['query_revision'] += 1
            return respond(link, request, response)
        self.access.respond = changed
        result = self.run_probe()
        self.assertEqual(result['result'], 'failed-or-unknown')
        self.assertEqual([item['op'] for item in self.access.links[1].sent], ['hello'])

    def test_rejection_timeout_never_replays_settings(self):
        self.access.respond = lambda link, request, response: None if request['op'] == 'settings' else tool.frame(response)
        result = self.run_probe('rejection')
        self.assertEqual(result['result'], 'failed-or-unknown')
        self.assertEqual(self.access.attempts, 1)
        self.assertEqual([item['op'] for item in self.access.links[0].sent], ['hello', 'status', 'settings'])
        self.assertTrue(result['human_review_required'])

    def test_rejection_must_have_exact_negative_ack(self):
        for changes in ({'ok': True}, {'op': 'other'}, {'request_id': 'foreign'}, {'error': 'other rejection'}):
            with self.subTest(changes=changes):
                self.access = FakeAccess()
                def respond(link, request, response):
                    if request['op'] == 'settings':
                        response.update(changes)
                    return tool.frame(response)
                self.access.respond = respond
                self.assertEqual(self.run_probe('rejection')['result'], 'failed-or-unknown')
                self.assertEqual(self.access.attempts, 1)

    def test_failed_fresh_connect_is_unknown_not_retry(self):
        self.access.connect_error = 2
        result = self.run_probe()
        self.assertEqual(result['result'], 'failed-or-unknown')
        self.assertEqual(self.access.attempts, 2)
        self.assertEqual(result['normal_closes_confirmed'], 1)

    def test_close_failure_aborts_before_next_connection(self):
        self.access.close_error = True
        result = self.run_probe()
        self.assertEqual(result['result'], 'failed-or-unknown')
        self.assertEqual(self.access.attempts, 1)
        self.assertEqual(result['normal_closes_confirmed'], 0)

    def test_post_files_change_is_unknown(self):
        respond = self.access.respond
        def changed(link, request, response):
            if link.index == 2:
                self.access.raw[tool.CONFIG] += b' '
            return respond(link, request, response)
        self.access.respond = changed
        self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')

    def test_unsolicited_status_is_checked_not_ignored(self):
        def respond(link, request, response):
            if request['op'] == 'status':
                extra = copy.deepcopy(self.access.state)
                extra['threshold'] = .8
                return tool.frame(extra) + tool.frame(response)
            return tool.frame(response)
        self.access.respond = respond
        self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')

    def test_message_and_total_time_budgets(self):
        def respond(link, request, response):
            return tool.frame(self.access.state) * 34 if request['op'] == 'status' else tool.frame(response)
        self.access.respond = respond
        self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')
        self.access = FakeAccess()
        def expired(link, request, response):
            self.access.clock = 42
            return tool.frame(response)
        self.access.respond = expired
        self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')

    def test_bad_frame_crc_extent_kind_and_eof(self):
        for kind in ('crc', 'size', 'kind', 'eof'):
            with self.subTest(kind=kind):
                self.access = FakeAccess()
                def respond(link, request, response):
                    raw = bytearray(tool.frame(response))
                    if kind == 'crc': raw[-1] ^= 1
                    if kind == 'size': struct.pack_into('<I', raw, 8, tool.MAX_JSON + 1)
                    if kind == 'kind': raw[5] = 5
                    if kind == 'eof':
                        link.recv = lambda size: b''
                    return bytes(raw)
                self.access.respond = respond
                self.assertEqual(self.run_probe()['result'], 'failed-or-unknown')

    def test_invalid_scenario_has_no_effect(self):
        self.assertEqual(self.run_probe('restart')['result'], 'blocked')
        self.assertEqual(self.access.attempts, 0)


class ParserAndBoundaryTests(unittest.TestCase):
    def test_json_duplicate_nonfinite_depth_number_and_object_bounds(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e999}', b'{"x":' + b'1' * 65 + b'}',
                    b'[]', b'{"x":' + b'[' * 30 + b'0' + b']' * 30 + b'}', b'x' * (tool.MAX_JSON + 1)):
            with self.subTest(raw=raw[:32]), self.assertRaises((tool.ProbeError, ValueError)):
                tool.json_object(raw)

    def test_fixed_read_refuses_all_other_paths_before_os_open(self):
        with mock.patch.object(tool.os, 'open', side_effect=AssertionError('must not open')):
            for path in ('/dev/mem', '/etc/shadow', '../config.json', 'ssh://host/file'):
                with self.subTest(path=path), self.assertRaises(tool.ProbeError):
                    tool.read_fixed(path)

    def test_only_fixed_ipv4_loopback_connect(self):
        link = mock.Mock()
        with mock.patch.object(tool.socket, 'socket', return_value=link) as factory:
            tool.SystemAccess().connect(5)
        factory.assert_called_once_with(socket.AF_INET, socket.SOCK_STREAM)
        link.connect.assert_called_once_with(('127.0.0.1', 8765))
        link.settimeout.assert_called_once_with(3)

    def test_connect_failure_closes_owned_socket_without_retry(self):
        link = mock.Mock()
        link.connect.side_effect = socket.timeout()
        with mock.patch.object(tool.socket, 'socket', return_value=link) as factory, self.assertRaises(socket.timeout):
            tool.SystemAccess().connect(5)
        self.assertEqual(factory.call_count, 1)
        link.close.assert_called_once_with()

    def test_python36_grammar_and_no_process_or_application_imports(self):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'), feature_version=(3, 6))
        imports = [item.name for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))
                   for item in node.names]
        self.assertFalse(set(imports) & {'subprocess', 'paramiko', 'serial', 'vision_app', 'ctypes'})
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
