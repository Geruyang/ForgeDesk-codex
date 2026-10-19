"""Offline fixture for the standalone FZ3B runtime-asset probe."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import unittest
from unittest import mock


PATH = Path(__file__).resolve().parents[1] / 'tools' / 'probe_runtime_assets.py'
spec = importlib.util.spec_from_file_location('probe_runtime_assets', PATH)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FakeAccess(object):
    def __init__(self):
        self.reads = []
        self.digests = []
        self.data = {}
        self.types = {}
        self.hashes = {}
        unit = ('[Service]\nExecStart=/usr/bin/python3 -B ' + probe.LOADER_CODE +
                ' daemon --config ' + probe.LOADER_CONFIG + ' --auto-target a0005\n').encode()
        self.data[probe.LOADER_UNIT] = unit
        self.hashes[probe.LOADER_CODE] = {'bytes': 6, 'sha256': sha(b'loader')}
        config = {'schema': 'fz3b-v10.5-ps-pl-loader-v1',
                  'assets': {'fixture': {'path': '/root/fixture-asset',
                                         'bytes': 3, 'sha256': sha(b'abc')}},
                  'token': 'NEVER-OUTPUT', 'environment': 'SECRET-ENV'}
        self.data[probe.LOADER_CONFIG] = json.dumps(config).encode()
        self.types['/root/fixture-asset'] = 'regular'
        self.hashes['/root/fixture-asset'] = {'bytes': 3, 'sha256': sha(b'abc')}
        contract = {'contract_id': 'fixture-contract', 'secret': 'NEVER-OUTPUT'}
        self.data[probe.CONTRACT] = json.dumps(contract).encode()
        for root in (probe.RETAINED, probe.PAYLOAD, probe.LOADER_ROOT):
            self.types[root] = 'directory'
        self.roots = []
        self.leaves = []
        for name, path, unused, root in probe.ROOT_MANIFESTS:
            content = (name + '-leaf').encode()
            relative = name + '.bin'
            self.leaves.append(root + '/' + relative)
            self.hashes[root + '/' + relative] = {'bytes': len(content), 'sha256': sha(content)}
            document = {'schema': name, 'files': {'one': {'path': relative,
                        'bytes': len(content), 'sha256': sha(content)}}}
            self.data[path] = json.dumps(document).encode()
            self.roots.append((name, path, sha(self.data[path]), root))
        for native in probe.NATIVE:
            self.types[native] = 'regular'
            self.hashes[native] = {'bytes': 4, 'sha256': sha(b'native')}

    def read(self, path, limit, deadline):
        self.reads.append(path)
        value = self.data[path]
        if len(value) > limit:
            raise probe.ProbeError('file-limit-exceeded')
        return value

    def digest(self, path, limit, deadline):
        self.digests.append(path)
        value = self.hashes[path]
        if value['bytes'] > limit:
            raise probe.ProbeError('file-limit-exceeded')
        return dict(value)

    def describe(self, path):
        return {'type': self.types.get(path, 'regular'), 'bytes': 0}

    def service(self):
        return {'ActiveState': 'active', 'FragmentPath': probe.LOADER_UNIT,
                'DropInPaths': '', 'MainPID': '42', 'SubState': 'running',
                'ExecStart': '{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -B ' +
                             probe.LOADER_CODE + ' daemon --config ' +
                             probe.LOADER_CONFIG + ' --auto-target a0005 ; ignore_errors=no ; }'}

    def version(self):
        return {'kernel': 'fixture', 'machine': 'aarch64', 'python': [3, 6, 15]}


class ProbeTests(unittest.TestCase):
    def fixture(self):
        fake = FakeAccess()
        patches = [mock.patch.object(probe, 'UNIT_SHA', sha(fake.data[probe.LOADER_UNIT])),
                   mock.patch.object(probe, 'LOADER_SHA', sha(b'loader')),
                   mock.patch.object(probe, 'CONTRACT_SHA', sha(fake.data[probe.CONTRACT])),
                   mock.patch.object(probe, 'CONTRACT_ID', 'fixture-contract'),
                   mock.patch.object(probe, 'ASSET_PATHS', {'fixture': '/root/fixture-asset'}),
                   mock.patch.object(probe, 'ASSET_EXPECTED', {'fixture': (3, sha(b'abc'))}),
                   mock.patch.object(probe, 'ROOT_MANIFESTS', tuple(fake.roots))]
        return fake, patches

    def run_fixture(self, fake, patches):
        for patch in patches:
            patch.start()
        try:
            with mock.patch.object(probe, 'SystemAccess', side_effect=AssertionError('real access forbidden')):
                return probe.collect(fake)
        finally:
            for patch in reversed(patches):
                patch.stop()

    def test_fixed_inventory_and_all_manifest_leaves_verified(self):
        fake, patches = self.fixture()
        result = self.run_fixture(fake, patches)
        self.assertEqual(result['result'], 'pinned-file-hashes-match')
        self.assertEqual(len(result['manifests']), 4)
        self.assertTrue(all(item['match'] for item in result['leaves']))
        self.assertEqual(set(fake.leaves), set(item['path'] for item in result['leaves']))
        self.assertTrue(all('content' in item for item in result['manifests']))
        self.assertNotIn('NEVER-OUTPUT', json.dumps(result))
        self.assertNotIn('SECRET-ENV', json.dumps(result))
        self.assertEqual(result['programming'], 'not-attempted')
        self.assertEqual(result['serviceActions'], 'not-attempted')

    def test_symlink_retained_root_holds_without_manifest_or_leaf_read(self):
        fake, patches = self.fixture()
        fake.types[probe.RETAINED] = 'symlink'
        result = self.run_fixture(fake, patches)
        self.assertEqual(result['result'], 'hold')
        self.assertEqual(result['roots'][0]['type'], 'symlink')
        self.assertFalse(result['manifests'])
        self.assertFalse(set(fake.leaves) & set(fake.digests))

    def test_loader_unit_or_effective_exec_mismatch_blocks_config_chase(self):
        fake, patches = self.fixture()
        patches[0] = mock.patch.object(probe, 'UNIT_SHA', sha(b'wrong'))
        result = self.run_fixture(fake, patches)
        self.assertEqual(result['result'], 'hold')
        self.assertNotIn(probe.LOADER_CONFIG, fake.reads)
        self.assertNotIn('/root/fixture-asset', fake.digests)
        fake, patches = self.fixture()
        fake.service = lambda: {'ActiveState': 'active', 'FragmentPath': probe.LOADER_UNIT,
                                'DropInPaths': '', 'ExecStart': 'unknown'}
        result = self.run_fixture(fake, patches)
        self.assertIn(probe.LOADER_UNIT, fake.reads)
        self.assertNotIn(probe.LOADER_CONFIG, fake.reads)
        self.assertEqual(result['result'], 'hold')

    def reviewed_fixture(self):
        fake, patches = self.fixture()
        fake.data[probe.REVIEWED_DROPIN_PATH] = probe.REVIEWED_DROPIN
        fake.data[probe.REVIEWED_CONFIG] = fake.data[probe.LOADER_CONFIG]
        fake.service = lambda: {'ActiveState': 'active', 'FragmentPath': probe.LOADER_UNIT,
                                'DropInPaths': probe.REVIEWED_DROPIN_PATH,
                                'MainPID': '3491', 'SubState': 'running',
                                'ExecStart': '{ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 -B ' +
                                             probe.LOADER_CODE + ' daemon --config ' + probe.REVIEWED_CONFIG +
                                             ' --auto-target a0005 --log ' + probe.REVIEWED_LOG +
                                             ' ; ignore_errors=no ; }'}
        patches.append(mock.patch.object(probe, 'REVIEWED_CONFIG_SHA',
                                         sha(fake.data[probe.REVIEWED_CONFIG])))
        return fake, patches

    def test_exact_reviewed_dropin_hash_exec_and_config_hash_allow_asset_hashes(self):
        fake, patches = self.reviewed_fixture()
        result = self.run_fixture(fake, patches)
        self.assertEqual(result['result'], 'pinned-file-hashes-match')
        self.assertEqual(result['loader']['reviewedDropIn']['sha256'], probe.REVIEWED_DROPIN_SHA)
        self.assertTrue(result['loader']['reviewedDropIn']['exactBytesMatch'])
        self.assertEqual(result['loader']['configPath'], probe.REVIEWED_CONFIG)
        self.assertIn('/root/fixture-asset', fake.digests)

    def test_reviewed_dropin_or_exec_or_config_change_blocks_asset_hashes(self):
        for change in ('dropin', 'exec', 'config'):
            fake, patches = self.reviewed_fixture()
            if change == 'dropin':
                fake.data[probe.REVIEWED_DROPIN_PATH] += b'Environment=EXTRA=1\n'
            elif change == 'exec':
                original = fake.service()
                original['ExecStart'] = original['ExecStart'].replace(
                    probe.REVIEWED_LOG, '/root/unreviewed.log')
                fake.service = lambda: original
            else:
                fake.data[probe.REVIEWED_CONFIG] += b' '
            result = self.run_fixture(fake, patches)
            self.assertEqual(result['result'], 'hold', change)
            self.assertNotIn('/root/fixture-asset', fake.digests, change)

    def test_unpinned_loader_asset_is_never_opened(self):
        fake, patches = self.fixture()
        config = json.loads(fake.data[probe.LOADER_CONFIG])
        config['assets']['fixture']['path'] = '/root/.ssh/id_rsa'
        fake.data[probe.LOADER_CONFIG] = json.dumps(config).encode()
        result = self.run_fixture(fake, patches)
        self.assertEqual(result['result'], 'hold')
        self.assertNotIn('/root/.ssh/id_rsa', fake.digests)

    def test_relative_path_and_missing_integrity_fail_before_leaf_hash(self):
        record = {'files': {'bad': {'path': '../escape', 'bytes': 1, 'sha256': sha(b'x')}}}
        with self.assertRaisesRegex(probe.ProbeError, 'unsafe-manifest-relative-path'):
            probe.leaf_records([('release', probe.RETAINED, record)])
        record['files']['bad'] = {'path': 'model.bin'}
        with self.assertRaisesRegex(probe.ProbeError, 'manifest-path-without-integrity'):
            probe.leaf_records([('release', probe.RETAINED, record)])
        with self.assertRaisesRegex(probe.ProbeError, 'unsafe-manifest-relative-path'):
            probe.safe_relative(probe.RETAINED, '/root/.ssh/key')

    def test_limits_duplicate_json_and_sensitive_manifest_are_fail_closed(self):
        with self.assertRaisesRegex(probe.ProbeError, 'duplicate-json-key'):
            probe.parse_object(b'{"a":1,"a":2}')
        with self.assertRaisesRegex(probe.ProbeError, 'nonfinite-json'):
            probe.parse_object(b'{"a":1e999}')
        with self.assertRaisesRegex(probe.ProbeError, 'json-number-limit'):
            probe.parse_object(b'{"a":' + b'9' * 65 + b'}')
        self.assertTrue(probe._sensitive({'nested': [{'authToken': 'SECRET'}]}))
        fake, patches = self.fixture()
        with mock.patch.object(probe, 'MAX_TOTAL', 40):
            result = self.run_fixture(fake, patches)
        self.assertEqual(result['result'], 'hold')
        self.assertLessEqual(result['totalFileReadBytes'], 40)
        self.assertFalse(fake.leaves[0] in fake.digests)

    def test_failed_partial_digest_stops_all_later_file_reads(self):
        fake, patches = self.fixture()
        original = fake.digest

        def fail_after_partial(path, limit, deadline):
            if path == '/root/fixture-asset':
                raise probe.ProbeError('simulated-partial-read')
            return original(path, limit, deadline)

        fake.digest = fail_after_partial
        result = self.run_fixture(fake, patches)
        self.assertEqual(result['result'], 'hold')
        self.assertNotIn(probe.CONTRACT, fake.reads)
        self.assertFalse(set(fake.leaves) & set(fake.digests))

    def test_no_real_io_on_import_and_python36_source(self):
        source = PATH.read_text(encoding='utf-8')
        ast.parse(source, feature_version=(3, 6))
        self.assertNotIn('import socket', source)
        self.assertNotIn('import vision_app', source)
        self.assertNotIn('from vision_app', source)
        self.assertNotIn('os.environ', source)
        self.assertNotIn('serviceActions\': \'attempted', source)
        with mock.patch.object(probe, 'collect', side_effect=AssertionError('must reject args')):
            with self.assertRaises(SystemExit):
                probe.main(['--path', '/dev/mem'])

    def test_system_access_reports_symlink_without_following_it(self):
        info = mock.Mock(st_mode=stat.S_IFLNK, st_size=31)
        with mock.patch.object(probe, '_directory', return_value=71), \
             mock.patch.object(probe.os, 'stat', return_value=info) as observed, \
             mock.patch.object(probe.os, 'readlink', return_value='/root/retained-pinned') as target, \
             mock.patch.object(probe.os, 'close') as closed:
            result = probe.SystemAccess().describe(probe.RETAINED)
        self.assertEqual(result['type'], 'symlink')
        self.assertEqual(result['linkTarget'], '/root/retained-pinned')
        self.assertFalse(observed.call_args.kwargs['follow_symlinks'])
        self.assertEqual(target.call_args.kwargs['dir_fd'], 71)
        closed.assert_called_once_with(71)

    def test_regular_open_is_nofollow_and_fstat_failure_closes_fd(self):
        with mock.patch.object(probe, '_directory', return_value=71), \
             mock.patch.object(probe.os, 'O_NOFOLLOW', 131072, create=True), \
             mock.patch.object(probe.os, 'O_NONBLOCK', 2048, create=True), \
             mock.patch.object(probe.os, 'open', return_value=72) as opened, \
             mock.patch.object(probe.os, 'fstat', side_effect=OSError('fixture')), \
             mock.patch.object(probe.os, 'close') as closed:
            with self.assertRaises(OSError):
                probe.SystemAccess()._open_regular(probe.LOADER_CODE, 100)
        self.assertTrue(opened.call_args.args[1] & 131072)
        self.assertEqual(closed.call_args_list, [mock.call(71), mock.call(72)])


if __name__ == '__main__':
    unittest.main()
