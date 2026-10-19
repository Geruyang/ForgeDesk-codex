"""Offline stdlib fixtures only. Never invokes collector main or a real child."""
import ast
import copy
from contextlib import ExitStack
import importlib.util
import io
import os
from pathlib import Path
import stat
import types
import unittest
from unittest.mock import patch, Mock

SOURCE = Path(__file__).with_name('new_boot_qualification.py')
spec = importlib.util.spec_from_file_location('readonly_collector_fixture', str(SOURCE))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


def meta(size=10, inode=8, mode=stat.S_IFREG | 0o600):
    return types.SimpleNamespace(st_dev=1, st_ino=inode, st_size=size, st_mtime=1, st_ctime=1,
                                 st_mtime_ns=1000000000, st_ctime_ns=1000000000,
                                 st_mode=mode, st_uid=0, st_gid=0, st_nlink=1, st_rdev=42)


def stat_bytes(ticks=10):
    return b'100 (name ) with spaces) ' + b' '.join([b'S', b'90'] + [b'0'] * 17 + [str(ticks).encode('ascii')])


def snapshot():
    metadata = q.metadata(meta())
    files = [dict(path=name, sha256=q.FILE_PINS.get(name, 'a' * 64), expectedSha256=q.FILE_PINS.get(name),
                  matchesPin=True if name in q.FILE_PINS else None, metadata=copy.deepcopy(metadata))
             for name in sorted(q.FILE_LIMITS)]
    services = []
    for i, unit in enumerate(q.UNITS):
        pid = 0 if i == 2 else 200 + i
        process = None if not pid else dict(pid=pid, startTicks=10, exe='/usr/bin/python3.6',
            prefixSha256='a' * 64, matchesExpectedPrefix=True, workingDirectoryMatches=True)
        services.append(dict(unit=unit, activeState='active', subState='exited' if not pid else 'running',
            mainPid=pid, startTicks=10 if pid else None, fragmentMatches=True, dropInsMatch=True,
            execStartMatches=True, execStartSha256='a' * 64, propertiesSha256='b' * 64,
            managerCurrent=True, workingDirectoryMatches=True, process=process))
    guard = lambda p: dict(path=p, state='absent', records=[], inventorySha256=q.sha(q.canonical([])))
    guards = dict(journal=guard(q.JOURNAL), quarantine=guard(q.QUARANTINE),
                  psLease=dict(path=q.PS_LEASE, state='absent', sha256=None, metadata=None))
    census = dict(complete=True, processCount=20, fdCount=100, selfExcluded=dict(pid=100, startTicks=10),
        sshAncestry=[dict(pid=90, startTicks=8, exe='/usr/sbin/sshd')], device=dict(metadata, rdev=42),
        vanishedUnrelated=[], deviceOwners=[], inspectors=[], tcp=[], ipv6Absent=False,
        environmentRead=False, stdinRead=False, remainingArgumentsRead=False, deviceOpened=False)
    deps = dict(scope='fixed-cryptography-metadata-only', pythonVersion=[3, 6, 15],
        roots=[dict(path=p, state='absent', distributions=[], moduleFiles=[]) for p in q.PACKAGE_ROOTS],
        applicationImported=False, providerImported=False, nativeLoaded=False,
        providerFunctionVerified=False, ed25519Verified=False)
    return dict(bootId='fbecfd68-ea21-498b-8ff3-f20237939e27', files=files, services=services,
                guards=guards, census=census, dependencies=deps)


class FakeAccess:
    def __init__(self, first=None, second=None):
        self.values = [first or snapshot(), second or snapshot()]
        self.read_bytes = 0
        self.boot_reads = 0

    def check(self): pass

    def bootstrap(self):
        file = lambda p: dict(path=p, metadata=dict(q.metadata(meta()), fileType=stat.S_IFREG), linkTarget=None)
        return dict(flags=dict(isolated=1, noSite=1, dontWriteBytecode=1, ignoreEnvironment=1, noUserSite=1), pythonVersion=[3, 6, 15],
                    reportedExecutableSha256=q.sha(b'/usr/bin/python3'),
                    executable=file('/usr/bin/python3'), resolvedExecutable=file('/usr/bin/python3'),
                    origins=[dict(module=n, kind='built-in', reportedOriginSha256=None, file=None) for n in q.BOOTSTRAP_MODULES],
                    trust='fixed-path-observation-only', cryptographicAttestation=False, transitiveOriginsVerified=False, issues=[])

    def current(self): return self.values[min(self.boot_reads // 2, 1)]
    def boot(self):
        value = self.values[min(self.boot_reads // 2, 1)]['bootId']; self.boot_reads += 1; return value
    def file(self, name): return next(f for f in self.current()['files'] if f['path'] == name)
    def services(self, units): return [next(s for s in self.current()['services'] if s['unit'] == unit) for unit in units]
    def guard(self, name): return self.current()['guards'][name]
    def census(self): return self.current()['census']
    def dependencies(self, roots):
        value = copy.deepcopy(self.current()['dependencies']); value['roots'] = [r for r in value['roots'] if r['path'] in roots]; return value

    def snapshot(self):
        return self.values.pop(0)

    def sleep(self):
        pass


def python36_bootstrap_fixture(case='none'):
    """Actual bootstrap method, isolated module/FS metadata fixtures only."""
    access = object.__new__(q.SystemAccess)
    access.bootstrap_metadata = Mock(side_effect=lambda p, **_: dict(path=p, metadata=dict(q.metadata(meta()), fileType=stat.S_IFREG), linkTarget=None))
    flags = types.SimpleNamespace(isolated=1, no_site=1, dont_write_bytecode=1, ignore_environment=1, no_user_site=1)
    modules = dict((n, types.SimpleNamespace(__spec__=types.SimpleNamespace(origin='built-in'))) for n in q.BOOTSTRAP_MODULES)
    modules['sys'] = q.sys
    fields = dict(flags=flags, executable='/usr/bin/python3', version_info=(3, 6, 9), modules=modules,
                  __spec__=None, __file__=None, __name__='sys', builtin_module_names=q.sys.builtin_module_names)
    if case == 'replacement':
        modules['sys'] = types.SimpleNamespace(__spec__=None, __file__=None, __name__='sys')
    elif case == 'missing-builtin':
        fields['builtin_module_names'] = tuple(n for n in q.sys.builtin_module_names if n != 'sys')
    elif case == 'wrong-name':
        fields['__name__'] = 'not-sys'
    elif case == 'conflicting-spec':
        fields['__spec__'] = types.SimpleNamespace(origin='/untrusted/sys.py')
    elif case == 'none-origin-spec':
        fields['__spec__'] = types.SimpleNamespace(origin=None)
    elif case == 'file-origin':
        fields['__file__'] = '/untrusted/sys.py'
    elif case == 'unrelated-none':
        modules['json'] = types.SimpleNamespace(__spec__=None, __file__=None, __name__='json')
    elif case != 'none':
        raise ValueError('unknown offline fixture case')
    with ExitStack() as stack:
        for field, value in fields.items():
            stack.enter_context(patch.object(q.sys, field, value, create=True))
        return access.bootstrap()


def python36_modulespec_fixture(case='exact'):
    """Real bootstrap class refs with synthetic 3.6 sys metadata; no real FS."""
    access = object.__new__(q.SystemAccess)
    access.bootstrap_metadata = Mock(side_effect=lambda p, **_: dict(path=p, metadata=dict(q.metadata(meta()), fileType=stat.S_IFREG), linkTarget=None))
    flags = types.SimpleNamespace(isolated=1, no_site=1, dont_write_bytecode=1, ignore_environment=1, no_user_site=1)
    modules = dict((n, types.SimpleNamespace(__spec__=types.SimpleNamespace(origin='built-in'))) for n in q.BOOTSTRAP_MODULES)
    modules.update(sys=q.sys, _frozen_importlib=q._bootstrap, _imp=q._imp)
    spec = q._MODULE_SPEC('sys', q._BUILTIN_IMPORTER, origin=None)
    fields = dict(flags=flags, executable='/usr/bin/python3', version_info=(3, 6, 9), modules=modules,
                  __spec__=spec, __name__='sys', __loader__=q._BUILTIN_IMPORTER,
                  builtin_module_names=q.sys.builtin_module_names, meta_path=list(q.sys.meta_path))
    same_named_spec = type('ModuleSpec', (), {'__module__': '_frozen_importlib'})
    same_named_loader = type('BuiltinImporter', (), {'__module__': '_frozen_importlib'})
    patches = []
    if case == 'spec-subclass':
        fields['__spec__'] = type('ChildSpec', (q._MODULE_SPEC,), {})('sys', q._BUILTIN_IMPORTER, origin=None)
    elif case == 'spec-lookalike':
        fields['__spec__'] = same_named_spec(); fields['__spec__'].__dict__.update(name='sys', loader=q._BUILTIN_IMPORTER, origin=None)
    elif case == 'spec-loader-lookalike': spec.loader = same_named_loader
    elif case == 'sys-loader-lookalike': fields['__loader__'] = same_named_loader
    elif case == 'loader-instance': spec.loader = q._BUILTIN_IMPORTER()
    elif case == 'spec-name': spec.name = 'json'
    elif case == 'spec-name-eq':
        class NameLookalike:
            def __eq__(self, _): raise AssertionError('custom equality must not execute')
        spec.name = NameLookalike()
    elif case == 'spec-name-str-subclass': spec.name = type('NameSubclass', (str,), {})('sys')
    elif case == 'spec-origin-string-none': spec.origin = 'None'
    elif case == 'spec-origin-file': spec.origin = '/untrusted/sys.py'
    elif case == 'spec-origin-frozen': spec.origin = 'frozen'
    elif case == 'registry-sys-replaced': modules['sys'] = types.SimpleNamespace(__name__='sys', __spec__=spec)
    elif case == 'sys-name': fields['__name__'] = 'json'
    elif case == 'no-sys-builtin': fields['builtin_module_names'] = tuple(n for n in q.sys.builtin_module_names if n != 'sys')
    elif case == 'sys-file-none': fields['__file__'] = None
    elif case == 'sys-file-origin': fields['__file__'] = '/untrusted/sys.py'
    elif case == 'bootstrap-replaced': modules['_frozen_importlib'] = types.SimpleNamespace(ModuleSpec=q._MODULE_SPEC, BuiltinImporter=q._BUILTIN_IMPORTER, FrozenImporter=q._FROZEN_IMPORTER)
    elif case == 'bootstrap-missing': del modules['_frozen_importlib']
    elif case == 'import-control-replaced': modules['_imp'] = types.SimpleNamespace(is_frozen=lambda _: True)
    elif case == 'import-control-missing': del modules['_imp']
    elif case == 'import-control-not-builtin': fields['builtin_module_names'] = tuple(n for n in q.sys.builtin_module_names if n != '_imp')
    elif case == 'import-control-file': patches.append(patch.object(q._imp, '__file__', None, create=True))
    elif case == 'not-frozen': patches.append(patch.object(q._imp, 'is_frozen', return_value=False))
    elif case == 'replaced-frozen-lambda': patches.append(patch.object(q._imp, 'is_frozen', lambda _: True))
    elif case == 'captured-frozen-lookalike':
        fake_probe = type('builtin_function_or_method', (), {'__module__': 'builtins', '__call__': lambda *_: True})()
        patches.extend((patch.object(q._imp, 'is_frozen', fake_probe), patch.object(q, '_IS_FROZEN', fake_probe)))
    elif case == 'bootstrap-sys-replaced': patches.append(patch.object(q._bootstrap, 'sys', types.SimpleNamespace()))
    elif case == 'bootstrap-imp-replaced': patches.append(patch.object(q._bootstrap, '_imp', types.SimpleNamespace()))
    elif case == 'export-spec-replaced': patches.append(patch.object(q._bootstrap, 'ModuleSpec', same_named_spec))
    elif case == 'export-builtin-replaced': patches.append(patch.object(q._bootstrap, 'BuiltinImporter', same_named_loader))
    elif case == 'export-frozen-replaced': patches.append(patch.object(q._bootstrap, 'FrozenImporter', type('FrozenImporter', (), {})))
    elif case == 'no-builtin-finder': fields['meta_path'] = [f for f in q.sys.meta_path if f is not q._BUILTIN_IMPORTER]
    elif case == 'no-frozen-finder': fields['meta_path'] = [f for f in q.sys.meta_path if f is not q._FROZEN_IMPORTER]
    elif case == 'unrelated-none': modules['json'] = types.SimpleNamespace(__name__='json', __spec__=q._MODULE_SPEC('json', q._BUILTIN_IMPORTER, origin=None))
    elif case != 'exact': raise ValueError('unknown offline modulespec fixture case')
    with ExitStack() as stack:
        for field, value in fields.items(): stack.enter_context(patch.object(q.sys, field, value, create=True))
        for item in patches: stack.enter_context(item)
        return access.bootstrap()


class CollectorTests(unittest.TestCase):
    def setUp(self):
        for name, value in [('O_NONBLOCK', 0x400), ('O_NOFOLLOW', 0x800), ('O_NOATIME', 0x1000), ('O_DIRECTORY', 0x2000)]:
            item = patch.object(q.os, name, value, create=True); item.start(); self.addCleanup(item.stop)

    def test_python36_grammar_and_import_surface(self):
        raw = SOURCE.read_bytes()
        tree = ast.parse(raw, feature_version=(3, 6))
        imports = {n.name for item in ast.walk(tree) if isinstance(item, ast.Import) for n in item.names}
        self.assertEqual(imports, {'_frozen_importlib', '_imp', 'datetime', 'hashlib', 'json', 'os', 're', 'select', 'stat', 'subprocess', 'sys', 'time'})
        forbidden = {'mkdir', 'makedirs', 'unlink', 'remove', 'rename', 'replace', 'write', 'write_bytes', 'write_text',
                     'chmod', 'chown', 'flock', 'kill', 'terminate', 'connect', 'socket', 'exec', 'eval', 'fsync'}
        calls = [n.func for n in ast.walk(tree) if isinstance(n, ast.Call)]
        self.assertFalse(forbidden.intersection(n.attr for n in calls if isinstance(n, ast.Attribute)))
        self.assertFalse({'exec', 'eval', '__import__'}.intersection(n.id for n in calls if isinstance(n, ast.Name)))
        self.assertEqual(sum(isinstance(n, ast.Attribute) and n.attr == 'Popen' for n in calls), 1)

    def test_no_main_arguments(self):
        with self.assertRaisesRegex(q.Refused, 'no-arguments'):
            q.main(['--adopt'])

    def test_complete_observation_is_not_qualification_or_authority(self):
        v = q.collect(FakeAccess())
        self.assertEqual(v['result'], 'observed-only')
        self.assertTrue(v['stable'])
        self.assertFalse(v['profileAdopted'] or v['computeAuthorized'] or v['releaseAuthorized'])
        self.assertIn('cryptography-provider-function-and-Ed25519-capability', v['unverified'])

    def test_unrelated_population_churn_not_in_relevant_equality(self):
        second = snapshot(); second['census']['processCount'] += 2; second['census']['fdCount'] += 4
        second['census']['vanishedUnrelated'] = [dict(pid=300, startTicks=21)]
        v = q.collect(FakeAccess(second=second))
        self.assertEqual(v['result'], 'observed-only')
        self.assertEqual(v['unrelatedChurn']['vanishedClassifiedNonInspectors'], 1)

    def test_relevant_changes_and_unknown_inspectors_hold(self):
        changes = [lambda s: s.update(bootId=q.OLD_BOOT),
                   lambda s: s['census']['device'].update(inode=100),
                   lambda s: s['services'][0]['process'].update(matchesExpectedPrefix=False),
                   lambda s: s['census']['inspectors'].append(dict(pid=299, startTicks=20)),
                   lambda s: s['census']['deviceOwners'].append(dict(pid=200, startTicks=10, fd=5)),
                   lambda s: s['guards']['psLease'].update(state='present-held')]
        for change in changes:
            with self.subTest(change=change):
                second = snapshot(); change(second)
                self.assertEqual(q.collect(FakeAccess(second=second))['result'], 'held')

    def test_read_failure_is_not_empty_complete_scan(self):
        fake = FakeAccess(); fake.file = Mock(side_effect=PermissionError('private-data-not-emitted'))
        v = q.collect(fake)
        self.assertEqual(v['result'], 'held')
        self.assertTrue(all(s['stages'][1]['state'] == 'partial' for s in v['scans']))
        self.assertTrue(all(s['stages'][4]['state'] == 'complete' for s in v['scans']))
        self.assertIn('PermissionError', v['issues'])

    def test_prefix_closed_inspector_detection_without_long_script_read(self):
        for raw, expected in [(b'/usr/bin/python3\0-B\0-c\0secret', True), (b'python3\0-\0', True),
                              (b'python3\0-B\0/root/workspace/a-very-long-script.py\0secret', False),
                              (b'python3\0-B\0-m\0vision_app.board_agent', False), (b'sshd: root@notty\0', False)]:
            stream = io.BytesIO(raw)
            self.assertIs(q.inspector_prefix(lambda: stream.read(1)), expected)
            if b'/root/workspace' in raw:
                self.assertLess(stream.tell(), raw.index(b'workspace'))
        with self.assertRaisesRegex(q.Refused, 'unknown-python-prefix'):
            q.inspector_prefix(lambda s=io.BytesIO(b'python3\0-I\0'): s.read(1))

    def test_duplicate_nonfinite_and_structural_json_refused(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'[]', b'{"a":' + b'[' * 26 + b'0' + b']' * 26 + b'}'):
            with self.subTest(raw=raw), self.assertRaises((q.Refused, ValueError)):
                q.object_json(raw)

    def test_proc_stat_and_tcp_validation(self):
        self.assertEqual(q.proc_start(stat_bytes(400)), 400)
        raw = b'  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n0: 0100007F:223D 00000000:0000 0A 0:0 00:0 0 0 0 42\n'
        rows = q.tcp_rows(raw, 'tcp'); self.assertEqual(rows[0]['localPort'], 8765)
        self.assertTrue(rows[0]['loopback']); self.assertEqual(rows[0]['inode'], 42)
        with self.assertRaises(q.Refused):
            q.tcp_rows(raw.replace(b'0100007F', b'NOT_VALID'), 'tcp')

    def accessor(self):
        access = object.__new__(q.SystemAccess); access.deadline = float('inf'); access.read_bytes = 0
        return access

    def safe_read(self, info=None, parent_changed=False, growth=False):
        access = self.accessor(); access.directory = Mock(side_effect=[10, 12])
        original = info or meta(3)
        def fstat(fd):
            return meta(0, 99 if parent_changed and fd == 12 else 9, stat.S_IFDIR | 0o700) if fd in (10, 12) else original
        stream = io.BytesIO(b'abcd' if growth else b'abc')
        with patch.object(q.os, 'stat', return_value=original), patch.object(q.os, 'fstat', side_effect=fstat), \
             patch.object(q.os, 'open', return_value=11) as opened, patch.object(q.os, 'close'), \
             patch.object(q.os, 'read', side_effect=lambda _fd, length: stream.read(length)), \
             patch.object(q.os, 'O_NOFOLLOW', 0x100, create=True), patch.object(q.os, 'O_NOATIME', 0x200, create=True):
            if info is not None or parent_changed or growth:
                with self.assertRaises(q.Refused):
                    access.read('/fixed/input', 3)
            else:
                self.assertEqual(access.read('/fixed/input', 3)[0], b'abc')
            if info is not None:
                opened.assert_not_called()

    def test_actual_read_holds_nonregular_links_budget_before_open(self):
        for info in (meta(3, mode=stat.S_IFCHR | 0o600), meta(4), meta(3, mode=stat.S_IFLNK | 0o777)):
            self.safe_read(info)
        info = meta(3); info.st_nlink = 2; self.safe_read(info)

    def test_actual_read_checks_byte_cap_and_named_parent_identity(self):
        self.safe_read(); self.safe_read(parent_changed=True); self.safe_read(growth=True)

    def test_actual_aggregate_budget_stops_during_read_with_bounded_overshoot(self):
        access = self.accessor(); access.read_bytes = q.MAX_TOTAL - 1; access.directory = Mock(return_value=10)
        with patch.object(q.os, 'stat', return_value=meta(3)), patch.object(q.os, 'fstat', return_value=meta(3)), \
             patch.object(q.os, 'open', return_value=11), patch.object(q.os, 'close'), patch.object(q.os, 'read', return_value=b'abc') as reading:
            with self.assertRaisesRegex(q.Refused, 'aggregate-read-budget'): access.read(q.APP + '/config.json', 3)
            self.assertEqual(reading.call_count, 1); self.assertEqual(access.read_bytes, q.MAX_TOTAL + 2)

    def test_bootstrap_fixed_symlink_still_requires_root_and_single_link(self):
        access = self.accessor(); access.directory = Mock(return_value=10)
        for owner, links in ((1000, 1), (0, 2)):
            value = meta(9, mode=stat.S_IFLNK | 0o777); value.st_uid = owner; value.st_nlink = links
            with patch.object(q.os, 'stat', return_value=value), patch.object(q.os, 'close'), patch.object(q.os, 'readlink') as target:
                with self.assertRaisesRegex(q.Refused, 'bootstrap-fixed-interpreter-link-metadata'): access.bootstrap_metadata('/usr/bin/python3', executable=True)
                target.assert_not_called()

    def test_actual_directory_rejects_links_writable_owner_and_replaced_open(self):
        access = self.accessor()
        good = meta(0, 8, stat.S_IFDIR | 0o700)
        for kind in ('link', 'writable', 'owner', 'replaced'):
            named = copy.copy(good); opened = copy.copy(good)
            if kind == 'link': named.st_mode = stat.S_IFLNK | 0o777
            if kind == 'writable': named.st_mode = stat.S_IFDIR | 0o722
            if kind == 'owner': named.st_uid = 1000
            if kind == 'replaced': opened.st_ino = 99
            with self.subTest(kind=kind), patch.object(q.os, 'open', side_effect=[10, 11]) as opening, \
                 patch.object(q.os, 'stat', return_value=named), patch.object(q.os, 'fstat', return_value=opened), patch.object(q.os, 'close'):
                with self.assertRaises(q.Refused): access.directory('/safe')
                self.assertEqual(opening.call_count, 2 if kind == 'replaced' else 1)

    def test_allowlisted_directory_diagnostic_identifies_unchanged_refusal_predicate(self):
        access = self.accessor()
        for failure in ('kind', 'owner', 'writable', 'identity'):
            named = meta(0, 8, stat.S_IFDIR | 0o700); opened = copy.copy(named)
            if failure == 'kind': named.st_mode = stat.S_IFLNK | 0o777
            if failure == 'owner': named.st_uid = 1000
            if failure == 'writable': named.st_mode = stat.S_IFDIR | 0o777
            if failure == 'identity': opened.st_ino = 99
            with self.subTest(failure=failure), patch.object(q.os, 'open', side_effect=[10, 11]), \
                 patch.object(q.os, 'stat', return_value=named), patch.object(q.os, 'fstat', return_value=opened), patch.object(q.os, 'close'):
                with self.assertRaises(q.Refused) as raised:
                    access.directory('/etc')
            d = raised.exception.diagnostic
            self.assertEqual(d['path'], '/etc'); self.assertEqual(d['pathClass'], 'fixed-input')
            self.assertEqual(d['category'], 'directory-metadata'); self.assertFalse(d['procPolicy'])
            field = dict(kind='kindMatches', owner='ownerRoot', writable='noGroupOrOtherWrite', identity='namedAndOpenedEqual')[failure]
            self.assertIs(d['checks'][field], False)
            self.assertEqual(d['identityDifferences'], ['inode'] if failure == 'identity' else [])
            self.assertEqual(d['stage'], 'opened-entry' if failure == 'identity' else 'named-entry')

    def test_diagnostics_cannot_emit_unlisted_paths_or_exception_text(self):
        bad = meta(1, mode=stat.S_IFLNK | 0o777)
        with self.assertRaises(q.Refused) as raised:
            q.require_metadata(False, 'file-metadata', '/root/.ssh/secret', 'regular-file', False, bad, limit=10)
        self.assertIsNone(raised.exception.diagnostic)
        fake = FakeAccess(); fake.read_bytes = 123
        fake.file = Mock(side_effect=PermissionError('SECRET RAW OS ERROR'))
        result = q.collect(fake)
        self.assertEqual(result['scans'][0]['stages'][1]['items'][0]['diagnostics'], []); self.assertIn('PermissionError', result['issues'])
        self.assertEqual(result['totalReadBytes'], 123); self.assertNotIn('SECRET', q.canonical(result).decode('ascii'))

    def test_file_metadata_diagnostic_is_preopen_and_path_allowlisted(self):
        access = self.accessor(); access.directory = Mock(return_value=10)
        info = meta(3); info.st_nlink = 2
        filename = q.APP + '/config.json'
        with patch.object(q.os, 'stat', return_value=info), patch.object(q.os, 'open') as opening, patch.object(q.os, 'close'):
            with self.assertRaises(q.Refused) as raised:
                access.read(filename, 10)
            opening.assert_not_called()
        d = raised.exception.diagnostic
        self.assertEqual(d['path'], filename); self.assertIs(d['checks']['singleLink'], False)
        self.assertEqual(d['limitBytes'], 10); self.assertIsNone(d['opened'])

    def test_diagnostic_allowlist_has_only_fixed_sources_and_closed_dynamic_names(self):
        for name in ('/proc/100/fd', q.JOURNAL + '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json',
                     q.PACKAGE_ROOTS[0] + '/cryptography-2.8.dist-info/METADATA'):
            self.assertIsNotNone(q.diagnostic_path_class(name))
        for name in ('/root/.ssh', '/proc/1/environ', '/proc/1/fd/3', '/root/other', q.PACKAGE_ROOTS[0] + '/other.dist-info/METADATA'):
            self.assertIsNone(q.diagnostic_path_class(name))

    def test_actual_fd_scan_inaccessible_disappearing_and_mutating_not_empty(self):
        device = meta(mode=stat.S_IFCHR | 0o600)
        for failure in (PermissionError, FileNotFoundError):
            access = self.accessor(); access.directory = Mock(return_value=10)
            with self.subTest(failure=failure), patch.object(q.os, 'listdir', return_value=['1']), \
                 patch.object(q.os, 'readlink', side_effect=failure), patch.object(q.os, 'close'):
                with self.assertRaises(failure): access._scan_fds(200, 10, device, [], [], 0)
        access = self.accessor(); access.directory = Mock(return_value=10)
        with patch.object(q.os, 'listdir', side_effect=[['1'], ['1', '2']]), patch.object(q.os, 'readlink', return_value='socket:[42]'), \
             patch.object(q.os, 'stat', return_value=meta()), patch.object(q.os, 'close'):
            with self.assertRaisesRegex(q.Refused, 'fd-inventory-changed'): access._scan_fds(200, 10, device, [], [], 0)
        with patch.object(q.os, 'listdir', return_value=['1']), patch.object(q.os, 'readlink', side_effect=['socket:[42]', 'socket:[43]']), \
             patch.object(q.os, 'stat', return_value=meta()), patch.object(q.os, 'close'):
            with self.assertRaisesRegex(q.Refused, 'fd-identity-changed'): access._scan_fds(200, 10, device, [], [], 0)
        changed = meta(); changed.st_ino += 1
        with patch.object(q.os, 'listdir', return_value=['1']), patch.object(q.os, 'readlink', return_value='socket:[42]'), \
             patch.object(q.os, 'stat', side_effect=[meta(), changed]), patch.object(q.os, 'close'):
            with self.assertRaisesRegex(q.Refused, 'fd-identity-changed'): access._scan_fds(200, 10, device, [], [], 0)
        growing_log = meta(1000); growing_log.st_mtime_ns += 1; growing_log.st_ctime_ns += 1
        with patch.object(q.os, 'listdir', return_value=['1']), patch.object(q.os, 'readlink', return_value='/var/log/fixed.log'), \
             patch.object(q.os, 'stat', side_effect=[meta(), growing_log]), patch.object(q.os, 'close'):
            access._scan_fds(200, 10, device, [], [], 0)
        owners, rows = [], [dict(inode=42, owners=[])]
        with patch.object(q.os, 'listdir', return_value=['1']), patch.object(q.os, 'readlink', return_value='socket:[42]'), \
             patch.object(q.os, 'stat', return_value=device), patch.object(q.os, 'close'):
            access._scan_fds(200, 10, device, rows, owners, 0)
            self.assertEqual(owners, [dict(pid=200, startTicks=10, fd=1)]); self.assertEqual(rows[0]['owners'], owners)

    def test_actual_guard_inventory_active_corrupt_unknown_or_changed_held(self):
        def run(kind, names, raw=b'{}', changed=False):
            access = self.accessor(); access.directory = Mock(return_value=10)
            access.read = Mock(return_value=(raw, q.metadata(meta(len(raw)))))
            with patch.object(q.os, 'fstat', return_value=meta(0, 8, stat.S_IFDIR | 0o700)), \
                 patch.object(q.os, 'listdir', side_effect=[names, names + ['foreign']] if changed else None,
                              return_value=names), patch.object(q.os, 'close'):
                return access.guard_directory(q.QUARANTINE if kind == 'quarantine' else q.JOURNAL, kind)
        self.assertEqual(run('quarantine', ['active.json'])['state'], 'held')
        for names, raw, changed in [(['foreign'], b'{}', False), (['active.json'], b'{', False), (['active.json'], b'{}', True)]:
            with self.subTest(names=names, changed=changed), self.assertRaises((q.Refused, ValueError)):
                run('quarantine', names, raw, changed)
        operation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        record = dict(schemaVersion=1, operationId=operation, nonce='a' * 64, profileSha256=q.OLD_PROFILE,
                      grantId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status='failed', remoteQuiescent=False, detail='fixed-failure')
        self.assertEqual(run('journal', [operation + '.json'], q.canonical(record))['state'], 'held')

    def test_dependency_presence_only_does_not_load_module_or_native_library(self):
        access = self.accessor(); access.directory = Mock(return_value=10)
        raw = b'Name: cryptography\nVersion: 2.8\n\nBODY NOT DISCLOSED\n'
        access.read = Mock(return_value=(raw, q.metadata(meta(len(raw)))))
        with patch.object(q.os, 'listdir', return_value=['cryptography-2.8.dist-info', 'unrelated']), \
             patch.object(q.os, 'stat', side_effect=lambda name, **_: meta(0, 8, stat.S_IFDIR | 0o700) if name.endswith('.dist-info') else meta()), \
             patch.object(q.os, 'close'):
            value = access.dependencies()
        self.assertEqual(value['roots'][0]['distributions'][0]['version'], '2.8')
        self.assertFalse(value['providerFunctionVerified'] or value['nativeLoaded'])
        self.assertNotIn('BODY', q.canonical(value).decode('ascii'))
        self.assertTrue(all(call.args[0].endswith('/METADATA') for call in access.read.call_args_list))

    def test_service_actual_process_wrong_prefix_not_just_declared_unit(self):
        access = self.accessor(); access.directory = Mock(return_value=10); access.read = Mock(return_value=(stat_bytes(), {}))
        def run(raw):
            stream = io.BytesIO(raw)
            with patch.object(q.os, 'readlink', side_effect=lambda n, **_: '/usr/bin/python3.6' if n == 'exe' else q.APP), \
                 patch.object(q.os, 'open', return_value=11), patch.object(q.os, 'fstat', return_value=meta()), \
                 patch.object(q.os, 'close'), patch.object(q.os, 'read', side_effect=lambda fd, n: stream.read(n)), \
                 patch.object(q.os, 'O_NOFOLLOW', 0x100, create=True):
                return access.service_process(200, ('-B', '-m', 'vision_app.board_agent'))
        self.assertTrue(run(b'python3\0-B\0-m\0vision_app.board_agent\0--config\0secret')['matchesExpectedPrefix'])
        self.assertFalse(run(b'python3\0-B\0-m\0evil.module\0')['matchesExpectedPrefix'])

    def test_service_outer_inner_startticks_change_is_an_item_refusal(self):
        access = self.accessor(); access.read = Mock(return_value=(stat_bytes(10), {}))
        access.service_process = Mock(return_value=dict(pid=200, startTicks=11, exe='/usr/bin/python3.6', cwd=q.APP,
            prefixSha256='a' * 64, matchesExpectedPrefix=True))
        props = dict((key, '') for key in q.PROPERTIES)
        props.update(MainPID='200', ActiveState='active', SubState='running', WorkingDirectory=q.APP,
                     FragmentPath='/etc/systemd/system/' + q.UNITS[0], NeedDaemonReload='no', Transient='no',
                     ExecStart='{ argv[]=' + q.APP + '/run.sh ; }')
        raw = '\n'.join(key + '=' + props[key] for key in q.PROPERTIES).encode('ascii')
        with patch.object(q, 'show_unit', return_value=raw):
            with self.assertRaisesRegex(q.Refused, 'service-instance-changed'): access.services((q.UNITS[0],))
        fake = FakeAccess(); original = fake.services
        def services(units):
            if units[0] == q.UNITS[0]: raise q.Refused('service-instance-changed')
            return original(units)
        fake.services = services; result = q.collect(fake)
        self.assertEqual(result['result'], 'held'); self.assertIn('service-instance-changed', result['issues'])
        self.assertTrue(all(s['stages'][4]['state'] == 'complete' for s in result['scans']))

    def test_bounded_show_only_fixed_unit_with_no_service_actions(self):
        child = Mock(); child.stdout.fileno.return_value = 7; child.wait.return_value = 0; child.poll.return_value = 0
        chunks = iter([b'ActiveState=active\n', b''])
        with patch.object(q.subprocess, 'Popen', return_value=child) as spawn, \
             patch.object(q.select, 'select', return_value=([7], [], [])), patch.object(q.os, 'read', side_effect=lambda *_: next(chunks)):
            self.assertEqual(q.show_unit(q.UNITS[0]), b'ActiveState=active\n')
            args, kwargs = spawn.call_args
            self.assertEqual(args[0][:3], ['/bin/systemctl', 'show', q.UNITS[0]])
            self.assertFalse(kwargs['shell']); self.assertEqual(kwargs['env'], q.SHOW_ENV)
        with self.assertRaises(q.Refused):
            q.show_unit('unrelated.service')

    def test_dependencies_missing_roots_are_not_ed25519_proof(self):
        access = self.accessor(); access.directory = Mock(side_effect=FileNotFoundError)
        value = access.dependencies()
        self.assertEqual([r['state'] for r in value['roots']], ['absent'] * 3)
        self.assertFalse(value['providerImported'] or value['providerFunctionVerified'] or value['ed25519Verified'])

    def test_incomplete_fd_scan_cannot_be_tolerated_as_unrelated_churn(self):
        access = self.accessor()
        access.read = Mock(side_effect=lambda p, *_a, **_k: (b'  sl local_address\n', {}) if '/net/' in p else (stat_bytes(), {}))
        access.directory = Mock(return_value=10)
        access._scan_fds = Mock(side_effect=FileNotFoundError)
        stream = io.BytesIO(b'sshd\0')
        with patch.object(q.os, 'getpid', return_value=100), patch.object(q.os, 'getppid', return_value=90), \
             patch.object(q.os, 'stat', return_value=meta()), patch.object(q.os, 'lstat', return_value=meta(mode=stat.S_IFCHR | 0o600)), \
             patch.object(q.os, 'listdir', return_value=['90', '100']), patch.object(q.os, 'readlink', return_value='/usr/sbin/sshd'), \
             patch.object(q.os, 'open', return_value=11), patch.object(q.os, 'fstat', return_value=meta()), patch.object(q.os, 'close'), \
             patch.object(q.os, 'read', side_effect=lambda _fd, n: stream.read(n)), patch.object(q.os, 'O_NOFOLLOW', 0x100, create=True):
            with self.assertRaisesRegex(q.Refused, 'incomplete-or-relevant-process-vanished'):
                access.census()

    def test_two_passes_preserve_core_and_never_traverse_unsafe_dependency_ancestor(self):
        fake = FakeAccess(); seen = []; original = fake.dependencies
        def deps(roots):
            seen.append(roots[0])
            if roots[0].startswith('/usr/local/'):
                bad = meta(4096, mode=stat.S_IFDIR | 0o2775)
                q.require_metadata(False, 'directory-metadata', '/usr/local/lib/python3.6', 'directory', False, bad)
            return original(roots)
        fake.dependencies = deps; value = q.collect(fake)
        self.assertEqual(value['result'], 'held'); self.assertFalse(value['stable']); self.assertTrue(value['relevantCoreStableObserved'])
        self.assertEqual(seen, [q.PACKAGE_ROOTS[0], q.PACKAGE_ROOTS[1]] * 2)
        for scan in value['scans']:
            self.assertTrue(all(scan['stages'][i]['state'] == 'complete' for i in (0, 1, 2, 3, 4, 6)))
            items = scan['stages'][5]['items']
            self.assertEqual(items[1]['state'], 'refused'); self.assertIsNone(items[1]['data'])
            self.assertEqual(items[2]['state'], 'not-attempted'); self.assertEqual(items[2]['blockedBy'], items[1]['id'])

    def test_global_budget_and_deadline_stop_all_remaining_inputs_without_retry(self):
        for error in ('aggregate-read-budget', 'collector-deadline', 'service-show-deadline'):
            fake = FakeAccess(); fake.file = Mock(side_effect=q.Refused(error))
            value = q.collect(fake)
            self.assertEqual(value['globalStop'], error); self.assertEqual(fake.file.call_count, 1)
            self.assertTrue(all(v['state'] == 'not-attempted' for stage in value['scans'][1]['stages'] for v in stage['items']))
            self.assertEqual(value['result'], 'held')

    def test_independent_service_issue_retained_when_another_stage_is_incomplete(self):
        fake = FakeAccess(); fake.file = Mock(side_effect=PermissionError)
        fake.values[0]['services'][0]['managerCurrent'] = False
        result = q.collect(fake)
        self.assertIn('PermissionError', result['issues']); self.assertIn('service-not-fixed-current', result['issues'])

    def test_untrusted_bootstrap_never_reads_device_or_inputs(self):
        fake = FakeAccess(); original = fake.bootstrap; fake.bootstrap = lambda: dict(original(), issues=['stdlib-origin-not-allowlisted'])
        fake.boot = Mock(side_effect=AssertionError('must not run'))
        value = q.collect(fake); fake.boot.assert_not_called()
        self.assertEqual(value['globalStop'], 'bootstrap-untrusted'); self.assertFalse(value['relevantCoreStableObserved'])

    def test_python36_sys_without_spec_requires_exact_imported_builtin_identity(self):
        value = python36_bootstrap_fixture()
        self.assertEqual(value['pythonVersion'], [3, 6, 9])
        self.assertEqual(value['issues'], [])
        self.assertEqual(next(v for v in value['origins'] if v['module'] == 'sys'),
                         dict(module='sys', kind='built-in', reportedOriginSha256=None, file=None))
        self.assertFalse(value['cryptographicAttestation']); self.assertFalse(value['transitiveOriginsVerified'])

    def test_python36_none_origin_rejects_replacement_and_conflicting_module_facts(self):
        for case in ('replacement', 'missing-builtin', 'wrong-name', 'conflicting-spec', 'none-origin-spec', 'file-origin', 'unrelated-none'):
            with self.subTest(case=case):
                value = python36_bootstrap_fixture(case)
                self.assertIn('stdlib-origin-not-allowlisted', value['issues'])
                bad = next(v for v in value['origins'] if v['module'] == ('json' if case == 'unrelated-none' else 'sys'))
                self.assertEqual(bad['kind'], 'untrusted')
                fake = FakeAccess(); fake.bootstrap = lambda: value
                fake.boot = Mock(side_effect=AssertionError('untrusted bootstrap must stop before input scans'))
                result = q.collect(fake); fake.boot.assert_not_called()
                self.assertEqual(result['globalStop'], 'bootstrap-untrusted'); self.assertEqual(result['result'], 'held')

    def test_python36_sys_compatibility_does_not_waive_independent_stage_failure(self):
        fake = FakeAccess(); fake.bootstrap = python36_bootstrap_fixture
        fake.file = Mock(side_effect=q.Refused('file-metadata'))
        value = q.collect(fake)
        self.assertEqual(value['bootstrap']['data']['issues'], [])
        self.assertGreater(fake.boot_reads, 0)
        self.assertEqual(value['result'], 'held'); self.assertIn('file-metadata', value['issues'])
        self.assertFalse(value['profileAdopted']); self.assertFalse(value['releaseAuthorized'])

    def test_python36_modulespec_none_origin_uses_actual_class_and_importer_identities(self):
        value = python36_modulespec_fixture()
        self.assertEqual(value['issues'], [])
        self.assertEqual(next(v for v in value['origins'] if v['module'] == 'sys'),
                         dict(module='sys', kind='built-in', reportedOriginSha256=None, file=None))
        self.assertFalse(value['cryptographicAttestation']); self.assertFalse(value['transitiveOriginsVerified'])

    def test_python36_modulespec_refuses_same_named_or_conflicting_runtime_objects(self):
        for case in ('spec-subclass', 'spec-lookalike', 'spec-loader-lookalike', 'sys-loader-lookalike', 'loader-instance',
                     'spec-name', 'spec-name-eq', 'spec-name-str-subclass', 'spec-origin-string-none', 'spec-origin-file', 'spec-origin-frozen', 'registry-sys-replaced',
                     'sys-name', 'no-sys-builtin', 'sys-file-none', 'sys-file-origin', 'bootstrap-replaced', 'bootstrap-missing',
                     'import-control-replaced', 'import-control-missing', 'import-control-not-builtin', 'import-control-file',
                     'not-frozen', 'replaced-frozen-lambda', 'captured-frozen-lookalike', 'bootstrap-sys-replaced', 'bootstrap-imp-replaced', 'export-spec-replaced',
                     'export-builtin-replaced', 'export-frozen-replaced', 'no-builtin-finder', 'no-frozen-finder', 'unrelated-none'):
            with self.subTest(case=case):
                value = python36_modulespec_fixture(case)
                self.assertIn('stdlib-origin-not-allowlisted', value['issues'])
                fake = FakeAccess(); fake.bootstrap = lambda: value; fake.boot = Mock(side_effect=AssertionError('must not scan'))
                result = q.collect(fake); fake.boot.assert_not_called()
                self.assertEqual(result['result'], 'held'); self.assertEqual(result['globalStop'], 'bootstrap-untrusted')

    def test_python36_modulespec_bootstrap_does_not_override_unsafe_ancestor_or_budget(self):
        for code in ('directory-metadata', 'aggregate-read-budget', 'collector-deadline'):
            with self.subTest(code=code):
                fake = FakeAccess(); fake.bootstrap = python36_modulespec_fixture
                fake.file = Mock(side_effect=q.Refused(code))
                value = q.collect(fake)
                self.assertEqual(value['bootstrap']['data']['issues'], [])
                self.assertGreater(fake.boot_reads, 0); self.assertEqual(value['result'], 'held')
                self.assertIn(code, value['issues']); self.assertFalse(value['releaseAuthorized'])

    def test_actual_bootstrap_flags_and_unlisted_origin_never_fallback(self):
        access = self.accessor(); access.bootstrap_metadata = Mock(side_effect=lambda p, **_: dict(path=p, metadata=dict(q.metadata(meta()), fileType=stat.S_IFREG), linkTarget=None))
        flags = types.SimpleNamespace(isolated=1, no_site=1, dont_write_bytecode=1, ignore_environment=1, no_user_site=1)
        modules = dict((n, types.SimpleNamespace(__spec__=types.SimpleNamespace(origin='built-in'))) for n in q.BOOTSTRAP_MODULES)
        modules['json'].__file__ = '/root/.ssh/secret-origin'
        with patch.object(q.sys, 'flags', flags), patch.object(q.sys, 'executable', '/usr/bin/python3'), \
             patch.object(q.sys, 'version_info', (3, 6, 15)), patch.object(q.sys, 'modules', modules):
            value = access.bootstrap()
        self.assertIn('stdlib-origin-not-allowlisted', value['issues']); self.assertNotIn('secret-origin', q.canonical(value).decode())
        self.assertTrue(all(call.args[0] in ('/usr/bin/python3', '/usr/bin/python3.6') for call in access.bootstrap_metadata.call_args_list))
        flags.no_site = 0
        with patch.object(q.sys, 'flags', flags): self.assertIn('isolated-bootstrap-flags-required', access.bootstrap()['issues'])


if __name__ == '__main__':
    unittest.main()
