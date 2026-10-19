"""Pure phase-1 policy tests. No network, subprocess, UI, device or application."""
import ast
import copy
import importlib.util
import os
import unittest
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FILE = os.path.join(ROOT, 'engineering/fz3b/tools/active_recovery_trial.py')
SPEC = importlib.util.spec_from_file_location('active_trial_under_test', FILE)
T = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(T)
BASELINE = 'output/qa/2026-10-16-fz3b-051/fz3b-installed-1792159422714-b14c06/evidence.json'
BASELINE_SHA = '4bf249193768550e0bccbc006d29a6a4eb1f55d7197cfeb7915408a4f5e99e0f'
JOB = 'fd-recovery-0123456789ab4cde8fab0123456789ab'
META = {'bootId': T.BOOT, 'appRoot': T.APP, 'contractId': T.CONTRACT,
        'deployedManifestSha256': T.DEPLOYED, 'existingPlSha256': T.CANDIDATE}


def status(state='RUNNING', completed=0, queued=0, cancelled=False):
    return {'type': 'status', 'protocol': 1, 'platform': 'A0005', 'boot_id': T.BOOT, 'contract_id': T.CONTRACT,
            'input_source': 'upload', 'cpu_frequency_changing': False, 'query_revision': 2,
            'inference': {'state': state, 'error': None, 'max_in_flight': 4},
            'upload': {'job_id': JOB, 'received': 1, 'completed': completed, 'queued': queued,
                       'finished': True, 'cancelled': cancelled, 'error': None}}


def quiet():
    return {'completePass': True, 'deviceOpened': False, 'deviceOwners': [], 'controlConnections': [],
            'stdinInspectors': [], 'newPidsAtEnd': [], 'selfExcluded': {'pid': 123, 'startTicks': 456}}


def machine(action='upload-cancel'):
    trial = T.FixtureTrial(action, JOB, 2)
    trial.event('product-held', {'fixtureJournalHash': 'a' * 64})
    trial.event('ps-held')
    trial.event('metadata-before', META)
    return trial


def finish(trial, terminal):
    trial.event('terminal', terminal)
    trial.event('owner-closed')
    trial.event('observer-terminal', terminal)
    trial.event('observer-closed')
    trial.event('quiet-scan', quiet())
    trial.event('quiet-scan', quiet())
    trial.event('metadata-after', META)
    return trial.event('product-recheck', {'fixtureJournalHash': 'a' * 64})


class ActivePolicyTests(unittest.TestCase):
    def test_b14_exact_public_report_is_a_candidate_not_a_current_board_assertion(self):
        with open(os.path.join(ROOT, BASELINE), 'rb') as stream: raw = stream.read()
        baseline = T.baseline_from_report(raw, BASELINE, BASELINE_SHA)
        self.assertEqual('cef91994-73d0-4ba1-ac81-e4f1825727b5', baseline['operationId'])
        self.assertEqual(1, baseline['queryRevision'])
        self.assertEqual(T.PROFILE, baseline['profileSha256'])
        with self.assertRaises(ValueError): T.baseline_from_report(raw, BASELINE, '0' * 64)

    def test_unsettled_wrong_target_or_unconsumed_baseline_is_refused(self):
        with open(os.path.join(ROOT, BASELINE), 'rb') as stream: report = T.load_json(stream.read())
        for field in ('unknown', 'active', 'wrong-nonce', 'grant', 'target', 'fixture', 'failed-report'):
            changed = copy.deepcopy(report)
            if field == 'unknown': changed['run']['operations'][-1]['status'] = 'unknown'
            elif field == 'active': changed['run']['active'] = True
            elif field == 'wrong-nonce': changed['run']['operations'][-1]['nonce'] = 'not-a-nonce'
            elif field == 'grant': changed['run']['grant']['consumedBy'] = 'other'
            elif field == 'target': changed['run']['identity']['bootId'] = 'other'
            elif field == 'fixture': changed['run']['semantic']['imageSha256'] = '0' * 64
            else: changed['result'] = 'failed'
            raw = T.canonical(changed)
            with self.assertRaises(ValueError): T.baseline_from_report(raw, BASELINE, T.sha(raw))

    def test_duplicate_json_and_nonfinite_are_not_accepted(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}'):
            with self.assertRaises(ValueError): T.load_json(raw)

    def test_real_pending_frame_sample_records_derived_work_not_hardware_inflight(self):
        for queued in (0, 1):
            proof = T.active_sample(status(queued=queued), JOB, 2)
            self.assertEqual(1 - queued, proof['outstandingNotQueued'])
            self.assertFalse(proof['hardwareInflightAttested'])

    def test_idle_starting_zero_work_wrong_job_and_boolean_counters_fail_active_gate(self):
        for changed in ('STOPPED', 'STARTING', 'DRAINING', 'zero', 'done', 'job', 'revision', 'bool', 'error'):
            value = status()
            if changed in ('STOPPED', 'STARTING', 'DRAINING'): value['inference']['state'] = changed
            elif changed == 'zero': value['upload']['received'] = 0
            elif changed == 'done': value['upload']['completed'] = 1
            elif changed == 'job': value['upload']['job_id'] = 'other'
            elif changed == 'revision': value['query_revision'] = 1
            elif changed == 'bool': value['upload']['completed'] = False
            else: value['inference']['error'] = 'runtime failure'
            with self.assertRaises(ValueError): T.active_sample(value, JOB, 2)

    def test_cancel_command_is_one_owner_bound_operation_not_global_stop(self):
        value = T.cancel_command(JOB, 'cancel-' + JOB[len('fd-recovery-'):])
        self.assertEqual('upload_cancel', value['op']); self.assertEqual(JOB, value['job_id'])
        with self.assertRaises(ValueError): T.cancel_command('../../other', 'id')

    def test_product_must_precede_ps_lease_and_failure_never_unlinks_it(self):
        trial = T.FixtureTrial('tcp-close', JOB, 2)
        with self.assertRaisesRegex(ValueError, 'lock-order'): trial.event('ps-held')
        self.assertFalse(trial.ps)
        trial = machine()
        with self.assertRaises(ValueError): trial.event('second-owner')
        self.assertTrue(trial.receipt()['unknown']); self.assertTrue(trial.receipt()['durableLeaseRetained'])

    def test_cancel_fixture_requires_exact_ack_then_terminal_and_dual_quiet_proof(self):
        for completed in (0, 1):
            trial = machine(); trial.event('active', status()); trial.event('fault', 'upload-cancel')
            trial.event('cancel-ack', {'type': 'ack', 'op': 'upload_cancel', 'ok': True,
                'request_id': 'cancel-' + JOB[len('fd-recovery-'):],
                'result': {'job_id': JOB, 'cancelled': True, 'queued': 0}})
            result = finish(trial, status('STOPPED', completed, cancelled=True))
            self.assertTrue(result['qualifiedFixture']); self.assertTrue(result['durableLeaseRetained'])
            self.assertFalse(result['realHardwarePassed']); self.assertFalse(result['executed'])

    def test_tcp_fixture_is_one_own_close_with_no_cancel_ack(self):
        trial = machine('tcp-close'); trial.event('active', status(queued=1)); trial.event('fault', 'tcp-close')
        self.assertTrue(trial.owner_closed)
        result = finish(trial, status('STOPPED', 0, cancelled=True))
        self.assertEqual(1, result['faultCount']); self.assertTrue(result['qualifiedFixture'])

    def test_duplicate_fault_wrong_ack_or_observer_before_owner_close_holds_unknown(self):
        for case in ('duplicate', 'ack', 'observer'):
            trial = machine(); trial.event('active', status()); trial.event('fault', 'upload-cancel')
            with self.assertRaises(ValueError):
                if case == 'duplicate': trial.event('fault', 'upload-cancel')
                elif case == 'ack': trial.event('cancel-ack', {'request_id': 'other'})
                else: trial.event('observer-terminal', status('STOPPED', 0, cancelled=True))
            self.assertTrue(trial.unknown); self.assertTrue(trial.ps)

    def test_normal_finish_before_fault_is_not_covered_and_never_restarts(self):
        trial = machine(); value = status('STOPPED', 1)
        trial.event('not-covered', value); trial.event('owner-closed'); trial.event('observer-terminal', value)
        self.assertTrue(trial.receipt()['notCovered']); self.assertEqual(0, trial.fault_count)
        self.assertFalse(trial.receipt()['qualifiedFixture']); self.assertTrue(trial.ps)

    def test_normal_completed_disconnect_is_not_cancellation_proof(self):
        with self.assertRaises(ValueError): T.terminal_sample(status('STOPPED', 1), JOB, 2)

    def test_device_tcp_inspector_incomplete_and_self_drift_cannot_be_quiet(self):
        for field in ('deviceOwners', 'controlConnections', 'stdinInspectors', 'completePass', 'newPidsAtEnd', 'selfExcluded'):
            trial = machine('tcp-close'); trial.event('active', status()); trial.event('fault', 'tcp-close')
            term = status('STOPPED', 0, cancelled=True); trial.event('terminal', term)
            trial.event('observer-terminal', term); trial.event('observer-closed'); trial.event('quiet-scan', quiet())
            value = quiet()
            value[field] = False if field == 'completePass' else {'pid': 999, 'startTicks': 1} if field == 'selfExcluded' else [999]
            with self.assertRaises(ValueError): trial.event('quiet-scan', value)
            self.assertTrue(trial.unknown); self.assertTrue(trial.ps)

    def test_changed_metadata_or_product_journal_never_releases(self):
        for field in ('metadata', 'journal', 'release'):
            trial = machine('tcp-close'); trial.event('active', status()); trial.event('fault', 'tcp-close')
            finish(trial, status('STOPPED', 0, cancelled=True))
            with self.assertRaises(ValueError):
                if field == 'metadata': trial.event('metadata-after', {**META, 'bootId': 'different'})
                elif field == 'journal': trial.event('product-recheck', {'fixtureJournalHash': 'b' * 64})
                else: trial.event('release')
            self.assertTrue(trial.unknown); self.assertTrue(trial.ps)

    def test_no_live_execution_imports_and_python36_grammar(self):
        with open(FILE, 'r', encoding='ascii') as stream: source = stream.read()
        tree = ast.parse(source, feature_version=(3, 6))
        imported = {node.names[0].name for node in ast.walk(tree) if isinstance(node, ast.Import)}
        self.assertFalse({'socket', 'subprocess', 'ctypes', 'paramiko', 'serial'} & imported)

    def test_prepare_rejects_invalid_identity_before_any_read_or_write(self):
        with mock.patch.object(T, 'host_read') as read, mock.patch.object(T.os, 'mkdir') as mkdir:
            for action in ('stop', 'reset', 'upload-cancel;stop'):
                with self.assertRaises(ValueError): T.prepare(action, BASELINE, BASELINE_SHA, 'invalid')
            read.assert_not_called(); mkdir.assert_not_called()


if __name__ == '__main__':
    unittest.main()
