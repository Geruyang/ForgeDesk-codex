"""Fail-closed Ed25519 provider for the installed recovery core (Python 3.6).

This file ships no key and does not provision one. The deployment owner must pin
the reviewed public key and finalize source before the zero-argument factory can
work. cryptography and its target ABI are separate deployment requirements.
"""
import hashlib


PINNED_PUBLIC_KEY_RAW = None
PINNED_FINALIZE_SOURCE_SHA256 = None


def build_host_verifier(public_key_raw32, finalize_source_sha256):
    """Trusted composition only. Never call with request/config/env values."""
    from . import recovery_quarantine_core as core

    core.require(type(public_key_raw32) is bytes and len(public_key_raw32) == 32,
                 'guard-host-public-key-unprovisioned')
    core.hash_value(finalize_source_sha256)
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        public_key = Ed25519PublicKey.from_public_bytes(public_key_raw32)
    except Exception as error:
        raise core.GuardError('guard-host-ed25519-provider-unavailable') from error

    def verify(message, signature):
        if (type(message) is not bytes or not message.startswith(core.ACK_DOMAIN)
                or not 0 < len(message) - len(core.ACK_DOMAIN) <= core.MAX_FILE
                or type(signature) is not bytes or len(signature) != 64):
            return False
        try:
            public_key.verify(signature, message)
        except InvalidSignature:
            return False
        except Exception:
            return False
        return True

    key_id = 'ed25519-sha256:' + hashlib.sha256(public_key_raw32).hexdigest()
    return core.TrustedHostAckVerifier(key_id, finalize_source_sha256, verify)


def build_deployed_host_verifier():
    """No dynamic provider/key discovery. Missing immutable pins stay held."""
    return build_host_verifier(PINNED_PUBLIC_KEY_RAW, PINNED_FINALIZE_SOURCE_SHA256)
