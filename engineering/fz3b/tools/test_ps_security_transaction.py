"""Pure in-memory transaction tests. Never invokes systemctl or board paths."""
import ast
import base64
import copy
import importlib.util
import io
import json
import os
import stat
import tarfile
import tempfile
import types
import unittest
from unittest import mock


HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location('ps_security_transaction_under_test',
                                            os.path.join(HERE, 'ps_security_transaction.py'))
T = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(T)
PROJECT = os.path.abspath(os.path.join(HERE, '../../..'))
APPROVED_MANIFEST = os.path.join(PROJECT, 'output/hardware/2026-10-16-continuation/deployment-bundle-v2/manifest.json')
APPROVED_ARCHIVE = os.path.join(PROJECT, 'output/hardware/2026-10-16-continuation/deployment-bundle-v2/data.tar')
FIXTURE_MANIFEST_SHA256 = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09'
FIXTURE_ARCHIVE_SHA256 = 'ec405d018a85e8c4c5e463b61d7f4dc565d34924913a9d54a68a3ac4262ebee3'


def fixture_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_nlink)


def fixed_fixture_bytes(file, expected_size, expected_sha256):
    """Read historical public fixtures only; never substitute current PS source."""
    current = os.path.abspath(file)
    while True:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('linked historical fixture')
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    before = os.lstat(file)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size != expected_size:
        raise ValueError('historical fixture extent/type')
    fd = os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    try:
        opened = os.fstat(fd)
        if fixture_identity(opened) != fixture_identity(before):
            raise ValueError('historical fixture identity')
        chunks, remaining = [], expected_size + 1
        while remaining:
            raw = os.read(fd, remaining)
            if not raw:
                break
            chunks.append(raw)
            remaining -= len(raw)
        raw = b''.join(chunks)
        after = os.lstat(file)
        if (fixture_identity(os.fstat(fd)) != fixture_identity(opened)
                or fixture_identity(after) != fixture_identity(before)
                or after.st_ctime_ns != before.st_ctime_ns
                or len(raw) != expected_size or T.digest(raw) != expected_sha256):
            raise ValueError('historical fixture bytes changed')
        return raw
    finally:
        os.close(fd)


def approved_payloads_from_bytes(manifest_raw, archive_raw):
    if (len(manifest_raw) != 2955 or T.digest(manifest_raw) != FIXTURE_MANIFEST_SHA256
            or len(archive_raw) != 71680 or T.digest(archive_raw) != FIXTURE_ARCHIVE_SHA256):
        raise ValueError('historical fixture pin')
    manifest = json.loads(manifest_raw.decode('utf-8'))
    if (T.APPROVED_MANIFEST_SHA256 != FIXTURE_MANIFEST_SHA256
            or manifest['bundle_bytes'] != len(archive_raw)
            or manifest['bundle_sha256'] != FIXTURE_ARCHIVE_SHA256):
        raise ValueError('historical fixture manifest binding')
    expected = {'PS/' + target for target in T.PY_TARGETS} | {'PS/config.example.json'}
    entries = {entry['path']: entry for entry in manifest['files']}
    if set(entries) != expected or len(manifest['files']) != len(expected):
        raise ValueError('historical fixture file set')
    payloads = {}
    with tarfile.open(fileobj=io.BytesIO(archive_raw), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) != len(expected) or {member.name for member in members} != expected:
            raise ValueError('historical fixture archive members')
        for member in members:
            entry = entries[member.name]
            if (not member.isfile() or member.linkname or member.mode != 0o644
                    or member.uid != 0 or member.gid != 0 or member.mtime != 0
                    or member.size != entry['bytes']):
                raise ValueError('historical fixture member metadata')
            with archive.extractfile(member) as stream:
                raw = stream.read(member.size + 1)
            if len(raw) != entry['bytes'] or T.digest(raw) != entry['new_sha256']:
                raise ValueError('historical fixture member pin')
            if member.name != 'PS/config.example.json':
                target = member.name[3:]
                if T.digest(raw) != T.APPROVED_SOURCE_SHA256[target]:
                    raise ValueError('historical fixture tool binding')
                payloads[target] = raw
    return payloads


def historical_payloads():
    return approved_payloads_from_bytes(
        fixed_fixture_bytes(APPROVED_MANIFEST, 2955, FIXTURE_MANIFEST_SHA256),
        fixed_fixture_bytes(APPROVED_ARCHIVE, 71680, FIXTURE_ARCHIVE_SHA256))


class MemoryFS(object):
    def __init__(self):
        self.files = {}
        for index, path in enumerate(T.TARGETS):
            if path != T.NEW_TARGET:
                self.files[path] = ((b'{"bind":"0.0.0.0","width":1280,"nested":{"x":[1,true,null]}}\n'
                                     if path == 'config.json' else ('OLD = %d\n' % index).encode('ascii')),
                                    0o644, 0, 0)
        self.runs = {}
        self.artifacts = None
        self.replace_calls = 0
        self.mutations = []
        self.fault = None
        self.closed = False
        self.lock_retained = False
        self.lock_uncertain = False
        self.lease = None
        self.lease_active = False

    def read_target(self, path):
        if path not in T.TARGETS:
            raise ValueError('bad target')
        return self.files.get(path)

    def acquire_lock(self, seal, recover=False):
        if self.lease is not None:
            if not recover or self.lease != seal or self.lease_active:
                raise RuntimeError('persistent lock exists or is active')
        self.lease = copy.deepcopy(seal)
        self.lease_active = True
        self.lock_retained = True

    def release_lock(self, seal):
        if self.lease != seal or not self.lease_active:
            raise RuntimeError('wrong lease')
        self.lease = None
        self.lock_retained = False

    def open_run(self, run_id, create):
        if create:
            if run_id in self.runs:
                raise FileExistsError('run exists')
            self.runs[run_id] = {}
            self.mutations.append(('run', run_id))
        elif run_id not in self.runs:
            raise FileNotFoundError('run absent')
        self.artifacts = self.runs[run_id]

    def write_artifact(self, name, data, mode=0o600, uid=0, gid=0):
        if name in self.artifacts:
            raise FileExistsError('artifact exists')
        self.artifacts[name] = (data, mode, uid, gid)
        self.mutations.append(('artifact', name))

    def read_artifact(self, name, limit=T.MAX_SOURCE):
        data = self.artifacts[name][0]
        if len(data) > limit:
            raise RuntimeError('oversized artifact')
        return data

    def replace(self, path, artifact):
        self.replace_calls += 1
        if self.fault:
            self.fault(self, path, artifact, 'before')
        self.files[path] = self.artifacts.pop(artifact)
        self.mutations.append(('replace', path))
        if self.fault:
            self.fault(self, path, artifact, 'after')

    def displace_new(self, path, artifact):
        if artifact in self.artifacts:
            raise FileExistsError('artifact exists')
        self.artifacts[artifact] = self.files.pop(path)
        self.mutations.append(('displace', path))

    def close(self):
        self.closed = True
        self.lease_active = False
        # lock_retained is ownership in this invocation, not an unrelated old lease.


def inactive():
    return {'ActiveState': 'inactive', 'MainPID': '0'}


def request_for(fs):
    payloads = {path: base64.b64encode(raw).decode('ascii')
                for path, raw in historical_payloads().items()}
    return {'schema': 1, 'mode': 'deploy', 'run_id': 'fixture-20261016',
            'expected_sha256': {path: None if fs.files.get(path) is None else T.digest(fs.files[path][0])
                                for path in T.TARGETS},
            'payloads': payloads}


class HistoricalPayloadFixtureTests(unittest.TestCase):
    def test_exact_archive_members_match_original_manifest_and_tool_pins(self):
        payloads = historical_payloads()
        self.assertEqual(set(T.PY_TARGETS), set(payloads))
        self.assertEqual({path: T.digest(raw) for path, raw in payloads.items()},
                         T.APPROVED_SOURCE_SHA256)
        self.assertEqual(40992, len(payloads['vision_app/board_agent.py']))
        self.assertEqual(4032, len(payloads['vision_app/camera.py']))

    def test_changed_or_truncated_archive_and_manifest_are_not_a_fixture_fallback(self):
        manifest = fixed_fixture_bytes(APPROVED_MANIFEST, 2955, FIXTURE_MANIFEST_SHA256)
        archive = fixed_fixture_bytes(APPROVED_ARCHIVE, 71680, FIXTURE_ARCHIVE_SHA256)
        for changed_manifest, changed_archive in (
                (manifest[:-1], archive), (b' ' + manifest[1:], archive),
                (manifest, archive[:-1]), (manifest, b'X' + archive[1:])):
            with self.assertRaisesRegex(ValueError, 'historical fixture pin'):
                approved_payloads_from_bytes(changed_manifest, changed_archive)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.fs = MemoryFS()
        self.original = copy.deepcopy(self.fs.files)
        self.request = request_for(self.fs)

    def run_request(self, request=None, reader=inactive):
        return T.execute_request(self.request if request is None else request,
                                 fs_factory=lambda: self.fs, service_reader=reader)

    def deployed(self):
        result = self.run_request()
        self.assertEqual('deployed', result['status'], result)
        return result

    def rollback_request(self, result):
        return {'schema': 1, 'mode': 'rollback', 'run_id': self.request['run_id'],
                'manifest_sha256': result['manifest_sha256']}

    def test_success_preserves_config_values_and_verified_backups(self):
        result = self.deployed()
        expected = json.loads(self.original['config.json'][0].decode('utf-8'))
        expected['bind'] = '127.0.0.1'
        self.assertEqual(expected, json.loads(self.fs.files['config.json'][0].decode('ascii')))
        for index, path in enumerate(T.TARGETS):
            self.assertEqual(result['manifest']['entries'][index]['new_sha256'], T.digest(self.fs.files[path][0]))
            if path != T.NEW_TARGET:
                self.assertEqual(self.original[path][0], self.fs.artifacts[str(index) + '.original'][0])
        self.assertFalse(result['service_lifecycle_changed'])
        self.assertFalse(result['hardware_accessed'])
        self.assertTrue(self.fs.closed)

    def test_stages_complete_before_first_replace(self):
        def inspect(fs, path, artifact, phase):
            if phase == 'before' and fs.replace_calls == 1:
                self.assertEqual(6, len([name for name in fs.artifacts if name.endswith('.staged')]))
                self.assertIn('manifest.json', fs.artifacts)
                self.assertEqual(5, len([name for name in fs.artifacts if name.endswith('.original')]))
        self.fs.fault = inspect
        self.deployed()

    def test_inactive_and_pid_zero_are_both_required_before_filesystem(self):
        factory = mock.Mock(side_effect=AssertionError('filesystem must not open'))
        for state in ({'ActiveState': 'active', 'MainPID': '0'},
                      {'ActiveState': 'inactive', 'MainPID': '9'},
                      {'ActiveState': 'inactive', 'MainPID': 0}, {}):
            result = T.execute_request(self.request, factory, lambda: state)
            self.assertEqual('failed', result['status'])
        factory.assert_not_called()

    def test_service_query_failure_is_fail_closed(self):
        result = self.run_request(reader=mock.Mock(side_effect=RuntimeError('unavailable')))
        self.assertEqual('failed', result['status'])
        self.assertEqual([], self.fs.mutations)

    def test_bad_requests_rejected_without_mutation(self):
        variants = []
        for run_id in ('../escape', '.', 'a/b', '', 'x' * 65, 'bad\n', 'a.b'):
            changed = copy.deepcopy(self.request)
            changed['run_id'] = run_id
            variants.append(changed)
        for key in ('app', 'command', 'service', 'authorized'):
            changed = copy.deepcopy(self.request)
            changed[key] = True
            variants.append(changed)
        changed = copy.deepcopy(self.request)
        changed['schema'] = True
        variants.append(changed)
        changed = copy.deepcopy(self.request)
        changed['payloads']['../anything'] = ''
        variants.append(changed)
        for changed in variants:
            self.assertEqual('failed', self.run_request(changed)['status'])
        self.assertEqual([], self.fs.mutations)

    def test_every_preimage_and_new_file_absence_checked(self):
        for path in T.TARGETS:
            fs = MemoryFS()
            if path == T.NEW_TARGET:
                fs.files[path] = (b'EXISTS = True\n', 0o644, 0, 0)
            else:
                fs.files[path] = (b'changed', 0o644, 0, 0)
            result = T.execute_request(self.request, lambda: fs, inactive)
            self.assertEqual('failed', result['status'])
            self.assertEqual([], fs.mutations)

    def test_new_file_hash_must_be_null(self):
        self.request['expected_sha256'][T.NEW_TARGET] = '0' * 64
        self.assertEqual('failed', self.run_request()['status'])
        self.assertEqual([], self.fs.mutations)

    def test_all_sources_compile_before_backup_creation(self):
        self.request['payloads'][T.PY_TARGETS[-1]] = base64.b64encode(b'def broken(:').decode('ascii')
        result = self.run_request()
        self.assertEqual('failed', result['status'])
        self.assertEqual([], self.fs.mutations)
        self.assertEqual(self.original, self.fs.files)

    def test_compilable_unapproved_source_is_rejected(self):
        self.request['payloads'][T.PY_TARGETS[0]] = base64.b64encode(b'VALUE = 42\n').decode('ascii')
        result = self.run_request()
        self.assertEqual('failed', result['status'])
        self.assertIn('approved v2', result['error'])
        self.assertEqual([], self.fs.mutations)

    def test_mutable_current_source_cannot_broaden_the_original_approved_payload(self):
        path = 'vision_app/board_agent.py'
        with open(os.path.join(PROJECT, 'engineering/fz3b/source/PS', path), 'rb') as stream:
            current = stream.read()
        # Exact approved bytes are not an invalid payload; retain an unapproved
        # candidate even if a future source checkout intentionally restores v2.
        candidate = current if T.digest(current) != T.APPROVED_SOURCE_SHA256[path] else current + b'\n# unapproved fixture\n'
        self.request['payloads'][path] = base64.b64encode(candidate).decode('ascii')
        result = self.run_request()
        self.assertEqual('failed', result['status'])
        self.assertIn('approved v2', result['error'])
        self.assertEqual([], self.fs.mutations)
        self.assertEqual(self.original, self.fs.files)

    def test_payload_limits_base64_and_nul_rejected(self):
        for value in ('###', base64.b64encode(b'x\x00').decode('ascii'),
                      base64.b64encode(b'x' * (T.MAX_SOURCE + 1)).decode('ascii'), ''):
            self.request['payloads'][T.PY_TARGETS[0]] = value
            self.assertEqual('failed', self.run_request()['status'])
        self.assertEqual([], self.fs.mutations)

    def test_config_invalid_json_duplicate_depth_nan_and_object_only(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e999}', b'[]',
                    ('{"x":' + '[' * 30 + '0' + ']' * 30 + '}').encode('ascii')):
            self.fs.files['config.json'] = (raw, 0o644, 0, 0)
            self.request = request_for(self.fs)
            self.assertEqual('failed', self.run_request()['status'])
            self.assertEqual([], self.fs.mutations)

    def test_run_id_never_overwrites_existing_backup(self):
        self.fs.runs[self.request['run_id']] = {'sentinel': b'unchanged'}
        result = self.run_request()
        self.assertEqual('failed', result['status'])
        self.assertEqual({'sentinel': b'unchanged'}, self.fs.runs[self.request['run_id']])
        self.assertEqual(self.original, self.fs.files)

    def test_replace_failure_before_rename_restores_previous_files(self):
        def fault(fs, path, artifact, phase):
            if fs.replace_calls == 4 and phase == 'before':
                raise OSError('rename failed')
        self.fs.fault = fault
        result = self.run_request()
        self.assertEqual('failed', result['status'], result)
        self.assertTrue(all(item['restored'] for item in result['rollback']))
        self.assertEqual(self.original, self.fs.files)
        self.assertTrue(any('.displaced.' in name for name in self.fs.artifacts))

    def test_fsync_failure_after_rename_is_observed_and_restored(self):
        def fault(fs, path, artifact, phase):
            if fs.replace_calls == 3 and phase == 'after':
                raise OSError('fsync failed after successful rename')
        self.fs.fault = fault
        result = self.run_request()
        self.assertEqual('failed', result['status'], result)
        self.assertEqual(self.original, self.fs.files)

    def test_partial_restore_failure_reports_unknown_and_can_retry(self):
        def fault(fs, path, artifact, phase):
            if phase == 'before' and fs.replace_calls in (4, 5):
                raise OSError('replace and restore fault')
        self.fs.fault = fault
        result = self.run_request()
        self.assertEqual('unknown', result['status'], result)
        self.assertTrue(result['persistent_lock_retained'])
        self.fs.fault = None
        retried = self.run_request(self.rollback_request(result))
        self.assertEqual('rolled_back', retried['status'], retried)
        self.assertEqual(self.original, self.fs.files)

    def test_unexpected_concurrent_target_never_overwritten(self):
        def fault(fs, path, artifact, phase):
            if fs.replace_calls == 2 and phase == 'after':
                fs.files[T.PY_TARGETS[0]] = (b'FOREIGN = True\n', 0o644, 0, 0)
                raise OSError('unexpected change')
        self.fs.fault = fault
        result = self.run_request()
        self.assertEqual('unknown', result['status'])
        self.assertEqual(b'FOREIGN = True\n', self.fs.files[T.PY_TARGETS[0]][0])
        self.assertIn(T.PY_TARGETS[0], result['uncertain_targets'])

    def test_prepared_B_cannot_undo_A_commit_before_B_acquires_lease(self):
        original_acquire = self.fs.acquire_lock
        committed_by_A = {}
        def other_run_commits_then_B_takes_lease(seal, recover=False):
            replacements = T.checked_payloads(self.request)
            config = json.loads(self.original['config.json'][0].decode('ascii'))
            config['bind'] = '127.0.0.1'
            replacements['config.json'] = T.json_bytes(config)
            for path, raw in replacements.items():
                self.fs.files[path] = (raw, 0o644, 0, 0)
            committed_by_A.update(copy.deepcopy(self.fs.files))
            original_acquire(seal, recover)
        self.fs.acquire_lock = other_run_commits_then_B_takes_lease
        result = self.run_request()
        self.assertEqual('unknown', result['status'], result)
        self.assertEqual(committed_by_A, self.fs.files)
        self.assertEqual([], self.fs.mutations)
        self.assertEqual([], result['rollback'])
        self.assertTrue(result['persistent_lock_retained'])

    def test_unattempted_same_new_content_during_staging_is_never_rolled_back(self):
        original_write = self.fs.write_artifact
        foreign = T.checked_payloads(self.request)[T.PY_TARGETS[-1]]
        def stage_and_inject(name, data, mode=0o600, uid=0, gid=0):
            original_write(name, data, mode, uid, gid)
            if name == 'manifest.json':
                self.fs.files[T.PY_TARGETS[-1]] = (foreign, 0o644, 0, 0)
        self.fs.write_artifact = stage_and_inject
        result = self.run_request()
        self.assertEqual('unknown', result['status'])
        self.assertEqual(foreign, self.fs.files[T.PY_TARGETS[-1]][0])
        self.assertEqual([], result['rollback'])
        self.assertFalse(any(item[0] == 'replace' for item in self.fs.mutations))

    def test_service_becomes_active_after_replace_reports_unknown(self):
        def reader():
            return inactive() if self.fs.replace_calls == 0 else {'ActiveState': 'active', 'MainPID': '12'}
        result = self.run_request(reader=reader)
        self.assertEqual('unknown', result['status'], result)
        self.assertFalse(result['service_lifecycle_changed'])

    def test_final_all_target_verification_catches_late_tamper(self):
        # The final service callback simulates a target change after its own post-write check.
        def reader():
            if self.fs.replace_calls == 6:
                self.fs.files[T.PY_TARGETS[0]] = (b'LATE = True\n', 0o644, 0, 0)
            return inactive()
        result = self.run_request(reader=reader)
        self.assertNotEqual('deployed', result['status'], result)

    def test_manual_rollback_preserves_backup_and_new_file_content(self):
        deployed = self.deployed()
        manifest_before = self.fs.artifacts['manifest.json']
        image = self.fs.files[T.NEW_TARGET][0]
        result = self.run_request(self.rollback_request(deployed))
        self.assertEqual('rolled_back', result['status'], result)
        self.assertEqual(self.original, self.fs.files)
        self.assertEqual(manifest_before, self.fs.artifacts['manifest.json'])
        self.assertTrue(any(value[0] == image and '.displaced.' in key for key, value in self.fs.artifacts.items()))
        self.assertFalse(any(item[0] == 'delete' for item in self.fs.mutations))

    def test_rollback_full_preflight_refuses_any_live_or_backup_tamper(self):
        for kind in ('live', 'backup', 'manifest', 'manifest_sealed_bad_path'):
            self.setUp()
            deployed = self.deployed()
            request = self.rollback_request(deployed)
            if kind == 'live':
                self.fs.files[T.TARGETS[-1]] = (b'foreign', 0o644, 0, 0)
            elif kind == 'backup':
                self.fs.artifacts['0.original'] = (b'foreign', 0o600, 0, 0)
            elif kind == 'manifest':
                self.fs.artifacts['manifest.json'] = (b'{}', 0o600, 0, 0)
            else:
                bad = copy.deepcopy(deployed['manifest'])
                bad['entries'][0]['backup'] = '../outside'
                raw = T.json_bytes(bad)
                self.fs.artifacts['manifest.json'] = (raw, 0o600, 0, 0)
                request['manifest_sha256'] = T.digest(raw)
            mutations = len(self.fs.mutations)
            self.assertIn(self.run_request(request)['status'], ('failed', 'unknown'))
            self.assertEqual(mutations, len(self.fs.mutations))

    def test_backup_stage_and_close_failures_cannot_report_success(self):
        self.fs.write_artifact = mock.Mock(side_effect=OSError('disk full'))
        self.assertEqual('failed', self.run_request()['status'])
        self.assertEqual(self.original, self.fs.files)
        self.setUp()
        self.fs.close = mock.Mock(side_effect=OSError('close failed'))
        self.assertEqual('unknown', self.run_request()['status'])

    def test_python36_grammar_and_emit_has_only_embedded_fixed_request(self):
        with open(T.__file__, 'r', encoding='utf-8') as stream:
            source = stream.read()
        ast.parse(source, feature_version=(3, 6))
        output_root = os.path.join(PROJECT, 'output', 'hardware', '2026-10-16-continuation')
        with tempfile.TemporaryDirectory(prefix='transaction-fixture-', dir=output_root) as directory:
            request_path = os.path.join(directory, 'request.json')
            payload_path = os.path.join(directory, 'payload.py')
            with open(request_path, 'wb') as stream:
                stream.write(T.json_bytes(self.request))
            metadata = T.emit_payload(request_path, payload_path, APPROVED_MANIFEST)
            with open(payload_path, 'rb') as stream:
                payload = stream.read()
            ast.parse(payload, feature_version=(3, 6))
            self.assertEqual(T.digest(payload), metadata['payload_sha256'])
            self.assertIn(b'RESULT = execute_request(REQUEST)', payload)
            self.assertFalse(metadata['executed'])
            with self.assertRaises(FileExistsError):
                T.emit_payload(request_path, payload_path, APPROVED_MANIFEST)

    def test_persistent_unknown_lease_denies_other_run_and_wrong_rollback_manifest(self):
        def fault(fs, path, artifact, phase):
            if phase == 'before' and fs.replace_calls in (4, 5):
                raise OSError('unknown fixture')
        self.fs.fault = fault
        result = self.run_request()
        self.assertEqual('unknown', result['status'])
        lease = copy.deepcopy(self.fs.lease)
        different = request_for(self.fs)
        different['run_id'] = 'different-run'
        # Preserve the absence precondition and original expected hashes for this check.
        different['expected_sha256'] = copy.deepcopy(self.request['expected_sha256'])
        self.assertNotEqual('deployed', self.run_request(different)['status'])
        self.assertEqual(lease, self.fs.lease)
        wrong = self.rollback_request(result)
        wrong['manifest_sha256'] = '0' * 64
        self.assertNotEqual('rolled_back', self.run_request(wrong)['status'])
        self.assertEqual(lease, self.fs.lease)
        self.fs.fault = None
        self.assertEqual('rolled_back', self.run_request(self.rollback_request(result))['status'])
        self.assertIsNone(self.fs.lease)

    def test_active_same_run_cannot_be_taken_over_by_rollback(self):
        result = self.deployed()
        seal = {'schema': 1, 'run_id': self.request['run_id'], 'manifest_sha256': result['manifest_sha256']}
        self.fs.lease, self.fs.lease_active = seal, True
        self.assertNotEqual('rolled_back', self.run_request(self.rollback_request(result))['status'])
        self.assertEqual(seal, self.fs.lease)

    def test_lost_connection_old_lease_denies_deploy_even_when_all_old_files_match(self):
        self.fs.lease = {'schema': 1, 'run_id': 'old-run', 'manifest_sha256': '1' * 64}
        self.fs.lease_active = False
        result = self.run_request()
        self.assertEqual('failed', result['status'])
        self.assertEqual([], self.fs.mutations)
        self.assertEqual('old-run', self.fs.lease['run_id'])

    def test_release_failure_is_unknown_not_success(self):
        self.fs.release_lock = mock.Mock(side_effect=OSError('cannot release durable lock'))
        result = self.run_request()
        self.assertEqual('unknown', result['status'])
        self.assertTrue(result['persistent_lock_retained'])

    def test_generator_rejects_wrong_approved_manifest(self):
        with mock.patch('builtins.open', mock.mock_open(read_data=T.json_bytes(self.request))):
            with self.assertRaisesRegex(ValueError, 'manifest byte seal'):
                T.emit_payload('request.json', 'never-written.py', 'wrong-manifest.json')


class LinuxPrimitiveContractTests(unittest.TestCase):
    @staticmethod
    def file_stat(mode=0o600):
        return types.SimpleNamespace(st_mode=stat.S_IFREG | mode, st_nlink=1, st_uid=0, st_gid=0,
                                     st_size=0, st_dev=1, st_ino=2, st_mtime_ns=3, st_ctime_ns=4)

    def test_regular_file_gate_rejects_symlink_hardlink_special_permissions_and_size(self):
        valid = dict(st_mode=stat.S_IFREG | 0o644, st_nlink=1, st_uid=0, st_size=10)
        T.SecureFS._regular(types.SimpleNamespace(**valid), 10)
        for changes in ({'st_mode': stat.S_IFLNK | 0o777}, {'st_mode': stat.S_IFIFO | 0o600},
                        {'st_nlink': 2}, {'st_uid': 1000}, {'st_size': 11},
                        {'st_mode': stat.S_IFREG | 0o664}, {'st_mode': stat.S_IFREG | 0o4644}):
            changed = dict(valid)
            changed.update(changes)
            with self.assertRaises(RuntimeError):
                T.SecureFS._regular(types.SimpleNamespace(**changed), 10)

    def test_directory_open_uses_nofollow_and_dirfd(self):
        fs = object.__new__(T.SecureFS)
        fs.fds = []
        value = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with mock.patch.object(T.os, 'O_NOFOLLOW', 0x20000, create=True), \
                mock.patch.object(T.os, 'O_DIRECTORY', 0x10000, create=True), \
                mock.patch.object(T.os, 'open', return_value=123) as opened, \
                mock.patch.object(T.os, 'fstat', return_value=value):
            self.assertEqual(123, fs._directory('fixed', 41))
            opened.assert_called_once_with('fixed', T.os.O_RDONLY | 0x10000 | 0x20000, dir_fd=41)

    def test_lock_creation_is_exclusive_nofollow_and_nonblocking_flock(self):
        fs = object.__new__(T.SecureFS)
        fs.appfd, fs.fds, fs.lockfd = 7, [], None
        fs.lock_retained, fs.lock_uncertain = False, False
        fs.assert_anchors = mock.Mock()
        fake_fcntl = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=mock.Mock())
        value = self.file_stat()
        seal = {'schema': 1, 'run_id': 'run1', 'manifest_sha256': '0' * 64}
        with mock.patch.dict('sys.modules', {'fcntl': fake_fcntl}), \
                mock.patch.object(T.os, 'O_NOFOLLOW', 0x20000, create=True), \
                mock.patch.object(T.os, 'open', return_value=123) as opened, \
                mock.patch.object(T.os, 'fstat', return_value=value), \
                mock.patch.object(T.os, 'stat', return_value=value), \
                mock.patch.object(T.os, 'write', side_effect=lambda fd, data: len(data)), \
                mock.patch.object(T.os, 'fsync'):
            fs.acquire_lock(seal)
        opened.assert_called_once_with(T.LOCK_NAME, T.os.O_RDWR | T.os.O_CREAT | T.os.O_EXCL | 0x20000,
                                       0o600, dir_fd=7)
        fake_fcntl.flock.assert_called_once_with(123, 6)
        self.assertTrue(fs.lock_retained)

    def test_lock_unlink_fsync_failure_reports_actual_absence_and_uncertainty(self):
        fs = object.__new__(T.SecureFS)
        fs.appfd, fs.lockfd, fs.lock_retained, fs.lock_uncertain = 7, 123, True, False
        fs.assert_anchors = mock.Mock()
        seal = {'schema': 1, 'run_id': 'run1', 'manifest_sha256': '0' * 64}
        fs._read = mock.Mock(return_value=(T.json_bytes(seal), 0o600, 0, 0))
        fs.acquire_lock = mock.Mock(side_effect=OSError('cannot recreate lease'))
        value = self.file_stat()
        with mock.patch.object(T.os, 'stat', return_value=value), \
                mock.patch.object(T.os, 'fstat', return_value=value), \
                mock.patch.object(T.os, 'unlink') as unlink, \
                mock.patch.object(T.os, 'fsync', side_effect=OSError('directory fsync failed')):
            with self.assertRaises(OSError):
                fs.release_lock(seal)
        unlink.assert_called_once_with(T.LOCK_NAME, dir_fd=7)
        fs.acquire_lock.assert_called_once_with(seal)
        self.assertFalse(fs.lock_retained)
        self.assertTrue(fs.lock_uncertain)

    def test_file_read_opens_nofollow_nonblock_and_rejects_special_before_read(self):
        fs = object.__new__(T.SecureFS)
        fs.assert_anchors = mock.Mock()
        value = self.file_stat()
        value.st_mode = stat.S_IFIFO | 0o600
        with mock.patch.object(T.os, 'O_NOFOLLOW', 0x20000, create=True), \
                mock.patch.object(T.os, 'O_NONBLOCK', 0x800, create=True), \
                mock.patch.object(T.os, 'open', return_value=123) as opened, \
                mock.patch.object(T.os, 'fstat', return_value=value), \
                mock.patch.object(T.os, 'read') as read, \
                mock.patch.object(T.os, 'close') as close:
            with self.assertRaises(RuntimeError):
                fs._read(7, 'camera.py', 100)
        opened.assert_called_once_with('camera.py', T.os.O_RDONLY | 0x20000 | 0x800, dir_fd=7)
        read.assert_not_called()
        close.assert_called_once_with(123)

    def test_rollback_open_never_creates_backup_parent(self):
        fs = object.__new__(T.SecureFS)
        fs.appfd, fs.chain, fs.fds = 7, [], []
        fs.assert_anchors = mock.Mock()
        fs._directory = mock.Mock(side_effect=FileNotFoundError('missing'))
        with mock.patch.object(T.os, 'mkdir') as mkdir:
            with self.assertRaises(FileNotFoundError):
                fs.open_run('run1', False)
            mkdir.assert_not_called()

    def test_target_mapping_is_closed(self):
        fs = object.__new__(T.SecureFS)
        fs.appfd, fs.visionfd = 7, 8
        self.assertEqual((7, 'config.json'), fs._target('config.json'))
        self.assertEqual((8, 'camera.py'), fs._target('vision_app/camera.py'))
        for path in ('../config.json', '/root/config.json', 'vision_app/../camera.py', 'run.sh'):
            with self.assertRaises(ValueError):
                fs._target(path)

    def test_service_command_is_fixed_read_only_and_bounded_timeout(self):
        result = types.SimpleNamespace(returncode=0, stderr=b'', stdout=(
            'Id=' + T.UNIT + '\nLoadState=loaded\nActiveState=inactive\nMainPID=0\n').encode('ascii'))
        with mock.patch.object(T.subprocess, 'run', return_value=result) as run:
            T.require_inactive(T.read_service_state)
            args, kwargs = run.call_args
            self.assertEqual(['/bin/systemctl', 'show', T.UNIT, '--no-pager',
                              '--property=Id,LoadState,ActiveState,MainPID'], args[0])
            self.assertEqual(10, kwargs['timeout'])
        for stdout in (b'MainPID=0\n', result.stdout + b'MainPID=0\n',
                       result.stdout.replace(b'LoadState=loaded', b'LoadState=not-found')):
            result.stdout = stdout
            with mock.patch.object(T.subprocess, 'run', return_value=result):
                with self.assertRaises((ValueError, RuntimeError)):
                    T.read_service_state()


if __name__ == '__main__':
    unittest.main(verbosity=2)
