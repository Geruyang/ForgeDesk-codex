"""Offline HOST endpoint/compatibility fixtures. No real sockets, codecs or Agent."""
import argparse
import ast
import builtins
import hashlib
import importlib
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
HOST = ROOT / 'engineering/fz3b/source/HOST/vision_app'
EVIDENCE = ROOT / 'output/hardware/2026-10-16-continuation/host-endpoint-security'
BLOCKED = []


def audit(event, args):
    if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system':
        BLOCKED.append(event)
        raise RuntimeError('HOST endpoint fixtures prohibit real sockets and processes')
    if event == 'import':
        name = args[0]
        if name.split('.')[0] in ('serial', 'pyocd', 'paramiko', 'PySide6') or any(
                part in name.split('.') for part in ('board_agent', 'board_runtime', 'hardware_monitor')):
            BLOCKED.append('import:' + name)
            raise RuntimeError('HOST endpoint fixtures prohibit hardware/runtime/GUI imports')


sys.addaudithook(audit)
PACKAGE = 'fz3b_host_endpoint_fixture'
package = types.ModuleType(PACKAGE)
package.__path__ = [str(HOST)]
sys.modules[PACKAGE] = package
video = importlib.import_module(PACKAGE + '.video_analysis')
transport = importlib.import_module(PACKAGE + '.transports')
protocol = importlib.import_module(PACKAGE + '.protocol')


class MockConnectionReached(Exception):
    pass


class Clock:
    def __init__(self):
        self.value = 0

    def monotonic(self):
        self.value += 1
        return self.value


class FakeSocket:
    def __init__(self, reply):
        self.incoming = [protocol.encode_message(protocol.JSON, reply)]
        self.sent = []
        self.decoder = protocol.Decoder()

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        return False

    def settimeout(self, timeout):
        pass

    def sendall(self, data):
        for kind, payload in self.decoder.feed(data):
            if kind == protocol.JSON:
                self.sent.append(json.loads(payload.decode('utf-8')))

    def recv(self, count):
        if self.incoming:
            return self.incoming.pop(0)
        raise socket.timeout()


class HostEndpointSecurity(unittest.TestCase):
    def test_direct_socket_inventory_has_only_the_two_reviewed_host_paths(self):
        modules = set()
        calls = []
        for path in HOST.rglob('*.py'):
            tree = ast.parse(path.read_text(encoding='utf-8'))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import) and any(item.name == 'socket' for item in node.names):
                    modules.add(path.relative_to(HOST).as_posix())
                if isinstance(node, ast.ImportFrom) and node.module == 'socket':
                    self.fail('New direct socket import requires endpoint review: ' + str(path))
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'socket' and node.func.attr in ('socket', 'create_connection'):
                    calls.append((path.relative_to(HOST).as_posix(), node.func.attr))
        self.assertEqual(modules, {'transports.py', 'video_analysis.py'})
        self.assertCountEqual(calls, [('transports.py', 'create_connection'), ('video_analysis.py', 'create_connection')])

    def test_non_loopback_rejected_before_av_directory_or_socket_side_effects(self):
        original_import = builtins.__import__

        def no_av(name, *args, **kwargs):
            if name == 'av':
                raise AssertionError('AV import happened before endpoint rejection')
            return original_import(name, *args, **kwargs)

        for host in ('192.168.1.254', '10.0.0.1', '8.8.8.8', '0.0.0.0', '::', 'fe80::1', '::ffff:192.168.1.254', 'board.example', '127.0.0.1.example', '127.0.0.1:8765', '', None, 127001):
            with self.subTest(host=host), mock.patch('builtins.__import__', side_effect=no_av), mock.patch.object(video, 'Path') as path, mock.patch.object(video.socket, 'create_connection') as connect:
                with self.assertRaisesRegex(ValueError, 'loopback SSH tunnel'):
                    video.analyze_video('unused.mp4', host, [], [], {}, 'unused-output')
                path.assert_not_called()
                connect.assert_not_called()

    def test_allowed_literal_uses_shared_validator_and_fixed_control_port(self):
        av = types.ModuleType('av')
        with mock.patch.dict(sys.modules, {'av': av}), mock.patch.object(video, 'Path'), mock.patch.object(video.socket, 'create_connection', side_effect=MockConnectionReached) as connect:
            with self.assertRaises(MockConnectionReached):
                video.analyze_video('unused.mp4', '127.0.0.1', [], [], {}, 'unused-output')
            connect.assert_called_once_with(('127.0.0.1', 8765), timeout=10)

    def test_localhost_is_canonicalized_before_mock_connection_without_dns(self):
        self.assertEqual(transport.require_loopback_host('localhost'), '127.0.0.1')
        av = types.ModuleType('av')
        with mock.patch.dict(sys.modules, {'av': av}), mock.patch.object(video, 'Path'), mock.patch.object(video.socket, 'getaddrinfo', side_effect=AssertionError('DNS is forbidden')) as dns, mock.patch.object(video.socket, 'create_connection', side_effect=MockConnectionReached) as connect:
            with self.assertRaises(MockConnectionReached):
                video.analyze_video('unused.mp4', 'localhost', [], [], {}, 'unused-output')
            connect.assert_called_once_with(('127.0.0.1', 8765), timeout=10)
            dns.assert_not_called()

    def test_invalid_hello_never_sends_settings_queries_or_upload(self):
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        replies = [dict(type='hello', ok=False, protocol=1), dict(type='hello', protocol=1), dict(type='hello', ok=1, protocol=1), dict(type='hello', ok=True, protocol=2)]
        for reply in replies:
            # Include the old path's expected fields to reveal premature acceptance.
            reply.update(inference={'state': 'STOPPED'}, query_revision=0)
            sock = FakeSocket(reply)
            av = types.ModuleType('av')
            av.open = mock.MagicMock()
            clock = Clock()
            with self.subTest(reply=reply), tempfile.TemporaryDirectory(prefix='mock-video-', dir=EVIDENCE) as temporary, mock.patch.dict(sys.modules, {'av': av}), mock.patch.object(video.socket, 'create_connection', return_value=sock), mock.patch.object(video.time, 'monotonic', side_effect=clock.monotonic):
                output = Path(temporary) / 'analysis'
                with self.assertRaisesRegex(TimeoutError, '视频分析握手失败'):
                    video.analyze_video('unused.mp4', '127.0.0.1', [], [], {}, output)
                self.assertEqual([item['op'] for item in sock.sent], ['hello'])
                report = json.loads((output / 'session.json').read_text(encoding='utf-8'))
                self.assertFalse(report['ok'])
                self.assertEqual(report['frames'], 0)
                self.assertEqual(report['completed'], 0)

    def test_valid_compatibility_hello_can_reach_mock_settings_without_real_inference(self):
        class StopAtSettings(FakeSocket):
            def sendall(self, data):
                super().sendall(data)
                if self.sent[-1]['op'] == 'settings':
                    raise MockConnectionReached('valid compatibility reply')

        sock = StopAtSettings(dict(type='hello', ok=True, protocol=1, inference={'state': 'STOPPED'}, query_revision=0))
        av = types.ModuleType('av')
        av.open = mock.MagicMock()
        clock = Clock()
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='mock-video-', dir=EVIDENCE) as temporary, mock.patch.dict(sys.modules, {'av': av}), mock.patch.object(video.socket, 'create_connection', return_value=sock), mock.patch.object(video.time, 'monotonic', side_effect=clock.monotonic):
            output = Path(temporary) / 'analysis'
            with self.assertRaises(MockConnectionReached):
                video.analyze_video('unused.mp4', '127.0.0.1', [], [], {}, output)
            self.assertEqual([item['op'] for item in sock.sent], ['hello', 'settings'])
            report = json.loads((output / 'session.json').read_text(encoding='utf-8'))
            self.assertFalse(report['ok'])
            self.assertEqual(report['frames'], 0)

    def test_z_no_real_network_process_or_hardware_import_occurred(self):
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--report')
    args = parser.parse_args()
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(HostEndpointSecurity))
    log = stream.getvalue()
    print(log, end='')
    if args.report:
        report = Path(args.report).resolve()
        if not report.is_relative_to(EVIDENCE.resolve()):
            raise ValueError('Report must stay in this test evidence directory')
        report.parent.mkdir(parents=True, exist_ok=True)
        sources = [HOST / name for name in ('video_analysis.py', 'transports.py', 'protocol.py')] + [Path(__file__).resolve()]
        report.write_text(json.dumps(dict(schemaVersion=1, fixtureOnly=True, hardwareAccessed=False, realSocketsOpened=False, sshExecuted=False, helloIsAuthentication=False, testsRun=result.testsRun, successful=result.wasSuccessful(), blockedEvents=BLOCKED, sourceSha256={str(path.relative_to(ROOT)).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}, output=log), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    sys.exit(0 if result.wasSuccessful() else 1)
