"""Offline fixtures for the fixed loader override diagnostic."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'probe_loader_override_readonly.py'
spec = importlib.util.spec_from_file_location('probe_loader_override_readonly', PATH)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def fixture():
    state = {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '3491',
             'FragmentPath': probe.UNIT, 'DropInPaths': probe.DROPIN,
             'ExecStart': '{ path=/usr/bin/python3 ; argv[]=' + probe.EXPECTED_ARGV +
                          ' ; ignore_errors=no ; start_time=fixture ; }'}
    config = {'schema': 'fz3b-v10.5-ps-pl-loader-v1',
              'assets': {label: {'path': '/root/fixture/' + label,
                                  'bytes': 3, 'sha256': 'a' * 64}
                         for label in probe.ASSET_LABELS},
              'token': 'NEVER-OUTPUT', 'environment': {'password': 'SECRET'}}
    data = {probe.DROPIN: probe.EXPECTED_DROPIN.encode('ascii'),
            probe.CONFIG: json.dumps(config).encode('utf-8')}
    reads = []

    def reader(path, cap):
        reads.append(path)
        assert len(data[path]) <= cap
        return data[path]

    return state, data, reads, reader


class DiagnosticTests(unittest.TestCase):
    def test_published_override_and_fixed_config_summary(self):
        state, data, reads, reader = fixture()
        with mock.patch.object(probe, 'CONFIG_SHA_PUBLISHED', hashlib.sha256(data[probe.CONFIG]).hexdigest()):
            result = probe.collect(reader=reader, show=lambda: state)
        self.assertEqual(result['result'], 'diagnostic-matches-published')
        self.assertEqual(reads, [probe.DROPIN, probe.CONFIG])
        self.assertEqual(result['dropIn']['content'], probe.EXPECTED_DROPIN)
        self.assertEqual(result['service']['effectiveExecStart'], state['ExecStart'])
        self.assertEqual(len(result['config']['assets']), 12)
        self.assertNotIn('NEVER-OUTPUT', json.dumps(result))
        self.assertNotIn('SECRET', json.dumps(result))

    def test_environment_override_content_is_omitted(self):
        state, data, reads, reader = fixture()
        data[probe.DROPIN] += b'Environment=SECRET_VALUE=NEVER-OUTPUT\n'
        result = probe.collect(reader=reader, show=lambda: state)
        self.assertEqual(result['result'], 'hold')
        self.assertFalse(result['dropIn']['matchesPublishedTemplate'])
        self.assertNotIn('content', result['dropIn'])
        self.assertNotIn('NEVER-OUTPUT', json.dumps(result))

    def test_unknown_effective_command_does_not_read_config(self):
        state, data, reads, reader = fixture()
        state['ExecStart'] = 'argv[]=/bin/unknown --config /root/.ssh/id_rsa ;'
        result = probe.collect(reader=reader, show=lambda: state)
        self.assertEqual(result['result'], 'hold')
        self.assertEqual(reads, [probe.DROPIN])
        self.assertNotIn('/root/.ssh/id_rsa', json.dumps(result))

    def test_unknown_dropin_path_does_not_read_files(self):
        state, data, reads, reader = fixture()
        state['DropInPaths'] += ' /etc/systemd/system/other.conf'
        result = probe.collect(reader=reader, show=lambda: state)
        self.assertEqual(result['result'], 'hold')
        self.assertEqual(reads, [])

    def test_json_validation_and_python36_syntax(self):
        for raw in (b'{"assets":{},"assets":{}}', b'{"assets":{},"x":1e999}'):
            with self.assertRaises(probe.ProbeError):
                probe.summarize_config(raw)
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('import socket', source)
        self.assertNotIn('import vision_app', source)
        self.assertNotIn('os.environ', source)
        with mock.patch.object(probe, 'collect', side_effect=AssertionError('no execution')):
            with self.assertRaises(SystemExit):
                probe.main(['--path', '/dev/mem'])


if __name__ == '__main__':
    unittest.main()
