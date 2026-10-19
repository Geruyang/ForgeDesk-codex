"""Offline protocol fixtures; no board service, socket, or runtime construction."""
import ast
import importlib.util
from pathlib import Path
import struct
import unittest


ROOT = Path(__file__).resolve().parents[1] / 'source'


def load_protocol(side):
    path = ROOT / side / 'vision_app' / 'protocol.py'
    spec = importlib.util.spec_from_file_location('fz3b_' + side.lower() + '_protocol', str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProtocolSecurity(unittest.TestCase):
    def test_hello_reply_requires_exact_integer_protocol(self):
        source = (ROOT / 'HOST' / 'vision_app' / 'transports.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                        and node.name == 'is_handshake_reply')
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), '<transport-hello>', 'exec'),
             namespace)
        accept = namespace['is_handshake_reply']
        self.assertTrue(accept({'type': 'hello', 'ok': True, 'protocol': 1}))
        for protocol in (True, 1.0, '1', None):
            self.assertFalse(accept({'type': 'hello', 'ok': True, 'protocol': protocol}))

    def test_partial_header_and_body_have_absolute_deadlines(self):
        for side in ('PS', 'HOST'):
            with self.subTest(side=side):
                p = load_protocol(side)
                frame = p.encode_message(p.JSON, {'op': 'hello'})
                header = p.Decoder(header_timeout_s=5)
                self.assertEqual(header.feed(frame[:2], now=10), [])
                self.assertEqual(header.feed(frame[2:6], now=14), [])
                with self.assertRaises(TimeoutError):
                    header.check_timeout(now=15)
                body = p.Decoder(body_timeout_s=30)
                self.assertEqual(body.feed(frame[:p.HEADER.size + 1], now=10), [])
                self.assertEqual(body.feed(frame[p.HEADER.size + 1:-1], now=39), [])
                with self.assertRaises(TimeoutError):
                    body.feed(frame[-1:], now=40)

    def test_idle_connection_and_normal_frames_stay_compatible(self):
        for side in ('PS', 'HOST'):
            with self.subTest(side=side):
                p = load_protocol(side)
                decoder = p.Decoder()
                first = p.encode_message(p.JSON, {'op': 'hello'})
                second = p.encode_message(p.JSON, {'op': 'status', 'request_id': 's1'})
                self.assertEqual(decoder.feed(first + second, now=0),
                                 [(p.JSON, b'{"op":"hello"}'),
                                  (p.JSON, b'{"op":"status","request_id":"s1"}')])
                decoder.check_timeout(now=100000)
                self.assertEqual(len(decoder.buffer), 0)

    def test_embedded_magic_cannot_interrupt_partial_image(self):
        for side in ('PS', 'HOST'):
            with self.subTest(side=side):
                p = load_protocol(side)
                embedded = p.encode_message(p.JSON, {'op': 'hello'})
                outer = p.encode_message(p.INPUT_FRAME, b'jpeg-prefix' + embedded + b'jpeg-tail')
                split = p.HEADER.size + len(b'jpeg-prefix') + len(embedded)
                decoder = p.Decoder(reset_validator=lambda request: True)
                self.assertEqual(decoder.feed(outer[:split], now=0), [])
                self.assertEqual(decoder.feed(outer[split:], now=1),
                                 [(p.INPUT_FRAME, b'jpeg-prefix' + embedded + b'jpeg-tail')])

    def test_budgets_fail_closed(self):
        for side in ('PS', 'HOST'):
            with self.subTest(side=side):
                p = load_protocol(side)
                with self.assertRaisesRegex(ValueError, 'resynchronization budget'):
                    p.Decoder().feed(b'x' * (p.MAX_RESYNC_BYTES + 1), now=0)
                with self.assertRaisesRegex(ValueError, 'feed exceeds limit'):
                    p.Decoder().feed(b'x' * (p.MAX_FEED_BYTES + 1), now=0)
                oversize_header = p.HEADER.pack(p.MAGIC, 1, p.JSON, 0,
                                                p.MAX_JSON_PAYLOAD + 1, 0)
                with self.assertRaisesRegex(ValueError, 'JSON frame exceeds limit'):
                    p.Decoder().feed(oversize_header, now=0)
                with self.assertRaisesRegex(ValueError, 'frame budget'):
                    p.Decoder().feed(p.encode_message(p.JSON, {'op': 'status'}) *
                                     (p.MAX_FRAMES_PER_FEED + 1), now=0)

    def test_json_rejects_duplicate_nonfinite_depth_and_extent(self):
        bad = [b'{"op":"status","op":"start"}', b'{"x":NaN}',
               b'{"x":Infinity}', b'{"x":1e999}',
               b'{"x":' + b'[' * 33 + b'0' + b']' * 33 + b'}']
        for side in ('PS', 'HOST'):
            with self.subTest(side=side):
                p = load_protocol(side)
                for payload in bad:
                    with self.subTest(payload=payload[:40]), self.assertRaises(ValueError):
                        p.parse_json_object(payload)
                with self.assertRaises(ValueError):
                    p.parse_json_object(b'{"x":0}' + b' ' * p.MAX_JSON_PAYLOAD)
                self.assertEqual(p.parse_json_object(b'{"op":"status"}'), {'op': 'status'})

    def test_image_metadata_uses_strict_json(self):
        for side in ('PS', 'HOST'):
            with self.subTest(side=side):
                p = load_protocol(side)
                meta = b'{"frame_id":0,"frame_id":1}'
                with self.assertRaisesRegex(ValueError, 'duplicate JSON key'):
                    p.unpack_image(struct.pack('<I', len(meta)) + meta + b'jpeg')
                good = p.pack_image({'frame_id': 0, 'width': 256}, b'jpeg')
                self.assertEqual(p.unpack_image(good),
                                 ({'frame_id': 0, 'width': 256}, b'jpeg'))


if __name__ == '__main__':
    unittest.main()
