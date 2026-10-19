"""Offline worker logic only. No SSH, sockets, device, service or loader access."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sys
import types
import unittest
from unittest import mock

try:
    import fcntl
except ImportError:
    fcntl = types.ModuleType('fcntl')
    fcntl.LOCK_EX = 2
    fcntl.LOCK_NB = 4
    fcntl.flock = lambda *args: None
    sys.modules['fcntl'] = fcntl

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fz3b_product_remote_offline', ROOT / 'remote.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
wire = types.ModuleType('fz3b_product_wire_offline')
exec(compile((ROOT / 'resources/remote/wire.py').read_bytes(), 'pinned-wire.py', 'exec'), wire.__dict__)
FIXTURE = json.loads((ROOT / 'resources/fixture/host-fixture.json').read_text(encoding='utf-8'))
QUERY_BYTES = (ROOT / 'resources/fixture/query-template.json').read_bytes()
QUERY = json.loads(QUERY_BYTES.decode('utf-8'))
IMAGE = (ROOT / 'resources/fixture/input.jpg').read_bytes()


def request():
    return {'schemaVersion': 1, 'action': 'semantic', 'operationId': '00000000-0000-4000-8000-000000000001',
            'nonce': 'a' * 64, 'profileSha256': 'b' * 64, 'fixture': FIXTURE,
            'queriesB64': base64.b64encode(QUERY_BYTES).decode('ascii'), 'imageB64': base64.b64encode(IMAGE).decode('ascii'),
            'grantRemainingMs': 300000,
            'grant': {'id': 'offline-grant', 'approvedAt': '2026-10-16T00:00:00Z',
                      'consumedBy': '00000000-0000-4000-8000-000000000001', 'profileSha256': 'b' * 64,
                      'scope': 'existing-candidate008-real-text-single-image-once'}}


def status(revision=5, frames=0):
    return {'type': 'status', 'protocol': 1, 'platform': 'A0005', 'contract_id': worker.CONTRACT, 'boot_id': worker.BOOT,
            'inference': {'state': 'STOPPED', 'error': None, 'frames': frames, 'max_in_flight': 1},
            'query_revision': revision, 'threshold': .2, 'result_delivery_drops': 0, 'cpu_frequency_changing': False}


class FakeClient:
    all_clients = []
    wrong_job = False
    fail_receive = False

    def __init__(self, deadline):
        self.deadline = deadline
        self.messages = 0
        self.results = []
        self.last_status = status()
        self.last_status_sequence = 0
        self.result_sequence = 0
        self.commands = []
        self.sent_frames = 0
        self.closed = False
        self.all_clients.append(self)

    def hello(self):
        return status()

    def status(self):
        self.messages += 1
        self.last_status_sequence = self.messages
        return self.last_status

    def command(self, op, **fields):
        self.commands.append((op, fields))
        self.messages += 1
        if op == 'queries':
            self.revision = fields['revision']
            return {'result': {'query_revision': self.revision, 'count': 4}}
        if op == 'upload_begin':
            self.job = fields['job_id']
            return {'result': {'job_id': self.job, 'credits': 1}}
        if op == 'upload_finish':
            self.result_sequence = self.messages
            self.results = [{'type': 'result', 'source': 'upload', 'job_id': 'wrong-job' if self.wrong_job else self.job,
                             'frame_id': 0, 'video_time_s': 0, 'source_width': 914, 'source_height': 512,
                             'query_revision': self.revision, 'identity': QUERY['identity'],
                             'ranking': [{'id': key, 'label': key, 'score': score} for key, score in
                                         zip(worker.QUERY_IDS, (.3, .1, .08, .07))]}]
            self.last_status = status(self.revision, 1)
            self.last_status['upload'] = {'job_id': self.job, 'received': 1, 'completed': 1, 'queued': 0,
                                          'finished': True, 'cancelled': False, 'error': None}
            return {'result': self.last_status['upload']}
        raise AssertionError('Unexpected command: ' + op)

    def send(self, payload, kind):
        if self.fail_receive:
            raise EOFError('Synthetic stream loss after upload admission')
        self.sent_frames += 1
        if kind != wire.INPUT_FRAME:
            raise AssertionError('Unexpected frame kind')

    def receive(self):
        raise AssertionError('Mock supplied a complete single result; no extra receive expected')

    def close(self):
        self.closed = True


class RemoteTests(unittest.TestCase):
    def setUp(self):
        FakeClient.all_clients = []
        FakeClient.wrong_job = False
        FakeClient.fail_receive = False

    def test_real_frozen_dense_queries_and_image_are_admitted(self):
        query, image = worker.checked_fixture(request())
        self.assertEqual([item['id'] for item in query['items']], worker.QUERY_IDS)
        self.assertEqual(len(image), 144219)

    def test_changed_image_and_query_bytes_are_rejected(self):
        for key in ('queriesB64', 'imageB64'):
            value = request()
            value[key] = base64.b64encode(b'changed').decode('ascii')
            with self.assertRaises(ValueError):
                worker.checked_fixture(value)

    def test_inspect_is_metadata_only_without_loading_wire_or_app_client(self):
        value = request()
        value['action'] = 'inspect'
        output = io.StringIO()
        with mock.patch.object(worker, 'metadata', return_value={'bootId': worker.BOOT}), \
                mock.patch.object(worker, 'require_idle', return_value={'deviceOwners': [], 'controlConnections': 0}), \
                mock.patch.object(worker, 'semantic', side_effect=AssertionError('No semantic call allowed')), contextlib.redirect_stdout(output):
            worker.forgedesk_main(value, b'not executable source')
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt['status'], 'succeeded')
        self.assertTrue(receipt['readOnly'])

    def test_inspect_metadata_failure_never_claims_quiescence(self):
        value = request()
        value['action'] = 'inspect'
        output = io.StringIO()
        with mock.patch.object(worker, 'metadata', side_effect=ValueError('config-changed')), contextlib.redirect_stdout(output):
            worker.forgedesk_main(value, b'')
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt['status'], 'failed')
        self.assertFalse(receipt['remoteQuiescent'])

    def test_native_grant_missing_or_expired_blocks_before_client_creation(self):
        for field, value in (('grant', {}), ('grantRemainingMs', 0)):
            payload = request()
            payload[field] = value
            with mock.patch.object(wire, 'Client', FakeClient), self.assertRaises(ValueError):
                worker.semantic(payload, wire, {}, worker.time.monotonic())
        self.assertEqual(FakeClient.all_clients, [])

    def run_semantic(self):
        journals = []
        identity = {'bootId': worker.BOOT, 'mainPid': 1234}
        with mock.patch.object(wire, 'Client', FakeClient), mock.patch.object(worker, 'acquire_journal', return_value=(42, 'fixed-journal')), \
                mock.patch.object(worker, 'write_journal', side_effect=lambda path, value: journals.append(value)), \
                mock.patch.object(worker, 'require_idle', return_value={'deviceOwners': [], 'controlConnections': 0}), \
                mock.patch.object(worker, 'metadata', return_value=identity), mock.patch.object(worker.os, 'close') as close:
            try:
                result = worker.semantic(request(), wire, identity, worker.time.monotonic())
            finally:
                self.assertEqual(close.call_args.args, (42,))
        return result, journals

    def test_actual_fixed_fixture_logic_uses_fresh_revision_and_exactly_one_job(self):
        result, journals = self.run_semantic()
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['semantic']['queryRevision'], 6)
        self.assertEqual(result['semantic']['completedFrames'], 1)
        self.assertEqual(result['semantic']['jobId'], 'fd-semantic-00000000000040008000000000000001')
        self.assertEqual(result['semantic']['threshold'], .2)
        self.assertTrue(result['semantic']['thresholdHit'])
        self.assertTrue(result['semantic']['expectedLabelMatched'])
        client = FakeClient.all_clients[0]
        self.assertEqual([item[0] for item in client.commands], ['queries', 'upload_begin', 'upload_finish'])
        self.assertEqual(client.sent_frames, 1)
        self.assertTrue(client.closed)
        self.assertTrue(journals[-1]['remoteQuiescent'])

    def test_wrong_job_and_post_admission_loss_stay_unknown_in_journal(self):
        for failure in ('wrong_job', 'fail_receive'):
            setattr(FakeClient, failure, True)
            journals = []
            with mock.patch.object(wire, 'Client', FakeClient), mock.patch.object(worker, 'acquire_journal', return_value=(42, 'fixed-journal')), \
                    mock.patch.object(worker, 'write_journal', side_effect=lambda path, value: journals.append(value)), \
                    mock.patch.object(worker.os, 'close'), self.assertRaises((ValueError, EOFError)):
                worker.semantic(request(), wire, {}, worker.time.monotonic())
            self.assertEqual(journals[-1]['status'], 'unknown')
            self.assertFalse(journals[-1]['remoteQuiescent'])
            setattr(FakeClient, failure, False)

    def test_device_alias_owner_is_detected_by_character_rdev(self):
        character = types.SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=42)
        with mock.patch.object(worker.os, 'stat', return_value=character), \
                mock.patch.object(worker.os, 'listdir', side_effect=lambda path: ['123'] if path == '/proc' else ['8']), \
                mock.patch.object(worker.os, 'readlink', return_value='/dev/alias-name'), \
                mock.patch.object(worker, 'safe_read', return_value=b'header\n'):
            self.assertEqual(worker.idle_scan()['deviceOwners'], [123])


if __name__ == '__main__':
    unittest.main()
