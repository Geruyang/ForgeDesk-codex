"""Read only three previously verified FZ3B PL artifacts for fixed SSH stdin export.

No arguments, application imports, device opens, service actions, or remote writes.
All three files are verified before any payload is emitted.
"""
from __future__ import print_function

import base64
import hashlib
import json
import os
import stat
import sys
import time


ARTIFACTS = (
    ('cnn_rtl.bit', '/root/rtl_optim-board-20261010/candidate008/cnn_rtl.bit',
     5568891, '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726'),
    ('cnn_rtl.native.bin', '/root/rtl_optim-board-20261010/candidate008/cnn_rtl.native.bin',
     5568668, 'bf788681c0e990c337b07ee949bec735dd81224bcabc4d5948d03221e217d439'),
    ('cnn_rtl.pcap.bin', '/lib/firmware/rtl-optim-20261010-candidate008/cnn_rtl.pcap.bin',
     5568668, '76dff052e3648a4634585bbed186cfa202b434c66c996a3d2b3349fa3b908c02'),
)
DEADLINE_S = 45
MAX_OUTPUT = 24 * 1024 * 1024


class ExportError(Exception):
    pass


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size,
            getattr(info, 'st_mtime_ns', info.st_mtime),
            getattr(info, 'st_ctime_ns', info.st_ctime))


def read_exact(path, expected_size, deadline):
    if not all(hasattr(os, flag) for flag in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK')):
        raise ExportError('safe-open-unavailable')
    if not path.startswith('/') or '\\' in path or '\x00' in path:
        raise ExportError('unsafe-fixed-path')
    parts = path[1:].split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ExportError('unsafe-fixed-path')
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    parent = os.open('/', directory_flags)
    try:
        for part in parts[:-1]:
            child = os.open(part, directory_flags, dir_fd=parent)
            os.close(parent)
            parent = child
        prior = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if (not stat.S_ISREG(prior.st_mode) or prior.st_nlink != 1 or
                prior.st_size != expected_size):
            raise ExportError('fixed-file-type-or-size-mismatch')
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=parent)
    finally:
        os.close(parent)
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or
                before.st_size != expected_size or _identity(prior) != _identity(before)):
            raise ExportError('fixed-file-type-or-size-mismatch')
        data = bytearray()
        while len(data) < expected_size:
            if time.monotonic() >= deadline:
                raise ExportError('read-deadline-exceeded')
            chunk = os.read(fd, min(65536, expected_size - len(data)))
            if not chunk:
                raise ExportError('short-read')
            data.extend(chunk)
        if time.monotonic() >= deadline:
            raise ExportError('read-deadline-exceeded')
        if os.read(fd, 1):
            raise ExportError('file-grew')
        if _identity(before) != _identity(os.fstat(fd)):
            raise ExportError('file-changed')
        return bytes(data)
    finally:
        os.close(fd)


def prepare(reader=read_exact, now=time.monotonic):
    deadline = now() + DEADLINE_S
    entries = []
    for name, path, expected_size, expected_sha in ARTIFACTS:
        data = reader(path, expected_size, deadline)
        if type(data) is not bytes or len(data) != expected_size:
            raise ExportError('fixed-file-size-mismatch')
        if hashlib.sha256(data).hexdigest() != expected_sha:
            raise ExportError('fixed-file-hash-mismatch')
        entries.append({'name': name, 'bytes': expected_size, 'sha256': expected_sha,
                        'base64': base64.b64encode(data).decode('ascii')})
    payload = json.dumps({'schemaVersion': 1, 'scope': 'fz3b-known-good-pl-readonly',
                          'readOnly': True, 'deployed': False, 'entries': entries},
                         sort_keys=True, separators=(',', ':')).encode('ascii') + b'\n'
    if len(payload) > MAX_OUTPUT or now() >= deadline:
        raise ExportError('output-size-or-deadline')
    return payload


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        raise SystemExit('no arguments accepted')
    try:
        payload = prepare()
    except Exception as error:
        reason = str(error) if isinstance(error, ExportError) else type(error).__name__
        print(json.dumps({'ok': False, 'error': reason}, separators=(',', ':')))
        return 1
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
