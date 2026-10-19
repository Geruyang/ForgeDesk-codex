"""Read-only candidate008 bit/native/PCAP format calibration, never new-bit approval."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct


PROJECT_ROOT = Path(__file__).resolve().parents[3]
FIXTURE_ROOT = PROJECT_ROOT / 'output/known-good-pl'
TARGET_PART = 'xazu3eg-sfvc784-1-i'
PART_FIELDS = frozenset((TARGET_PART,))
KNOWN_FILES = {
    'cnn_rtl.bit': (5568891, '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726'),
    'cnn_rtl.native.bin': (5568668, 'bf788681c0e990c337b07ee949bec735dd81224bcabc4d5948d03221e217d439'),
    'cnn_rtl.pcap.bin': (5568668, '76dff052e3648a4634585bbed186cfa202b434c66c996a3d2b3349fa3b908c02'),
}
BIT_MAGIC = bytes.fromhex('0ff00ff00ff00ff000')
NATIVE_SYNC = bytes.fromhex('aa995566')
PCAP_SYNC = bytes.fromhex('665599aa')
SYNC_OFFSET = 80
MAX_HEADER_BYTES = 4096
MAX_INPUT_BYTES = 8 * 1024 * 1024
RUN_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,95}\Z')


class ConversionError(ValueError):
    pass


def _require(condition, message):
    if not condition:
        raise ConversionError(message)


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _no_link(path):
    info = path.lstat()
    _require(not stat.S_ISLNK(info.st_mode) and
             not getattr(info, 'st_file_attributes', 0) & 0x400,
             'symlink or reparse point is forbidden')
    return info


def _checked_path(path):
    path = Path(os.path.abspath(str(path)))
    for parent in reversed((path,) + tuple(path.parents)):
        _no_link(parent)
    return path


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size,
            getattr(info, 'st_mtime_ns', info.st_mtime))


def _read_fixed(path, expected_bytes):
    path = _checked_path(path)
    before = _no_link(path)
    _require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
             'input must be a non-linked regular file')
    _require(before.st_size == expected_bytes and expected_bytes <= MAX_INPUT_BYTES,
             'known-good file length mismatch: ' + path.name)
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(str(path), flags)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        _require(_identity(opened) == _identity(before), 'input changed before read')
        data = stream.read(expected_bytes + 1)
        after = os.fstat(stream.fileno())
    final = _no_link(path)
    _require(_identity(opened) == _identity(after) == _identity(final),
             'input changed during read')
    _require(len(data) == expected_bytes, 'input extent changed')
    return data


def parse_bit(data):
    """Parse the bounded Xilinx .bit header; payload is never found by sync search."""
    _require(type(data) is bytes and len(data) <= MAX_INPUT_BYTES, 'invalid bit input type/size')
    cursor = 0

    def take(length):
        nonlocal cursor
        _require(0 <= length <= len(data) - cursor, 'truncated bit header or payload')
        result = data[cursor:cursor + length]
        cursor += length
        return result

    def number(width):
        return struct.unpack('>H' if width == 2 else '>I', take(width))[0]

    _require(number(2) == len(BIT_MAGIC), 'unsupported bit magic length')
    _require(take(len(BIT_MAGIC)) == BIT_MAGIC, 'unsupported bit type/magic')
    _require(number(2) == 1, 'invalid bit first-tag marker')
    fields = {}
    for tag, label, limit in ((b'a', 'design', 1024), (b'b', 'part', 128),
                              (b'c', 'date', 32), (b'd', 'time', 32)):
        _require(take(1) == tag, 'bit tags must be exactly a/b/c/d/e in order')
        length = number(2)
        _require(2 <= length <= limit, 'invalid bit field length: ' + label)
        raw = take(length)
        _require(raw.endswith(b'\0') and b'\0' not in raw[:-1] and
                 all(32 <= byte <= 126 for byte in raw[:-1]),
                 'invalid terminated ASCII bit field: ' + label)
        fields[label] = raw[:-1].decode('ascii')
        _require(cursor <= MAX_HEADER_BYTES, 'bit header exceeds bound')
    _require(fields['design'].split(';', 1)[0] == 'cnn_rtl_platform_wrapper',
             'unexpected bit design type')
    _require(fields['part'] in PART_FIELDS, 'unexpected bit device/part field')
    _require(re.fullmatch(r'\d{4}/\d{2}/\d{2}', fields['date']) is not None and
             re.fullmatch(r'\d{2}:\d{2}:\d{2}', fields['time']) is not None,
             'invalid bit date/time encoding')
    try:
        datetime.datetime.strptime(fields['date'] + ' ' + fields['time'], '%Y/%m/%d %H:%M:%S')
    except ValueError:
        raise ConversionError('invalid bit date/time value')
    _require(take(1) == b'e', 'bit tags must end with payload tag e')
    payload_bytes = number(4)
    header_bytes = cursor
    _require(header_bytes <= MAX_HEADER_BYTES and payload_bytes >= SYNC_OFFSET + 4 and
             payload_bytes % 4 == 0, 'invalid bit payload length/alignment')
    _require(payload_bytes == len(data) - header_bytes, 'bit payload extent/trailing bytes mismatch')
    payload = take(payload_bytes)
    _require(payload[SYNC_OFFSET:SYNC_OFFSET + 4] == NATIVE_SYNC,
             'bit payload is not the known native word order/sync')
    return dict(fields=fields, header_bytes=header_bytes,
                payload_bytes=payload_bytes, payload=payload)


def validate_triplet(files):
    """Only the three pinned candidate008 byte strings can calibrate the fixture."""
    _require(type(files) is dict and set(files) == set(KNOWN_FILES), 'exact three fixture files required')
    identities = {}
    for name, (size, expected) in KNOWN_FILES.items():
        data = files[name]
        _require(type(data) is bytes and len(data) == size, 'known-good length mismatch: ' + name)
        digest = _sha(data)
        _require(digest == expected, 'known-good SHA-256 mismatch: ' + name)
        identities[name] = dict(bytes=size, sha256=digest)
    parsed = parse_bit(files['cnn_rtl.bit'])
    native, pcap = files['cnn_rtl.native.bin'], files['cnn_rtl.pcap.bin']
    _require(parsed['payload'] == native, 'native file is not the exact bit TLV payload')
    _require(len(native) == len(pcap) and len(native) % 4 == 0, 'native/PCAP extent mismatch')
    _require(native[SYNC_OFFSET:SYNC_OFFSET + 4] == NATIVE_SYNC and
             pcap[SYNC_OFFSET:SYNC_OFFSET + 4] == PCAP_SYNC,
             'native/PCAP sync or word order mismatch')
    for offset in range(0, len(native), 4):
        _require(pcap[offset:offset + 4] == native[offset:offset + 4][::-1],
                 'native/PCAP full word-swap mismatch')
    return dict(schema='fz3b-candidate008-conversion-fixture-v1', result='PASS',
                scope='known-good candidate008 format calibration only',
                fixture_identity_verified=True, bit_fields=parsed['fields'],
                bit_header_bytes=parsed['header_bytes'], payload_bytes=parsed['payload_bytes'],
                native_equals_bit_payload=True, complete_word_swap_verified=True,
                sync_offset=SYNC_OFFSET, native_sync_hex=NATIVE_SYNC.hex(), pcap_sync_hex=PCAP_SYNC.hex(),
                expected_project_part=TARGET_PART, files=identities,
                receipt_used_as_trust_anchor=False, bootgen_executed=False,
                new_bit_accepted=False, hardware_validated=False)


def verify_run(run_id):
    _require(type(run_id) is str and RUN_ID.fullmatch(run_id) is not None,
             'invalid fixed-root fixture run id')
    root = _checked_path(FIXTURE_ROOT)
    _require(stat.S_ISDIR(_no_link(root).st_mode), 'fixture root is not a directory')
    folder = _checked_path(root / run_id)
    _require(folder.parent == root and stat.S_ISDIR(_no_link(folder).st_mode),
             'fixture must be an immediate child of the fixed project root')
    before = _no_link(folder)
    names = set()
    for path in folder.iterdir():
        _require(len(names) < 4, 'unexpected fixture directory member')
        info = _no_link(path)
        _require(path.name in set(KNOWN_FILES) | {'receipt.json'} and stat.S_ISREG(info.st_mode),
                 'unexpected fixture directory member')
        if path.name == 'receipt.json':
            _require(info.st_nlink == 1 and info.st_size <= 256 * 1024,
                     'invalid optional receipt metadata')
        names.add(path.name)
    _require(set(KNOWN_FILES) <= names, 'missing known-good fixture file')
    files = {name: _read_fixed(folder / name, value[0]) for name, value in KNOWN_FILES.items()}
    _require((before.st_dev, before.st_ino) ==
             (_no_link(folder).st_dev, _no_link(folder).st_ino), 'fixture directory changed')
    result = validate_triplet(files)
    result.update(fixture_run_id=run_id, fixture_directory=str(folder))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True, help='Single directory name below output/known-good-pl')
    args = parser.parse_args(argv)
    try:
        result = verify_run(args.run_id)
    except (ConversionError, OSError) as error:
        print(json.dumps(dict(result='REFUSED', error=str(error), new_bit_accepted=False,
                              hardware_validated=False), sort_keys=True))
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
