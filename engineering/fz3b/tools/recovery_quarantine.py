"""Fixed FZ3B durable recovery guard. Definitions only; Python 3.6 stdlib.

Integration is separate: every supported producer must hold the product flock,
and PS admission must use admission.lock around its guard read and side effect.
This module never runs the application, protocol, SSH, loader or a device.
"""
import base64
import binascii
import calendar
import contextlib
import copy
import hashlib
import json
import math
import os
import re
import stat
import sys
import time

APP = '/root/fz3b-vision-console-20261009-001'
DIRECTORY = '.forgedesk-recovery-quarantine'
PRODUCT = '.forgedesk-product-operations'
BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
PROFILE = '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd'
METHOD = 'fz3b-active-recovery-maintenance-v2'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z')
HEX = re.compile(r'[a-f0-9]{64}\Z')
RUN = re.compile(r'active-recovery-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\Z')
MAX_FILE, MAX_FILES, MAX_TOTAL, FRESH_MS = 65536, 258, 4 * 1048576, 120000
RECORDS = ('intent', 'terminal', 'host-accepted', 'finalize-observation', 'release-authority', 'commit', 'host-ack')
SUFFIXES = RECORDS + ('uncertain',)
ACK_DOMAIN = b'ForgeDesk/FZ3B/RecoveryHostCommitAck/v1\0'
ACK_KEYS = ('schemaVersion', 'method', 'acceptanceId', 'runId', 'owner', 'action', 'bootId', 'profileSha256',
            'planSha256', 'approvalIntentSha256', 'approvalReceiptSha256', 'consumedSha256', 'activeSha256',
            'proofSha256', 'hostAcceptedSha256', 'finalizeObservationSha256', 'releaseAuthoritySha256',
            'commitSha256', 'finalizeReceiptSha256', 'transportEvidenceSha256', 'finalizeSourceSha256',
            'coverage', 'acceptedAt', 'keyId', 'scope')
SUPPORTED_ENTRYPOINTS = ('production-inspect', 'production-semantic', 'maintenance-upload-cancel',
                        'maintenance-tcp-close', 'maintenance-ps-deploy', 'maintenance-ps-reinstall',
                        'maintenance-service-stop', 'maintenance-service-start', 'ps-json-admission', 'ps-input-frame')
INTEGRATION_STATUS = 'not-integrated-execution-disabled'
INTENT_KEYS = ('schemaVersion', 'method', 'runId', 'action', 'planSha256', 'approvalIntentSha256',
               'approvalReceiptSha256', 'consumedSha256', 'owner', 'bootId', 'profileSha256',
               'baselineSha256', 'sourcePinsSha256', 'fixtureSha256', 'metadataSha256',
               'productJournalSha256', 'ownerPermitSha256', 'serviceInstance', 'imageSha256',
               'queryBodySha256', 'inputMetadataSha256', 'jobId', 'expectedQueryRevision', 'createdAt', 'approvalExpiresAt')


class GuardError(ValueError):
    def __init__(self, code, preservation_confirmed=None, active_present=None):
        super(GuardError, self).__init__(code)
        self.code = code
        self.preservation_confirmed = preservation_confirmed
        self.active_present = active_present


def require(condition, code):
    if not condition:
        raise GuardError(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii') + b'\n'


def decode(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_FILE, 'guard-json-budget')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'guard-json-duplicate')
            result[key] = value
        return result
    def invalid(_):
        raise GuardError('guard-json-nonfinite')
    result = json.loads(raw.decode('ascii'), object_pairs_hook=pairs, parse_constant=invalid)
    pending, count = [(result, 0)], 0
    while pending:
        value, depth = pending.pop(); count += 1
        require(depth <= 16 and count <= 8192, 'guard-json-structure')
        if type(value) is float: require(math.isfinite(value), 'guard-json-nonfinite')
        elif type(value) is dict: pending.extend((child, depth + 1) for child in value.values())
        elif type(value) is list: pending.extend((child, depth + 1) for child in value)
    require(type(result) is dict and encode(result) == raw, 'guard-json-not-canonical')
    return result


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'guard-closed-schema')


def hash_value(value):
    require(type(value) is str and HEX.fullmatch(value) is not None, 'guard-hash')
    return value


def milliseconds(value):
    require(type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', value), 'guard-utc-time')
    return calendar.timegm(time.strptime(value[:19], '%Y-%m-%dT%H:%M:%S')) * 1000 + int(value[20:23])


def checked_owner(value):
    exact(value, ('actor', 'generation', 'nonce'))
    require(value['actor'] == 'independent-native-qa' and type(value['generation']) is str
            and UUID.fullmatch(value['generation']) is not None, 'guard-owner')
    hash_value(value['nonce'])


def same(left, right):
    # JSON equality must not equate True with 1 in identities or signed records.
    return encode(left) == encode(right)


class TrustedHostAckVerifier(object):
    """Explicit trusted deployment seam, never constructed from remote JSON.

    verify(message, signature) must use the fixed raw Ed25519 public key whose
    SHA256 forms key_id. No crypto implementation/provider is bundled here.
    Absent provider means history stays held; a parser or boolean is no proof.
    """
    def __init__(self, key_id, finalize_source_sha256, verify):
        require(type(key_id) is str and key_id.startswith('ed25519-sha256:'), 'guard-host-key-id')
        hash_value(key_id[len('ed25519-sha256:'):])
        hash_value(finalize_source_sha256)
        require(callable(verify), 'guard-host-verifier-unavailable')
        self.key_id = key_id
        self.finalize_source_sha256 = finalize_source_sha256
        self.verify = verify


def prepared_release_receipt(intent, proof, commit_raw):
    """Canonical receipt bytes are host-bound separately from the trial reply."""
    return {'schemaVersion': 1, 'method': 'fz3b-recovery-prepared-release-v1', 'runId': intent['runId'],
            'activeSha256': digest(encode(intent)), 'proofSha256': digest(encode(proof)),
            'coverage': proof['coverage'], 'commitSha256': digest(commit_raw), 'guardAbsent': True,
            'releaseDirectorySynced': True, 'preparedRelease': True, 'logicalQuarantineRetained': True,
            'hostAckRequired': True, 'unknownHistoryRewritten': False, 'automaticReplay': False}


def checked_host_ack(value, intent, proof, records, verifier):
    require(type(verifier) is TrustedHostAckVerifier, 'guard-host-verifier-unavailable')
    exact(value, ('schemaVersion', 'algorithm', 'keyId', 'payload', 'signatureB64'))
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['algorithm'] == 'Ed25519' and value['keyId'] == verifier.key_id, 'guard-host-ack-envelope')
    payload = value['payload']; exact(payload, ACK_KEYS); checked_owner(payload['owner'])
    require(type(payload['schemaVersion']) is int and payload['schemaVersion'] == 1
            and payload['method'] == 'fz3b-recovery-host-commit-ack-v1'
            and payload['scope'] == 'exact-finalize-completed-only' and payload['keyId'] == verifier.key_id
            and type(payload['acceptanceId']) is str and UUID.fullmatch(payload['acceptanceId']) is not None,
            'guard-host-ack-purpose')
    for key in ('runId', 'owner', 'action', 'bootId', 'profileSha256', 'planSha256', 'approvalIntentSha256',
                'approvalReceiptSha256', 'consumedSha256'):
        require(same(payload[key], intent[key]), 'guard-host-ack-context')
    require(payload['coverage'] == proof['coverage'], 'guard-host-ack-coverage')
    for field, suffix in (('activeSha256', 'intent'), ('proofSha256', 'terminal'),
                          ('hostAcceptedSha256', 'host-accepted'), ('finalizeObservationSha256', 'finalize-observation'),
                          ('releaseAuthoritySha256', 'release-authority'), ('commitSha256', 'commit')):
        require(payload[field] == digest(records[intent['runId'] + '.' + suffix + '.json']), 'guard-host-ack-preimage')
    for key in ('transportEvidenceSha256', 'finalizeSourceSha256', 'finalizeReceiptSha256'): hash_value(payload[key])
    require(payload['finalizeSourceSha256'] == verifier.finalize_source_sha256, 'guard-host-finalize-source')
    receipt = prepared_release_receipt(intent, proof, records[intent['runId'] + '.commit.json'])
    require(payload['finalizeReceiptSha256'] == digest(encode(receipt)), 'guard-host-finalize-receipt')
    observed = decode(records[intent['runId'] + '.finalize-observation.json'])['observedAt']
    require(milliseconds(payload['acceptedAt']) >= milliseconds(observed), 'guard-host-ack-order')
    signature = value['signatureB64']
    require(type(signature) is str and len(signature) == 88, 'guard-host-ack-signature')
    try: raw = base64.b64decode(signature.encode('ascii'), validate=True)
    except (UnicodeError, ValueError, binascii.Error): raise GuardError('guard-host-ack-signature')
    require(len(raw) == 64 and base64.b64encode(raw).decode('ascii') == signature, 'guard-host-ack-signature')
    try: valid = verifier.verify(ACK_DOMAIN + encode(payload), raw)
    except Exception as error: raise GuardError('guard-host-ack-verification-failed') from error
    require(valid is True, 'guard-host-ack-verification-failed')
    return payload


def checked_intent(value, now=None):
    exact(value, INTENT_KEYS)
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['method'] == METHOD
            and type(value['runId']) is str and RUN.fullmatch(value['runId']) is not None, 'guard-intent-identity')
    require(value['action'] in ('upload-cancel', 'tcp-close') and value['bootId'] == BOOT and value['profileSha256'] == PROFILE, 'guard-target')
    checked_owner(value['owner'])
    for key in ('planSha256', 'approvalIntentSha256', 'approvalReceiptSha256', 'consumedSha256', 'baselineSha256',
                'sourcePinsSha256', 'fixtureSha256', 'metadataSha256', 'productJournalSha256', 'ownerPermitSha256',
                'imageSha256', 'queryBodySha256', 'inputMetadataSha256'): hash_value(value[key])
    require(value['fixtureSha256'] == 'febcb9d93517f3c98eadb5d98eea6808f243fb6a1d4b61215cd981503de98e56'
            and value['imageSha256'] == '06dd779d1450c835255833be19c84f6636c2de99313713d80c850fa572c25967', 'guard-fixed-fixture')
    exact(value['serviceInstance'], ('mainPid', 'startTicks'))
    require(type(value['serviceInstance']['mainPid']) is int and value['serviceInstance']['mainPid'] > 1
            and type(value['serviceInstance']['startTicks']) is int and value['serviceInstance']['startTicks'] > 0, 'guard-service-instance')
    require(value['jobId'] == 'fd-recovery-' + value['runId'][len('active-recovery-'):].replace('-', '')
            and type(value['expectedQueryRevision']) is int and value['expectedQueryRevision'] > 0, 'guard-job')
    created, expires = milliseconds(value['createdAt']), milliseconds(value['approvalExpiresAt'])
    require(0 < expires - created <= 300000, 'guard-approval-duration')
    if now is not None: require(created <= now < expires, 'guard-approval-expired')
    return value


def terminal(value, intent, coverage):
    exact(value, ('state', 'error', 'jobId', 'queryRevision', 'received', 'completed', 'queued', 'finished', 'cancelled'))
    require(value['state'] == 'STOPPED' and value['error'] is None and value['jobId'] == intent['jobId']
            and type(value['queryRevision']) is int and value['queryRevision'] == intent['expectedQueryRevision']
            and type(value['received']) is int and value['received'] == 1
            and type(value['completed']) is int and value['completed'] in (0, 1)
            and type(value['queued']) is int and value['queued'] == 0
            and value['finished'] is True, 'guard-terminal-not-quiet')
    require((coverage == 'active-interrupted' and value['cancelled'] is True) or
            (coverage == 'not-covered' and value['cancelled'] is False and value['completed'] == 1), 'guard-terminal-coverage')


def observation(value, intent, active_sha, coverage, now=None):
    exact(value, ('activeSha256', 'owner', 'bootId', 'serviceInstance', 'metadataBeforeSha256', 'metadataAfterSha256',
                  'productJournalBeforeSha256', 'productJournalAfterSha256', 'terminal', 'observer', 'scans', 'observedAt'))
    require(value['activeSha256'] == active_sha and same(value['owner'], intent['owner']) and value['bootId'] == BOOT
            and same(value['serviceInstance'], intent['serviceInstance']), 'guard-proof-owner')
    for key in ('metadataBeforeSha256', 'metadataAfterSha256'): require(value[key] == intent['metadataSha256'], 'guard-metadata-drift')
    for key in ('productJournalBeforeSha256', 'productJournalAfterSha256'): require(value[key] == intent['productJournalSha256'], 'guard-journal-drift')
    terminal(value['terminal'], intent, coverage)
    observer = value['observer']
    exact(observer, ('connectionId', 'sequential', 'closedBeforeScans', 'statusMayWriteR5Telemetry'))
    require(type(observer['connectionId']) is str and UUID.fullmatch(observer['connectionId']) is not None
            and observer['sequential'] is True and observer['closedBeforeScans'] is True
            and observer['statusMayWriteR5Telemetry'] is True, 'guard-observer-not-closed')
    require(type(value['scans']) is list and len(value['scans']) == 2, 'guard-two-scans-required')
    own = None
    previous_time = None
    for scan in value['scans']:
        exact(scan, ('complete', 'deviceOpened', 'deviceOwners', 'controlConnections', 'stdinOwners', 'newPidsAtEnd',
                     'selfExcluded', 'bootId', 'metadataSha256', 'productJournalSha256', 'observedAt'))
        require(scan['complete'] is True and scan['deviceOpened'] is False and scan['bootId'] == BOOT
                and scan['metadataSha256'] == intent['metadataSha256'] and scan['productJournalSha256'] == intent['productJournalSha256'], 'guard-scan-incomplete')
        for key in ('deviceOwners', 'controlConnections', 'stdinOwners', 'newPidsAtEnd'): require(type(scan[key]) is list and scan[key] == [], 'guard-scan-busy')
        exact(scan['selfExcluded'], ('pid', 'startTicks'))
        require(all(type(scan['selfExcluded'][key]) is int for key in ('pid', 'startTicks'))
                and scan['selfExcluded']['pid'] > 0 and scan['selfExcluded']['startTicks'] >= 0, 'guard-scan-self')
        require(own is None or own == scan['selfExcluded'], 'guard-scan-self-drift'); own = scan['selfExcluded']
        sampled = milliseconds(scan['observedAt'])
        require(previous_time is None or 100 <= sampled - previous_time <= FRESH_MS, 'guard-scan-spacing'); previous_time = sampled
    observed = milliseconds(value['observedAt'])
    require(previous_time <= observed and observed - milliseconds(value['scans'][0]['observedAt']) <= FRESH_MS, 'guard-proof-time-order')
    if now is not None: require(0 <= now - observed <= FRESH_MS, 'guard-proof-stale')


def checked_proof(value, intent, active_sha, now=None):
    exact(value, ('schemaVersion', 'method', 'runId', 'activeSha256', 'owner', 'action', 'coverage', 'activeSample', 'fault', 'observation'))
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['method'] == 'fz3b-recovery-terminal-proof-v1'
            and value['runId'] == intent['runId'] and value['activeSha256'] == active_sha
            and same(value['owner'], intent['owner']) and value['action'] == intent['action'], 'guard-proof-binding')
    require(value['coverage'] in ('active-interrupted', 'not-covered'), 'guard-proof-coverage')
    sample = value['activeSample']
    if sample is not None:
        exact(sample, ('state', 'error', 'jobId', 'queryRevision', 'received', 'completed', 'queued', 'finished', 'cancelled'))
        require(sample['state'] == 'RUNNING' and sample['error'] is None and sample['jobId'] == intent['jobId']
                and type(sample['queryRevision']) is int and sample['queryRevision'] == intent['expectedQueryRevision']
                and type(sample['received']) is int and sample['received'] == 1 and type(sample['completed']) is int and sample['completed'] == 0
                and type(sample['queued']) is int and sample['queued'] in (0, 1) and sample['finished'] is True and sample['cancelled'] is False, 'guard-no-active-frame')
    fault = value['fault']
    exact(fault, ('action', 'attemptCount', 'connectionId', 'ownCloseObserved', 'cancelAck'))
    require(type(fault['attemptCount']) is int and fault['attemptCount'] in (0, 1) and type(fault['connectionId']) is str
            and UUID.fullmatch(fault['connectionId']) is not None and fault['ownCloseObserved'] is True, 'guard-fault-count')
    if fault['attemptCount'] == 0:
        require(value['coverage'] == 'not-covered' and sample is None and fault['action'] is None and fault['cancelAck'] is None, 'guard-fault-not-missed')
    elif intent['action'] == 'tcp-close':
        require(fault['action'] == 'tcp-close' and sample is not None and fault['cancelAck'] is None, 'guard-tcp-fault')
    else:
        require(fault['action'] == intent['action'] and sample is not None and value['coverage'] == 'active-interrupted', 'guard-cancel-coverage')
        ack = fault['cancelAck']; exact(ack, ('requestId', 'op', 'ok', 'jobId', 'cancelled', 'queued'))
        require(ack['requestId'] == 'cancel-' + intent['jobId'][len('fd-recovery-'):] and ack['op'] == 'upload_cancel'
                and ack['ok'] is True and ack['jobId'] == intent['jobId'] and ack['cancelled'] is True
                and type(ack['queued']) is int and ack['queued'] == 0 and fault['ownCloseObserved'] is True, 'guard-cancel-ack')
    observation(value['observation'], intent, active_sha, value['coverage'], now)
    require(value['observation']['observer']['connectionId'] != fault['connectionId'], 'guard-observer-not-fresh')


class RecoveryGuard(object):
    """Trusted core. Store must serialize under the exact product flock."""
    def __init__(self, store, now_ms=None, host_verifier=None):
        self.store = store
        self.now = now_ms or (lambda: int(time.time() * 1000))
        self.host_verifier = host_verifier
        self.poisoned = False

    def inventory(self):
        values = self.store.snapshot()
        require(type(values) is dict and len(values) <= MAX_FILES and sum(len(raw) for raw in values.values()) <= MAX_TOTAL, 'guard-inventory-budget')
        for name in values:
            require(name == 'active.json' or any(name.endswith('.' + suffix + '.json') and RUN.fullmatch(name[:-len('.' + suffix + '.json')]) for suffix in SUFFIXES), 'guard-unexpected-file')
            decode(values[name])
        return values

    def assert_clear(self):
        require(not self.poisoned, 'guard-instance-poisoned')
        values = self.inventory()
        require('active.json' not in values, 'recovery-quarantine-active')
        runs = set(name.split('.' + next(suffix for suffix in SUFFIXES if name.endswith('.' + suffix + '.json')))[0] for name in values)
        for run in runs:
            required = set(run + '.' + suffix + '.json' for suffix in RECORDS)
            require(set(name for name in values if name.startswith(run + '.')) == required, 'guard-orphan-or-uncertain-history')
            intent = checked_intent(decode(values[run + '.intent.json']))
            proof_raw = values[run + '.terminal.json']; proof = decode(proof_raw)
            checked_proof(proof, intent, digest(values[run + '.intent.json']))
            accepted_raw = values[run + '.host-accepted.json']; accepted = decode(accepted_raw)
            self.acceptance(accepted, intent, digest(values[run + '.intent.json']), digest(proof_raw))
            fresh_raw = values[run + '.finalize-observation.json']; fresh = decode(fresh_raw)
            observation(fresh, intent, digest(values[run + '.intent.json']), proof['coverage'])
            require(fresh['terminal'] == proof['observation']['terminal'] and milliseconds(fresh['observedAt']) >= milliseconds(accepted['acceptedAt'])
                    >= milliseconds(proof['observation']['observedAt']), 'guard-final-history-order')
            authority_raw = values[run + '.release-authority.json']; authority = decode(authority_raw)
            require(same(authority, {'schemaVersion': 1, 'method': 'fz3b-recovery-release-authority-v1', 'runId': run,
                    'activeSha256': digest(values[run + '.intent.json']), 'proofSha256': digest(proof_raw),
                    'hostAcceptedSha256': digest(accepted_raw), 'freshObservationSha256': digest(fresh_raw),
                    'owner': intent['owner'], 'releaseAuthorized': True}), 'guard-release-authority-invalid')
            commit = decode(values[run + '.commit.json'])
            require(same(commit, {'schemaVersion': 1, 'method': 'fz3b-recovery-commit-v1', 'runId': run,
                    'activeSha256': digest(values[run + '.intent.json']), 'releaseAuthoritySha256': digest(authority_raw),
                    'owner': intent['owner'], 'activeAbsentObserved': True, 'unlinkDirectorySynced': True}), 'guard-commit-invalid')
            checked_host_ack(decode(values[run + '.host-ack.json']), intent, proof, values, self.host_verifier)
        return True

    def active(self, owner, active_sha):
        require(not self.poisoned, 'guard-instance-poisoned')
        hash_value(active_sha); checked_owner(owner)
        values = self.inventory(); raw = values.get('active.json')
        require(raw is not None and digest(raw) == active_sha, 'guard-active-preimage')
        intent = checked_intent(decode(raw)); require(same(intent['owner'], owner), 'guard-foreign-owner')
        require(values.get(intent['runId'] + '.intent.json') == raw and intent['runId'] + '.uncertain.json' not in values, 'guard-owner-history-uncertain')
        return intent, raw

    def preserve(self, intent, raw, error):
        self.poisoned = True
        marker_confirmed = restored = False
        try:
            name = intent['runId'] + '.uncertain.json'
            record = encode({'schemaVersion': 1, 'method': 'fz3b-recovery-uncertain-v1', 'runId': intent['runId'],
                             'activeSha256': digest(raw), 'errorType': type(error).__name__, 'automaticReplay': False})
            self.store.create_if_same(name, record)
            marker_confirmed = True
        except Exception:
            pass
        try:
            self.store.restore_active(raw)
            restored = True
        except Exception:
            pass
        try: present = 'active.json' in self.store.snapshot()
        except Exception: present = None
        raise GuardError('guard-mutation-unknown', marker_confirmed or restored, present) from error

    def begin(self, intent):
        checked_intent(intent, self.now()); raw = encode(intent)
        with self.store.admission_exclusive():
            require(self.store.current_boot_id() == BOOT, 'guard-current-boot-changed')
            checked_intent(intent, self.now())
            self.assert_clear()
            values = self.inventory()
            for name, old in values.items():
                if name.endswith('.intent.json'):
                    prior = decode(old)
                    require(all(prior[field] != intent[field] for field in ('runId', 'approvalReceiptSha256', 'consumedSha256', 'ownerPermitSha256'))
                            and prior['owner'] != intent['owner'], 'guard-consent-or-owner-reused')
            require(self.store.product_journal_sha256() == intent['productJournalSha256'], 'guard-product-journal-drift')
            try:
                self.store.create(intent['runId'] + '.intent.json', raw)
                self.store.create('active.json', raw)
            except Exception as error: self.preserve(intent, raw, error)
        return {'activeSha256': digest(raw), 'runId': intent['runId'], 'action': intent['action'], 'planSha256': intent['planSha256'],
                'owner': copy.deepcopy(intent['owner']), 'serviceInstance': copy.deepcopy(intent['serviceInstance']),
                'jobId': intent['jobId'], 'expectedQueryRevision': intent['expectedQueryRevision']}

    def stage_terminal(self, owner, active_sha, proof):
        intent, raw = self.active(owner, active_sha)
        checked_proof(proof, intent, active_sha, self.now())
        require(self.store.product_journal_sha256() == intent['productJournalSha256'], 'guard-product-journal-drift')
        with self.store.admission_exclusive():
            require(self.store.current_boot_id() == BOOT, 'guard-current-boot-changed')
            self.active(owner, active_sha)
            checked_proof(proof, intent, active_sha, self.now())
            try: self.store.create(intent['runId'] + '.terminal.json', encode(proof))
            except Exception as error: self.preserve(intent, raw, error)
        return {'activeSha256': active_sha, 'proofSha256': digest(encode(proof)), 'quarantineRetained': True}

    def acceptance(self, value, intent, active_sha, proof_sha, fresh=False):
        exact(value, ('schemaVersion', 'method', 'runId', 'owner', 'activeSha256', 'proofSha256', 'rawReceiptSha256', 'acceptanceId', 'acceptedAt'))
        require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['method'] == 'fz3b-recovery-host-accepted-v1'
                and value['runId'] == intent['runId'] and same(value['owner'], intent['owner'])
                and value['activeSha256'] == active_sha and value['proofSha256'] == proof_sha
                and type(value['acceptanceId']) is str and UUID.fullmatch(value['acceptanceId']) is not None, 'guard-host-acceptance')
        hash_value(value['rawReceiptSha256']); accepted = milliseconds(value['acceptedAt'])
        if fresh: require(0 <= self.now() - accepted <= FRESH_MS, 'guard-host-acceptance-stale')

    def finalize(self, owner, active_sha, accepted, fresh_observation):
        intent, raw = self.active(owner, active_sha)
        values = self.inventory(); proof_raw = values.get(intent['runId'] + '.terminal.json')
        require(proof_raw is not None, 'guard-terminal-proof-missing')
        proof = decode(proof_raw); checked_proof(proof, intent, active_sha, self.now())
        self.acceptance(accepted, intent, active_sha, digest(proof_raw), True)
        observation(fresh_observation, intent, active_sha, proof['coverage'], self.now())
        require(fresh_observation['terminal'] == proof['observation']['terminal'], 'guard-terminal-drift')
        require(milliseconds(fresh_observation['observedAt']) >= milliseconds(proof['observation']['observedAt']), 'guard-fresh-proof-order')
        require(milliseconds(accepted['acceptedAt']) >= milliseconds(proof['observation']['observedAt'])
                and milliseconds(fresh_observation['observedAt']) >= milliseconds(accepted['acceptedAt']), 'guard-host-fresh-order')
        require(self.store.product_journal_sha256() == intent['productJournalSha256'], 'guard-product-journal-drift')
        accepted_raw = encode(accepted); fresh_raw = encode(fresh_observation)
        authority = {'schemaVersion': 1, 'method': 'fz3b-recovery-release-authority-v1', 'runId': intent['runId'],
                     'activeSha256': active_sha, 'proofSha256': digest(proof_raw), 'hostAcceptedSha256': digest(accepted_raw),
                     'freshObservationSha256': digest(fresh_raw),
                     'owner': intent['owner'], 'releaseAuthorized': True}
        with self.store.admission_exclusive():
            require(self.store.current_boot_id() == BOOT, 'guard-current-boot-changed')
            checked_proof(proof, intent, active_sha, self.now())
            self.acceptance(accepted, intent, active_sha, digest(proof_raw), True)
            observation(fresh_observation, intent, active_sha, proof['coverage'], self.now())
            try:
                self.active(owner, active_sha)
                self.store.create(intent['runId'] + '.host-accepted.json', accepted_raw)
                self.store.create(intent['runId'] + '.finalize-observation.json', fresh_raw)
                self.store.create(intent['runId'] + '.release-authority.json', encode(authority))
                self.store.remove_active_exact(raw)
                commit_raw = encode({'schemaVersion': 1, 'method': 'fz3b-recovery-commit-v1',
                    'runId': intent['runId'], 'activeSha256': active_sha, 'releaseAuthoritySha256': digest(encode(authority)),
                    'owner': intent['owner'], 'activeAbsentObserved': True, 'unlinkDirectorySynced': True})
                self.store.create(intent['runId'] + '.commit.json', commit_raw)
            except Exception as error: self.preserve(intent, raw, error)
        return prepared_release_receipt(intent, proof, commit_raw)

    def publish_host_ack(self, owner, active_sha, value):
        """Explicit post-success host attestation; never a trial/finalize retry."""
        require(not self.poisoned, 'guard-instance-poisoned')
        checked_owner(owner); hash_value(active_sha)
        require(type(value) is dict and type(value.get('payload')) is dict, 'guard-host-ack-envelope')
        run = value['payload'].get('runId')
        require(type(run) is str and RUN.fullmatch(run) is not None, 'guard-host-ack-run')
        with self.store.admission_exclusive():
            require(self.store.current_boot_id() == BOOT, 'guard-current-boot-changed')
            values = self.inventory(); raw = values.get(run + '.intent.json')
            require(raw is not None and digest(raw) == active_sha, 'guard-active-preimage')
            intent = checked_intent(decode(raw)); require(same(intent['owner'], owner), 'guard-foreign-owner')
            require('active.json' not in values, 'recovery-quarantine-active')
            require(self.store.product_journal_sha256() == intent['productJournalSha256'], 'guard-product-journal-drift')
            name = run + '.host-ack.json'; require(name not in values, 'guard-host-ack-already-published')
            values[name] = encode(value)
            history_clear(values, self.host_verifier)
            try: self.store.create(name, values[name])
            except Exception as error: self.preserve(intent, raw, error)
            self.assert_clear()
        return {'runId': run, 'hostAckSha256': digest(values[name]), 'logicalQuarantineClear': True,
                'automaticReplay': False, 'unknownHistoryRewritten': False}


def history_clear(snapshot, host_verifier=None):
    """Pure shared history parser for PS admission under its held SH snapshot."""
    class FrozenStore(object):
        def snapshot(self): return copy.deepcopy(snapshot)
    return RecoveryGuard(FrozenStore(), host_verifier=host_verifier).assert_clear()


def admission_state(snapshot, host_verifier=None):
    """Pure PS parser: None for settled history, or the exact active intent/raw.

    A staged/uncertain current run cannot admit any new work. Drain/close remains
    outside new admission and must not be blocked by this parser.
    """
    class FrozenStore(object):
        def snapshot(self): return copy.deepcopy(snapshot)
    values = RecoveryGuard(FrozenStore()).inventory()
    if 'active.json' not in values:
        history_clear(values, host_verifier); return None
    raw = values['active.json']; intent = checked_intent(decode(raw))
    name = intent['runId'] + '.intent.json'
    require(values.get(name) == raw and set(key for key in values if key.startswith(intent['runId'] + '.')) == {name}, 'guard-current-admission-not-live')
    del values['active.json']; del values[name]; history_clear(values, host_verifier)
    return intent, raw


class SecureStore(object):
    """Linux root-only fd-anchored store; instantiated only by explicit callers."""
    @classmethod
    def open_existing(cls, product_lock_fd=None):
        """Open an already provisioned store without repairing missing state."""
        require(sys.platform.startswith('linux') and os.geteuid() == 0, 'guard-linux-root-required')
        import fcntl
        self = cls.__new__(cls)
        self.fds = []; self.anchors = []
        try:
            self.app_fd = self.directory_path(APP)
            self.product_fd = self.directory(PRODUCT, self.app_fd, 0o700)
            named = os.stat('active.lock', dir_fd=self.product_fd, follow_symlinks=False)
            self.regular(named, empty=True)
            if product_lock_fd is None:
                lock = os.open('active.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.product_fd)
            else:
                require(type(product_lock_fd) is int and product_lock_fd >= 0, 'guard-product-lock-fd')
                lock = os.dup(product_lock_fd)
            self.fds.append(lock); self.regular(os.fstat(lock), empty=True)
            require(self.identity(named) == self.identity(os.fstat(lock)), 'guard-product-lock-identity')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB); self.product_lock = lock
            self.guard_fd = self.directory(DIRECTORY, self.app_fd, 0o700)
            named = os.stat('admission.lock', dir_fd=self.guard_fd, follow_symlinks=False)
            self.regular(named, empty=True)
            self.admission = os.open('admission.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.guard_fd)
            self.fds.append(self.admission); self.regular(os.fstat(self.admission), empty=True)
            require(self.identity(named) == self.identity(os.fstat(self.admission)), 'guard-admission-lock-identity')
            self.check()
            return self
        except BaseException:
            try: self.close()
            except OSError: pass
            raise

    def __init__(self, product_lock_fd=None):
        self.fds = []; self.anchors = []
        require(sys.platform.startswith('linux') and os.geteuid() == 0, 'guard-linux-root-required')
        import fcntl
        try:
            self.app_fd = self.directory_path(APP)
            self.product_fd = self.directory(PRODUCT, self.app_fd, 0o700)
            named = os.stat('active.lock', dir_fd=self.product_fd, follow_symlinks=False)
            self.regular(named, empty=True)
            lock = os.open('active.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.product_fd) if product_lock_fd is None else os.dup(product_lock_fd)
            self.fds.append(lock); self.regular(os.fstat(lock), empty=True)
            require(self.identity(named) == self.identity(os.fstat(lock)), 'guard-product-lock-identity')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB); self.product_lock = lock
            try:
                os.mkdir(DIRECTORY, 0o700, dir_fd=self.app_fd); os.fsync(self.app_fd)
            except FileExistsError: pass
            self.guard_fd = self.directory(DIRECTORY, self.app_fd, 0o700)
            try:
                fd = os.open('admission.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.guard_fd)
                try: os.fsync(fd)
                finally: os.close(fd)
                os.fsync(self.guard_fd)
            except FileExistsError: pass
            self.admission = os.open('admission.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.guard_fd)
            self.fds.append(self.admission); self.regular(os.fstat(self.admission), empty=True)
        except BaseException:
            try: self.close()
            except OSError: pass
            raise

    @staticmethod
    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_uid, info.st_gid, info.st_nlink)

    @staticmethod
    def regular(info, empty=False):
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and 0 <= info.st_size <= (0 if empty else MAX_FILE), 'guard-file-metadata')

    def directory(self, name, parent, mode=None):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent); self.fds.append(fd)
        info = os.fstat(fd)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022
                and (mode is None or stat.S_IMODE(info.st_mode) == mode), 'guard-directory-metadata')
        self.anchors.append((parent, name, fd)); return fd

    def directory_path(self, path):
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); self.fds.append(fd)
        for part in path.strip('/').split('/'): fd = self.directory(part, fd)
        return fd

    def check(self):
        for parent, name, fd in self.anchors:
            named = os.stat(name, dir_fd=parent, follow_symlinks=False); held = os.fstat(fd)
            require(stat.S_ISDIR(named.st_mode) and named.st_uid == named.st_gid == 0 and not named.st_mode & 0o022
                    and (named.st_dev, named.st_ino) == (held.st_dev, held.st_ino), 'guard-directory-replaced')
            if name in (DIRECTORY, PRODUCT):
                require(stat.S_IMODE(named.st_mode) == stat.S_IMODE(held.st_mode) == 0o700, 'guard-directory-metadata')
        for parent, name, fd in ((self.product_fd, 'active.lock', self.product_lock), (self.guard_fd, 'admission.lock', self.admission)):
            held = os.fstat(fd); named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            self.regular(held, True); self.regular(named, True); require(self.identity(named) == self.identity(held), 'guard-lock-replaced')

    def read_leaf(self, parent, name):
        self.check(); fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = os.fstat(fd); self.regular(before)
            raw = bytearray()
            while len(raw) <= MAX_FILE:
                part = os.read(fd, min(8192, MAX_FILE + 1 - len(raw)))
                if not part: break
                raw.extend(part)
            self.regular(os.stat(name, dir_fd=parent, follow_symlinks=False))
            require(len(raw) == before.st_size and self.identity(before) == self.identity(os.fstat(fd))
                    == self.identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'guard-file-changed')
            return bytes(raw)
        finally: os.close(fd)

    def snapshot(self):
        self.check(); names = sorted(os.listdir(self.guard_fd)); require(len(names) <= MAX_FILES + 1, 'guard-name-budget')
        result = {name: self.read_leaf(self.guard_fd, name) for name in names if name != 'admission.lock'}
        require(sorted(os.listdir(self.guard_fd)) == names, 'guard-inventory-changing'); return result

    @contextlib.contextmanager
    def admission_exclusive(self):
        import fcntl
        self.check(); fcntl.flock(self.admission, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try: self.check(); yield
        finally: fcntl.flock(self.admission, fcntl.LOCK_UN)

    def create(self, name, raw):
        self.check(); require('/' not in name and '\\' not in name and len(raw) <= MAX_FILE, 'guard-write-path-budget')
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.guard_fd)
        try:
            os.fchown(fd, 0, 0); os.fchmod(fd, 0o600)
            offset = 0
            while offset < len(raw):
                size = os.write(fd, raw[offset:]); require(type(size) is int and 0 < size <= len(raw) - offset, 'guard-short-write'); offset += size
            os.fsync(fd); self.regular(os.fstat(fd))
        finally: os.close(fd)
        os.fsync(self.guard_fd)
        require(self.read_leaf(self.guard_fd, name) == raw, 'guard-write-readback')

    def create_if_same(self, name, raw):
        try: self.create(name, raw)
        except FileExistsError:
            require(self.read_leaf(self.guard_fd, name) == raw, 'guard-existing-record-drift')
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.guard_fd)
            try:
                before = os.fstat(fd); self.regular(before); os.fsync(fd)
                require(self.identity(before) == self.identity(os.fstat(fd))
                        == self.identity(os.stat(name, dir_fd=self.guard_fd, follow_symlinks=False)), 'guard-existing-record-changed')
            finally: os.close(fd)
            os.fsync(self.guard_fd)
            require(self.read_leaf(self.guard_fd, name) == raw, 'guard-existing-record-drift')

    def restore_active(self, raw):
        self.create_if_same('active.json', raw)

    def remove_active_exact(self, raw):
        require(self.read_leaf(self.guard_fd, 'active.json') == raw, 'guard-unlink-preimage')
        os.unlink('active.json', dir_fd=self.guard_fd); os.fsync(self.guard_fd)
        try: os.stat('active.json', dir_fd=self.guard_fd, follow_symlinks=False)
        except FileNotFoundError: return
        raise GuardError('guard-unlink-not-absent')

    def product_journal_sha256(self):
        self.check(); names = sorted(os.listdir(self.product_fd)); require(len(names) <= 65 and 'active.lock' in names, 'guard-product-inventory')
        hashes = {}
        for name in names:
            if name == 'active.lock': continue
            require(name.endswith('.json') and UUID.fullmatch(name[:-5]), 'guard-product-name')
            raw = self.read_leaf(self.product_fd, name)
            value = decode(raw)
            require(type(value) is dict and value.get('operationId') == name[:-5] and value.get('status') in ('succeeded', 'failed')
                    and value.get('remoteQuiescent') is True and value.get('profileSha256') == PROFILE, 'guard-product-unresolved')
            hashes[name] = digest(raw)
        require(sorted(os.listdir(self.product_fd)) == names, 'guard-product-changing'); return digest(encode(hashes))

    def current_boot_id(self):
        self.check()
        fd = os.open('/proc/sys/kernel/random/boot_id', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(stat.S_ISREG(os.fstat(fd).st_mode), 'guard-boot-metadata')
            raw = os.read(fd, 38)
            require(len(raw) == 37 and raw[-1:] == b'\n' and not os.read(fd, 1), 'guard-boot-content')
            value = raw[:-1].decode('ascii')
            require(UUID.fullmatch(value) is not None, 'guard-boot-content')
            return value
        finally: os.close(fd)

    def close(self):
        failure = None
        for fd in reversed(getattr(self, 'fds', [])):
            try: os.close(fd)
            except OSError as error: failure = error
        self.fds = []
        if failure is not None: raise failure

    def __enter__(self): return self

    def __exit__(self, _kind, _value, _trace): self.close()
