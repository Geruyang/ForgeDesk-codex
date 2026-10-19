"""Pure PS admission tests. No application, subprocess, socket or device execution."""
import ast
import contextlib
import copy
import datetime
import errno
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import sys
import threading
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'engineering/fz3b/ps-runtime/recovery_quarantine.py'
BLOCKED = []


def audit(event, _args):
    if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system':
        BLOCKED.append(event)
        raise RuntimeError('Pure PS quarantine tests forbid process/network execution')


sys.addaudithook(audit)
SPEC = importlib.util.spec_from_file_location('pure_ps_quarantine', str(SOURCE))
Q = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(Q)
SHARED_SPEC = importlib.util.spec_from_file_location('pure_shared_quarantine', str(ROOT / 'engineering/fz3b/tools/recovery_quarantine.py'))
SHARED = importlib.util.module_from_spec(SHARED_SPEC)
SHARED_SPEC.loader.exec_module(SHARED)
TOKEN = 'ab' * 32
NOW = datetime.datetime(2026, 10, 17, 0, 1, tzinfo=datetime.timezone.utc)
INSTANCE = {'mainPid': 6238, 'startTicks': 7654321}
BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'


def fixed_inputs():
    fixture = ROOT / 'engineering/fz3b/product/resources/fixture'
    query = json.loads((fixture / 'query-template.json').read_bytes().decode('utf-8'))
    query['revision'] = 7
    jpeg = (fixture / 'input.jpg').read_bytes()
    job = 'fd-recovery-0123456789ab4cde8fab0123456789ab'
    meta = {'job_id': job, 'frame_id': 0, 'video_time_s': 0.0, 'width': 914, 'height': 512}
    return query, jpeg, Q.canonical(meta)


def guard_value(action='upload-cancel'):
    query, jpeg, meta = fixed_inputs()
    value = {key: 'a' * 64 for key in Q.GUARD_KEYS if key.endswith('Sha256')}
    value.update(schemaVersion=1, method=Q.METHOD, runId='active-recovery-01234567-89ab-4cde-8fab-0123456789ab',
                 action=action, owner={'actor': 'independent-native-qa', 'generation': 'abcdef01-2345-4abc-8abc-123456789abc', 'nonce': 'c' * 64},
                 ownerPermitSha256=Q.sha(bytes.fromhex(TOKEN)), bootId=BOOT, jobId='fd-recovery-0123456789ab4cde8fab0123456789ab',
                 profileSha256=Q.PROFILE,
                 fixtureSha256=Q.FIXTURE_SHA, imageSha256=Q.IMAGE_SHA, queryBodySha256=Q.sha(Q.canonical(query)),
                 inputMetadataSha256=Q.sha(meta), expectedQueryRevision=7, serviceInstance=dict(INSTANCE),
                 createdAt='2026-10-17T00:00:00.000Z', approvalExpiresAt='2026-10-17T00:05:00.000Z')
    assert Q.sha(jpeg) == Q.IMAGE_SHA
    return value


class FakeStore:
    def __init__(self, value='default'):
        self.value = guard_value() if value == 'default' else value
        self.raw_override = None
        self.identity = ('fixture-inode', 1)
        self.held = 0
        self.error = None
        self.post_error = None
        self.calls = 0

    @contextlib.contextmanager
    def snapshot(self):
        self.calls += 1
        if self.error:
            raise self.error
        raw = self.raw_override if self.raw_override is not None else None if self.value is None else Q.canonical(self.value) + b'\n'
        self.held += 1
        try:
            yield Q.GuardSnapshot(raw, self.identity if raw is not None else None)
            if self.post_error:
                raise self.post_error
        finally:
            self.held -= 1


class GateTests(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.activity = {'inferenceAlive': False, 'frequencyChanging': False, 'pendingWork': 0,
                         'inferenceState': 'STOPPED', 'inferenceError': None}
        self.activity_lock = threading.RLock()
        def activity():
            self.assertEqual(self.store.held, 1)
            self.assertTrue(self.activity_lock._is_owned())
            return self.activity
        self.gate = Q.AdmissionGate(self.store, BOOT, INSTANCE, activity, self.activity_lock, lambda: NOW)
        self.owner = object()
        self.query, self.jpeg, self.metadata = fixed_inputs()

    def recovery(self):
        value = self.store.value
        return dict(schemaVersion=1, method=Q.METHOD, activeSha256=Q.sha(Q.canonical(value) + b'\n'),
                    owner=copy.deepcopy(value['owner']), runId=value['runId'], action=value['action'],
                    planSha256=value['planSha256'], jobId=value['jobId'], expectedQueryRevision=7,
                    serviceInstance=dict(INSTANCE), permitToken=TOKEN)

    def bind(self):
        self.gate.bind_connection(self.owner, self.recovery())

    def command(self, op, body=None, owner=None):
        request = {'op': op} if body is None else body
        with self.gate.command(self.owner if owner is None else owner, op, request) as scope:
            self.assertEqual(self.store.held, 1)
            return scope

    def reach_finished(self):
        self.bind()
        self.command('queries', self.query)
        scope = self.command('upload_begin', {'op': 'upload_begin', 'job_id': self.store.value['jobId']})
        with self.gate.frame(self.owner, self.metadata, self.jpeg):
            self.assertEqual(self.store.held, 1)
        self.command('upload_finish', {'op': 'upload_finish', 'job_id': self.store.value['jobId'], 'frame_count': 1})
        return scope.ticket

    def test_no_guard_preserves_legacy_mutations_frames_and_normal_status_under_short_sh(self):
        self.store.value = None
        self.gate.bind_connection(self.owner, None)
        for op in ('queries', 'start', 'stop', 'settings', 'cpu_frequency', 'upload_begin', 'upload_finish', 'upload_cancel', 'unknown'):
            scope = self.command(op)
            self.assertEqual(scope.mode, 'legacy')
            self.assertFalse(scope.cached_status)
        with self.gate.frame(self.owner, b'old-metadata', b'old-image') as scope:
            self.assertEqual(scope.mode, 'legacy')
            self.assertEqual(self.store.held, 1)
        self.assertFalse(self.command('status').cached_status)

    def test_startup_is_fenced_before_hardware_initialization_not_only_network_commands(self):
        effects = []
        with self.assertRaises(Q.QuarantineError):
            with self.gate.startup(): effects.append('forbidden-startup')
        self.store.error = PermissionError('guard-unreadable')
        with self.assertRaises(PermissionError):
            with self.gate.startup(): effects.append('forbidden-startup')
        self.store.error, self.store.value = None, None
        with self.gate.startup() as scope:
            self.assertEqual(self.store.held, 1)
            self.assertEqual(scope.mode, 'legacy-clear-startup')
            effects.append('clear-legacy-startup')
        self.assertEqual(effects, ['clear-legacy-startup'])

    def test_old_clients_are_readonly_cached_with_valid_corrupt_unknown_or_unreadable_guard(self):
        self.gate.bind_connection(self.owner, None)
        for raw, error in ((None, None), (b'{broken', None), (b'{"status":"unknown"}', None),
                           (None, PermissionError(errno.EACCES, 'fixture')), (None, FileNotFoundError('missing-lock'))):
            self.store.raw_override, self.store.error = raw, error
            for op in Q.READ_ONLY:
                with self.gate.command(self.owner, op, {'op': op}) as scope:
                    self.assertTrue(scope.cached_status)
            for op in ('queries', 'start', 'stop', 'settings', 'cpu_frequency', 'upload_begin', 'upload_finish', 'upload_cancel', 'preview', 'unknown'):
                with self.assertRaises(Exception): self.command(op)
            with self.assertRaises(Exception):
                with self.gate.frame(self.owner, self.metadata, self.jpeg): self.fail('frame effect must not run')

    def test_owner_context_requires_full_binding_token_service_and_busy_checks(self):
        correct = self.recovery()
        for key in correct:
            value = copy.deepcopy(correct)
            value[key] = True if key == 'schemaVersion' else 'foreign'
            with self.assertRaises(Exception): self.gate.bind_connection(self.owner, value)
        for change in ({'inferenceAlive': True}, {'frequencyChanging': True}, {'pendingWork': 1},
                       {'pendingWork': False}, {'inferenceState': 'RUNNING'}, {'inferenceError': 'failure'}):
            original = self.activity
            self.activity = dict(original, **change)
            with self.assertRaises(Q.QuarantineError): self.bind()
            self.activity = original
        self.bind()
        with self.assertRaises(Q.QuarantineError): self.bind()
        with self.assertRaises(Q.QuarantineError): self.gate.bind_connection(object(), correct)
        with self.assertRaises(Q.QuarantineError): self.gate.bind_connection(True, correct)

    def test_nested_service_booleans_and_boolean_owner_authorization_are_not_permits(self):
        self.store.value['serviceInstance']['startTicks'] = 1
        self.gate.instance['startTicks'] = 1
        value = self.recovery()
        value['serviceInstance']['startTicks'] = True
        with self.assertRaises(Q.QuarantineError): self.gate.bind_connection(self.owner, value)
        with self.assertRaises(Q.QuarantineError): self.gate.bind_connection(self.owner, True)

    def test_one_fixed_query_image_finish_and_single_cancel_only(self):
        ticket = self.reach_finished()
        self.assertIsInstance(ticket, Q.DrainTicket)
        self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': self.store.value['jobId']})
        with self.assertRaises(Q.QuarantineError): self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': self.store.value['jobId']})
        with self.assertRaises(Q.QuarantineError): self.command('queries', self.query)
        for op in ('start', 'stop', 'settings', 'cpu_frequency', 'preview', 'unknown'):
            with self.assertRaises(Q.QuarantineError): self.command(op)

    def test_exact_wire_body_hashes_and_single_frame_extent_are_required(self):
        self.bind()
        changed = copy.deepcopy(self.query); changed['revision'] = True
        with self.assertRaises(Q.QuarantineError): self.command('queries', changed)
        changed = copy.deepcopy(self.query); changed['items'][0]['label'] = 'changed'
        with self.assertRaises(Q.QuarantineError): self.command('queries', changed)
        self.command('queries', dict(self.query, request_id='correlation-only', _owner='network-owner-is-ignored'))
        with self.assertRaises(Q.QuarantineError): self.command('upload_begin', {'op': 'upload_begin', 'job_id': 'foreign'})
        self.command('upload_begin', {'op': 'upload_begin', 'job_id': self.store.value['jobId']})
        for metadata, jpeg in ((self.metadata + b' ', self.jpeg), (self.metadata, self.jpeg + b'changed')):
            with self.assertRaises(Q.QuarantineError):
                with self.gate.frame(self.owner, metadata, jpeg): self.fail('altered image admitted')
        with self.gate.frame(self.owner, self.metadata, self.jpeg): pass
        with self.assertRaises(Q.QuarantineError):
            with self.gate.frame(self.owner, self.metadata, self.jpeg): self.fail('duplicate frame admitted')
        with self.assertRaises(Q.QuarantineError): self.command('upload_finish', {'op': 'upload_finish', 'job_id': self.store.value['jobId'], 'frame_count': True})

    def test_different_owner_inode_service_or_guard_content_never_reuses_claim(self):
        self.bind()
        with self.assertRaises(Q.QuarantineError): self.command('queries', self.query, object())
        self.store.identity = ('replacement', 2)
        with self.assertRaises(Q.QuarantineError): self.command('queries', self.query)
        self.store.identity = ('fixture-inode', 1)
        self.store.value['planSha256'] = 'b' * 64
        with self.assertRaises(Q.QuarantineError): self.command('queries', self.query)
        self.store.value['serviceInstance']['startTicks'] += 1
        with self.assertRaises(Q.QuarantineError): self.gate.bind_connection(object(), self.recovery())

    def test_pre_or_post_effect_failure_is_not_replayed_and_drain_survives_unknown_expiry(self):
        ticket = self.reach_finished()
        self.gate.now = lambda: NOW + datetime.timedelta(hours=1)
        with self.assertRaises(Q.QuarantineError): self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': self.store.value['jobId']})
        self.store.error = PermissionError('guard-unreadable')
        calls = self.store.calls
        with self.gate.drain(ticket, self.owner, self.store.value['jobId']) as scope:
            self.assertEqual(scope.mode, 'already-admitted-drain-only')
        self.assertEqual(self.store.calls, calls)
        with self.assertRaises(Q.QuarantineError):
            with self.gate.drain(ticket, object(), self.store.value['jobId']): self.fail('cross-owner drain')
        fake = Q.DrainTicket(ticket.owner, ticket.job_id, ticket.active_sha, ticket._seal)
        with self.assertRaises(Q.QuarantineError):
            with self.gate.drain(fake, self.owner, ticket.job_id): self.fail('forged drain')
        with self.assertRaises(Q.QuarantineError):
            with self.gate.drain(ticket, self.owner, 'foreign'): self.fail('cross-job drain')
        self.store.error = None
        self.gate.now = lambda: NOW
        self.store.post_error = OSError('post-effect-fsync-like-uncertainty')
        with self.assertRaises(OSError): self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': ticket.job_id})
        self.store.post_error = None
        with self.assertRaises(Q.QuarantineError): self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': ticket.job_id})
        with self.gate.drain(ticket, self.owner, ticket.job_id): pass
        self.gate.retire_drain_ticket(ticket, self.owner, ticket.job_id)
        with self.assertRaises(Q.QuarantineError):
            with self.gate.drain(ticket, self.owner, ticket.job_id): self.fail('retired ticket reused')

    def test_already_queued_frequency_callback_rechecks_at_its_actual_effect(self):
        self.store.value = None
        effects = []
        with self.gate.command(self.owner, 'cpu_frequency', {'op': 'cpu_frequency', 'khz': 600000}):
            queued = lambda: self.command('cpu_frequency', {'op': 'cpu_frequency', 'khz': 600000})
        self.store.value = guard_value()
        with self.assertRaises(Q.QuarantineError):
            queued()
            effects.append('forbidden-frequency-effect')
        self.assertEqual(effects, [])

    def test_tcp_close_owner_cannot_substitute_cancel_or_new_work(self):
        self.store.value['action'] = 'tcp-close'
        ticket = self.reach_finished()
        with self.assertRaises(Q.QuarantineError): self.command('upload_cancel', {'op': 'upload_cancel', 'job_id': ticket.job_id})
        with self.gate.drain(ticket, self.owner, ticket.job_id): pass
        with self.assertRaises(Q.QuarantineError): self.command('upload_begin', {'op': 'upload_begin', 'job_id': ticket.job_id})


def metadata(kind, inode, size=0, mode=0o600):
    return types.SimpleNamespace(st_mode=kind | mode, st_uid=0, st_gid=0, st_nlink=1, st_size=size, st_dev=1,
                                 st_ino=inode, st_mtime_ns=1, st_ctime_ns=1)


class StoreTests(unittest.TestCase):
    def fixture(self, inventory=None, missing_lock=False, records=None):
        stack = contextlib.ExitStack()
        infos = {1: metadata(stat.S_IFDIR, 1, mode=0o755), 5: metadata(stat.S_IFREG, 5)}
        by_name = {}
        contents, offsets = {}, {}
        for index, (name, raw) in enumerate((records or {}).items()):
            number = index + 6
            by_name[name] = number
            infos[number] = metadata(stat.S_IFREG, number, len(raw))
            contents[number], offsets[number] = raw, 0
        directories = []
        def directory(parent, name, exact_mode=None):
            number = 2 + len(directories)
            directories.append(name)
            infos[number] = metadata(stat.S_IFDIR, number, mode=exact_mode or 0o755)
            by_name[name] = number
            return number
        def opened(name, flags, **_kwargs):
            self.assertFalse(flags & (Q.os.O_CREAT | Q.os.O_WRONLY | Q.os.O_RDWR | Q.os.O_TRUNC))
            if name == '/': return 1
            if name == Q.ADMISSION:
                if missing_lock: raise FileNotFoundError(name)
                return 5
            if name in by_name: return by_name[name]
            if name == Q.ACTIVE: raise FileNotFoundError(name)
            raise AssertionError(name)
        def read(fd, limit):
            start = offsets[fd]
            value = contents[fd][start:start + limit]
            offsets[fd] += len(value)
            return value
        fcntl = types.SimpleNamespace(LOCK_SH=1, LOCK_NB=4, flock=mock.Mock())
        stack.enter_context(mock.patch.dict(sys.modules, fcntl=fcntl))
        stack.enter_context(mock.patch.object(Q.sys, 'platform', 'linux'))
        stack.enter_context(mock.patch.object(Q.os, 'geteuid', return_value=0, create=True))
        for name, number in (('O_NOFOLLOW', 0x20000), ('O_DIRECTORY', 0x10000), ('O_NONBLOCK', 0x40000)):
            stack.enter_context(mock.patch.object(Q.os, name, number, create=True))
        stack.enter_context(mock.patch.object(Q.PosixAdmissionStore, '_directory', side_effect=directory))
        stack.enter_context(mock.patch.object(Q.os, 'open', side_effect=opened))
        stack.enter_context(mock.patch.object(Q.os, 'read', side_effect=read))
        closed = stack.enter_context(mock.patch.object(Q.os, 'close'))
        stack.enter_context(mock.patch.object(Q.os, 'fstat', side_effect=lambda fd: infos[fd]))
        stack.enter_context(mock.patch.object(Q.os, 'stat', side_effect=lambda name, **_: infos[5] if name == Q.ADMISSION else infos[by_name[name]]))
        stack.enter_context(mock.patch.object(Q.os, 'listdir', return_value=inventory if inventory is not None else sorted([Q.ADMISSION] + list(records or {}))))
        return stack, fcntl, closed

    def test_absent_guard_only_legacy_with_existing_protected_shared_nonblocking_lock(self):
        stack, fcntl, closed = self.fixture()
        with stack:
            with Q.PosixAdmissionStore(SHARED.admission_state).snapshot() as snapshot:
                self.assertIsNone(snapshot.raw)
                fcntl.flock.assert_called_once_with(5, fcntl.LOCK_SH | fcntl.LOCK_NB)
                self.assertEqual(closed.call_count, 0)
        self.assertEqual(closed.call_count, 5)

    def test_missing_lock_or_orphan_history_is_never_absent_guard_compatibility(self):
        for inventory, missing in (([Q.ADMISSION, 'prepared.json'], False), ([Q.ADMISSION], True),
                                   ([Q.ADMISSION, 'unknown.tmp'], False)):
            stack, _, closed = self.fixture(inventory, missing)
            with stack:
                with self.assertRaises(Exception):
                    with Q.PosixAdmissionStore(SHARED.admission_state).snapshot(): self.fail('unverified absence admitted')
            self.assertGreaterEqual(closed.call_count, 4)

    def test_active_pair_is_read_under_shared_lock_through_the_same_common_parser(self):
        value = guard_value()
        raw = Q.canonical(value) + b'\n'
        records = {'active.json': raw, value['runId'] + '.intent.json': raw}
        stack, fcntl, closed = self.fixture(records=records)
        parsed = mock.Mock(wraps=SHARED.admission_state)
        with stack:
            with Q.PosixAdmissionStore(parsed).snapshot() as snapshot:
                self.assertEqual(snapshot.raw, raw)
                parsed.assert_called_once_with(records)
                fcntl.flock.assert_called_once_with(5, fcntl.LOCK_SH | fcntl.LOCK_NB)
                self.assertEqual(closed.call_count, 0)
        self.assertEqual(closed.call_count, 7)
        for changed in ({value['runId'] + '.intent.json': raw},
                        dict(records, **{value['runId'] + '.uncertain.json': b'{}\n'}),
                        dict(records, **{'foreign.tmp': b'{}\n'})):
            stack, _, _ = self.fixture(records=changed)
            with stack:
                with self.assertRaises(Exception):
                    with Q.PosixAdmissionStore(SHARED.admission_state).snapshot(): self.fail('orphan/uncertain state admitted')

    def test_guard_json_closed_schema_and_python36_source(self):
        raw = Q.canonical(guard_value()) + b'\n'
        Q.checked_guard(Q.GuardSnapshot(raw, (1,)), BOOT, INSTANCE)
        for changed in (raw[:-1], b'{"x":1,"x":2}', b'{"x":NaN}', b'[]', Q.canonical(dict(guard_value(), unknown=True)) + b'\n'):
            with self.assertRaises(Exception): Q.checked_guard(Q.GuardSnapshot(changed, (1,)), BOOT, INSTANCE)
        ast.parse(SOURCE.read_text(encoding='ascii'), feature_version=(3, 6))
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
