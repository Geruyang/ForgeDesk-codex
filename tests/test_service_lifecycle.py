"""Offline lifecycle fixtures only. Never SSH, spawn a service, or open a device."""
import ast
import copy
import errno
import hashlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import socket
import stat
import subprocess
import unittest
from unittest import mock
import zlib


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'engineering/fz3b/tools/service_lifecycle.py'
SPEC = importlib.util.spec_from_file_location('fz3b_service_lifecycle', TOOL)
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)
BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
HISTORICAL_SOURCE = ROOT / 'output/hardware/2026-10-16-continuation/release-source-v2/PS'
V2_HASHES = {
    'board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
    'camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
    'image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
    'protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
    'upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
}


def historical_code():
    # These tests model the deployed v2 epoch, never the evolving canonical PS.
    if service.APPROVED_HASHES != V2_HASHES:
        raise AssertionError('historical-v2-production-pins-changed')
    data = {path: (HISTORICAL_SOURCE / path[len(service.PROJECT) + 1:]).read_bytes()
            for path in service.CODE_PATHS}
    expected = dict(V2_HASHES, **{'semantic-contract.json': service.CONTRACT_SHA256})
    for name, digest in expected.items():
        if hashlib.sha256(data[service.PROJECT + '/vision_app/' + name]).hexdigest() != digest:
            raise AssertionError('historical-v2-fixture-hash-mismatch:' + name)
    unit = (HISTORICAL_SOURCE / 'services/fz3b-vision-console.service').read_bytes().replace(b'\r\n', b'\n')
    if hashlib.sha256(unit).hexdigest() != service.UNIT_SHA256:
        raise AssertionError('historical-v2-unit-hash-mismatch')
    data[service.UNIT_PATH] = unit
    return data


def raw_status(**changes):
    value = {'type': 'status', 'protocol': 1, 'platform': 'A0005', 'boot_id': BOOT,
             'contract_id': service.CONTRACT_ID, 'inference': {'state': 'STOPPED', 'error': None},
             'upload': None, 'cpu_frequency_changing': False}
    value.update(changes)
    return value


def properties(active=True):
    return dict(zip(service.PROPERTIES, (
        'active' if active else 'inactive', 'running' if active else 'dead', '3925' if active else '0',
        service.UNIT_PATH, '', 'no', '6min', 'no', 'no', service.PROJECT, 'no')))


class FixtureAccess:
    def __init__(self, mode='stop'):
        self.events, self.actions, self.active, self.pid = [], [], mode == 'stop', 3925
        self.data = historical_code()
        self.data[service.BOOT_PATH] = BOOT.encode('ascii') + b'\n'
        self.data[service.CONFIG_PATH] = b'{"bind":"127.0.0.1","control_port":8765,"video_port":8766}\n'
        self.status_value = raw_status()
        self.property_changes, self.dependency_changes = {}, {}
        self.scan_changes = {}
        self.probe_closed, self.sleep_count = False, 0

    def check_environment(self):
        self.events.append('environment')

    def read(self, path):
        self.events.append(('read', path))
        if path not in self.data:
            raise FileNotFoundError(path)
        return self.data[path]

    def show(self, unit):
        self.events.append(('show', unit))
        if unit != service.UNIT:
            return dict(properties(), **self.dependency_changes.get(unit, {}))
        value = properties(self.active)
        value['MainPID'] = str(self.pid) if self.active else '0'
        value.update(self.property_changes)
        return value

    def action(self, mode):
        self.actions.append(mode)
        self.events.append(('action', mode))
        self.active = mode == 'start'
        if self.active:
            self.pid = 4925
        return {'action': mode, 'unit': service.UNIT, 'pid': 9000, 'exitObserved': True,
                'returncode': 0, 'killAttempted': False,
                'timeoutSeconds': service.STOP_SECONDS if mode == 'stop' else service.START_SECONDS}

    def status(self, boot):
        self.events.append('status')
        checked = service.checked_status(self.status_value, boot)
        self.probe_closed = True
        return {'hello': checked, 'status': checked, 'probeSocketClosedBeforeFdScan': True}

    def scan(self):
        self.events.append('scan')
        if self.active:
            assert self.probe_closed, 'The HELLO/status socket must already be closed.'
        value = {'active8765': [], 'listeners8765': [{'state': '0A', 'inode': 30, 'owners': [{'pid': self.pid, 'fd': 8}]}] if self.active else [],
                 'a0005Owners': [], 'fdCount': 100, 'deviceOpened': False}
        value.update(copy.deepcopy(self.scan_changes))
        return value

    def sleep(self, seconds):
        self.sleep_count += 1


class LifecycleTests(unittest.TestCase):
    def execute(self, access, mode='stop', boot=BOOT, hashes=None):
        return service.lifecycle(mode, boot, service.APPROVED_HASHES if mode == 'start' and hashes is None else hashes, access)

    def test_fixture_is_exact_archived_v2_not_current_canonical_source(self):
        access = FixtureAccess('start')
        self.assertEqual(service.APPROVED_HASHES, V2_HASHES)
        for name, expected in V2_HASHES.items():
            raw = access.data[service.PROJECT + '/vision_app/' + name]
            self.assertEqual(raw, (HISTORICAL_SOURCE / 'vision_app' / name).read_bytes())
            self.assertEqual(hashlib.sha256(raw).hexdigest(), expected)
        current = (ROOT / 'engineering/fz3b/source/PS/vision_app/board_agent.py').read_bytes()
        self.assertNotEqual(hashlib.sha256(current).hexdigest(), V2_HASHES['board_agent.py'])

    def test_missing_or_corrupt_archive_never_falls_back_to_current_source(self):
        target = HISTORICAL_SOURCE / 'vision_app/board_agent.py'
        original = Path.read_bytes
        for value in (None, b'corrupt historical bytes'):
            def read(path):
                if path == target:
                    if value is None:
                        raise FileNotFoundError(str(path))
                    return value
                return original(path)
            with self.subTest(missing=value is None), mock.patch.object(Path, 'read_bytes', read):
                with self.assertRaises((FileNotFoundError, AssertionError)):
                    FixtureAccess('start')

    def test_current_canonical_files_mixed_into_v2_remain_blocked_without_action(self):
        for name in ('board_agent.py', 'camera.py'):
            with self.subTest(name=name):
                access = FixtureAccess('start')
                access.data[service.PROJECT + '/vision_app/' + name] = (
                    ROOT / 'engineering/fz3b/source/PS/vision_app' / name).read_bytes()
                result = self.execute(access, 'start')
                self.assertEqual(result['result'], 'blocked', result)
                self.assertEqual(result['error']['code'], 'deployed-python-hash-mismatch')
                self.assertEqual(access.actions, [])

    def test_stop_has_one_normal_action_after_closed_probe_and_complete_guards(self):
        access = FixtureAccess()
        result = self.execute(access)
        self.assertEqual(result['result'], 'passed', result)
        self.assertEqual(access.actions, ['stop'])
        self.assertEqual(result['after']['mainPid'], 0)
        self.assertEqual(result['after']['activeState'], 'inactive')
        self.assertEqual(result['command']['timeoutSeconds'], 370)
        self.assertLess(access.events.index('status'), access.events.index('scan'))
        self.assertLess(access.events.index('scan'), access.events.index(('action', 'stop')))
        self.assertEqual(result['preRead']['unit']['sha256'], service.UNIT_SHA256)
        self.assertEqual(result['preRead'], result['postRead'])

    def test_start_checks_exact_v2_hashes_and_dependencies_then_normal_start(self):
        access = FixtureAccess('start')
        result = self.execute(access, 'start')
        self.assertEqual(result['result'], 'passed', result)
        self.assertEqual(access.actions, ['start'])
        self.assertEqual(set(result['dependenciesBefore']), set(service.DEPENDENCIES))
        self.assertEqual(set(result['dependenciesAfter']), set(service.DEPENDENCIES))
        self.assertTrue(result['acceptedExistingStartEffects'])
        self.assertEqual(result['afterStatus']['connectionAttempts'], 1)
        self.assertEqual(result['preRead']['config']['bind'], '127.0.0.1')

    def test_invalid_mode_boot_and_extra_hash_path_fail_before_any_access(self):
        for mode, boot, hashes in [('restart', BOOT, None), ('stop', BOOT.upper(), None),
                                    ('start', BOOT, dict(service.APPROVED_HASHES, **{'../evil.py': '0' * 64})),
                                    ('stop', BOOT, service.APPROVED_HASHES)]:
            with self.subTest(mode=mode, boot=boot, hashes=hashes):
                access = FixtureAccess()
                result = service.lifecycle(mode, boot, hashes, access)
                self.assertEqual(result['result'], 'blocked')
                self.assertEqual(access.events, [])
                self.assertEqual(access.actions, [])

    def test_expected_mapping_does_not_allow_replacement_hashes_or_duplicate_keys(self):
        encoded = json.dumps(service.APPROVED_HASHES)
        self.assertEqual(service.expected_hashes(encoded), service.APPROVED_HASHES)
        for text in [encoded.replace(service.APPROVED_HASHES['camera.py'], '0' * 64),
                     '{"camera.py":"a","camera.py":"b"}', '{"/tmp/x":"' + '0' * 64 + '"}', '[]']:
            with self.subTest(text=text), self.assertRaises(service.LifecycleError):
                service.expected_hashes(text)

    def test_unit_manager_or_runtime_mismatch_is_never_stopped(self):
        for changes in [{'DropInPaths': '/tmp/x.conf'}, {'SendSIGKILL': 'yes'}, {'TimeoutStopUSec': '90s'},
                        {'NeedDaemonReload': 'yes'}, {'Transient': 'yes'}, {'WorkingDirectory': '/tmp'},
                        {'Restart': 'always'}, {'FragmentPath': '/tmp/unit'}, {'MainPID': '0'},
                        {'ActiveState': 'activating'}, {'SubState': 'stop-sigterm'}]:
            with self.subTest(changes=changes):
                access = FixtureAccess()
                access.property_changes = changes
                result = self.execute(access)
                self.assertEqual(result['result'], 'blocked')
                self.assertEqual(access.actions, [])

    def test_unit_source_and_boot_mismatch_are_blocked(self):
        for path, value in [(service.UNIT_PATH, b'[Service]\nSendSIGKILL=yes\n'),
                            (service.BOOT_PATH, b'00000000-0000-0000-0000-000000000000\n')]:
            with self.subTest(path=path):
                access = FixtureAccess()
                access.data[path] = value
                self.assertEqual(self.execute(access)['result'], 'blocked')
                self.assertEqual(access.actions, [])

    def test_clean_stopped_is_exact_null_not_false_empty_or_missing_error(self):
        for inference in [{'state': 'RUNNING', 'error': None}, {'state': 'STOPPING', 'error': None},
                          {'state': 'STOPPED'}, {'state': 'STOPPED', 'error': ''},
                          {'state': 'STOPPED', 'error': False}, {'state': 'STOPPED', 'error': 0}]:
            with self.subTest(inference=inference), self.assertRaises(service.LifecycleError):
                service.checked_status(raw_status(inference=inference), BOOT)

    def test_status_wrong_contract_platform_boot_upload_or_frequency_is_blocked(self):
        for changes in [{'contract_id': '0' * 64}, {'boot_id': 'other'}, {'platform': 'A0004'},
                        {'upload': {'state': 'DONE'}}, {'cpu_frequency_changing': True}, {'protocol': True}]:
            with self.subTest(changes=changes):
                access = FixtureAccess()
                access.status_value.update(changes)
                self.assertEqual(self.execute(access)['result'], 'blocked')
                self.assertEqual(access.actions, [])

    def test_busy_a0005_active_tcp_or_foreign_listener_blocks_without_action(self):
        for changes in [{'a0005Owners': [{'pid': 77, 'fd': 3}]}, {'active8765': [{'state': '01'}]},
                        {'listeners8765': [{'owners': [{'pid': 77}]}]}, {'listeners8765': [{'owners': []}]},
                        {'listeners8765': []}, {'deviceOpened': True}]:
            with self.subTest(changes=changes):
                access = FixtureAccess()
                access.scan_changes = changes
                self.assertEqual(self.execute(access)['result'], 'blocked')
                self.assertEqual(access.actions, [])
                self.assertLessEqual(access.sleep_count, 9)

    def test_a0005_scan_permission_failure_blocks_not_empty_owner_pass(self):
        access = FixtureAccess()
        access.scan = mock.Mock(side_effect=PermissionError(errno.EACCES, 'do not emit private pathname'))
        result = self.execute(access)
        self.assertEqual(result['result'], 'blocked')
        self.assertEqual(access.actions, [])
        self.assertNotIn('private pathname', json.dumps(result))

    def test_start_cannot_start_any_inactive_dependency(self):
        for unit in service.DEPENDENCIES:
            with self.subTest(unit=unit):
                access = FixtureAccess('start')
                access.dependency_changes[unit] = {'ActiveState': 'inactive'}
                self.assertEqual(self.execute(access, 'start')['result'], 'blocked')
                self.assertEqual(access.actions, [])

    def test_start_requires_every_python_hash_and_explicit_loopback(self):
        for name in service.APPROVED_HASHES:
            with self.subTest(name=name):
                access = FixtureAccess('start')
                access.data[service.PROJECT + '/vision_app/' + name] += b'\n# unexpected\n'
                self.assertEqual(self.execute(access, 'start')['result'], 'blocked')
                self.assertEqual(access.actions, [])
        for config in [b'{}', b'{"bind":"0.0.0.0"}', b'{"bind":"localhost"}',
                       b'{"bind":"127.0.0.1","control_port":true}', b'{"bind":"127.0.0.1","video_port":9999}']:
            with self.subTest(config=config):
                access = FixtureAccess('start')
                access.data[service.CONFIG_PATH] = config
                self.assertEqual(self.execute(access, 'start')['result'], 'blocked')
                self.assertEqual(access.actions, [])

    def test_stop_accepts_old_public_bind_but_does_not_emit_other_config(self):
        access = FixtureAccess()
        access.data[service.CONFIG_PATH] = b'{"bind":"0.0.0.0","password":"do-not-emit"}'
        result = self.execute(access)
        self.assertEqual(result['result'], 'passed')
        self.assertNotIn('do-not-emit', json.dumps(result))

    def test_only_stop_can_observe_missing_new_image_module(self):
        access = FixtureAccess()
        del access.data[service.PROJECT + '/vision_app/image_boundary.py']
        self.assertEqual(self.execute(access)['result'], 'passed')
        access = FixtureAccess('start')
        del access.data[service.PROJECT + '/vision_app/image_boundary.py']
        self.assertEqual(self.execute(access, 'start')['result'], 'blocked')

    def test_action_timeout_is_unknown_without_second_action_or_kill(self):
        access = FixtureAccess()
        def action(mode):
            access.actions.append(mode)
            raise service.LifecycleError('systemctl-timeout', {'exitObserved': False, 'killAttempted': False, 'pid': 88})
        access.action = action
        result = self.execute(access)
        self.assertEqual(result['result'], 'unknown')
        self.assertEqual(result['command']['exitObserved'], False)
        self.assertEqual(access.actions, ['stop'])
        self.assertTrue(result['humanReviewRequired'])
        self.assertFalse(result['killAttempted'])

    def test_nonzero_action_exit_and_post_action_state_failure_are_unknown(self):
        for failure in ('nonzero', 'still-active'):
            with self.subTest(failure=failure):
                access = FixtureAccess()
                def action(mode):
                    access.actions.append(mode)
                    return {'exitObserved': True, 'returncode': 1 if failure == 'nonzero' else 0}
                access.action = action
                result = self.execute(access)
                self.assertEqual(result['result'], 'unknown')
                self.assertEqual(access.actions, ['stop'])

    def test_before_action_changed_bytes_blocks_and_after_action_change_is_unknown(self):
        access = FixtureAccess()
        original_show = access.show
        shows = [0]
        def changed_show(unit):
            shows[0] += 1
            if shows[0] == 2:
                access.data[service.PROJECT + '/run.sh'] += b'# raced\n'
            return original_show(unit)
        access.show = changed_show
        self.assertEqual(self.execute(access)['result'], 'blocked')
        self.assertEqual(access.actions, [])
        access = FixtureAccess()
        action = access.action
        def changed_action(mode):
            value = action(mode)
            access.data[service.PROJECT + '/run.sh'] += b'# raced\n'
            return value
        access.action = changed_action
        self.assertEqual(self.execute(access)['result'], 'unknown')
        self.assertEqual(access.actions, ['stop'])

    def test_start_probe_retries_connection_refused_only_not_service_start(self):
        access = FixtureAccess('start')
        status = access.status
        attempts = [0]
        def opening(boot):
            attempts[0] += 1
            if attempts[0] < 3:
                raise ConnectionRefusedError(errno.ECONNREFUSED, 'not listening yet')
            return status(boot)
        access.status = opening
        result = self.execute(access, 'start')
        self.assertEqual(result['result'], 'passed', result)
        self.assertEqual(access.actions, ['start'])
        self.assertEqual(result['afterStatus']['connectionAttempts'], 3)

    def test_start_probe_bad_status_is_unknown_without_retry(self):
        access = FixtureAccess('start')
        access.status_value['inference']['error'] = 'not-clean'
        result = self.execute(access, 'start')
        self.assertEqual(result['result'], 'unknown')
        self.assertEqual(access.actions, ['start'])
        self.assertEqual(access.sleep_count, 0)

    def test_stdin_main_accepts_reviewed_explicit_arguments(self):
        output = io.StringIO()
        with mock.patch.object(service, 'SystemAccess', return_value=FixtureAccess()), mock.patch('sys.stdout', output):
            code = service.main(['--mode', 'stop', '--expected-boot-id', BOOT])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())['result'], 'passed')


class CommandTests(unittest.TestCase):
    def test_stop_timeout_does_not_kill_terminate_wait_or_retry(self):
        child = mock.Mock(pid=33)
        child.communicate.side_effect = subprocess.TimeoutExpired('systemctl', 370)
        factory = mock.Mock(return_value=child)
        with self.assertRaises(service.LifecycleError) as caught:
            service.run_systemctl('stop', service.UNIT, 370, factory)
        self.assertEqual(caught.exception.code, 'systemctl-timeout')
        self.assertEqual(caught.exception.command['exitObserved'], False)
        child.kill.assert_not_called()
        child.terminate.assert_not_called()
        child.wait.assert_not_called()
        self.assertEqual(factory.call_count, 1)
        args, options = factory.call_args
        self.assertEqual(args[0], ['/bin/systemctl', 'stop', service.UNIT, '--no-pager'])
        self.assertEqual(options['stdout'], subprocess.DEVNULL)
        self.assertEqual(options['stderr'], subprocess.DEVNULL)
        self.assertEqual(options['env'], service.CHILD_ENV)
        self.assertFalse(options['shell'])

    def test_only_fixed_actions_units_and_timeouts_reach_process_creation(self):
        factory = mock.Mock()
        for action, unit, seconds in [('restart', service.UNIT, 370), ('kill', service.UNIT, 370),
                                      ('start', service.DEPENDENCIES[0], 70), ('stop', 'other.service', 370),
                                      ('stop', service.UNIT, 5)]:
            with self.subTest(action=action, unit=unit), self.assertRaises(service.LifecycleError):
                service.run_systemctl(action, unit, seconds, factory)
        factory.assert_not_called()

    def test_source_has_no_kill_terminate_application_import_or_shell_run(self):
        tree = ast.parse(TOOL.read_text(encoding='utf-8'), feature_version=(3, 6))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotIn(node.func.attr, ('kill', 'terminate', 'system', 'run'))
            if isinstance(node, ast.ImportFrom):
                self.assertNotIn('vision_app', node.module or '')


def wire(value):
    payload = json.dumps(value, separators=(',', ':')).encode('utf-8')
    return service.HEADER.pack(b'FZVA', 1, 1, 0, len(payload), zlib.crc32(payload) & 0xffffffff) + payload


class FakeSocket:
    def __init__(self, data):
        self.data, self.sent, self.closed, self.destination = data, [], False, None

    def settimeout(self, seconds):
        assert 0 < seconds <= 8

    def connect(self, destination):
        self.destination = destination

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, size):
        chunk, self.data = self.data[:min(size, 7)], self.data[min(size, 7):]
        return chunk

    def close(self):
        self.closed = True


class ProtocolTests(unittest.TestCase):
    def socket(self):
        hello = raw_status(type='hello', ok=True)
        ack = {'type': 'ack', 'op': 'status', 'request_id': 'fixed-lifecycle-status', 'ok': True, 'result': raw_status()}
        return FakeSocket(wire(hello) + wire(raw_status()) + wire(ack))

    def test_only_hello_and_status_exact_loopback_socket_is_closed(self):
        link = self.socket()
        result = service.query_status(BOOT, lambda *args: link)
        self.assertTrue(link.closed)
        self.assertEqual(link.destination, ('127.0.0.1', 8765))
        requests = [json.loads(data[service.HEADER.size:]) for data in link.sent]
        self.assertEqual(requests, [{'op': 'hello'}, {'op': 'status', 'request_id': 'fixed-lifecycle-status'}])
        self.assertTrue(result['probeSocketClosedBeforeFdScan'])

    def test_bad_crc_wrong_ack_and_oversized_frame_fail_closed_and_close(self):
        bad_crc = bytearray(wire(raw_status(type='hello', ok=True)))
        bad_crc[-1] ^= 1
        for data in [bytes(bad_crc), service.HEADER.pack(b'FZVA', 1, 1, 0, service.MAX_JSON + 1, 0),
                     wire(raw_status(type='hello', ok=True)) + wire({'type': 'ack', 'op': 'stop', 'ok': True})]:
            with self.subTest(data=data[:16]):
                link = FakeSocket(data)
                with self.assertRaises(service.LifecycleError):
                    service.query_status(BOOT, lambda *args: link)
                self.assertTrue(link.closed)

    def test_tcp_active_close_wait_is_not_ignored_but_time_wait_is_classified(self):
        header = b'  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n'
        lines = b''
        for index, state in enumerate(('01', '06', '08', '0A')):
            lines += (' %d: 0100007F:223D 0100007F:ABCD %s 00000000:00000000 00:00000000 00000000 0 0 %d\n' % (index, state, 100 + index)).encode('ascii')
        parsed = service.tcp_rows(header + lines, 'tcp')
        self.assertEqual([row['state'] for row in parsed], ['01', '06', '08', '0A'])
        for data in [b'bad', header + b'bad\n', header + lines.replace(b' 08 ', b' FF ')]:
            with self.assertRaises(service.LifecycleError):
                service.tcp_rows(data, 'tcp')


class ProcMetadataTests(unittest.TestCase):
    def test_device_alias_owner_detected_using_metadata_without_device_open(self):
        header = b'sl local_address rem_address st\n'
        def listdir(path):
            return ['123'] if path == '/proc' else ['4', '5']
        def metadata(path):
            if path.endswith('/ns/net'):
                return SimpleNamespace(st_ino=7)
            return SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=42)
        def opened(path, mode):
            self.assertRegex(path, r'^/proc/\d+/net/tcp6?$')
            return io.BytesIO(header)
        with mock.patch.object(service.os, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFCHR, st_rdev=42)), \
                mock.patch.object(service.os, 'stat', side_effect=metadata), \
                mock.patch.object(service.os, 'listdir', side_effect=listdir), \
                mock.patch.object(service.os, 'readlink', return_value='/dev/alias-not-the-device-name'), \
                mock.patch('builtins.open', side_effect=opened):
            value = service.scan_quiescence()
        self.assertEqual(value['a0005Owners'], [{'pid': 123, 'fd': 4}, {'pid': 123, 'fd': 5}])
        self.assertFalse(value['deviceOpened'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
