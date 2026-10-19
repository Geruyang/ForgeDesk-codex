"""Independent fake-receiver regressions; no application or device execution."""
import contextlib
import importlib.util
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('independent_service_fixtures',
                                             str(HERE / 'test_ps_service_admission.py'))
FIX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIX)


class IndependentReceiverTests(unittest.TestCase):
    def test_fixed_upload_computation_is_single_frame_and_ttl_does_not_gate_cleanup(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.ready()
        fixture.store.value = FIX.BASE.guard_value()
        owner = object()
        agent.admission.bind(owner, fixture.recovery())
        agent.handle(dict(fixture.query, _owner=owner))
        module = types.ModuleType('isolated_service.upload_source')
        module.UploadSource = FIX.Job
        job_id = fixture.store.value['jobId']
        with mock.patch.dict(sys.modules, {'isolated_service.upload_source': module}):
            agent.handle(dict(op='upload_begin', job_id=job_id, _owner=owner))
        ticket = agent.upload_job.admission_ticket
        effects = []
        with agent.admission.work(ticket, owner, job_id):
            with agent.admission.computation(ticket, owner, job_id, 'runtime-create'):
                effects.append('runtime')
            with agent.admission.frame(owner, fixture.meta_raw, fixture.jpeg):
                agent.upload_job.put(FIX.json.loads(fixture.meta_raw), fixture.jpeg)
            with agent.admission.computation(ticket, owner, job_id, 'frame-submit'):
                effects.append('single-submit')
            with self.assertRaises(FIX.R.NewInputHeld):
                with agent.admission.computation(ticket, owner, job_id, 'frame-submit'):
                    effects.append('forbidden-second-submit')
            fixture.gate.now = lambda: FIX.Q.timestamp(fixture.store.value['approvalExpiresAt'])
            with self.assertRaises(FIX.R.NewInputHeld):
                with agent.admission.computation(ticket, owner, job_id, 'input-read'):
                    effects.append('forbidden-expired-input')
            fixture.store.error = OSError('cleanup must not read damaged guard')
            with agent.admission.drain(ticket, owner, job_id):
                effects.append('cleanup')
        agent.admission.work_done(ticket)
        agent.admission.close_owner(owner)
        self.assertEqual(effects, ['runtime', 'single-submit', 'cleanup'])

    def test_delayed_legacy_worker_cannot_create_runtime_after_guard_or_damage(self):
        for damaged in (False, True):
            fixture = FIX.ServiceFixture()
            agent = fixture.ready()
            owner = object()
            agent.admission.bind(owner)
            agent.handle(dict(fixture.query, _owner=owner))
            agent.handle(dict(op='start', _owner=owner))
            calls = []
            module = types.ModuleType('isolated_service.board_runtime')
            module.create_runtime = lambda _contract: calls.append('forbidden-new-runtime')
            if damaged:
                fixture.store.error = OSError('unreadable guard after scheduling')
            else:
                fixture.store.value = FIX.BASE.guard_value()
            with mock.patch.dict(sys.modules, {'isolated_service.board_runtime': module}):
                agent.infer()
            self.assertFalse(calls)
            self.assertFalse(agent.inference_enabled)
            self.assertEqual(agent.inference_state, 'STOPPED')
            self.assertIsNone(agent.inference_error)

    def test_guard_or_damage_stops_next_camera_input_but_runtime_close_still_runs(self):
        for damaged in (False, True):
            fixture = FIX.ServiceFixture()
            agent = fixture.ready()
            owner = object()
            agent.admission.bind(owner)
            agent.handle(dict(fixture.query, _owner=owner))
            agent.handle(dict(op='start', _owner=owner))
            calls = []

            def next_frame(_version, _timeout):
                calls.append('camera-input')
                return len(calls), dict(frame_id=len(calls), jpeg=b'fake-bounded-input')

            agent.frames = types.SimpleNamespace(get_after=next_frame)
            fixture.namespace['preprocess_jpeg'] = lambda _jpeg, _timings: 'pure-tensor'
            test = self

            class Runtime:
                @contextlib.contextmanager
                def iter_results(self, inputs, **_kwargs):
                    def outputs():
                        next(inputs)
                        calls.append('already-submitted')
                        if damaged:
                            fixture.store.error = OSError('guard damaged while one frame was submitted')
                        else:
                            fixture.store.value = FIX.BASE.guard_value()
                        with test.assertRaises(StopIteration):
                            next(inputs)
                        if False:
                            yield None
                    yield outputs()

                def close(self):
                    calls.append('runtime-close')

            module = types.ModuleType('isolated_service.board_runtime')
            module.create_runtime = lambda _contract: Runtime()
            with mock.patch.dict(sys.modules, {'isolated_service.board_runtime': module}):
                agent.infer()
            self.assertEqual(calls, ['camera-input', 'already-submitted', 'runtime-close'])
            self.assertFalse(agent.inference_enabled)
            self.assertEqual(agent.inference_state, 'STOPPED')
            self.assertEqual(fixture.store.held, 0)

    def test_supported_producer_and_service_effect_share_atomic_admission_lock(self):
        for producer_first in (False, True):
            records, effects, failures = {}, [], []
            lock = threading.Lock()
            intent = FIX.BASE.guard_value()

            @contextlib.contextmanager
            def exclusive():
                if not lock.acquire(False):
                    raise BlockingIOError('admission EX unavailable')
                try:
                    yield
                finally:
                    lock.release()

            @contextlib.contextmanager
            def snapshot():
                if not lock.acquire(False):
                    raise BlockingIOError('admission SH unavailable')
                try:
                    raw = records.get('active.json')
                    yield FIX.Q.GuardSnapshot(raw, ('fixed-memory-inode', 1) if raw else None)
                finally:
                    lock.release()

            def create(name, raw):
                if name in records:
                    raise FileExistsError(name)
                records[name] = raw

            producer_store = types.SimpleNamespace(
                snapshot=lambda: dict(records), admission_exclusive=exclusive,
                current_boot_id=lambda: FIX.BASE.BOOT,
                product_journal_sha256=lambda: intent['productJournalSha256'], create=create)
            producer = FIX.BASE.SHARED.RecoveryGuard(
                producer_store, lambda: FIX.BASE.SHARED.milliseconds('2026-10-17T00:01:00.000Z'))
            activity = dict(inferenceAlive=False, frequencyChanging=False, pendingWork=0,
                            inferenceState='STOPPED', inferenceError=None)
            gate = FIX.Q.AdmissionGate(types.SimpleNamespace(snapshot=snapshot),
                                       FIX.BASE.BOOT, FIX.BASE.INSTANCE, lambda: activity,
                                       threading.RLock(), lambda: FIX.BASE.NOW)
            if producer_first:
                producer.begin(intent)
                with self.assertRaises(ValueError):
                    with gate.command(object(), 'settings', dict(op='settings')):
                        effects.append('forbidden-effect')
                self.assertFalse(effects)
            else:
                def begin_once():
                    try:
                        producer.begin(intent)
                    except BaseException as error:
                        failures.append(error)

                with gate.command(object(), 'settings', dict(op='settings')):
                    worker = threading.Thread(target=begin_once)
                    worker.start()
                    worker.join(2)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(len(failures), 1)
                    self.assertIsInstance(failures[0], BlockingIOError)
                    effects.append('previously-admitted-effect')
                    self.assertFalse(records)
                self.assertFalse(records, 'a refused producer must not retry or publish later')

    def test_lost_upload_begin_ack_still_cancels_the_actual_owned_job(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.ready()
        fixture.store.value = FIX.BASE.guard_value()
        fixture.messages = [
            (1, FIX.Q.canonical(dict(op='hello', recovery=fixture.recovery()))),
            (1, FIX.Q.canonical(fixture.query)),
            (1, FIX.Q.canonical(dict(op='upload_begin', job_id=fixture.store.value['jobId']))),
        ]
        module = types.ModuleType('isolated_service.upload_source')
        module.UploadSource = FIX.Job

        class Connection:
            sends = 0
            closed = False

            def settimeout(self, _value):
                pass

            def recv(self, _limit):
                return b'one-decoded-batch'

            def sendall(self, _raw):
                self.sends += 1
                if self.sends == 3:
                    raise OSError('lost upload_begin ACK after admission')

            def close(self):
                self.closed = True

        connection = Connection()
        self.assertTrue(agent.client_limit.acquire(False))
        with mock.patch.dict(sys.modules, {'isolated_service.upload_source': module}):
            agent.tcp_client(connection, False)
        self.assertEqual(connection.sends, 3)
        self.assertIsNotNone(agent.upload_job)
        self.assertTrue(agent.upload_job.cancelled,
                        'ACK failure must still cancel the receiver-owned admitted upload')
        self.assertFalse(agent.inference_enabled)
        self.assertTrue(connection.closed)
        self.assertTrue(agent.client_limit.acquire(False), 'client capacity must be returned')
        agent.client_limit.release()

    def test_runtime_completion_racing_disconnect_does_not_skip_receiver_cleanup(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.ready()
        fixture.store.value = FIX.BASE.guard_value()
        job_id = fixture.store.value['jobId']
        prefix = len(fixture.meta_raw).to_bytes(4, 'little')
        fixture.messages = [
            (1, FIX.Q.canonical(dict(op='hello', recovery=fixture.recovery()))),
            (1, FIX.Q.canonical(fixture.query)),
            (1, FIX.Q.canonical(dict(op='upload_begin', job_id=job_id))),
            (5, prefix + fixture.meta_raw + fixture.jpeg),
            (1, FIX.Q.canonical(dict(op='upload_finish', job_id=job_id, frame_count=1))),
        ]
        module = types.ModuleType('isolated_service.upload_source')
        module.UploadSource = FIX.Job
        original_drain = agent.admission.drain

        @contextlib.contextmanager
        def completion_between_cleanup_check_and_ticket_entry(ticket, owner, job):
            agent.upload_job.completed = 1
            agent.admission.work_done(ticket, agent.upload_job.status())
            with original_drain(ticket, owner, job):
                yield

        agent.admission.drain = completion_between_cleanup_check_and_ticket_entry

        class Connection:
            reads = 0
            closed = False

            def settimeout(self, _value):
                pass

            def recv(self, _limit):
                self.reads += 1
                return b'one-decoded-batch' if self.reads == 1 else b''

            def sendall(self, _raw):
                pass

            def close(self):
                self.closed = True

        connection = Connection()
        self.assertTrue(agent.client_limit.acquire(False))
        with mock.patch.dict(sys.modules, {'isolated_service.upload_source': module}):
            agent.tcp_client(connection, False)
        self.assertEqual(agent.result_queues, [])
        self.assertEqual(agent.result_queue_owners, {})
        self.assertTrue(connection.closed)

    def test_failed_inference_spawn_retires_unstarted_work_after_disconnect(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.ready()
        owner = object()
        agent.admission.bind(owner)
        agent.handle(dict(fixture.query, _owner=owner))

        def failed_spawn(*_args, **_kwargs):
            raise RuntimeError('inference thread was never created')

        agent.spawn = failed_spawn
        with self.assertRaisesRegex(RuntimeError, 'never created'):
            agent.handle(dict(op='start', _owner=owner))
        agent.admission.close_owner(owner)
        self.assertFalse(agent.admission._work,
                         'a failed spawn has no worker that can later mark the ticket done')
        self.assertFalse(agent.inference_enabled)

    def test_completed_camera_work_does_not_exhaust_budget_on_one_open_connection(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.ready()
        owner = object()
        agent.admission.bind(owner)
        for _index in range(140):
            with agent.admission.command(owner, dict(op='start')) as scope:
                agent.admission.claim_work(scope.ticket, owner, 'camera')
            agent.admission.work_done(scope.ticket)
        agent.admission.close_owner(owner)
        self.assertFalse(agent.admission._work)

    def test_terminal_upload_status_releases_budget_for_one_persistent_owner(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.ready()
        owner = object()
        agent.admission.bind(owner)
        for index in range(140):
            job = FIX.Job('completed-upload-' + str(index))
            with agent.admission.command(owner, dict(op='upload_begin', job_id=job.job_id)) as scope:
                agent.admission.claim_work(scope.ticket, owner, job.job_id)
            job.received = job.completed = 1
            job.finish(1)
            agent.admission.work_done(scope.ticket, job.status())
        agent.admission.close_owner(owner)
        self.assertFalse(agent.admission._work)

    def test_failed_boot_defaults_closes_resources_already_initialized(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.agent()
        closed = []
        initialize = agent.initialize_hardware

        def initialize_with_owned_bridge():
            initialize()
            agent.r5 = types.SimpleNamespace(close=lambda: closed.append('owned-r5'))

        def failed_defaults():
            raise RuntimeError('boot default verification failed')

        agent.initialize_hardware = initialize_with_owned_bridge
        agent.apply_boot_defaults = failed_defaults
        with self.assertRaisesRegex(RuntimeError, 'verification failed'):
            agent.run()
        self.assertEqual(closed, ['owned-r5'])

    def test_serial_scope_postcheck_failure_closes_the_fd_before_handoff(self):
        fixture = FIX.ServiceFixture()
        agent = fixture.agent()
        fixture.store.post_error = OSError('admission snapshot postcheck failed')
        calls = []
        previous = [1, 2, 3, 4, 5, 6, [0] * 8]
        fixture.namespace['os'] = types.SimpleNamespace(
            O_RDWR=1, O_NOCTTY=2, O_NONBLOCK=4,
            open=lambda *_args: 99, close=lambda fd: calls.append(('close', fd)))
        termios = types.SimpleNamespace(CS8=1, CREAD=2, CLOCAL=4, B115200=115200,
            VMIN=0, VTIME=1, TCSANOW=0, tcgetattr=lambda _fd: previous,
            tcsetattr=lambda _fd, _when, state: calls.append(('termios', list(state))))
        with mock.patch.dict(sys.modules, {'termios': termios}):
            with self.assertRaisesRegex(OSError, 'postcheck failed'):
                agent.open_serial_device('never')
        self.assertIn(('close', 99), calls)
        self.assertEqual(calls[-1], ('close', 99))


if __name__ == '__main__':
    unittest.main()
