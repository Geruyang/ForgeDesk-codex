"""Fixed, read-only FZ3B asset probe for Python 3.6 stdin execution.

No arguments, application imports, loader calls, device opens, or service actions.
Only pinned paths and relative records inside four pinned manifests are read.
"""
from __future__ import print_function

import configparser
import hashlib
import json
import math
import os
import posixpath
import re
import shlex
import stat
import subprocess
import sys
import time


PROJECT = '/root/fz3b-vision-console-20261009-001'
LOADER_ROOT = '/root/workspace/network10-v10.5-pl-loader'
LOADER_UNIT = '/etc/systemd/system/fz3b-pl-loader.service'
LOADER_CODE = LOADER_ROOT + '/fz3b_pl_loader.py'
LOADER_CONFIG = LOADER_ROOT + '/config.json'
REVIEWED_DROPIN_PATH = '/etc/systemd/system/fz3b-pl-loader.service.d/rtl-optim-retained.conf'
REVIEWED_CONFIG = '/root/rtl_optim-board-20261010/candidate008/rtl-loader-config.json'
REVIEWED_LOG = '/root/rtl_optim-board-20261010/candidate008/deployment/loader-events.jsonl'
REVIEWED_DROPIN = ('[Service]\nExecStart=\nExecStart=/usr/bin/python3 -B ' + LOADER_CODE +
                   ' daemon --config ' + REVIEWED_CONFIG + ' --auto-target a0005 --log ' +
                   REVIEWED_LOG + '\n').encode('ascii')
REVIEWED_DROPIN_SHA = 'b2520099c6d021a2697c716a293359c44fabae2e6cb00ee9b950f092c9bed553'
REVIEWED_CONFIG_SHA = '10d5878bcc40278f47995453662099fdc5814ed42fbd68973c1161a5664c81c8'
CONTRACT = PROJECT + '/vision_app/semantic-contract.json'
RETAINED = '/root/network10-v10.5-a0005-retained-current'
PAYLOAD = '/root/workspace/network10-v10.5-a0005-board-validation-001'
UNIT_SHA = '337b24f9abc571275d9286334773de75cc427529fb34ee0b1bac45e0e3a0ead7'
LOADER_SHA = 'aaa7f5ba913252f7f298eee6f025615c3eccb1ef09928d1e6724caff9a64101d'
CONTRACT_SHA = '5f2f281ff7d3f92539a96f42728bd0dcdf5e70d07c98a00cff7f07fdb64aac87'
CONTRACT_ID = '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e'
ROOT_MANIFESTS = (
    ('suffix', RETAINED + '/suffix11-selection/selection-manifest.json',
     '441feea506c6e1697ee05604c0f9b09c32500dd8b7443343a8238cdcaf3490da', RETAINED + '/suffix11-selection'),
    ('release', RETAINED + '/release/manifest.json',
     '3f52238b2a35d23f6f07c4cc9263ff8d4330c5aa27a6ed91640c4a45a8d45a2d', RETAINED + '/release'),
    ('deployment', PAYLOAD + '/deployment/manifest.json',
     '6e01472fae50fcab672bf8a6097648630618b8b304c860f0703472cd6ec1d2f3', PAYLOAD + '/deployment'),
    ('combined', PAYLOAD + '/validation/contract/combined-manifest.json',
     '4a32c9373e783ac572a5d3374b316181a4d52ae9a92ec45f8b13d763ef028690',
     PAYLOAD + '/validation/contract'),
)
NATIVE = (RETAINED + '/bin/ort_partition_runner_v3',
          RETAINED + '/bin/libcnn_v10_native_quant.so',
          '/root/board-debug-runtime-20261004/runtime/onnxruntime-linux-aarch64-1.16.3/lib/libonnxruntime.so.1.16.3')
ASSET_PATHS = {
    'a0005_driver_ko': PAYLOAD + '/deployment/files/cnn_ddr_v10_signed40_candidate.ko',
    'a0005_dtbo': PAYLOAD + '/deployment/platform/network10_v10_signed40.dtbo',
    'a0005_firmware': '/lib/firmware/rtl-optim-20261010-candidate008/cnn_rtl.pcap.bin',
    'a0005_native_bin': '/root/rtl_optim-board-20261010/candidate008/cnn_rtl.native.bin',
    'a0005_source_bit': '/root/rtl_optim-board-20261010/candidate008/cnn_rtl.bit',
    'admission': PAYLOAD + '/validation/contract/admission.json',
    'combined_manifest': PAYLOAD + '/validation/contract/combined-manifest.json',
    'factory_driver_ko': '/root/workspace/factory-backups/network10-factory-20261009-a0005-retained/fpgadrv.ko',
    'factory_firmware': '/lib/firmware/network10-v10.5/factory-restore-pcap-word-swapped.bin',
    'factory_native_source': '/root/workspace/factory-backups/network10-factory-20261009-a0005-retained/factory-restore-native.bin',
    'lease_ko': '/root/workspace/network10-v10.4-pl1-iopll-lease-candidate-001/fz3b_pl1_iopll_lease.ko',
    'range_proof': PAYLOAD + '/validation/contract/range-proof.json',
}
ASSET_EXPECTED = {
    'a0005_driver_ko': (798576, '7a273d19ccc20c6d19c7f64bd6c07fc0067ad600dedf70c6bd111441b85e57f5'),
    'a0005_dtbo': (795, 'bc933ce55458343c7231ac85ff5e11bae9e8362adc4b43d2e90a908121d0e312'),
    'a0005_firmware': (5568668, '76dff052e3648a4634585bbed186cfa202b434c66c996a3d2b3349fa3b908c02'),
    'a0005_native_bin': (5568668, 'bf788681c0e990c337b07ee949bec735dd81224bcabc4d5948d03221e217d439'),
    'a0005_source_bit': (5568891, '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726'),
    'admission': (1452, 'cfa5f1a3a29aa04f11a83a7e3b23637be063e22e5627ca66b4c20c62745443dd'),
    'combined_manifest': (5214, '4a32c9373e783ac572a5d3374b316181a4d52ae9a92ec45f8b13d763ef028690'),
    'factory_driver_ko': (2085072, 'a482b11d47a117e60f98efd43631b45a3a33ba98e81ff610204d2f301dbb0b6f'),
    'factory_firmware': (5568668, '0fde8e95fc96388d2e04732d4f90e7fb339cce707ebd0aec84298ee0d14de81b'),
    'factory_native_source': (5568668, '59e1a6176194eccc05603738ba3c2e71ea25c3c09cdf9dce47ed1ad1ddf5fc2e'),
    'lease_ko': (234600, '3e3643b8cb334b610095311f563cd9019b1acc886fd2c133efec063bf2a6f272'),
    'range_proof': (98930, '9f3de6ffb18a9d1de54addbcc471f95f18c47acf86f31e051794d59e528b2676'),
}
MAX_TOTAL = 512 * 1024 * 1024
MAX_SINGLE = 128 * 1024 * 1024
MAX_MANIFEST = 128 * 1024
MAX_CONFIG = 64 * 1024
MAX_LEAVES = 128
DEADLINE_S = 90
SHA = re.compile(r'^[0-9a-f]{64}$')
SENSITIVE = ('auth', 'credential', 'password', 'secret', 'token', 'environment', 'private_key')
SHOW = ('/bin/systemctl', 'show', 'fz3b-pl-loader.service', '--no-pager',
        '--property=ActiveState,SubState,MainPID,FragmentPath,DropInPaths,ExecStart')
SHOW_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C',
            'SYSTEMD_PAGER': 'cat', 'SYSTEMD_COLORS': '0'}


class ProbeError(Exception):
    pass


def _parts(path):
    if not isinstance(path, str) or not path.startswith('/') or '\\' in path or '\x00' in path:
        raise ProbeError('unsafe-path')
    parts = path[1:].split('/')
    if not parts or any(part in ('', '.', '..') for part in parts):
        raise ProbeError('unsafe-path')
    return parts


def _directory(parts):
    for flag in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK'):
        if not hasattr(os, flag):
            raise ProbeError('safe-open-unavailable')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open('/', flags)
    try:
        for part in parts:
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size,
            getattr(info, 'st_mtime_ns', info.st_mtime),
            getattr(info, 'st_ctime_ns', info.st_ctime))


def _type(info):
    if stat.S_ISLNK(info.st_mode):
        return 'symlink'
    if stat.S_ISDIR(info.st_mode):
        return 'directory'
    if stat.S_ISREG(info.st_mode):
        return 'regular'
    return 'other'


class SystemAccess(object):
    def describe(self, path):
        parts = _parts(path)
        parent = _directory(parts[:-1])
        try:
            info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            result = {'type': _type(info), 'bytes': info.st_size}
            if result['type'] == 'symlink':
                target = os.readlink(parts[-1], dir_fd=parent)
                if len(target) <= 256 and all(32 <= ord(char) < 127 for char in target):
                    result['linkTarget'] = target
            return result
        finally:
            os.close(parent)

    def _open_regular(self, path, limit):
        if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_NONBLOCK'):
            raise ProbeError('safe-open-unavailable')
        parts = _parts(path)
        parent = _directory(parts[:-1])
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally:
            os.close(parent)
        try:
            info = os.fstat(fd)
        except BaseException:
            os.close(fd)
            raise
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size < 0 or info.st_size > limit:
            os.close(fd)
            raise ProbeError('regular-file-or-limit-required')
        return fd, info

    def read(self, path, limit, deadline):
        fd, before = self._open_regular(path, limit)
        data = bytearray()
        try:
            while True:
                if time.monotonic() >= deadline:
                    raise ProbeError('deadline-exceeded')
                chunk = os.read(fd, min(65536, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > limit:
                    raise ProbeError('file-limit-exceeded')
            if _identity(before) != _identity(os.fstat(fd)):
                raise ProbeError('file-changed')
            return bytes(data)
        finally:
            os.close(fd)

    def digest(self, path, limit, deadline):
        fd, before = self._open_regular(path, limit)
        count = 0
        digest = hashlib.sha256()
        try:
            while True:
                if time.monotonic() >= deadline:
                    raise ProbeError('deadline-exceeded')
                chunk = os.read(fd, min(65536, limit + 1 - count))
                if not chunk:
                    break
                count += len(chunk)
                if count > limit:
                    raise ProbeError('file-limit-exceeded')
                digest.update(chunk)
            if _identity(before) != _identity(os.fstat(fd)):
                raise ProbeError('file-changed')
            return {'bytes': count, 'sha256': digest.hexdigest()}
        finally:
            os.close(fd)

    def service(self):
        completed = subprocess.run(list(SHOW), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=dict(SHOW_ENV), shell=False, close_fds=True,
                                   timeout=5, check=False)
        if completed.returncode or len(completed.stdout) > 32768:
            raise ProbeError('loader-service-show-failed')
        result = {}
        for line in completed.stdout.decode('utf-8').splitlines():
            key, sep, value = line.partition('=')
            if sep and key in ('ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths', 'ExecStart'):
                if key in result:
                    raise ProbeError('duplicate-service-property')
                result[key] = value
        return result

    def version(self):
        info = os.uname()
        return {'kernel': info.release, 'machine': info.machine,
                'python': list(sys.version_info[:3])}


def _pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise ProbeError('duplicate-json-key')
        value[key] = item
    return value


def _constant(value):
    raise ProbeError('nonfinite-json')


def _float(value):
    if len(value) > 64:
        raise ProbeError('json-number-limit')
    result = float(value)
    if not math.isfinite(result):
        raise ProbeError('nonfinite-json')
    return result


def _int(value):
    if len(value) > 64:
        raise ProbeError('json-number-limit')
    return int(value)


def parse_object(data):
    try:
        result = json.loads(data.decode('utf-8'), object_pairs_hook=_pairs,
                            parse_constant=_constant, parse_float=_float, parse_int=_int)
    except (UnicodeError, ValueError, RecursionError):
        raise ProbeError('invalid-json')
    if not isinstance(result, dict):
        raise ProbeError('json-object-required')
    pending = [(result, 1)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if count > 20000 or depth > 32:
            raise ProbeError('json-structure-limit')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    return result


def unit_config_path(data):
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    try:
        parser.read_string(data.decode('utf-8'))
        command = shlex.split(parser.get('Service', 'ExecStart'))
    except (UnicodeError, ValueError, configparser.Error):
        raise ProbeError('invalid-loader-unit')
    if command != ['/usr/bin/python3', '-B', LOADER_CODE, 'daemon', '--config', LOADER_CONFIG,
                   '--auto-target', 'a0005']:
        raise ProbeError('unapproved-loader-execstart')
    return command[5]


def effective_argv(value):
    matches = re.findall(r'argv\[\]=(.*?)\s+;', value)
    if len(matches) != 1 or len(value) > 4096:
        raise ProbeError('unreviewed-loader-effective-exec')
    try:
        return shlex.split(matches[0])
    except ValueError:
        raise ProbeError('unreviewed-loader-effective-exec')


def config_summary(value):
    assets = value.get('assets')
    if not isinstance(assets, dict):
        raise ProbeError('loader-assets-object-required')
    summary = {'schema': value.get('schema') if type(value.get('schema')) is str else None,
               'assets': []}
    for label in sorted(assets):
        if label not in ASSET_PATHS:
            raise ProbeError('unknown-loader-asset')
        record = assets[label]
        if not isinstance(record, dict):
            raise ProbeError('invalid-loader-asset')
        path, expected, extent = record.get('path'), record.get('sha256'), record.get('bytes')
        if type(path) is not str or type(expected) is not str or not SHA.fullmatch(expected.lower()) or type(extent) is not int or extent < 0:
            raise ProbeError('invalid-loader-asset')
        summary['assets'].append({'label': label, 'path': path,
                                  'pathMatchesPinned': path == ASSET_PATHS[label],
                                  'declaredSha256': expected.lower(), 'declaredBytes': extent,
                                  'declarationMatchesPinned': (extent, expected.lower()) == ASSET_EXPECTED[label]})
    if set(assets) != set(ASSET_PATHS):
        raise ProbeError('loader-asset-set-mismatch')
    return summary


def safe_relative(root, value):
    if type(value) is not str or not value or value.startswith('/') or '\\' in value or '\x00' in value:
        raise ProbeError('unsafe-manifest-relative-path')
    parts = value.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ProbeError('unsafe-manifest-relative-path')
    target = root + '/' + '/'.join(parts)
    if posixpath.commonpath((root, target)) != root:
        raise ProbeError('manifest-path-escapes-root')
    return target


def _sensitive(value):
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            for key, child in item.items():
                if any(word in key.lower() for word in SENSITIVE):
                    return True
                pending.append(child)
        elif isinstance(item, list):
            pending.extend(item)
    return False


def leaf_records(documents):
    records = {}
    for name, root, value in documents:
        pending = [value]
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                if 'path' in item:
                    if not all(key in item for key in ('sha256', 'bytes')):
                        raise ProbeError('manifest-path-without-integrity')
                    relative, expected, extent = item['path'], item['sha256'], item['bytes']
                    if type(expected) is not str or not SHA.fullmatch(expected.lower()) or type(extent) is not int or extent < 0 or extent > MAX_SINGLE:
                        raise ProbeError('invalid-manifest-record')
                    path = safe_relative(root, relative)
                    record = (extent, expected.lower())
                    if path in records and records[path] != record:
                        raise ProbeError('conflicting-manifest-record')
                    records[path] = record
                    if len(records) > MAX_LEAVES:
                        raise ProbeError('manifest-leaf-limit')
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
    return records


def _error(error):
    if isinstance(error, ProbeError):
        return str(error)
    if isinstance(error, FileNotFoundError):
        return 'absent'
    if isinstance(error, OSError):
        return 'os-error-' + str(error.errno)
    return type(error).__name__


def collect(access=None):
    access = SystemAccess() if access is None else access
    deadline = time.monotonic() + DEADLINE_S
    used = [0]
    failed_read = [False]
    issues = []
    result = {'schemaVersion': 1, 'scope': 'fixed-fz3b-runtime-assets-readonly',
              'compute': 'not-attempted', 'programming': 'not-attempted',
              'serviceActions': 'not-attempted', 'applicationImported': False,
              'limits': {'totalBytes': MAX_TOTAL, 'singleBytes': MAX_SINGLE,
                         'manifestBytes': MAX_MANIFEST, 'deadlineSeconds': DEADLINE_S},
              'loader': {}, 'contract': {}, 'roots': [], 'manifests': [],
              'leaves': [], 'native': [], 'issues': issues}

    def read(path, cap):
        if failed_read[0]:
            raise ProbeError('prior-read-failed')
        limit = min(cap, MAX_TOTAL - used[0])
        if limit <= 0:
            raise ProbeError('aggregate-byte-limit')
        try:
            data = access.read(path, limit, deadline)
            if type(data) is not bytes or len(data) > limit:
                raise ProbeError('read-limit-violation')
        except Exception:
            failed_read[0] = True
            raise
        used[0] += len(data)
        return data

    def digest(path, cap):
        if failed_read[0]:
            raise ProbeError('prior-read-failed')
        limit = min(cap, MAX_TOTAL - used[0])
        if limit <= 0:
            raise ProbeError('aggregate-byte-limit')
        try:
            observed = access.digest(path, limit, deadline)
            if type(observed.get('bytes')) is not int or observed['bytes'] > limit or not SHA.fullmatch(observed.get('sha256', '')):
                raise ProbeError('digest-limit-violation')
        except Exception:
            failed_read[0] = True
            raise
        used[0] += observed['bytes']
        return observed

    try:
        result['version'] = access.version()
        service = access.service()
        result['loader']['service'] = {key: service.get(key) for key in
                                      ('ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths')}
        dropin_path = service.get('DropInPaths')
        if service.get('FragmentPath') != LOADER_UNIT or dropin_path not in ('', REVIEWED_DROPIN_PATH):
            raise ProbeError('unreviewed-loader-effective-unit')
        unit = read(LOADER_UNIT, 16384)
        result['loader']['unit'] = {'path': LOADER_UNIT, 'bytes': len(unit),
                                    'sha256': hashlib.sha256(unit).hexdigest()}
        if result['loader']['unit']['sha256'] != UNIT_SHA:
            raise ProbeError('loader-unit-hash-mismatch')
        base_config_path = unit_config_path(unit)
        if dropin_path == REVIEWED_DROPIN_PATH:
            dropin = read(REVIEWED_DROPIN_PATH, 8192)
            dropin_sha = hashlib.sha256(dropin).hexdigest()
            result['loader']['reviewedDropIn'] = {'path': REVIEWED_DROPIN_PATH,
                                                   'bytes': len(dropin), 'sha256': dropin_sha,
                                                   'exactBytesMatch': dropin == REVIEWED_DROPIN}
            if dropin_sha != REVIEWED_DROPIN_SHA or dropin != REVIEWED_DROPIN:
                raise ProbeError('reviewed-dropin-byte-mismatch')
            config_path = REVIEWED_CONFIG
            expected_argv = ['/usr/bin/python3', '-B', LOADER_CODE, 'daemon', '--config',
                             REVIEWED_CONFIG, '--auto-target', 'a0005', '--log', REVIEWED_LOG]
        else:
            config_path = base_config_path
            expected_argv = ['/usr/bin/python3', '-B', LOADER_CODE, 'daemon', '--config',
                             LOADER_CONFIG, '--auto-target', 'a0005']
        result['loader']['service']['execMatchesPinned'] = effective_argv(service.get('ExecStart', '')) == expected_argv
        if not result['loader']['service']['execMatchesPinned'] or service.get('ActiveState') != 'active':
            raise ProbeError('unreviewed-loader-effective-exec-or-state')
        result['loader']['configPath'] = config_path
        code = digest(LOADER_CODE, 65536)
        result['loader']['code'] = dict({'path': LOADER_CODE}, **code)
        if code['sha256'] != LOADER_SHA:
            raise ProbeError('loader-code-hash-mismatch')
        config_data = read(config_path, MAX_CONFIG)
        config_sha = hashlib.sha256(config_data).hexdigest()
        if dropin_path == REVIEWED_DROPIN_PATH and config_sha != REVIEWED_CONFIG_SHA:
            raise ProbeError('reviewed-config-hash-mismatch')
        config = parse_object(config_data)
        summary = config_summary(config)
        result['loader']['config'] = dict({'path': config_path, 'bytes': len(config_data),
                                           'sha256': config_sha}, **summary)
        if summary['schema'] != 'fz3b-v10.5-ps-pl-loader-v1':
            raise ProbeError('loader-config-schema-mismatch')
        for item in summary['assets']:
            if not item['pathMatchesPinned'] or not item['declarationMatchesPinned']:
                issues.append('loader-asset-declaration-mismatch:' + item['label'])
                continue
            try:
                item['pathType'] = access.describe(item['path'])['type']
                if item['pathType'] != 'regular':
                    issues.append('loader-asset-not-regular:' + item['label'])
                    continue
                observed = digest(item['path'], MAX_SINGLE)
                item['observedBytes'] = observed['bytes']
                item['observedSha256'] = observed['sha256']
                item['match'] = (observed['bytes'] == item['declaredBytes'] and
                                 observed['sha256'] == item['declaredSha256'])
                if not item['match']:
                    issues.append('loader-asset-mismatch:' + item['label'])
            except Exception as error:
                item['error'] = _error(error)
                issues.append('loader-asset-unavailable:' + item['label'])
    except Exception as error:
        issues.append('loader-inventory:' + _error(error))

    try:
        data = read(CONTRACT, MAX_MANIFEST)
        sha = hashlib.sha256(data).hexdigest()
        value = parse_object(data)
        result['contract'] = {'path': CONTRACT, 'bytes': len(data), 'sha256': sha,
                              'contractId': value.get('contract_id'),
                              'match': sha == CONTRACT_SHA and value.get('contract_id') == CONTRACT_ID}
        if not result['contract']['match']:
            raise ProbeError('contract-identity-mismatch')
    except Exception as error:
        issues.append('contract:' + _error(error))

    for root in (RETAINED, PAYLOAD, LOADER_ROOT):
        item = {'path': root}
        try:
            item.update(access.describe(root))
            if item['type'] != 'directory':
                issues.append('root-not-directory:' + root)
        except Exception as error:
            item['error'] = _error(error)
            issues.append('root-unavailable:' + root)
        result['roots'].append(item)

    documents = []
    if result['contract'].get('match') and not any(root.get('type') != 'directory' for root in result['roots']):
        for name, path, expected, root in ROOT_MANIFESTS:
            item = {'name': name, 'path': path, 'expectedSha256': expected}
            try:
                data = read(path, MAX_MANIFEST)
                sha = hashlib.sha256(data).hexdigest()
                item.update(bytes=len(data), sha256=sha, match=sha == expected)
                if sha != expected:
                    raise ProbeError('manifest-hash-mismatch')
                value = parse_object(data)
                if _sensitive(value):
                    raise ProbeError('manifest-sensitive-content')
                item['content'] = value
                documents.append((name, root, value))
            except Exception as error:
                item['error'] = _error(error)
                issues.append('manifest:' + name + ':' + item['error'])
            result['manifests'].append(item)
    else:
        issues.append('manifest-read-held-by-root-or-contract')

    if len(documents) == len(ROOT_MANIFESTS):
        try:
            for path, (extent, expected) in sorted(leaf_records(documents).items()):
                item = {'path': path, 'expectedBytes': extent, 'expectedSha256': expected}
                try:
                    observed = digest(path, MAX_SINGLE)
                    item.update(observed)
                    item['match'] = observed['bytes'] == extent and observed['sha256'] == expected
                    if not item['match']:
                        issues.append('leaf-mismatch:' + path)
                except Exception as error:
                    item['error'] = _error(error)
                    issues.append('leaf-unavailable:' + path)
                result['leaves'].append(item)
        except Exception as error:
            issues.append('leaf-plan:' + _error(error))

    for path in NATIVE:
        item = {'path': path, 'expectedSha256': None, 'trustedAnchor': False}
        try:
            item.update(access.describe(path))
            if item['type'] == 'regular':
                item.update(digest(path, MAX_SINGLE))
        except Exception as error:
            item['error'] = _error(error)
        result['native'].append(item)
    result['totalFileReadBytes'] = used[0]
    result['result'] = 'pinned-file-hashes-match' if not issues else 'hold'
    result['limitations'] = ['Native binary digests lack an independent expected SHA in the captured semantic contract.',
                             'Read-only identity evidence is not deployment, PL/driver/clock stability, or inference acceptance.']
    return result


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        raise SystemExit('no arguments accepted')
    print(json.dumps(collect(), sort_keys=True, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    sys.exit(main())
