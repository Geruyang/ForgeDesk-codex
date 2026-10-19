"""Fixed-target, offline-generated PS security deployment transaction (Python 3.6).

Importing this module does not access the board, filesystem, or service manager.
Only --emit is a host command. The emitted stdin program invokes execute_request.
"""
from __future__ import print_function

import sys
sys.dont_write_bytecode = True

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import uuid


APP = '/root/fz3b-vision-console-20261009-001'
UNIT = 'fz3b-vision-console.service'
BACKUP_DIR = '.forgedesk-ps-backups'
LOCK_NAME = '.forgedesk-ps-transaction.lock'
APPROVED_MANIFEST_SHA256 = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09'
APPROVED_SOURCE_SHA256 = {
    'vision_app/board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
    'vision_app/camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
    'vision_app/image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
    'vision_app/protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
    'vision_app/upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
}
PY_TARGETS = (
    'vision_app/board_agent.py', 'vision_app/camera.py',
    'vision_app/image_boundary.py', 'vision_app/protocol.py',
    'vision_app/upload_source.py',
)
TARGETS = PY_TARGETS + ('config.json',)
NEW_TARGET = 'vision_app/image_boundary.py'
MAX_SOURCE = 256 * 1024
MAX_CONFIG = 64 * 1024
MAX_REQUEST = 2 * 1024 * 1024
MAX_MANIFEST = 32 * 1024
RUN_RE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
SHA_RE = re.compile(r'[0-9a-f]{64}\Z')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def _exact_keys(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ValueError('unexpected object keys')


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _constant(value):
    raise ValueError('non-finite JSON constant')


def _json_depth(value, depth=0):
    if depth > 24:
        raise ValueError('JSON nesting exceeds limit')
    if isinstance(value, dict):
        for child in value.values():
            _json_depth(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            _json_depth(child, depth + 1)
    elif type(value) is float:
        import math
        if not math.isfinite(value):
            raise ValueError('non-finite JSON number')


def load_json(raw, limit):
    if type(raw) is not bytes or len(raw) > limit:
        raise ValueError('JSON byte limit')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                       parse_constant=_constant)
    _json_depth(value)
    return value


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'),
                       ensure_ascii=True, allow_nan=False) + '\n').encode('ascii')


def validate_request(request):
    if type(request) is not dict or request.get('schema') != 1 or type(request.get('schema')) is not int:
        raise ValueError('unsupported request schema')
    mode = request.get('mode')
    if mode == 'deploy':
        _exact_keys(request, ('schema', 'mode', 'run_id', 'expected_sha256', 'payloads'))
        _exact_keys(request['expected_sha256'], TARGETS)
        _exact_keys(request['payloads'], PY_TARGETS)
        for path in TARGETS:
            value = request['expected_sha256'][path]
            if path == NEW_TARGET:
                if value is not None:
                    raise ValueError('new image_boundary must be absent')
            elif type(value) is not str or SHA_RE.fullmatch(value) is None:
                raise ValueError('invalid old SHA256')
    elif mode == 'rollback':
        _exact_keys(request, ('schema', 'mode', 'run_id', 'manifest_sha256'))
        if type(request['manifest_sha256']) is not str or SHA_RE.fullmatch(request['manifest_sha256']) is None:
            raise ValueError('invalid manifest SHA256')
    else:
        raise ValueError('unsupported mode')
    if type(request['run_id']) is not str or RUN_RE.fullmatch(request['run_id']) is None:
        raise ValueError('invalid run ID')
    return request


def read_service_state():
    # No lifecycle command is accepted or constructed from request data.
    result = subprocess.run(
        ['/bin/systemctl', 'show', UNIT, '--no-pager',
         '--property=Id,LoadState,ActiveState,MainPID'],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=10, check=False)
    if result.returncode != 0 or len(result.stdout) > 2048 or len(result.stderr) > 2048:
        raise RuntimeError('service state query failed')
    fields = {}
    for line in result.stdout.decode('ascii').splitlines():
        key, value = line.split('=', 1)
        if key in fields:
            raise RuntimeError('duplicate service property')
        fields[key] = value
    _exact_keys(fields, ('Id', 'LoadState', 'ActiveState', 'MainPID'))
    if fields['Id'] != UNIT or fields['LoadState'] != 'loaded':
        raise RuntimeError('unexpected service identity')
    return fields


def require_inactive(reader):
    state = reader()
    if (type(state) is not dict or state.get('ActiveState') != 'inactive'
            or state.get('MainPID') != '0'):
        raise RuntimeError('service must be inactive with MainPID=0')


class SecureFS(object):
    """Linux fd-relative filesystem with no caller-selectable path root."""

    def __init__(self):
        if sys.platform != 'linux' or os.geteuid() != 0:
            raise RuntimeError('root Linux process required')
        if not all(hasattr(os, name) for name in ('O_NOFOLLOW', 'O_DIRECTORY')):
            raise RuntimeError('nofollow directory support required')
        self.fds = []
        self.chain = []
        self.runfd = None
        self.lockfd = None
        self.lock_uncertain = False
        self.lock_retained = False
        try:
            parent = self._directory('/')
            for name in APP.strip('/').split('/'):
                child = self._directory(name, parent)
                self.chain.append((parent, name, os.fstat(child)))
                parent = child
            self.appfd = parent
            self.visionfd = self._directory('vision_app', self.appfd)
            self.chain.append((self.appfd, 'vision_app', os.fstat(self.visionfd)))
        except Exception:
            self.close()
            raise

    def _directory(self, name, parent=None):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        self.fds.append(fd)
        value = os.fstat(fd)
        if not stat.S_ISDIR(value.st_mode) or value.st_uid != 0 or value.st_mode & 0o022:
            raise RuntimeError('directory is not root-owned and protected')
        return fd

    def assert_anchors(self):
        for parent, name, expected in self.chain:
            actual = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if ((actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino)
                    or not stat.S_ISDIR(actual.st_mode)
                    or actual.st_uid != 0 or actual.st_mode & 0o022):
                raise RuntimeError('directory identity changed')

    def _target(self, path):
        if path not in TARGETS:
            raise ValueError('target is not allowlisted')
        return (self.visionfd, path.split('/')[1]) if path.startswith('vision_app/') else (self.appfd, path)

    @staticmethod
    def _identity(value):
        return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns,
                value.st_ctime_ns, value.st_mode, value.st_uid, value.st_gid, value.st_nlink)

    @staticmethod
    def _regular(value, limit):
        if (not stat.S_ISREG(value.st_mode) or value.st_nlink != 1
                or value.st_uid != 0 or value.st_mode & 0o022
                or value.st_mode & 0o7000 or value.st_size > limit):
            raise RuntimeError('file is not a protected, bounded, single-link regular file')

    def _read(self, parent, name, limit, missing=False):
        self.assert_anchors()
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        except FileNotFoundError:
            if missing:
                return None
            raise
        try:
            before = os.fstat(fd)
            self._regular(before, limit)
            chunks, length = [], 0
            while True:
                chunk = os.read(fd, min(65536, limit + 1 - length))
                if not chunk:
                    break
                chunks.append(chunk)
                length += len(chunk)
                if length > limit:
                    raise RuntimeError('file grew beyond limit')
            after = os.fstat(fd)
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if self._identity(before) != self._identity(after) or self._identity(after) != self._identity(named):
                raise RuntimeError('file identity changed during read')
            return (b''.join(chunks), stat.S_IMODE(before.st_mode), before.st_uid, before.st_gid)
        finally:
            os.close(fd)

    def read_target(self, path):
        parent, name = self._target(path)
        return self._read(parent, name, MAX_CONFIG if path == 'config.json' else MAX_SOURCE, True)

    def acquire_lock(self, seal, recover=False):
        import fcntl
        self.assert_anchors()
        raw = json_bytes(seal)
        created = False
        fd = None
        try:
            try:
                fd = os.open(LOCK_NAME, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=self.appfd)
                created = True
                self.lock_retained = True
            except FileExistsError:
                if not recover:
                    raise RuntimeError('persistent transaction lock already exists')
                fd = os.open(LOCK_NAME, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.appfd)
            # The durable O_EXCL lease survives disconnects; flock prevents same-run live takeover.
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            value = os.fstat(fd)
            self._regular(value, 4096)
            if stat.S_IMODE(value.st_mode) != 0o600:
                raise RuntimeError('lock permissions must be 600')
            if created:
                offset = 0
                while offset < len(raw):
                    count = os.write(fd, raw[offset:])
                    if count <= 0:
                        raise RuntimeError('short lock write')
                    offset += count
                os.fsync(fd)
                os.fsync(self.appfd)
            else:
                existing = self._read(self.appfd, LOCK_NAME, 4096)[0]
                if existing != raw:
                    raise RuntimeError('persistent lock belongs to a different run or manifest')
            named = os.stat(LOCK_NAME, dir_fd=self.appfd, follow_symlinks=False)
            opened = os.fstat(fd)
            if self._identity(named) != self._identity(opened):
                raise RuntimeError('persistent lock identity changed')
            self.lockfd = fd
            self.lock_retained = True
            self.fds.append(fd)
            fd = None
        except Exception:
            if created:
                self.lock_uncertain = True
            raise
        finally:
            if fd is not None:
                os.close(fd)

    def release_lock(self, seal):
        self.assert_anchors()
        if self.lockfd is None:
            raise RuntimeError('transaction does not own lock')
        named = os.stat(LOCK_NAME, dir_fd=self.appfd, follow_symlinks=False)
        opened = os.fstat(self.lockfd)
        if self._identity(named) != self._identity(opened):
            raise RuntimeError('lock identity changed before release')
        if self._read(self.appfd, LOCK_NAME, 4096)[0] != json_bytes(seal):
            raise RuntimeError('lock seal changed before release')
        os.unlink(LOCK_NAME, dir_fd=self.appfd)
        self.lock_retained = False
        try:
            os.fsync(self.appfd)
        except Exception:
            self.lock_uncertain = True
            # Re-establish a durable barrier if possible; never claim an unlinked lock exists.
            try:
                self.acquire_lock(seal)
            except Exception:
                pass
            raise

    def open_run(self, run_id, create):
        self.assert_anchors()
        if create:
            try:
                os.mkdir(BACKUP_DIR, 0o700, dir_fd=self.appfd)
                os.fsync(self.appfd)
            except FileExistsError:
                pass
        backupfd = self._directory(BACKUP_DIR, self.appfd)
        if stat.S_IMODE(os.fstat(backupfd).st_mode) != 0o700:
            raise RuntimeError('backup parent must have mode 700')
        self.chain.append((self.appfd, BACKUP_DIR, os.fstat(backupfd)))
        if create:
            os.mkdir(run_id, 0o700, dir_fd=backupfd)
            os.fsync(backupfd)
        self.runfd = self._directory(run_id, backupfd)
        if stat.S_IMODE(os.fstat(self.runfd).st_mode) != 0o700:
            raise RuntimeError('backup run must have mode 700')
        self.chain.append((backupfd, run_id, os.fstat(self.runfd)))

    def write_artifact(self, name, data, mode=0o600, uid=0, gid=0):
        self.assert_anchors()
        if re.fullmatch(r'(manifest\.json|[0-5]\.(original|staged)|[0-5]\.(restore|displaced)\.[0-9a-f]{32})', name) is None:
            raise ValueError('invalid artifact name')
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     mode, dir_fd=self.runfd)
        try:
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
            offset = 0
            while offset < len(data):
                count = os.write(fd, data[offset:])
                if count <= 0:
                    raise RuntimeError('short artifact write')
                offset += count
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(self.runfd)

    def read_artifact(self, name, limit=MAX_SOURCE):
        if re.fullmatch(r'(manifest\.json|[0-5]\.(original|staged)|[0-5]\.(restore|displaced)\.[0-9a-f]{32})', name) is None:
            raise ValueError('invalid artifact name')
        return self._read(self.runfd, name, limit)[0]

    def replace(self, path, artifact):
        self.assert_anchors()
        parent, name = self._target(path)
        os.replace(artifact, name, src_dir_fd=self.runfd, dst_dir_fd=parent)
        os.fsync(parent)
        os.fsync(self.runfd)

    def displace_new(self, path, artifact):
        self.assert_anchors()
        parent, name = self._target(path)
        # Destination is created exclusively as a reservation, never overwritten evidence.
        self.write_artifact(artifact, b'')
        os.replace(name, artifact, src_dir_fd=parent, dst_dir_fd=self.runfd)
        os.fsync(parent)
        os.fsync(self.runfd)

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds = []


def _same_target(fs, path, expected):
    actual = fs.read_target(path)
    value = None if actual is None else digest(actual[0])
    if value != expected:
        raise RuntimeError('target SHA mismatch: ' + path)
    return actual


def checked_payloads(request):
    replacements = {}
    for path in PY_TARGETS:
        encoded = request['payloads'][path]
        if type(encoded) is not str or len(encoded) > ((MAX_SOURCE + 2) // 3) * 4:
            raise ValueError('source payload byte limit')
        raw = base64.b64decode(encoded.encode('ascii'), validate=True)
        if not raw or len(raw) > MAX_SOURCE or b'\x00' in raw:
            raise ValueError('invalid source extent')
        if digest(raw) != APPROVED_SOURCE_SHA256[path]:
            raise ValueError('source is not the approved v2 payload: ' + path)
        # Compilation happens in the actual board interpreter, never imports the payload.
        compile(raw, APP + '/' + path, 'exec', dont_inherit=True)
        replacements[path] = raw
    return replacements


def prepare(request, fs):
    originals = {}
    for path in TARGETS:
        originals[path] = _same_target(fs, path, request['expected_sha256'][path])
    replacements = checked_payloads(request)
    old_config = load_json(originals['config.json'][0], MAX_CONFIG)
    if type(old_config) is not dict:
        raise ValueError('config must be a JSON object')
    new_config = dict(old_config)
    new_config['bind'] = '127.0.0.1'
    replacements['config.json'] = json_bytes(new_config)
    if len(replacements['config.json']) > MAX_CONFIG:
        raise ValueError('new config byte limit')
    return originals, replacements


def make_manifest(request, originals, replacements):
    entries = []
    for index, path in enumerate(TARGETS):
        old = originals[path]
        entries.append({
            'path': path, 'old_sha256': None if old is None else digest(old[0]),
            'new_sha256': digest(replacements[path]),
            'backup': None if old is None else str(index) + '.original',
            'mode': 0o644 if old is None else old[1],
            'uid': 0 if old is None else old[2], 'gid': 0 if old is None else old[3],
        })
    return {'schema': 1, 'app': APP, 'unit': UNIT, 'run_id': request['run_id'],
            'approved_manifest_sha256': APPROVED_MANIFEST_SHA256,
            'config_change': {'bind': '127.0.0.1'}, 'entries': entries}


def validate_manifest(manifest, run_id):
    _exact_keys(manifest, ('schema', 'app', 'unit', 'run_id', 'approved_manifest_sha256', 'config_change', 'entries'))
    if (type(manifest['schema']) is not int or manifest['schema'] != 1 or manifest['app'] != APP
            or manifest['unit'] != UNIT or manifest['run_id'] != run_id
            or manifest['approved_manifest_sha256'] != APPROVED_MANIFEST_SHA256
            or manifest['config_change'] != {'bind': '127.0.0.1'}
            or type(manifest['entries']) is not list or len(manifest['entries']) != len(TARGETS)):
        raise ValueError('invalid fixed manifest identity')
    for index, entry in enumerate(manifest['entries']):
        _exact_keys(entry, ('path', 'old_sha256', 'new_sha256', 'backup', 'mode', 'uid', 'gid'))
        path = TARGETS[index]
        if entry['path'] != path:
            raise ValueError('invalid manifest target order')
        for field in ('old_sha256', 'new_sha256'):
            value = entry[field]
            if field == 'old_sha256' and path == NEW_TARGET:
                if value is not None:
                    raise ValueError('new target old hash must be null')
            elif type(value) is not str or SHA_RE.fullmatch(value) is None:
                raise ValueError('invalid manifest hash')
        if path in APPROVED_SOURCE_SHA256 and entry['new_sha256'] != APPROVED_SOURCE_SHA256[path]:
            raise ValueError('manifest source is not approved')
        expected_backup = None if path == NEW_TARGET else str(index) + '.original'
        if entry['backup'] != expected_backup:
            raise ValueError('invalid backup path')
        if (type(entry['mode']) is not int or entry['mode'] & ~0o777
                or entry['mode'] & 0o022 or type(entry['uid']) is not int or entry['uid'] != 0
                or type(entry['gid']) is not int or not 0 <= entry['gid'] <= 0xffffffff):
            raise ValueError('invalid stored permissions')
    return manifest


def restore(fs, manifest, entries, reader):
    results = []
    for entry in reversed(entries):
        path = entry['path']
        try:
            require_inactive(reader)
            actual = fs.read_target(path)
            current_hash = None if actual is None else digest(actual[0])
            if current_hash == entry['old_sha256']:
                results.append({'path': path, 'restored': True, 'already_original': True})
                continue
            if current_hash != entry['new_sha256']:
                raise RuntimeError('target SHA mismatch: ' + path)
            index = TARGETS.index(path)
            artifact = str(index) + ('.displaced.' if entry['old_sha256'] is None else '.restore.') + uuid.uuid4().hex
            if entry['old_sha256'] is None:
                fs.displace_new(path, artifact)
            else:
                raw = fs.read_artifact(entry['backup'])
                if digest(raw) != entry['old_sha256']:
                    raise RuntimeError('backup SHA mismatch')
                fs.write_artifact(artifact, raw, entry['mode'], entry['uid'], entry['gid'])
                _same_target(fs, path, entry['new_sha256'])
                fs.replace(path, artifact)
            _same_target(fs, path, entry['old_sha256'])
            results.append({'path': path, 'restored': True})
        except Exception as error:
            results.append({'path': path, 'restored': False, 'error': str(error)[:500]})
    return results


def deploy(request, fs, reader):
    originals, replacements = prepare(request, fs)
    manifest = make_manifest(request, originals, replacements)
    raw_manifest = json_bytes(manifest)
    result = {'mode': 'deploy', 'run_id': request['run_id'],
              'manifest_sha256': digest(raw_manifest), 'manifest': manifest,
              'backup_directory': APP + '/' + BACKUP_DIR + '/' + request['run_id']}
    seal = {'schema': 1, 'run_id': request['run_id'], 'manifest_sha256': digest(raw_manifest)}
    fs.acquire_lock(seal)
    attempted = []
    try:
        # Preparation can precede another run's successful commit; re-establish our preimage under lease.
        require_inactive(reader)
        for path in TARGETS:
            _same_target(fs, path, request['expected_sha256'][path])
        fs.open_run(request['run_id'], True)
        for index, path in enumerate(TARGETS):
            old = originals[path]
            if old is not None:
                fs.write_artifact(str(index) + '.original', old[0])
                if digest(fs.read_artifact(str(index) + '.original')) != digest(old[0]):
                    raise RuntimeError('backup verification failed')
            entry = manifest['entries'][index]
            fs.write_artifact(str(index) + '.staged', replacements[path], entry['mode'], entry['uid'], entry['gid'])
            if digest(fs.read_artifact(str(index) + '.staged')) != entry['new_sha256']:
                raise RuntimeError('stage verification failed')
        fs.write_artifact('manifest.json', raw_manifest)
        if fs.read_artifact('manifest.json', MAX_MANIFEST) != raw_manifest:
            raise RuntimeError('manifest verification failed')
        # Entire old set is checked again before any target is replaced.
        require_inactive(reader)
        for path in TARGETS:
            _same_target(fs, path, request['expected_sha256'][path])
        for index, entry in enumerate(manifest['entries']):
            require_inactive(reader)
            _same_target(fs, entry['path'], entry['old_sha256'])
            if digest(fs.read_artifact(str(index) + '.staged')) != entry['new_sha256']:
                raise RuntimeError('stage SHA changed before replacement')
            # Register before the call: rename may commit before its following fsync raises.
            attempted.append(entry)
            fs.replace(entry['path'], str(index) + '.staged')
            _same_target(fs, entry['path'], entry['new_sha256'])
        require_inactive(reader)
        for entry in manifest['entries']:
            _same_target(fs, entry['path'], entry['new_sha256'])
    except Exception as error:
        observed_changed = []
        observation_errors = []
        # Exact matching content alone is not ownership: never undo another run's changes.
        for entry in attempted:
            try:
                current = fs.read_target(entry['path'])
                current_hash = None if current is None else digest(current[0])
                if current_hash == entry['new_sha256']:
                    observed_changed.append(entry)
                elif current_hash != entry['old_sha256']:
                    observation_errors.append(entry['path'])
            except Exception:
                observation_errors.append(entry['path'])
        restored = restore(fs, manifest, observed_changed, reader)
        try:
            require_inactive(reader)
            for entry in manifest['entries']:
                _same_target(fs, entry['path'], entry['old_sha256'])
        except Exception:
            observation_errors.append('final_original_set_verification')
        result.update(status='unknown' if observation_errors or any(not item['restored'] for item in restored) else 'failed',
                      error=str(error)[:500], rollback=restored,
                      uncertain_targets=observation_errors)
        if result['status'] == 'failed':
            try:
                fs.release_lock(seal)
            except Exception as release_error:
                result.update(status='unknown', lock_error=str(release_error)[:500])
        return result
    try:
        fs.release_lock(seal)
        result['status'] = 'deployed'
    except Exception as error:
        result.update(status='unknown', lock_error=str(error)[:500])
    return result


def rollback(request, fs, reader):
    fs.open_run(request['run_id'], False)
    raw = fs.read_artifact('manifest.json', MAX_MANIFEST)
    if digest(raw) != request['manifest_sha256']:
        raise RuntimeError('manifest SHA mismatch')
    manifest = validate_manifest(load_json(raw, MAX_MANIFEST), request['run_id'])
    seal = {'schema': 1, 'run_id': request['run_id'], 'manifest_sha256': request['manifest_sha256']}
    fs.acquire_lock(seal, recover=True)
    # Accept exact original files too, allowing a strictly verified partial rollback retry.
    for entry in manifest['entries']:
        actual = fs.read_target(entry['path'])
        current_hash = None if actual is None else digest(actual[0])
        if current_hash not in (entry['old_sha256'], entry['new_sha256']):
            raise RuntimeError('target SHA mismatch: ' + entry['path'])
        if entry['backup'] is not None and digest(fs.read_artifact(entry['backup'])) != entry['old_sha256']:
            raise RuntimeError('backup SHA mismatch')
        if entry['path'] == 'config.json':
            original_config = load_json(fs.read_artifact(entry['backup']), MAX_CONFIG)
            if type(original_config) is not dict:
                raise ValueError('backup config must be an object')
            original_config['bind'] = '127.0.0.1'
            if digest(json_bytes(original_config)) != entry['new_sha256']:
                raise RuntimeError('manifest config change exceeds the approved bind-only change')
    require_inactive(reader)
    restored = restore(fs, manifest, manifest['entries'], reader)
    verified = True
    try:
        require_inactive(reader)
        for entry in manifest['entries']:
            _same_target(fs, entry['path'], entry['old_sha256'])
    except Exception:
        verified = False
    result = {'mode': 'rollback', 'run_id': request['run_id'],
              'manifest_sha256': request['manifest_sha256'], 'rollback': restored,
              'status': 'rolled_back' if verified and all(item['restored'] for item in restored) else 'unknown'}
    if result['status'] == 'rolled_back':
        try:
            fs.release_lock(seal)
        except Exception as error:
            result.update(status='unknown', lock_error=str(error)[:500])
    return result


def execute_request(request, fs_factory=SecureFS, service_reader=read_service_state):
    fs = None
    try:
        validate_request(request)
        require_inactive(service_reader)
        fs = fs_factory()
        result = deploy(request, fs, service_reader) if request['mode'] == 'deploy' else rollback(request, fs, service_reader)
    except Exception as error:
        result = {'status': 'unknown' if fs is not None and (fs.lock_retained or fs.lock_uncertain) else 'failed',
                  'error': str(error)[:500]}
    finally:
        if fs is not None:
            try:
                fs.close()
            except Exception as error:
                result = {'status': 'unknown', 'error': 'filesystem close failed: ' + str(error)[:500],
                          'prior_result': result}
    result['service_lifecycle_changed'] = False
    result['hardware_accessed'] = False
    result['application_started'] = False
    result['persistent_lock_retained'] = fs is not None and fs.lock_retained
    result['persistent_lock_uncertain'] = fs is not None and fs.lock_uncertain
    return result


def emit_payload(request_path, output_path, approved_manifest_path):
    # Host-only generation. The generated program has no path, command, or unit override.
    project = os.path.realpath(os.path.join(os.path.dirname(__file__), '../../..'))
    for path in (request_path, output_path, approved_manifest_path):
        if os.path.commonpath((project, os.path.realpath(path))) != project:
            raise ValueError('host generation paths must stay within this project')
    with open(request_path, 'rb') as stream:
        raw = stream.read(MAX_REQUEST + 1)
    request = validate_request(load_json(raw, MAX_REQUEST))
    with open(approved_manifest_path, 'rb') as stream:
        approved_raw = stream.read(MAX_MANIFEST + 1)
    if digest(approved_raw) != APPROVED_MANIFEST_SHA256:
        raise ValueError('approved v2 manifest byte seal mismatch')
    if request['mode'] == 'deploy':
        checked_payloads(request)
    with open(__file__, 'rb') as stream:
        source = stream.read()
    source = source[:source.index(b'\nif __name__ == ')]
    trailer = ("\nREQUEST = " + repr(request) +
               "\nsys.dont_write_bytecode = True\nRESULT = execute_request(REQUEST)\n" +
               "print(json.dumps(RESULT, sort_keys=True, allow_nan=False))\n" +
               "sys.exit(0 if RESULT['status'] in ('deployed', 'rolled_back') else 2)\n").encode('ascii')
    payload = source + trailer
    compile(payload, '<emitted-transaction>', 'exec', dont_inherit=True)
    with open(output_path, 'xb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return {'payload_sha256': digest(payload), 'bytes': len(payload), 'mode': request['mode'],
            'run_id': request['run_id'], 'executed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--emit', required=True, metavar='REQUEST_JSON')
    parser.add_argument('--output', required=True, metavar='STDIN_PY')
    parser.add_argument('--approved-manifest', required=True, metavar='V2_MANIFEST_JSON')
    args = parser.parse_args()
    print(json.dumps(emit_payload(args.emit, args.output, args.approved_manifest), sort_keys=True))
