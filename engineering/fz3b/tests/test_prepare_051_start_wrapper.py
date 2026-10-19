"""Pure wrapper flow tests. The actual old start program is never executed."""
import ast
import base64
import builtins
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
BLOCKED = []
ACTIVE = False


def audit(event, _args):
    if ACTIVE and (event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system'):
        BLOCKED.append(event)
        raise RuntimeError('Start-wrapper tests forbid real network/process execution')


sys.addaudithook(audit)


def setUpModule():
    global builder, payload, ACTIVE
    ACTIVE = True
    file = ROOT / 'engineering/fz3b/tools/prepare_051_start_wrapper.py'
    spec = importlib.util.spec_from_file_location('offline_start_wrapper_builder', str(file))
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    payload = builder.build_payload(builder.START.read_bytes(), builder.GATE.read_bytes())


def tearDownModule():
    global ACTIVE
    ACTIVE = False


class WrapperTests(unittest.TestCase):
    def fixture(self, result=None, exit_code=0):
        ns = {'__name__': 'offline_wrapper_definitions'}
        exec(compile(payload, '<offline-start-wrapper-definitions>', 'exec'), ns)
        events, held = [], [False]
        value = result or {'schemaVersion': 1, 'result': 'passed', 'actionIssued': True, 'inner': 'fake-only-not-real-service'}
        raw = ("import builtins,json\nassert builtins._fz3b_test_held()\nRESULT=" + repr(value) +
               "\nprint(json.dumps(RESULT,sort_keys=True))\nraise SystemExit(" + repr(exit_code) + ')\n').encode('ascii')
        ns['START_SHA'] = hashlib.sha256(raw).hexdigest()  # Test-only synthetic program; production bytes remain pinned.
        class Lease:
            app_fd = 7
            def __enter__(self):
                events.append('enter'); held[0] = True; return self
            def recheck(self):
                assert held[0]; events.append('journal'); return {'fixed': 'readonly-terminal'}
            def __exit__(self, *_):
                events.append('close'); held[0] = False
        def absent(_fd):
            assert held[0]; events.append('ps-absent'); return True
        return ns, raw, {'ProductLease': Lease, 'assert_ps_transaction_absent': absent}, events, held, value

    def test_old_main_systemexit_stays_inside_product_lease_and_original_json_is_returned_once(self):
        ns, raw, gate, events, held, value = self.fixture()
        with mock.patch.object(builtins, '_fz3b_test_held', side_effect=lambda: held[0], create=True) as executed:
            code, line = ns['guarded_start'](raw, gate)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(line), value)
        self.assertEqual(events, ['enter', 'ps-absent', 'journal', 'journal', 'ps-absent', 'close'])
        self.assertFalse(held[0]); self.assertEqual(executed.call_count, 1)

    def test_inner_blocked_or_unknown_result_is_not_retried_or_upgraded(self):
        for status in ('blocked', 'unknown'):
            value = {'result': status, 'actionIssued': status == 'unknown'}
            ns, raw, gate, events, held, _ = self.fixture(value, 2)
            with mock.patch.object(builtins, '_fz3b_test_held', side_effect=lambda: held[0], create=True) as executed:
                code, line = ns['guarded_start'](raw, gate)
            self.assertEqual(code, 2); self.assertEqual(json.loads(line), value)
            self.assertEqual(executed.call_count, 1); self.assertEqual(events.count('enter'), 1); self.assertFalse(held[0])

    def test_ps_absence_or_journal_failure_before_entry_blocks_without_executing_old_program(self):
        for field in ('ps', 'journal'):
            ns, raw, gate, events, held, _ = self.fixture()
            if field == 'ps': gate['assert_ps_transaction_absent'] = lambda _fd: False
            else:
                original = gate['ProductLease']
                class BadLease(original):
                    def recheck(self): raise ValueError('fixture-private-not-emitted')
                gate['ProductLease'] = BadLease
            with mock.patch.object(builtins, '_fz3b_test_held', side_effect=lambda: held[0], create=True) as executed:
                code, line = ns['guarded_start'](raw, gate)
            self.assertEqual(code, 1); self.assertEqual(json.loads(line)['result'], 'blocked')
            self.assertEqual(executed.call_count, 0); self.assertFalse(held[0]); self.assertNotIn('private-not-emitted', line)

    def test_post_guard_failure_does_not_publish_captured_passed_or_compensate(self):
        ns, raw, gate, events, held, _ = self.fixture()
        count = [0]
        def changed(_fd):
            count[0] += 1
            return count[0] == 1
        gate['assert_ps_transaction_absent'] = changed
        with mock.patch.object(builtins, '_fz3b_test_held', side_effect=lambda: held[0], create=True) as executed:
            code, line = ns['guarded_start'](raw, gate)
        value = json.loads(line)
        self.assertEqual(code, 2); self.assertEqual(value['result'], 'unknown'); self.assertTrue(value['actionIssued'])
        self.assertFalse(value['automaticRetry']); self.assertFalse(value['compensationRequested']); self.assertFalse(held[0])
        self.assertEqual(executed.call_count, 1); self.assertNotIn('"result": "passed"', line)

    def test_frozen_bytes_hashes_python36_and_no_generic_cli_input(self):
        tree = ast.parse(payload.decode('ascii'), feature_version=(3, 6))
        constants = {node.targets[0].id: ast.literal_eval(node.value) for node in tree.body
                     if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
        self.assertEqual(base64.b64decode(constants['START_B64']), builder.START.read_bytes())
        self.assertEqual(base64.b64decode(constants['GATE_B64']), builder.GATE.read_bytes())
        for raw, expected in ((builder.START.read_bytes(), builder.START_SHA), (builder.GATE.read_bytes(), builder.GATE_SHA)):
            self.assertEqual(hashlib.sha256(raw).hexdigest(), expected)
        with self.assertRaises(ValueError): builder.build_payload(builder.START.read_bytes() + b'\n', builder.GATE.read_bytes())
        with self.assertRaises(ValueError): builder.main(['--host', 'anything'])
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
