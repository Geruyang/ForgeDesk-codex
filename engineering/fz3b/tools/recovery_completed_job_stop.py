"""Offline-only builder of one separately reviewed completed-job normal-stop payload.

This host tool never executes the generated program or connects SSH. Existing
service_lifecycle.py is read, SHA-pinned and preserved, not imported or modified.
"""
import ast
import copy
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
BASE = ROOT / 'engineering/fz3b/tools/service_lifecycle.py'
BASE_SHA = 'b05172f7ead79cfda5995a70c2d7800f5eb72eae104c0621d904bfeb6467a81b'
OUT = ROOT / 'output/hardware/2026-10-16-next/recovery'
RECOVERY_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
RECOVERY_JOB = 'fz3b-one-image-97e500d59a104983ae19a4f67e853b12'
RECOVERY_CONFIG_SHA = 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2'
RECOVERY_FILES = {
    'disconnect-2026-10-16T06-17-55-826Z-9d7dd63f9021/evidence.json':
        '2fde02312e41e04fdff678e54d68147786b715881bfccaaa55983f50049e0edf',
    'rejection-2026-10-16T06-18-07-696Z-d187b5a59d7d/evidence.json':
        '6925bae91bfac8a17d1c8403d117e1417d68b9e4e23203a4c17ada06013252e8',
}


def completed_status(value, expected_boot):
    require(expected_boot == RECOVERY_BOOT, 'completed-stop-boot-not-fixed')
    require(type(value) is dict and value.get('type') in ('hello', 'status')
            and type(value.get('protocol')) is int and value['protocol'] == 1
            and value.get('platform') == 'A0005' and value.get('contract_id') == CONTRACT_ID
            and value.get('boot_id') == RECOVERY_BOOT, 'completed-stop-status-identity')
    inference = value.get('inference')
    require(type(inference) is dict and inference.get('state') == 'STOPPED'
            and 'error' in inference and inference['error'] is None
            and type(inference.get('frames')) is int and inference['frames'] == 1
            and type(inference.get('max_in_flight')) is int and inference['max_in_flight'] == 4,
            'completed-stop-inference-not-exact')
    require(type(value.get('query_revision')) is int and value['query_revision'] == 1
            and type(value.get('threshold')) in (int, float) and value['threshold'] == .2
            and type(value.get('result_delivery_drops')) is int and value['result_delivery_drops'] == 0,
            'completed-stop-query-or-settings-changed')
    require(value.get('cpu_frequency_changing') is False and value.get('input_source') == 'upload',
            'completed-stop-input-or-clock')
    upload = value.get('upload')
    require(type(upload) is dict and set(upload) == {'job_id', 'received', 'completed', 'queued', 'finished', 'cancelled', 'error'}
            and upload['job_id'] == RECOVERY_JOB and upload['finished'] is True
            and upload['cancelled'] is False and upload['error'] is None,
            'completed-stop-upload-not-exact')
    for key, expected in (('received', 1), ('completed', 1), ('queued', 0)):
        require(type(upload[key]) is int and upload[key] == expected, 'completed-stop-upload-not-drained')
    return {'bootId': RECOVERY_BOOT, 'contractId': CONTRACT_ID, 'platform': 'A0005',
            'inference': {'state': 'STOPPED', 'error': None, 'frames': 1, 'maxInFlight': 4},
            'queryRevision': 1, 'threshold': .2, 'resultDeliveryDrops': 0,
            'inputSource': 'upload', 'cpuFrequencyChanging': False, 'upload': dict(upload)}


def assert_lease_absent():
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    directory = os.open('/', flags)
    try:
        for part in PROJECT.strip('/').split('/'):
            opened = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = opened
            info = os.fstat(directory)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                    'completed-stop-unsafe-app-directory')
        try:
            os.stat('.forgedesk-ps-transaction.lock', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return True
        raise LifecycleError('completed-stop-transaction-lease-present')
    finally:
        os.close(directory)


def pre_read(access, boot, mode, hashes):
    require(mode == 'stop' and hashes is None and boot == RECOVERY_BOOT, 'completed-stop-only')
    require(access.lease_absent() is True, 'completed-stop-lease-absence-unconfirmed')
    # 'start' selects the frozen strict read-only v2 code/config checks; no action.
    evidence = original_pre_read(access, boot, 'start', dict(APPROVED_HASHES))
    require(evidence['config']['sha256'] == RECOVERY_CONFIG_SHA, 'completed-stop-config-not-fixed')
    return evidence


def recovery_stop(access=None):
    if access is None:
        class CompletedJobAccess(SystemAccess):
            def status(self, boot):
                return query_completed_status(boot)

            def lease_absent(self):
                return assert_lease_absent()
        access = CompletedJobAccess()
    result = {'schemaVersion': 1, 'scope': 'fixed-fz3b-completed-job-normal-stop',
              'mode': 'stop', 'result': 'blocked', 'actionIssued': False,
              'killAttempted': False, 'automaticRetry': False, 'jobClearedByProbe': False,
              'historicalUnknownResolved': False, 'startRequested': False}
    try:
        access.check_environment()
        require(access.lease_absent() is True, 'completed-stop-lease-absence-unconfirmed')
        before_dependencies = dependencies(access)
        observed = lifecycle('stop', RECOVERY_BOOT, None, access)
        result.update(observed)
        result['scope'] = 'fixed-fz3b-completed-job-normal-stop'
        result['completedJob'] = RECOVERY_JOB
        result['dependenciesBefore'] = before_dependencies
        if result['result'] == 'passed':
            require(access.lease_absent() is True, 'completed-stop-lease-after-action')
            result['dependenciesAfter'] = dependencies(access)
            require(result['dependenciesAfter'] == before_dependencies, 'completed-stop-dependencies-changed')
    except Exception as error:
        result.update(result='unknown' if result['actionIssued'] else 'blocked',
                      error={'code': error.code if isinstance(error, LifecycleError) else type(error).__name__,
                             'errno': getattr(error, 'errno', None)})
    result['humanReviewRequired'] = result['result'] == 'unknown'
    return result


def fixed_read(path, limit):
    absolute = Path(os.path.abspath(str(path)))
    if absolute != ROOT and ROOT not in absolute.parents:
        raise ValueError('outside-project')
    for part in (absolute,) + tuple(absolute.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('linked-path')
        if part == ROOT:
            break
    info = absolute.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
        raise ValueError('unsafe-file')
    with open(str(absolute), 'rb') as stream:
        raw = stream.read(limit + 1)
    if len(raw) != info.st_size or len(raw) > limit:
        raise ValueError('read-extent-changed')
    return raw


def build_payload(base_bytes, gate_bytes):
    if hashlib.sha256(base_bytes).hexdigest() != BASE_SHA:
        raise ValueError('frozen-lifecycle-hash-mismatch')
    base = ast.parse(base_bytes.decode('utf-8'), feature_version=(3, 6))
    gate = ast.parse(gate_bytes.decode('utf-8'))
    functions = {node.name: node for node in base.body if isinstance(node, ast.FunctionDef)}
    if 'pre_read' not in functions or 'query_status' not in functions:
        raise ValueError('unexpected-base-structure')
    output = copy.deepcopy(base)
    output.body = [node for node in output.body if not isinstance(node, ast.If)]
    for node in output.body:
        if isinstance(node, ast.FunctionDef) and node.name == 'pre_read':
            node.name = 'original_pre_read'
    query = copy.deepcopy(functions['query_status'])
    query.name = 'query_completed_status'
    for node in ast.walk(query):
        if isinstance(node, ast.Name) and node.id == 'checked_status':
            node.id = 'completed_status'
    selected = []
    for node in gate.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in
                ('RECOVERY_BOOT', 'RECOVERY_JOB', 'RECOVERY_CONFIG_SHA') for target in node.targets):
            selected.append(copy.deepcopy(node))
        elif isinstance(node, ast.FunctionDef) and node.name in (
                'completed_status', 'assert_lease_absent', 'pre_read', 'recovery_stop'):
            selected.append(copy.deepcopy(node))
    if len(selected) != 7:
        raise ValueError('unexpected-gate-structure')
    output.body.extend(selected + [query])
    output.body.extend(ast.parse("if __name__ == '__main__':\n    require(len(sys.argv) == 1, 'no-arguments-accepted')\n    RESULT = recovery_stop()\n    print(json.dumps(RESULT, sort_keys=True, indent=2))\n    sys.exit(0 if RESULT['result'] == 'passed' else 2 if RESULT['result'] == 'unknown' else 1)\n").body)
    ast.fix_missing_locations(output)
    payload = (ast.unparse(output) + '\n').encode('ascii')
    ast.parse(payload.decode('ascii'), feature_version=(3, 6))
    compile(payload, '<reviewed-completed-job-stop>', 'exec', dont_inherit=True)
    return payload


def main(argv=None):
    if (sys.argv[1:] if argv is None else argv):
        raise ValueError('no-arguments-accepted')
    base, gate = fixed_read(BASE, 65536), fixed_read(Path(__file__), 65536)
    preconditions = {}
    for relative, expected in RECOVERY_FILES.items():
        raw = fixed_read(OUT / relative, 1024 * 1024)
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('fixed-recovery-receipt-hash-mismatch')
        receipt = json.loads(raw.decode('utf-8'))
        if (receipt.get('result') != 'passed' or receipt.get('remoteOutcomeUnknown') is not False or
                receipt.get('sshCloseConfirmed') is not True or receipt.get('exitCode') != 0 or
                receipt.get('sourceUnchanged') is not True or receipt.get('humanReviewRequired') is not False):
            raise ValueError('recovery-receipt-not-confirmed')
        preconditions[relative] = expected
    payload = build_payload(base, gate)
    # Fixed tree only. Existing links are refused before creating the exclusive child.
    fixed_read(OUT / 'PLAN_AND_OFFLINE_RESULT.md', 65536)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ') + '-' + secrets.token_hex(6)
    directory = OUT / ('completed-job-stop-' + stamp)
    directory.mkdir()
    manifest = dict(schema='fz3b-completed-job-stop-preparation-v1', executed=False,
                    baseSha256=BASE_SHA, gateSha256=hashlib.sha256(gate).hexdigest(),
                    payloadSha256=hashlib.sha256(payload).hexdigest(), payloadBytes=len(payload),
                    fixedBoot=RECOVERY_BOOT, fixedJob=RECOVERY_JOB, fixedConfigSha256=RECOVERY_CONFIG_SHA,
                    priorRecoveryReceipts=preconditions, sharedSourceModified=False,
                    astDelta=['rename frozen pre_read to original_pre_read; retain body',
                              'append strict stop-only pre_read and completed-job validation/access wrapper',
                              'clone query_status as query_completed_status; only validation callee differs',
                              'replace CLI entry with fixed no-argument stop-only entry'],
                    scope='offline preparation only; root must review before one normal stop; no start/SSH here')
    for name, raw in (('reviewed-stdin.py', payload), ('manifest.json', (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode('ascii'))):
        with open(str(directory / name), 'xb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    print(json.dumps(dict(directory=str(directory), executed=False, payloadSha256=manifest['payloadSha256'])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
