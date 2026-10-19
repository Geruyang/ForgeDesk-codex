"""Offline-only preparation of one product-lease-wrapped, frozen old start."""
import ast
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
START = ROOT / 'output/hardware/2026-10-16-continuation/live-plan/ps-security-1792122514610/start-service.py'
GATE = ROOT / 'engineering/fz3b/tools/recovery_051_product_gate.py'
EXECUTION = ROOT / 'output/qa/2026-10-16-fz3b-051/ps-v2-reinstall-f8659d9d-fc3a-421f-86f9-ff3f715250bf/execution.json'
OUT = ROOT / 'output/qa/2026-10-16-fz3b-051/lifecycle'
START_SHA = '4d7b13905746a078b481d76ff0b535aca1697ee3ccb279c2475665a60a3c6eab'
GATE_SHA = 'c14b4604b4d18377865080d477cb5aa0d357829aca14c85d3be961d283be17aa'
EXECUTION_SHA = '08ecf3ec0eb6c5318ad165838aa1a5344faf7a6afda196657f3edf1149155995'

RUNTIME = '''
def wrapper_require(condition, code):
    if not condition:
        raise ValueError(code)

def guarded_start(start_bytes, gate_namespace):
    wrapper_require(hashlib.sha256(start_bytes).hexdigest() == START_SHA, 'fixed-old-start-hash-mismatch')
    output, inner, entered = [], {}, False
    def capture(value):
        wrapper_require(type(value) is str and not output and len(value.encode('utf-8')) <= 262144, 'old-start-output-contract')
        output.append(value)
    try:
        with gate_namespace['ProductLease']() as lease:
            wrapper_require(gate_namespace['assert_ps_transaction_absent'](lease.app_fd) is True, 'ps-lease-absence-unconfirmed')
            before = lease.recheck()
            inner = {'__name__': '__main__', 'print': capture}
            entered = True
            try:
                exec(compile(start_bytes, 'frozen-start-service.py', 'exec'), inner)
                raise ValueError('old-start-did-not-exit')
            except SystemExit as terminal:
                wrapper_require(type(terminal.code) is int and terminal.code in (0, 2), 'old-start-exit-code')
                exit_code = terminal.code
            result = inner.get('RESULT')
            wrapper_require(type(result) is dict and len(output) == 1 and json.loads(output[0]) == result, 'old-start-result-envelope')
            wrapper_require(exit_code == (0 if result.get('result') == 'passed' else 2), 'old-start-result-exit-mismatch')
            wrapper_require(lease.recheck() == before, 'product-journal-changed-during-old-start')
            wrapper_require(gate_namespace['assert_ps_transaction_absent'](lease.app_fd) is True, 'ps-lease-after-old-start')
        return exit_code, output[0]
    except Exception as error:
        result = inner.get('RESULT')
        failure = {'schemaVersion': 1, 'scope': 'fixed-product-lease-wrapped-old-start',
                   'result': 'unknown' if entered else 'blocked', 'oldStartEntered': entered,
                   'actionIssued': result.get('actionIssued') if type(result) is dict else None,
                   'automaticRetry': False, 'killAttempted': False, 'compensationRequested': False,
                   'error': {'type': type(error).__name__, 'errno': getattr(error, 'errno', None)}}
        return (2 if entered else 1), json.dumps(failure, sort_keys=True)

def main():
    wrapper_require(len(sys.argv) == 1, 'no-arguments-accepted')
    gate_bytes = base64.b64decode(GATE_B64)
    start_bytes = base64.b64decode(START_B64)
    wrapper_require(hashlib.sha256(gate_bytes).hexdigest() == GATE_SHA, 'fixed-product-gate-hash-mismatch')
    gate_namespace = {'__name__': 'fixed_product_gate'}
    exec(compile(gate_bytes, 'frozen-product-gate.py', 'exec'), gate_namespace)
    code, line = guarded_start(start_bytes, gate_namespace)
    print(line)
    return code

if __name__ == '__main__':
    sys.exit(main())
'''


def fixed_read(file, limit):
    absolute = Path(os.path.abspath(str(file)))
    if absolute != ROOT and ROOT not in absolute.parents:
        raise ValueError('outside-project')
    for component in (absolute,) + tuple(absolute.parents):
        info = component.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('linked-path')
        if component == ROOT:
            break
    info = absolute.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
        raise ValueError('unsafe-file')
    with open(str(absolute), 'rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) != info.st_size or len(raw) > limit:
        raise ValueError('file-changed-or-oversize')
    return raw


def build_payload(start_bytes, gate_bytes):
    if hashlib.sha256(start_bytes).hexdigest() != START_SHA or hashlib.sha256(gate_bytes).hexdigest() != GATE_SHA:
        raise ValueError('pinned-wrapper-input-mismatch')
    prefix = 'import base64,hashlib,json,sys\nsys.dont_write_bytecode=True\n'
    prefix += 'START_SHA=' + repr(START_SHA) + '\nGATE_SHA=' + repr(GATE_SHA) + '\n'
    prefix += 'START_B64=' + repr(base64.b64encode(start_bytes).decode('ascii')) + '\n'
    prefix += 'GATE_B64=' + repr(base64.b64encode(gate_bytes).decode('ascii')) + '\n'
    raw = (prefix + RUNTIME).encode('ascii')
    ast.parse(raw.decode('ascii'), feature_version=(3, 6))
    compile(raw, '<offline-fixed-start-wrapper>', 'exec', dont_inherit=True)
    return raw


def main(argv=None):
    if sys.argv[1:] if argv is None else argv:
        raise ValueError('no-arguments-accepted')
    start, gate = fixed_read(START, 65536), fixed_read(GATE, 65536)
    execution = fixed_read(EXECUTION, 2 * 1024 * 1024)
    if hashlib.sha256(execution).hexdigest() != EXECUTION_SHA:
        raise ValueError('fixed-reinstall-receipt-mismatch')
    receipt = json.loads(execution.decode('utf-8'))
    observed = receipt['receipt']['observation']
    if (receipt.get('result') != 'passed-host-ps-v2-reinstall' or receipt['receipt'].get('remoteOutcomeUnknown') is not False
            or receipt['receipt'].get('sshCloseConfirmed') is not True or receipt['receipt'].get('exitCode') != 0
            or observed.get('status') != 'reinstalled-v2' or observed.get('replacedTargetCount') != 6
            or observed.get('persistent_lock_retained') is not False or observed.get('productLeaseClosed') is not True):
        raise ValueError('fixed-reinstall-not-clean')
    payload = build_payload(start, gate)
    info = OUT.lstat()
    if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError('unsafe-output-directory')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ') + '-' + secrets.token_hex(6)
    directory = OUT / ('guarded-start-' + stamp)
    directory.mkdir()
    manifest = {'schema': 'fz3b-product-lease-wrapped-old-start-v1', 'executed': False,
                'builderSha256': hashlib.sha256(fixed_read(Path(__file__), 65536)).hexdigest(), 'legacyStartSha256': START_SHA,
                'productGateSha256': GATE_SHA, 'reinstallExecutionSha256': EXECUTION_SHA,
                'payloadSha256': hashlib.sha256(payload).hexdigest(), 'payloadBytes': len(payload),
                'innerBytesUnmodified': True, 'serviceAction': 'only the original pinned start', 'automaticRetry': False,
                'scope': 'Offline generation only; sole coordinator must review and authorize one real invocation.'}
    for name, raw in (('guarded-start-stdin.py', payload), ('manifest.json', (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode('ascii'))):
        with open(str(directory / name), 'xb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    print(json.dumps({'directory': str(directory), 'executed': False, 'payloadSha256': manifest['payloadSha256']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
