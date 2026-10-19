"""Pure generated-payload/product-gate tests: no SSH, application or device."""
import ast
import copy
import errno
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
ACTIVE = False
BLOCKED = []


def audit(event, _args):
    if ACTIVE and (event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system'):
        BLOCKED.append(event)
        raise RuntimeError('Offline completed-stop tests forbid network/process execution')


sys.addaudithook(audit)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setUpModule():
    global ACTIVE, builder, gate, old_fixture, payloads, namespaces, accepted
    ACTIVE = True
    builder = load('completed_051_builder', ROOT / 'engineering/fz3b/tools/recovery_051_completed_stop.py')
    gate = load('completed_051_product_gate', builder.GATE)
    old_fixture = load('completed_051_legacy_fixtures', ROOT / 'tests/test_service_lifecycle.py')
    inputs = [builder.BASE.read_bytes(), builder.OLD.read_bytes(), builder.GATE.read_bytes(), Path(builder.__file__).read_bytes(), builder.SOURCE.read_bytes(), builder.PROC.read_bytes()]
    payloads, _ = builder.build_payloads(*inputs)
    namespaces = {}
    for mode, raw in payloads.items():
        ns = {'__name__': 'offline_' + mode.replace('-', '_')}
        exec(compile(raw, '<offline-' + mode + '>', 'exec'), ns)
        namespaces[mode] = ns
    accepted = json.loads(inputs[4].decode('utf-8'))


def tearDownModule():
    global ACTIVE
    ACTIVE = False


def exact_status(ns):
    return dict(type='status', protocol=1, platform='A0005', contract_id=ns['CONTRACT_ID'], boot_id=builder.RECOVERY_BOOT,
                inference=dict(state='STOPPED', error=None, frames=1, max_in_flight=4), query_revision=3, threshold=.2,
                result_delivery_drops=0, cpu_frequency_changing=False, input_source='upload',
                upload=dict(job_id=builder.RECOVERY_JOB, received=1, completed=1, queued=0, finished=True, cancelled=False, error=None))


class FakeLease:
    app_fd = 999

    def __init__(self):
        self.held, self.closed, self.unknown = False, False, False
        self.calls = 0

    def __enter__(self):
        self.held = True
        return self

    def recheck(self):
        assert self.held
        self.calls += 1
        if self.unknown:
            raise namespaces['normal-stop']['ProductGateError']('fixture-product-unknown')
        return {'journalCount': 1, 'journalHashes': {gate.FIXED_OPERATION + '.json': 'a' * 64},
                'fixedOperationId': gate.FIXED_OPERATION, 'profileSha256': gate.FIXED_PROFILE,
                'productLeaseHeldReadOnly': True, 'unknownCleared': False}

    def __exit__(self, *_):
        self.held, self.closed = False, True


def access_fixture(ns, lease):
    class Access(old_fixture.FixtureAccess):
        def __init__(self):
            super(Access, self).__init__('stop')
            self.status_value = exact_status(ns)
            self.ps_present = False

        def status(self, boot):
            self.events.append('status')
            value = ns['completed_status'](self.status_value, boot)
            self.probe_closed = True
            return {'hello': value, 'status': value, 'probeSocketClosedBeforeFdScan': True}

        def guards(self, held):
            self.events.append('guards')
            self.assert_held = held.held
            if self.ps_present:
                raise ns['ProductGateError']('fixture-ps-lease-present')
            return held.recheck()

        def inspectors(self):
            self.events.append('inspectors')
            return {'completePass': True, 'selfExcluded': {'pid': 4242, 'startTicks': 77}, 'stdinInspectors': [],
                    'newPidsAtEnd': [], 'rawArgvEmitted': False, 'stdinRead': False, 'environmentRead': False, 'remainingArgumentsRead': False}

        def action(self):
            assert lease.held, 'Product lease must be held across the only normal stop.'
            return super(Access, self).action('stop')
    return Access()


class PayloadTests(unittest.TestCase):
    def setUp(self):
        self.ns = namespaces['normal-stop']
        self.lease = FakeLease()
        self.access = access_fixture(self.ns, self.lease)
        self.config = mock.patch.dict(self.ns, RECOVERY_CONFIG_SHA=hashlib.sha256(self.access.data[self.ns['CONFIG_PATH']]).hexdigest())
        self.config.start()
        self.addCleanup(self.config.stop)

    def stop(self):
        return self.ns['normal_stop'](self.access, self.lease)

    def test_exact_query3_job_never_accepts_missing_or_mixed_current_python_epoch(self):
        self.assertEqual(self.ns['APPROVED_HASHES'], old_fixture.V2_HASHES)
        for name in ('board_agent.py', 'camera.py'):
            for missing in (False, True):
                with self.subTest(name=name, missing=missing):
                    access = access_fixture(self.ns, self.lease)
                    target = self.ns['PROJECT'] + '/vision_app/' + name
                    if missing:
                        del access.data[target]
                    else:
                        access.data[target] = (ROOT / 'engineering/fz3b/source/PS/vision_app' / name).read_bytes()
                    result = self.ns['normal_stop'](access, self.lease)
                    self.assertEqual(result['result'], 'blocked', result)
                    self.assertFalse(result['actionIssued'])
                    self.assertEqual(access.actions, [])

    def test_exact_completed_job_gets_only_one_stop_while_product_lease_is_held(self):
        result = self.stop()
        self.assertEqual(result['result'], 'passed', result)
        self.assertEqual(self.access.actions, ['stop'])
        self.assertEqual(result['after']['mainPid'], 0)
        self.assertEqual(result['preRead'], result['postRead'])
        self.assertEqual(result['dependenciesBefore'], result['dependenciesAfter'])
        self.assertTrue(self.lease.closed)
        self.assertGreaterEqual(self.lease.calls, 4)
        self.assertFalse(result['historicalUnknownResolved'])
        self.assertFalse(result['jobClearedByProbe'])
        self.assertFalse(result['startRequested'])

    def test_readonly_preflight_has_no_action_and_requires_the_same_full_guards(self):
        ns = namespaces['readonly-preflight']
        access = access_fixture(ns, self.lease)
        access.action = mock.Mock(side_effect=AssertionError('Readonly payload must not request an action'))
        with mock.patch.dict(ns, RECOVERY_CONFIG_SHA=hashlib.sha256(access.data[ns['CONFIG_PATH']]).hexdigest()):
            result = ns['readonly_preflight'](access, self.lease)
        self.assertEqual(result['result'], 'passed', result)
        self.assertFalse(result['actionIssued'])
        access.action.assert_not_called()
        self.assertEqual(access.events.count('status'), 2)
        self.assertTrue(self.lease.closed)

    def test_foreign_missing_unfinished_cancelled_bool_counts_or_wrong_job_block_before_action(self):
        mutations = [lambda value: value.update(query_revision=1), lambda value: value.update(query_revision=True),
                     lambda value: value.update(threshold=float('nan')), lambda value: value.update(cpu_frequency_changing=True),
                     lambda value: value.update(boot_id='foreign'), lambda value: value.update(upload=None)]
        for change in ({'job_id': 'foreign'}, {'received': True}, {'received': 2}, {'completed': 0}, {'queued': 1},
                       {'finished': False}, {'cancelled': True}, {'error': 'failure'}):
            mutations.append(lambda value, change=change: value['upload'].update(change))
        for mutate in mutations:
            access = access_fixture(self.ns, self.lease)
            mutate(access.status_value)
            result = self.ns['normal_stop'](access, self.lease)
            self.assertEqual(result['result'], 'blocked', result)
            self.assertEqual(access.actions, [])

    def test_ps_or_product_unknown_before_or_immediately_before_stop_blocks(self):
        self.access.ps_present = True
        self.assertEqual(self.stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])
        self.access.ps_present = False
        self.lease.unknown = True
        self.assertEqual(self.stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])
        self.lease.unknown = False
        original = self.access.guards
        count = [0]
        def appears(held):
            count[0] += 1
            if count[0] == 3:
                self.access.ps_present = True
            return original(held)
        self.access.guards = appears
        self.assertEqual(self.stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])

    def test_five_python_config_unit_dependency_and_proc_guards_are_not_bypassed(self):
        for path in tuple(self.ns['PROJECT'] + '/vision_app/' + name for name in self.ns['APPROVED_HASHES']) + (self.ns['CONFIG_PATH'], self.ns['UNIT_PATH']):
            access = access_fixture(self.ns, self.lease)
            access.data[path] += b'changed'
            self.assertEqual(self.ns['normal_stop'](access, self.lease)['result'], 'blocked')
            self.assertEqual(access.actions, [])
        for change in ({'a0005Owners': [{'pid': 999}]}, {'active8765': [{'state': '08'}]}, {'listeners8765': []}, {'deviceOpened': True}):
            access = access_fixture(self.ns, self.lease)
            access.scan_changes = change
            self.assertEqual(self.ns['normal_stop'](access, self.lease)['result'], 'blocked')
            self.assertEqual(access.actions, [])
        self.access.dependency_changes[self.ns['DEPENDENCIES'][0]] = {'ActiveState': 'inactive'}
        self.assertEqual(self.stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])

    def test_late_status_change_is_rejected_after_first_clean_probe(self):
        original = self.access.status
        count = [0]
        def changed(boot):
            count[0] += 1
            if count[0] == 2:
                self.access.status_value['upload']['received'] = 2
            return original(boot)
        self.access.status = changed
        self.assertEqual(self.stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])

    def test_incomplete_inspector_absence_new_pid_or_changed_self_never_allows_stop(self):
        for change in ({'stdinInspectors': [{'pid': 888, 'startTicks': 1}]}, {'completePass': False},
                       {'newPidsAtEnd': [777]}, {'environmentRead': True}):
            access = access_fixture(self.ns, self.lease)
            original = access.inspectors
            access.inspectors = lambda: dict(original(), **change)
            self.assertEqual(self.ns['normal_stop'](access, self.lease)['result'], 'blocked')
            self.assertEqual(access.actions, [])
        original = self.access.inspectors
        count = [0]
        def changed_self():
            value = original()
            count[0] += 1
            if count[0] == 2: value['selfExcluded']['startTicks'] += 1
            return value
        self.access.inspectors = changed_self
        self.assertEqual(self.stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])

    def test_post_stop_inspector_or_proc_permission_error_is_unknown_without_repair(self):
        original = self.access.inspectors
        count = [0]
        def late_permission():
            count[0] += 1
            if count[0] == 3: raise PermissionError(errno.EACCES, 'fixture-private-path-not-for-output')
            return original()
        self.access.inspectors = late_permission
        result = self.stop()
        self.assertEqual(result['result'], 'unknown')
        self.assertEqual(self.access.actions, ['stop'])
        self.assertNotIn('private-path', json.dumps(result))

    def test_stop_timeout_is_unknown_without_kill_compensation_or_second_action(self):
        def timeout():
            self.access.actions.append('stop')
            raise self.ns['LifecycleError']('fixture-stop-timeout', {'exitObserved': False, 'killAttempted': False})
        self.access.action = timeout
        result = self.stop()
        self.assertEqual(result['result'], 'unknown')
        self.assertTrue(result['humanReviewRequired'])
        self.assertEqual(self.access.actions, ['stop'])
        self.assertFalse(result['command']['killAttempted'])
        self.assertTrue(self.lease.closed)

    def test_post_stop_lease_dependency_or_file_change_is_unknown_with_no_start(self):
        for change in ('ps', 'product', 'dependency', 'file'):
            lease = FakeLease()
            access = access_fixture(self.ns, lease)
            original = access.action
            def changed(change=change):
                result = original()
                if change == 'ps': access.ps_present = True
                if change == 'product': lease.unknown = True
                if change == 'dependency': access.dependency_changes[self.ns['DEPENDENCIES'][0]] = {'MainPID': '999'}
                if change == 'file': access.data[self.ns['PROJECT'] + '/vision_app/camera.py'] += b'changed'
                return result
            access.action = changed
            result = self.ns['normal_stop'](access, lease)
            self.assertEqual(result['result'], 'unknown', result)
            self.assertEqual(access.actions, ['stop'])
            self.assertTrue(lease.closed)


def journal():
    return dict(schemaVersion=1, operationId=gate.FIXED_OPERATION, nonce=gate.FIXED_NONCE, profileSha256=gate.FIXED_PROFILE,
                grantId=gate.FIXED_GRANT, status='succeeded', remoteQuiescent=True, semantic=copy.deepcopy(accepted['run']['semantic']),
                idle={'controlConnections': 0, 'deviceOwners': []})


def metadata(kind, inode, size=0, mode=0o600):
    return types.SimpleNamespace(st_mode=kind | mode, st_uid=0, st_nlink=1, st_size=size, st_dev=1, st_ino=inode, st_mtime=1, st_ctime=1)


class ProductGateTests(unittest.TestCase):
    def gate_context(self, value=None, names=None, lock_error=None, lock_info=None):
        stack = __import__('contextlib').ExitStack()
        app = metadata(stat.S_IFDIR, 1, mode=0o755)
        directory = metadata(stat.S_IFDIR, 2, mode=0o700)
        lock = lock_info or metadata(stat.S_IFREG, 3)
        records = {gate.FIXED_OPERATION + '.json': journal() if value is None else value}
        inventory = names or ['active.lock'] + list(records)
        fcntl = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=mock.Mock(side_effect=lock_error))
        stack.enter_context(mock.patch.dict(sys.modules, fcntl=fcntl))
        stack.enter_context(mock.patch.object(gate.sys, 'platform', 'linux'))
        stack.enter_context(mock.patch.object(gate.os, 'geteuid', return_value=0, create=True))
        for name, number in (('O_NOFOLLOW', 0x20000), ('O_DIRECTORY', 0x10000), ('O_NONBLOCK', 0x40000)):
            stack.enter_context(mock.patch.object(gate.os, name, number, create=True))
        stack.enter_context(mock.patch.object(gate, 'gate_app_directory', return_value=100))
        stack.enter_context(mock.patch.object(gate, 'gate_directory', return_value=101))
        opened = stack.enter_context(mock.patch.object(gate.os, 'open', return_value=102))
        closed = stack.enter_context(mock.patch.object(gate.os, 'close'))
        stack.enter_context(mock.patch.object(gate.os, 'fstat', side_effect=lambda fd: lock if fd == 102 else directory if fd == 101 else app))
        stack.enter_context(mock.patch.object(gate.os, 'stat', side_effect=lambda name, **_: directory if name == gate.PRODUCT_DIRECTORY else lock))
        stack.enter_context(mock.patch.object(gate.os, 'listdir', return_value=inventory))
        stack.enter_context(mock.patch.object(gate, 'gate_read_leaf', side_effect=lambda _fd, name: gate.gate_canonical(records[name])))
        return stack, fcntl, opened, closed, records

    def test_stale_lock_inode_is_accepted_only_with_exclusive_nonblocking_readonly_flock_and_exact_journal(self):
        stack, fcntl, opened, closed, _ = self.gate_context()
        with stack:
            with gate.ProductLease() as lease:
                value = lease.recheck()
                self.assertTrue(value['productLeaseHeldReadOnly'])
                self.assertFalse(value['unknownCleared'])
                self.assertEqual(value['journalCount'], 1)
                self.assertIsNotNone(lease.lock_fd)
            self.assertIsNone(lease.lock_fd)
        fcntl.flock.assert_called_once_with(102, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.assertTrue(all(not call.args[1] & (gate.os.O_WRONLY | gate.os.O_RDWR | gate.os.O_CREAT | gate.os.O_TRUNC) for call in opened.call_args_list))
        self.assertGreaterEqual(closed.call_count, 3)

    def test_live_flock_untrusted_lock_or_unknown_journal_is_rejected_and_descriptors_close(self):
        for value, error, info in ((journal(), OSError(errno.EAGAIN, 'held'), None),
                                   (dict(journal(), status='unknown'), None, None),
                                   (dict(journal(), remoteQuiescent=False), None, None),
                                   (dict(journal(), nonce='0' * 64), None, None),
                                   (dict(journal(), grantId='foreign'), None, None),
                                   (journal(), None, metadata(stat.S_IFLNK, 3)),
                                   (journal(), None, metadata(stat.S_IFREG, 3, mode=0o644))):
            stack, _, _, closed, _ = self.gate_context(value=value, lock_error=error, lock_info=info)
            with stack:
                with self.assertRaises(Exception):
                    with gate.ProductLease(): pass
            self.assertGreaterEqual(closed.call_count, 3)

    def test_journal_change_extra_entry_and_missing_current_completion_are_not_safe(self):
        stack, _, _, _, records = self.gate_context()
        with stack:
            with gate.ProductLease() as lease:
                records[gate.FIXED_OPERATION + '.json']['semantic']['queryRevision'] = 4
                with self.assertRaises(gate.ProductGateError): lease.recheck()
        for names in (['active.lock'], ['active.lock', 'unknown.tmp'], ['active.lock', '../escape.json']):
            stack, *_ = self.gate_context(names=names)
            with stack:
                with self.assertRaises(Exception):
                    with gate.ProductLease(): pass

    def test_current_idle_count_requires_integer_zero_not_boolean_coercion(self):
        for idle in ({'controlConnections': False, 'deviceOwners': []}, {'controlConnections': 0, 'deviceOwners': {}},
                     {'controlConnections': 0, 'deviceOwners': [], 'extra': False}):
            value = journal()
            value['idle'] = idle
            stack, *_ = self.gate_context(value=value)
            with stack:
                with self.assertRaises(gate.ProductGateError):
                    with gate.ProductLease(): pass

    def test_ps_lease_any_inode_blocks_without_body_read_create_or_unlink(self):
        with mock.patch.object(gate.os, 'stat', side_effect=FileNotFoundError) as observed:
            self.assertTrue(gate.assert_ps_transaction_absent(9))
        self.assertEqual(observed.call_args.kwargs, {'dir_fd': 9, 'follow_symlinks': False})
        with mock.patch.object(gate.os, 'stat', return_value=object()):
            with self.assertRaises(gate.ProductGateError): gate.assert_ps_transaction_absent(9)

    def test_strict_json_rejects_duplicate_nan_overflow_depth_and_byte_budget(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":1e9999}', b'[]', b'{' + b' ' * 32768 + b'}',
                    b'{"x":' + b'[' * 20 + b'0' + b']' * 20 + b'}'):
            with self.assertRaises(Exception): gate.journal_object(raw)


class BuilderTests(unittest.TestCase):
    def test_only_fixed_source_and_pinned_base_old_gate_inputs_are_accepted(self):
        inputs = [builder.BASE.read_bytes(), builder.OLD.read_bytes(), builder.GATE.read_bytes(), Path(builder.__file__).read_bytes(), builder.SOURCE.read_bytes(), builder.PROC.read_bytes()]
        for index in (0, 1, 2, 4, 5):
            changed = list(inputs)
            changed[index] += b'\n'
            with self.assertRaises(ValueError): builder.build_payloads(*changed)
        with self.assertRaises(ValueError): builder.main(['--host', 'arbitrary'])
        self.assertEqual(hashlib.sha256(inputs[4]).hexdigest(), builder.SOURCE_SHA)
        self.assertEqual(accepted['run']['semantic']['jobId'], builder.RECOVERY_JOB)

    def test_readonly_ast_has_no_service_mutation_capability_or_file_writes_and_python36_grammar(self):
        for mode, raw in payloads.items():
            tree = ast.parse(raw.decode('ascii'), feature_version=(3, 6))
            names = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
            self.assertNotIn('run_systemctl', names)
            self.assertNotIn('lifecycle', names)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    self.assertNotIn(node.func.attr, ('kill', 'terminate', 'unlink', 'remove', 'rename', 'mkdir', 'write', 'write_file', 'write_bytes'))
            if mode == 'readonly-preflight':
                self.assertNotIn('run_stop', names)
                self.assertNotIn('StopAccess', names)
                self.assertFalse(any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'action' for node in ast.walk(tree)))
            self.assertNotIn("'restart'", raw.decode('ascii'))

    def test_old_query_and_status_ast_delta_is_only_named_validator_and_exact_revision(self):
        old = ast.parse(builder.OLD.read_bytes())
        before = copy.deepcopy(next(node for node in old.body if isinstance(node, ast.FunctionDef) and node.name == 'completed_status'))
        after = copy.deepcopy(next(node for node in ast.parse(payloads['normal-stop']).body if isinstance(node, ast.FunctionDef) and node.name == 'completed_status'))
        for node in ast.walk(after):
            if isinstance(node, ast.Compare) and isinstance(node.left, ast.Subscript) and isinstance(node.left.value, ast.Name) and node.left.value.id == 'value' and ast.literal_eval(node.left.slice) == 'query_revision':
                node.comparators = [ast.Constant(value=1)]
            if isinstance(node, ast.Dict):
                for index, key in enumerate(node.keys):
                    if isinstance(key, ast.Constant) and key.value == 'queryRevision': node.values[index] = ast.Constant(value=1)
        self.assertEqual(ast.dump(before, include_attributes=False), ast.dump(after, include_attributes=False))
        self.assertEqual(BLOCKED, [])

    def test_proc_metadata_and_bounded_prefix_functions_are_the_exact_pinned_reviewed_subset(self):
        before = {node.name: node for node in ast.parse(builder.PROC.read_bytes()).body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        after = {node.name: node for node in ast.parse(payloads['normal-stop']).body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        for name in ('proc_stat', 'classify_prefix', 'ProcAccess', 'scan_inspectors'):
            self.assertEqual(ast.dump(before[name], include_attributes=False), ast.dump(after[name], include_attributes=False), name)
        self.assertNotIn('maintenance_collect', after)
        self.assertNotIn('checked_status', after)

    def test_only_fixed_show_or_single_stop_subprocess_contract_and_timeout_never_kills(self):
        ns = namespaces['normal-stop']
        calls = []
        class Child:
            pid, returncode = 55, 0
            def communicate(self, timeout):
                calls.append(('communicate', timeout))
                return ('\n'.join(key + '=' + value for key, value in old_fixture.properties().items()).encode('ascii'), None)
        def popen(args, **kwargs):
            calls.append((args, kwargs))
            return Child()
        ns['run_show'](ns['UNIT'], popen)
        self.assertEqual(calls[0][0][:3], ['/bin/systemctl', 'show', ns['UNIT']])
        self.assertEqual(calls[0][1]['shell'], False)
        self.assertEqual(calls[1], ('communicate', 5))
        calls[:] = []
        result = ns['run_stop'](popen)
        self.assertEqual(calls[0][0], ['/bin/systemctl', 'stop', ns['UNIT'], '--no-pager'])
        self.assertEqual(calls[1], ('communicate', 370))
        self.assertFalse(result['killAttempted'])
        class TimeoutChild(Child):
            def communicate(self, timeout):
                raise subprocess.TimeoutExpired('fixed-fixture', timeout)
        with self.assertRaises(ns['LifecycleError']) as raised:
            ns['run_stop'](lambda *_args, **_kwargs: TimeoutChild())
        self.assertFalse(raised.exception.command['exitObserved'])
        self.assertFalse(raised.exception.command['killAttempted'])
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
