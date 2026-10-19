"""Isolated AST/fake-service tests; never import the app or operate a device."""
import ast
import collections
import contextlib
import copy
import datetime
import importlib.util
import json
from pathlib import Path
import queue
import socket
import sys
import threading
import time
import types
import unittest
from unittest import mock
import zlib

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, str(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BASE = load('service_gate_fixture', ROOT / 'engineering/fz3b/tests/test_ps_recovery_quarantine.py')
Q = BASE.Q
R = load('service_admission_fixture', ROOT / 'engineering/fz3b/source/PS/vision_app/recovery_admission.py')
BOARD = ROOT / 'engineering/fz3b/source/PS/vision_app/board_agent.py'
CAMERA = ROOT / 'engineering/fz3b/source/PS/vision_app/camera.py'


class Candidates:
    def __init__(self):
        self.snapshot = None

    def get(self):
        return self.snapshot

    def replace(self, items, features, revision, identity):
        self.snapshot = (items, features, revision, identity)


class Recent:
    samples = 0

    def value(self):
        return 0

    def clear(self):
        pass


class Job:
    def __init__(self, job_id):
        self.job_id = job_id
        self.received = self.completed = 0
        self.finished = self.cancelled = False
        self.error = None

    def status(self):
        return dict(job_id=self.job_id, received=self.received, completed=self.completed,
                    queued=0 if self.cancelled else self.received - self.completed, finished=self.finished,
                    cancelled=self.cancelled, error=self.error)

    def put(self, metadata, _jpeg):
        self.received += 1
        return metadata

    def finish(self, count):
        if count != self.received:
            raise ValueError('frame count')
        self.finished = True

    def cancel(self):
        self.cancelled = True


class Array:
    def reshape(self, *_args):
        return self

    def copy(self):
        return self


class ServiceFixture:
    def __init__(self, guarded=False, factory_error=False):
        self.store = BASE.FakeStore(BASE.guard_value() if guarded else None)
        self.calls, self.threads = [], []
        self.query, self.jpeg, self.meta_raw = BASE.fixed_inputs()
        self.identity = self.query['identity']
        self.gate = None
        fixture = self

        def admission(activity, lock, progress):
            if factory_error:
                raise ValueError('missing trusted provider')
            self.gate = Q.AdmissionGate(self.store, BASE.BOOT, BASE.INSTANCE, activity, lock, lambda: BASE.NOW)
            return R.ServiceAdmission(activity, lock, progress, lambda *_args: self.gate)

        def guarded_call(name):
            if not self.store.held:
                raise AssertionError('effect escaped SH: ' + name)
            self.calls.append(name)

        class Monitor:
            def __init__(self): guarded_call('monitor-create')
            def sample(self): guarded_call('monitor-sample')
            def status(self): return {}

        class Cpu:
            def __init__(self, **_kwargs): guarded_call('cpu-create')
            def set_frequency(self, _khz): guarded_call('frequency'); return {}
            def status(self): guarded_call('cpu-status'); return {'current_khz': 1}

        class Camera:
            def __init__(self, *_args, **kwargs):
                guarded_call('camera-create')
                self.process_scope = kwargs['process_scope']
                self.frames = self.gaps = self.width = self.height = self.fps = 0
                self.started, self.error = 0, None
            def run(self): raise AssertionError('No real camera loop')

        class Decoder:
            errors = 0
            def __init__(self, **_kwargs): pass
            def feed(self, _data): return fixture.messages
            def check_timeout(self): pass

        def spawn(agent, target, args=()):
            guarded_call('spawn')
            self.threads.append((target, args))
            return types.SimpleNamespace(is_alive=lambda: True)

        def encode(_kind, payload, crc):
            crc(b'bounded-wire')
            return json.dumps(payload).encode('ascii')

        source = ast.parse(BOARD.read_text(encoding='utf-8'))
        node = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'Agent')
        self.namespace = dict(__name__='isolated_service.Agent', __package__='isolated_service',
            collections=collections, threading=threading, time=time, queue=queue, socket=socket,
            json=json, zlib=zlib, math=__import__('math'), base64=__import__('base64'),
            np=types.SimpleNamespace(frombuffer=lambda *_a, **_kw: Array()),
            LatestSlot=lambda: object(), RecentFps=Recent, Candidates=Candidates,
            HardwareMonitor=Monitor, CpuPolicy=Cpu, Camera=Camera,
            create_service_admission=admission, require_loopback_bind=lambda value: value,
            load_contract=lambda _path: copy.deepcopy(self.identity),
            DEFAULT_BIND='127.0.0.1', DEFAULT_CPU_KHZ=1199999,
            signal=types.SimpleNamespace(SIGTERM=1, SIGINT=2, signal=lambda *_a: None),
            read=lambda *_a: '', Decoder=Decoder, JSON=1, INPUT_FRAME=5, RESULT_IMAGE=4,
            PREVIEW=2, encode_message=encode, parse_json_object=lambda raw: json.loads(raw),
            NewInputHeld=R.NewInputHeld,
            unpack_image=lambda raw: (json.loads(raw[4:4 + int.from_bytes(raw[:4], 'little')]), raw[4 + int.from_bytes(raw[:4], 'little'):]))
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(BOARD), 'exec'), self.namespace)
        self.Agent = self.namespace['Agent']
        self.Agent.spawn = spawn

    def agent(self):
        return self.Agent(dict(contract='pure', camera_helper='never', camera_device='never', r5_enabled=False))

    def ready(self):
        agent = self.agent()
        agent.stop = types.SimpleNamespace(wait=lambda _seconds: True, is_set=lambda: False, set=lambda: None)
        agent.run()
        return agent

    def recovery(self):
        value = self.store.value
        return dict(schemaVersion=1, method=Q.METHOD, activeSha256=Q.sha(Q.canonical(value) + b'\n'),
                    owner=copy.deepcopy(value['owner']), runId=value['runId'], action=value['action'],
                    planSha256=value['planSha256'], jobId=value['jobId'], expectedQueryRevision=7,
                    serviceInstance=copy.deepcopy(value['serviceInstance']), permitToken=BASE.TOKEN)


class ServiceTests(unittest.TestCase):
    def test_python36_grammar_and_imports_have_no_app_side_effects(self):
        for file in (BOARD, CAMERA, ROOT / 'engineering/fz3b/source/PS/vision_app/recovery_admission.py'):
            ast.parse(file.read_text(encoding='utf-8'), feature_version=(3, 6))
        with self.assertRaises((ImportError, ValueError)):
            R.ServiceAdmission(lambda: {}, threading.RLock(), lambda: {})

    def test_missing_provider_or_startup_guard_precedes_all_hardware(self):
        failed = ServiceFixture(factory_error=True)
        with self.assertRaisesRegex(ValueError, 'missing trusted provider'):
            failed.agent()
        self.assertEqual(failed.calls, [])
        for mode in ('active', 'damaged'):
            f = ServiceFixture(guarded=True)
            agent = f.agent()
            if mode == 'damaged': f.store.error = OSError('guard unreadable')
            with self.assertRaises((OSError, ValueError)):
                agent.run()
            self.assertEqual(f.calls, [])
            self.assertIsNone(agent.camera)
            self.assertIsNone(agent.r5)

    def test_clear_startup_holds_snapshot_at_actual_initialization(self):
        f = ServiceFixture()
        agent = f.ready()
        self.assertTrue(agent.initialized)
        self.assertIn('frequency', f.calls)
        self.assertIsNotNone(agent.camera.process_scope)

    def test_cached_status_and_crc_never_call_live_hardware_under_guard(self):
        f = ServiceFixture()
        agent = f.ready()
        agent.live_status = lambda: {'type': 'status', 'protocol': 1, 'stable': 'remembered'}
        self.assertEqual(agent.status()['stable'], 'remembered')
        f.store.value = BASE.guard_value()
        agent.live_status = lambda: self.fail('live status called under guard')
        agent.r5 = types.SimpleNamespace(crc=lambda _data: self.fail('R5 CRC under guard'))
        self.assertTrue(agent.status()['quarantine']['cached'])
        self.assertEqual(agent.status()['stable'], 'remembered')
        agent.wire(1, agent.status())
        f.store.error = OSError('guard unreadable')
        self.assertTrue(agent.status()['quarantine']['cached'])
        agent.wire(1, agent.status())

    def test_all_legacy_mutation_commands_refuse_without_effects(self):
        f = ServiceFixture()
        agent = f.ready()
        f.store.value = BASE.guard_value()
        owner = object()
        agent.admission.bind(owner)
        baseline = list(f.calls)
        for operation in ('queries', 'upload_begin', 'upload_finish', 'upload_cancel', 'start', 'stop', 'settings', 'cpu_frequency', 'arbitrary'):
            with self.assertRaises(ValueError):
                agent.handle({'op': operation, '_owner': owner})
        with self.assertRaises(ValueError):
            agent.start_frequency_reply({'op': 'cpu_frequency', '_owner': owner}, queue.Queue())
        self.assertEqual(f.calls, baseline)

    def test_closed_owner_and_forged_work_capability_cannot_admit(self):
        f = ServiceFixture()
        agent = f.ready()
        owner = object()
        agent.admission.bind(owner)
        agent.admission.close_owner(owner)
        with self.assertRaises(ValueError):
            agent.handle({'op': 'settings', '_owner': owner})
        with self.assertRaises(ValueError):
            with agent.admission.drain(object(), owner, 'camera'):
                self.fail('forged drain')

    def test_tcp_fixed_owner_frame_and_disconnect_drain_do_not_bypass_gate(self):
        f = ServiceFixture()
        agent = f.ready()
        agent.inference_thread = None
        f.store.value = BASE.guard_value()
        prefix = len(f.meta_raw).to_bytes(4, 'little')
        f.messages = [(1, json.dumps(dict(op='hello', recovery=f.recovery())).encode('ascii')),
                      (1, Q.canonical(f.query)), (1, Q.canonical({'op': 'upload_begin', 'job_id': f.store.value['jobId']})),
                      (5, prefix + f.meta_raw + f.jpeg),
                      (1, Q.canonical({'op': 'upload_finish', 'job_id': f.store.value['jobId'], 'frame_count': 1}))]
        module = types.ModuleType('isolated_service.upload_source')
        module.UploadSource = Job
        seen = []
        agent.r5 = types.SimpleNamespace(request=lambda *_args: seen.append((agent.upload_job.received if agent.upload_job else 0, f.store.held)),
                                        crc=lambda _data: self.fail('guarded reply RPC'))
        class Connection:
            count = 0
            closed = False
            def settimeout(self, _value): pass
            def sendall(self, _value): pass
            def recv(self, _limit):
                self.count += 1
                if self.count == 1: return b'x'
                f.store.error = OSError('damaged during cleanup')
                return b''
            def close(self): self.closed = True
        connection = Connection()
        self.assertTrue(agent.client_limit.acquire(False))
        with mock.patch.dict(sys.modules, {'isolated_service.upload_source': module}):
            agent.tcp_client(connection, False)
        self.assertTrue(connection.closed)
        self.assertTrue(agent.upload_job.cancelled)
        self.assertEqual(agent.upload_job.received, 1)
        self.assertTrue(all(held > 0 for _count, held in seen))
        self.assertEqual(seen[1][0], 1, 'R5 frame notification follows accepted queue entry')

    def test_async_and_serial_routes_have_no_unguarded_dispatch_or_crc(self):
        tree = ast.parse(BOARD.read_text(encoding='utf-8'))
        agent = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Agent')
        methods = {n.name: n for n in agent.body if isinstance(n, ast.FunctionDef)}
        serial = ast.unparse(methods['serial_loop'])
        self.assertIn('self.admission.bind(owner', serial)
        self.assertIn("req['_owner'] = owner", serial)
        self.assertIn('self.status()', serial)
        self.assertIn('self.wire(', serial)
        opened = ast.unparse(methods['open_serial_device'])
        self.assertIn('with self.admission.startup()', opened)
        self.assertIn('os.close(fd)', opened)
        self.assertIn('self.reply(request)', ast.unparse(methods['queued_reply']))
        self.assertIn('self.admission.command', ast.unparse(methods['start_frequency_reply']))

    def test_existing_serial_client_is_cached_and_cannot_mutate_or_schedule_frequency(self):
        f = ServiceFixture()
        agent = f.ready()
        baseline = list(f.calls)
        f.store.value = BASE.guard_value()
        f.messages = [(1, Q.canonical({'op': 'hello'})),
                      (1, Q.canonical({'op': 'settings', 'threshold': .7})),
                      (1, Q.canonical({'op': 'cpu_frequency', 'khz': 1}))]
        agent.live_status = lambda: self.fail('serial live status under guard')
        agent.r5 = types.SimpleNamespace(crc=lambda _raw: self.fail('serial R5 CRC'))
        class Stop:
            calls = 0
            def is_set(self):
                self.calls += 1
                return self.calls > 1
        agent.stop = Stop()
        previous, restored, closed, writes = object(), [], [], []
        # The serial FD was admitted before quarantine; no real open occurs.
        agent.open_serial_device = lambda _device: (99, previous)
        f.namespace['os'] = types.SimpleNamespace(read=lambda *_a: b'x', write=lambda _fd, raw: writes.append(raw) or len(raw),
                                                close=lambda fd: closed.append(fd))
        f.namespace['select'] = types.SimpleNamespace(select=lambda *_a: ([99], [99], []))
        termios = types.ModuleType('termios')
        termios.TCSANOW = 0
        termios.tcsetattr = lambda fd, _mode, value: restored.append((fd, value))
        with mock.patch.dict(sys.modules, {'termios': termios}):
            agent.serial_loop('never')
        self.assertEqual(agent.threshold, .2)
        self.assertEqual(f.calls, baseline)
        self.assertTrue(writes)
        self.assertEqual(restored, [(99, previous)])
        self.assertEqual(closed, [99])
        self.assertEqual(agent.admission._owners, set())

    def test_new_serial_open_is_rejected_before_device_or_termios_access(self):
        f = ServiceFixture()
        agent = f.ready()
        f.store.value = BASE.guard_value()
        f.namespace['os'] = types.SimpleNamespace(open=lambda *_a: self.fail('new serial device open'))
        with mock.patch.dict(sys.modules, {'termios': types.ModuleType('termios')}):
            with self.assertRaises(ValueError):
                agent.open_serial_device('never')

    def test_owner_bind_does_not_take_activity_lock_while_waiting_for_command_mutex(self):
        store, attempted, activity_taken, done = BASE.FakeStore(), threading.Event(), threading.Event(), threading.Event()
        main = threading.get_ident()
        class Lock:
            def __init__(self, kind): self.kind, self.lock = kind, threading.RLock()
            def __enter__(self):
                if threading.get_ident() != main:
                    (attempted if self.kind == 'gate' else activity_taken).set()
                self.lock.acquire()
                return self
            def __exit__(self, *_a): self.lock.release()
        activity_lock = Lock('activity')
        state = {'inferenceAlive': False, 'frequencyChanging': False, 'pendingWork': 0,
                 'inferenceState': 'STOPPED', 'inferenceError': None}
        gate = Q.AdmissionGate(store, BASE.BOOT, BASE.INSTANCE, lambda: state, activity_lock, lambda: BASE.NOW)
        gate._mutex = Lock('gate')
        f = ServiceFixture(guarded=True)
        errors = []
        def worker():
            try: gate.bind_connection(object(), f.recovery())
            except BaseException as error: errors.append(error)
            finally: done.set()
        with gate._mutex:
            thread = threading.Thread(target=worker)
            thread.start()
            try:
                self.assertTrue(attempted.wait(2))
                self.assertFalse(activity_taken.is_set(), 'opposite order would deadlock an admitted command taking Agent.lock')
            finally:
                pass
        self.assertTrue(done.wait(2))
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])

    def test_owned_runtime_and_single_submit_need_current_permit_but_drain_survives_expiry(self):
        f = ServiceFixture()
        agent = f.ready()
        f.store.value = BASE.guard_value()
        owner = object()
        agent.admission.bind(owner, f.recovery())
        query = dict(f.query, _owner=owner)
        agent.handle(query)
        upload = types.ModuleType('isolated_service.upload_source')
        upload.UploadSource = Job
        with mock.patch.dict(sys.modules, {'isolated_service.upload_source': upload}):
            agent.handle(dict(op='upload_begin', job_id=f.store.value['jobId'], _owner=owner))
        job = agent.upload_job
        with agent.admission.work(job.admission_ticket, owner, job.job_id):
            with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'runtime-create'):
                self.assertEqual(f.store.held, 1)
            with self.assertRaises(R.NewInputHeld):
                with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'runtime-create'):
                    self.fail('second runtime')
            with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'input-read'):
                self.assertEqual(f.store.held, 1)
            with agent.admission.frame(owner, f.meta_raw, f.jpeg):
                job.put(json.loads(f.meta_raw), f.jpeg)
            agent.handle(dict(op='upload_finish', job_id=job.job_id, frame_count=1, _owner=owner))
            with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'frame-submit'):
                self.assertEqual(f.store.held, 1)
            with self.assertRaises(R.NewInputHeld):
                with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'frame-submit'):
                    self.fail('second fixed frame')
            f.gate.now = lambda: BASE.NOW + datetime.timedelta(minutes=10)
            with self.assertRaises(R.NewInputHeld):
                with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'input-read'):
                    self.fail('expired new input')
            f.store.error = OSError('damaged after admission')
            with agent.admission.drain(job.admission_ticket, owner, job.job_id):
                job.cancel()
        agent.admission.work_done(job.admission_ticket, job.status())
        self.assertEqual(agent.admission._work, {})

    def test_owned_input_wait_does_not_lock_out_the_frame_producer(self):
        f = ServiceFixture()
        agent = f.ready()
        f.store.value = BASE.guard_value()
        owner = object()
        agent.admission.bind(owner, f.recovery())
        agent.handle(dict(f.query, _owner=owner))
        upload = types.ModuleType('isolated_service.upload_source')
        upload.UploadSource = Job
        with mock.patch.dict(sys.modules, {'isolated_service.upload_source': upload}):
            agent.handle(dict(op='upload_begin', job_id=f.store.value['jobId'], _owner=owner))
        job, done, errors = agent.upload_job, threading.Event(), []
        def deliver():
            try:
                with agent.admission.frame(owner, f.meta_raw, f.jpeg):
                    job.put(json.loads(f.meta_raw), f.jpeg)
            except BaseException as error: errors.append(error)
            finally: done.set()
        with agent.admission.work(job.admission_ticket, owner, job.job_id):
            with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'runtime-create'):
                pass
            with agent.admission.computation(job.admission_ticket, owner, job.job_id, 'input-read'):
                thread = threading.Thread(target=deliver)
                thread.start()
                delivered = done.wait(2)
            thread.join(2)
        self.assertTrue(delivered, 'waiting input must not retain the command mutex')
        self.assertEqual(errors, [])
        self.assertEqual(job.received, 1)


class CameraScopeTests(unittest.TestCase):
    def test_post_creation_snapshot_error_still_closes_the_owned_helper(self):
        source = ast.parse(CAMERA.read_text(encoding='utf-8'))
        camera = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'Camera')
        calls = []
        @contextlib.contextmanager
        def scope():
            yield
            raise ValueError('snapshot postcheck failed')
        class Process:
            stdout = types.SimpleNamespace(close=lambda: calls.append('close'))
            def poll(self): return None
            def terminate(self): calls.append('terminate')
            def wait(self, **_kw): calls.append('wait')
        namespace = {'time': time, 'contextlib': contextlib,
                     'subprocess': types.SimpleNamespace(Popen=lambda *_a, **_kw: Process(), PIPE=-1, TimeoutExpired=TimeoutError)}
        exec(compile(ast.Module(body=[camera], type_ignores=[]), str(CAMERA), 'exec'), namespace)
        value = namespace['Camera'](object(), types.SimpleNamespace(is_set=lambda: False), 'never', 'never', process_scope=scope)
        value.run()
        self.assertEqual(calls, ['terminate', 'wait', 'close'])
        self.assertIn('snapshot postcheck failed', value.error)

    def test_actual_popen_is_scoped_restarts_refuse_but_cleanup_is_not_gated(self):
        source = ast.parse(CAMERA.read_text(encoding='utf-8'))
        camera = next(n for n in source.body if isinstance(n, ast.ClassDef) and n.name == 'Camera')
        state = {'held': 0, 'guarded': False, 'created': 0, 'cleanup': 0}
        @contextlib.contextmanager
        def scope():
            if state['guarded']: raise ValueError('quarantined camera restart')
            state['held'] += 1
            try: yield
            finally: state['held'] -= 1
        class Process:
            stdout = types.SimpleNamespace(close=lambda: state.__setitem__('cleanup', state['cleanup'] + 1))
            def poll(self): return 0
            def wait(self, **_kwargs): return 0
        def popen(*_args, **_kwargs):
            self.assertEqual(state['held'], 1)
            state['created'] += 1
            return Process()
        header = types.SimpleNamespace(size=1, unpack=lambda _raw: (0x43414d31, 1, 0, 0, 0))
        namespace = {'time': time, 'contextlib': contextlib, 'CAM_HEADER': header,
                     'subprocess': types.SimpleNamespace(Popen=popen, PIPE=-1, TimeoutExpired=TimeoutError)}
        exec(compile(ast.Module(body=[camera], type_ignores=[]), str(CAMERA), 'exec'), namespace)
        slot = types.SimpleNamespace(publish=lambda _frame: state.__setitem__('guarded', True))
        value = namespace['Camera'](slot, types.SimpleNamespace(is_set=lambda: False), 'never', 'never', process_scope=scope)
        value._exact = lambda _size: b'x'
        value.run()
        self.assertEqual(state['created'], 1)
        self.assertEqual(state['cleanup'], 1)
        self.assertIn('quarantined camera restart', value.error)


if __name__ == '__main__':
    unittest.main()
