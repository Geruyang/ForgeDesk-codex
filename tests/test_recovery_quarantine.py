"""Pure guard persistence/syscall fixtures; no Linux store, app, SSH or device."""
import ast
import base64
import contextlib
import copy
import importlib.util
import os
import stat
import types
import unittest
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FILE = os.path.join(ROOT, 'engineering/fz3b/tools/recovery_quarantine.py')
SPEC = importlib.util.spec_from_file_location('quarantine_under_test', FILE)
Q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(Q)
RUN = 'active-recovery-01234567-89ab-4cde-8fab-0123456789ab'
OWNER = {'actor': 'independent-native-qa', 'generation': 'abcdefab-cdef-4abc-8def-abcdefabcdef', 'nonce': '1' * 64}
NOW = Q.milliseconds('2026-10-17T00:01:00.000Z')


class MemoryStore(object):
    def __init__(self):
        self.files = {}
        self.journal = '2' * 64
        self.actions = []
        self.depth = 0
        self.failure = None
        self.fail_restore = False
        self.fail_uncertain = False
        self.boot = Q.BOOT

    def snapshot(self): return copy.deepcopy(self.files)
    def product_journal_sha256(self): return self.journal
    def current_boot_id(self): return self.boot

    @contextlib.contextmanager
    def admission_exclusive(self):
        self.depth += 1
        self.actions.append('admission-enter')
        try: yield
        finally:
            self.actions.append('admission-exit'); self.depth -= 1

    def create(self, name, raw):
        assert self.depth == 1, 'Every mutation and repair must remain under short admission EX'
        if self.fail_uncertain and name.endswith('.uncertain.json'): raise OSError('uncertain record unavailable')
        if self.failure == ('before', name):
            self.failure = None; raise OSError('write failed before create')
        if name in self.files: raise FileExistsError(name)
        self.files[name] = raw
        self.actions.append(('create', name))
        if self.failure == ('partial', name):
            self.failure = None; self.files[name] = raw[:max(1, len(raw) // 2)]; raise OSError('partial write')
        if self.failure == ('visible', name):
            self.failure = None; raise OSError('file visible but fsync failed')

    def create_if_same(self, name, raw):
        if name in self.files:
            if self.files[name] != raw: raise ValueError('existing bytes differ')
        else: self.create(name, raw)

    def restore_active(self, raw):
        assert self.depth == 1
        if self.fail_restore: raise OSError('restore unavailable')
        self.create_if_same('active.json', raw)

    def remove_active_exact(self, raw):
        assert self.depth == 1
        if self.files.get('active.json') != raw: raise ValueError('active changed')
        if self.failure == ('before', 'unlink'):
            self.failure = None; raise OSError('unlink refused')
        del self.files['active.json']; self.actions.append('unlink-active')
        if self.failure == ('visible', 'unlink'):
            self.failure = None; raise OSError('unlink visible but directory fsync failed')


def intent():
    return {'schemaVersion': 1, 'method': Q.METHOD, 'runId': RUN, 'action': 'upload-cancel',
            'planSha256': '3' * 64, 'approvalIntentSha256': '4' * 64, 'approvalReceiptSha256': '5' * 64,
            'consumedSha256': '6' * 64, 'owner': copy.deepcopy(OWNER), 'bootId': Q.BOOT, 'profileSha256': Q.PROFILE,
            'baselineSha256': '7' * 64, 'sourcePinsSha256': '8' * 64,
            'fixtureSha256': 'febcb9d93517f3c98eadb5d98eea6808f243fb6a1d4b61215cd981503de98e56',
            'metadataSha256': '9' * 64, 'productJournalSha256': '2' * 64, 'ownerPermitSha256': 'a' * 64,
            'serviceInstance': {'mainPid': 3925, 'startTicks': 1000},
            'imageSha256': '06dd779d1450c835255833be19c84f6636c2de99313713d80c850fa572c25967',
            'queryBodySha256': 'b' * 64, 'inputMetadataSha256': 'c' * 64,
            'jobId': 'fd-recovery-0123456789ab4cde8fab0123456789ab', 'expectedQueryRevision': 2,
            'createdAt': '2026-10-17T00:00:00.000Z', 'approvalExpiresAt': '2026-10-17T00:05:00.000Z'}


def terminal_state(i, cancelled=True):
    return {'state': 'STOPPED', 'error': None, 'jobId': i['jobId'], 'queryRevision': 2,
            'received': 1, 'completed': 0 if cancelled else 1, 'queued': 0, 'finished': True, 'cancelled': cancelled}


def observation(i, active_sha, cancelled=True):
    def scan(at):
        return {'complete': True, 'deviceOpened': False, 'deviceOwners': [], 'controlConnections': [], 'stdinOwners': [],
                'newPidsAtEnd': [], 'selfExcluded': {'pid': 123, 'startTicks': 456}, 'bootId': Q.BOOT,
                'metadataSha256': i['metadataSha256'], 'productJournalSha256': i['productJournalSha256'], 'observedAt': at}
    return {'activeSha256': active_sha, 'owner': copy.deepcopy(OWNER), 'bootId': Q.BOOT,
            'serviceInstance': copy.deepcopy(i['serviceInstance']), 'metadataBeforeSha256': i['metadataSha256'], 'metadataAfterSha256': i['metadataSha256'],
            'productJournalBeforeSha256': i['productJournalSha256'], 'productJournalAfterSha256': i['productJournalSha256'],
            'terminal': terminal_state(i, cancelled),
            'observer': {'connectionId': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'sequential': True,
                         'closedBeforeScans': True, 'statusMayWriteR5Telemetry': True},
            'scans': [scan('2026-10-17T00:00:30.000Z'), scan('2026-10-17T00:00:30.100Z')], 'observedAt': '2026-10-17T00:00:30.200Z'}


def proof(i, active_sha):
    return {'schemaVersion': 1, 'method': 'fz3b-recovery-terminal-proof-v1', 'runId': RUN,
            'activeSha256': active_sha, 'owner': copy.deepcopy(OWNER), 'action': i['action'], 'coverage': 'active-interrupted',
            'activeSample': {'state': 'RUNNING', 'error': None, 'jobId': i['jobId'], 'queryRevision': 2,
                             'received': 1, 'completed': 0, 'queued': 0, 'finished': True, 'cancelled': False},
            'fault': {'action': i['action'], 'attemptCount': 1, 'connectionId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                      'ownCloseObserved': True,
                      'cancelAck': {'requestId': 'cancel-' + i['jobId'][len('fd-recovery-'):], 'op': 'upload_cancel',
                                    'ok': True, 'jobId': i['jobId'], 'cancelled': True, 'queued': 0}},
            'observation': observation(i, active_sha)}


def acceptance(i, active_sha, p):
    return {'schemaVersion': 1, 'method': 'fz3b-recovery-host-accepted-v1', 'runId': RUN, 'owner': copy.deepcopy(OWNER),
            'activeSha256': active_sha, 'proofSha256': Q.digest(Q.encode(p)), 'rawReceiptSha256': 'd' * 64,
            'acceptanceId': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'acceptedAt': '2026-10-17T00:00:31.000Z'}


def fresh(i, active_sha, cancelled=True):
    value = observation(i, active_sha, cancelled)
    value['scans'][0]['observedAt'] = '2026-10-17T00:00:32.000Z'
    value['scans'][1]['observedAt'] = '2026-10-17T00:00:32.100Z'
    value['observedAt'] = '2026-10-17T00:00:32.200Z'
    return value


def host_ack_fixture(i, p, files):
    """Synthetic trusted-verifier contract only, NOT Ed25519/board validation."""
    key_id = 'ed25519-sha256:' + 'e' * 64
    payload = {'schemaVersion': 1, 'method': 'fz3b-recovery-host-commit-ack-v1',
               'acceptanceId': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'runId': i['runId'],
               'owner': copy.deepcopy(i['owner']), 'action': i['action'], 'bootId': i['bootId'],
               'profileSha256': i['profileSha256'], 'planSha256': i['planSha256'],
               'approvalIntentSha256': i['approvalIntentSha256'], 'approvalReceiptSha256': i['approvalReceiptSha256'],
               'consumedSha256': i['consumedSha256'], 'coverage': p['coverage'],
               'acceptedAt': '2026-10-17T00:00:40.000Z', 'keyId': key_id,
               'scope': 'exact-finalize-completed-only', 'transportEvidenceSha256': 'f' * 64,
               'finalizeSourceSha256': '0' * 64}
    for field, suffix in (('activeSha256', 'intent'), ('proofSha256', 'terminal'),
                          ('hostAcceptedSha256', 'host-accepted'), ('finalizeObservationSha256', 'finalize-observation'),
                          ('releaseAuthoritySha256', 'release-authority'), ('commitSha256', 'commit')):
        payload[field] = Q.digest(files[i['runId'] + '.' + suffix + '.json'])
    payload['finalizeReceiptSha256'] = Q.digest(Q.encode(Q.prepared_release_receipt(i, p, files[i['runId'] + '.commit.json'])))
    message = Q.ACK_DOMAIN + Q.encode(payload)
    signature = b'\xa5' * 64
    verifier = Q.TrustedHostAckVerifier(key_id, '0' * 64,
        lambda actual, sig: actual == message and sig == signature)
    ack = {'schemaVersion': 1, 'algorithm': 'Ed25519', 'keyId': key_id, 'payload': payload,
           'signatureB64': base64.b64encode(signature).decode('ascii')}
    return verifier, ack


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore(); self.guard = Q.RecoveryGuard(self.store, lambda: NOW)
        self.intent = intent()

    def begin(self):
        self.permit = self.guard.begin(self.intent); self.active_sha = self.permit['activeSha256']
        return self.active_sha

    def stage(self):
        self.begin(); self.proof = proof(self.intent, self.active_sha)
        self.guard.stage_terminal(OWNER, self.active_sha, self.proof)

    def finish(self):
        return self.guard.finalize(OWNER, self.active_sha, acceptance(self.intent, self.active_sha, self.proof), fresh(self.intent, self.active_sha))

    def publish(self):
        self.verifier, self.ack = host_ack_fixture(self.intent, self.proof, self.store.snapshot())
        self.guard.host_verifier = self.verifier
        return self.guard.publish_host_ack(OWNER, self.active_sha, self.ack)

    def blocked_after_restart(self):
        restarted = Q.RecoveryGuard(self.store, lambda: NOW)
        with self.assertRaises((Q.GuardError, ValueError)): restarted.assert_clear()

    def test_begin_durable_active_survives_a_new_instance_without_any_expiry_clear(self):
        self.assertTrue(self.guard.assert_clear()); self.begin(); self.blocked_after_restart()
        later = Q.RecoveryGuard(self.store, lambda: NOW + 999999999)
        with self.assertRaises(Q.GuardError): later.assert_clear()
        self.assertNotIn('permitToken', repr(self.store.files)); self.assertNotIn('ownerPermitSha256', self.permit)

    def test_strict_finalize_requires_exact_owner_host_accepted_and_fresh_observation(self):
        self.stage(); result = self.finish()
        self.assertTrue(result['guardAbsent']); self.assertTrue(result['releaseDirectorySynced'])
        self.assertTrue(result['preparedRelease']); self.assertTrue(result['logicalQuarantineRetained'])
        self.blocked_after_restart()
        self.assertTrue(self.publish()['logicalQuarantineClear'])
        self.assertTrue(Q.RecoveryGuard(self.store, lambda: NOW + 999999, self.verifier).assert_clear())
        self.assertFalse(result['unknownHistoryRewritten']); self.assertFalse(result['automaticReplay'])

    def test_no_automatic_replay_or_reuse_of_run_receipt_or_owner(self):
        self.stage(); self.finish(); self.publish()
        with self.assertRaises(Q.GuardError): self.guard.begin(self.intent)

    def test_bad_intent_schema_target_expiry_token_or_service_instance_fails_before_writes(self):
        for change in ('extra', 'boot', 'expired', 'bool', 'token', 'fixture', 'service'):
            value = intent()
            if change == 'extra': value['authorized'] = True
            elif change == 'boot': value['bootId'] = 'new-boot'
            elif change == 'expired': value['approvalExpiresAt'] = '2026-10-17T00:00:00.001Z'
            elif change == 'bool': value['expectedQueryRevision'] = True
            elif change == 'token': value['ownerPermitSha256'] = 'not-a-hash'
            elif change == 'fixture': value['fixtureSha256'] = '0' * 64
            else: value['serviceInstance']['mainPid'] = True
            with self.assertRaises(Q.GuardError): self.guard.begin(value)
            self.assertEqual({}, self.store.files)

    def test_foreign_owner_wrong_preimage_and_changed_journal_keep_quarantine(self):
        self.begin()
        for owner, digest in (({**OWNER, 'nonce': 'f' * 64}, self.active_sha), (OWNER, 'f' * 64)):
            with self.assertRaises(Q.GuardError): self.guard.stage_terminal(owner, digest, proof(self.intent, self.active_sha))
            self.blocked_after_restart()
        self.store.journal = 'f' * 64
        with self.assertRaises(Q.GuardError): self.guard.stage_terminal(OWNER, self.active_sha, proof(self.intent, self.active_sha))
        self.blocked_after_restart()

    def test_corrupt_partial_or_orphan_records_never_look_clear(self):
        for name, raw in (('active.json', b'{'), (RUN + '.intent.json', Q.encode(intent())),
                          ('unexpected.tmp', b'{}\n'), (RUN + '.commit.json', Q.encode({'committed': True}))):
            self.store.files = {name: raw}; self.blocked_after_restart()

    def test_begin_partial_create_or_visible_fsync_failure_is_persistently_blocked(self):
        for name in (RUN + '.intent.json', 'active.json'):
            for mode in ('before', 'partial', 'visible'):
                self.setUp(); self.store.failure = (mode, name)
                with self.assertRaises(Q.GuardError) as failure: self.guard.begin(self.intent)
                self.assertEqual('guard-mutation-unknown', failure.exception.code)
                self.blocked_after_restart()

    def test_terminal_write_failures_remain_blocked_after_restart(self):
        for mode in ('before', 'partial', 'visible'):
            self.setUp(); self.begin(); self.store.failure = (mode, RUN + '.terminal.json')
            with self.assertRaises(Q.GuardError): self.guard.stage_terminal(OWNER, self.active_sha, proof(self.intent, self.active_sha))
            self.blocked_after_restart()

    def test_all_finalize_write_unlink_fsync_failures_hold_durably_after_restart(self):
        for name in (RUN + '.host-accepted.json', RUN + '.finalize-observation.json', RUN + '.release-authority.json', 'unlink', RUN + '.commit.json'):
            for mode in ('before', 'visible'):
                self.setUp(); self.stage(); self.store.failure = (mode, name)
                with self.assertRaises(Q.GuardError) as failure: self.finish()
                self.assertTrue(failure.exception.preservation_confirmed)
                self.blocked_after_restart()
                self.assertEqual(0, self.store.depth)

    def test_orphan_prepared_after_unlink_without_commit_blocks_restart(self):
        self.stage()
        self.store.files[RUN + '.host-accepted.json'] = Q.encode(acceptance(self.intent, self.active_sha, self.proof))
        self.store.files[RUN + '.release-authority.json'] = Q.encode({'not': 'a real commit'})
        del self.store.files['active.json']
        self.blocked_after_restart()

    def test_independent_uncertain_marker_blocks_if_active_rebuild_fails(self):
        self.stage(); self.store.failure = ('visible', 'unlink'); self.store.fail_restore = True
        with self.assertRaises(Q.GuardError) as failure: self.finish()
        self.assertTrue(failure.exception.preservation_confirmed)
        self.assertFalse(failure.exception.active_present); self.blocked_after_restart()

    def test_active_rebuild_blocks_if_uncertain_marker_cannot_be_written(self):
        self.stage(); self.store.failure = ('visible', RUN + '.commit.json'); self.store.fail_uncertain = True
        with self.assertRaises(Q.GuardError) as failure: self.finish()
        self.assertTrue(failure.exception.preservation_confirmed); self.assertTrue(failure.exception.active_present)
        self.blocked_after_restart()

    def test_no_false_active_presence_claim_if_both_preservation_writes_fail(self):
        self.stage(); self.store.failure = ('visible', 'unlink'); self.store.fail_restore = self.store.fail_uncertain = True
        with self.assertRaises(Q.GuardError) as failure: self.finish()
        self.assertFalse(failure.exception.preservation_confirmed); self.assertFalse(failure.exception.active_present)
        self.blocked_after_restart()  # No commit exists at this failure point.

    def test_visible_commit_and_both_repairs_failed_never_looks_clear_after_restart(self):
        self.stage(); self.store.failure = ('visible', RUN + '.commit.json')
        self.store.fail_restore = self.store.fail_uncertain = True
        with self.assertRaises(Q.GuardError) as failure: self.finish()
        self.assertFalse(failure.exception.preservation_confirmed); self.assertFalse(failure.exception.active_present)
        self.assertIn(RUN + '.commit.json', self.store.files)
        self.blocked_after_restart()
        with self.assertRaises(Q.GuardError): Q.history_clear(self.store.snapshot())

    def test_host_ack_requires_a_trusted_provider_not_remote_claims_or_a_boolean(self):
        self.stage(); self.finish()
        verifier, ack = host_ack_fixture(self.intent, self.proof, self.store.snapshot())
        signed = self.store.snapshot(); signed[RUN + '.host-ack.json'] = Q.encode(ack)
        for provider in (None, True, {'trusted': True}, lambda _m, _s: True):
            with self.assertRaises(Q.GuardError): Q.history_clear(signed, provider)
        self.assertTrue(Q.history_clear(signed, verifier))
        self.assertEqual(6, len(self.store.files))  # Pure verification does not publish.

    def test_host_ack_rejects_bad_signature_key_context_source_and_noncanonical_base64(self):
        self.stage(); self.finish()
        verifier, ack = host_ack_fixture(self.intent, self.proof, self.store.snapshot())
        for changed in ('signature', 'b64', 'key', 'owner', 'source', 'receipt', 'transport', 'bool', 'oldtime', 'extra'):
            value = copy.deepcopy(ack)
            if changed == 'signature': value['signatureB64'] = base64.b64encode(b'\x00' * 64).decode('ascii')
            elif changed == 'b64': value['signatureB64'] += '\n'
            elif changed == 'key': value['keyId'] = 'ed25519-sha256:' + 'a' * 64
            elif changed == 'owner': value['payload']['owner']['nonce'] = '0' * 64
            elif changed == 'source': value['payload']['finalizeSourceSha256'] = 'a' * 64
            elif changed == 'receipt': value['payload']['finalizeReceiptSha256'] = 'a' * 64
            elif changed == 'transport': value['payload']['transportEvidenceSha256'] = 'a' * 64
            elif changed == 'bool': value['payload']['schemaVersion'] = True
            elif changed == 'oldtime': value['payload']['acceptedAt'] = '2026-10-17T00:00:00.000Z'
            else: value['payload']['authorized'] = True
            files = self.store.snapshot(); files[RUN + '.host-ack.json'] = Q.encode(value)
            with self.assertRaises(Q.GuardError): Q.history_clear(files, verifier)

    def test_host_ack_verifier_failure_or_nonboolean_result_keeps_history_held(self):
        self.stage(); self.finish()
        verifier, ack = host_ack_fixture(self.intent, self.proof, self.store.snapshot())
        files = self.store.snapshot(); files[RUN + '.host-ack.json'] = Q.encode(ack)
        for result in (False, 1, None, {'verified': True}):
            provider = Q.TrustedHostAckVerifier(verifier.key_id, verifier.finalize_source_sha256, lambda _m, _s: result)
            with self.assertRaises(Q.GuardError): Q.history_clear(files, provider)
        def unavailable(_m, _s): raise ImportError('No trusted crypto runtime')
        provider = Q.TrustedHostAckVerifier(verifier.key_id, verifier.finalize_source_sha256, unavailable)
        with self.assertRaises(Q.GuardError): Q.history_clear(files, provider)

    def test_host_ack_cannot_release_active_uncertain_foreign_or_unsupported_history(self):
        self.stage(); self.finish()
        verifier, ack = host_ack_fixture(self.intent, self.proof, self.store.snapshot())
        self.guard.host_verifier = verifier
        for name, raw in (('active.json', Q.encode(self.intent)), (RUN + '.uncertain.json', Q.encode({'unknown': True})),
                          ('foreign-file', b'{}\n')):
            before = self.store.snapshot(); self.store.files[name] = raw
            with self.assertRaises(Q.GuardError): self.guard.publish_host_ack(OWNER, self.active_sha, ack)
            self.store.files = before
        self.guard.publish_host_ack(OWNER, self.active_sha, ack)
        before = self.store.snapshot()
        with self.assertRaises(Q.GuardError): self.guard.publish_host_ack(OWNER, self.active_sha, ack)
        self.assertEqual(before, self.store.snapshot())

    def test_host_ack_write_failure_is_reported_unknown_and_never_claims_local_success(self):
        for mode in ('before', 'partial', 'visible'):
            self.setUp(); self.stage(); self.finish()
            self.store.failure = (mode, RUN + '.host-ack.json')
            with self.assertRaises(Q.GuardError) as failure: self.publish()
            self.assertTrue(failure.exception.preservation_confirmed)
            self.blocked_after_restart()

    def test_current_kernel_boot_not_caller_proof_controls_mutating_store_actions(self):
        self.store.boot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        with self.assertRaises(Q.GuardError): self.begin()
        self.assertEqual({}, self.store.files)
        self.store.boot = Q.BOOT; self.stage(); before = self.store.snapshot()
        self.store.boot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        with self.assertRaises(Q.GuardError): self.finish()
        self.assertEqual(before, self.store.snapshot()); self.blocked_after_restart()

    def test_active_and_terminal_false_counter_or_wrong_job_evidence_rejected(self):
        self.begin()
        for changed in ('idle', 'completed', 'queue', 'job', 'duplicate-fault', 'ack', 'terminal', 'service'):
            p = proof(self.intent, self.active_sha)
            if changed == 'idle': p['activeSample']['state'] = 'STOPPED'
            elif changed == 'completed': p['activeSample']['completed'] = 1
            elif changed == 'queue': p['activeSample']['queued'] = False
            elif changed == 'job': p['activeSample']['jobId'] = 'another'
            elif changed == 'duplicate-fault': p['fault']['attemptCount'] = 2
            elif changed == 'ack': p['fault']['cancelAck']['queued'] = False
            elif changed == 'terminal': p['observation']['terminal']['cancelled'] = False
            else: p['observation']['serviceInstance']['startTicks'] += 1
            with self.assertRaises(Q.GuardError): self.guard.stage_terminal(OWNER, self.active_sha, p)
            self.blocked_after_restart()

    def test_two_fresh_complete_scans_and_closed_sequential_observer_are_required(self):
        self.begin()
        for changed in ('one', 'device', 'tcp', 'stdin', 'self', 'newpid', 'closed', 'time', 'metadata'):
            p = proof(self.intent, self.active_sha); obs = p['observation']
            if changed == 'one': obs['scans'].pop()
            elif changed in ('device', 'tcp', 'stdin', 'newpid'):
                key = {'device': 'deviceOwners', 'tcp': 'controlConnections', 'stdin': 'stdinOwners', 'newpid': 'newPidsAtEnd'}[changed]
                obs['scans'][1][key] = [123]
            elif changed == 'self': obs['scans'][1]['selfExcluded']['startTicks'] += 1
            elif changed == 'closed': obs['observer']['closedBeforeScans'] = False
            elif changed == 'time': obs['scans'][1]['observedAt'] = obs['scans'][0]['observedAt']
            else: obs['metadataAfterSha256'] = 'f' * 64
            with self.assertRaises(Q.GuardError): self.guard.stage_terminal(OWNER, self.active_sha, p)

    def test_host_acceptance_or_fresh_recheck_failure_never_unlinks(self):
        self.stage()
        for changed in ('owner', 'proof', 'raw', 'time', 'terminal', 'observer'):
            accepted, observed = acceptance(self.intent, self.active_sha, self.proof), fresh(self.intent, self.active_sha)
            if changed == 'owner': accepted['owner']['nonce'] = 'f' * 64
            elif changed == 'proof': accepted['proofSha256'] = 'f' * 64
            elif changed == 'raw': accepted['rawReceiptSha256'] = ''
            elif changed == 'time': accepted['acceptedAt'] = '2026-10-17T00:00:20.000Z'
            elif changed == 'terminal': observed['terminal']['completed'] = 1
            else: observed['observer']['closedBeforeScans'] = False
            with self.assertRaises(Q.GuardError): self.guard.finalize(OWNER, self.active_sha, accepted, observed)
            self.blocked_after_restart()

    def test_not_covered_normal_completion_can_only_release_with_explicit_host_acceptance(self):
        self.begin(); p = proof(self.intent, self.active_sha); p['coverage'] = 'not-covered'; p['activeSample'] = None
        p['fault']['attemptCount'] = 0; p['fault']['action'] = None; p['fault']['cancelAck'] = None
        p['observation'] = observation(self.intent, self.active_sha, False)
        self.guard.stage_terminal(OWNER, self.active_sha, p)
        result = self.guard.finalize(OWNER, self.active_sha, acceptance(self.intent, self.active_sha, p), fresh(self.intent, self.active_sha, False))
        self.assertEqual('not-covered', result['coverage']); self.blocked_after_restart()
        self.proof = p; self.publish(); self.assertTrue(self.guard.assert_clear())

    def test_no_age_expiry_or_stale_proof_can_release(self):
        self.stage(); self.guard.now = lambda: NOW + 1000000
        with self.assertRaises(Q.GuardError): self.finish()
        self.blocked_after_restart()

    def test_shared_ps_admission_parser_refuses_staged_current_or_foreign_orphan(self):
        self.assertIsNone(Q.admission_state({}))
        self.begin(); parsed, raw = Q.admission_state(self.store.snapshot())
        self.assertEqual(self.intent, parsed); self.assertEqual(self.active_sha, Q.digest(raw))
        other = 'active-recovery-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.intent.json'
        values = self.store.snapshot(); values[other] = Q.encode(self.intent)
        with self.assertRaises(Q.GuardError): Q.admission_state(values)
        self.proof = proof(self.intent, self.active_sha)
        self.guard.stage_terminal(OWNER, self.active_sha, self.proof)
        with self.assertRaises(Q.GuardError): Q.admission_state(self.store.snapshot())
        self.finish()
        with self.assertRaises(Q.GuardError): Q.admission_state(self.store.snapshot())
        self.publish(); self.assertIsNone(Q.admission_state(self.store.snapshot(), self.verifier))

    def test_secure_store_metadata_rejects_links_hardlinks_modes_and_owners(self):
        for change in ({'st_mode': stat.S_IFLNK | 0o600}, {'st_nlink': 2}, {'st_uid': 1}, {'st_gid': 1},
                       {'st_mode': stat.S_IFREG | 0o644}, {'st_size': Q.MAX_FILE + 1}):
            values = dict(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1, st_size=1); values.update(change)
            with self.assertRaises(Q.GuardError): Q.SecureStore.regular(types.SimpleNamespace(**values))

    def test_secure_create_uses_exclusive_nofollow_and_full_write_loop(self):
        store = Q.SecureStore.__new__(Q.SecureStore); store.guard_fd = 4
        store.check = lambda: None; store.read_leaf = lambda _parent, _name: b'abcd'
        flags = getattr(Q.os, 'O_NOFOLLOW', 0x20000) | getattr(Q.os, 'O_NONBLOCK', 0x800)
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1, st_size=4)
        with mock.patch.object(Q.os, 'O_NOFOLLOW', flags & ~0x800, create=True), mock.patch.object(Q.os, 'O_NONBLOCK', 0x800, create=True), \
                mock.patch.object(Q.os, 'open', return_value=9) as opened, mock.patch.object(Q.os, 'fchown', create=True), \
                mock.patch.object(Q.os, 'fchmod', create=True), mock.patch.object(Q.os, 'write', side_effect=[1, 3]) as written, \
                mock.patch.object(Q.os, 'fstat', return_value=info), mock.patch.object(Q.os, 'fsync') as synced, mock.patch.object(Q.os, 'close'):
            store.create('active.json', b'abcd')
            self.assertTrue(opened.call_args.args[1] & Q.os.O_EXCL); self.assertTrue(opened.call_args.args[1] & Q.os.O_NOFOLLOW)
            self.assertEqual(2, written.call_count); self.assertEqual([mock.call(9), mock.call(4)], synced.call_args_list)

    def test_existing_repair_reconfirms_file_and_directory_sync_not_only_visible_bytes(self):
        store = Q.SecureStore.__new__(Q.SecureStore); store.guard_fd = 4
        def exists(_name, _raw): raise FileExistsError('visible existing record')
        store.create = exists; store.read_leaf = lambda _parent, _name: b'abcd'
        info = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1,
                                     st_size=4, st_dev=1, st_ino=2, st_mtime_ns=3, st_ctime_ns=4)
        with mock.patch.object(Q.os, 'O_NOFOLLOW', 0x20000, create=True), mock.patch.object(Q.os, 'O_NONBLOCK', 0x800, create=True), \
                mock.patch.object(Q.os, 'open', return_value=9), mock.patch.object(Q.os, 'fstat', return_value=info), \
                mock.patch.object(Q.os, 'stat', return_value=info), mock.patch.object(Q.os, 'close'), \
                mock.patch.object(Q.os, 'fsync') as synced:
            store.create_if_same('active.json', b'abcd')
            self.assertEqual([mock.call(9), mock.call(4)], synced.call_args_list)
            synced.side_effect = OSError('sync failed')
            with self.assertRaises(OSError): store.create_if_same('active.json', b'abcd')

    def test_module_is_python36_and_import_has_no_network_or_process_execution(self):
        with open(FILE, 'r', encoding='ascii') as stream: source = stream.read()
        tree = ast.parse(source, feature_version=(3, 6))
        imports = {node.names[0].name for node in ast.walk(tree) if isinstance(node, ast.Import)}
        self.assertFalse(imports & {'socket', 'subprocess', 'ctypes', 'paramiko', 'serial'})
        self.assertEqual('not-integrated-execution-disabled', Q.INTEGRATION_STATUS)
        self.assertEqual(len(Q.SUPPORTED_ENTRYPOINTS), len(set(Q.SUPPORTED_ENTRYPOINTS)))


if __name__ == '__main__': unittest.main()
