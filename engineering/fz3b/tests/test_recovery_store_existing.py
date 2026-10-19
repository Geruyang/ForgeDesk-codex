"""No-create opening over real local files with an explicit POSIX syscall model.

Windows cannot prove Linux flock/dirfd semantics. The model tests control flow,
metadata and raced namespace identities; the conditional native test is separate.
"""
import ast
import importlib.util
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import types
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / 'tools' / 'recovery_quarantine.py'
SPEC = importlib.util.spec_from_file_location('existing_store_core', str(SOURCE))
CORE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CORE)


class PosixModel(object):
    """Real bytes/inodes and mutations, modeled ownership/modes/dirfds/flock."""
    O_RDONLY, O_RDWR, O_CREAT, O_EXCL = os.O_RDONLY, os.O_RDWR, os.O_CREAT, os.O_EXCL
    O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY = 0x10000000, 0x20000000, 0x40000000

    def __init__(self, root):
        self.root, self.handles, self.serial = root, {}, 100000
        self.opens, self.closed, self.locks = [], [], []
        self.modes, self.owners, self.race = {}, {}, None
        self.missing, self.symlinks = set(), set()
        self.fail_lock = False

    def path(self, name, parent=None):
        if parent is not None:
            return self.handles[parent]['path'] / name
        return self.root / str(name).lstrip('/')

    def metadata(self, value, path):
        attrs = {key: getattr(value, key) for key in (
            'st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns',
            'st_mode', 'st_uid', 'st_gid', 'st_nlink')}
        kind = stat.S_IFMT(value.st_mode)
        attrs['st_mode'] = kind | self.modes.get(path, 0o700 if stat.S_ISDIR(value.st_mode) else 0o600)
        attrs['st_uid'], attrs['st_gid'] = self.owners.get(path, (0, 0))
        return types.SimpleNamespace(**attrs)

    def open(self, name, flags, mode=0o777, dir_fd=None):
        if flags & (self.O_CREAT | self.O_EXCL):
            raise AssertionError('open_existing attempted creation')
        path = self.path(name, dir_fd)
        self.opens.append((path, flags))
        if self.race is not None:
            self.race(path, flags)
        info = path.lstat()
        if path in self.symlinks or stat.S_ISLNK(info.st_mode):
            raise OSError('modeled O_NOFOLLOW')
        if flags & self.O_DIRECTORY:
            if not stat.S_ISDIR(info.st_mode):
                raise NotADirectoryError(str(path))
            native = None
        else:
            native = os.open(str(path), os.O_RDWR if flags & self.O_RDWR else os.O_RDONLY)
        self.serial += 1
        self.handles[self.serial] = {'path': path, 'native': native, 'initial': info}
        return self.serial

    def fstat(self, fd):
        item = self.handles[fd]
        info = os.fstat(item['native']) if item['native'] is not None else item['initial']
        value = self.metadata(info, item['path'])
        # Windows fstat creation-time caching differs from POSIX ctime. The
        # modeled timestamp uses the named inode only when its identity matches;
        # held inode and size still come from the real open file descriptor.
        if item['native'] is not None and item['path'].exists():
            named = item['path'].lstat()
            if (named.st_dev, named.st_ino) == (info.st_dev, info.st_ino):
                value.st_mtime_ns, value.st_ctime_ns = named.st_mtime_ns, named.st_ctime_ns
        return value

    def stat(self, name, dir_fd=None, follow_symlinks=False):
        path = self.path(name, dir_fd)
        if path in self.missing:
            raise FileNotFoundError(str(path))
        if path in self.symlinks:
            value = self.metadata(path.lstat(), path)
            value.st_mode = stat.S_IFLNK | 0o600
            return value
        return self.metadata(path.stat() if follow_symlinks else path.lstat(), path)

    def close(self, fd):
        item = self.handles.pop(fd)
        if item['native'] is not None:
            os.close(item['native'])
        self.closed.append(fd)

    def dup(self, fd):
        item = self.handles[fd]
        self.serial += 1
        self.handles[self.serial] = dict(item, native=os.dup(item['native']) if item['native'] is not None else None)
        return self.serial

    def flock(self, fd, flags):
        self.locks.append((self.handles[fd]['path'], flags))
        if self.fail_lock:
            raise BlockingIOError('modeled foreign lock')

    def mkdir(self, *_args, **_kwargs):
        raise AssertionError('open_existing attempted mkdir')

    def getuid(self):
        return 0

    geteuid = getuid

    def listdir(self, fd):
        return os.listdir(self.handles[fd]['path'])

    def read(self, fd, count):
        return os.read(self.handles[fd]['native'], count)


class ExistingStoreTests(unittest.TestCase):
    def setUp(self):
        parent = SOURCE.parents[3] / 'output' / 'qa' / '2026-10-17-fz3b-recovery'
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='existing-store-model-', dir=str(parent))
        self.root = Path(self.temp.name)
        self.app = self.root / 'app'
        self.product, self.guard = self.app / CORE.PRODUCT, self.app / CORE.DIRECTORY
        self.product.mkdir(parents=True)
        self.guard.mkdir()
        (self.product / 'active.lock').write_bytes(b'')
        (self.guard / 'admission.lock').write_bytes(b'')
        self.fs = PosixModel(self.root)
        self.fcntl = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, LOCK_UN=8, flock=self.fs.flock)
        self.patches = [mock.patch.object(CORE, 'os', self.fs), mock.patch.object(CORE, 'APP', '/app'),
                        mock.patch.object(CORE, 'sys', types.SimpleNamespace(platform='linux')),
                        mock.patch.dict(sys.modules, {'fcntl': self.fcntl})]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for fd in list(self.fs.handles):
            self.fs.close(fd)
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def denied(self):
        with self.assertRaises((OSError, CORE.GuardError)):
            CORE.SecureStore.open_existing()
        self.assertEqual(self.fs.handles, {})

    def test_existing_open_holds_product_before_guard_and_closes_without_creation(self):
        with CORE.SecureStore.open_existing() as store:
            self.assertEqual(store.snapshot(), {})
            self.assertEqual(self.fs.locks, [(self.product / 'active.lock', 6)])
            self.assertTrue(store.product_lock in self.fs.handles)
            self.assertTrue(store.admission in self.fs.handles)
            guard_index = next(i for i, item in enumerate(self.fs.opens) if item[0] == self.guard)
            self.assertLess(next(i for i, item in enumerate(self.fs.opens) if item[0] == self.product / 'active.lock'), guard_index)
        self.assertEqual(self.fs.handles, {})

    def test_absent_paths_are_never_reprovisioned(self):
        for path in (self.guard / 'admission.lock', self.guard, self.product / 'active.lock', self.product, self.app):
            with self.subTest(path=str(path)):
                if path.is_dir():
                    shutil.rmtree(str(path))
                elif path.exists():
                    path.unlink()
                self.denied()
                self.assertFalse(path.exists())

    def test_missing_guard_after_product_acquired_is_not_created(self):
        def race(path, _flags):
            if path == self.guard:
                shutil.rmtree(str(path))
        self.fs.race = race
        self.denied()
        self.assertFalse(self.guard.exists())

    def test_admission_delete_after_stat_does_not_create_new_lock(self):
        admission = self.guard / 'admission.lock'
        self.fs.race = lambda path, _flags: admission.unlink() if path == admission else None
        self.denied()
        self.assertFalse(admission.exists())

    def test_replacement_lock_between_stat_and_open_is_rejected(self):
        for path in (self.product / 'active.lock', self.guard / 'admission.lock'):
            with self.subTest(path=str(path)):
                def race(actual, _flags):
                    if actual == path:
                        self.fs.race = None
                        path.rename(path.with_name(path.name + '.old'))
                        path.write_bytes(b'')
                self.fs.race = race
                self.denied()

    def test_replacement_guard_after_open_is_rejected_by_final_identity_check(self):
        def race(path, _flags):
            if path == self.guard / 'admission.lock':
                self.fs.race = None
                self.guard.rename(self.app / 'old-guard')
                self.guard.mkdir()
                path.write_bytes(b'')
        self.fs.race = race
        self.denied()

    def test_lock_metadata_root_mode_size_and_hardlink_are_strict(self):
        lock = self.guard / 'admission.lock'
        for mutation in ('mode', 'owner', 'size', 'hardlink'):
            with self.subTest(mutation=mutation):
                if mutation == 'mode': self.fs.modes[lock] = 0o660
                if mutation == 'owner': self.fs.owners[lock] = (0, 50)
                if mutation == 'size': lock.write_bytes(b'x')
                if mutation == 'hardlink': os.link(str(lock), str(self.guard / 'linked'))
                self.denied()
                self.fs.modes.clear(); self.fs.owners.clear()
                lock.write_bytes(b'')
                linked = self.guard / 'linked'
                if linked.exists(): linked.unlink()

    def test_directory_mode_and_unknown_stat_failure_close_all_handles(self):
        self.fs.modes[self.guard] = 0o750
        self.denied()
        self.fs.modes.clear()
        self.fs.race = lambda path, _flags: (_ for _ in ()).throw(PermissionError('unknown')) if path == self.guard else None
        self.denied()

    def test_foreign_product_lock_stops_before_guard_open(self):
        self.fs.fail_lock = True
        self.denied()
        self.assertFalse(any(path == self.guard for path, _flags in self.fs.opens))

    def test_nofollow_is_required_for_every_component_and_both_lock_leaves(self):
        for path in (self.app, self.product, self.guard, self.product / 'active.lock', self.guard / 'admission.lock'):
            with self.subTest(path=str(path)):
                self.fs.symlinks.add(path)
                self.denied()
                self.fs.symlinks.clear()
        self.assertTrue(all(flags & self.fs.O_NOFOLLOW for _path, flags in self.fs.opens))

    def test_supplied_fd_is_duplicated_checked_and_not_closed_by_store(self):
        fd = self.fs.open('/app/' + CORE.PRODUCT + '/active.lock', self.fs.O_RDONLY)
        with CORE.SecureStore.open_existing(fd) as store:
            self.assertNotEqual(store.product_lock, fd)
        self.assertIn(fd, self.fs.handles)
        other = self.fs.open('/app/' + CORE.DIRECTORY + '/admission.lock', self.fs.O_RDONLY)
        with self.assertRaises(CORE.GuardError): CORE.SecureStore.open_existing(other)
        self.assertEqual(set(self.fs.handles), {fd, other})

    def test_mutation_after_open_does_not_become_absent_compatibility(self):
        with CORE.SecureStore.open_existing() as store:
            # Windows denies actual unlink of this open FD. Model the Linux
            # namespace result explicitly; do not claim a native unlink test.
            self.fs.missing.add(self.guard / 'admission.lock')
            with self.assertRaises(FileNotFoundError): store.snapshot()

    def test_unknown_inventory_is_returned_to_existing_strict_parser_not_cleared(self):
        (self.guard / 'unexpected.json').write_bytes(b'{}')
        with CORE.SecureStore.open_existing() as store:
            records = store.snapshot()
            with self.assertRaises(CORE.GuardError): CORE.history_clear(records)
        self.assertTrue((self.guard / 'unexpected.json').exists())

    def test_source_no_create_path_or_constructor_call_and_python36_grammar(self):
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'), feature_version=(3, 6))
        method = next(node for cls in tree.body if isinstance(cls, ast.ClassDef) and cls.name == 'SecureStore'
                      for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == 'open_existing')
        names = [node.attr for node in ast.walk(method) if isinstance(node, ast.Attribute)]
        self.assertNotIn('mkdir', names)
        self.assertNotIn('O_CREAT', names)
        self.assertNotIn('O_EXCL', names)
        self.assertNotIn('__init__', names)


if __name__ == '__main__':
    unittest.main(verbosity=2)
