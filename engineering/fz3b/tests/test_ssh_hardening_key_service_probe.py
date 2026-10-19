"""Offline fixtures for separate-key login and systemd identity probe."""
import ast
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'ssh_hardening_key_service_probe.py'
spec = importlib.util.spec_from_file_location('ssh_hardening_key_service_probe', PATH)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def sha(value):
    return hashlib.sha256(value).hexdigest()


class ProbeTests(unittest.TestCase):
    def fixture(self):
        project = b'project-blob-fixture'
        recovery = b'recovery-blob-fixture'
        auth = (b'ssh-ed25519 ' + base64.b64encode(project) + b' project\n' +
                b'ssh-ed25519 ' + base64.b64encode(recovery) + b' recovery\n')
        backup = auth.splitlines()[0] + b'\n'
        def reader(parts, size, digest):
            self.assertIn(parts[-1], ('authorized_keys',
                                       'authorized_keys.fz3b-prehardening-20261016'))
            return auth if parts[-1] == 'authorized_keys' else backup
        def runner(argv):
            self.assertEqual(argv[0:2], (probe.SYSTEMCTL, 'show'))
            self.assertIn(argv[2], ('ssh.service', 'sshd.service'))
            data = (b'Id=ssh.service\nNames=ssh.service sshd.service\n'
                    b'FragmentPath=/lib/systemd/system/ssh.service\n'
                    b'ExecReload={ path=/bin/kill ; argv[]=/bin/kill -HUP $MAINPID ; '
                    b'ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; '
                    b'pid=0 ; code=(null) ; status=0/0 }\n'
                    b'ExecReload={ path=/bin/true ; argv[]=/bin/true ; status=0/0 }\n'
                    b'MainPID=123\nActiveState=active\nLoadState=loaded\n')
            return 0, data, sha(b'')
        patches = (mock.patch.object(probe, 'EXPECTED_AUTH_SHA', sha(auth)),
                   mock.patch.object(probe, 'EXPECTED_AUTH_BYTES', len(auth)),
                   mock.patch.object(probe, 'EXPECTED_BACKUP_SHA', sha(backup)),
                   mock.patch.object(probe, 'PROJECT_BLOB_SHA', sha(project)),
                   mock.patch.object(probe, 'RECOVERY_BLOB_SHA', sha(recovery)),
                   mock.patch.object(probe.os, 'geteuid', return_value=0, create=True))
        return reader, runner, patches

    def test_root_sameboot_two_keys_and_service_fields_only(self):
        reader, runner, patches = self.fixture()
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            result = probe.collect(reader=reader, boot=lambda: probe.EXPECTED_BOOT,
                                   runner=runner,
                                   session='169.254.142.174 51000 169.254.220.254 22')
        self.assertEqual(result['user'], 'root')
        self.assertEqual(result['uid'], 0)
        self.assertEqual(result['recoveryPublicKeyCount'], 1)
        self.assertEqual(result['services']['ssh.service']['ActiveState'], 'active')
        self.assertEqual(result['services']['ssh.service']['MainPID'], 123)
        self.assertEqual(result['services']['ssh.service']['ExecReloadCount'], 2)
        self.assertEqual(len(result['services']['ssh.service']['ExecReloadEntrySha256']), 2)
        self.assertEqual(result['services']['ssh.service']['ExecReloadEntries'][1],
                         '{ path=/bin/true ; argv[]=/bin/true ; status=0/0 }')
        self.assertNotIn('project-blob-fixture', json.dumps(result))
        self.assertFalse(result['filesWritten'])

    def test_wrong_source_and_nonroot_refuse(self):
        reader, runner, patches = self.fixture()
        with patches[5]:
            with self.assertRaisesRegex(ValueError, 'root-or-session-identity-mismatch'):
                probe.collect(reader=reader, boot=lambda: probe.EXPECTED_BOOT,
                              runner=runner, session='169.254.142.175 51000 169.254.220.254 22')
        with mock.patch.object(probe.os, 'geteuid', return_value=1000, create=True):
            with self.assertRaisesRegex(ValueError, 'root-or-session-identity-mismatch'):
                probe.collect(reader=reader, boot=lambda: probe.EXPECTED_BOOT,
                              runner=runner, session='169.254.142.174 51000 169.254.220.254 22')

    def test_service_rejects_extra_or_unsafe_fields(self):
        def extra(argv):
            return 0, (b'Id=ssh.service\nNames=ssh.service\nFragmentPath=/lib/ssh\n'
                       b'ExecReload=\nMainPID=123\nActiveState=active\nLoadState=loaded\n'
                       b'Environment=SECRET=value\n'), sha(b'')
        with self.assertRaisesRegex(ValueError, 'unsafe-systemctl-property') as caught:
            probe._service(extra, 'ssh.service')
        self.assertEqual(caught.exception.property_key, 'unknown')
        self.assertEqual(caught.exception.property_line, 8)
        self.assertEqual(caught.exception.value_length, len('SECRET=value'))
        self.assertEqual(caught.exception.duplicate_count, 0)

    def test_only_exec_reload_can_repeat_with_eight_entry_limit(self):
        base = (b'Id=ssh.service\nNames=ssh.service\nFragmentPath=/lib/ssh\n'
                b'ExecReload=/bin/true\nMainPID=123\nActiveState=active\nLoadState=loaded\n')
        def run(data):
            return lambda argv: (0, data, sha(b''))
        with self.assertRaisesRegex(ValueError, 'duplicate-systemctl-property') as caught:
            probe._service(run(base + b'Id=other\n'), 'ssh.service')
        self.assertEqual(caught.exception.property_key, 'Id')
        self.assertEqual(caught.exception.duplicate_count, 1)
        self.assertEqual(probe._service(run(base), 'ssh.service')['ExecReloadCount'], 1)
        too_many = base.replace(b'ExecReload=/bin/true\n', b'ExecReload=/bin/true\n' * 9)
        with self.assertRaisesRegex(ValueError, 'too-many-reload-entries') as caught:
            probe._service(run(too_many), 'ssh.service')
        self.assertEqual(caught.exception.duplicate_count, 8)

    def test_property_diagnostic_excludes_value(self):
        def failure():
            raise probe.PropertyError('duplicate-systemctl-property', 'ExecReload', 4, 29, 2)
        with mock.patch.object(probe, 'collect', side_effect=failure), \
             mock.patch('builtins.print') as printed:
            self.assertEqual(probe.main([]), 1)
        value = json.loads(printed.call_args[0][0])
        self.assertEqual(value['propertyKey'], 'ExecReload')
        self.assertEqual(value['propertyLine'], 4)
        self.assertEqual(value['valueLength'], 29)
        self.assertEqual(value['duplicateCount'], 2)
        self.assertNotIn('argv', printed.call_args[0][0])

    def test_missing_secondary_alias_is_reported_without_hiding_active_unit(self):
        reader, runner, patches = self.fixture()
        def one_alias(argv):
            if argv[2] == 'sshd.service':
                return 4, b'', sha(b'unit-not-found fixture')
            return runner(argv)
        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            result = probe.collect(reader=reader, boot=lambda: probe.EXPECTED_BOOT,
                                   runner=one_alias,
                                   session='169.254.142.174 51000 169.254.220.254 22')
        self.assertFalse(result['services']['sshd.service']['available'])
        self.assertTrue(result['services']['ssh.service']['available'])

    def test_controlled_failure_excludes_exception_body(self):
        with mock.patch.object(probe, 'collect', side_effect=ValueError('ssh-service-unidentified')), \
             mock.patch('builtins.print') as printed:
            self.assertEqual(probe.main([]), 1)
        value = json.loads(printed.call_args[0][0])
        self.assertEqual(value['errorCode'], 'ssh-service-unidentified')
        self.assertEqual(value['scope'], 'fz3b-key-service-diagnostic')
        self.assertNotIn('stdout', value)

    def test_python36_fixed_no_secret_scope(self):
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('/etc/shadow', source)
        self.assertNotIn('ssh_host_ed25519_key', source)
        self.assertNotIn('systemctl reload', source)
        with mock.patch.object(probe, 'collect', side_effect=AssertionError('no IO')):
            with self.assertRaises(SystemExit):
                probe.main(['--other'])


if __name__ == '__main__':
    unittest.main()
