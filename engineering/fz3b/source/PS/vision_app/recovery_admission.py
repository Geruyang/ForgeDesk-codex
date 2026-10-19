"""Service-only composition. Missing deployed guard/crypto fails before hardware."""
import collections
import contextlib
import copy
import json
import os
import re
import threading

Scope = collections.namedtuple('Scope', 'cached_status ticket')


class NewInputHeld(ValueError):
    pass


def deployed_gate(activity_reader, activity_lock):
    from . import recovery_quarantine_core as core
    from .recovery_quarantine_gate import AdmissionGate, PosixAdmissionStore
    from .host_ack_crypto import build_deployed_host_verifier
    verifier = build_deployed_host_verifier()
    if type(verifier) is not core.TrustedHostAckVerifier:
        raise ValueError('quarantine-trusted-verifier-required')
    def fixed_read(filename, limit):
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            raw = os.read(fd, limit + 1)
            if not raw or len(raw) > limit:
                raise ValueError('quarantine-service-identity-budget')
            return raw.decode('ascii').strip()
        finally:
            os.close(fd)
    boot = fixed_read('/proc/sys/kernel/random/boot_id', 64)
    if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', boot):
        raise ValueError('quarantine-service-boot')
    process = fixed_read('/proc/self/stat', 4096)
    left, right = process.find('('), process.rfind(')')
    if left < 1 or right < left or int(process[:left].strip()) != os.getpid():
        raise ValueError('quarantine-service-process')
    ticks = int(process[right + 1:].split()[19])
    if ticks <= 0:
        raise ValueError('quarantine-service-startticks')
    parser = lambda records: core.admission_state(records, verifier)
    return AdmissionGate(PosixAdmissionStore(parser), boot,
                         {'mainPid': os.getpid(), 'startTicks': ticks}, activity_reader, activity_lock)


class ServiceAdmission(object):
    """No request can provide a gate, save result, ticket or authorization bool."""
    def __init__(self, activity_reader, activity_lock, progress_reader, gate_factory=deployed_gate):
        self.gate = gate_factory(activity_reader, activity_lock)
        self.progress_reader = progress_reader
        self._observer, self._mutex = object(), threading.RLock()
        self._owners, self._work = set(), {}
        self._cache = {'type': 'status', 'protocol': 1, 'inference': {'state': 'STOPPED', 'error': None, 'frames': 0},
                       'query_revision': 0, 'upload': None}

    @staticmethod
    def _bounded(value):
        raw = json.dumps(value, allow_nan=False, separators=(',', ':'))
        if len(raw.encode('utf-8')) > 65536:
            raise ValueError('quarantine-status-budget')
        return json.loads(raw)

    def startup(self):
        return self.gate.startup()

    def bind(self, owner, recovery=None):
        if type(owner) is not object:
            raise ValueError('quarantine-owner-object')
        self.gate.bind_connection(owner, recovery)
        with self._mutex:
            if owner in self._owners or len(self._owners) >= 64:
                raise ValueError('quarantine-owner-budget')
            self._owners.add(owner)

    def _owner(self, owner):
        with self._mutex:
            if owner not in self._owners:
                raise ValueError('quarantine-owner-closed')

    @contextlib.contextmanager
    def observation(self):
        with self.gate.command(self._observer, 'status', {'op': 'status'}) as scope:
            yield scope

    def remember(self, value):
        value = self._bounded(value)
        with self._mutex:
            self._cache = value
        return copy.deepcopy(value)

    def cached(self):
        with self._mutex:
            value = copy.deepcopy(self._cache)
        progress = self._bounded(self.progress_reader())
        if set(progress) != {'inference', 'query_revision', 'upload', 'cpu_frequency_changing', 'threshold', 'result_delivery_drops'}:
            raise ValueError('quarantine-progress-shape')
        value.update(progress)
        value['quarantine'] = {'cached': True, 'hardwareRefreshed': False, 'releaseAuthorized': False}
        return self._bounded(value)

    @contextlib.contextmanager
    def command(self, owner, request):
        self._owner(owner)
        operation = request.get('op')
        ticket, state = None, None
        with self.gate.command(owner, operation, request) as scope:
            try:
                self._owner(owner)
                if operation in ('start', 'upload_begin', 'cpu_frequency'):
                    ticket = object()
                    job = request.get('job_id') if operation == 'upload_begin' else 'camera'
                    state = {'owner': owner, 'job': job, 'drain': scope.ticket, 'claimed': False,
                             'started': False, 'scheduled': False, 'done': False}
                    with self._mutex:
                        if len(self._work) >= 128:
                            raise ValueError('quarantine-work-budget')
                        self._work[ticket] = state
                try:
                    yield Scope(scope.cached_status, ticket)
                except BaseException:
                    with self._mutex:
                        if state is not None and not state['started'] and not state['scheduled']:
                            state['claimed'] = False
                    raise
            finally:
                with self._mutex:
                    claimed = state is not None and state['claimed']
                    if ticket in self._work and not claimed:
                        self._work.pop(ticket)
                if not claimed and scope.ticket is not None:
                    self.gate.retire_drain_ticket(scope.ticket, owner,
                                                 request.get('job_id') if operation == 'upload_begin' else 'camera')

    def claim_work(self, ticket, owner, job):
        with self._mutex:
            state = self._work.get(ticket)
            if not state or state['owner'] is not owner or state['job'] != job or state['claimed']:
                raise ValueError('quarantine-work-not-admitted')
            state['claimed'] = True

    @contextlib.contextmanager
    def work(self, ticket, owner, job):
        with self._mutex:
            state = self._work.get(ticket)
            if not state or not state['claimed'] or state['owner'] is not owner or state['job'] != job or state['started']:
                raise ValueError('quarantine-work-not-admitted')
            state['started'] = True
        with self.drain(ticket, owner, job):
            yield

    def work_scheduled(self, ticket):
        with self._mutex:
            state = self._work.get(ticket)
            if state is not None:
                state['scheduled'] = True

    def work_started(self, ticket):
        with self._mutex:
            state = self._work.get(ticket)
            return state is not None and (state['started'] or state['scheduled'])

    @contextlib.contextmanager
    def computation(self, ticket, owner, job, stage):
        with contextlib.ExitStack() as stack:
            try:
                self._owner(owner)
                with self._mutex:
                    state = self._work.get(ticket)
                    if not state or not state['started'] or state['done'] or state['owner'] is not owner or state['job'] != job:
                        raise ValueError('quarantine-computation-not-admitted')
                    inherited = state['drain']
                stack.enter_context(self.gate.computation(owner, inherited, job, stage))
            except (OSError, ValueError) as error:
                raise NewInputHeld('quarantine-new-input-held') from error
            yield

    @contextlib.contextmanager
    def drain(self, ticket, owner, job):
        with self._mutex:
            state = self._work.get(ticket)
            if not state or not state['claimed'] or state['owner'] is not owner or state['job'] != job:
                raise ValueError('quarantine-drain-not-admitted')
            inherited = state['drain']
        if inherited is None:
            yield
        else:
            with self.gate.drain(inherited, owner, job):
                yield

    @staticmethod
    def terminal_upload(upload_status, job_id):
        expected = {'job_id', 'received', 'completed', 'queued', 'finished', 'cancelled', 'error'}
        if type(upload_status) is not dict or set(upload_status) != expected or upload_status['job_id'] != job_id:
            raise ValueError('quarantine-upload-terminal-shape')
        counts = [upload_status[key] for key in ('received', 'completed', 'queued')]
        if not all(type(value) is int and value >= 0 for value in counts):
            raise ValueError('quarantine-upload-terminal-counts')
        return upload_status['queued'] == 0 and (upload_status['cancelled'] is True or
            upload_status['finished'] is True and upload_status['error'] is None and
            upload_status['received'] == upload_status['completed'])

    def work_done(self, ticket, upload_status=None):
        retired = None
        with self._mutex:
            state = self._work.get(ticket)
            if state:
                state['done'] = True
                completed = False
                if upload_status is not None:
                    completed = self.terminal_upload(upload_status, state['job'])
                if state['owner'] not in self._owners or state['job'] == 'camera' or completed:
                    retired = self._work.pop(ticket)
        self._retire(retired)

    def _retire(self, state):
        if state is not None and state['drain'] is not None:
            self.gate.retire_drain_ticket(state['drain'], state['owner'], state['job'])

    def close_owner(self, owner):
        retired = []
        with self._mutex:
            self._owners.discard(owner)
            for ticket, state in list(self._work.items()):
                if state['owner'] is owner and state['done']:
                    retired.append(self._work.pop(ticket))
        for state in retired:
            self._retire(state)

    def frame(self, owner, metadata_raw, jpeg):
        self._owner(owner)
        return self.gate.frame(owner, metadata_raw, jpeg)


def create_service_admission(activity_reader, activity_lock, progress_reader):
    return ServiceAdmission(activity_reader, activity_lock, progress_reader)
