"""Offline-only builder of two fixed completed-job lifecycle stdin payloads.

No generated program is executed here. No SSH, application import or hardware.
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
import subprocess
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'engineering/fz3b/tools/service_lifecycle.py'
OLD = ROOT / 'engineering/fz3b/tools/recovery_completed_job_stop.py'
GATE = ROOT / 'engineering/fz3b/tools/recovery_051_product_gate.py'
SOURCE = ROOT / 'output/hardware/2026-10-16-next/product/fz3b-installed-1792146694950-f4d812/evidence.json'
PROC = ROOT / 'output/hardware/2026-10-16-next/recovery/maintenance-check/maintenance_gate.py'
OUT = ROOT / 'output/qa/2026-10-16-fz3b-051/lifecycle'
BASE_SHA = 'b05172f7ead79cfda5995a70c2d7800f5eb72eae104c0621d904bfeb6467a81b'
OLD_SHA = 'f626e5a9ce0f72c04ab31ac117136bbceb44573b4b53e1a0532744a53d4c91cf'
GATE_SHA = 'c14b4604b4d18377865080d477cb5aa0d357829aca14c85d3be961d283be17aa'
SOURCE_SHA = '718ac62b2652427597c93cc28cd8d6b007d6b89fbc9d5757896b1a2d9382f418'
PROC_SHA = '9c15a032ff912893824c3bc634551618bc39eab61790d7fb53e2dcc70bcca9d9'
RECOVERY_BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
RECOVERY_JOB = 'fd-semantic-af51470db5454fdeae7869bf13a61fd7'
RECOVERY_CONFIG_SHA = 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2'


class SystemAccess(object):
    """Host-only placeholder; generated payload retains the pinned base class."""
    pass


def run_show(unit, popen=subprocess.Popen):
    require(unit in (UNIT,) + DEPENDENCIES, 'unit-not-allowed')
    child = popen(['/bin/systemctl', 'show', unit, '--no-pager', '--property=' + ','.join(PROPERTIES)],
                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                  env=dict(CHILD_ENV), shell=False, close_fds=True)
    record = {'action': 'show', 'unit': unit, 'pid': child.pid, 'timeoutSeconds': 5, 'exitObserved': False, 'killAttempted': False}
    try:
        stdout, _ = child.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        raise LifecycleError('systemctl-show-timeout-no-kill', record)
    require(child.returncode == 0 and type(stdout) is bytes and len(stdout) <= 65536, 'systemctl-show-failed')
    values = {}
    for line in stdout.decode('utf-8').splitlines():
        key, separator, value = line.partition('=')
        require(separator and key in PROPERTIES and key not in values, 'systemctl-property-envelope')
        values[key] = value
    require(set(values) == set(PROPERTIES), 'systemctl-missing-property')
    return values


def run_stop(popen=subprocess.Popen):
    child = popen(['/bin/systemctl', 'stop', UNIT, '--no-pager'], stdin=subprocess.DEVNULL,
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(CHILD_ENV), shell=False, close_fds=True)
    record = {'action': 'stop', 'unit': UNIT, 'pid': child.pid, 'timeoutSeconds': STOP_SECONDS, 'exitObserved': False, 'killAttempted': False}
    try:
        child.communicate(timeout=STOP_SECONDS)
    except subprocess.TimeoutExpired:
        raise LifecycleError('systemctl-stop-timeout-no-kill', record)
    record.update(exitObserved=True, returncode=child.returncode)
    return record


def strict_pre_read(access):
    # The old 'start' selector enforces exact v2 hashes/loopback without issuing an action.
    value = original_pre_read(access, RECOVERY_BOOT, 'start', dict(APPROVED_HASHES))
    require(value['config']['sha256'] == RECOVERY_CONFIG_SHA, 'completed-051-config-changed')
    return value


def strict_dependencies(access):
    value = dependencies(access)
    for item in value.values():
        require(item['subState'] in ('running', 'exited') and type(item['mainPid']) is str
                and re.fullmatch(r'0|[1-9][0-9]*', item['mainPid']) is not None
                and ((item['subState'] == 'exited' and item['mainPid'] == '0')
                     or (item['subState'] == 'running' and int(item['mainPid']) > 0)), 'dependency-not-clean-active')
    return value


class CompletedAccess(SystemAccess):
    def show(self, unit):
        return run_show(unit)

    def status(self, boot):
        return query_completed_status(boot)

    def inspectors(self):
        return scan_inspectors()

    def guards(self, lease):
        result = lease.recheck()
        require(assert_ps_transaction_absent(lease.app_fd) is True, 'completed-051-ps-lease-unknown')
        return result


class StopAccess(CompletedAccess):
    def action(self):
        return run_stop()


def checked_inspector_audit(access):
    value = access.inspectors()
    require(type(value) is dict and value.get('completePass') is True and value.get('stdinInspectors') == []
            and value.get('newPidsAtEnd') == [] and value.get('rawArgvEmitted') is False and value.get('stdinRead') is False
            and value.get('environmentRead') is False and value.get('remainingArgumentsRead') is False,
            'completed-051-inspector-absence-unconfirmed')
    own = value.get('selfExcluded')
    require(type(own) is dict and set(own) == {'pid', 'startTicks'} and type(own['pid']) is int and own['pid'] > 0
            and type(own['startTicks']) is int and own['startTicks'] >= 0, 'completed-051-inspector-self-unconfirmed')
    return value


def checked_preflight(access, lease):
    first_guard = access.guards(lease)
    files = strict_pre_read(access)
    deps = strict_dependencies(access)
    before = checked_service(access.show(UNIT))
    clean_service(before, 'active')
    status_value = access.status(RECOVERY_BOOT)
    require(status_value.get('probeSocketClosedBeforeFdScan') is True, 'completed-051-probe-not-closed')
    idle = quiescence(access, before['mainPid'])
    audit1 = checked_inspector_audit(access)
    require(strict_pre_read(access) == files and strict_dependencies(access) == deps
            and checked_service(access.show(UNIT)) == before, 'completed-051-changed-before-action')
    # A fresh second status is closed before the final descriptor scan.
    access.sleep(.3)
    status_value = access.status(RECOVERY_BOOT)
    require(status_value.get('probeSocketClosedBeforeFdScan') is True, 'completed-051-probe-not-closed')
    idle = quiescence(access, before['mainPid'])
    audit2 = checked_inspector_audit(access)
    require(audit1['selfExcluded'] == audit2['selfExcluded'], 'completed-051-inspector-self-changed')
    require(access.guards(lease) == first_guard, 'completed-051-guard-changed')
    return {'preRead': files, 'dependenciesBefore': deps, 'before': before, 'beforeStatus': status_value,
            'beforeQuiescence': idle, 'productGuard': first_guard, 'inspectorAudits': [audit1, audit2]}


def checked_execution(mode, access, lease):
    result = {'schemaVersion': 1, 'scope': 'fixed-completed-job-051-maintenance', 'mode': mode,
              'result': 'blocked', 'actionIssued': False, 'killAttempted': False, 'automaticRetry': False,
              'applicationImported': False, 'deviceOpened': False, 'authenticationFilesRead': False,
              'jobClearedByProbe': False, 'historicalUnknownResolved': False, 'startRequested': False,
              'fixedJob': RECOVERY_JOB, 'fixedQueryRevision': 3, 'productJournalModified': False,
              'limitations': ['Outer reviewed host/global hardware ownership remains mandatory.',
                              'PS lease absence is a point-in-time guard, not a lock against another root.',
                              'HELLO/status compatibility is not board authentication or unknown-operation recovery.']}
    try:
        require(mode in ('readonly-preflight', 'normal-stop'), 'completed-051-mode-not-allowed')
        access.check_environment()
        with lease as held:
            result.update(checked_preflight(access, held))
            if mode == 'normal-stop':
                require(access.guards(held) == result['productGuard'], 'completed-051-last-guard-changed')
                result['actionIssued'] = True
                result['command'] = access.action()
                require(result['command'].get('exitObserved') is True and result['command'].get('returncode') == 0
                        and result['command'].get('action') == 'stop' and result['command'].get('unit') == UNIT
                        and result['command'].get('killAttempted') is False, 'completed-051-stop-exit-unknown')
                after = checked_service(access.show(UNIT))
                clean_service(after, 'inactive')
                result['after'] = after
                result['afterQuiescence'] = quiescence(access, 0)
                result['afterInspectorAudit'] = checked_inspector_audit(access)
                require(result['afterInspectorAudit']['selfExcluded'] == result['inspectorAudits'][0]['selfExcluded'], 'completed-051-post-inspector-self-changed')
                result['postRead'] = strict_pre_read(access)
                result['dependenciesAfter'] = strict_dependencies(access)
                require(result['postRead'] == result['preRead'] and result['dependenciesAfter'] == result['dependenciesBefore'], 'completed-051-post-state-changed')
                require(access.guards(held) == result['productGuard'], 'completed-051-post-guard-changed')
            result['result'] = 'passed'
        result['productLeaseReleasedOnReturn'] = True
    except Exception as error:
        result['result'] = 'unknown' if result['actionIssued'] else 'blocked'
        result['error'] = {'code': error.code if isinstance(error, LifecycleError) else str(error) if isinstance(error, ProductGateError) else type(error).__name__,
                           'errno': getattr(error, 'errno', None)}
        if isinstance(error, LifecycleError) and error.command is not None:
            result['command'] = error.command
    result['humanReviewRequired'] = result['result'] == 'unknown'
    return result


def readonly_preflight(access=None, lease=None):
    return checked_execution('readonly-preflight', CompletedAccess() if access is None else access, ProductLease() if lease is None else lease)


def normal_stop(access=None, lease=None):
    return checked_execution('normal-stop', StopAccess() if access is None else access, ProductLease() if lease is None else lease)


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


def validate_source(raw):
    if hashlib.sha256(raw).hexdigest() != SOURCE_SHA:
        raise ValueError('fixed-source-receipt-hash-mismatch')
    value = json.loads(raw.decode('utf-8'))
    run = value['run']
    semantic = run['semantic']
    expected = ['fz3b_status', 'fz3b_build', 'fz3b_inspect', 'fz3b_request_semantic', 'fz3b_semantic', 'fz3b_export']
    if (value.get('result') != 'passed' or value.get('realModel') is not True or value.get('secondUser') is not False
            or run.get('status') != 'completed' or run.get('active') is not False or run.get('hardwareBusy') is not False
            or [call['tool'] for call in run['calls']] != expected or any(call['status'] != 'succeeded' for call in run['calls'])
            or semantic.get('jobId') != RECOVERY_JOB or type(semantic.get('queryRevision')) is not int or semantic['queryRevision'] != 3
            or semantic.get('inferenceStopped') is not True or semantic.get('completedFrames') != 1 or semantic.get('threshold') != .2
            or value['controls'].get('normalClose') != 'passed' or value['controls'].get('restartNoReplay') != 'passed'):
        raise ValueError('fixed-source-not-completed')
    return value


def build_payloads(base_bytes, old_bytes, gate_bytes, self_bytes, source_bytes, proc_bytes):
    for raw, expected in ((base_bytes, BASE_SHA), (old_bytes, OLD_SHA), (gate_bytes, GATE_SHA), (proc_bytes, PROC_SHA)):
        if hashlib.sha256(raw).hexdigest() != expected:
            raise ValueError('pinned-input-hash-mismatch')
    accepted = validate_source(source_bytes)
    base = ast.parse(base_bytes.decode('utf-8'), feature_version=(3, 6))
    old = ast.parse(old_bytes.decode('utf-8'))
    gate = ast.parse(gate_bytes.decode('utf-8'), feature_version=(3, 6))
    proc = ast.parse(proc_bytes.decode('utf-8'), feature_version=(3, 6))
    own = ast.parse(self_bytes.decode('utf-8'))
    keep = {'require', 'unique_pairs', 'json_object', 'read_fixed', 'tcp_rows', 'scan_quiescence',
            'checked_service', 'clean_service', 'pre_read', 'dependencies', 'quiescence'}
    common = []
    for node in base.body:
        if isinstance(node, (ast.Import, ast.ImportFrom, ast.Assign)):
            common.append(copy.deepcopy(node))
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute) and isinstance(node.value.func.value, ast.Name) and node.value.func.value.id == 'READ_LIMITS' and node.value.func.attr == 'update':
            common.append(copy.deepcopy(node))
        elif isinstance(node, ast.FunctionDef) and node.name in keep:
            copied = copy.deepcopy(node)
            if copied.name == 'pre_read':
                copied.name = 'original_pre_read'
            common.append(copied)
        elif isinstance(node, ast.ClassDef) and node.name in ('LifecycleError', 'SystemAccess'):
            copied = copy.deepcopy(node)
            if copied.name == 'SystemAccess':
                copied.body = [item for item in copied.body if not isinstance(item, ast.FunctionDef) or item.name in ('check_environment', 'read', 'scan', 'sleep')]
            common.append(copied)
    common.extend(copy.deepcopy(gate.body))
    proc_nodes = [copy.deepcopy(node) for node in proc.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
                  and node.name in ('proc_stat', 'classify_prefix', 'ProcAccess', 'scan_inspectors')]
    if len(proc_nodes) != 4:
        raise ValueError('pinned-proc-subset-shape-changed')
    common.extend(proc_nodes)
    completed = copy.deepcopy(next(node for node in old.body if isinstance(node, ast.FunctionDef) and node.name == 'completed_status'))
    revision_changes = 0
    for node in ast.walk(completed):
        if isinstance(node, ast.Compare) and isinstance(node.left, ast.Subscript) and isinstance(node.left.value, ast.Name) and node.left.value.id == 'value':
            if ast.literal_eval(node.left.slice) == 'query_revision':
                node.comparators = [ast.Constant(value=3)]
                revision_changes += 1
        if isinstance(node, ast.Dict):
            for index, key in enumerate(node.keys):
                if isinstance(key, ast.Constant) and key.value == 'queryRevision':
                    node.values[index] = ast.Constant(value=3)
                    revision_changes += 1
    if revision_changes != 2:
        raise ValueError('old-completed-validator-shape-changed')
    common.append(completed)
    query = copy.deepcopy(next(node for node in base.body if isinstance(node, ast.FunctionDef) and node.name == 'query_status'))
    query.name = 'query_completed_status'
    for node in ast.walk(query):
        if isinstance(node, ast.Name) and node.id == 'checked_status':
            node.id = 'completed_status'
    common.append(query)
    wanted = {'run_show', 'strict_pre_read', 'strict_dependencies', 'checked_inspector_audit', 'checked_preflight', 'checked_execution', 'readonly_preflight'}
    result = {}
    for mode in ('readonly-preflight', 'normal-stop'):
        output = ast.Module(body=copy.deepcopy(common), type_ignores=[])
        selected = wanted | ({'run_stop', 'normal_stop'} if mode == 'normal-stop' else set())
        for node in own.body:
            if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id in ('RECOVERY_BOOT', 'RECOVERY_JOB', 'RECOVERY_CONFIG_SHA') for target in node.targets):
                output.body.append(copy.deepcopy(node))
            elif isinstance(node, ast.FunctionDef) and node.name in selected:
                copied = copy.deepcopy(node)
                if copied.name == 'checked_execution' and mode == 'readonly-preflight':
                    copied.body = [item for item in copied.body]
                    for parent in ast.walk(copied):
                        for field, children in ast.iter_fields(parent):
                            if isinstance(children, list):
                                children[:] = [item for item in children if not (isinstance(item, ast.If) and ast.unparse(item.test) == "mode == 'normal-stop'")]
                output.body.append(copied)
            elif isinstance(node, ast.ClassDef) and node.name in ({'CompletedAccess', 'StopAccess'} if mode == 'normal-stop' else {'CompletedAccess'}):
                output.body.append(copy.deepcopy(node))
        entry = 'readonly_preflight' if mode == 'readonly-preflight' else 'normal_stop'
        output.body.extend(ast.parse("if __name__ == '__main__':\n    require(len(sys.argv) == 1, 'no-arguments-accepted')\n    RESULT = " + entry + "()\n    print(json.dumps(RESULT, sort_keys=True, indent=2))\n    sys.exit(0 if RESULT['result'] == 'passed' else 2 if RESULT['result'] == 'unknown' else 1)\n").body)
        ast.fix_missing_locations(output)
        payload = (ast.unparse(output) + '\n').encode('ascii')
        ast.parse(payload.decode('ascii'), feature_version=(3, 6))
        compile(payload, '<fixed-051-' + mode + '>', 'exec', dont_inherit=True)
        result[mode] = payload
    return result, {'acceptedRunId': accepted['run']['runId'], 'acceptedSourceVersion': accepted['release']['version']}


def main(argv=None):
    if sys.argv[1:] if argv is None else argv:
        raise ValueError('no-arguments-accepted')
    inputs = [fixed_read(BASE, 65536), fixed_read(OLD, 65536), fixed_read(GATE, 65536), fixed_read(Path(__file__), 65536), fixed_read(SOURCE, 4 * 1024 * 1024), fixed_read(PROC, 65536)]
    payloads, evidence = build_payloads(*inputs)
    for directory in (ROOT / 'output', ROOT / 'output/qa', ROOT / 'output/qa/2026-10-16-fz3b-051', OUT):
        if not directory.exists():
            directory.mkdir()
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            raise ValueError('unsafe-output-directory')
    name = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H-%M-%SZ') + '-' + secrets.token_hex(6)
    directory = OUT / ('completed-051-' + name)
    directory.mkdir()
    manifest = dict(schema='fz3b-fixed-completed-051-payloads-v1', executed=False, sourceReceiptSha256=SOURCE_SHA,
                    baseSha256=BASE_SHA, oldCompletedGateSha256=OLD_SHA, productGateSha256=GATE_SHA, procSubsetSourceSha256=PROC_SHA,
                    builderSha256=hashlib.sha256(inputs[3]).hexdigest(), fixedBoot=RECOVERY_BOOT, fixedJob=RECOVERY_JOB,
                    fixedQueryRevision=3, accepted=evidence, payloads={}, sharedSourcesModified=False,
                    scope='Offline generation only; coordinator must review and separately authorize each invocation; no SSH here.')
    for mode, payload in payloads.items():
        filename = mode + '-stdin.py'
        manifest['payloads'][mode] = {'file': filename, 'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)}
        with open(str(directory / filename), 'xb') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    raw = (json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode('ascii')
    with open(str(directory / 'manifest.json'), 'xb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    print(json.dumps({'directory': str(directory), 'executed': False, 'manifestSha256': hashlib.sha256(raw).hexdigest()}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
