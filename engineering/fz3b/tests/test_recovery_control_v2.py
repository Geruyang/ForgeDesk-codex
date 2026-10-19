"""Offline dispatcher tests. No deployed store, application, process or network."""
import ast
import base64
import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import sys
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'engineering/fz3b/ps-runtime/recovery_control_v2.py'
SPEC = importlib.util.spec_from_file_location('offline_recovery_control', str(SOURCE))
CONTROL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROL)
FIXTURE_SPEC = importlib.util.spec_from_file_location('offline_control_guard_fixture', str(ROOT / 'tests/test_recovery_quarantine.py'))
FIXTURE = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURE)
CORE = FIXTURE.Q
BLOCKED = []


def audit(event, _args):
    if event.startswith(('socket.', 'subprocess.', 'os.exec', 'os.spawn')) or event == 'os.system':
        BLOCKED.append(event)
        raise RuntimeError('Offline recovery control tests prohibit process/network execution')


sys.addaudithook(audit)


class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.store, self.opens = FIXTURE.MemoryStore(), 0
        self.intent = FIXTURE.intent()
        self.active = CORE.digest(CORE.encode(self.intent))
        self.binding = {'sourceSha256': '0' * 64, 'commandRecipeSha256': CORE.digest(CORE.encode(CONTROL.RECIPE)),
                        'epochSha256': 'f' * 64, 'keyId': 'ed25519-sha256:' + 'e' * 64}
        self.verifier = CORE.TrustedHostAckVerifier(self.binding['keyId'], self.binding['sourceSha256'], lambda _message, _signature: False)
        @contextlib.contextmanager
        def open_store():
            self.opens += 1
            yield self.store
        self.open_store = open_store
        self.dispatcher = CONTROL.TrustedDispatcher(CORE, self.verifier, self.binding, open_store, lambda: FIXTURE.NOW)

    def request(self, verb, payload):
        return {'schemaVersion': 1, 'method': CONTROL.METHOD, 'verb': verb, 'runId': self.intent['runId'],
                'owner': copy.deepcopy(self.intent['owner']), 'activeSha256': self.active,
                'binding': copy.deepcopy(self.binding), 'payload': payload}

    def dispatch(self, verb, payload):
        return CORE.decode(self.dispatcher.dispatch(CORE.encode(self.request(verb, payload))))

    def prepared(self):
        self.dispatch('begin', {'intent': self.intent})
        self.proof = FIXTURE.proof(self.intent, self.active)
        self.dispatch('stage-terminal', {'proof': self.proof})
        accepted = FIXTURE.acceptance(self.intent, self.active, self.proof)
        fresh = FIXTURE.fresh(self.intent, self.active)
        return self.dispatch('finalize', {'accepted': accepted, 'freshObservation': fresh})

    def test_real_core_begin_stage_finalize_and_explicit_host_ack_publication(self):
        receipt = self.prepared()
        self.assertEqual(receipt, CORE.prepared_release_receipt(self.intent, self.proof, self.store.files[self.intent['runId'] + '.commit.json']))
        self.assertTrue(receipt['logicalQuarantineRetained'])
        self.assertNotIn('active.json', self.store.files)
        with self.assertRaises(CORE.GuardError): CORE.history_clear(self.store.snapshot(), self.verifier)
        # Existing exact-message synthetic verifier contract only. Real crypto is
        # covered separately in test_host_ack_crypto.py, not claimed here.
        verifier, ack = FIXTURE.host_ack_fixture(self.intent, self.proof, self.store.snapshot())
        self.dispatcher = CONTROL.TrustedDispatcher(CORE, verifier, self.binding, self.open_store, lambda: FIXTURE.NOW)
        result = self.dispatch('publish-host-ack', {'envelope': ack})
        self.assertTrue(result['logicalQuarantineClear'])
        self.assertTrue(CORE.history_clear(self.store.snapshot(), verifier))
        before = self.store.snapshot()
        with self.assertRaises(CORE.GuardError): self.dispatch('publish-host-ack', {'envelope': ack})
        self.assertEqual(self.store.snapshot(), before)

    def test_trial_and_observer_verbs_are_unavailable_before_any_store_or_effect(self):
        for verb in ('trial-once', 'observe-terminal', 'exec', 'shell', 'force', 'approve', 'finalize;sh', '', None, True):
            with self.assertRaises((CONTROL.ControlError, CORE.GuardError)):
                self.dispatcher.dispatch(CORE.encode(self.request(verb, {})))
        self.assertEqual(self.opens, 0)
        self.assertEqual(self.store.actions, [])
        self.assertEqual(self.store.snapshot(), {})

    def test_closed_request_binding_rejects_every_field_tamper_before_store(self):
        good = self.request('begin', {'intent': self.intent})
        cases = []
        for name in good:
            changed = copy.deepcopy(good)
            changed[name] = True if name == 'schemaVersion' else 'foreign'
            cases.append(changed)
        for name in good['binding']:
            changed = copy.deepcopy(good); changed['binding'][name] = ('1' * 64 if name != 'keyId' else 'ed25519-sha256:' + '1' * 64)
            cases.append(changed)
        for name in ('path', 'command', 'source', 'provider', 'saved', 'verified', 'authorized', 'force'):
            changed = copy.deepcopy(good); changed[name] = True; cases.append(changed)
            changed = copy.deepcopy(good); changed['payload'][name] = True; cases.append(changed)
        for changed in cases:
            with self.assertRaises((CONTROL.ControlError, CORE.GuardError)):
                self.dispatcher.dispatch(CORE.encode(changed))
        self.assertEqual(self.opens, 0)
        self.assertEqual(self.store.snapshot(), {})

    def test_canonical_base64_and_bounded_stdin_use_same_core_parser(self):
        request = self.request('begin', {'intent': self.intent}); raw = CORE.encode(request)
        token = base64.b64encode(raw).decode('ascii')
        self.assertEqual(CONTROL.decode_argv_request([token], CORE), request)
        self.assertEqual(CONTROL.decode_stdin_request(io.BytesIO(raw), CORE), request)
        for argv in ([], [token, token], [token + '\n'], [' ' + token], ['!'], ['A'], ['a' * 20000], [b'not-text']):
            with self.assertRaises(CONTROL.ControlError): CONTROL.decode_argv_request(argv, CORE)
        for bad in (raw[:-1], b' ' + raw, raw.replace(b'"schemaVersion":1', b'"schemaVersion":1,"schemaVersion":1'),
                    b'x' * (CONTROL.REQUEST_LIMIT + 1), b'{}\n', raw.replace(b'"schemaVersion":1', b'"schemaVersion":true')):
            with self.assertRaises((CONTROL.ControlError, CORE.GuardError, ValueError)):
                CONTROL.decode_stdin_request(io.BytesIO(bad), CORE)
        self.assertEqual(self.opens, 0)

    def test_read_history_is_raw_exact_owner_bound_and_never_authorizes_release(self):
        self.prepared(); before = self.store.snapshot()
        result = self.dispatch('read-history', {})
        self.assertTrue(result['observationOnly']); self.assertFalse(result['releaseAuthorized'])
        self.assertFalse(result['automaticReplay'])
        self.assertEqual({name: base64.b64decode(raw) for name, raw in result['records'].items()}, before)
        self.assertEqual(self.store.snapshot(), before)
        foreign = self.request('read-history', {}); foreign['owner']['nonce'] = '2' * 64
        with self.assertRaises(CONTROL.ControlError): self.dispatcher.dispatch(CORE.encode(foreign))
        self.assertEqual(self.store.snapshot(), before)

    def test_wrong_owner_preimage_and_freshness_never_mutate_terminal_state(self):
        self.dispatch('begin', {'intent': self.intent})
        before = self.store.snapshot()
        proof = FIXTURE.proof(self.intent, self.active)
        for field, value in (('activeSha256', '0' * 64), ('owner', {'actor': 'independent-native-qa', 'generation': self.intent['owner']['generation'], 'nonce': '9' * 64})):
            request = self.request('stage-terminal', {'proof': proof}); request[field] = value
            with self.assertRaises((CONTROL.ControlError, CORE.GuardError)):
                self.dispatcher.dispatch(CORE.encode(request))
        proof['observation']['observedAt'] = '2026-10-16T00:00:00.000Z'
        with self.assertRaises(CORE.GuardError): self.dispatch('stage-terminal', {'proof': proof})
        self.assertEqual(self.store.snapshot(), before)

    def test_missing_or_lookalike_verifier_and_self_asserted_source_recipe_are_not_authority(self):
        for verifier in (None, True, types.SimpleNamespace(key_id=self.verifier.key_id, finalize_source_sha256='0' * 64, verify=lambda _a, _b: True)):
            with self.assertRaises(CONTROL.ControlError):
                CONTROL.TrustedDispatcher(CORE, verifier, self.binding, self.open_store, lambda: FIXTURE.NOW)
        for field in ('sourceSha256', 'commandRecipeSha256', 'keyId'):
            binding = dict(self.binding); binding[field] = '1' * 64
            with self.assertRaises(CONTROL.ControlError):
                CONTROL.TrustedDispatcher(CORE, self.verifier, binding, self.open_store, lambda: FIXTURE.NOW)
        self.assertEqual(self.opens, 0)

    def test_missing_provision_or_provider_fail_before_secure_store(self):
        with mock.patch.object(CONTROL, '_read_root_owned_file', side_effect=CONTROL.ControlError('fixture-unprovisioned')) as read:
            with mock.patch.object(CORE, 'SecureStore', side_effect=AssertionError('must not open a deployed store')):
                with self.assertRaises(CONTROL.ControlError): CONTROL.build_deployed_dispatcher()
            self.assertEqual(read.call_args[0][0], CONTROL.PROVISION)
        sources = {'vision_app/__init__.py': b'"""Inert offline fixture package."""\n',
                   'vision_app/recovery_quarantine_core.py': Path(FIXTURE.FILE).read_bytes(),
                   'vision_app/host_ack_crypto.py': (ROOT / 'engineering/fz3b/ps-runtime/host_ack_crypto.py').read_bytes()}
        provision = dict(self.binding, schemaVersion=1, method='fz3b-recovery-control-deployment-v2', appRoot=CONTROL.APP,
                         bootId=CORE.BOOT, profileSha256=CORE.PROFILE, coreSha256=CORE.digest(sources['vision_app/recovery_quarantine_core.py']),
                         providerSha256=CORE.digest(sources['vision_app/host_ack_crypto.py']), packageInitSha256=CORE.digest(sources['vision_app/__init__.py']))
        def read(path, _limit, private=False):
            return CORE.encode(provision) if path == CONTROL.PROVISION else sources[path[len(CONTROL.APP) + 1:]]
        # Compile only these actual public project sources, never deployment files
        # or a pyc cache. The real default provider has None pins and must refuse.
        with mock.patch.object(CONTROL, '_read_root_owned_file', side_effect=read):
            with self.assertRaisesRegex(ValueError, 'guard-host-public-key-unprovisioned'): CONTROL.build_deployed_dispatcher()
        self.assertTrue(all(name not in sys.modules for name in ('vision_app', 'vision_app.recovery_quarantine_core', 'vision_app.host_ack_crypto')))
        sources['vision_app/__init__.py'] = b'raise AssertionError("initializer must never execute")\n'
        provision['packageInitSha256'] = CORE.digest(sources['vision_app/__init__.py'])
        with mock.patch.object(CONTROL, '_read_root_owned_file', side_effect=read):
            with self.assertRaisesRegex(CONTROL.ControlError, 'initializer-not-inert'): CONTROL.build_deployed_dispatcher()
        self.assertEqual(self.opens, 0)

    def test_fixed_source_command_flags_are_structural_not_request_authority(self):
        request = self.request('begin', {'intent': self.intent})
        token = base64.b64encode(CORE.encode(request)).decode('ascii')
        for entry, isolated, no_bytecode in (('program.py', 1, 1), ('-', 0, 1), ('-', 1, 0)):
            with mock.patch.object(CONTROL.sys, 'argv', [entry, token]), \
                    mock.patch.object(CONTROL.sys, 'flags', types.SimpleNamespace(isolated=isolated, dont_write_bytecode=no_bytecode)), \
                    mock.patch.object(CONTROL, 'build_deployed_dispatcher', side_effect=AssertionError('wrong recipe must precede provision')):
                with self.assertRaises(CONTROL.ControlError): CONTROL.deployed_dispatch([token])
        self.assertEqual(self.opens, 0)
        with mock.patch.object(CONTROL.sys, 'argv', ['-', token]), \
                mock.patch.object(CONTROL.sys, 'flags', types.SimpleNamespace(isolated=1, dont_write_bytecode=1)), \
                mock.patch.object(CONTROL, 'build_deployed_dispatcher', return_value=self.dispatcher):
            response = CORE.decode(CONTROL.deployed_dispatch([token]))
        self.assertEqual(response['activeSha256'], self.active)
        self.assertEqual(self.opens, 1)

    def test_deployed_dispatch_uses_only_retained_existing_store_api_without_precheck_or_fallback(self):
        # Public local module fixtures only. Synthetic provider here is not a
        # deployment/crypto claim; this test observes the store composition call.
        provider_raw = b'''from . import recovery_quarantine_core as core
def build_deployed_host_verifier():
    return core.TrustedHostAckVerifier('ed25519-sha256:' + 'e' * 64, '0' * 64, lambda _message, _signature: False)
'''
        sources = {'vision_app/__init__.py': b'',
                   'vision_app/recovery_quarantine_core.py': Path(FIXTURE.FILE).read_bytes(),
                   'vision_app/host_ack_crypto.py': provider_raw}
        provision = dict(self.binding, schemaVersion=1, method='fz3b-recovery-control-deployment-v2', appRoot=CONTROL.APP,
                         bootId=CORE.BOOT, profileSha256=CORE.PROFILE, coreSha256=CORE.digest(sources['vision_app/recovery_quarantine_core.py']),
                         providerSha256=CORE.digest(provider_raw), packageInitSha256=CORE.digest(b''))
        def read(path, _limit, private=False):
            return CORE.encode(provision) if path == CONTROL.PROVISION else sources[path[len(CONTROL.APP) + 1:]]
        names = ('vision_app', 'vision_app.recovery_quarantine_core', 'vision_app.host_ack_crypto')
        events = []
        @contextlib.contextmanager
        def open_existing():
            events.append('entered')
            try: yield self.store
            finally: events.append('closed')
        original_create = self.store.create
        def checked_create(name, raw):
            self.assertEqual(events[-1], 'entered')
            return original_create(name, raw)
        try:
            with mock.patch.object(CONTROL, '_read_root_owned_file', side_effect=read) as reads, \
                    mock.patch.object(CONTROL.time, 'time', return_value=FIXTURE.NOW / 1000.0):
                dispatcher = CONTROL.build_deployed_dispatcher()
                deployed_core = dispatcher.core
                with mock.patch.object(deployed_core.SecureStore, '__init__', side_effect=AssertionError('provisioning constructor forbidden')) as provisioning, \
                        mock.patch.object(deployed_core.SecureStore, 'open_existing', side_effect=open_existing) as existing, \
                        mock.patch.object(self.store, 'create', side_effect=checked_create):
                    response = CORE.decode(dispatcher.dispatch(CORE.encode(self.request('begin', {'intent': self.intent}))))
                    self.assertEqual(response['activeSha256'], self.active)
                    self.assertEqual(events, ['entered', 'closed'])
                    existing.assert_called_once_with()
                    provisioning.assert_not_called()
                    before = self.store.snapshot()
                    existing.side_effect = FileNotFoundError('fixture anchor removed after composition')
                    with self.assertRaises(FileNotFoundError): dispatcher.dispatch(CORE.encode(self.request('read-history', {})))
                    self.assertEqual(self.store.snapshot(), before)
                    self.assertEqual(existing.call_count, 2)
                    provisioning.assert_not_called()
                # No read-close-reopen lock precheck remains in this caller.
                self.assertFalse(any(call.args[0].endswith(('/admission.lock', '/active.lock')) for call in reads.call_args_list))
        finally:
            for name in names: sys.modules.pop(name, None)

    def test_fixed_entry_flags_and_python36_grammar_no_runtime_imports(self):
        with mock.patch.object(CONTROL, 'build_deployed_dispatcher', side_effect=AssertionError('wrong launch must refuse before provision')):
            with self.assertRaises(CONTROL.ControlError): CONTROL.deployed_dispatch([])
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'), filename=str(SOURCE), feature_version=(3, 6))
        modules = [node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
        modules.extend(alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names)
        self.assertFalse(any(name and name.split('.')[0] in ('socket', 'subprocess', 'board_agent', 'board_runtime') for name in modules))
        self.assertEqual(BLOCKED, [])


if __name__ == '__main__':
    unittest.main()
