"""Offline mocks only: never run the real readiness collector/systemctl/files."""
import ast
import hashlib
import importlib.util
import json
import stat
from pathlib import Path
import subprocess
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('probe_readiness_readonly', Path(__file__).resolve().parents[1] / 'tools/probe_readiness_readonly.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FakeAccess(object):
    def __init__(self):
        self.reads = []
        self.data = dict((path, b'offline code fixture') for path in probe.CONTENT_FILES + probe.APP_FILES)
        self.data[probe.CONFIG] = json.dumps({'control_host': '127.0.0.1', 'video_host': 'localhost', 'control_port': 8765,
            'video_port': 8766, 'token': 'NEVER-EXPORT', 'token_file': '/root/.ssh/secret', 'bind': '127.0.0.1'}).encode('ascii')
        self.data[probe.BOOT_ID] = b'5ceb45a3-8903-4efc-9484-ec75c17280df\n'

    def read(self, path, limit):
        assert path in probe.FILE_LIMITS
        self.reads.append((path, limit))
        if path not in self.data:
            raise FileNotFoundError()
        if len(self.data[path]) > limit:
            raise probe.ProbeError('file-limit-exceeded')
        return self.data[path]

    def uname(self):
        return {'sysname': 'Linux', 'release': 'fixture', 'machine': 'aarch64'}

    def disk(self):
        return {'path': probe.PROJECT, 'availableBytes': 1024}

    def service(self):
        return {'status': 'collected', 'properties': {'ActiveState': 'active', 'MainPID': '1234'}}


class ReadinessTests(unittest.TestCase):
    def test_only_fixed_source_contents_and_application_hashes_are_returned(self):
        access = FakeAccess()
        with mock.patch.object(probe, 'SystemAccess', side_effect=AssertionError('real audit forbidden')):
            result = probe.collect(access)
        self.assertEqual([item['path'] for item in result['contentFiles']], list(probe.CONTENT_FILES))
        self.assertTrue(all(item['content'] == 'offline code fixture' for item in result['contentFiles']))
        self.assertTrue(all('content' not in item for item in result['applicationHashes']))
        self.assertEqual(result['applicationHashes'][0]['sha256'], hashlib.sha256(b'offline code fixture').hexdigest())
        self.assertEqual(set(path for path, _ in access.reads), set(probe.FILE_LIMITS))
        encoded = json.dumps(result)
        for secret in ('NEVER-EXPORT', '/root/.ssh/secret'):
            self.assertNotIn(secret, encoded)
        self.assertEqual(result['config']['config']['fields']['bind']['value'], '127.0.0.1')
        self.assertEqual(result['programming'], 'not-attempted')
        self.assertEqual(result['serviceActions'], 'not-attempted')

    def test_aggregate_and_per_file_limits_never_expand_or_emit_excess(self):
        access = FakeAccess()
        for path in probe.CONTENT_FILES:
            access.data[path] = b'x' * probe.SINGLE_LIMIT
        result = probe.collect(access)
        self.assertEqual(result['totalFileReadBytes'], probe.TOTAL_LIMIT)
        self.assertEqual(len(access.reads), 2)
        self.assertEqual(sum(len(item.get('content', '')) for item in result['contentFiles']), probe.TOTAL_LIMIT)
        self.assertEqual(result['contentFiles'][2]['code'], 'aggregate-file-budget-exhausted')

    def test_config_bad_host_and_ports_omit_values_and_unknown_fields(self):
        result = probe.config_summary(b'{"control_host":"SECRET","video_host":true,"control_port":true,"video_port":99999,"password":"SECRET"}')
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertTrue(all(field['valueOmitted'] for field in result['fields'].values()))
        with self.assertRaises(probe.ProbeError):
            probe.config_summary(b'{"control_port":1,"control_port":2}')

    def test_config_bind_exports_only_literal_ip_not_hostnames_or_private_text(self):
        for address in ('127.0.0.1', '0.0.0.0', '::1'):
            result = probe.config_summary(json.dumps({'bind': address}).encode('ascii'))
            self.assertEqual(result['fields']['bind']['value'], address)
        for value in ('localhost', 'PRIVATE-SECRET', '127.0.0.1\nPRIVATE', True, 123, None):
            result = probe.config_summary(json.dumps({'bind': value}).encode('ascii'))
            self.assertNotIn('value', result['fields']['bind'])
            self.assertTrue(result['fields']['bind']['valueOmitted'])
            self.assertNotIn('PRIVATE', json.dumps(result))

    def test_fixed_systemctl_show_has_no_actions_env_inheritance_or_raw_stderr(self):
        completed = mock.Mock(returncode=0, stdout=b'ActiveState=active\nSubState=running\nMainPID=1234\nEnvironment=SECRET\n', stderr=b'SECRET')
        with mock.patch.object(probe.subprocess, 'run', return_value=completed) as run:
            result = probe.service_show()
        args, kwargs = run.call_args
        self.assertEqual(args, (list(probe.SYSTEMCTL),))
        self.assertEqual(probe.SYSTEMCTL[1:3], ('show', 'fz3b-vision-console.service'))
        self.assertEqual(kwargs['env'], probe.CHILD_ENV)
        self.assertFalse(kwargs['shell'])
        self.assertEqual(kwargs['timeout'], 5)
        self.assertEqual(kwargs['stdin'], subprocess.DEVNULL)
        self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(set(result['properties']), {'ActiveState', 'SubState', 'MainPID'})

    def test_systemctl_timeout_failure_duplicate_and_large_output_are_not_success(self):
        with mock.patch.object(probe.subprocess, 'run', side_effect=subprocess.TimeoutExpired(probe.SYSTEMCTL, 5)):
            with self.assertRaises(subprocess.TimeoutExpired):
                probe.service_show()
        for result in (mock.Mock(returncode=1, stdout=b'', stderr=b'SECRET'),
                       mock.Mock(returncode=0, stdout=b'x' * (probe.SYSTEMCTL_LIMIT + 1)),
                       mock.Mock(returncode=0, stdout=b'ActiveState=active\nActiveState=inactive\n')):
            with mock.patch.object(probe.subprocess, 'run', return_value=result):
                with self.assertRaises(probe.ProbeError):
                    probe.service_show()

    def test_unknown_paths_and_cli_commands_are_refused_before_real_io(self):
        with mock.patch.object(probe, '_directory', side_effect=AssertionError('must refuse first')):
            for path in ('/root/.ssh/id_rsa', '/proc/self/environ', '/root/license.lic', '/dev/mem'):
                with self.assertRaises(probe.ProbeError):
                    probe.read_fixed(path, 100)
        for args in (['--path', probe.CONFIG], ['--command', 'start'], ['--include-loader-status']):
            with mock.patch.object(probe, 'collect', side_effect=AssertionError('must reject before audit')), mock.patch('sys.stderr'):
                with self.assertRaises(SystemExit):
                    probe.main(args)

    def test_source_open_is_bounded_regular_nofollow_and_closes_every_descriptor(self):
        for mode, size, links, should_pass in ((stat.S_IFREG, 3, 1, True), (stat.S_IFIFO, 3, 1, False),
                                                (stat.S_IFREG, probe.SINGLE_LIMIT + 1, 1, False), (stat.S_IFREG, 3, 2, False)):
            info = mock.Mock(st_mode=mode, st_size=size, st_nlink=links, st_dev=1, st_ino=2,
                             st_mtime_ns=1, st_ctime_ns=1, st_mtime=1, st_ctime=1)
            with mock.patch.object(probe, '_directory', return_value=90), \
                 mock.patch.object(probe.os, 'O_NOFOLLOW', 131072, create=True), \
                 mock.patch.object(probe.os, 'O_NONBLOCK', 2048, create=True), \
                 mock.patch.object(probe.os, 'open', return_value=91) as opened, \
                 mock.patch.object(probe.os, 'close') as closed, \
                 mock.patch.object(probe.os, 'fstat', return_value=info), \
                 mock.patch.object(probe.os, 'read', side_effect=[b'abc', b'']):
                if should_pass:
                    self.assertEqual(probe.read_fixed(probe.CONTENT_FILES[0], probe.SINGLE_LIMIT), b'abc')
                else:
                    with self.assertRaises(probe.ProbeError):
                        probe.read_fixed(probe.CONTENT_FILES[0], probe.SINGLE_LIMIT)
                self.assertTrue(opened.call_args.args[1] & 131072)
                self.assertEqual(closed.call_args_list, [mock.call(91), mock.call(90)])

    def test_disk_observation_uses_the_fixed_nofollow_directory_descriptor(self):
        info = mock.Mock(f_blocks=100, f_bavail=40, f_bfree=50, f_frsize=4096)
        with mock.patch.object(probe, '_directory', return_value=90) as opened, \
             mock.patch.object(probe.os, 'fstatvfs', return_value=info, create=True) as observed, \
             mock.patch.object(probe.os, 'close') as closed:
            result = probe.SystemAccess().disk()
        opened.assert_called_once_with(probe.PROJECT.strip('/').split('/'))
        observed.assert_called_once_with(90)
        closed.assert_called_once_with(90)
        self.assertEqual(result['availableBytes'], 40 * 4096)

    def test_python36_grammar_and_no_application_or_network_import(self):
        source = Path(spec.origin).read_text(encoding='utf-8')
        tree = ast.parse(source, feature_version=(3, 6))
        imports = [item.names[0].name for item in ast.walk(tree) if isinstance(item, ast.Import)]
        self.assertTrue(all(not item.startswith(('vision_app', 'socket', 'paramiko', 'serial')) for item in imports))
        self.assertNotIn('os.environ', source)


if __name__ == '__main__':
    unittest.main()
