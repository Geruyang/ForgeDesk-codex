"""Independent phase-2 consumer attacks. Only pure production guard functions.

The owner test module supplies synthetic record builders/MemoryStore, not a fake
guard. No SecureStore, application, process, network, credential or device opens.
"""
import contextlib
import copy
import datetime
import importlib.util
import json
import os
import threading
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SPEC = importlib.util.spec_from_file_location(
    'phase2_owner_fixture_only', os.path.join(ROOT, 'tests/test_recovery_quarantine.py'))
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)
Q = F.Q
PS_SPEC = importlib.util.spec_from_file_location('phase2_ps_consumer',
    os.path.join(ROOT, 'engineering/fz3b/ps-runtime/recovery_quarantine.py'))
P = importlib.util.module_from_spec(PS_SPEC)
PS_SPEC.loader.exec_module(P)


class IndependentGuardBoundaries(unittest.TestCase):
    def setUp(self):
        self.store = F.MemoryStore()
        self.guard = Q.RecoveryGuard(self.store, lambda: F.NOW)
        self.intent = F.intent()

    def stage(self):
        self.sha = self.guard.begin(self.intent)['activeSha256']
        self.proof = F.proof(self.intent, self.sha)
        self.guard.stage_terminal(self.intent['owner'], self.sha, self.proof)

    def finalize(self):
        return self.guard.finalize(self.intent['owner'], self.sha,
            F.acceptance(self.intent, self.sha, self.proof), F.fresh(self.intent, self.sha))

    def acknowledge_fixture(self):
        # Synthetic verifier contract only; no real signing or Ed25519 assurance.
        verifier, ack = F.host_ack_fixture(self.intent, self.proof, self.store.snapshot())
        self.guard.host_verifier = verifier
        self.guard.publish_host_ack(self.intent['owner'], self.sha, ack)
        return verifier, ack

    def assert_reload_blocked(self):
        snapshot = self.store.snapshot()
        with self.assertRaises((Q.GuardError, ValueError)):
            Q.history_clear(snapshot, self.guard.host_verifier)
        with self.assertRaises((Q.GuardError, ValueError)):
            Q.RecoveryGuard(self.store, lambda: F.NOW + 999999999,
                host_verifier=self.guard.host_verifier).assert_clear()
        self.assertEqual(snapshot, self.store.snapshot())

    def test_terminal_preparation_and_age_do_not_release_a_fresh_reader(self):
        self.stage()
        self.assert_reload_blocked()
        self.assertNotIn(F.RUN + '.commit.json', self.store.files)

    def test_visible_commit_error_and_both_repairs_failed_cannot_publish_clear(self):
        self.stage()
        self.store.failure = ('visible', F.RUN + '.commit.json')
        self.store.fail_restore = self.store.fail_uncertain = True
        with self.assertRaises(Q.GuardError) as failed:
            self.finalize()
        self.assertFalse(failed.exception.preservation_confirmed)
        self.assertFalse(failed.exception.active_present)
        self.assert_reload_blocked()

    def test_visible_unlink_error_and_both_repairs_failed_leave_orphan_blocked(self):
        self.stage()
        self.store.failure = ('visible', 'unlink')
        self.store.fail_restore = self.store.fail_uncertain = True
        with self.assertRaises(Q.GuardError) as failed:
            self.finalize()
        self.assertFalse(failed.exception.preservation_confirmed)
        self.assertFalse(failed.exception.active_present)
        self.assert_reload_blocked()

    def test_partial_commit_with_both_repairs_failed_is_not_clear(self):
        self.stage()
        self.store.failure = ('partial', F.RUN + '.commit.json')
        self.store.fail_restore = self.store.fail_uncertain = True
        with self.assertRaises(Q.GuardError):
            self.finalize()
        self.assert_reload_blocked()

    def test_every_incomplete_finalization_prefix_blocks_without_active(self):
        self.stage()
        self.finalize()
        self.assert_reload_blocked()
        self.acknowledge_fixture()
        full = self.store.snapshot()
        names = [F.RUN + '.' + suffix + '.json' for suffix in
                 ('intent', 'terminal', 'host-accepted', 'finalize-observation',
                  'release-authority', 'commit', 'host-ack')]
        self.assertTrue(Q.history_clear(full, self.guard.host_verifier))
        for missing in names:
            with self.subTest(missing=missing):
                self.store.files = {name: raw for name, raw in full.items() if name != missing}
                self.assert_reload_blocked()

    def test_valid_commit_does_not_override_uncertain_or_foreign_active(self):
        self.stage()
        self.finalize()
        self.acknowledge_fixture()
        full = self.store.snapshot()
        for name, raw in (
                (F.RUN + '.uncertain.json', Q.encode({'uncertain': True})),
                ('active.json', Q.encode(self.intent))):
            with self.subTest(name=name):
                self.store.files = dict(full)
                self.store.files[name] = raw
                self.assert_reload_blocked()

    def test_each_persisted_record_is_hash_bound_not_just_its_filename(self):
        self.stage()
        self.finalize()
        self.acknowledge_fixture()
        full = self.store.snapshot()
        for name, raw in full.items():
            with self.subTest(name=name):
                self.store.files = dict(full)
                value = Q.decode(raw)
                (value['payload'] if name.endswith('.host-ack.json') else value)['owner']['nonce'] = 'f' * 64
                self.store.files[name] = Q.encode(value)
                self.assert_reload_blocked()

    def test_duplicate_finalize_cannot_delete_or_rewrite_committed_history(self):
        self.stage()
        self.finalize()
        self.acknowledge_fixture()
        before, actions = self.store.snapshot(), list(self.store.actions)
        with self.assertRaises(Q.GuardError):
            self.finalize()
        self.assertEqual(before, self.store.snapshot())
        self.assertEqual(actions, self.store.actions)
        self.assertTrue(Q.history_clear(before, self.guard.host_verifier))

    def test_completed_run_prevents_receipt_consumption_or_permit_reuse_by_new_owner(self):
        self.stage()
        self.finalize()
        self.acknowledge_fixture()
        before = self.store.snapshot()
        for reused in ('approvalReceiptSha256', 'consumedSha256', 'ownerPermitSha256'):
            with self.subTest(reused=reused):
                new = F.intent()
                new['runId'] = 'active-recovery-fedcba98-7654-4321-8abc-fedcba987654'
                new['jobId'] = 'fd-recovery-fedcba98765443218abcfedcba987654'
                new['owner'] = {'actor': 'independent-native-qa',
                    'generation': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'nonce': 'e' * 64}
                for key in ('approvalReceiptSha256', 'consumedSha256', 'ownerPermitSha256'):
                    if key != reused:
                        new[key] = 'e' * 64
                with self.assertRaises(Q.GuardError):
                    Q.RecoveryGuard(self.store, lambda: F.NOW,
                        host_verifier=self.guard.host_verifier).begin(new)
                self.assertEqual(before, self.store.snapshot())

    def test_each_scan_requires_exact_no_process_no_tcp_identity_not_two_booleans(self):
        self.sha = self.guard.begin(self.intent)['activeSha256']
        changes = (
            lambda o: o['scans'][0].update(complete=False),
            lambda o: o['scans'][1].update(deviceOwners=[{'pid': 123, 'startTicks': 1}]),
            lambda o: o['scans'][0].update(controlConnections=[{'inode': '7'}]),
            lambda o: o['scans'][1].update(stdinOwners=[123]),
            lambda o: o['scans'][1]['selfExcluded'].update(startTicks=True),
            lambda o: o['scans'][1].update(observedAt=o['scans'][0]['observedAt']),
            lambda o: o['observer'].update(closedBeforeScans=False),
            lambda o: o['serviceInstance'].update(mainPid=999),
            lambda o: o.update(metadataAfterSha256='e' * 64),
            lambda o: o.update(productJournalAfterSha256='e' * 64),
        )
        before = self.store.snapshot()
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                proof = F.proof(self.intent, self.sha)
                change(proof['observation'])
                with self.assertRaises(Q.GuardError):
                    self.guard.stage_terminal(self.intent['owner'], self.sha, proof)
                self.assertEqual(before, self.store.snapshot())

    def test_fresh_final_observation_must_still_match_original_service_job_and_terminal(self):
        self.stage()
        before = self.store.snapshot()
        for key in ('jobId', 'queryRevision', 'completed', 'cancelled'):
            with self.subTest(key=key):
                observation = F.fresh(self.intent, self.sha)
                observation['terminal'][key] = {'jobId': 'other', 'queryRevision': 3,
                    'completed': 1, 'cancelled': False}[key]
                with self.assertRaises(Q.GuardError):
                    self.guard.finalize(self.intent['owner'], self.sha,
                        F.acceptance(self.intent, self.sha, self.proof), observation)
                self.assertEqual(before, self.store.snapshot())

    def test_history_parser_does_not_mutate_input_or_claim_remote_integration(self):
        self.stage()
        self.finalize()
        self.acknowledge_fixture()
        before = self.store.snapshot()
        self.assertTrue(Q.history_clear(before, self.guard.host_verifier))
        self.assertEqual(before, self.store.snapshot())
        self.assertEqual('not-integrated-execution-disabled', Q.INTEGRATION_STATUS)

    def test_successful_remote_prepare_without_ack_or_real_provider_is_still_held(self):
        self.stage()
        receipt = self.finalize()
        self.assertTrue(receipt['preparedRelease'])
        self.assertTrue(receipt['logicalQuarantineRetained'])
        self.assert_reload_blocked()
        verifier, _ack = self.acknowledge_fixture()
        self.assertTrue(Q.history_clear(self.store.snapshot(), verifier))
        for unavailable in (None, True, {'keyId': verifier.key_id, 'verify': True}):
            with self.assertRaises(Q.GuardError):
                Q.history_clear(self.store.snapshot(), unavailable)

    def test_verifier_exceptions_or_truthy_non_boolean_values_never_authenticate(self):
        self.stage()
        self.finalize()
        verifier, _ack = self.acknowledge_fixture()
        def broken(_message, _signature):
            raise OSError('synthetic verification provider failure')
        for verify in (broken, lambda _m, _s: 1, lambda _m, _s: 'true', lambda _m, _s: False):
            candidate = Q.TrustedHostAckVerifier(verifier.key_id, verifier.finalize_source_sha256, verify)
            with self.assertRaises(Q.GuardError):
                Q.history_clear(self.store.snapshot(), candidate)

    def test_ack_context_source_signature_and_foreign_key_are_not_self_authorizing(self):
        self.stage()
        self.finalize()
        verifier, ack = self.acknowledge_fixture()
        original = self.store.snapshot()
        changes = (
            lambda v: v.update(keyId='ed25519-sha256:' + '0' * 64),
            lambda v: v.update(publicKey='untrusted-key-from-request'),
            lambda v: v.update(signatureB64='A' * 88),
            lambda v: v['payload'].update(finalizeSourceSha256='1' * 64),
            lambda v: v['payload'].update(commitSha256='0' * 64),
            lambda v: v['payload'].update(finalizeReceiptSha256='0' * 64),
            lambda v: v['payload'].update(transportEvidenceSha256='0' * 64),
            lambda v: v['payload']['owner'].update(generation='dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
            lambda v: v['payload']['owner'].update(nonce='e' * 64),
            lambda v: v['payload'].update(bootId='foreign-boot'),
        )
        for index, change in enumerate(changes):
            with self.subTest(index=index):
                value = copy.deepcopy(ack)
                change(value)
                self.assertNotEqual(ack, value)
                self.store.files = dict(original)
                self.store.files[F.RUN + '.host-ack.json'] = Q.encode(value)
                with self.assertRaises(Q.GuardError):
                    Q.history_clear(self.store.snapshot(), verifier)


class SharedSnapshot(object):
    """Only locking/bytes fixture; actual shared production parser decides admission."""
    def __init__(self, memory):
        self.memory, self.held, self.calls = memory, 0, 0
        self.identity = ('synthetic-active-inode', 17)
        self.error = None

    @contextlib.contextmanager
    def snapshot(self):
        self.calls += 1
        if self.error:
            raise self.error
        self.held += 1
        try:
            parsed = Q.admission_state(self.memory.snapshot())
            yield P.GuardSnapshot(None, None) if parsed is None else P.GuardSnapshot(parsed[1], self.identity)
        finally:
            self.held -= 1


class IndependentPsAdmissionBoundaries(unittest.TestCase):
    def setUp(self):
        self.memory = F.MemoryStore()
        self.intent = F.intent()
        self.token = 'ab' * 32
        fixture = os.path.join(ROOT, 'engineering/fz3b/product/resources/fixture')
        with open(os.path.join(fixture, 'query-template.json'), 'rb') as stream:
            self.query = json.loads(stream.read().decode('utf-8'))
        self.query['revision'] = self.intent['expectedQueryRevision']
        with open(os.path.join(fixture, 'input.jpg'), 'rb') as stream:
            self.jpeg = stream.read()
        self.metadata = P.canonical({'job_id': self.intent['jobId'], 'frame_id': 0,
            'video_time_s': 0.0, 'width': 914, 'height': 512})
        self.intent.update(ownerPermitSha256=P.sha(bytes.fromhex(self.token)),
            queryBodySha256=P.sha(P.canonical(self.query)), inputMetadataSha256=P.sha(self.metadata))
        self.core = Q.RecoveryGuard(self.memory, lambda: F.NOW)
        self.active_sha = self.core.begin(self.intent)['activeSha256']
        self.store = SharedSnapshot(self.memory)
        self.activity = {'inferenceAlive': False, 'frequencyChanging': False, 'pendingWork': 0,
            'inferenceState': 'STOPPED', 'inferenceError': None}
        self.lock = threading.RLock()
        self.owner = object()
        self.gate = P.AdmissionGate(self.store, Q.BOOT, self.intent['serviceInstance'],
            self.read_activity, self.lock,
            lambda: datetime.datetime.fromtimestamp(F.NOW / 1000, datetime.timezone.utc))

    def read_activity(self):
        self.assertEqual(1, self.store.held)
        self.assertTrue(self.lock._is_owned())
        return self.activity

    def recovery(self):
        return {'schemaVersion': 1, 'method': P.METHOD, 'activeSha256': self.active_sha,
            'owner': copy.deepcopy(self.intent['owner']), 'runId': self.intent['runId'],
            'action': self.intent['action'], 'planSha256': self.intent['planSha256'],
            'jobId': self.intent['jobId'], 'expectedQueryRevision': self.intent['expectedQueryRevision'],
            'serviceInstance': copy.deepcopy(self.intent['serviceInstance']), 'permitToken': self.token}

    def command(self, op, body=None, owner=None):
        with self.gate.command(self.owner if owner is None else owner, op,
                {'op': op} if body is None else body) as scope:
            self.assertEqual(0 if scope.mode == 'quarantined-unreadable' else 1, self.store.held)
            if scope.mode == 'quarantined-unreadable':
                self.assertTrue(scope.cached_status)
            return scope

    def begin_upload(self):
        self.gate.bind_connection(self.owner, self.recovery())
        self.command('queries', self.query)
        return self.command('upload_begin', {'op': 'upload_begin', 'job_id': self.intent['jobId']}).ticket

    def finish_upload(self):
        ticket = self.begin_upload()
        with self.gate.frame(self.owner, self.metadata, self.jpeg):
            self.assertEqual(1, self.store.held)
        self.command('upload_finish', {'op': 'upload_finish', 'job_id': self.intent['jobId'], 'frame_count': 1})
        return ticket

    def test_old_protocol_mutations_and_input_frames_cannot_cross_real_shared_guard(self):
        self.gate.bind_connection(self.owner, None)
        effects = []
        for op in ('queries', 'start', 'stop', 'settings', 'cpu_frequency', 'upload_begin',
                   'upload_finish', 'upload_cancel', 'preview', 'unknown'):
            with self.subTest(op=op):
                with self.assertRaises(ValueError):
                    with self.gate.command(self.owner, op, {'op': op}):
                        effects.append(op)
        with self.assertRaises(ValueError):
            with self.gate.frame(self.owner, self.metadata, self.jpeg):
                effects.append('INPUT_FRAME')
        self.assertEqual([], effects)
        for op in ('hello', 'status', 'frame_get'):
            self.assertTrue(self.command(op).cached_status)

    def test_orphan_partial_and_unknown_inventory_do_not_turn_into_absent_guard(self):
        original = self.memory.snapshot()
        for files in (
                {name: raw for name, raw in original.items() if name != 'active.json'},
                {'active.json': b'{'},
                dict(original, **{F.RUN + '.uncertain.json': b'{}\n'}),
                dict(original, **{'unexpected.tmp': b'{}\n'})):
            self.memory.files = files
            with self.assertRaises(ValueError):
                self.command('queries', self.query)
            self.assertTrue(self.command('status').cached_status)

    def test_each_claim_binding_and_internal_service_busy_read_are_mandatory(self):
        for key in self.recovery():
            with self.subTest(key=key):
                changed = self.recovery()
                del changed[key]
                with self.assertRaises(ValueError):
                    self.gate.bind_connection(self.owner, changed)
        for changed in ({'inferenceAlive': True}, {'frequencyChanging': True},
                        {'pendingWork': 1}, {'pendingWork': False}, {'inferenceState': 'DRAINING'}):
            original = self.activity
            self.activity = dict(original, **changed)
            with self.assertRaises(ValueError):
                self.gate.bind_connection(self.owner, self.recovery())
            self.activity = original
        self.gate.bind_connection(self.owner, self.recovery())
        with self.assertRaises(ValueError):
            self.gate.bind_connection(object(), self.recovery())

    def test_fixed_image_query_and_metadata_hashes_cannot_be_replaced_with_self_hashes(self):
        self.begin_upload()
        for meta, image in ((self.metadata + b' ', self.jpeg), (self.metadata, self.jpeg + b' ')):
            with self.assertRaises(ValueError):
                with self.gate.frame(self.owner, meta, image):
                    self.fail('Altered frame was admitted')
        with self.gate.frame(self.owner, self.metadata, self.jpeg):
            pass
        with self.assertRaises(ValueError):
            with self.gate.frame(self.owner, self.metadata, self.jpeg):
                self.fail('Second frame was admitted')

    def test_expired_foreground_fault_is_denied_but_existing_drain_does_not_read_guard(self):
        ticket = self.finish_upload()
        self.gate.now = lambda: datetime.datetime(2026, 10, 17, 0, 5, tzinfo=datetime.timezone.utc)
        with self.assertRaises(ValueError):
            self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': self.intent['jobId']})
        self.store.error = PermissionError('synthetic guard loss')
        reads = self.store.calls
        with self.gate.drain(ticket, self.owner, self.intent['jobId']) as scope:
            self.assertEqual('already-admitted-drain-only', scope.mode)
        self.assertEqual(reads, self.store.calls)
        with self.assertRaises(ValueError):
            with self.gate.drain(ticket, object(), self.intent['jobId']):
                self.fail('Another owner acquired cleanup capability')

    def test_a_copied_or_retired_drain_ticket_cannot_be_reused(self):
        ticket = self.finish_upload()
        copied = P.DrainTicket(ticket.owner, ticket.job_id, ticket.active_sha, ticket._seal)
        with self.assertRaises(ValueError):
            with self.gate.drain(copied, self.owner, self.intent['jobId']):
                self.fail('A copied ticket was accepted')
        self.gate.retire_drain_ticket(ticket, self.owner, self.intent['jobId'])
        with self.assertRaises(ValueError):
            with self.gate.drain(ticket, self.owner, self.intent['jobId']):
                self.fail('A retired ticket was accepted')

    def test_terminal_staging_revokes_new_admission_without_blocking_admitted_cleanup(self):
        ticket = self.finish_upload()
        self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': self.intent['jobId']})
        self.core.stage_terminal(self.intent['owner'], self.active_sha, F.proof(self.intent, self.active_sha))
        with self.assertRaises(ValueError):
            self.command('queries', self.query)
        with self.gate.drain(ticket, self.owner, self.intent['jobId']):
            pass

    def test_restart_instance_or_foreign_inode_cannot_inherit_mutation_owner(self):
        self.gate.bind_connection(self.owner, self.recovery())
        self.store.identity = ('foreign-inode', 99)
        with self.assertRaises(ValueError):
            self.command('queries', self.query)
        other = dict(self.intent['serviceInstance'], startTicks=self.intent['serviceInstance']['startTicks'] + 1)
        restarted = P.AdmissionGate(self.store, Q.BOOT, other,
            self.read_activity, self.lock, self.gate.now)
        with self.assertRaises(ValueError):
            restarted.bind_connection(object(), self.recovery())

    def test_service_startup_effect_is_held_under_shared_guard_check(self):
        effects = []
        with self.assertRaises(ValueError):
            with self.gate.startup():
                effects.append('forbidden-hardware-init')
        self.memory.files = {}
        with self.gate.startup() as scope:
            self.assertEqual(1, self.store.held)
            self.assertFalse(scope.cached_status)
            effects.append('synthetic-init-only')
        self.assertEqual(['synthetic-init-only'], effects)
        self.store.error = PermissionError('synthetic missing admission lock')
        with self.assertRaises(OSError):
            with self.gate.startup():
                effects.append('forbidden-missing-lock-init')


if __name__ == '__main__':
    unittest.main()
