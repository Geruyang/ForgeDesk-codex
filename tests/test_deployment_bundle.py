"""Offline fixtures only; no application, remote connection, or device operation."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import stat
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'engineering/fz3b/tools/prepare_deployment.py'
SPEC = importlib.util.spec_from_file_location('fz3b_prepare_deployment', TOOL)
bundle = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundle)
EVIDENCE = ROOT / 'output/hardware/2026-10-16-continuation/deployment-bundle-v2-fixtures'


def tar_bytes(files, mutate=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:', format=tarfile.USTAR_FORMAT) as archive:
        for index, (name, data) in enumerate(files):
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o644
            if mutate:
                mutate(info, index)
            archive.addfile(info, io.BytesIO(data) if info.isreg() else None)
    return stream.getvalue()


class DeploymentBundleTests(unittest.TestCase):
    def setUp(self):
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='fixture-', dir=EVIDENCE)
        self.root = Path(self.temporary.name)
        self.assertTrue(self.root.resolve().is_relative_to(EVIDENCE.resolve()))
        self.addCleanup(self.temporary.cleanup)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.original = {name: b'BASE = True\n' for name in bundle.PAYLOAD_PATHS if not name.endswith('image_boundary.py')}
        self.original.update({name: b'HOST = True\n' for name in bundle.NON_DEPLOYED_PATCHES})
        self.original.update({'PS/run.sh': b'#!/bin/sh\n', 'PS/services/pl-loader.service': b'[Service]\n', 'PS/vision_app/r5_start.py': b'R5 = True\n'})
        self.original['PS/config.example.json'] = b'{"bind":"0.0.0.0"}\n'
        for name, data in self.original.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        for name in bundle.PAYLOAD_PATHS:
            (self.source / name).write_bytes(b'{"bind":"127.0.0.1"}\n' if name.endswith('.json') else b'PATCHED = True\n')
        (self.source / 'HOST/vision_app/protocol.py').write_bytes(b'HOST_PATCHED = True\n')
        self.base = self.root / 'base.tar'
        self.base.write_bytes(tar_bytes(sorted(self.original.items())))
        self.pinned = mock.patch.object(bundle, 'BASE_ARCHIVE_SHA256', bundle.sha256(self.base.read_bytes()))
        self.pinned.start()
        self.addCleanup(self.pinned.stop)

    def build(self):
        output = self.root / 'package'
        result = bundle.build_bundle(self.source, self.base, output)
        return output, result

    def verify(self, output, expected=None):
        encoded = (output / 'manifest.json').read_bytes()
        return bundle.verify_bundle(output / 'manifest.json', output / 'data.tar', self.base, expected or bundle.sha256(encoded))

    def alter(self, output, change):
        path = output / 'manifest.json'
        value = json.loads(path.read_bytes())
        change(value)
        path.write_bytes(bundle._json_bytes(value))

    def replace_tar(self, output, data):
        (output / 'data.tar').write_bytes(data)
        self.alter(output, lambda value: value.update(bundle_sha256=bundle.sha256(data), bundle_bytes=len(data)))

    def test_round_trip_exact_six_data_files_and_blocked_gates(self):
        first_plan = bundle.prepare_plan(self.source, self.base)
        self.assertEqual(set(self.root.iterdir()), {self.source, self.base})
        output, result = self.build()
        self.assertEqual(result['manifest_sha256'], first_plan['manifest_sha256'])
        verified = self.verify(output, result['manifest_sha256'])
        self.assertEqual(verified['members'], list(bundle.PAYLOAD_PATHS))
        self.assertFalse(verified['deployment_authorized'])
        self.assertFalse(verified['deployed_base_verified'])
        plan = json.loads((output / 'deployment-plan.json').read_bytes())
        self.assertTrue(all(gate['status'] == 'unverified' for gate in plan['gates']))
        self.assertFalse(plan['network_transition']['public_udp_tcp_shutdown_authorized'])
        self.assertFalse(plan['config_example_auto_apply'])
        self.assertFalse(plan['pl_changes_permitted'])
        self.assertEqual(plan['remote_actions_performed'], [])
        manifest = json.loads((output / 'manifest.json').read_bytes())
        example = manifest['files'][0]
        self.assertEqual((example['role'], example['target']), ('reference-only', 'config.example.hardened.json'))
        added = next(entry for entry in manifest['files'] if entry['role'] == 'add')
        self.assertIsNone(added['base_sha256'])
        self.assertEqual(added['deployed_base_requirement'], 'must-not-exist')
        self.assertEqual(manifest['excluded_non_deployed_source_changes'], ['HOST/vision_app/protocol.py'])
        with tarfile.open(output / 'data.tar') as archive:
            self.assertEqual(archive.getnames(), list(bundle.PAYLOAD_PATHS))
            self.assertTrue(all(info.mode == 0o644 and info.uid == info.gid == info.mtime == 0 and info.isreg() for info in archive))

    def test_deterministic_tar_and_no_overwrite(self):
        output, result = self.build()
        other = self.root / 'other'
        next_result = bundle.build_bundle(self.source, self.base, other)
        self.assertEqual((output / 'data.tar').read_bytes(), (other / 'data.tar').read_bytes())
        self.assertEqual(result['manifest_sha256'], next_result['manifest_sha256'])
        with self.assertRaises(FileExistsError):
            bundle.build_bundle(self.source, self.base, output)

    def test_pinned_base_and_reviewed_manifest_are_required(self):
        output, result = self.build()
        with self.assertRaises(bundle.BundleError):
            self.verify(output, '0' * 64)
        with self.assertRaises(bundle.BundleError):
            self.verify(output, 'not-a-hash')
        self.base.write_bytes(self.base.read_bytes() + bytes(512))
        with self.assertRaisesRegex(bundle.BundleError, 'pinned upstream'):
            self.verify(output, result['manifest_sha256'])

    def test_outside_patch_source_changes_and_extra_credentials_are_rejected(self):
        for name in ('PS/run.sh', 'PS/services/pl-loader.service', 'PS/vision_app/r5_start.py'):
            with self.subTest(name=name):
                target = self.source / name
                target.write_bytes(b'changed\n')
                with self.assertRaises(bundle.BundleError):
                    bundle.prepare_plan(self.source, self.base)
                target.write_bytes(self.original[name])
        for name in ('secret.lic', '.runtime/auth.json', 'output/key', 'models/model.bin', 'PL/new.bit', 'PS/driver.ko'):
            with self.subTest(name=name):
                target = self.source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b'fixture-only')
                with self.assertRaises(bundle.BundleError):
                    bundle.prepare_plan(self.source, self.base)
                target.unlink()
                while target.parent != self.source and not any(target.parent.iterdir()):
                    target.parent.rmdir()
                    target = target.parent

    def test_source_hardlink_rejected(self):
        target = self.source / bundle.PAYLOAD_PATHS[1]
        original = target.read_bytes()
        backing = self.root / 'backing.py'
        backing.write_bytes(original)
        target.unlink()
        os.link(backing, target)
        with self.assertRaises(bundle.BundleError):
            bundle.prepare_plan(self.source, self.base)

    def test_source_symlink_and_reparse_metadata_rejected_without_privilege(self):
        for info in (SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0), SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)):
            path = mock.Mock()
            path.lstat.return_value = info
            with self.assertRaises(bundle.BundleError):
                bundle._no_link(path)

    def test_source_real_symlink_rejected_if_creation_is_available(self):
        backing = self.root / 'link-target.py'
        backing.write_bytes(b'FIXTURE = True\n')
        target = self.source / bundle.PAYLOAD_PATHS[1]
        target.unlink()
        try:
            target.symlink_to(backing)
        except OSError:
            self.skipTest('Windows symlink creation privilege unavailable; metadata and tar-link rejection covered independently')
        with self.assertRaises(bundle.BundleError):
            bundle.prepare_plan(self.source, self.base)

    def test_missing_invalid_python_public_bind_and_inline_secret_rejected(self):
        path = self.source / bundle.PAYLOAD_PATHS[1]
        path.unlink()
        with self.assertRaises(bundle.BundleError):
            bundle.prepare_plan(self.source, self.base)
        path.write_bytes(b'not python :=\x00')
        with self.assertRaises(bundle.BundleError):
            bundle.prepare_plan(self.source, self.base)
        path.write_bytes(b'OK = True\n')
        for data in (b'{"bind":"0.0.0.0"}', b'{"bind":"localhost"}', b'{"bind":2130706433}', b'{"bind":"127.0.0.1","token":"fixture"}', b'{"bind":"127.0.0.1","nested":{"auth":"fixture"}}', b'{"bind":"127.0.0.1","bind":"0.0.0.0"}'):
            (self.source / bundle.PAYLOAD_PATHS[0]).write_bytes(data)
            with self.assertRaises(bundle.BundleError):
                bundle.prepare_plan(self.source, self.base)

    def test_manifest_scope_and_base_new_hash_cannot_be_retargeted(self):
        output, _ = self.build()
        encoded = (output / 'manifest.json').read_bytes()
        mutations = [lambda value: value.update(unexpected=True), lambda value: value['files'][1].update(target='PL/firmware.bit'),
                     lambda value: value['files'][1].update(base_sha256='0' * 64), lambda value: value['files'][1].update(new_sha256='0' * 64),
                     lambda value: value['files'][0].update(role='replace', target='config.json'), lambda value: value['files'].pop(),
                     lambda value: value.update(excluded_non_deployed_source_changes=['PS/run.sh'])]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                (output / 'manifest.json').write_bytes(encoded)
                self.alter(output, mutation)
                with self.assertRaises(bundle.BundleError):
                    self.verify(output)

    def test_tar_traversal_links_duplicates_extra_and_modes_rejected(self):
        output, _ = self.build()
        payload = bundle._tar_entries((output / 'data.tar').read_bytes())
        normal = list(payload.items())
        malicious = [tar_bytes(normal + [(name, b'fixture')]) for name in ('../escape', '/absolute', 'C:/absolute', 'PS/../escape', 'PS\\vision_app\\board_agent.py', 'PS/secret.lic', 'PS/run.sh', 'PL/firmware.bit')]
        malicious += [tar_bytes(normal + [normal[0]])]
        for type_ in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME):
            def mutate(info, index, type_=type_):
                if index == 0:
                    info.type, info.linkname = type_, '../outside'
            malicious.append(tar_bytes(normal, mutate))
        for mode in (0o755, 0o777, 0o4644):
            malicious.append(tar_bytes(normal, lambda info, index, mode=mode: setattr(info, 'mode', mode)))
        malicious.append(tar_bytes(normal, lambda info, index: setattr(info, 'uid', 1000)))
        for data in malicious:
            with self.subTest(hash=bundle.sha256(data)):
                self.replace_tar(output, data)
                with self.assertRaises(bundle.BundleError):
                    self.verify(output)

    def test_tar_hidden_trailing_data_truncation_and_budgets_rejected(self):
        output, _ = self.build()
        data = (output / 'data.tar').read_bytes()
        for altered in (data + b'not data', data[:512], data + tar_bytes([('PS/secret.lic', b'fixture')]), bytes(bundle.MAX_TAR_BYTES + 512)):
            self.replace_tar(output, altered)
            with self.assertRaises(bundle.BundleError):
                self.verify(output)
        target = self.source / bundle.PAYLOAD_PATHS[1]
        target.write_bytes(b'#' * (bundle.MAX_FILE_BYTES + 1))
        with self.assertRaises(bundle.BundleError):
            bundle.prepare_plan(self.source, self.base)

    def test_source_change_during_preparation_is_rejected(self):
        original = bundle._data_tar
        def changed(payload):
            data = original(payload)
            (self.source / bundle.PAYLOAD_PATHS[1]).write_bytes(b'RACED = True\n')
            return data
        with mock.patch.object(bundle, '_data_tar', changed):
            with self.assertRaisesRegex(bundle.BundleError, 'changed during planning'):
                bundle.prepare_plan(self.source, self.base)

    def test_exact_git_comment_is_base_only_and_other_extended_metadata_rejected(self):
        data = self.base.read_bytes()
        comment = ('52 comment=' + bundle.UPSTREAM_COMMIT + '\n').encode('ascii')
        info = tarfile.TarInfo('pax_global_header')
        info.type, info.size = tarfile.XGLTYPE, len(comment)
        prefix = info.tobuf(format=tarfile.USTAR_FORMAT) + comment + bytes(-len(comment) % 512)
        self.assertEqual(bundle._tar_entries(prefix + data, base=True), self.original)
        with self.assertRaises(bundle.BundleError):
            bundle._tar_entries(prefix + data)
        wrong = prefix.replace(bundle.UPSTREAM_COMMIT.encode('ascii'), b'0' * 40)
        with self.assertRaises(bundle.BundleError):
            bundle._tar_entries(wrong + data, base=True)

    def test_v1_policy_is_rejected_even_with_a_recomputed_reviewed_hash(self):
        output, _ = self.build()
        self.alter(output, lambda manifest: manifest.update(policy='fz3b-ps-loopback-data-v1'))
        with self.assertRaisesRegex(bundle.BundleError, 'manifest policy'):
            self.verify(output)

    def test_non_payload_newlines_must_match_base_exactly(self):
        path = self.source / 'PS/vision_app/r5_start.py'
        path.write_bytes(self.original['PS/vision_app/r5_start.py'].replace(b'\n', b'\r\n'))
        with self.assertRaisesRegex(bundle.BundleError, 'outside the explicit'):
            bundle.prepare_plan(self.source, self.base)

    def test_frozen_payload_crlf_is_preserved_and_tampering_is_not_normalized(self):
        name = 'PS/vision_app/board_agent.py'
        data = b'PATCHED = True\r\nSECOND = 2\r\n'
        (self.source / name).write_bytes(data)
        output, _ = self.build()
        manifest = json.loads((output / 'manifest.json').read_bytes())
        entry = next(item for item in manifest['files'] if item['path'] == name)
        self.assertEqual(entry['base_sha256'], bundle.sha256(self.original[name]))
        self.assertEqual(entry['new_sha256'], bundle.sha256(data))
        payload = bundle._tar_entries((output / 'data.tar').read_bytes())
        self.assertEqual(payload[name], data)
        self.verify(output)
        payload[name] = data.replace(b'\r\n', b'\n')
        self.replace_tar(output, bundle._data_tar(payload))
        with self.assertRaisesRegex(bundle.BundleError, 'base/new hash'):
            self.verify(output)


if __name__ == '__main__':
    unittest.main(verbosity=2)
