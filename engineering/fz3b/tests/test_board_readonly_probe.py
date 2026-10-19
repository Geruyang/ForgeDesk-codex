"""Pure mock tests: never execute the real board audit or real sockets/files."""
import ast
import errno
import hashlib
import importlib.util
import json
from pathlib import Path
import socket
import stat
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('audit_board_readonly', Path(__file__).resolve().parents[1] / 'tools/audit_board_readonly.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FakeAccess(object):
    def __init__(self):
        self.reads = []
        self.loader_calls = 0
        self.data = {probe.MODEL_PATH: b'Zynq UltraScale+\0', probe.COMPATIBLE_PATH: b'xlnx,zynqmp\0xlnx,zcu\0',
                     probe.BOOT_PATH: b'5ceb45a3-8903-4efc-9484-ec75c17280df\n', probe.FPGA_PATH: b'operating\n',
                     probe.CONFIG_PATH: json.dumps({'bind': '0.0.0.0', 'control_port': 8765, 'video_port': 8766,
                                                   'token': 'NEVER-EXPORT', 'token_file': '/root/.ssh/secret'}).encode('ascii')}
        for path in probe.PATCH_PATHS:
            if not path.endswith('image_boundary.py'):
                self.data[path] = b'offline source fixture'

    def uname(self):
        return {'sysname': 'Linux', 'release': 'fixture', 'machine': 'aarch64'}

    def read_file(self, path, limit):
        assert path in probe.ALLOWED_FILES
        self.reads.append((path, limit))
        if path not in self.data:
            raise FileNotFoundError()
        return self.data[path]

    def loader_status(self):
        self.loader_calls += 1
        return {'ok': True, 'ready': True}


class FakeClock(object):
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class FakeSocket(object):
    def __init__(self, chunks, clock=None, delays=None, connect_error=None):
        self.chunks = list(chunks)
        self.clock = clock
        self.delays = list(delays or [])
        self.connect_error = connect_error
        self.sent, self.timeouts = [], []
        self.connected = None
        self.closed = False

    def settimeout(self, timeout):
        self.timeouts.append(timeout)

    def connect(self, path):
        self.connected = path
        if self.connect_error:
            raise self.connect_error

    def sendall(self, data):
        self.sent.append(data)

    def recv(self, count):
        if self.clock and self.delays:
            self.clock.now += self.delays.pop(0)
        if not self.chunks:
            return b''
        chunk = self.chunks.pop(0)
        if len(chunk) > count:
            self.chunks.insert(0, chunk[count:])
            chunk = chunk[:count]
        return chunk

    def close(self):
        self.closed = True


def query(link, clock=None):
    factory = mock.Mock(return_value=link)
    with mock.patch.object(probe.socket, 'AF_UNIX', 1, create=True):
        result = probe.query_loader_status(socket_factory=factory, monotonic=clock or (lambda: 0.0), check_socket=lambda: None)
        factory.assert_called_once_with(1, socket.SOCK_STREAM)
    return result


class AuditTests(unittest.TestCase):
    def test_fixed_file_hashes_no_image_and_no_default_loader_access(self):
        access = FakeAccess()
        with mock.patch.object(probe, 'SystemAccess', side_effect=AssertionError('real IO forbidden')):
            result = probe.collect(access=access)
        self.assertEqual(result['compute'], 'not-attempted')
        self.assertEqual(result['programming'], 'not-attempted')
        self.assertEqual(access.loader_calls, 0)
        self.assertEqual(len(access.reads), len(probe.ALLOWED_FILES))
        absent = next(item for item in result['files'] if item['path'].endswith('image_boundary.py'))
        self.assertEqual(absent['status'], 'absent')
        self.assertTrue(absent['baselineAbsenceAllowed'])
        existing = next(item for item in result['files'] if item['path'].endswith('board_agent.py'))
        self.assertEqual(existing['sha256'], hashlib.sha256(b'offline source fixture').hexdigest())
        self.assertNotIn('offline source fixture', json.dumps(result))
        self.assertNotIn('NEVER-EXPORT', json.dumps(result))
        self.assertNotIn('/root/.ssh/secret', json.dumps(result))
        self.assertFalse(result['model']['aliasUsed'])
        self.assertEqual(result['model']['path'], '/sys/firmware/devicetree/base/model')
        self.assertNotIn('/proc/device-tree/model', [path for path, _ in access.reads])

    def test_config_whitelist_omits_invalid_values_and_secrets(self):
        result = probe.config_summary(b'{"bind":"secret-text","control_port":true,"video_port":70000,"license":"SECRET"}')
        encoded = json.dumps(result)
        self.assertNotIn('secret-text', encoded)
        self.assertNotIn('SECRET', encoded)
        self.assertNotIn('license', encoded)
        self.assertFalse(result['fields']['bind']['validLiteralIp'])
        for data in (b'{"bind":"127.0.0.1","bind":"0.0.0.0"}', b'{"x":NaN}', b'bad-json'):
            with self.assertRaises(probe.ProbeError):
                probe.config_summary(data)

    def test_loader_opt_in_and_errors_do_not_echo_private_error_text(self):
        access = FakeAccess()
        self.assertEqual(probe.collect(True, access)['loader']['statusQuery'], 'completed')
        self.assertEqual(access.loader_calls, 1)
        access.read_file = mock.Mock(side_effect=OSError('private-secret'))
        self.assertNotIn('private-secret', json.dumps(probe.collect(access=access)))

    def test_bad_boot_id_and_invalid_config_do_not_echo_source_content(self):
        access = FakeAccess()
        access.data[probe.BOOT_PATH] = b'SECRET-INVALID-BOOT'
        access.data[probe.CONFIG_PATH] = b'{"SECRET" invalid json}'
        result = probe.collect(access=access)
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(result['bootId']['code'], 'invalid-boot-id')

    def test_unreadable_or_linked_kernel_state_is_unavailable_not_absent(self):
        access = FakeAccess()
        original = access.read_file

        def read(path, limit):
            if path == probe.FPGA_PATH:
                raise OSError(errno.ELOOP, 'symlink refused')
            if path == probe.MODEL_PATH:
                raise FileNotFoundError()
            return original(path, limit)

        access.read_file = read
        result = probe.collect(access=access)
        self.assertEqual(result['fpgaManagerState']['status'], 'unavailable')
        self.assertEqual(result['model']['status'], 'unavailable')
        self.assertFalse(result['model']['aliasUsed'])

    def test_cli_rejects_path_command_and_implicit_loader_overrides(self):
        for args in (['--path', '/root/.ssh/id_rsa'], ['--command', 'prepare-a0005'], ['status'], ['--socket', '/tmp/x']):
            with mock.patch.object(probe, 'collect', side_effect=AssertionError('must reject before IO')):
                with mock.patch('sys.stderr'), self.assertRaises(SystemExit):
                    probe.main(args)

    def test_source_is_python36_grammar_and_has_no_execution_imports(self):
        source = Path(spec.origin).read_text(encoding='utf-8')
        tree = ast.parse(source, feature_version=(3, 6))
        modules = [node.names[0].name for node in ast.walk(tree) if isinstance(node, ast.Import)]
        self.assertNotIn('subprocess', modules)
        self.assertTrue(all(not name.startswith(('vision_app', 'paramiko', 'serial')) for name in modules))


class LoaderTests(unittest.TestCase):
    def test_exact_one_status_request_and_response_whitelist(self):
        reply = json.dumps({'ok': True, 'result': {'schema': 'loader-v1', 'status': 'READY_A0005', 'target': 'a0005',
            'ready': True, 'failure': 'PRIVATE', 'secret': 'PRIVATE', 'observed': {'manager_state': 'operating',
                'detected_target': 'a0005', 'raw_clocks': {'secret': 'PRIVATE'}}}}).encode('ascii') + b'\n'
        link = FakeSocket([reply[:15], reply[15:]])
        result = query(link)
        self.assertEqual(link.connected, probe.SOCKET_PATH)
        self.assertEqual(link.sent, [b'{"command":"status"}\n'])
        self.assertTrue(link.closed)
        self.assertEqual(result['manager_state'], 'operating')
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertTrue(result['reportedFailure'])

    def test_absolute_deadline_does_not_reset_for_slow_chunks(self):
        clock = FakeClock()
        link = FakeSocket([b'{', b'"ok":', b'true}\n'], clock, [2.0, 2.0, 1.01])
        with self.assertRaisesRegex(probe.ProbeError, 'loader-deadline'):
            query(link, clock)
        self.assertTrue(link.closed)
        self.assertEqual(link.timeouts, [5.0, 5.0, 5.0, 3.0, 1.0])

    def test_disconnect_oversize_extra_json_and_bad_envelope_close(self):
        for chunks in ([b''], [b'x' * (probe.LOADER_LIMIT + 1)], [b'{}\n{}\n'],
                       [b'not-json\n'], [b'{"ok":1,"result":{}}\n'], [b'{"ok":true,"ok":false,"result":{}}\n']):
            link = FakeSocket(chunks)
            with self.assertRaises(probe.ProbeError):
                query(link)
            self.assertTrue(link.closed)

    def test_connect_timeout_closes_and_never_retries(self):
        link = FakeSocket([], connect_error=socket.timeout())
        with self.assertRaisesRegex(probe.ProbeError, 'loader-deadline'):
            query(link)
        self.assertTrue(link.closed)
        self.assertEqual(link.sent, [])

    def test_socket_node_and_link_validation_uses_only_fixed_socket_path(self):
        with mock.patch.object(probe.os.path, 'realpath', return_value=probe.SOCKET_PATH), \
             mock.patch.object(probe.os, 'lstat', return_value=mock.Mock(st_mode=stat.S_IFREG)) as checked:
            with self.assertRaisesRegex(probe.ProbeError, 'unexpected-loader-socket'):
                probe._check_socket()
            checked.assert_called_once_with(probe.SOCKET_PATH)
        with mock.patch.object(probe.os.path, 'realpath', return_value='/tmp/foreign.sock'), \
             mock.patch.object(probe.os, 'lstat', side_effect=AssertionError('must reject before stat')):
            with self.assertRaisesRegex(probe.ProbeError, 'unexpected-loader-socket'):
                probe._check_socket()

    def test_exact_limit_reply_succeeds_but_late_complete_reply_is_rejected(self):
        prefix, suffix = b'{"ok":true,"result":{},"ignored":"', b'"}\n'
        reply = prefix + b'x' * (probe.LOADER_LIMIT - len(prefix) - len(suffix)) + suffix
        self.assertEqual(query(FakeSocket([reply]))['responseBytes'], probe.LOADER_LIMIT)
        clock = FakeClock()
        link = FakeSocket([b'{"ok":true,"result":{}}\n'], clock, [5.01])
        with self.assertRaisesRegex(probe.ProbeError, 'loader-deadline'):
            query(link, clock)
        self.assertTrue(link.closed)


class SafeFileTests(unittest.TestCase):
    def test_unknown_paths_refused_before_any_system_call(self):
        for path in ('/root/.ssh/id_rsa', '/root/license.lic', '/dev/mem', probe.PROJECT + '/vision_app/../config.json'):
            with mock.patch.object(probe.os.path, 'realpath', side_effect=AssertionError('must reject first')):
                with self.assertRaisesRegex(probe.ProbeError, 'path-not-allowed'):
                    probe.read_allowed_file(path, probe.FILE_LIMIT)

    def test_parent_links_cannot_redirect_project_reads_to_authentication_files(self):
        failure = OSError(errno.ENOTDIR, 'nofollow parent link')
        with mock.patch.object(probe.os, 'O_DIRECTORY', 65536, create=True), \
             mock.patch.object(probe.os, 'O_NOFOLLOW', 131072, create=True), \
             mock.patch.object(probe.os, 'O_NONBLOCK', 2048, create=True), \
             mock.patch.object(probe.os, 'open', side_effect=[100, failure]) as opened, \
             mock.patch.object(probe.os, 'close') as closed:
            with self.assertRaises(OSError):
                probe.read_allowed_file(probe.PATCH_PATHS[0], probe.FILE_LIMIT)
            self.assertTrue(all(call.args[1] & 131072 for call in opened.call_args_list))
            self.assertEqual([call.args[0] for call in opened.call_args_list], ['/', 'root'])
            closed.assert_called_once_with(100)

    def test_only_canonical_kernel_paths_and_fixed_limits_are_admitted(self):
        for path in ('/proc/device-tree/model', '/proc/device-tree/compatible', '/sys/devices/foreign/fpga_manager/fpga0/state'):
            with self.assertRaisesRegex(probe.ProbeError, 'path-not-allowed'):
                probe.read_allowed_file(path, probe.TEXT_LIMIT)
        with mock.patch.object(probe.os.path, 'realpath', side_effect=AssertionError('must reject first')):
            with self.assertRaisesRegex(probe.ProbeError, 'read-limit-not-allowed'):
                probe.read_allowed_file(probe.CONFIG_PATH, probe.FILE_LIMIT)

    def fake_read(self, mode=stat.S_IFREG, size=3, links=1, changed=False, data=b'abc', path=None):
        info = mock.Mock(st_mode=mode | 0o600, st_size=size, st_nlink=links,
                         st_dev=1, st_ino=2, st_mtime=1, st_ctime=1, st_mtime_ns=1, st_ctime_ns=1)
        after = mock.Mock(st_mode=info.st_mode, st_size=size + 1, st_nlink=links,
                          st_dev=1, st_ino=2, st_mtime=1, st_ctime=1, st_mtime_ns=2, st_ctime_ns=1) if changed else info
        with mock.patch.object(probe.os.path, 'realpath', side_effect=lambda path: path), \
             mock.patch.object(probe.os, 'O_DIRECTORY', 65536, create=True), \
             mock.patch.object(probe.os, 'O_NOFOLLOW', 131072, create=True), \
             mock.patch.object(probe.os, 'O_NONBLOCK', 2048, create=True), \
             mock.patch.object(probe.os, 'open', side_effect=range(100, 120)) as opened, \
             mock.patch.object(probe.os, 'close') as closed, \
             mock.patch.object(probe.os, 'fstat', side_effect=[info, after]), \
             mock.patch.object(probe.os, 'read', side_effect=[data, b'']):
            try:
                chosen = path or probe.PATCH_PATHS[0]
                result = probe.read_allowed_file(chosen, probe.TEXT_LIMIT if chosen == probe.MODEL_PATH else probe.FILE_LIMIT)
                self.assertEqual(result, data)
                self.assertTrue(all(call.args[1] & 131072 for call in opened.call_args_list))
                return result
            finally:
                self.assertEqual(opened.call_count, closed.call_count)

    def test_bounded_regular_file_uses_nofollow_and_closes_descriptors(self):
        self.fake_read()

    def test_virtual_files_allow_zero_or_page_size_with_different_content_length(self):
        for size in (0, 4096):
            self.fake_read(path=probe.MODEL_PATH, size=size, data=b'Zynq\0')

    def test_nonregular_oversized_hardlink_and_changing_files_refused(self):
        for arguments in ({'mode': stat.S_IFIFO}, {'size': probe.FILE_LIMIT + 1}, {'links': 2},
                          {'changed': True}, {'data': b'x' * (probe.FILE_LIMIT + 1)}):
            with self.assertRaises(probe.ProbeError):
                self.fake_read(**arguments)


if __name__ == '__main__':
    unittest.main()
