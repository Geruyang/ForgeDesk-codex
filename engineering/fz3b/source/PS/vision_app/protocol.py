"""Bounded FZVA wire protocol shared with the Python 3.6 board."""
import json
import math
import struct
import time
import zlib

MAGIC = b'FZVA'
HEADER = struct.Struct('<4sBBHII')
MAX_PAYLOAD = 4 * 1024 * 1024
MAX_JSON_PAYLOAD = 1024 * 1024
MAX_BUFFER = HEADER.size + MAX_PAYLOAD
MAX_FEED_BYTES = MAX_BUFFER
MAX_FRAMES_PER_FEED = 64
MAX_RESYNC_BYTES = 4096
MAX_JSON_DEPTH = 32
MAX_JSON_NODES = 300000
JSON, PREVIEW, RESULT_IMAGE, IMAGE_CHUNK = 1, 2, 3, 4
INPUT_FRAME = 5
CHUNK_HEADER = struct.Struct('<QII')


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _unique_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate JSON key')
        value[key] = item
    return value


def _finite_float(value):
    if len(value) > 64:
        raise ValueError('JSON number exceeds limit')
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('nonfinite JSON number')
    return result


def _bounded_int(value):
    if len(value) > 64:
        raise ValueError('JSON number exceeds limit')
    return int(value)


def _invalid_constant(value):
    raise ValueError('nonfinite JSON constant: ' + value)


def parse_json_object(payload, max_bytes=MAX_JSON_PAYLOAD):
    if not isinstance(payload, (bytes, bytearray)) or len(payload) > max_bytes:
        raise ValueError('JSON payload exceeds limit')
    try:
        value = json.loads(bytes(payload).decode('utf-8'), object_pairs_hook=_unique_pairs,
                           parse_constant=_invalid_constant, parse_float=_finite_float,
                           parse_int=_bounded_int)
    except (UnicodeError, RecursionError) as exc:
        raise ValueError('invalid JSON encoding or depth') from exc
    if not isinstance(value, dict):
        raise ValueError('JSON object required')
    pending = [(value, 1)]
    nodes = 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES or depth > MAX_JSON_DEPTH:
            raise ValueError('JSON structure exceeds limit')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    return value


def encode_message(kind, payload, crc=None):
    if kind not in (JSON, PREVIEW, RESULT_IMAGE, IMAGE_CHUNK, INPUT_FRAME):
        raise ValueError('unknown message kind')
    payload = json_bytes(payload) if isinstance(payload, dict) else bytes(payload)
    if len(payload) > MAX_PAYLOAD or (kind == JSON and len(payload) > MAX_JSON_PAYLOAD):
        raise ValueError('payload too large')
    checksum = zlib.crc32(payload) if crc is None else crc(payload)
    return HEADER.pack(MAGIC, 1, kind, 0, len(payload), checksum & 0xffffffff) + payload


class Decoder:
    def __init__(self, reset_validator=None, header_timeout_s=5, body_timeout_s=30):
        self.buffer = bytearray()
        self.errors = 0
        self.header_timeout_s = header_timeout_s
        self.body_timeout_s = body_timeout_s
        self._phase = None
        self._started = None
        self._resync_bytes = 0
        # Preserve the old constructor signature. An unfinished body is never
        # scanned for an embedded HELLO or a new frame boundary.
        self.reset_validator = reset_validator

    def reset(self):
        self.buffer.clear()
        self._phase = None
        self._started = None
        self._resync_bytes = 0

    def check_timeout(self, now=None):
        now = time.monotonic() if now is None else now
        if self._phase is None:
            return
        limit = self.header_timeout_s if self._phase == 'header' else self.body_timeout_s
        if now - self._started >= limit:
            raise TimeoutError('partial FZVA %s timed out' % self._phase)

    def _phase_at(self, phase, now):
        if self._phase != phase:
            self._phase, self._started = phase, now

    def _discard(self, size):
        if size:
            del self.buffer[:size]
            self._resync_bytes += size
            if self._resync_bytes > MAX_RESYNC_BYTES:
                raise ValueError('FZVA resynchronization budget exceeded')

    def _consume(self, now, output):
        while self.buffer:
            position = self.buffer.find(MAGIC)
            if position < 0:
                keep = 0
                for size in (3, 2, 1):
                    if self.buffer.endswith(MAGIC[:size]):
                        keep = size
                        break
                self._discard(len(self.buffer) - keep)
                if keep:
                    self._phase_at('header', now)
                else:
                    self._phase, self._started = None, None
                return
            if position:
                self._discard(position)
                self._phase, self._started = None, None
            if len(self.buffer) < HEADER.size:
                self._phase_at('header', now)
                return
            magic, version, kind, flags, size, checksum = HEADER.unpack_from(self.buffer)
            if (magic != MAGIC or version != 1 or flags != 0 or
                    kind not in (JSON, PREVIEW, RESULT_IMAGE, IMAGE_CHUNK, INPUT_FRAME) or
                    size > MAX_PAYLOAD):
                self.errors += 1
                self._discard(4)
                self._phase, self._started = None, None
                continue
            if kind == JSON and size > MAX_JSON_PAYLOAD:
                raise ValueError('JSON frame exceeds limit')
            if len(self.buffer) < HEADER.size + size:
                self._phase_at('body', now)
                return
            payload = bytes(self.buffer[HEADER.size:HEADER.size + size])
            del self.buffer[:HEADER.size + size]
            self._phase, self._started = None, None
            if zlib.crc32(payload) & 0xffffffff != checksum:
                self.errors += 1
                self._resync_bytes += HEADER.size + size
                if self._resync_bytes > MAX_RESYNC_BYTES:
                    raise ValueError('FZVA resynchronization budget exceeded')
                continue
            self._resync_bytes = 0
            output.append((kind, payload))
            if len(output) > MAX_FRAMES_PER_FEED:
                raise ValueError('FZVA frame budget exceeded')
        self._phase, self._started = None, None

    def feed(self, data, now=None):
        now = time.monotonic() if now is None else now
        self.check_timeout(now)
        if len(data) > MAX_FEED_BYTES:
            raise ValueError('FZVA feed exceeds limit')
        output = []
        offset = 0
        while offset < len(data):
            capacity = MAX_BUFFER - len(self.buffer)
            if capacity <= 0:
                raise ValueError('FZVA buffer exceeds limit')
            count = min(65536, capacity, len(data) - offset)
            self.buffer.extend(data[offset:offset + count])
            offset += count
            self._consume(now, output)
        return output


def pack_image(metadata, jpeg):
    meta = json_bytes(metadata)
    if len(meta) > 65536 or len(jpeg) + len(meta) + 4 > MAX_PAYLOAD:
        raise ValueError('image metadata/payload exceeds limit')
    return struct.pack('<I', len(meta)) + meta + bytes(jpeg)


def unpack_image(payload):
    if len(payload) < 4:
        raise ValueError('short image')
    n = struct.unpack_from('<I', payload)[0]
    if n > 65536 or n + 4 >= len(payload):
        raise ValueError('invalid image metadata length')
    meta = parse_json_object(payload[4:4 + n], max_bytes=65536)
    if type(meta.get('frame_id')) is not int or meta['frame_id'] < 0:
        raise ValueError('image frame ID missing')
    return meta, payload[4 + n:]


def fragment_image(payload, frame_id, size=1024):
    if not 64 <= size <= 8192 or len(payload) > MAX_PAYLOAD:
        raise ValueError('invalid fragment size')
    for offset in range(0, len(payload), size):
        yield CHUNK_HEADER.pack(frame_id, len(payload), offset) + payload[offset:offset + size]


class ImageAssembler:
    def __init__(self):
        self.frame_id = None
        self.buffer = bytearray()
        self.total = 0
        self.updated = 0

    def feed(self, part):
        if len(part) < CHUNK_HEADER.size:
            raise ValueError('short fragment')
        frame, total, offset = CHUNK_HEADER.unpack_from(part)
        data = part[CHUNK_HEADER.size:]
        if not 0 < total <= MAX_PAYLOAD or not data or offset + len(data) > total:
            raise ValueError('invalid fragment extent')
        if offset == 0:
            self.frame_id, self.total, self.buffer = frame, total, bytearray()
        if frame != self.frame_id or total != self.total or offset != len(self.buffer) or (offset and time.monotonic() - self.updated > 10):
            self.buffer.clear()
            self.frame_id = None
            raise ValueError('fragment order/identity/timeout mismatch')
        self.buffer.extend(data)
        self.updated = time.monotonic()
        if len(self.buffer) == total:
            result = bytes(self.buffer)
            self.buffer.clear()
            self.frame_id = None
            return result
        return None
