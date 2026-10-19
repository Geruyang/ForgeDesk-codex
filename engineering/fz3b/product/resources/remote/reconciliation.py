"""Fixed read-only reconciliation proof. Exec after the unchanged pinned remote.py.

No APP connection, HELLO, journal acquisition/write, loader, reset or service action.
The proof is point-in-time observation, not an exclusion lock against external root.
"""


def stdin_from_prefix(read_byte):
    executable = bytearray()
    for _ in range(256):
        byte = read_byte()
        if byte in (b'', b'\0'):
            break
        executable.extend(byte)
    else:
        raise ValueError('proc-argv0-prefix-budget')
    if not re.fullmatch(br'python(?:[0-9]+(?:\.[0-9]+)*)?', bytes(executable).rsplit(b'/', 1)[-1]):
        return False
    for position in range(2):
        token = bytearray()
        for _ in range(3):
            byte = read_byte()
            if byte in (b'', b'\0'):
                break
            token.extend(byte)
        token = bytes(token)
        if token in (b'', b'-', b'-c'):
            return True
        if token == b'-m' or not token.startswith(b'-'):
            return False
        require(position == 0 and token == b'-B', 'unknown-python-prefix-not-cleared')
    raise ValueError('unknown-python-prefix-not-cleared')


def proc_is_inspector(pid):
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    leaf = None
    try:
        for part in ('proc', str(pid)):
            opened = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = opened
        leaf = os.open('cmdline', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        require(stat.S_ISREG(os.fstat(leaf).st_mode), 'proc-cmdline-not-regular')
        return stdin_from_prefix(lambda: os.read(leaf, 1))
    finally:
        if leaf is not None:
            os.close(leaf)
        os.close(directory)


def stdin_inspectors():
    result = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit() or int(entry) == os.getpid():
            continue
        try:
            if proc_is_inspector(int(entry)):
                result.append(int(entry))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return sorted(result)


def readonly_journal_scan():
    try:
        info = os.lstat(JOURNAL)
    except FileNotFoundError:
        return 0
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700, 'journal-directory-untrusted')
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in JOURNAL.strip('/').split('/'):
            opened = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = opened
        opened_info = os.fstat(directory)
        require((info.st_dev, info.st_ino) == (opened_info.st_dev, opened_info.st_ino), 'journal-directory-changed')
        names = os.listdir(directory)
        require(len(names) <= 1024, 'journal-entry-budget')
        unfinished = 0
        for name in names:
            require(name == 'active.lock' or re.fullmatch(r'[a-zA-Z0-9_-]+\.json', name), 'journal-unexpected-file')
            entry_info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            require(stat.S_ISREG(entry_info.st_mode) and entry_info.st_uid == 0 and entry_info.st_nlink == 1 and stat.S_IMODE(entry_info.st_mode) == 0o600, 'journal-file-untrusted')
            if name.endswith('.json'):
                record = json.loads(safe_read(JOURNAL + '/' + name, 32768).decode('ascii'))
                if record.get('status') not in ('succeeded', 'failed') or record.get('remoteQuiescent') is not True:
                    unfinished += 1
        require(names == os.listdir(directory), 'journal-inventory-changed')
        return unfinished
    finally:
        os.close(directory)


def reconcile_readonly(request):
    require(request.get('schemaVersion') == 1 and request.get('action') == 'reconcile_inspect', 'reconciliation-action')
    for field in ('id', 'originalOperationId'):
        require(type(request.get(field)) is str and re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', request[field]), 'reconciliation-id')
    for field in ('nonce', 'contextSha256', 'profileSha256'):
        require(type(request.get(field)) is str and re.fullmatch(r'[0-9a-f]{64}', request[field]), 'reconciliation-binding')
    before = metadata()
    for _ in range(2):
        observed = idle_scan()
        inspectors = stdin_inspectors()
        unfinished = readonly_journal_scan()
        require(not observed['deviceOwners'] and observed['controlConnections'] == 0 and not inspectors and unfinished == 0, 'reconciliation-not-quiescent')
        time.sleep(.1)
    after = metadata()
    require(before == after, 'reconciliation-metadata-changed')
    return {'schemaVersion': 1, 'id': request['id'], 'nonce': request['nonce'], 'contextSha256': request['contextSha256'],
            'profileSha256': request['profileSha256'], 'status': 'succeeded', 'identity': after,
            'remote': {'readOnly': True, 'metadataStable': True, 'deviceOwners': [], 'controlConnections': 0,
                       'inspectorPids': [], 'unfinishedJournalEntries': 0, 'scanCount': 2,
                       'procScanComplete': True, 'journalScanComplete': True, 'originalInspectorAbsent': True}}


def forgedesk_reconcile(request):
    try:
        answer = reconcile_readonly(request)
    except BaseException as error:
        answer = {'schemaVersion': 1, 'id': request.get('id'), 'nonce': request.get('nonce'),
                  'contextSha256': request.get('contextSha256'), 'profileSha256': request.get('profileSha256'),
                  'status': 'failed', 'detail': type(error).__name__ + ':' + str(error)[:256]}
    print(json.dumps(answer, sort_keys=True, separators=(',', ':'), allow_nan=False), flush=True)
