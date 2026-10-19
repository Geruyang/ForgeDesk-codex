"""Host-only preparation / fixed six-file PS v2-to-v2 reinstall (Python 3.6).

No service action, rollback, application import, device open or PL action exists
on the execution path. Root separately reviews and sends the emitted stdin.
"""
import sys
sys.dont_write_bytecode = True
import argparse
import ast
import base64
import hashlib
import importlib.util
import json
import os
import re
import stat
import types
import uuid

LEGACY_SHA = '9b0bf3212e10fd539872e8976814474edac0df4611655d8b01cafea8202b3a02'
LIFECYCLE_SHA = 'b05172f7ead79cfda5995a70c2d7800f5eb72eae104c0621d904bfeb6467a81b'
TRANSPORT_SHA = '3f37b68858edd15c74f1879174cd9caea8702473126e895bbeef64534ff3b515'
PRODUCT_GATE_SHA = 'c14b4604b4d18377865080d477cb5aa0d357829aca14c85d3be961d283be17aa'
INSPECTOR_GATE_SHA = '9c15a032ff912893824c3bc634551618bc39eab61790d7fb53e2dcc70bcca9d9'
INSPECTOR_GATE_SOURCE = 'output/hardware/2026-10-16-next/recovery/maintenance-check/maintenance_gate.py'
APPROVED_MANIFEST_SHA = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09'
APPROVED_TAR_SHA = 'ec405d018a85e8c4c5e463b61d7f4dc565d34924913a9d54a68a3ac4262ebee3'
BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
BACKUPS = '.forgedesk-ps-v2-reinstall-backups'
SOURCE_ROOT = 'output/hardware/2026-10-16-continuation/release-source-v2/PS'
BUNDLE_ROOT = 'output/hardware/2026-10-16-continuation/deployment-bundle-v2'
OUTPUT_ROOT = 'output/qa/2026-10-16-fz3b-051'
SOURCE_PINS = {
    'vision_app/board_agent.py': (40992, '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a'),
    'vision_app/camera.py': (4032, 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2'),
    'vision_app/image_boundary.py': (4678, '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057'),
    'vision_app/protocol.py': (9358, 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37'),
    'vision_app/upload_source.py': (2876, 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249'),
    'config.json': (575, 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2'),
}
TARGETS = ('vision_app/board_agent.py', 'vision_app/camera.py', 'vision_app/image_boundary.py',
           'vision_app/protocol.py', 'vision_app/upload_source.py', 'config.json')
RUN = re.compile(r'ps-v2-reinstall-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\Z')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _fixed_module(filename, pin, name):
    location = os.path.join(os.path.dirname(__file__), filename)
    with open(location, 'rb') as stream:
        raw = stream.read(128 * 1024 + 1)
    if sha(raw) != pin:
        raise ValueError('reviewed support source changed: ' + filename)
    spec = importlib.util.spec_from_file_location(name, location)
    module = importlib.util.module_from_spec(spec)
    # Execute the bytes just hashed, not a second path read or cached pyc.
    exec(compile(raw, location, 'exec'), module.__dict__)
    return module


LEGACY = globals().get('_REINSTALL_LEGACY') or _fixed_module('ps_security_transaction.py', LEGACY_SHA, 'reinstall_legacy')
LIFECYCLE = globals().get('_REINSTALL_LIFECYCLE') or _fixed_module('service_lifecycle.py', LIFECYCLE_SHA, 'reinstall_lifecycle')


def validate_request(request):
    LEGACY._exact_keys(request, ('schema', 'mode', 'run_id', 'boot_id', 'approved_manifest_sha256', 'expected_sha256', 'payloads'))
    if (type(request['schema']) is not int or request['schema'] != 1 or request['mode'] != 'reinstall-v2'
            or request['boot_id'] != BOOT or request['approved_manifest_sha256'] != APPROVED_MANIFEST_SHA
            or type(request['run_id']) is not str or RUN.fullmatch(request['run_id']) is None):
        raise ValueError('fixed reinstall request identity mismatch')
    LEGACY._exact_keys(request['expected_sha256'], TARGETS)
    if request['expected_sha256'] != dict((key, value[1]) for key, value in SOURCE_PINS.items()):
        raise ValueError('all six preimages must be the exact present v2 files')
    LEGACY._exact_keys(request['payloads'], LEGACY.PY_TARGETS)
    LEGACY.checked_payloads(request)
    return request


def safety_gate():
    access = LIFECYCLE.SystemAccess()
    access.check_environment()
    if access.read(LIFECYCLE.BOOT_PATH).decode('ascii').strip() != BOOT:
        raise RuntimeError('boot identity changed')
    if sha(access.read(LIFECYCLE.UNIT_PATH)) != LIFECYCLE.UNIT_SHA256:
        raise RuntimeError('unit identity changed')
    contract = LIFECYCLE.PROJECT + '/vision_app/semantic-contract.json'
    if sha(access.read(contract)) != LIFECYCLE.CONTRACT_SHA256:
        raise RuntimeError('contract identity changed')
    service = LIFECYCLE.checked_service(access.show(LIFECYCLE.UNIT))
    LIFECYCLE.clean_service(service, 'inactive')
    dependencies = LIFECYCLE.dependencies(access)
    scan = access.scan()
    if (scan.get('deviceOpened') is not False or scan.get('a0005Owners') != []
            or scan.get('listeners8765') != [] or scan.get('active8765') != []):
        raise RuntimeError('device or application TCP is not quiescent')
    audit = inspector_module().scan_inspectors()
    if (audit.get('completePass') is not True or audit.get('stdinInspectors') != []
            or audit.get('newPidsAtEnd') != [] or type(audit.get('selfExcluded')) is not dict
            or type(audit['selfExcluded'].get('pid')) is not int or audit['selfExcluded']['pid'] <= 0
            or type(audit['selfExcluded'].get('startTicks')) is not int or audit['selfExcluded']['startTicks'] < 0):
        raise RuntimeError('stdin process census is incomplete or not quiescent')
    return {'boot_id': BOOT, 'unit_sha256': LIFECYCLE.UNIT_SHA256, 'service': service,
            'dependencies': dependencies, 'scan': scan, 'processAudit': audit}


def inspector_source(raw):
    if sha(raw) != INSPECTOR_GATE_SHA:
        raise ValueError('reviewed process census source changed')
    tree = ast.parse(raw.decode('ascii'))
    selected = ('proc_stat', 'classify_prefix', 'ProcAccess', 'scan_inspectors')
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in selected]
    if tuple(node.name for node in nodes) != selected or any(not hasattr(node, 'end_lineno') for node in nodes):
        raise ValueError('process census definition selection changed')
    lines = raw.splitlines(keepends=True)
    prologue = (b'import re,os,errno,stat\nMAX_PROCESSES=16384\n'
                b'class LifecycleError(RuntimeError):\n    pass\n'
                b'def require(condition,code):\n    if not condition:\n        raise LifecycleError(code)\n')
    return prologue + b'\n'.join(b''.join(lines[node.lineno - 1:node.end_lineno]) for node in nodes)


def inspector_module():
    module = globals().get('_REINSTALL_INSPECTORS')
    if module is None:
        project = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
        source = inspector_source(_host_read(project, INSPECTOR_GATE_SOURCE, 128 * 1024))
        module = types.ModuleType('reinstall_inspectors')
        exec(compile(source, '<fixed-process-census>', 'exec'), module.__dict__)
        globals()['_REINSTALL_INSPECTORS'] = module
    return module


class ReinstallFS(LEGACY.SecureFS):
    def assert_product_root(self, product):
        own, held = os.fstat(self.appfd), os.fstat(product.app_fd)
        if (own.st_dev, own.st_ino) != (held.st_dev, held.st_ino):
            raise RuntimeError('product and PS filesystem anchors differ')

    def assert_fresh_run(self, run_id):
        self.assert_anchors()
        try:
            backupfd = self._directory(BACKUPS, self.appfd)
        except FileNotFoundError:
            return
        if stat.S_IMODE(os.fstat(backupfd).st_mode) != 0o700:
            raise RuntimeError('reinstall backup parent must have mode 700')
        try:
            os.stat(run_id, dir_fd=backupfd, follow_symlinks=False)
        except FileNotFoundError:
            return
        raise RuntimeError('reinstall run already exists')

    def open_run(self, run_id, create):
        if create is not True:
            raise ValueError('reinstall never resumes an existing backup run')
        self.assert_anchors()
        try:
            os.mkdir(BACKUPS, 0o700, dir_fd=self.appfd)
            os.fsync(self.appfd)
        except FileExistsError:
            pass
        backupfd = self._directory(BACKUPS, self.appfd)
        if stat.S_IMODE(os.fstat(backupfd).st_mode) != 0o700:
            raise RuntimeError('reinstall backup parent must have mode 700')
        self.chain.append((self.appfd, BACKUPS, os.fstat(backupfd)))
        os.mkdir(run_id, 0o700, dir_fd=backupfd)
        os.fsync(backupfd)
        self.runfd = self._directory(run_id, backupfd)
        if stat.S_IMODE(os.fstat(self.runfd).st_mode) != 0o700:
            raise RuntimeError('reinstall run must have mode 700')
        self.chain.append((backupfd, run_id, os.fstat(self.runfd)))

    def snapshot(self, path):
        parent, name = self._target(path)
        self.assert_anchors()
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        value = self.read_target(path)
        after = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if self._identity(before) != self._identity(after) or value is None:
            raise RuntimeError('target changed during identity snapshot')
        return value, self.identity_record(after)

    @staticmethod
    def identity_record(value):
        return {'dev': value.st_dev, 'ino': value.st_ino, 'bytes': value.st_size,
                'mtime_ns': str(value.st_mtime_ns), 'ctime_ns': str(value.st_ctime_ns),
                'mode': stat.S_IMODE(value.st_mode), 'uid': value.st_uid,
                'gid': value.st_gid, 'nlink': value.st_nlink}

    def artifact_identity(self, name):
        self.read_artifact(name)
        value = os.stat(name, dir_fd=self.runfd, follow_symlinks=False)
        self._regular(value, LEGACY.MAX_SOURCE)
        return self.identity_record(value)


def checked_snapshot(fs, path):
    value, identity = fs.snapshot(path)
    expected_bytes, expected_sha = SOURCE_PINS[path]
    expected_mode = 0o600 if path == 'config.json' else 0o644
    if (len(value[0]) != expected_bytes or sha(value[0]) != expected_sha
            or value[1:] != (expected_mode, 0, 0) or identity['nlink'] != 1):
        raise RuntimeError('exact v2 preimage/metadata mismatch: ' + path)
    return value, identity


def product_lease():
    module = globals().get('_REINSTALL_PRODUCT_GATE') or _fixed_module('recovery_051_product_gate.py', PRODUCT_GATE_SHA, 'reinstall_product_gate')
    return module.ProductLease()


def execute_request(request, fs_factory=ReinstallFS, gate=safety_gate, product_factory=product_lease):
    fs = None
    product = None
    result = {'mode': 'reinstall-v2', 'status': 'failed', 'attemptedTargetCount': 0, 'replacedTargetCount': 0,
              'service_lifecycle_changed': False, 'hardware_accessed': False, 'application_started': False,
              'automatic_rollback': False, 'new_pl_built': False, 'entries': [], 'checks': [],
              'inspectorGateSha256': INSPECTOR_GATE_SHA,
              'productGateSha256': PRODUCT_GATE_SHA, 'productGateChecks': [], 'productLockFileModified': False, 'productLeaseClosed': False}
    def checked_gate():
        proof = product.recheck()
        if (type(proof) is not dict or proof.get('productLeaseHeldReadOnly') is not True
                or proof.get('unknownCleared') is not False or len(LEGACY.json_bytes(proof)) > 32768):
            raise RuntimeError('product lease proof invalid')
        result['productGateChecks'].append(proof)
        check = gate()
        if result['checks']:
            first = result['checks'][0]
            if any(check.get(key) != first.get(key) for key in ('boot_id', 'unit_sha256', 'service', 'dependencies')):
                raise RuntimeError('boot, unit, service or dependency identity changed')
            if check.get('processAudit', {}).get('selfExcluded') != first.get('processAudit', {}).get('selfExcluded'):
                raise RuntimeError('process census self identity changed')
        result['checks'].append(check)
    try:
        validate_request(request)
        result['run_id'] = request['run_id']
        product = product_factory()
        product.__enter__()
        checked_gate()
        fs = fs_factory()
        fs.assert_product_root(product)
        fs.assert_fresh_run(request['run_id'])
        originals = dict((key, checked_snapshot(fs, key)) for key in TARGETS)
        payloads = LEGACY.checked_payloads(request)
        # Config is never serialized or supplied by the host. Its exact current bytes are restaged.
        payloads['config.json'] = originals['config.json'][0][0]
        config = LEGACY.load_json(payloads['config.json'], LEGACY.MAX_CONFIG)
        if type(config) is not dict or config.get('bind') != '127.0.0.1':
            raise ValueError('current pinned config must bind IPv4 loopback')
        manifest = {'schema': 2, 'method': 'exact-ps-v2-reinstall', 'run_id': request['run_id'], 'boot_id': BOOT,
                    'app': LEGACY.APP, 'unit': LEGACY.UNIT, 'approved_manifest_sha256': APPROVED_MANIFEST_SHA,
                    'legacy_source_sha256': LEGACY_SHA, 'lifecycle_source_sha256': LIFECYCLE_SHA,
                    'product_gate_source_sha256': PRODUCT_GATE_SHA, 'inspector_gate_source_sha256': INSPECTOR_GATE_SHA, 'entries': []}
        for index, key in enumerate(TARGETS):
            value, identity = originals[key]
            manifest['entries'].append({'path': key, 'old_sha256': SOURCE_PINS[key][1], 'new_sha256': SOURCE_PINS[key][1],
                                        'bytes': len(value[0]), 'backup': str(index) + '.original', 'before': identity})
        raw_manifest = LEGACY.json_bytes(manifest)
        seal = {'schema': 2, 'mode': 'reinstall-v2', 'run_id': request['run_id'], 'manifest_sha256': sha(raw_manifest)}
        result.update(manifest_sha256=sha(raw_manifest), manifest=manifest, backup_directory=LEGACY.APP + '/' + BACKUPS + '/' + request['run_id'])
        fs.acquire_lock(seal)
        checked_gate()
        for key in TARGETS:
            if checked_snapshot(fs, key) != originals[key]:
                raise RuntimeError('preimage identity changed while acquiring lease')
        fs.open_run(request['run_id'], True)
        stages = {}
        for index, key in enumerate(TARGETS):
            value, _ = originals[key]
            fs.write_artifact(str(index) + '.original', value[0])
            fs.write_artifact(str(index) + '.staged', payloads[key], value[1], value[2], value[3])
            if (fs.read_artifact(str(index) + '.original') != value[0]
                    or fs.read_artifact(str(index) + '.staged') != payloads[key]):
                raise RuntimeError('backup/stage verification failed')
            stages[key] = fs.artifact_identity(str(index) + '.staged')
        fs.write_artifact('manifest.json', raw_manifest)
        if fs.read_artifact('manifest.json', LEGACY.MAX_MANIFEST) != raw_manifest:
            raise RuntimeError('manifest verification failed')
        for key in TARGETS:
            if checked_snapshot(fs, key) != originals[key]:
                raise RuntimeError('preimage identity changed before commit')
        for index, key in enumerate(TARGETS):
            checked_gate()
            if checked_snapshot(fs, key) != originals[key]:
                raise RuntimeError('target changed immediately before replacement')
            if sha(fs.read_artifact(str(index) + '.staged')) != SOURCE_PINS[key][1]:
                raise RuntimeError('stage changed immediately before replacement')
            result['attemptedTargetCount'] += 1
            fs.replace(key, str(index) + '.staged')
            _, after = checked_snapshot(fs, key)
            if ((after['dev'], after['ino']) != (stages[key]['dev'], stages[key]['ino'])
                    or (after['dev'], after['ino']) == (originals[key][1]['dev'], originals[key][1]['ino'])):
                raise RuntimeError('replacement inode identity unconfirmed')
            result['entries'].append({'path': key, 'sha256': SOURCE_PINS[key][1], 'before': originals[key][1], 'after': after})
            result['replacedTargetCount'] += 1
        checked_gate()
        for key in TARGETS:
            _, final = checked_snapshot(fs, key)
            if (final['dev'], final['ino']) != (stages[key]['dev'], stages[key]['ino']):
                raise RuntimeError('final replacement identity changed')
        if result['replacedTargetCount'] != 6:
            raise RuntimeError('all six explicit replacements are required')
        fs.release_lock(seal)
        result['status'] = 'reinstalled-v2'
    except Exception as error:
        # Equal old/new bytes do not establish rename ownership or success.
        result['status'] = 'unknown' if fs is not None and (fs.lock_retained or fs.lock_uncertain) else 'failed'
        result['error'] = str(error)[:500]
    finally:
        filesystem_closed = fs is None
        if fs is not None:
            try:
                fs.close()
                filesystem_closed = True
            except Exception as error:
                result.update(status='unknown', close_error=str(error)[:500])
        # If PS fd closure is unconfirmed, retain the product flock until the
        # interpreter exits rather than opening an earlier overlap window.
        if product is not None and filesystem_closed:
            try:
                product.close()
                result['productLeaseClosed'] = True
            except Exception as error:
                result.update(status='unknown', product_close_error=str(error)[:500])
    result['persistent_lock_retained'] = fs is not None and fs.lock_retained
    result['persistent_lock_uncertain'] = fs is not None and fs.lock_uncertain
    return result


def _host_plain(project, relative):
    filename = os.path.join(project, relative)
    current = os.path.abspath(project)
    if os.path.normcase(os.path.realpath(current)) != os.path.normcase(current):
        raise ValueError('host project root resolution changed')
    for component in relative.replace('\\', '/').split('/'):
        if component in ('', '.', '..'):
            raise ValueError('invalid host relative path')
        current = os.path.join(current, component)
        value = os.lstat(current)
        if stat.S_ISLNK(value.st_mode) or getattr(value, 'st_file_attributes', 0) & 1024:
            raise ValueError('host links/reparse points are forbidden')
    return filename


def _host_read(project, relative, limit):
    filename = _host_plain(project, relative)
    value = os.stat(filename)
    if not stat.S_ISREG(value.st_mode) or value.st_nlink != 1 or value.st_size > limit:
        raise ValueError('invalid host input')
    with open(filename, 'rb') as stream:
        before = os.fstat(stream.fileno())
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    named = os.lstat(filename)
    cross_named = LEGACY.SecureFS._identity(value)
    cross_fd = LEGACY.SecureFS._identity(before)
    if os.name == 'nt':
        # CPython Windows named-stat and fstat may report different ctime semantics.
        # Each API must still remain fully stable across the read.
        cross_named = cross_named[:4] + cross_named[5:]
        cross_fd = cross_fd[:4] + cross_fd[5:]
    if (len(raw) != value.st_size or cross_named != cross_fd
            or LEGACY.SecureFS._identity(before) != LEGACY.SecureFS._identity(after)
            or LEGACY.SecureFS._identity(value) != LEGACY.SecureFS._identity(named)):
        raise ValueError('host input changed during read')
    return raw


def prepare_bundle(run_id):
    if RUN.fullmatch(run_id) is None:
        raise ValueError('fresh UUID v4 reinstall run ID required')
    project = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
    approved = _host_read(project, BUNDLE_ROOT + '/manifest.json', LEGACY.MAX_MANIFEST)
    tar = _host_read(project, BUNDLE_ROOT + '/data.tar', 128 * 1024)
    if sha(approved) != APPROVED_MANIFEST_SHA or sha(tar) != APPROVED_TAR_SHA:
        raise ValueError('immutable v2 bundle byte seal mismatch')
    if sha(_host_read(project, 'engineering/fz3b/tools/ssh_script_receipt.mjs', 128 * 1024)) != TRANSPORT_SHA:
        raise ValueError('reviewed transport source changed')
    request = {'schema': 1, 'mode': 'reinstall-v2', 'run_id': run_id, 'boot_id': BOOT,
               'approved_manifest_sha256': APPROVED_MANIFEST_SHA,
               'expected_sha256': dict((key, value[1]) for key, value in SOURCE_PINS.items()), 'payloads': {}}
    for key in LEGACY.PY_TARGETS:
        raw = _host_read(project, SOURCE_ROOT + '/' + key, LEGACY.MAX_SOURCE)
        if len(raw) != SOURCE_PINS[key][0] or sha(raw) != SOURCE_PINS[key][1]:
            raise ValueError('frozen source differs from v2 pin')
        request['payloads'][key] = base64.b64encode(raw).decode('ascii')
    validate_request(request)
    prefix = b'import types\n'
    for name, filename, expected in (('_REINSTALL_LEGACY', 'ps_security_transaction.py', LEGACY_SHA),
                                     ('_REINSTALL_LIFECYCLE', 'service_lifecycle.py', LIFECYCLE_SHA),
                                     ('_REINSTALL_PRODUCT_GATE', 'recovery_051_product_gate.py', PRODUCT_GATE_SHA)):
        raw = _host_read(project, 'engineering/fz3b/tools/' + filename, 128 * 1024)
        if sha(raw) != expected:
            raise ValueError('support source byte seal mismatch')
        if b'\nif __name__ == ' in raw:
            raw = raw[:raw.index(b'\nif __name__ == ')]
        prefix += ("%s=types.ModuleType(%r)\nexec(compile(%r,%r,'exec'),%s.__dict__)\n" % (name, name, raw, filename, name)).encode('ascii')
    inspectors = inspector_source(_host_read(project, INSPECTOR_GATE_SOURCE, 128 * 1024))
    prefix += ("_REINSTALL_INSPECTORS=types.ModuleType('reinstall_inspectors')\nexec(compile(%r,'<fixed-process-census>','exec'),_REINSTALL_INSPECTORS.__dict__)\n" % inspectors).encode('ascii')
    source = _host_read(project, 'engineering/fz3b/tools/ps_v2_reinstall.py', 128 * 1024)
    body = source[:source.index(b'\nif __name__ == ')]
    trailer = ("\nREQUEST=" + repr(request) + "\nRESULT=execute_request(REQUEST)\nprint(json.dumps(RESULT,sort_keys=True,allow_nan=False))\nsys.exit(0 if RESULT['status']=='reinstalled-v2' else 2)\n").encode('ascii')
    script = prefix + body + trailer
    compile(script, '<reviewed-ps-v2-reinstall>', 'exec', dont_inherit=True)
    relative = OUTPUT_ROOT + '/' + run_id
    directory = os.path.join(project, relative)
    # OUTPUT_ROOT is pre-existing project evidence infrastructure; this fresh run may not be replaced.
    parent = _host_plain(project, OUTPUT_ROOT)
    if not stat.S_ISDIR(os.lstat(parent).st_mode):
        raise ValueError('evidence parent must be a plain directory')
    os.mkdir(directory, 0o700)
    _host_plain(project, relative)
    plan = {'schemaVersion': 1, 'method': 'host-maintenance-ps-v2-reinstall', 'runId': run_id, 'bootId': BOOT,
            'app': LEGACY.APP, 'unit': LEGACY.UNIT, 'approvedManifestSha256': APPROVED_MANIFEST_SHA,
            'approvedTarSha256': APPROVED_TAR_SHA, 'toolSha256': sha(source), 'legacySha256': LEGACY_SHA,
            'lifecycleSha256': LIFECYCLE_SHA, 'stdinFile': relative + '/stdin.py', 'stdinSha256': sha(script),
            'transportSha256': TRANSPORT_SHA,
            'productGateSha256': PRODUCT_GATE_SHA,
            'inspectorGateSha256': INSPECTOR_GATE_SHA,
            'requestFile': relative + '/request.json', 'requestSha256': sha(LEGACY.json_bytes(request)),
            'expectedSha256': request['expected_sha256'], 'requiresSeparateServiceStopStart': True,
            'automaticRollback': False, 'changesPL': False, 'executed': False}
    for name, raw in (('request.json', LEGACY.json_bytes(request)), ('stdin.py', script), ('plan.json', LEGACY.json_bytes(plan))):
        _host_plain(project, relative)
        with open(os.path.join(directory, name), 'xb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    return {'directory': relative, 'planSha256': sha(LEGACY.json_bytes(plan)), 'executed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', required=True, metavar='PS_V2_REINSTALL_UUID4_RUN_ID')
    args = parser.parse_args()
    print(json.dumps(prepare_bundle(args.prepare), sort_keys=True))
