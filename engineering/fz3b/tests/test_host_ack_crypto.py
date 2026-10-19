"""Local real Ed25519 tests. Ephemeral fixture keys only; no device/SSH/App.

The Node interoperability case executes only local Node fixture subprocesses.
No private key bytes leave the fixture process or are persisted/output.
"""
import ast
import base64
import copy
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'engineering/fz3b/ps-runtime/host_ack_crypto.py'
FIXTURE_SPEC = importlib.util.spec_from_file_location('host_ack_guard_fixture', str(ROOT / 'tests/test_recovery_quarantine.py'))
FIXTURE = importlib.util.module_from_spec(FIXTURE_SPEC)
FIXTURE_SPEC.loader.exec_module(FIXTURE)
CORE = FIXTURE.Q
PACKAGE = types.ModuleType('host_ack_fixture_package')
PACKAGE.__path__ = []
sys.modules[PACKAGE.__name__] = PACKAGE
sys.modules[PACKAGE.__name__ + '.recovery_quarantine_core'] = CORE
SPEC = importlib.util.spec_from_file_location(PACKAGE.__name__ + '.host_ack_crypto', str(SOURCE))
CRYPTO = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CRYPTO)


def raw_public(key):
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000.0, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def prepared_fixture():
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    intent = FIXTURE.intent()
    intent['createdAt'], intent['approvalExpiresAt'] = iso(now - 60000), iso(now + 240000)
    store = FIXTURE.MemoryStore()
    guard = CORE.RecoveryGuard(store, lambda: now)
    active = guard.begin(intent)['activeSha256']
    proof = FIXTURE.proof(intent, active)
    def retime(observation, start):
        observation['scans'][0]['observedAt'] = iso(start)
        observation['scans'][1]['observedAt'] = iso(start + 100)
        observation['observedAt'] = iso(start + 200)
        return observation
    retime(proof['observation'], now - 10000)
    guard.stage_terminal(intent['owner'], active, proof)
    accepted = FIXTURE.acceptance(intent, active, proof)
    accepted['acceptedAt'] = iso(now - 8000)
    fresh = retime(FIXTURE.fresh(intent, active), now - 7000)
    receipt = guard.finalize(intent['owner'], active, accepted, fresh)
    return intent, proof, store.snapshot(), CORE.encode(receipt)


class HostAckCryptoTests(unittest.TestCase):
    def test_factory_pins_real_raw_public_key_and_rejects_wrong_key_message_signature(self):
        key = Ed25519PrivateKey.generate()
        public = raw_public(key)
        verifier = CRYPTO.build_host_verifier(public, 'd' * 64)
        self.assertIs(type(verifier), CORE.TrustedHostAckVerifier)
        self.assertEqual(verifier.key_id, 'ed25519-sha256:' + hashlib.sha256(public).hexdigest())
        message = CORE.ACK_DOMAIN + CORE.encode({'fixture': True})
        signature = key.sign(message)
        self.assertIs(verifier.verify(message, signature), True)
        for other_message, other_signature in ((message + b' ', signature), (message, signature[:-1]),
                                                (message, b'\0' * 64), (b'wrong-domain' + message, signature),
                                                (message.decode('ascii'), signature), (message, bytearray(signature))):
            self.assertIs(verifier.verify(other_message, other_signature), False)
        wrong = CRYPTO.build_host_verifier(raw_public(Ed25519PrivateKey.generate()), 'd' * 64)
        self.assertIs(wrong.verify(message, signature), False)

    def test_absent_provider_wrong_pin_and_unprovisioned_zero_arg_factory_fail_closed(self):
        public = raw_public(Ed25519PrivateKey.generate())
        for value in (None, b'', b'x' * 31, b'x' * 33, bytearray(public), public.hex()):
            with self.assertRaises(CORE.GuardError): CRYPTO.build_host_verifier(value, 'd' * 64)
        for source in (None, 'd' * 63, 'D' * 64, True):
            with self.assertRaises(CORE.GuardError): CRYPTO.build_host_verifier(public, source)
        with self.assertRaises(CORE.GuardError): CRYPTO.build_deployed_host_verifier()
        with mock.patch.dict(sys.modules, {'cryptography.hazmat.primitives.asymmetric.ed25519': None}):
            with self.assertRaisesRegex(CORE.GuardError, 'provider-unavailable'):
                CRYPTO.build_host_verifier(public, 'd' * 64)

    def test_zero_arg_factory_uses_only_immutable_module_pins(self):
        key = Ed25519PrivateKey.generate()
        public = raw_public(key)
        with mock.patch.object(CRYPTO, 'PINNED_PUBLIC_KEY_RAW', public), mock.patch.object(CRYPTO, 'PINNED_FINALIZE_SOURCE_SHA256', 'd' * 64):
            verifier = CRYPTO.build_deployed_host_verifier()
        self.assertEqual(verifier.finalize_source_sha256, 'd' * 64)
        self.assertEqual(verifier.key_id, 'ed25519-sha256:' + hashlib.sha256(public).hexdigest())

    def test_python36_grammar_for_provider(self):
        ast.parse(SOURCE.read_text(encoding='utf-8'), filename=str(SOURCE), feature_version=(3, 6))

    def test_real_node_finalizer_ack_passes_existing_core_full_history_and_mutations_stay_held(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Local Node runtime is required for real cross-language crypto tests')
        intent, proof, records, receipt = prepared_fixture()
        fixture_root = ROOT / 'output/qa/2026-10-17-fz3b-recovery/recovery-phase3/remote-host-ack-fixtures'
        fixture_root.mkdir(parents=True, exist_ok=True)
        program = r'''
import { generateKeyPairSync, createHash } from 'node:crypto';
import { createRemoteHostAckFinalizer } from './packages/engineering-runner/fz3b/remote-host-ack.ts';
let text=''; for await (const chunk of process.stdin) text+=chunk;
const request=JSON.parse(text);
const hash=b=>createHash('sha256').update(b).digest('hex');
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const rawPublic=publicKey.export({format:'der',type:'spki'}).subarray(-32);
const receipt=Buffer.from(request.receipt,'base64');
const source=Buffer.from(`process.stdout.write(Buffer.from('${receipt.toString('base64')}','base64'));\n`);
const command={executable:process.execPath,args:['-']};
// The exact canonical command JSON sorts args before executable.
const commandRaw=Buffer.from(JSON.stringify({args:command.args,executable:command.executable})+'\n');
const operation=createRemoteHostAckFinalizer({ privateKey,pinnedPublicKeyRaw32:rawPublic,pinnedFinalizeSourceSha256:hash(source),finalizeSource:source,
fixedCommand:{...command,pinnedCommandSha256:hash(commandRaw)},records:Object.fromEntries(Object.entries(request.records).map(([k,v])=>[k,Buffer.from(v,'base64')])),
acceptanceDirectory:request.directory,timeoutMs:5000 });
const result=await operation.complete();
process.stdout.write(JSON.stringify({publicKey:rawPublic.toString('base64'),sourceSha256:hash(source),envelope:result.envelope.toString('base64')}));
'''
        with tempfile.TemporaryDirectory(prefix='cross-language-', dir=str(fixture_root)) as directory:
            os.chmod(directory, 0o700)
            request = {'receipt': base64.b64encode(receipt).decode('ascii'), 'directory': directory,
                       'records': {suffix: base64.b64encode(records[intent['runId'] + '.' + suffix + '.json']).decode('ascii')
                                   for suffix in CORE.RECORDS if suffix != 'host-ack'}}
            process = subprocess.run([node, '--import', 'tsx', '--input-type=module', '-e', program], cwd=str(ROOT),
                                     input=json.dumps(request).encode('ascii'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
            self.assertEqual(process.returncode, 0, process.stderr.decode('utf-8', 'replace'))
            self.assertEqual(process.stderr, b'')
            result = json.loads(process.stdout.decode('ascii'))
            envelope_raw = base64.b64decode(result['envelope'])
            ack = CORE.decode(envelope_raw)
            verifier = CRYPTO.build_host_verifier(base64.b64decode(result['publicKey']), result['sourceSha256'])
            self.assertEqual(CORE.checked_host_ack(ack, intent, proof, records, verifier), ack['payload'])
            full = dict(records)
            full[intent['runId'] + '.host-ack.json'] = envelope_raw
            self.assertTrue(CORE.history_clear(full, verifier))
            with self.assertRaises(CORE.GuardError): CORE.history_clear(records, verifier)
            for path, value in (('signatureB64', base64.b64encode(b'\0' * 64).decode('ascii')), ('signatureB64', ack['signatureB64'] + '\n'),
                                ('algorithm', 'HMAC'), ('keyId', 'ed25519-sha256:' + '0' * 64)):
                changed = copy.deepcopy(ack); changed[path] = value
                bad = dict(full); bad[intent['runId'] + '.host-ack.json'] = CORE.encode(changed)
                with self.assertRaises(CORE.GuardError): CORE.history_clear(bad, verifier)
            for field in CORE.ACK_KEYS:
                changed = copy.deepcopy(ack)
                changed['payload'][field] = 'foreign'
                bad = dict(full); bad[intent['runId'] + '.host-ack.json'] = CORE.encode(changed)
                with self.assertRaises((CORE.GuardError, ValueError, TypeError)):
                    CORE.history_clear(bad, verifier)
            for suffix in CORE.RECORDS:
                bad = dict(full); del bad[intent['runId'] + '.' + suffix + '.json']
                with self.assertRaises(CORE.GuardError): CORE.history_clear(bad, verifier)


if __name__ == '__main__':
    unittest.main()
