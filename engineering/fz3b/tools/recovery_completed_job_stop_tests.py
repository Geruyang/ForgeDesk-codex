"""Offline generated-payload/fake-service tests; no real lifecycle or SSH."""
import ast
import copy
import errno
import hashlib
import importlib.util
from pathlib import Path
import stat
import subprocess
import sys
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
GUARD_ACTIVE = False
BLOCKED = []
builder = fixture = ns = None


def audit(event, args):
    if GUARD_ACTIVE and (event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system'):
        BLOCKED.append(event)
        raise RuntimeError('Offline recovery stop tests prohibit network/process operations')


sys.addaudithook(audit)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setUpModule():
    global GUARD_ACTIVE, builder, fixture, ns
    GUARD_ACTIVE = True
    try:
        builder = load('completed_stop_builder', Path(__file__).with_name('recovery_completed_job_stop.py'))
        fixture = load('frozen_lifecycle_test_fixtures', ROOT / 'tests/test_service_lifecycle.py')
        payload = builder.build_payload(builder.BASE.read_bytes(), Path(builder.__file__).read_bytes())
        ns = {'__name__': 'offline_completed_job_payload'}
        exec(compile(payload, '<offline-generated-definitions>', 'exec'), ns)
    except BaseException:
        GUARD_ACTIVE = False
        raise


def tearDownModule():
    global GUARD_ACTIVE
    GUARD_ACTIVE = False


def exact_status():
    return dict(type='status', protocol=1, platform='A0005', contract_id=ns['CONTRACT_ID'],
                boot_id=builder.RECOVERY_BOOT, inference=dict(state='STOPPED', error=None, frames=1, max_in_flight=4),
                query_revision=1, threshold=.2, result_delivery_drops=0,
                cpu_frequency_changing=False, input_source='upload',
                upload=dict(job_id=builder.RECOVERY_JOB, received=1, completed=1, queued=0,
                            finished=True, cancelled=False, error=None))


class FixtureAccess:
    def __new__(cls):
        class CompletedFixture(fixture.FixtureAccess):
            def __init__(self):
                super().__init__('stop')
                self.status_value = exact_status()
                self.lease_present = False

            def lease_absent(self):
                self.events.append('lease-check')
                return not self.lease_present

            def status(self, boot):
                self.events.append('status')
                checked = ns['completed_status'](self.status_value, boot)
                self.probe_closed = True
                return {'hello': checked, 'status': checked, 'probeSocketClosedBeforeFdScan': True}
        return CompletedFixture()


class CompletedStopTests(unittest.TestCase):
    def setUp(self):
        self.access = FixtureAccess()
        # Fixed production config pin remains unchanged; only this fake config gets a test-scope pin.
        self.config_patch = mock.patch.dict(ns, RECOVERY_CONFIG_SHA=hashlib.sha256(self.access.data[ns['CONFIG_PATH']]).hexdigest())
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)

    def run_stop(self):
        return ns['recovery_stop'](self.access)

    def test_exact_completed_job_gets_one_normal_stop_with_all_original_guards(self):
        result = self.run_stop()
        self.assertEqual(result['result'], 'passed', result)
        self.assertEqual(self.access.actions, ['stop'])
        self.assertEqual(result['after']['mainPid'], 0)
        self.assertEqual(result['afterQuiescence']['a0005Owners'], [])
        self.assertEqual(result['preRead'], result['postRead'])
        self.assertEqual(result['dependenciesBefore'], result['dependenciesAfter'])
        self.assertFalse(result['jobClearedByProbe'])
        self.assertFalse(result['historicalUnknownResolved'])
        self.assertFalse(result['startRequested'])
        self.assertGreaterEqual(self.access.events.count('lease-check'), 5)
        self.assertLess(self.access.events.index('status'), self.access.events.index('scan'))
        self.assertLess(self.access.events.index('scan'), self.access.events.index(('action', 'stop')))

    def test_original_shared_status_gate_still_refuses_completed_upload(self):
        with self.assertRaises(fixture.service.LifecycleError):
            fixture.service.checked_status(exact_status(), builder.RECOVERY_BOOT)
        self.assertEqual(hashlib.sha256(builder.BASE.read_bytes()).hexdigest(), builder.BASE_SHA)

    def test_foreign_job_unfinished_cancelled_or_bad_count_is_not_stopped(self):
        for change in ({'job_id': 'foreign'}, {'finished': False}, {'cancelled': True}, {'error': 'failure'},
                       {'received': 2, 'completed': 2}, {'completed': 0}, {'queued': 1}, {'received': True}):
            with self.subTest(change=change):
                self.access = FixtureAccess()
                self.access.status_value['upload'].update(change)
                self.assertEqual(self.run_stop()['result'], 'blocked')
                self.assertEqual(self.access.actions, [])

    def test_missing_upload_or_null_is_not_this_special_gate(self):
        for value in (None, {}, 'completed'):
            self.access = FixtureAccess()
            self.access.status_value['upload'] = value
            self.assertEqual(self.run_stop()['result'], 'blocked')
            self.assertEqual(self.access.actions, [])

    def test_changed_query_frames_state_clock_identity_is_blocked(self):
        for key, value in (('query_revision', 2), ('threshold', .3), ('result_delivery_drops', 1),
                           ('cpu_frequency_changing', True), ('input_source', 'camera'),
                           ('boot_id', 'foreign'), ('contract_id', '0' * 64)):
            with self.subTest(key=key):
                self.access = FixtureAccess()
                self.access.status_value[key] = value
                self.assertEqual(self.run_stop()['result'], 'blocked')
                self.assertEqual(self.access.actions, [])
        for change in ({'frames': 2}, {'frames': True}, {'state': 'DRAINING'}, {'error': 'failure'}, {'max_in_flight': 2}):
            self.access = FixtureAccess()
            self.access.status_value['inference'].update(change)
            self.assertEqual(self.run_stop()['result'], 'blocked')
            self.assertEqual(self.access.actions, [])

    def test_lease_present_before_or_appearing_before_action_blocks(self):
        self.access.lease_present = True
        self.assertEqual(self.run_stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])
        self.access = FixtureAccess()
        counter = [0]
        def check():
            counter[0] += 1
            return counter[0] < 3
        self.access.lease_absent = check
        self.assertEqual(self.run_stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])

    def test_original_owner_connection_and_listener_guards_remain(self):
        for change in ({'a0005Owners': [{'pid': 999, 'fd': 1}]}, {'active8765': [{'state': '08'}]},
                       {'listeners8765': [{'owners': [{'pid': 999}]}]}, {'deviceOpened': True}):
            self.access = FixtureAccess()
            self.access.scan_changes = change
            self.assertEqual(self.run_stop()['result'], 'blocked')
            self.assertEqual(self.access.actions, [])

    def test_source_config_and_unit_stop_policy_remain_strict(self):
        for path in (ns['PROJECT'] + '/vision_app/board_agent.py', ns['CONFIG_PATH'], ns['UNIT_PATH']):
            self.access = FixtureAccess()
            self.access.data[path] += b'changed'
            self.assertEqual(self.run_stop()['result'], 'blocked')
            self.assertEqual(self.access.actions, [])
        self.access = FixtureAccess()
        self.access.property_changes['SendSIGKILL'] = 'yes'
        self.assertEqual(self.run_stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])

    def test_missing_approved_source_blocks_even_legacy_stop_allowed_absence(self):
        self.access.data.pop(ns['PROJECT'] + '/vision_app/image_boundary.py')
        self.assertEqual(self.run_stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])

    def test_dependency_not_active_blocks_and_changed_after_stop_is_unknown(self):
        unit = ns['DEPENDENCIES'][0]
        self.access.dependency_changes[unit] = {'ActiveState': 'inactive'}
        self.assertEqual(self.run_stop()['result'], 'blocked')
        self.assertEqual(self.access.actions, [])
        self.access = FixtureAccess()
        original = self.access.action
        def changed(mode):
            record = original(mode)
            self.access.dependency_changes[unit] = {'MainPID': '999'}
            return record
        self.access.action = changed
        result = self.run_stop()
        self.assertEqual(result['result'], 'unknown')
        self.assertTrue(result['humanReviewRequired'])
        self.assertEqual(self.access.actions, ['stop'])

    def test_timeout_is_unknown_without_second_action_or_start(self):
        def timeout(mode):
            self.access.actions.append(mode)
            raise ns['LifecycleError']('systemctl-timeout', {'exitObserved': False, 'killAttempted': False})
        self.access.action = timeout
        result = self.run_stop()
        self.assertEqual(result['result'], 'unknown')
        self.assertTrue(result['humanReviewRequired'])
        self.assertEqual(self.access.actions, ['stop'])
        self.assertFalse(result['command']['exitObserved'])

    def test_post_owner_or_lease_is_unknown_not_start_or_cleanup(self):
        original = self.access.action
        def changed(mode):
            result = original(mode)
            self.access.lease_present = True
            return result
        self.access.action = changed
        result = self.run_stop()
        self.assertEqual(result['result'], 'unknown')
        self.assertEqual(self.access.actions, ['stop'])


class GeneratorTests(unittest.TestCase):
    def test_generated_grammar_and_unchanged_base_ast_except_named_alias(self):
        original = ast.parse(builder.BASE.read_text(encoding='utf-8'))
        payload = builder.build_payload(builder.BASE.read_bytes(), Path(builder.__file__).read_bytes())
        generated = ast.parse(payload.decode('ascii'), feature_version=(3, 6))
        before = {node.name: node for node in original.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        after = {node.name: node for node in generated.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
        for name, node in before.items():
            actual = copy.deepcopy(after['original_pre_read' if name == 'pre_read' else name])
            actual.name = name
            self.assertEqual(ast.dump(node, include_attributes=False), ast.dump(actual, include_attributes=False), name)
        self.assertIn("require(len(sys.argv) == 1, 'no-arguments-accepted')", payload.decode('ascii'))
        self.assertIn("lifecycle('stop', RECOVERY_BOOT, None, access)", payload.decode('ascii'))

    def test_modified_base_refused_without_execution(self):
        with self.assertRaises(ValueError):
            builder.build_payload(builder.BASE.read_bytes() + b'\n', Path(builder.__file__).read_bytes())

    def test_query_clone_only_changes_function_name_and_validation_callee(self):
        before = copy.deepcopy(next(node for node in ast.parse(builder.BASE.read_text()).body
                                    if isinstance(node, ast.FunctionDef) and node.name == 'query_status'))
        payload = ast.parse(builder.build_payload(builder.BASE.read_bytes(), Path(builder.__file__).read_bytes()))
        after = copy.deepcopy(next(node for node in payload.body if isinstance(node, ast.FunctionDef)
                                   and node.name == 'query_completed_status'))
        after.name = 'query_status'
        for node in ast.walk(after):
            if isinstance(node, ast.Name) and node.id == 'completed_status': node.id = 'checked_status'
        self.assertEqual(ast.dump(before, include_attributes=False), ast.dump(after, include_attributes=False))

    def test_lease_reader_only_stats_fixed_leaf_no_create_unlink_or_body_read(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with mock.patch.object(ns['os'], 'open', return_value=9) as opened, \
             mock.patch.object(ns['os'], 'close'), mock.patch.object(ns['os'], 'fstat', return_value=info), \
             mock.patch.object(ns['os'], 'stat', side_effect=FileNotFoundError) as stated:
            with mock.patch.object(ns['os'], 'O_DIRECTORY', 0x10000, create=True), \
                 mock.patch.object(ns['os'], 'O_NOFOLLOW', 0x20000, create=True), \
                 mock.patch.object(ns['os'], 'O_NONBLOCK', 0x40000, create=True):
                self.assertTrue(ns['assert_lease_absent']())
        self.assertEqual(stated.call_args.args[0], '.forgedesk-ps-transaction.lock')
        self.assertEqual(stated.call_args.kwargs['follow_symlinks'], False)
        self.assertTrue(all(not call.args[1] & (ns['os'].O_WRONLY | ns['os'].O_CREAT) for call in opened.call_args_list))

    def test_any_existing_lease_is_refused_without_reading_or_clearing(self):
        info = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0)
        with mock.patch.object(ns['os'], 'open', return_value=9), mock.patch.object(ns['os'], 'close'), \
             mock.patch.object(ns['os'], 'fstat', return_value=info), mock.patch.object(ns['os'], 'stat', return_value=object()), \
             mock.patch.object(ns['os'], 'O_DIRECTORY', 0x10000, create=True), \
             mock.patch.object(ns['os'], 'O_NOFOLLOW', 0x20000, create=True), \
             mock.patch.object(ns['os'], 'O_NONBLOCK', 0x40000, create=True):
            with self.assertRaises(ns['LifecycleError']): ns['assert_lease_absent']()

    def test_fixed_host_receipts_are_real_record_pins_not_mock_fault_claims(self):
        for relative, expected in builder.RECOVERY_FILES.items():
            self.assertEqual(hashlib.sha256((builder.OUT / relative).read_bytes()).hexdigest(), expected)
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
