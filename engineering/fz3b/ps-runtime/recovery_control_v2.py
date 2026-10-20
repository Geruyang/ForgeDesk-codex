"""Unintegrated fixed recovery dispatcher; Python 3.6, no trial/runtime adapter.

Request hashes are structural bindings, never native/host acceptance authority.
The trusted SSH/main coordinator must supply that authority separately. Default
deployment has no provisioned binding/provider and fails before opening a store.
"""
import base64
import binascii
import ast
import contextlib
import copy
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import time


APP = '/root/fz3b-vision-console-20261009-001'
PROVISION = APP + '/.forgedesk-recovery-control-v2/binding.json'
REQUEST_LIMIT = 8192
OUTPUT_LIMIT = 65536
METHOD = 'fz3b-recovery-control-v2'
VERBS = ('begin', 'stage-terminal', 'finalize', 'publish-host-ack', 'read-history')
RECIPE = {'python': '/usr/bin/python3', 'flags': ['-I', '-B', '-'],
          'requestEncoding': 'canonical-base64-single-argv', 'sourceStdinOnly': True}
HEX = re.compile(r'[a-f0-9]{64}\Z')
BINDING_KEYS = ('sourceSha256', 'commandRecipeSha256', 'epochSha256', 'keyId')
PROVISION_KEYS = BINDING_KEYS + ('schemaVersion', 'method', 'appRoot', 'bootId', 'profileSha256',
                               'coreSha256', 'providerSha256', 'packageInitSha256')


class ControlError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise ControlError(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii') + b'\n'


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys), 'control-closed-schema')


def checked_hash(value):
    require(type(value) is str and HEX.fullmatch(value) is not None, 'control-hash')
    return value


def decode_request(raw, core):
    require(type(raw) is bytes and 0 < len(raw) <= REQUEST_LIMIT, 'control-request-budget')
    value = core.decode(raw)
    exact(value, ('schemaVersion', 'method', 'verb', 'runId', 'owner', 'activeSha256', 'binding', 'payload'))
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and value['method'] == METHOD,
            'control-request-purpose')
    require(type(value['verb']) is str and value['verb'] in VERBS, 'control-verb-unavailable')
    require(type(value['runId']) is str and core.RUN.fullmatch(value['runId']) is not None, 'control-run')
    core.checked_owner(value['owner']); core.hash_value(value['activeSha256'])
    exact(value['binding'], BINDING_KEYS)
    for name in BINDING_KEYS[:-1]: checked_hash(value['binding'][name])
    require(type(value['binding']['keyId']) is str and value['binding']['keyId'].startswith('ed25519-sha256:'), 'control-key-id')
    checked_hash(value['binding']['keyId'][len('ed25519-sha256:'):])
    fields = {'begin': ('intent',), 'stage-terminal': ('proof',),
              'finalize': ('accepted', 'freshObservation'), 'publish-host-ack': ('envelope',), 'read-history': ()}
    exact(value['payload'], fields[value['verb']])
    for child in value['payload'].values(): require(type(child) is dict, 'control-payload-object')
    return value


def decode_argv_request(argv, core):
    require(type(argv) in (list, tuple) and len(argv) == 1 and type(argv[0]) is str,
            'control-exact-argv')
    token = argv[0]
    require(0 < len(token) <= 4 * ((REQUEST_LIMIT + 2) // 3) and
            re.fullmatch(r'[A-Za-z0-9+/]*={0,2}', token) is not None, 'control-base64-budget')
    try: raw = base64.b64decode(token.encode('ascii'), validate=True)
    except (UnicodeError, ValueError, binascii.Error): raise ControlError('control-base64')
    require(base64.b64encode(raw).decode('ascii') == token, 'control-base64-canonical')
    return decode_request(raw, core)


def decode_stdin_request(stream, core):
    """Bounded parser for a future reviewed installed-source adapter, not CLI mode."""
    raw = stream.read(REQUEST_LIMIT + 1)
    return decode_request(raw, core)


class TrustedDispatcher(object):
    """Offline/trusted composition seam, not a native authorization service.

    open_store is owned composition, not request data. No request can choose a
    store, provider, file, command, source code or callback. Real trial/observer
    verbs are deliberately unavailable until their trusted adapters exist.
    """
    def __init__(self, core, verifier, binding, open_store, now_ms):
        require(type(verifier) is core.TrustedHostAckVerifier, 'control-trusted-verifier-required')
        exact(binding, BINDING_KEYS)
        for name in BINDING_KEYS[:-1]: checked_hash(binding[name])
        require(binding['keyId'] == verifier.key_id and binding['sourceSha256'] == verifier.finalize_source_sha256,
                'control-provider-binding')
        require(binding['commandRecipeSha256'] == core.digest(core.encode(RECIPE)), 'control-fixed-command-recipe')
        require(callable(open_store) and callable(now_ms), 'control-trusted-composition-required')
        self.core, self.verifier = core, verifier
        self._binding = copy.deepcopy(binding)
        self._open_store, self._now = open_store, now_ms

    def dispatch(self, raw):
        return self.dispatch_value(decode_request(raw, self.core))

    def dispatch_value(self, request):
        core = self.core
        # A dict API is still parsed through the same canonical byte budget/schema.
        request = decode_request(core.encode(request), core)
        require(core.same(request['binding'], self._binding), 'control-deployment-binding')
        verb, payload = request['verb'], request['payload']
        if verb == 'begin':
            intent = core.checked_intent(payload['intent'], self._now())
            require(intent['runId'] == request['runId'] and core.same(intent['owner'], request['owner']) and
                    core.digest(core.encode(intent)) == request['activeSha256'], 'control-intent-binding')
        with self._open_store() as store:
            guard = core.RecoveryGuard(store, now_ms=self._now, host_verifier=self.verifier)
            if verb != 'begin':
                values = guard.inventory(); raw_intent = values.get(request['runId'] + '.intent.json')
                require(raw_intent is not None and core.digest(raw_intent) == request['activeSha256'], 'control-stored-intent-binding')
                intent = core.checked_intent(core.decode(raw_intent))
                require(core.same(intent['owner'], request['owner']), 'control-stored-owner')
            if verb == 'begin': result = guard.begin(intent)
            elif verb == 'stage-terminal': result = guard.stage_terminal(request['owner'], request['activeSha256'], payload['proof'])
            elif verb == 'finalize': result = guard.finalize(request['owner'], request['activeSha256'], payload['accepted'], payload['freshObservation'])
            elif verb == 'publish-host-ack': result = guard.publish_host_ack(request['owner'], request['activeSha256'], payload['envelope'])
            else:
                if 'active.json' in values:
                    require(values['active.json'] == raw_intent, 'control-foreign-active')
                records = {name: base64.b64encode(raw).decode('ascii') for name, raw in values.items()
                           if name == 'active.json' or name.startswith(request['runId'] + '.')}
                result = {'schemaVersion': 1, 'method': 'fz3b-recovery-history-read-v2', 'runId': request['runId'],
                          'activeSha256': request['activeSha256'], 'owner': request['owner'], 'records': records,
                          'observationOnly': True, 'releaseAuthorized': False, 'automaticReplay': False}
            encoded = core.encode(result)
            require(len(encoded) <= OUTPUT_LIMIT, 'control-output-budget')
            return encoded


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def _read_root_owned_file(path, limit, private=False):
    """Fixed deployment paths only. No request field reaches this function."""
    require(sys.platform.startswith('linux') and os.geteuid() == 0, 'control-linux-root-required')
    descriptors, anchors = [], []
    try:
        parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); descriptors.append(parent)
        parts = path.strip('/').split('/')
        for part in parts[:-1]:
            require(part not in ('', '.', '..'), 'control-fixed-path')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent); descriptors.append(child)
            info = os.fstat(child)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == info.st_gid == 0 and not info.st_mode & 0o022,
                    'control-deployment-directory')
            anchors.append((parent, part, child))
            parent = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent); descriptors.append(fd)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and before.st_nlink == 1 and
                not before.st_mode & 0o022 and 0 <= before.st_size <= limit and
                (not private or stat.S_IMODE(before.st_mode) == 0o600), 'control-deployment-file')
        raw = bytearray()
        while len(raw) <= limit:
            part = os.read(fd, min(8192, limit + 1 - len(raw)))
            if not part: break
            raw.extend(part)
        named = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        require(len(raw) == before.st_size and _identity(before) == _identity(os.fstat(fd)) == _identity(named),
                'control-deployment-file-changed')
        for ancestor, name, held_fd in anchors:
            named_dir = os.stat(name, dir_fd=ancestor, follow_symlinks=False)
            held_dir = os.fstat(held_fd)
            require(stat.S_ISDIR(named_dir.st_mode) and named_dir.st_uid == named_dir.st_gid == 0 and
                    not named_dir.st_mode & 0o022 and (named_dir.st_dev, named_dir.st_ino) == (held_dir.st_dev, held_dir.st_ino),
                    'control-deployment-ancestor-changed')
        return bytes(raw)
    finally:
        for fd in reversed(descriptors): os.close(fd)


def build_deployed_dispatcher():
    """Fixed root-owned public provisioning; absent pins/provider fail closed.

    Provisioning is separate from this module; this function never creates a
    directory, lock, key, configuration or provider. No env/request fallback.
    """
    raw = _read_root_owned_file(PROVISION, REQUEST_LIMIT, private=True)
    # Parse only the fixed provisioning file; reject duplicate/noncanonical JSON.
    def pairs(items):
        value = {}
        for name, child in items:
            require(name not in value, 'control-provision-duplicate'); value[name] = child
        return value
    provision = json.loads(raw.decode('ascii'), object_pairs_hook=pairs)
    require(canonical(provision) == raw, 'control-provision-canonical'); exact(provision, PROVISION_KEYS)
    require(type(provision['schemaVersion']) is int and provision['schemaVersion'] == 1 and
            provision['method'] == 'fz3b-recovery-control-deployment-v2' and provision['appRoot'] == APP,
            'control-provision-purpose')
    for name in ('sourceSha256', 'commandRecipeSha256', 'epochSha256', 'profileSha256', 'coreSha256', 'providerSha256', 'packageInitSha256'):
        checked_hash(provision[name])
    require(provision['commandRecipeSha256'] == hashlib.sha256(canonical(RECIPE)).hexdigest(), 'control-provision-recipe')
    files = (('vision_app/__init__.py', 'packageInitSha256'),
             ('vision_app/recovery_quarantine_core.py', 'coreSha256'), ('vision_app/host_ack_crypto.py', 'providerSha256'))
    sources = {}
    for relative, field in files:
        module_raw = _read_root_owned_file(APP + '/' + relative, 131072)
        require(hashlib.sha256(module_raw).hexdigest() == provision[field], 'control-installed-source-pin')
        sources[relative] = module_raw
    initializer = ast.parse(sources['vision_app/__init__.py'].decode('utf-8'))
    for node in initializer.body:
        if isinstance(node, ast.Pass): continue
        require(isinstance(node, ast.Expr), 'control-package-initializer-not-inert')
        try: literal = ast.literal_eval(node.value)
        except (ValueError, TypeError, SyntaxError): raise ControlError('control-package-initializer-not-inert')
        require(type(literal) is str, 'control-package-initializer-not-inert')
    # This source runs in a fresh isolated interpreter; reject preloaded modules.
    names = ('vision_app', 'vision_app.recovery_quarantine_core', 'vision_app.host_ack_crypto')
    require(all(name not in sys.modules for name in names), 'control-module-preloaded')
    inserted = []
    try:
        # Execute only the three fixed, already pinned sources. Normal import can
        # prefer timestamp-valid .pyc; it would not attest the bytes checked above.
        # No request data, module name or path participates in this load.
        for name, (relative, _field) in zip(names, files):
            path = APP + '/' + relative
            spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=[APP + '/vision_app'] if name == 'vision_app' else None)
            require(spec is not None, 'control-fixed-module-spec')
            module = importlib.util.module_from_spec(spec)
            sys.modules[name] = module; inserted.append(name)
            exec(compile(sources[relative], path, 'exec', dont_inherit=True), module.__dict__)
        core, provider = sys.modules[names[1]], sys.modules[names[2]]
        for relative, field in files:
            require(hashlib.sha256(_read_root_owned_file(APP + '/' + relative, 131072)).hexdigest() == provision[field], 'control-installed-source-changed')
        require(core.APP == APP and core.BOOT == provision['bootId'] and core.PROFILE == provision['profileSha256'], 'control-installed-epoch')
        verifier = provider.build_deployed_host_verifier()
        binding = {name: provision[name] for name in BINDING_KEYS}
        @contextlib.contextmanager
        def open_store():
            # Keep existing anchors and product EX through the entire dispatch;
            # a separate precheck cannot prevent constructor reprovision races.
            with core.SecureStore.open_existing() as store: yield store
        return TrustedDispatcher(core, verifier, binding, open_store, lambda: int(time.time() * 1000))
    except BaseException:
        for name in reversed(inserted): sys.modules.pop(name, None)
        raise


def deployed_dispatch(argv):
    require(sys.argv[0] == '-' and sys.flags.isolated == 1 and sys.flags.dont_write_bytecode == 1,
            'control-fixed-source-command-required')
    dispatcher = build_deployed_dispatcher()
    return dispatcher.dispatch_value(decode_argv_request(argv, dispatcher.core))


if __name__ == '__main__':
    try:
        response = deployed_dispatch(sys.argv[1:])
        sys.stdout.buffer.write(response); sys.stdout.buffer.flush()
    except Exception:
        sys.stderr.write('FZ3B_RECOVERY_CONTROL_REFUSED\n')
        raise SystemExit(1)
