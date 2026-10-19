"""Offline post-compute mocks; no service, SSH, application or device actions."""
import ast
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOL = ROOT / 'engineering/fz3b/tools/probe_post_compute.py'
probe = load('fz3b_probe_post_compute', TOOL)
fixtures = load('fz3b_lifecycle_fixture_tests', ROOT / 'tests/test_service_lifecycle.py')


def completed_status(**changes):
    value = fixtures.raw_status(
        inference={'state': 'STOPPED', 'error': None, 'frames': 1}, query_revision=1, input_source='upload',
        upload={'job_id': probe.EXPECTED_JOB, 'finished': True, 'cancelled': False, 'error': None,
                'received': 1, 'completed': 1, 'queued': 0})
    value.update(changes)
    return value


class FixtureAccess(fixtures.FixtureAccess):
    def __init__(self):
        super().__init__('stop')
        self.status_value = completed_status()

    def status(self, boot):
        self.events.append('status')
        checked = probe.checked_status(self.status_value, boot)
        self.probe_closed = True
        return {'hello': checked, 'status': checked, 'probeSocketClosedBeforeFdScan': True}


class PostComputeTests(unittest.TestCase):
    def test_historical_v2_pins_reject_missing_or_current_canonical_python_without_action(self):
        self.assertEqual(probe.APPROVED_HASHES, fixtures.V2_HASHES)
        for name in ('board_agent.py', 'camera.py'):
            for missing in (False, True):
                with self.subTest(name=name, missing=missing):
                    access = FixtureAccess()
                    target = probe.PROJECT + '/vision_app/' + name
                    if missing:
                        del access.data[target]
                    else:
                        access.data[target] = (ROOT / 'engineering/fz3b/source/PS/vision_app' / name).read_bytes()
                    result = probe.collect(access)
                    self.assertEqual(result['result'], 'blocked', result)
                    self.assertEqual(access.actions, [])

    def test_valid_completed_single_image_is_readonly_passed(self):
        access = FixtureAccess()
        result = probe.collect(access)
        self.assertEqual(result['result'], 'passed', result)
        self.assertEqual(access.actions, [])
        self.assertEqual(result['expectedQueryRevision'], 1)
        self.assertEqual(result['expectedInferenceFrames'], 1)
        self.assertEqual(result['preRead'], result['postRead'])
        self.assertEqual(result['applicationBefore'], result['applicationAfter'])
        self.assertEqual(result['dependenciesBefore'], result['dependenciesAfter'])
        self.assertEqual(result['quiescence']['a0005Owners'], [])
        self.assertEqual(result['finalQuiescence']['active8765'], [])
        self.assertLess(access.events.index('status'), access.events.index('scan'))
        self.assertEqual(access.events.count('status'), 1)
        self.assertEqual(access.events.count('scan'), 2)
        for key in ('filesWritten', 'deviceOpened', 'applicationImported', 'authenticationFilesRead'):
            self.assertFalse(result[key])

    def test_fixed_boot_unit_config_and_each_python_hash_are_required(self):
        alterations = [(probe.BOOT_PATH, b'00000000-0000-0000-0000-000000000000\n'),
                       (probe.UNIT_PATH, b'[Service]\nSendSIGKILL=yes\n'),
                       (probe.CONFIG_PATH, b'{"bind":"0.0.0.0"}'),
                       (probe.CONFIG_PATH, b'{"bind":"127.0.0.1","video_port":9999}')]
        for name in probe.APPROVED_HASHES:
            path = probe.PROJECT + '/vision_app/' + name
            alterations.append((path, b'unexpected bytes'))
        for path, data in alterations:
            with self.subTest(path=path):
                access = FixtureAccess()
                access.data[path] = data
                self.assertEqual(probe.collect(access)['result'], 'blocked')
                self.assertEqual(access.actions, [])
                self.assertNotIn('status', access.events)

    def test_partial_count_extra_frame_changed_revision_or_boolean_count_rejected(self):
        for changes in [{'query_revision': 2}, {'query_revision': True},
                        {'inference': {'state': 'STOPPED', 'error': None, 'frames': 0}},
                        {'inference': {'state': 'STOPPED', 'error': None, 'frames': 2}},
                        {'inference': {'state': 'STOPPED', 'error': None, 'frames': True}}]:
            with self.subTest(changes=changes), self.assertRaises(probe.LifecycleError):
                probe.checked_status(completed_status(**changes), probe.EXPECTED_BOOT)

    def test_running_cleanup_error_wrong_contract_or_boot_rejected(self):
        for changes in [{'inference': {'state': 'RUNNING', 'error': None, 'frames': 1}},
                        {'inference': {'state': 'STOPPED', 'error': '', 'frames': 1}},
                        {'inference': {'state': 'STOPPED', 'frames': 1}},
                        {'boot_id': 'other'}, {'contract_id': '0' * 64}, {'input_source': 'camera'},
                        {'cpu_frequency_changing': True}]:
            with self.subTest(changes=changes):
                access = FixtureAccess()
                access.status_value.update(changes)
                self.assertEqual(probe.collect(access)['result'], 'blocked')
                self.assertEqual(access.actions, [])

    def test_only_the_fixed_clean_finished_upload_job_is_accepted(self):
        for changes in [{'job_id': 'other'}, {'finished': False}, {'cancelled': True}, {'error': ''},
                        {'queued': 1}, {'received': 2}, {'completed': 0}, {'completed': True}]:
            with self.subTest(changes=changes):
                value = completed_status()
                value['upload'].update(changes)
                with self.assertRaises(probe.LifecycleError):
                    probe.checked_status(value, probe.EXPECTED_BOOT)
        with self.assertRaises(probe.LifecycleError):
            probe.checked_status(completed_status(upload=None), probe.EXPECTED_BOOT)

    def test_inactive_app_or_dependency_is_blocked_without_service_action(self):
        access = FixtureAccess()
        access.active = False
        self.assertEqual(probe.collect(access)['result'], 'blocked')
        for unit in probe.DEPENDENCIES:
            with self.subTest(unit=unit):
                access = FixtureAccess()
                access.dependency_changes[unit] = {'ActiveState': 'inactive'}
                self.assertEqual(probe.collect(access)['result'], 'blocked')
                self.assertEqual(access.actions, [])

    def test_device_owner_live_connection_foreign_listener_and_scan_error_are_blocked(self):
        for changes in [{'a0005Owners': [{'pid': 100, 'fd': 3}]}, {'active8765': [{'state': '08'}]},
                        {'listeners8765': [{'owners': [{'pid': 100}]}]}, {'listeners8765': [{'owners': []}]}]:
            with self.subTest(changes=changes):
                access = FixtureAccess()
                access.scan_changes = changes
                self.assertEqual(probe.collect(access)['result'], 'blocked')
                self.assertEqual(access.actions, [])
        access = FixtureAccess()
        access.scan = mock.Mock(side_effect=PermissionError('private text must not be emitted'))
        result = probe.collect(access)
        self.assertEqual(result['result'], 'blocked')
        self.assertNotIn('private text', json.dumps(result))

    def test_changed_files_boot_app_or_dependency_cannot_pass_second_observation(self):
        for change in ('file', 'boot', 'pid', 'dependency'):
            with self.subTest(change=change):
                access = FixtureAccess()
                scan = access.scan
                def changed_scan():
                    value = scan()
                    if change == 'file':
                        access.data[probe.PROJECT + '/run.sh'] += b'# changed\n'
                    elif change == 'boot':
                        access.data[probe.BOOT_PATH] = b'00000000-0000-0000-0000-000000000000\n'
                    elif change == 'pid':
                        access.pid += 1
                    else:
                        access.dependency_changes[probe.DEPENDENCIES[0]] = {'MainPID': '8888'}
                    return value
                access.scan = changed_scan
                self.assertEqual(probe.collect(access)['result'], 'blocked')

    def test_no_raw_config_fields_are_emitted(self):
        access = FixtureAccess()
        config = json.loads(access.data[probe.CONFIG_PATH])
        config['secret'] = 'private-config-not-to-emit'
        access.data[probe.CONFIG_PATH] = json.dumps(config).encode('utf-8')
        result = probe.collect(access)
        self.assertEqual(result['result'], 'passed')
        self.assertNotIn('private-config-not-to-emit', json.dumps(result))

    def test_main_has_no_operation_or_path_override_parameters(self):
        output = io.StringIO()
        with mock.patch.object(probe, 'SystemAccess', return_value=FixtureAccess()), mock.patch('sys.stdout', output):
            self.assertEqual(probe.main([]), 0)
        self.assertEqual(json.loads(output.getvalue())['result'], 'passed')
        for args in (['--mode', 'start'], ['--expected-boot-id', 'other'], ['--path', '/tmp/x']):
            with self.subTest(args=args), mock.patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit):
                probe.main(args)


class ProtocolAndProcessTests(unittest.TestCase):
    def test_fragmented_hello_and_status_only_fixed_loopback_then_close(self):
        hello = completed_status(type='hello', ok=True)
        ack = {'type': 'ack', 'op': 'status', 'request_id': 'fixed-lifecycle-status', 'ok': True,
               'result': completed_status()}
        link = fixtures.FakeSocket(fixtures.wire(hello) + fixtures.wire(ack))
        result = probe.query_status(probe.EXPECTED_BOOT, lambda *args: link)
        self.assertTrue(link.closed)
        self.assertEqual(link.destination, ('127.0.0.1', 8765))
        self.assertEqual([json.loads(data[probe.HEADER.size:])['op'] for data in link.sent], ['hello', 'status'])
        self.assertEqual(result['status']['inference']['frames'], 1)

    def test_protocol_rejects_changed_status_between_hello_and_ack(self):
        hello = completed_status(type='hello', ok=True)
        ack = {'type': 'ack', 'op': 'status', 'request_id': 'fixed-lifecycle-status', 'ok': True,
               'result': completed_status(query_revision=2)}
        link = fixtures.FakeSocket(fixtures.wire(hello) + fixtures.wire(ack))
        with self.assertRaises(probe.LifecycleError):
            probe.query_status(probe.EXPECTED_BOOT, lambda *args: link)
        self.assertTrue(link.closed)

    def test_systemctl_has_only_show_and_a_fixed_unit(self):
        data = '\n'.join(key + '=' + value for key, value in fixtures.properties().items()).encode('utf-8')
        child = mock.Mock(pid=88, returncode=0)
        child.communicate.return_value = (data, None)
        factory = mock.Mock(return_value=child)
        self.assertEqual(probe.show_service(probe.UNIT, factory), fixtures.properties())
        args, options = factory.call_args
        self.assertEqual(args[0][:4], ['/bin/systemctl', 'show', probe.UNIT, '--no-pager'])
        self.assertEqual(options['env'], probe.CHILD_ENV)
        self.assertFalse(options['shell'])
        with self.assertRaises(probe.LifecycleError):
            probe.show_service('other.service', factory)
        self.assertEqual(factory.call_count, 1)

    def test_readonly_show_timeout_never_kills_or_retries(self):
        child = mock.Mock(pid=88)
        child.communicate.side_effect = subprocess.TimeoutExpired('systemctl', 5)
        factory = mock.Mock(return_value=child)
        with self.assertRaises(probe.LifecycleError):
            probe.show_service(probe.UNIT, factory)
        child.kill.assert_not_called()
        child.terminate.assert_not_called()
        self.assertEqual(factory.call_count, 1)

    def test_safe_read_proc_protocol_and_guards_match_frozen_lifecycle_ast(self):
        original = ast.parse((ROOT / 'engineering/fz3b/tools/service_lifecycle.py').read_text(encoding='utf-8'))
        current = ast.parse(TOOL.read_text(encoding='utf-8'), feature_version=(3, 6))
        old = {node.name: node for node in original.body if isinstance(node, ast.FunctionDef)}
        new = {node.name: node for node in current.body if isinstance(node, ast.FunctionDef)}
        for name in ('require', 'unique_pairs', 'json_object', 'read_fixed', 'query_status', 'tcp_rows',
                     'scan_quiescence', 'checked_service', 'dependencies', 'quiescence'):
            with self.subTest(function=name):
                self.assertEqual(ast.dump(old[name], include_attributes=False), ast.dump(new[name], include_attributes=False))
        for node in ast.walk(current):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotIn(node.func.attr, ('kill', 'terminate', 'system', 'run', 'action'))
            if isinstance(node, ast.ImportFrom):
                self.assertNotIn('vision_app', node.module or '')
        self.assertNotIn('lifecycle', new)
        self.assertNotIn('run_systemctl', new)


if __name__ == '__main__':
    unittest.main(verbosity=2)
