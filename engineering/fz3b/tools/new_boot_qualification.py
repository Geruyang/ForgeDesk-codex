"""Fixed read-only new-boot observations; not epoch approval. Python 3.6 stdlib.

No arguments, application imports, RPC, device opens, flock or remote writes.
Only the host wrapper compares observations with its separately reviewed plan.
"""
from __future__ import print_function

import _frozen_importlib as _bootstrap
import _imp
import datetime
import hashlib
import json
import os
import re
import select
import stat
import subprocess
import sys
import time

_MODULE_SPEC = _bootstrap.ModuleSpec
_BUILTIN_IMPORTER = _bootstrap.BuiltinImporter
_FROZEN_IMPORTER = _bootstrap.FrozenImporter
_IS_FROZEN = _imp.is_frozen
sys.dont_write_bytecode = True
SCOPE = 'fz3b-new-boot-readonly-qualification-v2'
APP = '/root/fz3b-vision-console-20261009-001'
OLD_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
OLD_PROFILE = '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd'
RESOURCE_MANIFEST = 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07'
BOOT = '/proc/sys/kernel/random/boot_id'
DEVICE = '/dev/network10_v10_signed40'
JOURNAL = APP + '/.forgedesk-product-operations'
QUARANTINE = APP + '/.forgedesk-recovery-quarantine'
PS_LEASE = APP + '/.forgedesk-ps-transaction.lock'
UNITS = ('fz3b-vision-console.service', 'fz3b-pl-loader.service', 'fz3b-app-r5.service', 'fz3b-app-cpu-clock.service')
PROPERTIES = ('ActiveState', 'SubState', 'MainPID', 'FragmentPath', 'DropInPaths', 'ExecStart',
              'WorkingDirectory', 'NeedDaemonReload', 'Transient', 'SendSIGKILL', 'TimeoutStopUSec', 'Restart')
SHOW_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'SYSTEMD_PAGER': 'cat', 'SYSTEMD_COLORS': '0'}
LOADER = '/root/workspace/network10-v10.5-pl-loader/fz3b_pl_loader.py'
LOADER_CONFIG = '/root/rtl_optim-board-20261010/candidate008/rtl-loader-config.json'
LOADER_DROPIN = '/etc/systemd/system/fz3b-pl-loader.service.d/rtl-optim-retained.conf'
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
SHA = re.compile(r'^[0-9a-f]{64}$')
MAX_PROCESSES, MAX_FDS, MAX_NAMES = 16384, 262144, 259
MAX_TOTAL, MAX_GUARDS, TCP_LIMIT = 16 * 1048576, 4 * 1048576, 2 * 1048576
DEADLINE_SECONDS = 45
FILE_PINS = {
    APP + '/vision_app/board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
    APP + '/vision_app/camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
    APP + '/vision_app/image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
    APP + '/vision_app/protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
    APP + '/vision_app/upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
    APP + '/config.json': 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2',
    APP + '/vision_app/semantic-contract.json': '5f2f281ff7d3f92539a96f42728bd0dcdf5e70d07c98a00cff7f07fdb64aac87',
    LOADER: 'aaa7f5ba913252f7f298eee6f025615c3eccb1ef09928d1e6724caff9a64101d',
    LOADER_CONFIG: '10d5878bcc40278f47995453662099fdc5814ed42fbd68973c1161a5664c81c8',
    LOADER_DROPIN: 'b2520099c6d021a2697c716a293359c44fabae2e6cb00ee9b950f092c9bed553',
    '/etc/systemd/system/' + UNITS[0]: '1089e63bb0138e9c0f0c45f22ad8f95a74bcc92fca998fa541f37836844d599b',
    '/etc/systemd/system/' + UNITS[1]: '337b24f9abc571275d9286334773de75cc427529fb34ee0b1bac45e0e3a0ead7',
    APP + '/.forgedesk-ps-backups/ps-security-1792122514610/manifest.json': 'a478fd7f12b15bc5a39d84e074d0d929b049a4a862c7a618c2d8edaffa9df1d1',
    '/root/rtl_optim-board-20261010/candidate008/cnn_rtl.bit': '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726',
}
# These are observations only. No unreviewed runtime byte hash is invented from a local CRLF/LF conversion.
OBSERVED_FILES = (APP + '/run.sh', APP + '/vision_app/link_setup.py', APP + '/vision_app/board_runtime.py',
                  APP + '/vision_app/r5_start.py', APP + '/vision_app/r5_bridge.py', APP + '/vision_app/cpu_clock_service.py',
                  '/etc/systemd/system/' + UNITS[2], '/etc/systemd/system/' + UNITS[3])
FILE_LIMITS = dict((name, 262144) for name in tuple(FILE_PINS) + OBSERVED_FILES)
FILE_LIMITS['/root/rtl_optim-board-20261010/candidate008/cnn_rtl.bit'] = 8 * 1048576
PACKAGE_ROOTS = ('/usr/lib/python3/dist-packages', '/usr/local/lib/python3.6/dist-packages', '/usr/local/lib/python3.6/site-packages')
PACKAGE_FILES = ('hazmat/primitives/asymmetric/ed25519.py', 'hazmat/bindings/_openssl.abi3.so', 'hazmat/bindings/_rust.abi3.so')
BOOTSTRAP_MODULES = ('datetime', 'hashlib', 'json', 'os', 're', 'select', 'stat', 'subprocess', 'sys', 'time')
BOOTSTRAP_ORIGINS = dict((name, ('/usr/lib/python3.6/' + ('json/__init__' if name == 'json' else name) + '.py',
                                '/usr/lib/python3.6/' + ('json/__init__' if name == 'json' else name) + '.pyc')) for name in BOOTSTRAP_MODULES)
BOOTSTRAP_ORIGINS['select'] = ('/usr/lib/python3.6/lib-dynload/select.cpython-36m-aarch64-linux-gnu.so',)
STAGES = ('boot-before', 'files', 'services', 'guards', 'census', 'dependencies', 'boot-after')
DIAGNOSTIC_FIXED_PATHS = {'/'}
for _fixed in tuple(FILE_LIMITS) + (BOOT, DEVICE, JOURNAL, QUARANTINE, PS_LEASE, '/usr/bin/python3', '/usr/bin/python3.6') + tuple(origin for origins in BOOTSTRAP_ORIGINS.values() for origin in origins) + PACKAGE_ROOTS + tuple(root + '/cryptography/' + leaf for root in PACKAGE_ROOTS for leaf in ('__init__.py',) + PACKAGE_FILES):
    _parts = _fixed.strip('/').split('/')
    DIAGNOSTIC_FIXED_PATHS.update('/' + '/'.join(_parts[:end]) for end in range(1, len(_parts) + 1))


class Refused(Exception):
    def __init__(self, code, diagnostic=None):
        Exception.__init__(self, code)
        self.diagnostic = diagnostic


def require(value, code):
    if not value:
        raise Refused(code)


def fixed_sys_none_origin(module, spec):
    if not (module is sys and sys.modules.get('sys') is sys and type(getattr(module, '__name__', None)) is str and module.__name__ == 'sys' and
            'sys' in sys.builtin_module_names and not hasattr(module, '__file__') and
            type(spec) is _MODULE_SPEC and type(spec.name) is str and spec.name == 'sys' and spec.origin is None and
            spec.loader is _BUILTIN_IMPORTER and getattr(module, '__loader__', None) is _BUILTIN_IMPORTER):
        return False
    # Bind the already-loaded frozen bootstrap and actual import machinery.
    # These are runtime object identities, not name-based provenance claims.
    return (sys.modules.get('_frozen_importlib') is _bootstrap and type(_bootstrap) is type(sys) and
            getattr(_bootstrap, 'sys', None) is sys and getattr(_bootstrap, '_imp', None) is _imp and
            sys.modules.get('_imp') is _imp and type(_imp) is type(sys) and '_imp' in sys.builtin_module_names and
            not hasattr(_imp, '__file__') and _imp.is_frozen is _IS_FROZEN and type(_IS_FROZEN) is type(len) and
            _IS_FROZEN('_frozen_importlib') is True and
            _bootstrap.ModuleSpec is _MODULE_SPEC and _bootstrap.BuiltinImporter is _BUILTIN_IMPORTER and
            _bootstrap.FrozenImporter is _FROZEN_IMPORTER and
            any(finder is _BUILTIN_IMPORTER for finder in sys.meta_path) and
            any(finder is _FROZEN_IMPORTER for finder in sys.meta_path))


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def object_json(raw, limit=32768):
    require(type(raw) is bytes and 0 < len(raw) <= limit, 'json-byte-budget')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate-json-key')
            result[key] = value
        return result
    def constant(_):
        raise Refused('nonfinite-json')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    require(type(value) is dict, 'json-object-required')
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop(); count += 1
        require(count <= 12000 and depth <= 24, 'json-structure-budget')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)
    return value


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, getattr(info, 'st_mtime_ns', info.st_mtime),
            getattr(info, 'st_ctime_ns', info.st_ctime), info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def metadata(info):
    return {'device': info.st_dev, 'inode': info.st_ino, 'bytes': info.st_size, 'mode': stat.S_IMODE(info.st_mode),
            'uid': info.st_uid, 'gid': info.st_gid, 'nlink': info.st_nlink}


def diagnostic_path_class(absolute):
    if absolute in DIAGNOSTIC_FIXED_PATHS:
        return 'fixed-input'
    if re.fullmatch(r'/proc/[1-9][0-9]{0,6}(?:/(?:fd|stat|cmdline|net(?:/tcp6?)?))?', absolute):
        return 'proc-census'
    for root in PACKAGE_ROOTS:
        if re.fullmatch(re.escape(root) + r'/cryptography(?:-[0-9][A-Za-z0-9_.+-]{0,79})?\.(?:dist-info|egg-info)(?:/(?:METADATA|PKG-INFO))?', absolute):
            return 'package-metadata'
    if re.fullmatch(re.escape(JOURNAL) + r'/(?:active\.lock|[0-9a-f-]{36}\.json)', absolute) or re.fullmatch(re.escape(QUARANTINE) + r'/(?:admission\.lock|active\.json|fz3b-recovery-v1-[0-9a-f-]{36}\.[a-z-]+\.json)', absolute):
        return 'guard-record'
    return None


def require_metadata(value, code, absolute, expected_kind, proc, named, opened=None, limit=None, stage='named-entry'):
    if value:
        return
    path_class = diagnostic_path_class(absolute)
    diagnostic = None
    if path_class is not None:
        observed = opened if opened is not None else named
        kind = stat.S_ISDIR if expected_kind == 'directory' else stat.S_ISREG
        diagnostic = {'category': code, 'path': absolute, 'pathClass': path_class, 'stage': stage,
                      'expectedKind': expected_kind, 'procPolicy': proc,
                      'named': dict(metadata(named), fileType=stat.S_IFMT(named.st_mode)),
                      'opened': dict(metadata(opened), fileType=stat.S_IFMT(opened.st_mode)) if opened is not None else None,
                      'identityDifferences': [key for key, a, b in zip(('device', 'inode', 'bytes', 'mtime', 'ctime', 'mode', 'uid', 'gid', 'nlink'), identity(named), identity(opened)) if a != b] if opened is not None else [],
                      'limitBytes': limit, 'checks': {'kindMatches': kind(observed.st_mode), 'ownerRoot': observed.st_uid == 0,
                      'noGroupOrOtherWrite': not bool(observed.st_mode & 0o022),
                      'singleLink': observed.st_nlink == 1 if expected_kind == 'regular-file' else None,
                      'withinSizeBudget': 0 <= observed.st_size <= limit if limit is not None else None,
                      'namedAndOpenedEqual': identity(named) == identity(opened) if opened is not None else None}}
    raise Refused(code, diagnostic)


def fd_identity(info):
    # Open logs may grow while the same handle remains valid. Bind the referred
    # object/type/device, not unrelated file-content timestamps or size.
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode), info.st_rdev)


def proc_start(raw):
    require(type(raw) is bytes and len(raw) <= 4096, 'proc-stat-budget')
    _, separator, tail = raw.rpartition(b') ')
    fields = tail.split()
    require(separator and len(fields) >= 20 and fields[19].isdigit(), 'proc-stat-envelope')
    value = int(fields[19]); require(value > 0, 'proc-startticks'); return value


def tcp_rows(raw, family):
    require(type(raw) is bytes and len(raw) <= TCP_LIMIT, 'tcp-byte-budget')
    lines = raw.decode('ascii').splitlines()
    require(lines and 'local_address' in lines[0] and len(lines) <= 16385, 'tcp-envelope')
    rows, width = [], 8 if family == 'tcp' else 32
    for line in lines[1:]:
        fields = line.split()
        require(len(fields) >= 10, 'tcp-row')
        local, remote, state = fields[1:4]
        require(re.fullmatch(r'[0-9A-F]{%d}:[0-9A-F]{4}' % width, local) and
                re.fullmatch(r'[0-9A-F]{%d}:[0-9A-F]{4}' % width, remote) and
                state in ('01', '02', '03', '04', '05', '06', '07', '08', '09', '0A', '0B', '0C') and fields[9].isdigit(), 'tcp-row')
        lp, rp = int(local[-4:], 16), int(remote[-4:], 16)
        if lp in (8765, 8766) or rp in (8765, 8766):
            loopback = local[:-5] == ('0100007F' if family == 'tcp' else '00000000000000000000000001000000')
            rows.append({'family': family, 'localPort': lp, 'remotePort': rp, 'loopback': loopback,
                         'state': state, 'inode': int(fields[9]), 'owners': []})
    return rows


def inspector_prefix(read_byte):
    def token(limit):
        value = bytearray()
        for _ in range(limit + 1):
            char = read_byte()
            if char in (b'', b'\0'):
                return bytes(value)
            value.extend(char)
        raise Refused('proc-prefix-budget')
    executable = token(256).rsplit(b'/', 1)[-1]
    if not re.fullmatch(br'python(?:[0-9]+(?:\.[0-9]+)*)?', executable):
        return False
    for position in range(2):
        # A script path is not an inspector. Read only enough to distinguish the
        # closed interpreter switches, never its path or remaining arguments.
        first = read_byte()
        if first not in (b'', b'\0', b'-'):
            return False
        item = first + token(2) if first == b'-' else b''
        if item in (b'', b'-', b'-c'):
            return True
        if item == b'-m' or not item.startswith(b'-'):
            return False
        require(position == 0 and item == b'-B', 'unknown-python-prefix')
    raise Refused('unknown-python-prefix')


def show_unit(unit):
    require(unit in UNITS, 'unit-not-allowed')
    args = ['/bin/systemctl', 'show', unit, '--no-pager', '--property=' + ','.join(PROPERTIES)]
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env=dict(SHOW_ENV), shell=False, close_fds=True)
    raw = bytearray(); end = time.monotonic() + 5
    try:
        fd = child.stdout.fileno()
        while True:
            remaining = end - time.monotonic(); require(remaining > 0, 'service-show-deadline')
            require(select.select([fd], [], [], remaining)[0], 'service-show-deadline')
            part = os.read(fd, min(4096, 65537 - len(raw)))
            if not part:
                break
            raw.extend(part); require(len(raw) <= 65536, 'service-show-byte-budget')
        require(child.wait(timeout=1) == 0, 'service-show-exit')
        return bytes(raw)
    finally:
        child.stdout.close()
        # This read-only collector never sends a signal or claims remote cleanup from a timeout.
        if child.poll() is None:
            try:
                child.wait(timeout=.25)
            except subprocess.TimeoutExpired:
                pass


class SystemAccess(object):
    def __init__(self):
        require(sys.platform.startswith('linux') and os.geteuid() == 0, 'linux-root-required')
        require(all(hasattr(os, flag) for flag in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK', 'O_NOATIME')), 'safe-open-unavailable')
        self.deadline, self.read_bytes = time.monotonic() + DEADLINE_SECONDS, 0

    def check(self):
        require(time.monotonic() < self.deadline, 'collector-deadline')

    def prefix_byte(self, fd):
        self.check(); raw = os.read(fd, 1); self.read_bytes += len(raw)
        require(self.read_bytes <= MAX_TOTAL, 'aggregate-read-budget'); return raw

    def directory(self, absolute, proc=False):
        self.check(); require(absolute.startswith('/') and all(p not in ('', '.', '..') for p in absolute[1:].split('/')), 'fixed-directory-path')
        require(not proc or absolute.startswith('/proc/'), 'proc-path-required')
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOATIME
        fd = os.open('/', flags)
        walked = ''
        try:
            for name in absolute[1:].split('/'):
                walked += '/' + name
                named = os.stat(name, dir_fd=fd, follow_symlinks=False)
                require_metadata(stat.S_ISDIR(named.st_mode) and (proc or named.st_uid == 0 and not named.st_mode & 0o022),
                                 'directory-metadata', walked, 'directory', proc, named)
                child = os.open(name, flags, dir_fd=fd)
                info = os.fstat(child)
                try:
                    require_metadata(stat.S_ISDIR(info.st_mode) and (proc or info.st_uid == 0 and not info.st_mode & 0o022) and identity(named) == identity(info),
                                     'directory-metadata', walked, 'directory', proc, named, info, stage='opened-entry')
                except BaseException:
                    os.close(child); raise
                os.close(fd); fd = child
            return fd
        except BaseException:
            os.close(fd); raise

    def read(self, absolute, limit, proc=False, empty=False):
        self.check(); parent_path, name = absolute.rsplit('/', 1)
        parent = self.directory(parent_path, proc=proc); leaf = None
        try:
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            require_metadata(stat.S_ISREG(named.st_mode) and named.st_nlink == 1 and 0 <= named.st_size <= limit and
                    (proc or named.st_uid == 0 and not named.st_mode & 0o022), 'file-metadata', absolute, 'regular-file', proc, named, limit=limit)
            leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOATIME, dir_fd=parent)
            before = os.fstat(leaf)
            require_metadata(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and
                    (proc or before.st_uid == 0 and not before.st_mode & 0o022) and identity(named) == identity(before),
                    'file-metadata', absolute, 'regular-file', proc, named, before, limit, 'opened-entry')
            require_metadata(0 <= before.st_size <= limit, 'file-size-budget', absolute, 'regular-file', proc, named, before, limit, 'opened-entry')
            raw = bytearray()
            while len(raw) <= limit:
                self.check(); part = os.read(leaf, min(65536, limit + 1 - len(raw)))
                if not part:
                    break
                raw.extend(part); self.read_bytes += len(part)
                require(self.read_bytes <= MAX_TOTAL, 'aggregate-read-budget')
            require(len(raw) <= limit and self.read_bytes <= MAX_TOTAL and (proc or len(raw) == before.st_size), 'file-read-budget')
            require(identity(before) == identity(os.fstat(leaf)) == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'file-changed')
            repeated = self.directory(parent_path, proc=proc)
            try:
                require(identity(os.fstat(parent)) == identity(os.fstat(repeated)), 'file-parent-changed')
            finally:
                os.close(repeated)
            require(not empty or len(raw) == 0, 'lock-not-empty')
            return bytes(raw), metadata(before)
        finally:
            if leaf is not None:
                os.close(leaf)
            os.close(parent)

    def boot(self):
        raw, _ = self.read(BOOT, 128, proc=True)
        text = raw.decode('ascii').strip()
        require(UUID.fullmatch(text) and raw == (text + '\n').encode('ascii'), 'boot-envelope'); return text

    def files(self):
        return [self.file(name) for name in sorted(FILE_LIMITS)]

    def file(self, name):
        require(name in FILE_LIMITS, 'fixed-file-required')
        raw, info = self.read(name, FILE_LIMITS[name]); expected = FILE_PINS.get(name)
        return {'path': name, 'sha256': sha(raw), 'expectedSha256': expected,
                'matchesPin': sha(raw) == expected if expected else None, 'metadata': info}

    def services(self, units=UNITS):
        require(all(unit in UNITS for unit in units) and 0 < len(units) <= len(UNITS), 'fixed-units-required')
        result = []
        for unit in units:
            self.check()
            raw = show_unit(unit)
            self.read_bytes += len(raw); require(self.read_bytes <= MAX_TOTAL, 'aggregate-read-budget')
            props = {}
            for line in raw.decode('utf-8').splitlines():
                key, sep, value = line.partition('=')
                require(sep and key in PROPERTIES and key not in props, 'service-property-envelope'); props[key] = value
            require(set(props) == set(PROPERTIES) and re.fullmatch(r'0|[1-9][0-9]*', props['MainPID']), 'service-property-set')
            pid = int(props['MainPID'])
            ticks = proc_start(self.read('/proc/%d/stat' % pid, 4096, proc=True)[0]) if pid > 1 else None
            require(pid == 0 or pid > 1, 'service-pid')
            expected_command = {UNITS[0]: APP + '/run.sh', UNITS[1]: '/usr/bin/python3 -B ' + LOADER + ' daemon --config ' + LOADER_CONFIG + ' --auto-target a0005 --log /root/rtl_optim-board-20261010/candidate008/deployment/loader-events.jsonl',
                                UNITS[2]: '/usr/bin/python3 -B -m vision_app.r5_start', UNITS[3]: '/usr/bin/python3 -B -m vision_app.cpu_clock_service --module ' + APP + '/cpu-clock/fz3b_cpu_clock.ko'}[unit]
            command_match = (props['ExecStart'].count('argv[]=') == 1 and props['ExecStart'].count('{') == 1 and
                             props['ExecStart'].count('}') == 1 and ('argv[]=' + expected_command + ' ;') in props['ExecStart'])
            expected_dropin = LOADER_DROPIN if unit == UNITS[1] else ''
            expected_prefix = {UNITS[0]: ('-B', '-m', 'vision_app.board_agent'), UNITS[1]: ('-B', LOADER, 'daemon'),
                               UNITS[2]: ('-B', '-m', 'vision_app.r5_start'), UNITS[3]: ('-B', '-m', 'vision_app.cpu_clock_service')}[unit]
            process = self.service_process(pid, expected_prefix) if pid > 1 else None
            require(process is None or process['startTicks'] == ticks, 'service-instance-changed')
            expected_cwd = '' if unit == UNITS[1] else APP
            if process is not None:
                process['workingDirectoryMatches'] = process.pop('cwd') == (expected_cwd or '/')
            result.append({'unit': unit, 'activeState': props['ActiveState'], 'subState': props['SubState'], 'mainPid': pid,
                           'startTicks': ticks, 'fragmentMatches': props['FragmentPath'] == '/etc/systemd/system/' + unit,
                           'dropInsMatch': props['DropInPaths'] == expected_dropin, 'execStartMatches': command_match,
                           'execStartSha256': sha(props['ExecStart'].encode('utf-8')), 'propertiesSha256': sha(canonical(props)),
                           'workingDirectoryMatches': props['WorkingDirectory'] == expected_cwd,
                           'process': process, 'managerCurrent': props['NeedDaemonReload'] == 'no' and props['Transient'] == 'no'})
        return result

    def service_process(self, pid, expected_prefix):
        parent = self.directory('/proc/%d' % pid, proc=True); command = None
        try:
            ticks = proc_start(self.read('/proc/%d/stat' % pid, 4096, proc=True)[0])
            exe = os.readlink('exe', dir_fd=parent)
            require(len(exe) <= 256, 'service-exe-budget')
            command = os.open('cmdline', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            require(stat.S_ISREG(os.fstat(command).st_mode), 'service-prefix-kind')
            tokens = []
            for _ in range(4):
                token = bytearray()
                for __ in range(257):
                    char = self.prefix_byte(command)
                    if char in (b'', b'\0'):
                        break
                    token.extend(char)
                require(len(token) <= 256, 'service-prefix-budget'); tokens.append(bytes(token))
            python_exe = bool(re.fullmatch(r'/usr/bin/python3(?:\.[0-9]+)?', exe))
            argv0 = bool(re.fullmatch(br'(?:/usr/bin/)?python3(?:\.[0-9]+)?', tokens[0]))
            matched = python_exe and argv0 and tuple(tokens[1:]) == tuple(v.encode('ascii') for v in expected_prefix)
            require(proc_start(self.read('/proc/%d/stat' % pid, 4096, proc=True)[0]) == ticks, 'service-pid-reused')
            return {'pid': pid, 'startTicks': ticks, 'exe': exe, 'cwd': os.readlink('cwd', dir_fd=parent),
                    'prefixSha256': sha(b'\0'.join(tokens)), 'matchesExpectedPrefix': matched}
        finally:
            if command is not None:
                os.close(command)
            os.close(parent)

    def guard_directory(self, absolute, kind):
        try:
            directory = self.directory(absolute)
        except FileNotFoundError:
            return {'path': absolute, 'state': 'absent', 'records': [], 'inventorySha256': sha(canonical([]))}
        try:
            info = os.fstat(directory); require(stat.S_IMODE(info.st_mode) == 0o700, 'guard-directory-mode')
            names = sorted(os.listdir(directory)); require(len(names) <= MAX_NAMES, 'guard-count-budget')
            records, used, held = [], 0, False
            for name in names:
                self.check()
                lock = name == ('active.lock' if kind == 'journal' else 'admission.lock')
                allowed = (lock or (UUID.fullmatch(name[:-5]) and name.endswith('.json'))) if kind == 'journal' else (lock or name == 'active.json' or re.fullmatch(r'fz3b-recovery-v1-[0-9a-f-]{36}\.[a-z-]+\.json', name))
                require(allowed, 'guard-unexpected-name')
                raw, meta = self.read(absolute + '/' + name, 65536, empty=lock)
                used += len(raw); require(used <= MAX_GUARDS and meta['mode'] == 0o600, 'guard-file-budget-or-mode')
                state = 'empty-lock' if lock else 'unverified-history'
                if not lock:
                    value = object_json(raw, 65536)
                    if kind == 'journal':
                        base = {'schemaVersion', 'operationId', 'nonce', 'profileSha256', 'grantId', 'status', 'remoteQuiescent'}
                        expected = base | ({'semantic', 'idle'} if value.get('status') == 'succeeded' else {'detail'})
                        require(set(value) == expected and value['schemaVersion'] == 1 and value['operationId'] == name[:-5] and
                                SHA.fullmatch(value.get('nonce', '')) and value.get('profileSha256') == OLD_PROFILE and UUID.fullmatch(value.get('grantId', '')), 'journal-envelope')
                        # Nested RPC receipts are retained by byte hash, not authenticated here.
                        terminal = value['status'] in ('succeeded', 'failed') and value['remoteQuiescent'] is True
                        state = 'terminal-history-observed' if terminal else 'held-history'; held = held or not terminal
                    else:
                        # No public-key HostACK verifier is integrated here. Never accept history as a release capability.
                        state = 'active' if name == 'active.json' else 'unverified-history'; held = True
                records.append({'name': name, 'sha256': sha(raw), 'metadata': meta, 'state': state})
            require(sorted(os.listdir(directory)) == names and identity(info) == identity(os.fstat(directory)), 'guard-inventory-changed')
            return {'path': absolute, 'state': 'held' if held else 'observed-no-active-record', 'records': records,
                    'inventorySha256': sha(canonical(records))}
        finally:
            os.close(directory)

    def guards(self):
        return dict((key, self.guard(key)) for key in ('journal', 'psLease', 'quarantine'))

    def guard(self, key):
        require(key in ('journal', 'psLease', 'quarantine'), 'fixed-guard-required')
        if key != 'psLease':
            return self.guard_directory(JOURNAL if key == 'journal' else QUARANTINE, key)
        try:
            raw, info = self.read(PS_LEASE, 65536)
            lease = {'path': PS_LEASE, 'state': 'present-held', 'sha256': sha(raw), 'metadata': info}
        except FileNotFoundError:
            lease = {'path': PS_LEASE, 'state': 'absent', 'sha256': None, 'metadata': None}
        return lease

    def dependencies(self, selected_roots=PACKAGE_ROOTS):
        require(all(root in PACKAGE_ROOTS for root in selected_roots) and 0 < len(selected_roots) <= len(PACKAGE_ROOTS), 'fixed-package-roots-required')
        roots = []
        for root in selected_roots:
            try:
                directory = self.directory(root)
            except FileNotFoundError:
                roots.append({'path': root, 'state': 'absent', 'distributions': [], 'moduleFiles': []}); continue
            try:
                names = sorted(os.listdir(directory)); require(len(names) <= 4096, 'package-name-budget')
                matches = [n for n in names if re.fullmatch(r'cryptography(?:-[0-9][A-Za-z0-9_.+-]{0,79})?\.(?:dist-info|egg-info)', n)]
                require(len(matches) <= 4, 'package-match-budget'); distributions = []
                for name in matches:
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'package-metadata-kind')
                    # Only Name/Version are emitted; no metadata body or unrelated distribution is exposed.
                    filename = 'METADATA' if name.endswith('.dist-info') else 'PKG-INFO'
                    raw, meta = self.read(root + '/' + name + '/' + filename, 65536)
                    found = {}
                    for line in raw.decode('utf-8').splitlines():
                        if not line:
                            break
                        key, sep, value = line.partition(':')
                        if key in ('Name', 'Version') and sep:
                            require(key not in found, 'package-duplicate-field'); found[key] = value.strip()
                    require(found.get('Name', '').lower() == 'cryptography' and re.fullmatch(r'[A-Za-z0-9_.+-]{1,80}', found.get('Version', '')), 'package-version-envelope')
                    distributions.append({'directory': name, 'name': 'cryptography', 'version': found['Version'], 'metadataSha256': sha(raw), 'metadata': meta})
                files = []
                for relative in ('__init__.py',) + PACKAGE_FILES:
                    absolute = root + '/cryptography/' + relative
                    try:
                        parent = self.directory(absolute.rsplit('/', 1)[0])
                        try:
                            info = os.stat(absolute.rsplit('/', 1)[1], dir_fd=parent, follow_symlinks=False)
                            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0 and not info.st_mode & 0o022, 'package-module-metadata')
                            files.append({'relativePath': relative, 'state': 'present', 'metadata': metadata(info)})
                        finally:
                            os.close(parent)
                    except FileNotFoundError:
                        files.append({'relativePath': relative, 'state': 'absent', 'metadata': None})
                require(sorted(os.listdir(directory)) == names, 'package-inventory-changed')
                roots.append({'path': root, 'state': 'observed', 'distributions': distributions, 'moduleFiles': files})
            finally:
                os.close(directory)
        return {'scope': 'fixed-cryptography-metadata-only', 'pythonVersion': list(sys.version_info[:3]), 'roots': roots,
                'applicationImported': False, 'providerImported': False, 'nativeLoaded': False,
                'providerFunctionVerified': False, 'ed25519Verified': False}

    def census(self):
        self.check(); own = os.getpid(); own_ticks = proc_start(self.read('/proc/%d/stat' % own, 4096, proc=True)[0])
        require(os.stat('/proc/1/ns/net').st_ino == os.stat('/proc/%d/ns/net' % own).st_ino, 'host-network-namespace-required')
        device = os.lstat(DEVICE); require(stat.S_ISCHR(device.st_mode), 'device-node-metadata')
        device_identity = dict(metadata(device), rdev=device.st_rdev)
        ancestry, parent_pid = [], os.getppid()
        for _ in range(4):
            require(parent_pid > 1, 'ssh-parent-not-identified')
            raw = self.read('/proc/%d/stat' % parent_pid, 4096, proc=True)[0]
            ticks = proc_start(raw); fields = raw.rpartition(b') ')[2].split()
            exe = os.readlink('/proc/%d/exe' % parent_pid)
            require(len(exe) <= 256, 'parent-exe-budget')
            ancestry.append({'pid': parent_pid, 'startTicks': ticks, 'exe': exe})
            if exe == '/usr/sbin/sshd':
                break
            require(fields[1].isdigit(), 'parent-stat-envelope'); parent_pid = int(fields[1])
        require(ancestry[-1]['exe'] == '/usr/sbin/sshd', 'ssh-parent-not-identified')
        rows, ipv6_absent = [], False
        for family in ('tcp', 'tcp6'):
            try:
                rows.extend(tcp_rows(self.read('/proc/%d/net/%s' % (own, family), TCP_LIMIT, proc=True)[0], family))
            except FileNotFoundError:
                require(family == 'tcp6', 'missing-ipv4-table'); ipv6_absent = True
        pids = sorted(int(name) for name in os.listdir('/proc') if name.isdigit())
        require(len(pids) <= MAX_PROCESSES, 'process-count-budget')
        owners, inspectors, count, scanned, vanished = [], [], 0, set(), []
        pending = list(pids)
        for_round = 0
        while pending:
          for pid in pending:
            self.check()
            if pid == own:
                scanned.add(pid)
                continue
            # A vanished process is excluded only after its non-inspector prefix
            # was classified and no relevant handle was observed. New/unreadable
            # identities are never silently skipped.
            ticks, inspector, relevant, fds_complete = None, None, False, False
            try:
              ticks = proc_start(self.read('/proc/%d/stat' % pid, 4096, proc=True)[0])
              parent = self.directory('/proc/%d' % pid, proc=True); command = None
              try:
                command = os.open('cmdline', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                require(stat.S_ISREG(os.fstat(command).st_mode), 'proc-prefix-kind')
                inspector = inspector_prefix(lambda: self.prefix_byte(command))
                if inspector:
                    inspectors.append({'pid': pid, 'startTicks': ticks})
              finally:
                if command is not None:
                    os.close(command)
                os.close(parent)
              self._scan_fds(pid, ticks, device, rows, owners, count)
              fds_complete = True
              count = self._fd_count
              relevant = any(o['pid'] == pid for o in owners) or any(any(o['pid'] == pid for o in r['owners']) for r in rows)
              require(proc_start(self.read('/proc/%d/stat' % pid, 4096, proc=True)[0]) == ticks, 'pid-reused-during-scan')
            except FileNotFoundError:
              count = getattr(self, '_fd_count', count)
              relevant = relevant or any(o['pid'] == pid for o in owners) or any(any(o['pid'] == pid for o in r['owners']) for r in rows)
              require(fds_complete and inspector is False and not relevant, 'incomplete-or-relevant-process-vanished')
              try:
                self.read('/proc/%d/stat' % pid, 4096, proc=True)
              except FileNotFoundError:
                pass
              else:
                raise Refused('live-process-incomplete-scan')
              vanished.append({'pid': pid, 'startTicks': ticks})
            scanned.add(pid)
          current = sorted(int(name) for name in os.listdir('/proc') if name.isdigit())
          require(len(current) <= MAX_PROCESSES and len(scanned) <= MAX_PROCESSES, 'process-count-budget')
          pending = [pid for pid in current if pid not in scanned]
          for_round += 1; require(not pending or for_round < 3, 'process-census-churn-budget')
        require(identity(device) == identity(os.lstat(DEVICE)) and device.st_rdev == os.lstat(DEVICE).st_rdev, 'device-node-changed')
        require(proc_start(self.read('/proc/%d/stat' % own, 4096, proc=True)[0]) == own_ticks, 'self-identity-changed')
        for item in ancestry:
            require(proc_start(self.read('/proc/%d/stat' % item['pid'], 4096, proc=True)[0]) == item['startTicks'] and os.readlink('/proc/%d/exe' % item['pid']) == item['exe'], 'ssh-parent-identity-changed')
        return {'complete': True, 'processCount': len(current), 'fdCount': count, 'selfExcluded': {'pid': own, 'startTicks': own_ticks},
                'sshAncestry': ancestry, 'device': device_identity, 'vanishedUnrelated': vanished,
                'deviceOwners': owners, 'inspectors': inspectors, 'tcp': rows, 'ipv6Absent': ipv6_absent,
                'environmentRead': False, 'stdinRead': False, 'remainingArgumentsRead': False, 'deviceOpened': False}

    def _scan_fds(self, pid, ticks, device, rows, owners, count):
            self._fd_count = count
            directory = self.directory('/proc/%d/fd' % pid, proc=True)
            try:
                names = sorted(os.listdir(directory)); require(all(n.isdigit() for n in names), 'fd-name')
                observed = []
                for name in names:
                    self.check(); count += 1; self._fd_count = count; require(count <= MAX_FDS, 'fd-count-budget')
                    target = os.readlink(name, dir_fd=directory); info = os.stat(name, dir_fd=directory)
                    observed.append((name, target, fd_identity(info)))
                    owner = {'pid': pid, 'startTicks': ticks, 'fd': int(name)}
                    if stat.S_ISCHR(info.st_mode) and info.st_rdev == device.st_rdev:
                        owners.append(owner)
                    match = re.fullmatch(r'socket:\[(\d+)\]', target)
                    if match:
                        for row in rows:
                            if row['inode'] == int(match.group(1)):
                                row['owners'].append(owner)
                for name, target, info in observed:
                    self.check()
                    require(os.readlink(name, dir_fd=directory) == target and fd_identity(os.stat(name, dir_fd=directory)) == info, 'fd-identity-changed')
                require(sorted(os.listdir(directory)) == names, 'fd-inventory-changed')
            finally:
                os.close(directory)
            self._fd_count = count

    def snapshot(self):
        return {'bootId': self.boot(), 'files': self.files(), 'services': self.services(), 'guards': self.guards(), 'census': self.census(), 'dependencies': self.dependencies()}

    def bootstrap_metadata(self, absolute, executable=False):
        parent_path, name = absolute.rsplit('/', 1); parent = self.directory(parent_path)
        try:
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if executable and absolute == '/usr/bin/python3' and stat.S_ISLNK(named.st_mode):
                require(named.st_uid == 0 and named.st_nlink == 1, 'bootstrap-fixed-interpreter-link-metadata')
                target = os.readlink(name, dir_fd=parent)
                require(target in ('python3.6', '/usr/bin/python3.6'), 'bootstrap-fixed-interpreter-link')
                require(identity(named) == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'bootstrap-interpreter-link-changed')
                return {'path': absolute, 'metadata': dict(metadata(named), fileType=stat.S_IFMT(named.st_mode)), 'linkTarget': target}
            require_metadata(stat.S_ISREG(named.st_mode) and named.st_uid == 0 and not named.st_mode & 0o022 and named.st_nlink == 1,
                             'file-metadata', absolute, 'regular-file', False, named, limit=16 * 1048576)
            require(identity(named) == identity(os.stat(name, dir_fd=parent, follow_symlinks=False)), 'bootstrap-origin-changed')
            return {'path': absolute, 'metadata': dict(metadata(named), fileType=stat.S_IFMT(named.st_mode)), 'linkTarget': None}
        finally:
            os.close(parent)

    def bootstrap(self):
        flags = dict((key, int(getattr(sys.flags, field, 0))) for key, field in
                     (('isolated', 'isolated'), ('noSite', 'no_site'), ('dontWriteBytecode', 'dont_write_bytecode'),
                      ('ignoreEnvironment', 'ignore_environment'), ('noUserSite', 'no_user_site')))
        value = {'flags': flags, 'pythonVersion': list(sys.version_info[:3]), 'executable': None, 'resolvedExecutable': None,
                 'reportedExecutableSha256': sha(sys.executable.encode('utf-8')) if type(sys.executable) is str and len(sys.executable) <= 256 else None,
                 'origins': [], 'trust': 'fixed-path-observation-only', 'cryptographicAttestation': False,
                 'transitiveOriginsVerified': False, 'issues': []}
        if any(flag != 1 for flag in flags.values()):
            value['issues'].append('isolated-bootstrap-flags-required'); return value
        if sys.executable != '/usr/bin/python3' or tuple(sys.version_info[:2]) != (3, 6):
            value['issues'].append('preselected-interpreter-not-observed'); return value
        value['executable'] = self.bootstrap_metadata('/usr/bin/python3', executable=True)
        target = '/usr/bin/python3.6' if value['executable']['linkTarget'] is not None else '/usr/bin/python3'
        value['resolvedExecutable'] = self.bootstrap_metadata(target, executable=True)
        for name in BOOTSTRAP_MODULES:
            module = sys.modules[name]; origin = getattr(module, '__file__', None)
            spec = getattr(module, '__spec__', None)
            # CPython 3.6 may leave its initial sys module without a ModuleSpec.
            # No-origin alone cannot establish a built-in module's identity.
            initial_sys = (name == 'sys' and module is sys and sys.modules.get('sys') is sys and
                           getattr(module, '__name__', None) == 'sys' and 'sys' in sys.builtin_module_names and spec is None)
            if origin is None and (getattr(spec, 'origin', None) == 'built-in' or initial_sys or
                                   name == 'sys' and fixed_sys_none_origin(module, spec)):
                value['origins'].append({'module': name, 'kind': 'built-in', 'reportedOriginSha256': None, 'file': None}); continue
            if type(origin) is not str or len(origin) > 256 or origin not in BOOTSTRAP_ORIGINS[name]:
                value['issues'].append('stdlib-origin-not-allowlisted')
                value['origins'].append({'module': name, 'kind': 'untrusted', 'reportedOriginSha256': sha(str(origin)[:512].encode('utf-8')), 'file': None}); continue
            value['origins'].append({'module': name, 'kind': 'fixed-file', 'reportedOriginSha256': sha(origin.encode('ascii')), 'file': self.bootstrap_metadata(origin)})
        return value

    def sleep(self):
        self.check(); time.sleep(.3)


def utc():
    return datetime.datetime.utcnow().isoformat(timespec='milliseconds') + 'Z'


def snapshot_issues(value):
    issues = []
    require(set(value) == {'bootId', 'files', 'services', 'guards', 'census', 'dependencies'} and UUID.fullmatch(value['bootId']), 'snapshot-envelope')
    require(len(value['files']) == len(FILE_LIMITS) and {item['path'] for item in value['files']} == set(FILE_LIMITS), 'file-set')
    if any(item['matchesPin'] is False for item in value['files']):
        issues.append('fixed-file-pin-mismatch')
    require(len(value['services']) == len(UNITS) and [s['unit'] for s in value['services']] == list(UNITS), 'service-set')
    for service in value['services']:
        active = service['activeState'] == 'active' and ((service['subState'] == 'running' and service['mainPid'] > 1 and service['startTicks'] > 0) or
                 (service['unit'] == UNITS[2] and service['subState'] == 'exited' and service['mainPid'] == 0 and service['startTicks'] is None))
        if not (active and service['fragmentMatches'] and service['dropInsMatch'] and service['execStartMatches'] and service['managerCurrent'] and
                service['workingDirectoryMatches'] and (service['process'] is None and service['mainPid'] == 0 or
                service['process'] is not None and service['process']['matchesExpectedPrefix'] and service['process']['workingDirectoryMatches'] and service['process']['startTicks'] == service['startTicks'])):
            issues.append('service-not-fixed-current')
    census = value['census']; require(census['complete'] is True and census['deviceOpened'] is False and census['environmentRead'] is False and census['stdinRead'] is False and census['remainingArgumentsRead'] is False, 'incomplete-census')
    if census['deviceOwners'] or census['inspectors']:
        issues.append('device-owner-or-inspector')
    app_pid = value['services'][0]['mainPid']
    for row in census['tcp']:
        if row['state'] == '0A':
            if row['localPort'] not in (8765, 8766) or not row['loopback'] or not row['owners'] or any(o['pid'] != app_pid for o in row['owners']):
                issues.append('unexpected-listener')
        elif row['state'] not in ('06', '07'):
            issues.append('active-application-connection')
    guards = value['guards']
    if guards['psLease']['state'] != 'absent' or any(guards[k]['state'] == 'held' for k in ('journal', 'quarantine')):
        issues.append('guard-held-or-unverified')
    return sorted(set(issues))


def stable_projection(value):
    census = value['census']
    # Full bounded scans remain in the report. Only unrelated population/count
    # churn is outside equality; no relevant owner or unknown inspector is omitted.
    relevant = dict((k, v) for k, v in census.items() if k not in ('processCount', 'fdCount', 'vanishedUnrelated'))
    relevant['deviceOwners'] = sorted(relevant['deviceOwners'], key=canonical)
    relevant['inspectors'] = sorted(relevant['inspectors'], key=canonical)
    relevant['tcp'] = sorted((dict(row, owners=sorted(row['owners'], key=canonical)) for row in relevant['tcp']), key=canonical)
    return dict(value, census=relevant)


def collect(access=None):
    result = {'schemaVersion': 2, 'scope': SCOPE, 'result': 'held', 'startedAt': utc(), 'completedAt': None,
              'historicalBootId': OLD_BOOT, 'historicalProfileSha256': OLD_PROFILE, 'resourceManifestSha256': RESOURCE_MANIFEST,
              'profileAdopted': False, 'computeAuthorized': False, 'releaseAuthorized': False,
              'noApplicationImport': True, 'noDeviceOpen': True, 'noRPC': True, 'noServiceActions': True,
              'noIntentionalRemoteWrites': True, 'bootstrap': None, 'scans': [], 'stable': False, 'relevantCoreStableObserved': False, 'issues': [],
              'dependencyScope': {'scope': 'fixed-cryptography-metadata-only', 'applicationImported': False, 'providerImported': False,
                                  'nativeLoaded': False, 'providerFunctionVerified': False, 'ed25519Verified': False},
              'globalStop': None, 'unrelatedChurn': None, 'unverified': ['loaded-PL-and-physical-identity', 'current-R5-clock-semantics', 'runtime-quarantine-gate-deployment',
                             'real-HostACK-verifier-deployment', 'native-independent-digests', 'new-epoch-and-historical-profile-compatibility',
                             'observed-only-startup-and-dependency-file-hashes', 'journal-nested-RPC-receipt-authenticity',
                             'cryptography-provider-function-and-Ed25519-capability', 'transitive-bootstrap-and-native-dependency-integrity'], 'totalReadBytes': 0}
    def code(error):
        return str(error) if isinstance(error, Refused) else type(error).__name__
    def observation(identity, action):
        before = getattr(access, 'read_bytes', 0)
        item = {'id': identity, 'state': 'not-attempted', 'data': None, 'error': None, 'diagnostics': [],
                'blockedBy': None, 'readBytesBefore': before, 'readBytesAfter': before}
        if result['globalStop'] is not None:
            item['error'] = 'global-stop'; return item
        try:
            access.check(); data = action(); access.check(); item['data'] = data; item['state'] = 'observed'
        except Exception as error:
            item['state'] = 'refused' if isinstance(error, Refused) else 'unavailable'; item['error'] = code(error)
            if isinstance(error, Refused) and error.diagnostic is not None:
                item['diagnostics'] = [error.diagnostic]
            result['issues'].append(item['error'])
            if item['error'] in ('collector-deadline', 'aggregate-read-budget', 'service-show-deadline', 'service-show-byte-budget', 'TimeoutExpired', 'MemoryError') or getattr(access, 'read_bytes', 0) > MAX_TOTAL:
                result['globalStop'] = item['error']
        item['readBytesAfter'] = getattr(access, 'read_bytes', 0)
        return item
    try:
        access = SystemAccess() if access is None else access
        result['bootstrap'] = observation('bootstrap', access.bootstrap)
        if result['bootstrap']['state'] != 'observed' or result['bootstrap']['data']['issues']:
            result['globalStop'] = 'bootstrap-untrusted'; result['issues'].append('bootstrap-untrusted')
    except Exception as error:
        result['globalStop'] = code(error); result['issues'].append(code(error))
        result['bootstrap'] = {'id': 'bootstrap', 'state': 'unavailable', 'data': None, 'error': code(error), 'diagnostics': [], 'blockedBy': None, 'readBytesBefore': 0, 'readBytesAfter': 0}
    for ordinal in (1, 2):
        scan = {'ordinal': ordinal, 'startedAt': utc(), 'completedAt': None, 'stages': []}
        for stage in STAGES:
            ids = stage_ids(stage); entries = []; blocked = []
            for key in ids:
                def action(stage=stage, key=key):
                    if stage.startswith('boot-'): return access.boot()
                    if stage == 'files': return access.file(key)
                    if stage == 'services': return access.services((key,))[0]
                    if stage == 'guards': return access.guard(key)
                    if stage == 'census': return access.census()
                    return access.dependencies((key,))['roots'][0]
                ancestor = next((entry for entry in blocked if key.startswith(entry[0] + '/')), None)
                if ancestor is not None:
                    count = getattr(access, 'read_bytes', 0)
                    entries.append({'id': key, 'state': 'not-attempted', 'data': None, 'error': 'unsafe-ancestor-not-traversed',
                                    'diagnostics': [], 'blockedBy': ancestor[1], 'readBytesBefore': count, 'readBytesAfter': count})
                    continue
                item = observation(key, action); entries.append(item)
                if stage == 'dependencies' and item['diagnostics']:
                    d = item['diagnostics'][0]
                    if d['category'] == 'directory-metadata' and d['stage'] == 'named-entry' and not d['procPolicy']:
                        blocked.append((d['path'], key))
            state = 'complete' if all(item['state'] == 'observed' for item in entries) else 'partial'
            scan['stages'].append({'id': stage, 'state': state, 'items': entries})
        scan['completedAt'] = utc(); result['scans'].append(scan)
        result['issues'].extend(retained_issues(scan))
        if ordinal == 1 and result['globalStop'] is None:
            try: access.sleep()
            except Exception as error:
                result['globalStop'] = code(error); result['issues'].append(code(error))
    cores = [core_from_scan(scan, result['bootstrap']['data']) for scan in result['scans']]
    for core in cores:
        if core is not None:
            result['issues'].extend(snapshot_issues(core))
    fences = [item['data'] for scan in result['scans'] for stage in scan['stages'] if stage['id'].startswith('boot-') for item in stage['items'] if item['state'] == 'observed']
    boot_stable = len(fences) == 4 and len(set(fences)) == 1
    if not boot_stable: result['issues'].append('boot-fences-incomplete-or-changed')
    if all(core is not None for core in cores) and boot_stable:
        result['relevantCoreStableObserved'] = canonical(stable_projection(cores[0])) == canonical(stable_projection(cores[1]))
        a, b = [core['census'] for core in cores]
        result['unrelatedChurn'] = {'processCountBefore': a['processCount'], 'processCountAfter': b['processCount'],
                                    'fdCountBefore': a['fdCount'], 'fdCountAfter': b['fdCount'],
                                    'vanishedClassifiedNonInspectors': len(a['vanishedUnrelated']) + len(b['vanishedUnrelated'])}
    if not result['relevantCoreStableObserved']: result['issues'].append('relevant-core-incomplete-or-changed')
    complete = all(stage['state'] == 'complete' for scan in result['scans'] for stage in scan['stages'])
    if not complete: result['issues'].append('required-stage-incomplete')
    dependencies_stable = False
    if all(result['scans'][i]['stages'][5]['state'] == 'complete' for i in (0, 1)):
        dependencies_stable = canonical([v['data'] for v in result['scans'][0]['stages'][5]['items']]) == canonical([v['data'] for v in result['scans'][1]['stages'][5]['items']])
    result['stable'] = complete and result['relevantCoreStableObserved'] and dependencies_stable
    if not result['stable']: result['issues'].append('two-scan-state-incomplete-or-changed')
    result['issues'] = sorted(set(result['issues'])); result['result'] = 'held' if result['issues'] else 'observed-only'
    result['totalReadBytes'] = getattr(access, 'read_bytes', 0)
    result['completedAt'] = utc()
    return result


def stage_ids(stage):
    return {'boot-before': ('boot',), 'files': tuple(sorted(FILE_LIMITS)), 'services': UNITS,
            'guards': ('journal', 'psLease', 'quarantine'), 'census': ('system',),
            'dependencies': PACKAGE_ROOTS, 'boot-after': ('boot',)}[stage]


def core_from_scan(scan, bootstrap):
    stages = dict((s['id'], s) for s in scan['stages'])
    if any(stages[key]['state'] != 'complete' for key in ('boot-before', 'files', 'services', 'guards', 'census')):
        return None
    return {'bootId': stages['boot-before']['items'][0]['data'], 'files': [v['data'] for v in stages['files']['items']],
            'services': [v['data'] for v in stages['services']['items']], 'guards': dict((v['id'], v['data']) for v in stages['guards']['items']),
            'census': stages['census']['items'][0]['data'], 'dependencies': None}


def retained_issues(scan):
    stages = dict((s['id'], s) for s in scan['stages']); issues = []
    for item in stages['files']['items']:
        if item['state'] == 'observed' and item['data']['matchesPin'] is False: issues.append('fixed-file-pin-mismatch')
    app = None
    for item in stages['services']['items']:
        if item['state'] != 'observed': continue
        value = item['data']
        if item['id'] == UNITS[0]: app = value
        active = value['activeState'] == 'active' and ((value['subState'] == 'running' and value['mainPid'] > 1) or
                 (item['id'] == UNITS[2] and value['subState'] == 'exited' and value['mainPid'] == 0))
        if not (active and all(value[key] for key in ('fragmentMatches', 'dropInsMatch', 'execStartMatches', 'workingDirectoryMatches', 'managerCurrent')) and
                (value['process'] is None or value['process']['matchesExpectedPrefix'] and value['process']['workingDirectoryMatches'])):
            issues.append('service-not-fixed-current')
    for item in stages['guards']['items']:
        if item['state'] == 'observed' and item['data']['state'] in ('held', 'present-held'): issues.append('guard-held-or-unverified')
    for item in stages['census']['items']:
        if item['state'] != 'observed': continue
        census = item['data']
        if census['deviceOwners'] or census['inspectors']: issues.append('device-owner-or-inspector')
        for row in census['tcp']:
            if row['state'] == '0A':
                if not (row['localPort'] in (8765, 8766) and row['loopback'] and row['owners'] and app is not None and
                        all(owner['pid'] == app['mainPid'] and owner['startTicks'] == app['startTicks'] for owner in row['owners'])):
                    issues.append('unexpected-listener')
            elif row['state'] not in ('06', '07'): issues.append('active-application-connection')
    return issues


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    require(not argv, 'no-arguments-accepted')
    print(json.dumps(collect(), sort_keys=True, separators=(',', ':'), allow_nan=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
