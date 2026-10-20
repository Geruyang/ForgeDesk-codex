"""PS-side recovery admission fence. Definitions only; no application/device I/O.

Callers must keep command/frame scopes around the actual synchronous effect.
Drain scopes only continue previously admitted work; they never admit new input.
"""
import collections
import contextlib
import datetime
import hashlib
import hmac
import json
import math
import os
import re
import stat
import sys
import threading

APP = '/root/fz3b-vision-console-20261009-001'
DIRECTORY = '.forgedesk-recovery-quarantine'
ADMISSION = 'admission.lock'
ACTIVE = 'active.json'
METHOD = 'fz3b-active-recovery-maintenance-v2'
PROFILE = '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd'
FIXTURE_SHA = 'febcb9d93517f3c98eadb5d98eea6808f243fb6a1d4b61215cd981503de98e56'
IMAGE_SHA = '06dd779d1450c835255833be19c84f6636c2de99313713d80c850fa572c25967'
QUERY_SEMANTIC_SHA = 'b784dfcd947b8e7d6f4a034ca32e0d4851cc5fc626660c227ea65751ee18ad70'
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z')
HEX = re.compile(r'[a-f0-9]{64}\Z')
UTC = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\Z')
READ_ONLY = frozenset(('hello', 'status', 'frame_get'))
GUARD_KEYS = frozenset(('schemaVersion', 'method', 'runId', 'action', 'planSha256', 'approvalIntentSha256',
    'approvalReceiptSha256', 'consumedSha256', 'owner', 'ownerPermitSha256', 'bootId', 'profileSha256',
    'baselineSha256', 'sourcePinsSha256', 'fixtureSha256', 'imageSha256', 'queryBodySha256',
    'inputMetadataSha256', 'metadataSha256', 'productJournalSha256', 'jobId', 'expectedQueryRevision',
    'serviceInstance', 'createdAt', 'approvalExpiresAt'))
CONTEXT_KEYS = frozenset(('schemaVersion', 'method', 'activeSha256', 'owner', 'runId', 'action', 'planSha256',
    'jobId', 'expectedQueryRevision', 'serviceInstance', 'permitToken'))
GuardSnapshot = collections.namedtuple('GuardSnapshot', 'raw identity')
AdmissionScope = collections.namedtuple('AdmissionScope', 'mode cached_status ticket')


class QuarantineError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise QuarantineError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'quarantine-object-shape')


def strict_json(raw, budget=32768):
    require(type(raw) is bytes and 0 < len(raw) <= budget, 'quarantine-json-budget')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'quarantine-duplicate-key')
            result[key] = value
        return result
    def invalid(_value):
        raise QuarantineError('quarantine-nonfinite')
    value = json.loads(raw.decode('ascii'), object_pairs_hook=pairs, parse_constant=invalid)
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        require(depth <= 16 and count <= 8192, 'quarantine-json-structure')
        if type(item) is dict:
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            pending.extend((child, depth + 1) for child in item)
        elif type(item) is float:
            require(math.isfinite(item), 'quarantine-nonfinite')
    return value


def timestamp(value):
    require(type(value) is str and UTC.fullmatch(value), 'quarantine-utc-format')
    return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=datetime.timezone.utc)


def service_identity(value):
    exact(value, ('mainPid', 'startTicks'))
    require(type(value['mainPid']) is int and value['mainPid'] > 1 and type(value['startTicks']) is int
            and value['startTicks'] > 0, 'quarantine-service-instance')


def checked_guard(snapshot, boot_id, instance):
    require(type(snapshot) is GuardSnapshot and snapshot.raw is not None, 'quarantine-snapshot-required')
    value = strict_json(snapshot.raw)
    exact(value, GUARD_KEYS)
    require(snapshot.raw == canonical(value) + b'\n', 'quarantine-guard-not-canonical')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['method'] == METHOD,
            'quarantine-schema')
    require(type(value['runId']) is str and value['runId'].startswith('active-recovery-')
            and UUID.fullmatch(value['runId'][16:]), 'quarantine-run')
    require(value['action'] in ('upload-cancel', 'tcp-close'), 'quarantine-action')
    for key in GUARD_KEYS:
        if key.endswith('Sha256'):
            require(type(value[key]) is str and HEX.fullmatch(value[key]), 'quarantine-hash-field')
    exact(value['owner'], ('actor', 'generation', 'nonce'))
    require(value['owner']['actor'] == 'independent-native-qa' and type(value['owner']['generation']) is str
            and UUID.fullmatch(value['owner']['generation']) and type(value['owner']['nonce']) is str
            and HEX.fullmatch(value['owner']['nonce']), 'quarantine-owner')
    require(value['jobId'] == 'fd-recovery-' + value['runId'][16:].replace('-', ''), 'quarantine-job')
    require(type(value['expectedQueryRevision']) is int and value['expectedQueryRevision'] > 0, 'quarantine-revision')
    require(value['bootId'] == boot_id and value['profileSha256'] == PROFILE
            and value['fixtureSha256'] == FIXTURE_SHA and value['imageSha256'] == IMAGE_SHA,
            'quarantine-target-fixture')
    service_identity(value['serviceInstance'])
    require(value['serviceInstance'] == instance, 'quarantine-restarted-service')
    created, expires = timestamp(value['createdAt']), timestamp(value['approvalExpiresAt'])
    require(created < expires and (expires - created).total_seconds() <= 300, 'quarantine-owner-expiry')
    return value


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode,
            info.st_uid, info.st_gid, info.st_nlink)


class PosixAdmissionStore(object):
    """Never creates files. A separately approved deployment must provision the lock."""
    def __init__(self, admission_parser=None):
        # Integration must inject the pinned shared module's admission_state;
        # no local approximation of settled-history proof is acceptable.
        self.admission_parser = admission_parser

    @staticmethod
    def _directory(parent, name, exact_mode=None):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                    'quarantine-directory-untrusted')
            if exact_mode is not None:
                require(stat.S_IMODE(info.st_mode) == exact_mode, 'quarantine-directory-mode')
            return fd
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def _regular(info, empty=False):
        require(stat.S_ISREG(info.st_mode) and info.st_uid == info.st_gid == 0 and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and 0 <= info.st_size <= 65536,
                'quarantine-file-untrusted')
        if empty:
            require(info.st_size == 0, 'quarantine-admission-not-empty')

    @contextlib.contextmanager
    def snapshot(self):
        import fcntl
        require(sys.platform.startswith('linux') and os.geteuid() == 0, 'quarantine-linux-root-required')
        require(callable(self.admission_parser), 'quarantine-shared-parser-required')
        fds, anchors = [], []
        try:
            root = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
            fds.append(root)
            parent = root
            for part in APP.strip('/').split('/') + [DIRECTORY]:
                child = self._directory(parent, part, 0o700 if part == DIRECTORY else None)
                fds.append(child)
                anchors.append((parent, part, child))
                parent = child
            directory = parent
            lock = os.open(ADMISSION, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            fds.append(lock)
            self._regular(os.fstat(lock), empty=True)
            fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
            identity = file_identity(os.fstat(lock))
            def check_anchors():
                for base, name, held in anchors:
                    named = os.stat(name, dir_fd=base, follow_symlinks=False)
                    opened = os.fstat(held)
                    require(named.st_dev == opened.st_dev and named.st_ino == opened.st_ino
                            and stat.S_ISDIR(named.st_mode) and named.st_uid == named.st_gid == 0 and not named.st_mode & 0o022
                            and (name != DIRECTORY or stat.S_IMODE(named.st_mode) == 0o700),
                            'quarantine-directory-replaced')
                self._regular(os.stat(ADMISSION, dir_fd=directory, follow_symlinks=False), empty=True)
                require(file_identity(os.stat(ADMISSION, dir_fd=directory, follow_symlinks=False)) == identity
                        == file_identity(os.fstat(lock)), 'quarantine-admission-replaced')
            check_anchors()
            inventory = sorted(os.listdir(directory))
            require(ADMISSION in inventory and len(inventory) <= 259, 'quarantine-inventory')
            records, identities, total = {}, {}, 0
            for name in inventory:
                if name == ADMISSION:
                    continue
                require(type(name) is str and '/' not in name and '\\' not in name and name not in ('.', '..'),
                        'quarantine-history-name')
                leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
                fds.append(leaf)
                before = os.fstat(leaf)
                self._regular(before)
                chunks, size = [], 0
                while size <= 65536:
                    chunk = os.read(leaf, min(8192, 65537 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    chunks.append(chunk)
                require(size == before.st_size and file_identity(before) == file_identity(os.fstat(leaf))
                        == file_identity(os.stat(name, dir_fd=directory, follow_symlinks=False)), 'quarantine-history-changed')
                records[name], identities[name] = b''.join(chunks), file_identity(before)
                total += size
                require(total <= 4 * 1048576, 'quarantine-history-total-budget')
            parsed = self.admission_parser(records)
            if ACTIVE not in records:
                require(parsed is None, 'quarantine-shared-parser-shape')
                snapshot = GuardSnapshot(None, None)
            else:
                require(type(parsed) is tuple and len(parsed) == 2 and type(parsed[0]) is dict
                        and parsed[1] == records[ACTIVE] and canonical(parsed[0]) + b'\n' == records[ACTIVE],
                        'quarantine-shared-parser-shape')
                snapshot = GuardSnapshot(records[ACTIVE], identities[ACTIVE])
            yield snapshot
            check_anchors()
            require(sorted(os.listdir(directory)) == inventory, 'quarantine-inventory-changed-under-admission')
            for name, identity in identities.items():
                require(file_identity(os.stat(name, dir_fd=directory, follow_symlinks=False)) == identity,
                        'quarantine-history-replaced-under-admission')
        finally:
            close_error = None
            for fd in reversed(fds):
                try:
                    os.close(fd)
                except OSError as error:
                    if close_error is None:
                        close_error = error
            if close_error is not None:
                raise close_error


class DrainTicket(object):
    __slots__ = ('owner', 'job_id', 'active_sha', '_seal')
    def __init__(self, owner, job_id, active_sha, seal):
        self.owner, self.job_id, self.active_sha, self._seal = owner, job_id, active_sha, seal


class AdmissionGate(object):
    def __init__(self, store, boot_id, instance, activity_reader, activity_lock, now=None):
        service_identity(instance)
        self.store, self.boot_id, self.instance = store, boot_id, dict(instance)
        self.activity_reader, self.activity_lock = activity_reader, activity_lock
        self.now = now or (lambda: datetime.datetime.now(datetime.timezone.utc))
        self._mutex, self._claims, self._tickets = threading.RLock(), {}, {}

    @contextlib.contextmanager
    def startup(self):
        """Hold before any Agent hardware initialization/default-setting effect."""
        with self.store.snapshot() as snapshot:
            require(snapshot.raw is None, 'quarantine-service-startup-held')
            yield AdmissionScope('legacy-clear-startup', False, None)

    def _guard(self, snapshot):
        return checked_guard(snapshot, self.boot_id, self.instance)

    def _claim(self, owner, snapshot):
        key = sha(snapshot.raw)
        claim = self._claims.get(key)
        require(type(owner) is object and claim is not None and claim['owner'] is owner
                and claim['identity'] == snapshot.identity and not claim['poisoned'], 'quarantine-owner-not-admitted')
        return claim

    def _unexpired(self, guard):
        require(timestamp(guard['createdAt']) <= self.now() < timestamp(guard['approvalExpiresAt']),
                'quarantine-admission-expired')

    def bind_connection(self, owner, recovery):
        require(type(owner) is object, 'quarantine-internal-owner-required')
        if recovery is None:
            # An old client may observe cached status, but never acquires a claim.
            return
        with self.store.snapshot() as snapshot:
            if snapshot.raw is None:
                require(recovery is None, 'quarantine-no-active-permit')
                return
            guard = self._guard(snapshot)
            exact(recovery, CONTEXT_KEYS)
            require(type(recovery['schemaVersion']) is int and recovery['schemaVersion'] == 1
                    and recovery['method'] == METHOD and recovery['activeSha256'] == sha(snapshot.raw), 'quarantine-permit-envelope')
            for key in ('owner', 'runId', 'action', 'planSha256', 'jobId', 'expectedQueryRevision', 'serviceInstance'):
                require(type(recovery[key]) is type(guard[key]) and recovery[key] == guard[key], 'quarantine-permit-binding')
            service_identity(recovery['serviceInstance'])
            token = recovery['permitToken']
            require(type(token) is str and HEX.fullmatch(token)
                    and hmac.compare_digest(sha(bytes.fromhex(token)), guard['ownerPermitSha256']), 'quarantine-permit-secret')
            self._unexpired(guard)
            # command() holds this mutex across the effect, which may take the
            # Agent lock. Keep the same order for owner admission.
            with self._mutex:
                with self.activity_lock:
                    activity = self.activity_reader()
                    exact(activity, ('inferenceAlive', 'frequencyChanging', 'pendingWork', 'inferenceState', 'inferenceError'))
                    require(activity['inferenceAlive'] is False and activity['frequencyChanging'] is False
                            and type(activity['pendingWork']) is int and activity['pendingWork'] == 0
                            and activity['inferenceState'] == 'STOPPED' and activity['inferenceError'] is None,
                            'quarantine-service-not-idle-at-claim')
                    key = sha(snapshot.raw)
                    require(key not in self._claims and len(self._claims) < 64, 'quarantine-permit-already-claimed')
                    self._claims[key] = {'owner': owner, 'identity': snapshot.identity, 'phase': 'bound', 'poisoned': False}

    @staticmethod
    def _body(request):
        require(type(request) is dict, 'quarantine-request-object')
        return {key: value for key, value in request.items() if key not in ('request_id', '_owner', 'recovery')}

    def _validate_command(self, claim, guard, operation, request):
        body = self._body(request)
        require(body.get('op') == operation, 'quarantine-operation-mismatch')
        if operation == 'queries':
            exact(body, ('op', 'items', 'features_f32_b64', 'identity', 'revision'))
            require(claim['phase'] == 'bound' and type(body['revision']) is int
                    and body['revision'] == guard['expectedQueryRevision'] and sha(canonical(body)) == guard['queryBodySha256'],
                    'quarantine-query-not-fixed')
            semantic = {key: value for key, value in body.items() if key != 'revision'}
            require(sha(canonical(semantic)) == QUERY_SEMANTIC_SHA, 'quarantine-query-fixture')
            return 'queried'
        if operation == 'upload_begin':
            exact(body, ('op', 'job_id'))
            require(claim['phase'] == 'queried' and body['job_id'] == guard['jobId'], 'quarantine-upload-begin')
            return 'begun'
        if operation == 'upload_finish':
            exact(body, ('op', 'job_id', 'frame_count'))
            require(claim['phase'] == 'frame' and body['job_id'] == guard['jobId']
                    and type(body['frame_count']) is int and body['frame_count'] == 1, 'quarantine-upload-finish')
            return 'finished'
        if operation == 'upload_cancel':
            exact(body, ('op', 'job_id'))
            require(guard['action'] == 'upload-cancel' and claim['phase'] == 'finished'
                    and body['job_id'] == guard['jobId'], 'quarantine-upload-cancel')
            return 'terminal'
        raise QuarantineError('quarantine-mutation-not-allowed')

    def _ticket(self, owner, job, active_sha):
        require(len(self._tickets) < 256, 'quarantine-drain-ticket-budget')
        seal = object()
        ticket = DrainTicket(owner, job, active_sha, seal)
        self._tickets[seal] = (ticket, owner, job, active_sha, {'runtimeCreated': False})
        return ticket

    @contextlib.contextmanager
    def command(self, owner, operation, request):
        require(type(operation) is str, 'quarantine-operation-type')
        entered = False
        claim, admitted = None, False
        try:
            with self.store.snapshot() as snapshot:
                entered = True
                if snapshot.raw is None:
                    ticket = None
                    if operation in ('upload_begin', 'start', 'cpu_frequency') and type(request) is dict:
                        ticket = self._ticket(owner, request.get('job_id') if operation == 'upload_begin' else 'camera', None)
                    yield AdmissionScope('legacy', False, ticket)
                elif operation in READ_ONLY:
                    yield AdmissionScope('quarantined-read-only', True, None)
                else:
                    guard = self._guard(snapshot)
                    with self._mutex:
                        claim = self._claim(owner, snapshot)
                        self._unexpired(guard)
                        next_phase = self._validate_command(claim, guard, operation, request)
                        ticket = self._ticket(owner, guard['jobId'], sha(snapshot.raw)) if operation == 'upload_begin' else None
                        admitted = True
                        try:
                            yield AdmissionScope('owned-maintenance', True, ticket)
                        except BaseException:
                            claim['poisoned'] = True
                            raise
                        claim['phase'] = next_phase
        except BaseException as error:
            if claim is not None and admitted:
                with self._mutex:
                    claim['poisoned'] = True
            if not entered and operation in READ_ONLY and isinstance(error, (OSError, ValueError)):
                yield AdmissionScope('quarantined-unreadable', True, None)
            else:
                raise

    @contextlib.contextmanager
    def frame(self, owner, metadata_raw, jpeg):
        claim, admitted = None, False
        try:
            with self.store.snapshot() as snapshot:
                if snapshot.raw is None:
                    yield AdmissionScope('legacy', False, None)
                    return
                guard = self._guard(snapshot)
                with self._mutex:
                    claim = self._claim(owner, snapshot)
                    self._unexpired(guard)
                    require(claim['phase'] == 'begun' and type(jpeg) is bytes and 0 < len(jpeg) <= 1024 * 1024
                            and sha(jpeg) == guard['imageSha256'] and type(metadata_raw) is bytes and 0 < len(metadata_raw) <= 4096
                            and sha(metadata_raw) == guard['inputMetadataSha256'], 'quarantine-frame-not-fixed')
                    meta = strict_json(metadata_raw, 4096)
                    exact(meta, ('job_id', 'frame_id', 'video_time_s', 'width', 'height'))
                    require(meta['job_id'] == guard['jobId'] and type(meta['frame_id']) is int and meta['frame_id'] == 0
                            and type(meta['video_time_s']) in (int, float) and meta['video_time_s'] == 0
                            and type(meta['width']) is int and meta['width'] == 914 and type(meta['height']) is int and meta['height'] == 512,
                            'quarantine-frame-metadata')
                    admitted = True
                    yield AdmissionScope('owned-maintenance', True, None)
                    claim['phase'] = 'frame'
        except BaseException:
            if claim is not None and admitted:
                with self._mutex:
                    claim['poisoned'] = True
            raise

    @contextlib.contextmanager
    def computation(self, owner, ticket, job_id, stage):
        require(stage in ('runtime-create', 'input-read', 'frame-submit'), 'quarantine-computation-stage')
        with self.drain(ticket, owner, job_id):
            with self.store.snapshot() as snapshot:
                claim = None
                with self._mutex:
                    lifecycle = self._tickets[ticket._seal][4]
                    if stage == 'runtime-create':
                        require(not lifecycle['runtimeCreated'], 'quarantine-runtime-already-created')
                    else:
                        require(lifecycle['runtimeCreated'], 'quarantine-runtime-not-created')
                    if snapshot.raw is None:
                        require(ticket.active_sha is None, 'quarantine-computation-history-not-live')
                    else:
                        guard = self._guard(snapshot)
                        claim = self._claim(owner, snapshot)
                        self._unexpired(guard)
                        require(ticket.active_sha == sha(snapshot.raw) and job_id == guard['jobId']
                                and claim['phase'] in ('begun', 'frame', 'finished'), 'quarantine-computation-owner')
                        if stage == 'runtime-create':
                            require(not claim.get('runtimeCreated', False), 'quarantine-runtime-already-created')
                            claim['runtimeCreated'] = True
                        else:
                            require(claim.get('runtimeCreated') is True, 'quarantine-runtime-not-created')
                            if stage == 'frame-submit':
                                require(claim['phase'] in ('frame', 'finished') and not claim.get('frameSubmitted', False),
                                        'quarantine-computation-frame')
                                claim['frameSubmitted'] = True
                    if stage == 'runtime-create':
                        lifecycle['runtimeCreated'] = True
                # Do not hold the gate mutex while waiting for input or a runtime
                # consumer: frame delivery/cancel must be able to advance/drain.
                try:
                    yield AdmissionScope('admitted-computation', False, ticket)
                except BaseException:
                    if claim is not None:
                        with self._mutex:
                            claim['poisoned'] = True
                    raise

    @contextlib.contextmanager
    def drain(self, ticket, owner, job_id):
        require(type(ticket) is DrainTicket and type(ticket._seal) is object, 'quarantine-drain-ticket')
        with self._mutex:
            held = self._tickets.get(ticket._seal)
            require(held is not None and held[0] is ticket and held[1] is owner and held[2] == job_id
                    and ticket.owner is owner and ticket.job_id == job_id and ticket.active_sha == held[3],
                    'quarantine-drain-binding')
        # No disk/clock/admission lock: cleanup must survive damaged/expired guards.
        yield AdmissionScope('already-admitted-drain-only', True, ticket)

    def retire_drain_ticket(self, ticket, owner, job_id):
        with self.drain(ticket, owner, job_id):
            with self._mutex:
                del self._tickets[ticket._seal]
