"""Pure local fixtures for the fixed sshd config structure probe."""
import ast
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'ssh_hardening_structure.py'
spec = importlib.util.spec_from_file_location('ssh_hardening_structure', PATH)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class StructureTests(unittest.TestCase):
    def describe(self, data, session='169.254.142.174 51000 169.254.220.254 22'):
        with mock.patch.object(probe, 'CONFIG_BYTES', len(data)), \
             mock.patch.object(probe, 'CONFIG_SHA256', hashlib.sha256(data).hexdigest()):
            return probe.describe(data, session)

    def test_fixed_structure_and_auth_values_without_other_raw_values(self):
        data = (b'# Banner /secret\nPasswordAuthentication yes\n'
                b'UsePAM yes\nBanner /private/location\nMatch User root\n'
                b'PasswordAuthentication no\n')
        result = self.describe(data)
        self.assertEqual(result['matchCount'], 1)
        self.assertEqual(result['includeCount'], 0)
        self.assertEqual([entry['key'] for entry in result['directives']],
                         ['passwordauthentication', 'usepam', 'banner', 'match',
                          'passwordauthentication'])
        self.assertEqual(result['directives'][3]['matchCriteria'], 'User root')
        self.assertEqual(result['directives'][0]['authValue'], 'yes')
        self.assertNotIn('/private/location', str(result))
        self.assertTrue(result['sessionContextMatches'])

    def test_changed_session_is_reported_not_used_as_match_context(self):
        result = self.describe(b'PasswordAuthentication yes\n',
                               '169.254.142.175 51000 169.254.220.254 22')
        self.assertFalse(result['sessionContextMatches'])

    def test_preimage_mismatch_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'config-sha-or-size-mismatch'):
            probe.describe(b'changed\n', '')

    def test_match_value_requires_safe_bounded_shape(self):
        with self.assertRaisesRegex(ValueError, 'unsafe-match-value'):
            self.describe(b'Match User root # unexpected\n')

    def test_python36_scope_and_no_secret_reads(self):
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('/etc/shadow', source)
        self.assertNotIn('ssh_host_ed25519_key', source)
        self.assertNotIn('authorized_keys', source)
        with mock.patch.object(probe, 'read_config', side_effect=AssertionError('no read')):
            with self.assertRaises(SystemExit):
                probe.main(['--path', '/etc/shadow'])


if __name__ == '__main__':
    unittest.main()
