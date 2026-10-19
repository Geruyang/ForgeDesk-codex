"""Offline tests for fixed SSH authentication audit; no board connection."""
import ast
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'ssh_hardening_audit.py'
spec = importlib.util.spec_from_file_location('ssh_hardening_audit', PATH)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def sha(value):
    return hashlib.sha256(value).hexdigest()


class AuditTests(unittest.TestCase):
    def fixture(self):
        project_blob = b'project-public-blob-fixture'
        host_blob = b'host-public-blob-fixture'
        values = {
            audit.CONFIG: b'Include /etc/ssh/sshd_config.d/*.conf\nPasswordAuthentication yes\n',
            audit.AUTHORIZED: b'ssh-ed25519 ' + base64.b64encode(project_blob) + b' secret-comment-not-output\n',
            audit.HOST_PUBLIC: b'ssh-ed25519 ' + base64.b64encode(host_blob) + b' host-comment-not-output\n',
            audit.DROPINS + '/local.conf': b'PasswordAuthentication yes\n',
        }
        reads = []
        commands = []

        def reader(path, cap, deadline):
            reads.append(path)
            value = values[path]
            self.assertLessEqual(len(value), cap)
            info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0)
            return value, info

        def runner(argv, deadline):
            commands.append(tuple(argv))
            if argv[1] == '-V':
                return 0, b'', b'OpenSSH_7.6p1 fixture\n'
            if argv[1] == '-t':
                return 0, b'', b''
            return 0, (b'pubkeyauthentication yes\npasswordauthentication yes\n'
                       b'kbdinteractiveauthentication yes\npermitrootlogin yes\n'
                       b'authorizedkeysfile .ssh/authorized_keys\n'), b''

        return values, reads, commands, reader, runner, sha(project_blob), sha(host_blob)

    def test_safe_summary_omits_keys_config_content_and_passwords(self):
        values, reads, commands, reader, runner, project_sha, host_sha = self.fixture()
        with mock.patch.object(audit, 'PROJECT_KEY_BLOB_SHA', project_sha), \
             mock.patch.object(audit, 'HOST_KEY_BLOB_SHA', host_sha):
            result = audit.collect(reader=reader, listing=lambda: ['local.conf'], runner=runner,
                                   session='169.254.142.174 51000 169.254.220.254 22')
        self.assertEqual(result['result'], 'audit-collected')
        self.assertEqual(len(commands), 3)
        self.assertEqual(len(reads), 4)
        self.assertEqual(result['commands']['syntax']['valid'], True)
        self.assertEqual(result['commands']['effectiveRoot']['auth']['passwordauthentication'], 'yes')
        self.assertEqual(result['files'][1]['projectPublicKeyCount'], 1)
        self.assertEqual(result['files'][2]['matchesPinnedHostPublicKey'], True)
        output = json.dumps(result)
        self.assertNotIn('secret-comment-not-output', output)
        self.assertNotIn('host-comment-not-output', output)
        self.assertNotIn('PasswordAuthentication yes', output)
        self.assertNotIn(base64.b64encode(b'project-public-blob-fixture').decode(), output)
        self.assertFalse(result['privateKeyRead'])
        self.assertFalse(result['passwordOrShadowRead'])
        self.assertEqual(result['serviceActions'], 'not-attempted')
        self.assertTrue(result['currentSessionMatchesExpectedConnection'])

    def test_syntax_failure_is_incomplete_without_raw_stderr(self):
        values, reads, commands, reader, runner, project_sha, host_sha = self.fixture()
        def broken(argv, deadline):
            if argv[1] == '-t':
                return 1, b'', b'password secret fixture invalid\n'
            return runner(argv, deadline)
        result = audit.collect(reader=reader, listing=lambda: [], runner=broken)
        self.assertEqual(result['result'], 'audit-incomplete')
        self.assertFalse(result['commands']['syntax']['valid'])
        self.assertNotIn('password secret fixture', json.dumps(result))

    def test_effective_values_are_allowlisted_and_bounded(self):
        with self.assertRaisesRegex(audit.AuditError, 'duplicate-effective-field'):
            audit._effective(b'passwordauthentication yes\npasswordauthentication no\n')
        with self.assertRaisesRegex(audit.AuditError, 'unexpected-effective-token'):
            audit._effective(b'passwordauthentication secret=value\n')
        safe = audit._effective(b'authorizedkeysfile .ssh/authorized_keys\n')
        self.assertTrue(safe['authorizedkeysfile']['matchesDefault'])
        self.assertNotIn('.ssh/authorized_keys', json.dumps(safe))

    def test_fixed_scope_and_python36_syntax(self):
        self.assertEqual(audit.SSHD, '/usr/sbin/sshd')
        self.assertEqual(audit.AUTHORIZED, '/root/.ssh/authorized_keys')
        self.assertEqual(audit.MATCH, 'user=root,host=169.254.142.174,addr=169.254.142.174,laddr=169.254.220.254,lport=22')
        self.assertEqual([entry[1][1] for entry in audit.COMMANDS], ['-V', '-t', '-T'])
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('/etc/shadow', source)
        self.assertNotIn("'/etc/ssh/ssh_host_ed25519_key'", source)
        self.assertNotIn('import vision_app', source)
        self.assertNotIn('shell=True', source)
        with mock.patch.object(audit, 'collect', side_effect=AssertionError('no read')):
            with self.assertRaises(SystemExit):
                audit.main(['--path', '/etc/shadow'])

    def test_bad_dropin_names_are_rejected_before_read(self):
        values, reads, commands, reader, runner, project_sha, host_sha = self.fixture()
        result = audit.collect(reader=reader, listing=lambda: ['../../secret.conf'], runner=runner)
        self.assertEqual(result['result'], 'audit-incomplete')
        self.assertFalse(any('secret.conf' in path for path in reads))

    def test_fixed_match_context_requires_current_session_confirmation(self):
        values, reads, commands, reader, runner, project_sha, host_sha = self.fixture()
        with mock.patch.object(audit, 'PROJECT_KEY_BLOB_SHA', project_sha), \
             mock.patch.object(audit, 'HOST_KEY_BLOB_SHA', host_sha):
            result = audit.collect(reader=reader, listing=lambda: ['local.conf'], runner=runner,
                                   session='169.254.142.175 51000 169.254.220.254 22')
        self.assertEqual(result['result'], 'audit-incomplete')
        self.assertFalse(result['currentSessionMatchesExpectedConnection'])
        self.assertIn('session-context-unverified', result['issues'])
        self.assertEqual(result['commands']['effectiveRoot']['matchContext'], audit.MATCH)
        self.assertNotIn('51000', json.dumps(result))

    def test_host_and_project_key_mismatch_are_explicit_issues(self):
        values, reads, commands, reader, runner, project_sha, host_sha = self.fixture()
        result = audit.collect(reader=reader, listing=lambda: ['local.conf'], runner=runner,
                               session='169.254.142.174 51000 169.254.220.254 22')
        self.assertEqual(result['result'], 'audit-incomplete')
        self.assertIn('project-public-key-not-in-fixed-authorized-keys', result['issues'])
        self.assertIn('host-public-key-pin-mismatch', result['issues'])


if __name__ == '__main__':
    unittest.main()
