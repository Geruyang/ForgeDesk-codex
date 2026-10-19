"""Installed fixed FZ3B metadata/one-image worker. Python 3.6 standard library.

Executed only as pinned source over pinned SSH stdin. No deployment, service
management, PL switch, driver install, reset, arbitrary command, or model input.
"""
import base64
import fcntl
import hashlib
import json
import math
import os
import re
import socket
import stat
import struct
import subprocess
import time
import types

APP = '/root/fz3b-vision-console-20261009-001'
BOOT = '5ceb45a3-8903-4efc-9484-ec75c17280df'
CONTRACT = '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e'
DEPLOYED = 'd0740647bdb4a505414e626839c5eff811091b25612e09cce5487a459a631c09'
BIT_PATH = '/root/rtl_optim-board-20261010/candidate008/cnn_rtl.bit'
BIT_SHA = '78038efd603cde7763a1b3ff4581b799cabd1a11395db2d78af33b7c81d46726'
BACKUP = APP + '/.forgedesk-ps-backups/ps-security-1792122514610/manifest.json'
BACKUP_SHA = 'a478fd7f12b15bc5a39d84e074d0d929b049a4a862c7a618c2d8edaffa9df1d1'
JOURNAL = APP + '/.forgedesk-product-operations'
EXPECTED_FILES = {
    APP + '/vision_app/board_agent.py': '6a769109783596c566fe930a10e8d41b7e9b968053fca1ec3f8ea48104ac4c6a',
    APP + '/vision_app/camera.py': 'a0b954e7c5fef1d3d441055891db9109038dc61b324458a0082055d7dddcc5c2',
    APP + '/vision_app/image_boundary.py': '653327b2fadbb10ac219895fd5babaa498f2eabcec8075320b007e453e4e9057',
    APP + '/vision_app/protocol.py': 'c2c3583d8e8bcf07ff0a4307bd7c59da7597a08cc3b4aee9d5e542eac1463c37',
    APP + '/vision_app/upload_source.py': 'c96c0ac23d2f037c2f56403de74a987b6dfc02ce75e9fd0c5445c219172d8249',
    APP + '/config.json': 'e297d39d4d6cf0e329cec325b8af945c0addda252802293ebd0ec79ca60acef2',
    APP + '/vision_app/semantic-contract.json': '5f2f281ff7d3f92539a96f42728bd0dcdf5e70d07c98a00cff7f07fdb64aac87',
    '/root/workspace/network10-v10.5-pl-loader/fz3b_pl_loader.py': 'aaa7f5ba913252f7f298eee6f025615c3eccb1ef09928d1e6724caff9a64101d',
    '/root/rtl_optim-board-20261010/candidate008/rtl-loader-config.json': '10d5878bcc40278f47995453662099fdc5814ed42fbd68973c1161a5664c81c8',
    '/etc/systemd/system/fz3b-pl-loader.service.d/rtl-optim-retained.conf': 'b2520099c6d021a2697c716a293359c44fabae2e6cb00ee9b950f092c9bed553',
}
QUERY_IDS = ['pillow', 'cup', 'mobile-phone', 'bottle']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def safe_read(path, limit):
    parts = path.strip('/').split('/')
    require(path.startswith('/') and all(part not in ('', '.', '..') for part in parts), 'fixed-path-invalid')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    leaf = None
    try:
        for part in parts[:-1]:
            opened = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = opened
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        before = os.fstat(leaf)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 <= before.st_size <= limit, 'fixed-file-metadata')
        raw = bytearray()
        while len(raw) <= limit:
            chunk = os.read(leaf, min(16384, limit + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
        after = os.fstat(leaf)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime, value.st_ctime)
        require(len(raw) <= limit and identity(before) == identity(after), 'fixed-file-changed')
        return bytes(raw)
    finally:
        if leaf is not None:
            os.close(leaf)
        os.close(directory)


def service_pid():
    answer = subprocess.run(['/bin/systemctl', 'show', 'fz3b-vision-console.service', '--no-pager',
                             '--property=ActiveState,SubState,MainPID'], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
                            shell=False, close_fds=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C', 'SYSTEMD_PAGER': 'cat'})
    require(answer.returncode == 0 and len(answer.stdout) <= 4096, 'service-metadata-unavailable')
    value = dict(line.split('=', 1) for line in answer.stdout.decode('ascii').splitlines())
    require(value.get('ActiveState') == 'active' and value.get('SubState') == 'running' and value.get('MainPID', '').isdigit(), 'service-not-active')
    require(int(value['MainPID']) > 1, 'service-pid-invalid')
    return int(value['MainPID'])


def metadata():
    require(safe_read('/proc/sys/kernel/random/boot_id', 128).decode('ascii').strip() == BOOT, 'boot-changed')
    hashes = {}
    for path, expected in EXPECTED_FILES.items():
        actual = sha(safe_read(path, 262144))
        require(actual == expected, 'deployed-file-mismatch:' + path.rsplit('/', 1)[-1])
        hashes[path] = actual
    backup = safe_read(BACKUP, 32768)
    require(sha(backup) == BACKUP_SHA and json.loads(backup.decode('utf-8')).get('approved_manifest_sha256') == DEPLOYED, 'approved-deployment-manifest-mismatch')
    require(sha(safe_read(BIT_PATH, 8 * 1024 * 1024)) == BIT_SHA, 'existing-candidate008-artifact-mismatch')
    contract = json.loads(safe_read(APP + '/vision_app/semantic-contract.json', 32768).decode('utf-8'))
    require(contract.get('contract_id') == CONTRACT, 'contract-mismatch')
    return {'bootId': BOOT, 'appRoot': APP, 'platform': 'A0005', 'contractId': CONTRACT,
            'deployedManifestSha256': DEPLOYED, 'existingPlSha256': BIT_SHA,
            'mainPid': service_pid(), 'deployedFileSha256': hashes,
            'loadedPlAttested': False}


def idle_scan():
    owners = []
    device = os.stat('/dev/network10_v10_signed40')
    require(stat.S_ISCHR(device.st_mode), 'fixed-device-not-character')
    for entry in os.listdir('/proc'):
        if not entry.isdigit():
            continue
        directory = '/proc/' + entry + '/fd'
        try:
            for name in os.listdir(directory):
                try:
                    target = os.readlink(directory + '/' + name)
                    opened = os.stat(directory + '/' + name)
                except FileNotFoundError:
                    continue
                if target.startswith('/dev/network10_v10_signed40') or (stat.S_ISCHR(opened.st_mode) and opened.st_rdev == device.st_rdev):
                    owners.append(int(entry))
        except FileNotFoundError:
            continue
    connections = 0
    for table in ('/proc/%d/net/tcp' % os.getpid(), '/proc/%d/net/tcp6' % os.getpid()):
        for line in safe_read(table, 1048576).decode('ascii').splitlines()[1:]:
            fields = line.split()
            if len(fields) > 3 and fields[1].rsplit(':', 1)[-1].upper() == '223D' and fields[3] in ('01', '08'):
                connections += 1
    return {'deviceOwners': sorted(set(owners)), 'controlConnections': connections}


def require_idle(seconds=8):
    end = time.monotonic() + seconds
    clean = 0
    last = None
    while time.monotonic() < end:
        last = idle_scan()
        if not last['deviceOwners'] and last['controlConnections'] == 0:
            clean += 1
            if clean == 2:
                return last
        else:
            clean = 0
        time.sleep(.1)
    raise ValueError('remote-quiescence-not-confirmed:' + json.dumps(last))


def write_journal(path, value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False) + '\n').encode('ascii')
    temporary = path + '.tmp'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.rename(temporary, path)
        directory = os.open(JOURNAL, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def acquire_journal(request):
    try:
        os.mkdir(JOURNAL, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(JOURNAL)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'journal-directory-untrusted')
    lock = os.open(JOURNAL + '/active.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        lock_info = os.fstat(lock)
        require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_nlink == 1 and lock_info.st_uid == 0 and stat.S_IMODE(lock_info.st_mode) == 0o600, 'journal-lock-untrusted')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in os.listdir(JOURNAL):
            require(name == 'active.lock' or re.fullmatch(r'[a-zA-Z0-9_-]+\.json', name), 'journal-unexpected-file')
            if name.endswith('.json'):
                previous = json.loads(safe_read(JOURNAL + '/' + name, 32768).decode('ascii'))
                require(previous.get('status') in ('succeeded', 'failed') and previous.get('remoteQuiescent') is True, 'unresolved-remote-operation-no-replay')
        record = JOURNAL + '/' + request['operationId'] + '.json'
        require(not os.path.lexists(record), 'operation-already-recorded-no-replay')
        write_journal(record, {'schemaVersion': 1, 'operationId': request['operationId'], 'nonce': request['nonce'],
                               'profileSha256': request['profileSha256'], 'grantId': request['grant']['id'],
                               'status': 'intent', 'remoteQuiescent': False})
        return lock, record
    except BaseException:
        os.close(lock)
        raise


def checked_fixture(request):
    fixture = request['fixture']
    query_raw = base64.b64decode(request['queriesB64'], validate=True)
    image = base64.b64decode(request['imageB64'], validate=True)
    require(sha(query_raw) == fixture['queriesSha256'] and sha(image) == fixture['imageSha256'] and len(image) == 144219, 'fixture-byte-binding')
    require(fixture['id'] == 'fz3b-pillow-scene-v1' and fixture['imageSha256'] == '06dd779d1450c835255833be19c84f6636c2de99313713d80c850fa572c25967', 'fixture-not-fixed')
    query = json.loads(query_raw.decode('utf-8'))
    require(query.get('op') == 'queries' and [item['id'] for item in query['items']] == QUERY_IDS, 'query-closed-set')
    raw = base64.b64decode(query['features_f32_b64'], validate=True)
    require(len(raw) == 4 * 512 * 4, 'query-extent')
    rows = []
    for row in range(4):
        values = struct.unpack('<512f', raw[row * 2048:(row + 1) * 2048])
        require(all(math.isfinite(value) for value in values) and sum(value != 0 for value in values) >= 64 and abs(sum(value * value for value in values) - 1) < .0001, 'query-normalization-or-synthetic')
        rows.append(sha(raw[row * 2048:(row + 1) * 2048]))
    require(len(set(rows)) == 4, 'duplicate-query-embeddings')
    identity = query['identity']
    expected = fixture['encoderIdentity']
    require(identity['contract_id'] == expected['contractId'] == CONTRACT and identity['weight_sha256'] == expected['weightSha256'] and
            identity['bpe_sha256'] == expected['bpeSha256'] and identity['normalization'] == expected['normalization'] == 'l2-float32-v1', 'query-encoder-identity')
    return query, image


def semantic(request, wire, before_identity, received_at):
    grant = request.get('grant')
    require(type(grant) is dict and grant.get('consumedBy') == request['operationId'] and grant.get('profileSha256') == request['profileSha256'] and
            grant.get('scope') == 'existing-candidate008-real-text-single-image-once' and grant.get('approvedAt'), 'native-grant-missing')
    remaining = request.get('grantRemainingMs')
    require(type(remaining) in (int, float) and math.isfinite(remaining) and 0 < remaining <= 300000 and
            time.monotonic() - received_at < remaining / 1000.0, 'native-grant-expired')
    query, image = checked_fixture(request)
    lock, record = acquire_journal(request)
    client = None
    side_effect = False
    try:
        deadline = wire.Deadline(210)
        client = wire.Client(deadline)
        before = wire.stopped(client.hello())
        require(before.get('boot_id') == BOOT and before['threshold'] == .2 and before.get('cpu_frequency_changing') is False, 'application-not-fixed-idle')
        before = wire.stopped(client.status())
        revision = before['query_revision'] + 1
        fields = {key: value for key, value in query.items() if key != 'op'}
        fields['revision'] = revision
        require(time.monotonic() - received_at < remaining / 1000.0, 'native-grant-expired')
        side_effect = True
        ack = client.command('queries', **fields)['result']
        require(ack.get('query_revision') == revision and ack.get('count') == 4, 'query-ack-mismatch')
        job = 'fd-semantic-' + request['operationId'].replace('-', '')
        ack = client.command('upload_begin', job_id=job)['result']
        require(ack.get('job_id') == job and 1 <= ack.get('credits', 0) <= 16, 'upload-ack-mismatch')
        meta = wire.json_bytes({'job_id': job, 'frame_id': 0, 'video_time_s': 0.0, 'width': 914, 'height': 512})
        client.send(struct.pack('<I', len(meta)) + meta + image, wire.INPUT_FRAME)
        finish = client.command('upload_finish', job_id=job, frame_count=1)['result']
        require(finish.get('job_id') == job and finish.get('received') == 1 and finish.get('finished') is True and not finish.get('cancelled') and finish.get('error') is None, 'upload-finish-mismatch')
        finish_sequence = client.messages
        client.status()
        while True:
            require(len(client.results) <= 1, 'extra-result')
            status_value = client.last_status
            require(status_value['boot_id'] == BOOT and status_value['inference']['state'] != 'FAILED' and status_value['inference']['error'] is None, 'inference-failed-or-boot-changed')
            if len(client.results) == 1 and client.last_status_sequence > max(client.result_sequence, finish_sequence) and status_value['inference']['state'] == 'STOPPED':
                break
            client.receive()
        result = client.results[0]
        require(result.get('source') == 'upload' and result.get('job_id') == job and result.get('frame_id') == 0 and result.get('video_time_s') == 0 and
                result.get('source_width') == 914 and result.get('source_height') == 512 and result.get('query_revision') == revision and result.get('identity') == query['identity'], 'result-binding-mismatch')
        ranking = result.get('ranking')
        require(type(ranking) is list and len(ranking) == 4 and sorted(item['id'] for item in ranking) == sorted(QUERY_IDS), 'ranking-closed-set')
        require(all(type(item.get('score')) in (int, float) and math.isfinite(item['score']) and -1 <= item['score'] <= 1 for item in ranking), 'ranking-nonfinite')
        require(all(ranking[index]['score'] >= ranking[index + 1]['score'] for index in range(3)), 'ranking-order')
        upload = status_value.get('upload') or {}
        require(upload.get('job_id') == job and upload.get('received') == 1 and upload.get('completed') == 1 and upload.get('queued') == 0 and
                upload.get('finished') is True and upload.get('cancelled') is False and upload.get('error') is None and status_value['inference']['frames'] == 1 and
                status_value['query_revision'] == revision and status_value['result_delivery_drops'] == before['result_delivery_drops'], 'terminal-counts-mismatch')
        client.close()
        client = None
        idle = require_idle()
        after_identity = metadata()
        require(after_identity == before_identity, 'metadata-changed-during-semantic')
        threshold_hit = ranking[0]['score'] >= .2
        output = {'jobId': job, 'frameId': 0, 'queryRevision': revision, 'completedFrames': 1,
                  'fixtureManifestSha256': request['fixture']['manifestSha256'], 'queriesSha256': request['fixture']['queriesSha256'],
                  'imageSha256': request['fixture']['imageSha256'], 'encoderIdentity': request['fixture']['encoderIdentity'],
                  'ranking': [{'id': item['id'], 'label': item['id'], 'score': item['score']} for item in ranking],
                  'bestId': ranking[0]['id'], 'semanticInput': 'real-text-encoder', 'synthetic': False,
                  'classificationUnknown': not threshold_hit, 'threshold': .2, 'thresholdHit': threshold_hit,
                  'expectedLabel': 'pillow', 'expectedLabelMatched': ranking[0]['id'] == 'pillow' and ranking[0]['score'] > max(item['score'] for item in ranking[1:]),
                  'inferenceStopped': True, 'newPlLoaded': False}
        write_journal(record, {'schemaVersion': 1, 'operationId': request['operationId'], 'nonce': request['nonce'],
                               'profileSha256': request['profileSha256'], 'grantId': grant['id'], 'status': 'succeeded', 'remoteQuiescent': True,
                               'semantic': output, 'idle': idle})
        return {'status': 'succeeded', 'remoteQuiescent': True, 'remoteOutcomeUnknown': False, 'semantic': output,
                'identity': before_identity, 'grantId': grant['id'], 'before': wire.summary(before), 'after': wire.summary(status_value), 'rawResult': result, 'idle': idle}
    except BaseException as error:
        # No reconnect/replay, service kill, implicit reset, or speculative recovery after a lost operation.
        failed = {'schemaVersion': 1, 'operationId': request['operationId'], 'nonce': request['nonce'], 'profileSha256': request['profileSha256'],
                  'grantId': grant['id'], 'status': 'unknown' if side_effect else 'failed', 'remoteQuiescent': False, 'detail': type(error).__name__ + ':' + str(error)}
        try:
            write_journal(record, failed)
        except BaseException:
            pass
        raise
    finally:
        try:
            if client is not None:
                client.close()
        finally:
            os.close(lock)


def forgedesk_main(request, wire_source):
    received_at = time.monotonic()
    result = {'schemaVersion': 1, 'operationId': request.get('operationId'), 'nonce': request.get('nonce'),
              'profileSha256': request.get('profileSha256'), 'status': 'failed', 'remoteQuiescent': False, 'remoteOutcomeUnknown': False}
    dispatched = False
    try:
        require(request.get('schemaVersion') == 1 and request.get('action') in ('inspect', 'semantic'), 'action-not-allowed')
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', request.get('operationId', '')) and re.fullmatch(r'[a-f0-9]{64}', request.get('nonce', '')) and re.fullmatch(r'[a-f0-9]{64}', request.get('profileSha256', '')), 'operation-binding-invalid')
        identity = metadata()
        idle = require_idle()
        result.update(identity=identity, idle=idle, remoteQuiescent=True)
        if request['action'] == 'semantic':
            wire = types.ModuleType('forgedesk_pinned_wire')
            exec(compile(wire_source, 'forgedesk-pinned-wire.py', 'exec'), wire.__dict__)
            dispatched = True
            result.update(semantic(request, wire, identity, received_at))
        else:
            result.update(status='succeeded', readOnly=True)
    except BaseException as error:
        result.update(status='unknown' if dispatched else 'failed', remoteQuiescent=False,
                      remoteOutcomeUnknown=dispatched, detail=type(error).__name__ + ':' + str(error))
    print(json.dumps(result, sort_keys=True, separators=(',', ':'), allow_nan=False))
