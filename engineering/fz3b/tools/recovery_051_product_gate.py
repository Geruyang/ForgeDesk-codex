"""Fixed completed-operation product lease gate; definitions only, no execution.

Linux callers hold ProductLease before acquiring their own PS transaction lease.
This module never creates, writes, truncates or removes a product journal file.
"""
import errno
import hashlib
import json
import math
import os
import re
import stat
import sys

PROJECT = '/root/fz3b-vision-console-20261009-001'
PRODUCT_DIRECTORY = '.forgedesk-product-operations'
PS_LEASE = '.forgedesk-ps-transaction.lock'
FIXED_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
FIXED_OPERATION = 'af51470d-b545-4fde-ae78-69bf13a61fd7'
FIXED_NONCE = 'e9edb873d385f106dc5046586f5bf169541a3cc8b6ceb92df50d799e3c109ae3'
FIXED_GRANT = 'fc1aeea5-2b40-418e-965f-ace322c54e63'
FIXED_PROFILE = '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd'
FIXED_JOB = 'fd-semantic-af51470db5454fdeae7869bf13a61fd7'
FIXED_SEMANTIC_SHA = 'f3af58fdf68f4d681b68ad84068888b16e37a4ea971260a10893009f7e450de0'
SOURCE_RECEIPT_SHA = '718ac62b2652427597c93cc28cd8d6b007d6b89fbc9d5757896b1a2d9382f418'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')


class ProductGateError(Exception):
    pass


def gate_require(condition, code):
    if not condition:
        raise ProductGateError(code)


def gate_sha(raw):
    return hashlib.sha256(raw).hexdigest()


def gate_canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def journal_object(raw):
    gate_require(type(raw) is bytes and 0 < len(raw) <= 32768, 'product-journal-byte-budget')
    def pairs(items):
        value = {}
        for key, child in items:
            gate_require(key not in value, 'product-journal-duplicate-key')
            value[key] = child
        return value
    def invalid(_):
        raise ProductGateError('product-journal-nonfinite')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid)
    gate_require(type(value) is dict, 'product-journal-object-required')
    pending, count = [(value, 1)], 0
    while pending:
        item, depth = pending.pop()
        count += 1
        gate_require(depth <= 16 and count <= 4096, 'product-journal-structure-budget')
        if type(item) is float:
            gate_require(math.isfinite(item), 'product-journal-nonfinite')
        if type(item) is dict:
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            pending.extend((child, depth + 1) for child in item)
    return value


def gate_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime, info.st_ctime)


def gate_directory(parent, name, exact_mode=None):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    descriptor = os.open(name, flags, dir_fd=parent)
    try:
        info = os.fstat(descriptor)
        gate_require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                     'product-directory-untrusted')
        if exact_mode is not None:
            gate_require(stat.S_IMODE(info.st_mode) == exact_mode, 'product-directory-mode')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def gate_app_directory():
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory = os.open('/', flags)
    try:
        for part in PROJECT.strip('/').split('/'):
            opened = gate_directory(directory, part)
            os.close(directory)
            directory = opened
        return directory
    except BaseException:
        os.close(directory)
        raise


def gate_regular(info, empty=False):
    gate_require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                 and stat.S_IMODE(info.st_mode) == 0o600 and 0 <= info.st_size <= 32768,
                 'product-file-untrusted')
    if empty:
        gate_require(info.st_size == 0, 'product-lock-not-empty')


def gate_read_leaf(directory, name):
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(descriptor)
        gate_regular(before)
        raw = bytearray()
        while len(raw) <= 32768:
            part = os.read(descriptor, min(8192, 32769 - len(raw)))
            if not part:
                break
            raw.extend(part)
        gate_require(len(raw) == before.st_size and len(raw) <= 32768
                     and gate_identity(before) == gate_identity(os.fstat(descriptor)), 'product-journal-changed')
        return bytes(raw)
    finally:
        os.close(descriptor)


def assert_ps_transaction_absent(app_fd):
    try:
        os.stat(PS_LEASE, dir_fd=app_fd, follow_symlinks=False)
    except FileNotFoundError:
        return True
    raise ProductGateError('ps-transaction-lease-present-or-unknown')


class ProductLease(object):
    def __init__(self):
        self.app_fd = None
        self.directory_fd = None
        self.lock_fd = None
        self.snapshot = None

    def __enter__(self):
        import fcntl
        gate_require(sys.platform.startswith('linux') and os.geteuid() == 0, 'product-gate-linux-root-required')
        try:
            self.app_fd = gate_app_directory()
            self.directory_fd = gate_directory(self.app_fd, PRODUCT_DIRECTORY, 0o700)
            self.lock_fd = os.open('active.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.directory_fd)
            gate_regular(os.fstat(self.lock_fd), empty=True)
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EAGAIN, errno.EACCES):
                    raise ProductGateError('product-lease-live-or-unknown')
                raise
            self.lock_identity = gate_identity(os.fstat(self.lock_fd))
            self.recheck()
            return self
        except BaseException:
            self.close()
            raise

    def recheck(self):
        gate_require(self.lock_fd is not None, 'product-lease-not-held')
        opened = gate_app_directory()
        try:
            gate_require(gate_identity(os.fstat(opened))[:2] == gate_identity(os.fstat(self.app_fd))[:2], 'product-app-path-replaced')
        finally:
            os.close(opened)
        directory = os.stat(PRODUCT_DIRECTORY, dir_fd=self.app_fd, follow_symlinks=False)
        gate_require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == 0 and stat.S_IMODE(directory.st_mode) == 0o700
                     and gate_identity(directory)[:2] == gate_identity(os.fstat(self.directory_fd))[:2], 'product-journal-path-replaced')
        lock = os.stat('active.lock', dir_fd=self.directory_fd, follow_symlinks=False)
        gate_regular(lock, empty=True)
        gate_require(gate_identity(lock) == self.lock_identity == gate_identity(os.fstat(self.lock_fd)), 'product-lock-path-replaced')
        names = sorted(os.listdir(self.directory_fd))
        gate_require('active.lock' in names and len(names) <= 65, 'product-journal-inventory')
        hashes, total = {}, 0
        for name in names:
            if name == 'active.lock':
                continue
            gate_require(name.endswith('.json') and UUID.fullmatch(name[:-5]) is not None, 'product-journal-unexpected-entry')
            raw = gate_read_leaf(self.directory_fd, name)
            total += len(raw)
            gate_require(total <= 1048576, 'product-journal-total-budget')
            value = journal_object(raw)
            gate_require(type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1
                         and value.get('operationId') == name[:-5] and value.get('profileSha256') == FIXED_PROFILE
                         and type(value.get('nonce')) is str and HEX64.fullmatch(value['nonce']) is not None
                         and type(value.get('grantId')) is str and UUID.fullmatch(value['grantId']) is not None
                         and value.get('status') in ('succeeded', 'failed') and value.get('remoteQuiescent') is True,
                         'product-journal-unresolved-or-foreign')
            if name == FIXED_OPERATION + '.json':
                semantic = value.get('semantic')
                gate_require(set(value) == {'schemaVersion', 'operationId', 'nonce', 'profileSha256', 'grantId', 'status', 'remoteQuiescent', 'semantic', 'idle'}
                             and value['status'] == 'succeeded' and value['nonce'] == FIXED_NONCE and value['grantId'] == FIXED_GRANT
                             and type(semantic) is dict and gate_sha(gate_canonical(semantic)) == FIXED_SEMANTIC_SHA
                             and semantic.get('jobId') == FIXED_JOB and type(semantic.get('queryRevision')) is int and semantic['queryRevision'] == 3
                             and type(semantic.get('completedFrames')) is int and semantic['completedFrames'] == 1
                             and semantic.get('inferenceStopped') is True and semantic.get('newPlLoaded') is False
                             and type(value['idle']) is dict and set(value['idle']) == {'controlConnections', 'deviceOwners'}
                             and type(value['idle']['controlConnections']) is int and value['idle']['controlConnections'] == 0
                             and type(value['idle']['deviceOwners']) is list and value['idle']['deviceOwners'] == [], 'product-current-completion-not-exact')
            hashes[name] = gate_sha(raw)
        gate_require(FIXED_OPERATION + '.json' in hashes and sorted(os.listdir(self.directory_fd)) == names, 'product-current-completion-absent-or-changing')
        result = {'journalCount': len(hashes), 'journalHashes': hashes, 'profileSha256': FIXED_PROFILE,
                  'fixedOperationId': FIXED_OPERATION, 'productLeaseHeldReadOnly': True, 'unknownCleared': False}
        if self.snapshot is None:
            self.snapshot = result
        else:
            gate_require(result == self.snapshot, 'product-journal-changed-while-held')
        return result

    def close(self):
        for name in ('lock_fd', 'directory_fd', 'app_fd'):
            descriptor = getattr(self, name)
            if descriptor is not None:
                setattr(self, name, None)
                os.close(descriptor)

    def __exit__(self, _kind, _value, _trace):
        self.close()
