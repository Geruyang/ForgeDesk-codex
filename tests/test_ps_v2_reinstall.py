"""Pure memory / syscall fixtures; never invokes a service, SSH or device."""
import ast
import base64
import copy
import errno
import importlib.util
import io
import os
import stat
import types
import unittest
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SOURCE = os.path.join(ROOT, 'engineering/fz3b/tools/ps_v2_reinstall.py')
SPEC = importlib.util.spec_from_file_location('ps_v2_reinstall_under_test', SOURCE)
T = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(T)
RUN = 'ps-v2-reinstall-01234567-89ab-4cde-8fab-0123456789ab'


def clean_gate():
    return {'boot_id': T.BOOT, 'service': {'activeState': 'inactive', 'mainPid': 0},
            'dependencies': {'loader': {'activeState': 'active', 'mainPid': 123}},
            'scan': {'deviceOpened': False, 'a0005Owners': [], 'active8765': [], 'listeners8765': []},
            'processAudit': {'completePass': True, 'selfExcluded': {'pid': 42, 'startTicks': 123},
                             'stdinInspectors': [], 'newPidsAtEnd': []}}


class ProductLease(object):
    def __init__(self):
        self.held = False
        self.closed = False
        self.reads = 0
        self.fail_at = None

    def __enter__(self):
        self.held = True
        return self

    def recheck(self):
        if not self.held:
            raise RuntimeError('product lease is not held')
        self.reads += 1
        if self.reads == self.fail_at:
            raise RuntimeError('product journal changed')
        return {'journalCount': 1, 'journalHashes': {'af51470d-b545-4fde-ae78-69bf13a61fd7.json': 'a' * 64},
                'profileSha256': '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd',
                'fixedOperationId': 'af51470d-b545-4fde-ae78-69bf13a61fd7', 'productLeaseHeldReadOnly': True, 'unknownCleared': False}

    def close(self):
        self.held = False
        self.closed = True


class MemoryFS(object):
    def __init__(self, files):
        self.files = {}
        self.artifacts = {}
        self.runs = set()
        self.lock_retained = False
        self.lock_uncertain = False
        self.lease = None
        self.closed = False
        self.attempts = []
        self.failure = None
        self.next_inode = 1000
        self.product = None
        for index, (key, raw) in enumerate(files.items()):
            mode = 0o600 if key == 'config.json' else 0o644
            self.files[key] = ((raw, mode, 0, 0), self.identity(raw, 100 + index, mode))

    @staticmethod
    def identity(raw, inode, mode):
        return {'dev': 1, 'ino': inode, 'bytes': len(raw), 'mode': mode, 'uid': 0, 'gid': 0, 'nlink': 1,
                'mtime_ns': '1792154386501571393', 'ctime_ns': '1792154386501571393'}

    def snapshot(self, key):
        if key not in self.files:
            raise FileNotFoundError(key)
        return copy.deepcopy(self.files[key])

    def assert_fresh_run(self, run):
        if run in self.runs:
            raise RuntimeError('run already exists')

    def assert_product_root(self, product):
        if not product.held:
            raise RuntimeError('product must be held before PS filesystem')
        self.product = product

    def acquire_lock(self, seal):
        if not self.product.held:
            raise RuntimeError('wrong lock order')
        if self.lease is not None:
            raise RuntimeError('foreign lease exists')
        self.lease = copy.deepcopy(seal)
        self.lock_retained = True

    def release_lock(self, seal):
        if self.failure == 'release':
            self.lock_uncertain = True
            raise RuntimeError('release directory fsync failed')
        if self.lease != seal:
            raise RuntimeError('wrong lease')
        self.lease = None
        self.lock_retained = False

    def open_run(self, run, create):
        self.assert_fresh_run(run)
        if create is not True:
            raise RuntimeError('cannot reuse run')
        self.runs.add(run)

    def write_artifact(self, name, raw, mode=0o600, uid=0, gid=0):
        if name in self.artifacts:
            raise FileExistsError(name)
        if self.failure == name:
            raise RuntimeError('artifact write failed')
        self.next_inode += 1
        self.artifacts[name] = ((raw, mode, uid, gid), self.identity(raw, self.next_inode, mode))

    def read_artifact(self, name, limit=T.LEGACY.MAX_SOURCE):
        value = self.artifacts[name][0][0]
        if len(value) > limit:
            raise RuntimeError('budget')
        return value

    def artifact_identity(self, name):
        return copy.deepcopy(self.artifacts[name][1])

    def replace(self, key, name):
        self.attempts.append(key)
        if self.failure == 'before-rename':
            raise RuntimeError('rename unconfirmed')
        if self.failure != 'no-op':
            self.files[key] = self.artifacts.pop(name)
        if self.failure == 'after-rename':
            raise RuntimeError('rename succeeded then directory fsync failed')

    def close(self):
        if self.product is not None and not self.product.held:
            raise RuntimeError('product lease must outlive PS fd close')
        self.closed = True
        if self.failure == 'close':
            raise RuntimeError('fd close failed')


class ReinstallTests(unittest.TestCase):
    def setUp(self):
        self.payloads = {}
        for key in T.LEGACY.PY_TARGETS:
            with open(os.path.join(ROOT, T.SOURCE_ROOT, key), 'rb') as stream:
                self.payloads[key] = stream.read()
        # No real board config is read. This deliberate memory fixture has its own pin.
        config = b'{"bind":"127.0.0.1","fixture":"retained bytes and spacing"}\n'
        self.pin_patch = mock.patch.dict(T.SOURCE_PINS, {'config.json': (len(config), T.sha(config))})
        self.pin_patch.start()
        self.addCleanup(self.pin_patch.stop)
        files = dict(self.payloads)
        files['config.json'] = config
        self.fs = MemoryFS(files)
        self.request = {'schema': 1, 'mode': 'reinstall-v2', 'run_id': RUN, 'boot_id': T.BOOT,
                        'approved_manifest_sha256': T.APPROVED_MANIFEST_SHA,
                        'expected_sha256': dict((key, value[1]) for key, value in T.SOURCE_PINS.items()),
                        'payloads': dict((key, base64.b64encode(raw).decode('ascii')) for key, raw in self.payloads.items())}
        self.product = ProductLease()

    def execute(self, gate=clean_gate):
        return T.execute_request(self.request, lambda: self.fs, gate, lambda: self.product)

    def test_six_real_replacements_and_six_original_backups_preserve_config_bytes(self):
        old = copy.deepcopy(self.fs.files)
        result = self.execute()
        self.assertEqual('reinstalled-v2', result['status'], result)
        self.assertEqual(6, result['attemptedTargetCount'])
        self.assertEqual(6, result['replacedTargetCount'])
        self.assertEqual(list(T.TARGETS), self.fs.attempts)
        self.assertEqual(6, len([key for key in self.fs.artifacts if key.endswith('.original')]))
        for index, key in enumerate(T.TARGETS):
            self.assertEqual(old[key][0][0], self.fs.read_artifact(str(index) + '.original'))
            self.assertEqual(old[key][0][0], self.fs.files[key][0][0])
            self.assertNotEqual(old[key][1]['ino'], self.fs.files[key][1]['ino'])
        self.assertFalse(self.fs.lock_retained)
        self.assertFalse(result['automatic_rollback'])
        self.assertTrue(result['productLeaseClosed'])
        self.assertEqual(9, self.product.reads)
        self.assertEqual(9, len(result['productGateChecks']))

    def test_missing_image_boundary_is_not_first_deploy_and_never_gets_a_lease(self):
        del self.fs.files['vision_app/image_boundary.py']
        result = self.execute()
        self.assertEqual('failed', result['status'])
        self.assertIsNone(self.fs.lease)
        self.assertEqual([], self.fs.attempts)

    def test_wrong_live_hash_mode_owner_and_link_metadata_are_rejected_before_mutation(self):
        key = T.TARGETS[0]
        for mutation in ('hash', 'mode', 'owner', 'nlink'):
            old = copy.deepcopy(self.fs.files[key])
            value, identity = copy.deepcopy(old)
            if mutation == 'hash':
                value = (value[0] + b'\n',) + value[1:]
            elif mutation == 'mode':
                value = (value[0], 0o666, 0, 0)
            elif mutation == 'owner':
                value = (value[0], value[1], 1, 0)
            else:
                identity['nlink'] = 2
            self.fs.files[key] = (value, identity)
            self.assertEqual('failed', self.execute()['status'])
            self.assertIsNone(self.fs.lease)
            self.fs.files[key] = old

    def test_wrong_request_hash_extra_path_payload_and_mode_fail_closed(self):
        for change in ('old', 'absent', 'extra', 'payload', 'mode', 'boot'):
            request = copy.deepcopy(self.request)
            if change == 'old': request['expected_sha256'][T.TARGETS[0]] = '0' * 64
            elif change == 'absent': request['expected_sha256']['vision_app/image_boundary.py'] = None
            elif change == 'extra': request['payloads']['../../driver.py'] = 'eA=='
            elif change == 'payload': request['payloads'][T.TARGETS[0]] = base64.b64encode(b'changed=True\n').decode('ascii')
            elif change == 'mode': request['mode'] = 'rollback'
            else: request['boot_id'] = 'different'
            self.assertEqual('failed', T.execute_request(request, lambda: self.fs, clean_gate, ProductLease)['status'])
            self.assertEqual([], self.fs.attempts)

    def test_existing_run_or_foreign_lease_is_not_overwritten(self):
        self.fs.runs.add(RUN)
        self.assertEqual('failed', self.execute()['status'])
        self.assertIsNone(self.fs.lease)
        self.fs.runs.clear()
        self.fs.lease = {'foreign': True}
        self.assertEqual('failed', self.execute()['status'])
        self.assertEqual({'foreign': True}, self.fs.lease)

    def test_active_safety_gate_blocks_before_filesystem_factory(self):
        factory = mock.Mock(side_effect=AssertionError('filesystem must not be opened'))
        def active(): raise RuntimeError('A0005 device owned')
        result = T.execute_request(self.request, factory, active, ProductLease)
        self.assertEqual('failed', result['status'])
        factory.assert_not_called()

    def test_real_safety_gate_checks_device_owners_tcp_boot_and_inactive_without_action(self):
        service = {'activeState': 'inactive', 'subState': 'dead', 'mainPid': 0}
        access = mock.Mock()
        access.read.side_effect = lambda path: T.BOOT.encode('ascii') if path == T.LIFECYCLE.BOOT_PATH else b'fixture'
        access.scan.return_value = {'deviceOpened': False, 'a0005Owners': [{'pid': 42}], 'listeners8765': [], 'active8765': []}
        with mock.patch.object(T.LIFECYCLE, 'SystemAccess', return_value=access), mock.patch.object(T, 'sha', side_effect=[T.LIFECYCLE.UNIT_SHA256, T.LIFECYCLE.CONTRACT_SHA256]), \
                mock.patch.object(T.LIFECYCLE, 'checked_service', return_value=service), mock.patch.object(T.LIFECYCLE, 'dependencies', return_value={}):
            with self.assertRaisesRegex(RuntimeError, 'not quiescent'): T.safety_gate()
        access.action.assert_not_called()
        access.status.assert_not_called()

    def test_any_exception_after_lease_keeps_unknown_without_automatic_restore(self):
        for failure in ('0.original', '2.staged', 'manifest.json', 'before-rename', 'after-rename', 'no-op', 'release'):
            fs = copy.deepcopy(self.fs)
            fs.failure = failure
            result = T.execute_request(self.request, lambda: fs, clean_gate, ProductLease)
            self.assertEqual('unknown', result['status'], (failure, result))
            self.assertTrue(result['persistent_lock_retained'])
            self.assertFalse(result['automatic_rollback'])
            self.assertNotEqual('reinstalled-v2', result['status'])

    def test_lost_quiescence_after_first_replace_keeps_partial_unknown(self):
        calls = [0]
        def gate():
            calls[0] += 1
            if calls[0] == 4: raise RuntimeError('new active TCP connection')
            return clean_gate()
        result = self.execute(gate)
        self.assertEqual('unknown', result['status'])
        self.assertEqual(1, result['attemptedTargetCount'])
        self.assertEqual(1, result['replacedTargetCount'])
        self.assertTrue(self.fs.lock_retained)

    def test_changed_dependency_or_census_self_during_commit_is_unknown(self):
        for changed in ('dependency', 'self'):
            fs = copy.deepcopy(self.fs)
            calls = [0]
            def gate():
                calls[0] += 1
                value = clean_gate()
                if calls[0] == 4:
                    if changed == 'dependency': value['dependencies']['loader']['mainPid'] = 999
                    else: value['processAudit']['selfExcluded']['startTicks'] = 999
                return value
            result = T.execute_request(self.request, lambda: fs, gate, ProductLease)
            self.assertEqual('unknown', result['status'])
            self.assertEqual(1, result['replacedTargetCount'])
            self.assertTrue(result['persistent_lock_retained'])

    def test_preimage_inode_change_under_lease_is_not_excused_by_same_hash(self):
        calls = [0]
        def gate():
            calls[0] += 1
            if calls[0] == 2: self.fs.files[T.TARGETS[0]][1]['ino'] += 99
            return clean_gate()
        result = self.execute(gate)
        self.assertEqual('unknown', result['status'])
        self.assertEqual([], self.fs.attempts)

    def test_product_journal_drift_during_commit_is_unknown_and_never_clears_product_state(self):
        self.product.fail_at = 4
        result = self.execute()
        self.assertEqual('unknown', result['status'])
        self.assertEqual(1, result['attemptedTargetCount'])
        self.assertTrue(result['persistent_lock_retained'])
        self.assertFalse(result['productLockFileModified'])
        self.assertTrue(self.product.closed)

    def test_live_product_lease_blocks_before_ps_filesystem_or_global_lease(self):
        busy = mock.Mock()
        busy.__enter__ = mock.Mock(side_effect=RuntimeError('product lease live'))
        factory = mock.Mock(side_effect=AssertionError('PS filesystem must not open'))
        result = T.execute_request(self.request, factory, clean_gate, lambda: busy)
        self.assertEqual('failed', result['status'])
        factory.assert_not_called()
        busy.close.assert_called_once()

    def test_ps_fd_close_failure_does_not_release_product_lease_or_claim_pass(self):
        self.fs.failure = 'close'
        result = self.execute()
        self.assertEqual('unknown', result['status'])
        self.assertFalse(result['productLeaseClosed'])
        self.assertTrue(self.product.held)
        self.assertFalse(self.product.closed)

    def test_production_secure_fs_opens_target_with_nofollow_and_does_not_follow_link(self):
        fs = T.ReinstallFS.__new__(T.ReinstallFS)
        fs.chain = []
        fs.visionfd = 2
        fs.appfd = 1
        metadata = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        flags = getattr(T.os, 'O_NOFOLLOW', 0x20000)
        def opened(name, requested, **kwargs):
            self.assertTrue(requested & flags)
            raise OSError(errno.ELOOP, 'nofollow link rejected')
        with mock.patch.object(T.os, 'O_NOFOLLOW', flags, create=True), mock.patch.object(T.os, 'O_NONBLOCK', 0x800, create=True), \
                mock.patch.object(T.os, 'stat', return_value=metadata), mock.patch.object(T.os, 'open', side_effect=opened):
            with self.assertRaises(OSError): fs.snapshot(T.TARGETS[0])

    def test_python36_grammar_and_legacy_global_lease_are_preserved(self):
        with open(SOURCE, 'r', encoding='utf-8') as stream:
            ast.parse(stream.read(), feature_version=(3, 6))
        self.assertTrue(issubclass(T.ReinstallFS, T.LEGACY.SecureFS))
        self.assertEqual('.forgedesk-ps-transaction.lock', T.LEGACY.LOCK_NAME)
        self.assertNotEqual(T.BACKUPS, T.LEGACY.BACKUP_DIR)

    def test_host_emitter_produces_only_fresh_offline_request_plan_and_stdin(self):
        self.pin_patch.stop()
        names = [T.BUNDLE_ROOT + '/manifest.json', T.BUNDLE_ROOT + '/data.tar',
                 'engineering/fz3b/tools/ps_security_transaction.py', 'engineering/fz3b/tools/service_lifecycle.py',
                 'engineering/fz3b/tools/recovery_051_product_gate.py', 'engineering/fz3b/tools/ssh_script_receipt.mjs',
                 T.INSPECTOR_GATE_SOURCE,
                 'engineering/fz3b/tools/ps_v2_reinstall.py'] + [T.SOURCE_ROOT + '/' + key for key in T.LEGACY.PY_TARGETS]
        inputs = {}
        for name in names:
            with open(os.path.join(ROOT, name), 'rb') as stream:
                inputs[name] = stream.read()
        outputs = {}
        class Sink(io.BytesIO):
            def __init__(self, name):
                super(Sink, self).__init__()
                self.name = name
            def fileno(self): return 123
            def __exit__(self, *_):
                outputs[os.path.basename(self.name)] = self.getvalue()
                self.close()
        def host_read(_project, name, limit):
            self.assertLessEqual(len(inputs[name]), limit)
            return inputs[name]
        with mock.patch.object(T, '_host_read', side_effect=host_read), \
                mock.patch.object(T, '_host_plain', side_effect=lambda project, relative: os.path.join(project, relative)), \
                mock.patch.object(T.os, 'mkdir') as mkdir, mock.patch.object(T.os, 'fsync'), \
                mock.patch('builtins.open', side_effect=lambda name, mode: Sink(name) if mode == 'xb' else self.fail('unexpected file mode')):
            result = T.prepare_bundle(RUN)
            mkdir.assert_called_once()
        self.assertEqual(False, result['executed'])
        self.assertEqual({'request.json', 'stdin.py', 'plan.json'}, set(outputs))
        self.assertTrue(result['directory'].startswith(T.OUTPUT_ROOT + '/'))
        ast.parse(outputs['stdin.py'].decode('ascii'), feature_version=(3, 6))
        plan = T.LEGACY.load_json(outputs['plan.json'], 65536)
        self.assertEqual(T.sha(outputs['stdin.py']), plan['stdinSha256'])
        self.assertEqual(T.sha(outputs['request.json']), plan['requestSha256'])
        self.assertIn(b'_REINSTALL_PRODUCT_GATE', outputs['stdin.py'])
        self.assertIn(b'_REINSTALL_INSPECTORS', outputs['stdin.py'])
        self.assertNotIn('config.json', T.LEGACY.load_json(outputs['request.json'], T.LEGACY.MAX_REQUEST)['payloads'])
        with mock.patch.object(T, '_host_read') as read:
            with self.assertRaises(ValueError): T.prepare_bundle('reused-ordinary-run')
            read.assert_not_called()

    def test_process_census_subset_is_pinned_and_excludes_other_maintenance_actions(self):
        with open(os.path.join(ROOT, T.INSPECTOR_GATE_SOURCE), 'rb') as stream:
            raw = stream.read()
        source = T.inspector_source(raw)
        ast.parse(source.decode('ascii'), feature_version=(3, 6))
        namespace = {}
        exec(compile(source, '<pure-process-census>', 'exec'), namespace)
        self.assertEqual({'proc_stat', 'classify_prefix', 'ProcAccess', 'scan_inspectors'},
                         set(node.name for node in ast.parse(source).body
                             if isinstance(node, (ast.FunctionDef, ast.ClassDef))) - {'LifecycleError', 'require'})
        self.assertNotIn(b'maintenance_collect', source)
        self.assertNotIn(b'checked_status', source)
        with self.assertRaises(ValueError): T.inspector_source(raw + b'\n')

    def test_host_windows_metadata_ctime_difference_does_not_weaken_stability_checks(self):
        def info(ctime=100, **changed):
            fields = dict(st_dev=1, st_ino=2, st_size=4, st_mtime_ns=3, st_ctime_ns=ctime,
                          st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1)
            fields.update(changed)
            return types.SimpleNamespace(**fields)
        for mutation in (None, 'named-ctime', 'fd-ctime', 'inode', 'mtime', 'mode', 'nlink'):
            named_before, named_after, fd_before, fd_after = info(), info(), info(200), info(200)
            if mutation == 'named-ctime': named_after.st_ctime_ns += 1
            elif mutation == 'fd-ctime': fd_after.st_ctime_ns += 1
            elif mutation == 'inode': fd_before.st_ino = fd_after.st_ino = 999
            elif mutation == 'mtime': fd_before.st_mtime_ns = fd_after.st_mtime_ns = 999
            elif mutation == 'mode': fd_before.st_mode = fd_after.st_mode = stat.S_IFREG | 0o666
            elif mutation == 'nlink': named_before.st_nlink = named_after.st_nlink = 2
            with mock.patch.object(T, '_host_plain', return_value='memory'), mock.patch.object(T.os, 'name', 'nt'), \
                    mock.patch.object(T.os, 'stat', return_value=named_before), mock.patch.object(T.os, 'lstat', return_value=named_after), \
                    mock.patch.object(T.os, 'fstat', side_effect=[fd_before, fd_after]), mock.patch('builtins.open', mock.mock_open(read_data=b'data')):
                if mutation is None: self.assertEqual(b'data', T._host_read('.', 'data', 4))
                else:
                    with self.assertRaises(ValueError): T._host_read('.', 'data', 4)

    def test_actual_safety_gate_rejects_another_stdin_inspector_or_incomplete_census(self):
        access = mock.Mock()
        access.read.side_effect = lambda path: T.BOOT.encode('ascii') if path == T.LIFECYCLE.BOOT_PATH else b'fixture'
        access.scan.return_value = clean_gate()['scan']
        for change in ('candidate', 'incomplete', 'new-pid', 'boolean-self'):
            audit = copy.deepcopy(clean_gate()['processAudit'])
            if change == 'candidate': audit['stdinInspectors'] = [{'pid': 999}]
            elif change == 'incomplete': audit['completePass'] = False
            elif change == 'new-pid': audit['newPidsAtEnd'] = [999]
            else: audit['selfExcluded']['pid'] = True
            inspector = types.SimpleNamespace(scan_inspectors=lambda: audit)
            with mock.patch.object(T.LIFECYCLE, 'SystemAccess', return_value=access), \
                    mock.patch.object(T, 'sha', side_effect=[T.LIFECYCLE.UNIT_SHA256, T.LIFECYCLE.CONTRACT_SHA256]), \
                    mock.patch.object(T.LIFECYCLE, 'checked_service', return_value={'activeState': 'inactive', 'subState': 'dead', 'mainPid': 0}), \
                    mock.patch.object(T.LIFECYCLE, 'dependencies', return_value={}), mock.patch.object(T, 'inspector_module', return_value=inspector):
                with self.assertRaisesRegex(RuntimeError, 'census'): T.safety_gate()
        access.action.assert_not_called()


if __name__ == '__main__':
    unittest.main()
