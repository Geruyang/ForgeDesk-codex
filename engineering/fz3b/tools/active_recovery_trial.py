"""Phase-1 offline plan and pure active-trial policy. Never connects or executes.

No socket, subprocess, application import, device access or remote lease operation
is implemented here. Production remains unchanged. Python 3.6 compatible.
"""
import argparse
import copy
import hashlib
import json
import math
import os
import re
import stat
import sys
import uuid

sys.dont_write_bytecode = True
OUTPUT = 'output/qa/2026-10-17-fz3b-recovery'
METHOD = 'fz3b-active-recovery-maintenance-v1'
ACTIONS = ('upload-cancel', 'tcp-close')
BLOCKERS = ('STRICT_FINALIZATION_NOT_IMPLEMENTED', 'CROSS_ENTRYPOINT_DURABLE_QUARANTINE_NOT_IMPLEMENTED')
BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
APP = '/root/fz3b-vision-console-20261009-001'
PROFILE = '5ca4d855dddb4d83093d0dc472e11b71f5b228349f23e025e1cbf8ee888a32dd'
CONTRACT = '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e'
DEPLOYED = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09'
CANDIDATE = '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726'
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z')
HEX = re.compile(r'[a-f0-9]{64}\Z')
FIXTURE = {
    'id': 'fz3b-pillow-scene-v1', 'imageCount': 1, 'width': 914, 'height': 512,
    'manifestSha256': 'febcb9d93517f3c98eadb5d98eea6808f243fb6a1d4b61215cd981503de98e56',
    'queriesSha256': '0d10e566bb1c167d3987e8d782f1c0c6f87ee3c1aaba9983afe1f8a134e106e9',
    'imageSha256': '06dd779d1450c835255833be19c84f6636c2de99313713d80c850fa572c25967',
    'queryIds': ['pillow', 'cup', 'mobile-phone', 'bottle'],
    'encoderIdentity': {
        'contractId': CONTRACT, 'normalization': 'l2-float32-v1',
        'weightSha256': '1270fab6ea23bacbd61cea564bd521a7e875fdb0fcb6d31382bccf4d973b71a6',
        'bpeSha256': '924691ac288e54409236115652ad4aa250f48203de50a9e4722a6ecd48d6804a',
    },
}
SOURCE_PINS = {
    'engineering/fz3b/product/resources/manifest.json': 'b8db612a4c3c7d427d1fac36323c0b35f4bd1109cba092116415f5b9c0b03c07',
    'engineering/fz3b/product/resources/remote/remote.py': '7a675f09af5973e6fa69ad832a424df06ed7b9f04b45ed3ebd2b5c2851faf516',
    'engineering/fz3b/product/resources/remote/wire.py': '460bae822a42262c610541ef5e2b45423e588d3b43e749327a98aed8cc818710',
    'engineering/fz3b/product/resources/ps-src/vision_app/board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
    'engineering/fz3b/product/resources/ps-src/vision_app/board_runtime.py': 'd637298882c6f65a172e07e8c7ed65a816c49922e005a567f633c5d4364eb95e',
    'engineering/fz3b/product/resources/ps-src/vision_app/protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
    'engineering/fz3b/product/resources/ps-src/vision_app/upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
    'engineering/fz3b/product/resources/ps-src/vision_app/r5_bridge.py': 'c1695156be3ab7622dcd9af91824606da3600f1d1fd0fac7206e7fd49d93642d',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def load_json(raw):
    require(type(raw) is bytes and len(raw) <= 4 * 1024 * 1024, 'json-budget')
    def pairs(items):
        value = {}
        for key, child in items:
            require(key not in value, 'duplicate-json-key')
            value[key] = child
        return value
    def invalid(_):
        raise ValueError('nonfinite-json')
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=invalid)
    pending, count = [(value, 0)], 0
    while pending:
        child, depth = pending.pop()
        count += 1
        require(depth <= 40 and count <= 100000, 'json-structure-budget')
        if type(child) is dict: pending.extend((item, depth + 1) for item in child.values())
        elif type(child) is list: pending.extend((item, depth + 1) for item in child)
        elif type(child) is float: require(math.isfinite(child), 'nonfinite-json')
    return value


def baseline_from_report(raw, relative, expected_sha):
    require(type(expected_sha) is str and HEX.fullmatch(expected_sha) and sha(raw) == expected_sha, 'baseline-byte-binding')
    require(relative.startswith(('output/qa/2026-10-16-fz3b-051/', OUTPUT + '/')) and relative.endswith('/evidence.json'), 'baseline-location')
    report = load_json(raw)
    require(report.get('result') == 'passed' and report.get('failures') == [] and report.get('pageErrors') == [], 'baseline-not-accepted')
    run = report.get('run', {})
    require(run.get('active') is False and run.get('hardwareBusy') is False and run.get('profileSha256') == PROFILE, 'baseline-not-terminal')
    operations = run.get('operations')
    require(type(operations) is list and len(operations) <= 16 and all(
        op.get('status') == 'succeeded' and op.get('processExited') is True and op.get('remoteQuiescent') is True for op in operations), 'baseline-operation-unsettled')
    semantic_ops = [op for op in operations if op.get('kind') == 'semantic']
    require(len(semantic_ops) == 1, 'baseline-semantic-count')
    operation, grant, semantic, identity = semantic_ops[0], run.get('grant', {}), run.get('semantic', {}), run.get('identity', {})
    require(UUID.fullmatch(operation.get('id', '')) and HEX.fullmatch(operation.get('nonce', ''))
            and UUID.fullmatch(grant.get('id', '')) and grant.get('consumedBy') == operation['id']
            and grant.get('profileSha256') == PROFILE and run.get('nativeApproval') == 'approved', 'baseline-grant-binding')
    require(semantic.get('jobId') == 'fd-semantic-' + operation['id'].replace('-', '')
            and type(semantic.get('queryRevision')) is int and semantic['queryRevision'] > 0
            and type(semantic.get('completedFrames')) is int and semantic['completedFrames'] == 1
            and semantic.get('inferenceStopped') is True and semantic.get('synthetic') is False
            and semantic.get('semanticInput') == 'real-text-encoder' and semantic.get('newPlLoaded') is False
            and semantic.get('encoderIdentity') == FIXTURE['encoderIdentity'], 'baseline-semantic-binding')
    require(all(semantic.get(key) == FIXTURE[fixed] for key, fixed in (
        ('fixtureManifestSha256', 'manifestSha256'), ('queriesSha256', 'queriesSha256'), ('imageSha256', 'imageSha256'))), 'baseline-fixture-binding')
    require(identity.get('bootId') == BOOT and identity.get('appRoot') == APP and identity.get('contractId') == CONTRACT
            and identity.get('deployedManifestSha256') == DEPLOYED and identity.get('existingPlSha256') == CANDIDATE, 'baseline-target-binding')
    return {'relativeFile': relative, 'sha256': expected_sha, 'operationId': operation['id'], 'nonce': operation['nonce'],
            'grantId': grant['id'], 'profileSha256': PROFILE, 'semanticSha256': sha(canonical(semantic)),
            'jobId': semantic['jobId'], 'queryRevision': semantic['queryRevision'], 'completedFrames': 1}


def checked_status(value, job, revision):
    require(type(value) is dict and value.get('type') in ('hello', 'status') and type(value.get('protocol')) is int
            and value['protocol'] == 1 and value.get('boot_id') == BOOT and value.get('contract_id') == CONTRACT
            and value.get('platform') == 'A0005' and value.get('input_source') == 'upload'
            and value.get('cpu_frequency_changing') is False and type(value.get('query_revision')) is int
            and value['query_revision'] == revision, 'status-identity')
    inference, upload = value.get('inference'), value.get('upload')
    require(type(inference) is dict and inference.get('state') in ('STARTING', 'RUNNING', 'DRAINING', 'STOPPED', 'FAILED')
            and 'error' in inference and inference['error'] is None, 'status-inference')
    require(type(upload) is dict and upload.get('job_id') == job and upload.get('error') is None, 'status-job')
    require(all(type(upload.get(key)) is int and 0 <= upload[key] <= 1 for key in ('received', 'completed', 'queued'))
            and upload['completed'] + upload['queued'] <= upload['received'], 'status-upload-counters')
    return inference, upload


def active_sample(value, job, revision):
    inference, upload = checked_status(value, job, revision)
    require(inference['state'] == 'RUNNING' and upload['received'] == 1 and upload['completed'] == 0
            and upload.get('cancelled') is False and upload.get('finished') is True, 'active-window-not-observed')
    return {'jobId': job, 'queryRevision': revision, 'received': 1, 'completed': 0, 'queued': upload['queued'],
            'outstandingNotQueued': 1 - upload['queued'], 'hardwareInflightAttested': False}


def terminal_sample(value, job, revision):
    inference, upload = checked_status(value, job, revision)
    require(inference['state'] == 'STOPPED' and upload['received'] == 1 and upload['queued'] == 0
            and upload.get('cancelled') is True and upload.get('finished') is True, 'cancelled-terminal-not-confirmed')
    return {'jobId': job, 'queryRevision': revision, 'completed': upload['completed'], 'cancelled': True,
            'inferenceStopped': True, 'semanticSucceeded': False}


def cancel_command(job, request_id):
    require(type(job) is str and re.fullmatch(r'fd-recovery-[a-f0-9]{32}', job), 'fixed-job-required')
    require(type(request_id) is str and re.fullmatch(r'cancel-[a-f0-9]{32}', request_id), 'fixed-request-required')
    return {'op': 'upload_cancel', 'job_id': job, 'request_id': request_id}


class FixtureTrial(object):
    """Pure event policy, not a runtime adapter or simulated hardware acceptance."""
    def __init__(self, action, job, revision):
        require(action in ACTIONS, 'action-not-fixed')
        cancel_command(job, 'cancel-' + '0' * 32)
        require(type(revision) is int and revision > 1, 'revision-not-fresh')
        self.action, self.job, self.revision = action, job, revision
        self.product = self.ps = self.owner_closed = self.observer_closed = False
        self.metadata = self.product_snapshot = None
        self.active = self.terminal = self.observed_terminal = None
        self.fault_count = 0
        self.not_covered = False
        self.quiet_scans = []
        self.unknown = False

    def event(self, name, value=None):
        try:
            require(not self.unknown, 'fixture-already-unknown')
            if name == 'product-held':
                require(not self.product and not self.ps and type(value) is dict, 'product-lock-order')
                self.product = True; self.product_snapshot = copy.deepcopy(value)
            elif name == 'ps-held':
                require(self.product and not self.ps, 'ps-lock-order'); self.ps = True
            elif name == 'metadata-before':
                require(self.product and self.ps and self.metadata is None and type(value) is dict, 'metadata-order')
                require(value.get('bootId') == BOOT and value.get('appRoot') == APP and value.get('contractId') == CONTRACT
                        and value.get('deployedManifestSha256') == DEPLOYED and value.get('existingPlSha256') == CANDIDATE, 'metadata-target-binding')
                self.metadata = copy.deepcopy(value)
            elif name == 'active':
                require(self.metadata is not None and self.fault_count == 0 and self.active is None, 'active-order')
                self.active = active_sample(value, self.job, self.revision)
            elif name == 'fault':
                require(self.active is not None and self.fault_count == 0 and value == self.action, 'single-fault-required')
                self.fault_count = 1
                if self.action == 'tcp-close': self.owner_closed = True
            elif name == 'cancel-ack':
                require(self.action == 'upload-cancel' and self.fault_count == 1 and type(value) is dict
                        and value.get('type') == 'ack' and value.get('op') == 'upload_cancel' and value.get('ok') is True
                        and value.get('request_id') == 'cancel-' + self.job[len('fd-recovery-'):], 'cancel-ack-binding')
                upload = value.get('result', {})
                require(upload.get('job_id') == self.job and upload.get('cancelled') is True
                        and type(upload.get('queued')) is int and upload['queued'] == 0, 'cancel-ack-state')
                self.cancel_ack = True
            elif name == 'not-covered':
                require(self.metadata is not None and self.active is None and self.fault_count == 0, 'missed-window-order')
                inference, upload = checked_status(value, self.job, self.revision)
                require(inference['state'] == 'STOPPED' and upload.get('finished') is True and upload.get('cancelled') is False
                        and upload['received'] == upload['completed'] == 1 and upload['queued'] == 0, 'missed-window-not-terminal')
                self.not_covered = True; self.terminal = copy.deepcopy(value)
            elif name == 'terminal':
                require(self.fault_count == 1 and (self.action == 'tcp-close' or getattr(self, 'cancel_ack', False)), 'terminal-order')
                self.terminal = terminal_sample(value, self.job, self.revision)
            elif name == 'owner-closed':
                require((self.fault_count == 1 or self.not_covered) and (self.action == 'tcp-close' or self.terminal is not None), 'owner-close-order')
                self.owner_closed = True
            elif name == 'observer-terminal':
                require(self.owner_closed and self.terminal is not None, 'observer-must-be-sequential')
                if self.not_covered: require(value == self.terminal, 'missed-terminal-changed')
                else: require(terminal_sample(value, self.job, self.revision) == self.terminal, 'observer-terminal-changed')
                self.observed_terminal = True
            elif name == 'observer-closed':
                require(self.observed_terminal is True, 'observer-close-order'); self.observer_closed = True
            elif name == 'quiet-scan':
                require(self.observer_closed and len(self.quiet_scans) < 2 and type(value) is dict, 'quiet-scan-order')
                require(value.get('completePass') is True and value.get('deviceOpened') is False
                        and value.get('deviceOwners') == [] and value.get('controlConnections') == []
                        and value.get('stdinInspectors') == [] and value.get('newPidsAtEnd') == []
                        and type(value.get('selfExcluded')) is dict, 'quiet-scan-not-clean')
                own = value['selfExcluded']
                require(type(own.get('pid')) is int and own['pid'] > 0 and type(own.get('startTicks')) is int
                        and own['startTicks'] >= 0, 'quiet-audit-identity-invalid')
                if self.quiet_scans: require(value['selfExcluded'] == self.quiet_scans[0]['selfExcluded'], 'quiet-audit-identity-drift')
                self.quiet_scans.append(copy.deepcopy(value))
            elif name == 'metadata-after':
                require(len(self.quiet_scans) == 2 and value == self.metadata, 'metadata-drift')
                self.metadata_stable = True
            elif name == 'product-recheck':
                require(getattr(self, 'metadata_stable', False) and value == self.product_snapshot, 'journal-drift')
                self.journal_stable = True
            elif name == 'release':
                raise ValueError('strict-finalization-and-cross-entry-quarantine-not-implemented')
            else:
                raise ValueError('event-not-fixed')
        except Exception:
            if self.ps: self.unknown = True
            raise
        return self.receipt()

    def receipt(self):
        qualified = getattr(self, 'journal_stable', False) and not self.unknown and not self.not_covered
        return {'fixtureOnly': True, 'executed': False, 'action': self.action, 'faultCount': self.fault_count,
                'activeObserved': self.active is not None, 'terminalObserved': self.terminal is not None,
                'qualifiedFixture': qualified, 'unknown': self.unknown, 'durableLeaseRetained': self.ps,
                'notCovered': self.not_covered,
                'kernelFlockSurvivesProcessExit': False, 'crossEntrypointQuarantineImplemented': False,
                'realHardwarePassed': False, 'automaticRetry': False, 'serviceActions': False}


def host_path(root, relative):
    require(type(relative) is str and '\\' not in relative and not relative.startswith('/')
            and all(part not in ('', '.', '..') for part in relative.split('/')), 'host-path-invalid')
    current = root
    require(os.path.normcase(os.path.realpath(root)) == os.path.normcase(root), 'host-root-linked')
    for part in relative.split('/'):
        current = os.path.join(current, part)
        info = os.lstat(current)
        require(not stat.S_ISLNK(info.st_mode) and not getattr(info, 'st_file_attributes', 0) & 1024, 'host-path-linked')
    return current


def host_read(root, relative, limit):
    filename = host_path(root, relative)
    named_before = os.lstat(filename)
    require(stat.S_ISREG(named_before.st_mode) and named_before.st_nlink == 1 and named_before.st_size <= limit, 'host-input-metadata')
    identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_nlink)
    with open(filename, 'rb') as stream:
        before = os.fstat(stream.fileno()); raw = stream.read(limit + 1); after = os.fstat(stream.fileno())
    require(identity(before) == identity(after) and identity(named_before) == identity(os.lstat(filename)), 'host-input-changed')
    a, b = identity(before), identity(named_before)
    if os.name == 'nt': a, b = a[:4] + a[5:], b[:4] + b[5:]
    require(a == b and len(raw) == named_before.st_size, 'host-open-identity')
    return raw


def prepare(action, baseline_relative, expected_sha, run_id):
    require(action in ACTIONS and run_id.startswith('active-recovery-') and UUID.fullmatch(run_id[len('active-recovery-'):]), 'fresh-fixed-run-required')
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '../../..'))
    baseline = baseline_from_report(host_read(root, baseline_relative, 4 * 1024 * 1024), baseline_relative, expected_sha)
    for relative, pin in SOURCE_PINS.items(): require(sha(host_read(root, relative, 1024 * 1024)) == pin, 'source-pin-changed:' + relative)
    fixture_root = 'engineering/fz3b/product/resources/fixture/'
    for name, key in (('encoding-manifest.json', 'manifestSha256'), ('query-template.json', 'queriesSha256'), ('input.jpg', 'imageSha256')):
        require(sha(host_read(root, fixture_root + name, 1024 * 1024)) == FIXTURE[key], 'fixture-pin-changed')
    relative = OUTPUT + '/' + run_id
    parent = host_path(root, OUTPUT); require(stat.S_ISDIR(os.lstat(parent).st_mode), 'output-parent-not-directory')
    source = host_read(root, 'engineering/fz3b/tools/active_recovery_trial.py', 128 * 1024)
    # Definitions only, with a fail-closed tail even if someone sends this template to Python.
    template = source[:source.index(b'\nif __name__ == ')] + b"\nraise SystemExit('PHASE1_EXECUTION_DISABLED: no runtime adapter/finalization/quarantine')\n"
    compile(template, '<phase1-never-execute>', 'exec')
    plan = {'schemaVersion': 1, 'method': METHOD, 'runId': run_id, 'action': action,
            'jobId': 'fd-recovery-' + run_id[len('active-recovery-'):].replace('-', ''),
            'bootId': BOOT, 'appRoot': APP, 'endpoint': {'host': '127.0.0.1', 'port': 8765},
            'fixture': FIXTURE, 'baseline': baseline, 'sourcePins': SOURCE_PINS, 'toolSha256': sha(source),
            'stdinRelativeFile': relative + '/phase1-disabled.py', 'stdinSha256': sha(template),
            'nativeApprovalRequired': True, 'automaticRetry': False, 'changesPL': False,
            'mayPrepareExistingCandidate': True, 'statusMayWriteR5Telemetry': True,
            'executionEnabled': False, 'blocker': ';'.join(BLOCKERS), 'executionBlockers': list(BLOCKERS),
            'crossEntrypointDurableQuarantineImplemented': False, 'strictFinalizationImplemented': False,
            'purpose': 'independent-native-qa-not-product-grant', 'executed': False}
    directory = os.path.join(root, relative); os.mkdir(directory, 0o700)
    for name, raw in (('phase1-disabled.py', template), ('plan.json', canonical(plan) + b'\n')):
        host_path(root, relative)
        with open(os.path.join(directory, name), 'xb') as stream:
            require(stream.write(raw) == len(raw), 'prepare-short-write'); stream.flush(); os.fsync(stream.fileno())
    return {'relativeFile': relative + '/plan.json', 'planSha256': sha(canonical(plan) + b'\n'), 'executionEnabled': False, 'executed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare', choices=ACTIONS, required=True)
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--baseline-sha256', required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.prepare, args.baseline, args.baseline_sha256, args.run_id), sort_keys=True))
