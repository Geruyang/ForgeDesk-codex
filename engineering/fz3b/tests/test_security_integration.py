"""Independent offline integration tests; never construct Agent or connect hardware."""
import argparse
import ast
import contextlib
import hashlib
import importlib
import io
import json
from pathlib import Path
import queue
import socket
import struct
import sys
import threading
import time
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "engineering/fz3b/source"
EVIDENCE = ROOT / "output/hardware/2026-10-16-continuation/security-review"
BLOCKED = []
AUDIT_ACTIVE = False


def audit(event, args):
    if not AUDIT_ACTIVE:
        return
    if event.startswith(("socket.", "subprocess.", "os.exec", "os.spawn")) or event == "os.system":
        BLOCKED.append(event)
        raise RuntimeError("Security integration tests prohibit sockets and child processes")
    if event == "import":
        name = args[0]
        if name.split(".")[0] in ("serial", "pyocd", "paramiko") or any(
                part in name.split(".") for part in ("board_agent", "board_runtime", "hardware_monitor")):
            BLOCKED.append("import:" + name)
            raise RuntimeError("Security integration tests prohibit hardware imports")
    if event == "open" and isinstance(args[0], (str, bytes)):
        name = str(args[0]).replace("\\", "/").lower()
        if name.startswith(("/dev/", "//./", "//?/globalroot/")):
            BLOCKED.append("open-device")
            raise RuntimeError("Security integration tests prohibit device paths")


sys.addaudithook(audit)


def setUpModule():
    global AUDIT_ACTIVE
    AUDIT_ACTIVE = True


def tearDownModule():
    global AUDIT_ACTIVE
    AUDIT_ACTIVE = False


def pure(side, name):
    package = "fz3b_security_" + side.lower()
    if package not in sys.modules:
        module = types.ModuleType(package)
        module.__path__ = [str(SOURCE / side / "vision_app")]
        sys.modules[package] = module
    return importlib.import_module(package + "." + name)


def extracted(side, file, owner, method, namespace):
    tree = ast.parse((SOURCE / side / "vision_app" / file).read_text(encoding="utf-8"))
    node = next(item for item in tree.body if isinstance(item, ast.ClassDef) and item.name == owner)
    function = next(item for item in node.body if isinstance(item, ast.FunctionDef) and item.name == method)
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    scope = dict(namespace)
    exec(compile(module, str(SOURCE / side / "vision_app" / file), "exec"), scope)
    return scope[method]


def board_constant(name):
    tree = ast.parse((SOURCE / "PS/vision_app/board_agent.py").read_text(encoding="utf-8"))
    statement = next(item for item in tree.body if isinstance(item, ast.Assign) and
                     any(isinstance(target, ast.Name) and target.id == name for target in item.targets))
    return ast.literal_eval(statement.value)


def loopback_guard(value):
    tree = ast.parse((SOURCE / "PS/vision_app/board_agent.py").read_text(encoding="utf-8"))
    node = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == "require_loopback_bind")
    scope = {"ipaddress": importlib.import_module("ipaddress")}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), "loopback-guard", "exec"), scope)
    return scope["require_loopback_bind"](value)


def jpeg(width=320, height=240):
    from PIL import Image
    output = io.BytesIO()
    with Image.new("RGB", (width, height), (16, 32, 48)) as image:
        image.save(output, format="JPEG")
    return output.getvalue()


def metadata(**changes):
    result = {"job_id": "qa-job", "frame_id": 0, "video_time_s": 0.0, "width": 320, "height": 240}
    result.update(changes)
    return result


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now


class Slot:
    def __init__(self):
        self.held = False
        self.releases = 0

    def acquire(self, unused=False):
        if self.held:
            return False
        self.held = True
        return True

    def release(self):
        if not self.held:
            raise AssertionError("client slot released twice")
        self.held = False
        self.releases += 1


class Connection:
    def __init__(self, actions=(), clock=None):
        self.actions = iter(actions)
        self.clock = clock or Clock()
        self.sent = []
        self.closed = 0
        self.receives = 0

    def settimeout(self, unused):
        pass

    def recv(self, unused):
        self.receives += 1
        delay, value = next(self.actions, (0, b""))
        self.clock.now += delay
        if isinstance(value, BaseException):
            raise value
        return value

    def sendall(self, payload):
        self.sent.append(payload)

    def close(self):
        self.closed += 1

    def getpeername(self):
        return ("127.0.0.1", 50000)


class ClearAdmissionFixture:
    """Explicit clear-state seam for the pre-existing protocol/image tests.

    Guard/owner authorization is exercised by test_ps_service_admission instead;
    the real service has no missing-admission fallback.
    """
    def bind(self, owner, recovery=None):
        if recovery is not None:
            raise ValueError('This legacy fixture has no recovery permit')

    def close_owner(self, owner):
        pass

    @contextlib.contextmanager
    def command(self, owner, request):
        yield types.SimpleNamespace(cached_status=False, ticket=object())

    @contextlib.contextmanager
    def frame(self, owner, metadata_raw, jpeg):
        yield

    @contextlib.contextmanager
    def drain(self, ticket, owner, job_id):
        yield


def handler_fixture(actions, clock=None):
    protocol = pure("PS", "protocol")
    clock = clock or Clock()
    environment = dict(Decoder=protocol.Decoder, JSON=protocol.JSON, PREVIEW=protocol.PREVIEW,
                       RESULT_IMAGE=protocol.RESULT_IMAGE, IMAGE_CHUNK=protocol.IMAGE_CHUNK,
                       INPUT_FRAME=protocol.INPUT_FRAME, unpack_image=protocol.unpack_image,
                       pack_image=protocol.pack_image, queue=queue, socket=socket, json=json,
                       time=types.SimpleNamespace(monotonic=clock.monotonic))
    if hasattr(protocol, "parse_json_object"):
        environment["parse_json_object"] = protocol.parse_json_object
    function = extracted("PS", "board_agent.py", "Agent", "tcp_client", environment)
    slot = Slot()
    slot.acquire()
    instance = types.SimpleNamespace(stop=threading.Event(), lock=threading.RLock(),
        result_queues=[], result_queue_owners={}, result_frames={}, client_limit=slot,
        input_source="upload", inference_enabled=False, upload_job=None, r5=None, admission=ClearAdmissionFixture(),
        wire=protocol.encode_message, status=lambda: {"type": "status"},
        accept_hello=lambda value: isinstance(value, dict) and value.get("op") == "hello")
    instance.reply = lambda request: {"type": "ack", "ok": True, "op": request.get("op")}
    return function, instance, Connection(actions, clock), slot, protocol


class Images(unittest.TestCase):
    def test_narrow_image_rejected_before_decoder_load_or_resize(self):
        boundary = pure("PS", "image_boundary")
        camera = pure("PS", "camera")
        events = []

        class Opened:
            size = (1, 8192)
            format = "JPEG"
            mode = "RGB"

            def load(self):
                events.append("load")
                raise AssertionError("An over-budget image must not load")

            def close(self):
                events.append("close")

            def __enter__(self):
                return self

            def __exit__(self, *unused):
                self.close()

        with mock.patch.object(boundary.Image, "open", return_value=Opened()) as opened:
            with self.assertRaises(ValueError):
                camera.preprocess_jpeg(b"\xff\xd8tiny-compressed-fixture\xff\xd9")
        opened.assert_called_once()
        self.assertNotIn("load", events)

    def test_normal_image_preserves_tensor_shape_and_finite_values(self):
        camera = pure("PS", "camera")
        tensor = camera.preprocess_jpeg(jpeg())
        self.assertEqual(tensor.shape, (1, 3, 256, 256))
        self.assertEqual(str(tensor.dtype), "float32")
        self.assertTrue(camera.np.isfinite(tensor).all())
        self.assertGreaterEqual(float(tensor.min()), 0.0)
        self.assertLessEqual(float(tensor.max()), 1.0)

    def test_budget_helper_rejects_types_source_extent_and_resize_amplification(self):
        boundary = pure("PS", "image_boundary")
        self.assertEqual(boundary.checked_resize_size(320, 240), (341, 256))
        for size in ((True, 240), (320.0, 240), (0, 1), (-1, 1), (1, 8192),
                     (8193, 1), (4096, 4096)):
            with self.subTest(size=size), self.assertRaises(ValueError):
                boundary.checked_resize_size(*size)

    def test_bad_metadata_or_image_cannot_change_upload_state(self):
        upload = pure("PS", "upload_source")
        image = jpeg()
        cases = [({}, image), (metadata(frame_id=True), image), (metadata(frame_id=2 ** 32), image),
                 (metadata(job_id="other-job"), image), (metadata(width=True), image), (metadata(width=float("nan")), image),
                 (metadata(height=239), image), (metadata(extra="untrusted"), image),
                 (metadata(video_time_s=True), image), (metadata(video_time_s=float("inf")), image),
                 (metadata(), b"not-a-JPEG"), (metadata(width=1, height=8192), jpeg(1, 8192))]
        for meta, data in cases:
            source = upload.UploadSource("qa-job")
            before = source.status()
            with self.subTest(meta=meta), self.assertRaises((ValueError, TypeError)):
                source.put(meta, data)
            self.assertEqual(source.status(), before)
            self.assertEqual(len(source.frames), 0)

    def test_successful_admission_returns_copy_and_owns_immutable_jpeg(self):
        source = pure("PS", "upload_source").UploadSource("qa-job")
        meta = metadata()
        image = bytearray(jpeg())
        accepted = source.put(meta, image)
        self.assertIsInstance(accepted, dict)
        self.assertEqual(source.received, 1)
        meta["width"] = 1
        image[0] = 0
        accepted["width"] = 1
        queued = source.take(0)
        self.assertEqual(queued["width"], 320)
        self.assertIsInstance(queued["jpeg"], bytes)
        self.assertEqual(queued["jpeg"][:2], b"\xff\xd8")


class Protocol(unittest.TestCase):
    def test_ps_and_host_strict_json_reject_nonfinite_duplicates_and_depth(self):
        invalid = [b'{"v":NaN}', b'{"v":Infinity}', b'{"v":-Infinity}',
                   b'{"v":1,"v":2}', b'{"v":{"x":1,"x":2}}',
                   b'{"v":' * 80 + b'0' + b'}' * 80, b'[]', b'"scalar"']
        for side in ("PS", "HOST"):
            parse = pure(side, "protocol").parse_json_object
            self.assertEqual(parse(b'{"ok":true,"n":1}'), {"ok": True, "n": 1})
            for body in invalid:
                with self.subTest(side=side, body=body[:60]), self.assertRaises(ValueError):
                    parse(body)

    def test_metadata_wire_parser_uses_same_strict_json_boundary(self):
        for side in ("PS", "HOST"):
            protocol = pure(side, "protocol")
            for body in (b'{"frame_id":0,"width":NaN}',
                         b'{"frame_id":0,"frame_id":1}',
                         b'{"frame_id":0,"nested":' + b'[' * 80 + b'0' + b']' * 80 + b'}'):
                with self.subTest(side=side, body=body[:60]), self.assertRaises(ValueError):
                    protocol.unpack_image(struct.pack("<I", len(body)) + body + b"jpeg")

    def test_incomplete_legal_body_expires_without_new_bytes(self):
        for side in ("PS", "HOST"):
            protocol = pure(side, "protocol")
            decoder = protocol.Decoder()
            full = protocol.encode_message(protocol.JSON, {"op": "status"})
            self.assertEqual(decoder.feed(full[:17], now=0.0), [])
            with self.assertRaises(TimeoutError):
                decoder.check_timeout(now=100.0)

    def test_deadline_allows_valid_fragmented_completion(self):
        for side in ("PS", "HOST"):
            protocol = pure(side, "protocol")
            decoder = protocol.Decoder()
            full = protocol.encode_message(protocol.JSON, {"op": "status"})
            self.assertEqual(decoder.feed(full[:17], now=0.0), [])
            self.assertEqual(decoder.feed(full[17:], now=0.01),
                             [(protocol.JSON, protocol.json_bytes({"op": "status"}))])
            decoder.check_timeout(now=100.0)


class ServerIntegration(unittest.TestCase):
    def test_idle_socket_timeout_expires_body_and_returns_slot(self):
        protocol = pure("PS", "protocol")
        full = protocol.encode_message(protocol.JSON, {"op": "status"})
        function, instance, connection, slot, unused = handler_fixture([
            (0, protocol.encode_message(protocol.JSON, {"op": "hello"})),
            (0.1, full[:17]), (100, socket.timeout("no more bytes"))])
        with mock.patch.object(protocol.time, "monotonic", connection.clock.monotonic):
            function(instance, connection, False)
        self.assertEqual(connection.receives, 3, "deadline must be checked on idle timeout, not a fourth read")
        self.assertEqual(connection.closed, 1)
        self.assertEqual(slot.releases, 1)
        self.assertFalse(slot.held)
        self.assertEqual(instance.result_queues, [])
        self.assertEqual(instance.result_queue_owners, {})

    def test_r5_notification_follows_actual_admission_and_invalid_input_notifies_nothing(self):
        protocol = pure("PS", "protocol")
        upload = pure("PS", "upload_source")
        for valid in (False, True):
            with self.subTest(valid=valid):
                meta = metadata() if valid else metadata(height=239)
                function, instance, connection, slot, unused = handler_fixture([
                    (0, protocol.encode_message(protocol.JSON, {"op": "hello"})),
                    (0, protocol.encode_message(protocol.JSON, {"op": "upload_begin"})),
                    (0, protocol.encode_message(protocol.INPUT_FRAME, protocol.pack_image(meta, jpeg())))])
                notices = []
                source = upload.UploadSource("qa-job")
                source.admission_ticket = object()
                instance.r5 = types.SimpleNamespace(request=lambda *args: notices.append((args, source.received)))

                def reply(request):
                    source.owner = request["_owner"]
                    instance.upload_job = source
                    return {"type": "ack", "ok": True}

                instance.reply = reply
                function(instance, connection, False)
                self.assertEqual(notices, [((0, 13, 0), 1)] if valid else [])
                self.assertEqual(source.received, int(valid))
                self.assertEqual(slot.releases, 1)

    def test_nonloopback_listen_rejected_before_socket_creation(self):
        attempted = []
        fake_socket = types.SimpleNamespace(socket=lambda: attempted.append(True))
        function = extracted("PS", "board_agent.py", "Agent", "listen", dict(
            socket=fake_socket, require_loopback_bind=loopback_guard,
            DEFAULT_BIND=board_constant("DEFAULT_BIND")))
        for bind in ("0.0.0.0", "192.0.2.1", "::", "::1"):
            instance = types.SimpleNamespace(config={"bind": bind})
            with self.subTest(bind=bind), self.assertRaises((ValueError, PermissionError)):
                function(instance, 8765, False)
        self.assertEqual(attempted, [])

    def test_default_bind_is_loopback_and_spawn_failure_returns_client_slot(self):
        self.assertEqual(board_constant("DEFAULT_BIND"), "127.0.0.1")
        connection = Connection()
        binds = []

        class Listener:
            closed = 0

            def setsockopt(self, *unused):
                pass

            def bind(self, value):
                binds.append(value)

            def listen(self, unused):
                pass

            def settimeout(self, unused):
                pass

            def accept(self):
                return connection, ("127.0.0.1", 50000)

            def close(self):
                self.closed += 1

        listener = Listener()
        fake_socket = types.SimpleNamespace(socket=lambda: listener, SOL_SOCKET=1, SO_REUSEADDR=2,
                                            timeout=socket.timeout)
        function = extracted("PS", "board_agent.py", "Agent", "listen", dict(
            socket=fake_socket, require_loopback_bind=loopback_guard,
            DEFAULT_BIND=board_constant("DEFAULT_BIND")))
        slot = Slot()

        def failed_spawn(*unused):
            raise RuntimeError("Synthetic thread-start failure")

        instance = types.SimpleNamespace(config={}, listeners=[], stop=threading.Event(),
                                         client_limit=slot, spawn=failed_spawn, tcp_client=lambda: None)
        with self.assertRaisesRegex(RuntimeError, "thread-start failure"):
            function(instance, 8765, False)
        self.assertEqual(binds, [("127.0.0.1", 8765)])
        self.assertEqual(listener.closed, 1)
        self.assertEqual(connection.closed, 1)
        self.assertEqual(slot.releases, 1)
        self.assertFalse(slot.held)

    def test_duplicate_control_request_cannot_reach_dispatch_and_slot_returns(self):
        protocol = pure("PS", "protocol")
        function, instance, connection, slot, unused = handler_fixture([
            (0, protocol.encode_message(protocol.JSON, {"op": "hello"})),
            (0, protocol.encode_message(protocol.JSON, b'{"op":"status","op":"stop"}'))])
        calls = []
        instance.reply = lambda request: calls.append(request)
        function(instance, connection, False)
        self.assertEqual(calls, [])
        self.assertEqual(connection.closed, 1)
        self.assertEqual(slot.releases, 1)
        self.assertEqual(instance.result_queues, [])

    def test_close_error_does_not_retain_client_slot(self):
        function, instance, connection, slot, unused = handler_fixture([])

        def failed_close():
            connection.closed += 1
            raise OSError("Synthetic socket close failure")

        connection.close = failed_close
        try:
            function(instance, connection, False)
        except OSError as error:
            self.assertIn("socket close failure", str(error))
        self.assertEqual(connection.closed, 1)
        self.assertEqual(slot.releases, 1)
        self.assertFalse(slot.held)


class HostUnknownState(unittest.TestCase):
    def test_remote_control_endpoint_refused_before_connection_attempt(self):
        protocol = pure("HOST", "protocol")
        transport = pure("HOST", "transports")
        attempts, errors = [], []
        environment = dict(socket=types.SimpleNamespace(create_connection=lambda *args, **kwargs: attempts.append(args)),
                           time=time, queue=queue, Decoder=protocol.Decoder, JSON=protocol.JSON,
                           encode_message=protocol.encode_message,
                           require_loopback_host=transport.require_loopback_host)
        function = extracted("HOST", "transports.py", "Link", "_tcp", environment)
        discard = extracted("HOST", "transports.py", "Link", "_discard_outgoing", dict(queue=queue))
        instance = types.SimpleNamespace(stop=threading.Event(), outgoing=queue.Queue(), on_error=errors.append)
        instance._discard_outgoing = lambda: discard(instance)
        for host in ("169.254.220.254", "0.0.0.0", "board.example", "192.0.2.1"):
            function(instance, host, 8765, False)
        self.assertEqual(attempts, [])
        self.assertEqual(len(errors), 4)
        self.assertTrue(all("loopback" in error for error in errors))

    def test_ambiguous_send_is_not_replayed_after_manual_reconnect(self):
        protocol = pure("HOST", "protocol")
        transport = pure("HOST", "transports")
        commands = [protocol.encode_message(protocol.JSON, {"op": "start", "request_id": "qa-first"}),
                    protocol.encode_message(protocol.JSON, {"op": "cpu_frequency", "request_id": "qa-queued"})]
        outgoing = queue.Queue()
        for command in commands:
            outgoing.put_nowait(command)
        errors, messages, sent_commands = [], [], []
        handshaken = []

        class Endpoint(Connection):
            def __init__(self, fail_send):
                super().__init__([(0, protocol.encode_message(protocol.JSON, {"type": "hello", "ok": True, "protocol": 1}))])
                self.fail_send = fail_send

            def recv(self, size):
                if self.receives == 0:
                    self_test.assertFalse(any(body in commands for body in self.sent),
                                          "No queued write may precede HELLO")
                handshaken.append(True)
                return super().recv(size)

            def sendall(self, body):
                super().sendall(body)
                if body in commands:
                    self_test.assertTrue(handshaken)
                    sent_commands.append(body)
                    if self.fail_send:
                        raise OSError("Synthetic ambiguous write; remote outcome unknown")

        self_test = self
        endpoints = [Endpoint(True), Endpoint(False)]
        available = iter(endpoints)
        fake_socket = types.SimpleNamespace(create_connection=lambda *args, **kwargs: next(available),
                                            timeout=socket.timeout)
        environment = dict(socket=fake_socket, time=time, queue=queue, Decoder=protocol.Decoder,
                           JSON=protocol.JSON, PREVIEW=protocol.PREVIEW, RESULT_IMAGE=protocol.RESULT_IMAGE,
                           encode_message=protocol.encode_message,
                           require_loopback_host=transport.require_loopback_host,
                           is_handshake_reply=transport.is_handshake_reply)
        function = extracted("HOST", "transports.py", "Link", "_tcp", environment)
        discard = extracted("HOST", "transports.py", "Link", "_discard_outgoing", dict(queue=queue))
        instance = types.SimpleNamespace(stop=threading.Event(), outgoing=outgoing, endpoints=[],
            state=types.SimpleNamespace(accept=lambda kind, body: protocol.parse_json_object(body)),
            on_frame=None, on_result_image=None, on_error=errors.append, on_message=messages.append)
        instance._discard_outgoing = lambda: discard(instance)
        function(instance, "127.0.0.1", 8765, False)
        self.assertEqual(sent_commands, commands[:1])
        self.assertTrue(outgoing.empty())
        self.assertTrue(any("remote outcome unknown" in error for error in errors))
        self.assertEqual(endpoints[0].closed, 1)
        handshaken.clear()
        # A separate explicit reconnect is allowed, but no queued old operation survives.
        function(instance, "127.0.0.1", 8765, False)
        self.assertEqual(sent_commands, commands[:1])
        self.assertEqual(endpoints[1].closed, 1)


class FrequencyGate(unittest.TestCase):
    def methods(self):
        queued = extracted("PS", "board_agent.py", "Agent", "queued_reply", dict(queue=queue))
        try:
            raw_start = extracted("PS", "board_agent.py", "Agent", "start_frequency_reply", {})
            schedule = extracted("PS", "board_agent.py", "Agent", "schedule_frequency_reply", {})
            def start(instance, *args):
                instance.schedule_frequency_reply = types.MethodType(schedule, instance)
                return raw_start(instance, *args)
        except StopIteration:
            start = None  # The old TCP implementation does not call this new helper.
        return start, queued

    def test_tcp_frequency_requests_have_one_global_worker_and_stop_is_not_queued(self):
        protocol = pure("PS", "protocol")
        function, instance, connection, slot, unused = handler_fixture([
            (0, protocol.encode_message(protocol.JSON, {"op": "hello"})),
            (0, protocol.encode_message(protocol.JSON, {"op": "cpu_frequency", "request_id": "cpu-1"})),
            (0, protocol.encode_message(protocol.JSON, {"op": "cpu_frequency", "request_id": "cpu-2"})),
            (0, protocol.encode_message(protocol.JSON, {"op": "stop", "request_id": "stop-1"}))])
        start, queued = self.methods()
        instance.frequency_reply_limit = threading.BoundedSemaphore(1)
        instance.queued_reply = types.MethodType(queued, instance)
        if start is not None:
            instance.start_frequency_reply = types.MethodType(start, instance)
        workers, stopped = [], []
        instance.spawn = lambda target, args: workers.append((target, args))

        def reply(request):
            if request["op"] == "stop":
                stopped.append(request["request_id"])
            return {"type": "ack", "op": request["op"], "request_id": request.get("request_id"), "ok": True}

        instance.reply = reply
        function(instance, connection, False)
        self.assertEqual(len(workers), 1, "CPU requests share one global slot, not one thread per request")
        self.assertEqual(stopped, ["stop-1"], "Stop dispatch must not await the held CPU worker")
        self.assertEqual(slot.releases, 1)
        replies = []
        decoder = protocol.Decoder()
        for packet in connection.sent:
            for kind, payload in decoder.feed(packet):
                replies.append(json.loads(payload.decode("utf-8")))
        busy = next(value for value in replies if value.get("request_id") == "cpu-2")
        self.assertEqual(busy["ok"], False)
        self.assertEqual(busy["op"], "cpu_frequency")
        uart_queue = queue.Queue()
        uart_busy = start(instance, {"op": "cpu_frequency", "request_id": "uart-1"}, uart_queue, 7)
        self.assertEqual(uart_busy["ok"], False)
        self.assertEqual(len(workers), 1)
        target, args = workers.pop()
        target(*args)
        self.assertIsNone(start(instance, {"op": "cpu_frequency", "request_id": "uart-2"}, uart_queue, 7))
        target, args = workers.pop()
        target(*args)
        epoch, answer = uart_queue.get_nowait()
        self.assertEqual(epoch, 7)
        self.assertEqual(answer["request_id"], "uart-2")

    def test_frequency_spawn_worker_and_full_reply_queue_release_gate(self):
        start, queued = self.methods()
        self.assertIsNotNone(start)
        limit = threading.BoundedSemaphore(1)
        instance = types.SimpleNamespace(frequency_reply_limit=limit, admission=ClearAdmissionFixture())
        instance.queued_reply = types.MethodType(queued, instance)

        def fail_spawn(*unused):
            raise RuntimeError("Synthetic spawn failure")

        instance.spawn = fail_spawn
        request = {"op": "cpu_frequency", "request_id": "qa-cpu"}
        with self.assertRaisesRegex(RuntimeError, "spawn failure"):
            start(instance, request, queue.Queue())
        self.assertTrue(limit.acquire(False))
        limit.release()

        workers = []
        instance.spawn = lambda target, args: workers.append((target, args))

        def fail_reply(unused):
            raise RuntimeError("Synthetic CPU worker failure")

        instance.reply = fail_reply
        start(instance, request, queue.Queue())
        target, args = workers.pop()
        with self.assertRaisesRegex(RuntimeError, "worker failure"):
            target(*args)
        self.assertTrue(limit.acquire(False))
        limit.release()
        instance.reply = lambda unused: {"ok": True}
        full = queue.Queue(1)
        full.put_nowait("existing")
        start(instance, request, full)
        target, args = workers.pop()
        target(*args)
        self.assertEqual(full.get_nowait(), "existing")
        self.assertTrue(limit.acquire(False))
        limit.release()

    def test_uart_wiring_uses_shared_gate_and_passes_connection_epoch(self):
        tree = ast.parse((SOURCE / "PS/vision_app/board_agent.py").read_text(encoding="utf-8"))
        owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "Agent")
        serial = next(node for node in owner.body if isinstance(node, ast.FunctionDef) and node.name == "serial_loop")
        calls = [node for node in ast.walk(serial) if isinstance(node, ast.Call) and
                 isinstance(node.func, ast.Attribute) and node.func.attr == "start_frequency_reply"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(calls[0].args), 3)
        self.assertIsInstance(calls[0].args[2], ast.Name)
        self.assertEqual(calls[0].args[2].id, "epoch")


def source_hashes():
    files = list((SOURCE / "PS/vision_app").glob("*.py"))
    files += list((SOURCE / "HOST/vision_app").glob("*.py"))
    return {str(file.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in sorted(files)}


def main():
    global SOURCE
    parser = argparse.ArgumentParser()
    parser.add_argument("--report")
    parser.add_argument("--baseline", action="store_true")
    parser.add_argument("--case")
    options, remaining = parser.parse_known_args()
    if options.baseline:
        SOURCE = ROOT / "output/hardware/2026-10-16/fz3b-semantic-video-search"
    report = Path(options.report).resolve() if options.report else None
    if report is not None and EVIDENCE.resolve() not in report.parents:
        raise ValueError("Report must remain in the independent security-review output directory")
    before = source_hashes()
    if options.case:
        suite = unittest.defaultTestLoader.loadTestsFromName(options.case, sys.modules[__name__])
    else:
        suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    after = source_hashes()
    success = result.wasSuccessful() and before == after and not BLOCKED
    if report is not None:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps({
            "schemaVersion": 1, "result": "passed" if success else "failed",
            "scope": "offline hardened-source security integration; not deployed acceptance",
            "sourceVariant": "upstream-baseline" if options.baseline else "hardened-project-copy",
            "testSourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "python": sys.version, "testsRun": result.testsRun,
            "dependencies": {name: getattr(sys.modules.get(name), "__version__", None)
                             for name in ("numpy", "PIL")},
            "failures": [{"test": str(case), "trace": trace} for case, trace in result.failures],
            "errors": [{"test": str(case), "trace": trace} for case, trace in result.errors],
            "sourceBefore": before, "sourceAfter": after, "sourceUnchanged": before == after,
            "auditBlockedEvents": BLOCKED,
            "boundaries": {"agentConstructed": False, "boardRuntimeImported": False,
                "realNetwork": False, "realHardware": False, "realModel": False,
                "authenticationAcceptance": False, "deployedAcceptance": False},
        }, indent=2) + "\n", encoding="utf-8")
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
