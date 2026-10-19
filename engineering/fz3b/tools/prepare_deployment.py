"""Offline, data-only FZ3B PS patch bundles. Never connects to a target."""
import argparse
import ast
import hashlib
import io
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile


UPSTREAM_COMMIT = '59cdbefade2535dbeea9a34d1658a307ab7f3bb7'
BASE_ARCHIVE_SHA256 = 'b847d3768a765625b421ba0e798d9d75f5673c980114fe7c15e1d7960b247d95'
POLICY = 'fz3b-ps-loopback-data-v2-gitcanonical'
PAYLOAD_PATHS = (
    'PS/config.example.json',
    'PS/vision_app/board_agent.py',
    'PS/vision_app/camera.py',
    'PS/vision_app/image_boundary.py',
    'PS/vision_app/protocol.py',
    'PS/vision_app/upload_source.py',
)
NON_DEPLOYED_PATCHES = frozenset(('HOST/vision_app/protocol.py', 'HOST/vision_app/transports.py', 'HOST/vision_app/video_analysis.py'))
MAX_FILE_BYTES = 512 * 1024
MAX_PAYLOAD_BYTES = 1024 * 1024
MAX_TAR_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 4 * 1024 * 1024
MAX_MANIFEST_BYTES = 64 * 1024
MAX_BASE_MEMBERS = 256


class BundleError(ValueError):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _canonical(path):
    if (type(path) is not str or not path or len(path) > 160 or
            re.fullmatch(r'[A-Za-z0-9_./-]+', path) is None or
            str(PurePosixPath(path)) != path or
            any(part in ('', '.', '..') or part.startswith('.') for part in path.split('/')) or
            PurePosixPath(path).is_absolute()):
        raise BundleError('noncanonical relative path')
    return path


def _no_link(path):
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise BundleError('symlink or reparse point is forbidden')
    return info


def _checked_path(path):
    absolute = Path(os.path.abspath(path))
    for part in reversed((absolute,) + tuple(absolute.parents)):
        _no_link(part)
    return absolute


def _read_file(path, limit):
    path = _checked_path(path)
    before = _no_link(path)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        raise BundleError('input must be a bounded, non-linked regular file')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(str(path), flags)
    with os.fdopen(descriptor, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size) != (before.st_dev, before.st_ino, before.st_size):
            raise BundleError('input changed before read')
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    final = _no_link(path)
    identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns)
    if len(data) > limit or identity(before) != identity(after) or identity(before) != identity(final):
        raise BundleError('input changed or exceeded limit')
    return data


def _tar_entries(data, base=False):
    if len(data) > MAX_TAR_BYTES or len(data) % 512:
        raise BundleError('tar size or block alignment is invalid')
    offset, entries, seen = 0, {}, set()
    while offset < len(data):
        header = data[offset:offset + 512]
        if header == bytes(512):
            if len(data) - offset < 1024 or any(data[offset:]):
                raise BundleError('tar contains hidden trailing data')
            return entries
        try:
            member = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
        except (tarfile.TarError, ValueError, UnicodeError) as error:
            raise BundleError('invalid tar header') from error
        name = _canonical(member.name.rstrip('/') if base and member.isdir() else member.name)
        if name in seen or len(seen) >= MAX_BASE_MEMBERS:
            raise BundleError('duplicate or excessive tar members')
        seen.add(name)
        if member.linkname or member.pax_headers or member.size < 0 or member.size > MAX_FILE_BYTES:
            raise BundleError('invalid tar member extent or metadata')
        end = offset + 512 + member.size
        next_offset = end + (-member.size % 512)
        if next_offset > len(data) or any(data[end:next_offset]):
            raise BundleError('truncated tar or nonzero member padding')
        # Only the already-pinned upstream Git archive may carry its exact commit comment.
        if base and offset == 0 and member.type == tarfile.XGLTYPE:
            expected = ('52 comment=' + UPSTREAM_COMMIT + '\n').encode('ascii')
            if member.name != 'pax_global_header' or data[offset + 512:end] != expected:
                raise BundleError('unrecognized upstream Git metadata')
            offset = next_offset
            continue
        if member.type != tarfile.REGTYPE and not (base and member.type == tarfile.DIRTYPE):
            raise BundleError('tar permits regular data files only, without links or extended headers')
        if member.isfile():
            if not base and (name not in PAYLOAD_PATHS or member.mode != 0o644 or member.uid != 0 or member.gid != 0 or member.mtime != 0 or member.uname or member.gname):
                raise BundleError('unexpected payload or uncontrolled tar permissions/ownership')
            entries[name] = data[offset + 512:end]
        elif member.size:
            raise BundleError('directory has data')
        offset = next_offset
    raise BundleError('tar end marker is missing')


def _base(path):
    data = _read_file(path, MAX_TAR_BYTES)
    if sha256(data) != BASE_ARCHIVE_SHA256:
        raise BundleError('base archive does not match the pinned upstream archive')
    entries = _tar_entries(data, base=True)
    expected = set(PAYLOAD_PATHS) - {'PS/vision_app/image_boundary.py'}
    if not expected.issubset(entries) or 'PS/vision_app/image_boundary.py' in entries:
        raise BundleError('pinned base does not have the expected patch topology')
    return entries


def _json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise BundleError('duplicate JSON key')
            result[key] = value
        return result
    def constant(_):
        raise BundleError('nonfinite JSON value')
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError, RecursionError) as error:
        raise BundleError('invalid JSON') from error


def _payload(path, data):
    if len(data) > MAX_FILE_BYTES or b'\0' in data:
        raise BundleError('payload must be bounded UTF-8 source data')
    if path.endswith('.py'):
        try:
            ast.parse(data.decode('utf-8'), filename=path)
        except (UnicodeError, SyntaxError) as error:
            raise BundleError('invalid Python source payload') from error
    else:
        config = _json(data)
        try:
            loopback = type(config) is dict and type(config.get('bind')) is str and ipaddress.IPv4Address(config['bind']).is_loopback
        except (ValueError, TypeError):
            loopback = False
        if not loopback:
            raise BundleError('config example must bind literal IPv4 loopback')
        def reject_secrets(value, depth=0):
            if depth > 16:
                raise BundleError('config example nesting exceeds its limit')
            if type(value) is dict:
                for key, item in value.items():
                    if key.lower() in ('token', 'password', 'secret', 'authorization', 'auth', 'sshkey', 'ssh_key', 'private_key', 'license'):
                        raise BundleError('inline credential fields are forbidden in the example')
                    reject_secrets(item, depth + 1)
            elif type(value) is list:
                for item in value:
                    reject_secrets(item, depth + 1)
        reject_secrets(config)


def _source(root, base):
    root = _checked_path(root)
    if not root.is_dir():
        raise BundleError('source root must be a directory')
    allowed = set(base) | set(PAYLOAD_PATHS)
    allowed_dirs = {str(parent) for name in allowed for parent in PurePosixPath(name).parents if str(parent) != '.'}
    found, total = {}, 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs:
            path = Path(directory) / name
            _no_link(path)
            if _canonical(path.relative_to(root).as_posix()) not in allowed_dirs:
                raise BundleError('unexpected source directory')
        for name in files:
            path = Path(directory) / name
            relative = _canonical(path.relative_to(root).as_posix())
            if relative not in allowed:
                raise BundleError('unexpected source file')
            data = _read_file(path, MAX_FILE_BYTES)
            total += len(data)
            if total > MAX_SOURCE_BYTES:
                raise BundleError('source tree exceeds its budget')
            if relative not in PAYLOAD_PATHS and relative not in NON_DEPLOYED_PATCHES and data != base.get(relative):
                raise BundleError('source changed outside the explicit security-patch policy')
            found[relative] = data
    if set(found) != allowed:
        raise BundleError('source tree has missing files')
    return found


def _json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + '\n').encode('ascii')


def _entry(path, data, base):
    example = path == 'PS/config.example.json'
    return {
        'path': path,
        'target': 'config.example.hardened.json' if example else path[len('PS/'):],
        'role': 'reference-only' if example else ('replace' if path in base else 'add'),
        'base_sha256': sha256(base[path]) if path in base else None,
        'new_sha256': sha256(data), 'bytes': len(data), 'mode': '0644',
        'deployed_base_requirement': 'not-auto-applied' if example else ('sha256-match' if path in base else 'must-not-exist'),
    }


def _data_tar(payload):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:', format=tarfile.USTAR_FORMAT) as archive:
        for path in PAYLOAD_PATHS:
            info = tarfile.TarInfo(path)
            info.size, info.mode, info.uid, info.gid, info.mtime = len(payload[path]), 0o644, 0, 0, 0
            archive.addfile(info, io.BytesIO(payload[path]))
    data = stream.getvalue()
    if len(data) > MAX_TAR_BYTES:
        raise BundleError('bundle tar exceeds its budget')
    return data


def _plan(manifest, manifest_sha256):
    patches = [entry for entry in manifest['files'] if entry['role'] != 'reference-only']
    return {
        'schema_version': 1, 'policy': POLICY, 'deployment_authorized': False,
        'offline_only': True, 'remote_actions_performed': [], 'manifest_sha256': manifest_sha256,
        'config_example_auto_apply': False, 'pl_changes_permitted': False,
        'gates': [{'id': name, 'status': 'unverified'} for name in (
            'review-exact-manifest-and-source', 'authenticated-ssh-root-and-target-identity',
            'ssh-and-required-tunnels-independently-confirmed', 'application-quiescence-without-pl-or-loader-actions',
            'deployed-root-binding-and-exact-base-hashes-or-absence', 'verified-backups-and-rollback-availability',
            'separate-explicit-loopback-config-migration', 'independent-loopback-status-and-negative-validation')],
        'network_transition': {
            'separate_configuration_step_required': True, 'ssh_authentication': 'unverified',
            'tunnel_status': 'unverified', 'public_udp_tcp_shutdown_authorized': False,
            'rule': 'Do not alter public bindings until authenticated SSH and required tunnels work independently; no bypass flag.',
        },
        'ordered_deployer_requirements': [
            'Bind an approved existing PS deployment root and independently verify each deployed base hash; additions must be absent. Reject symlinks/reparse points at every path component.',
            'Confirm application quiescence without invoking run.sh, service/loader/driver startup, R5, or PL programming. No such activation is authorized by this plan.',
            'Back up every replaced file with hash, metadata and verified restore location before any replacement. Record absent targets for removal on rollback.',
            'Stage verified payload bytes on the target filesystem with mode 0644 and approved ownership; use same-directory atomic replacement for each file. This is not a multi-file atomic transaction.',
            'Keep the config example separate. Migrate actual network configuration only through the separate SSH/tunnel gate, never by copying the example over current config.',
            'Independently validate loopback-only bindings, correlated status, malformed/oversized/unauthorized negative cases and unchanged PL/driver state; imported evidence alone is not authentication.',
            'On any failure, restore verified backups atomically and remove only the exact newly added files; revalidate the restored state. If rollback is not confirmed, retain a failed/unknown deployment lock.',
        ],
        'patch_preconditions': patches,
    }


def _prepare(source_root, base_archive):
    base = _base(base_archive)
    source = _source(source_root, base)
    payload = {path: source[path] for path in PAYLOAD_PATHS}
    for path, data in payload.items():
        _payload(path, data)
    if sum(map(len, payload.values())) > MAX_PAYLOAD_BYTES:
        raise BundleError('payload exceeds its total budget')
    tar = _data_tar(payload)
    if _source(source_root, base) != source:
        raise BundleError('source tree changed during planning')
    manifest = {
        'schema_version': 1, 'policy': POLICY, 'upstream_commit': UPSTREAM_COMMIT,
        'base_archive_sha256': BASE_ARCHIVE_SHA256,
        'source_snapshot_sha256': sha256(_json_bytes({name: sha256(data) for name, data in sorted(source.items())})),
        'bundle_sha256': sha256(tar), 'bundle_bytes': len(tar),
        'files': [_entry(path, payload[path], base) for path in PAYLOAD_PATHS],
        'excluded_non_deployed_source_changes': sorted(name for name in NON_DEPLOYED_PATCHES if source.get(name) != base.get(name)),
    }
    encoded = _json_bytes(manifest)
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise BundleError('manifest exceeds its budget')
    return manifest, encoded, tar, _plan(manifest, sha256(encoded))


def prepare_plan(source_root, base_archive):
    """Hash one local snapshot without writing it or authorizing deployment."""
    return _prepare(source_root, base_archive)[3]


def _write_outputs(output_dir, files):
    output = Path(os.path.abspath(output_dir))
    _checked_path(output.parent)
    output.mkdir(mode=0o700, exist_ok=False)
    for name, data in files.items():
        with open(output / name, 'xb') as stream:
            stream.write(data)
        os.chmod(output / name, 0o600)
    return output


def build_bundle(source_root, base_archive, output_dir):
    """Create a new local output directory; never overwrite or execute a bundle."""
    manifest, encoded, tar, plan = _prepare(source_root, base_archive)
    output = _write_outputs(output_dir, {'manifest.json': encoded, 'data.tar': tar, 'deployment-plan.json': _json_bytes(plan)})
    return {'result': 'passed', 'offline_only': True, 'deployment_authorized': False,
            'manifest_sha256': sha256(encoded), 'bundle_sha256': manifest['bundle_sha256'], 'output_dir': str(output)}


def verify_bundle(manifest_path, bundle_path, base_archive, expected_manifest_sha256):
    """Check integrity against a separately reviewed manifest hash, not remote state."""
    if type(expected_manifest_sha256) is not str or re.fullmatch('[0-9a-f]{64}', expected_manifest_sha256) is None:
        raise BundleError('a reviewed lowercase manifest SHA256 is required')
    encoded = _read_file(manifest_path, MAX_MANIFEST_BYTES)
    if sha256(encoded) != expected_manifest_sha256:
        raise BundleError('manifest hash does not match the reviewed hash')
    manifest = _json(encoded)
    keys = {'schema_version', 'policy', 'upstream_commit', 'base_archive_sha256', 'source_snapshot_sha256', 'bundle_sha256', 'bundle_bytes', 'files', 'excluded_non_deployed_source_changes'}
    if (type(manifest) is not dict or set(manifest) != keys or type(manifest['schema_version']) is not int or manifest['schema_version'] != 1 or
            manifest['policy'] != POLICY or manifest['upstream_commit'] != UPSTREAM_COMMIT or manifest['base_archive_sha256'] != BASE_ARCHIVE_SHA256 or
            type(manifest['source_snapshot_sha256']) is not str or re.fullmatch('[0-9a-f]{64}', manifest['source_snapshot_sha256']) is None or
            type(manifest['files']) is not list or len(manifest['files']) != len(PAYLOAD_PATHS) or
            type(manifest['excluded_non_deployed_source_changes']) is not list or
            any(type(name) is not str for name in manifest['excluded_non_deployed_source_changes']) or
            manifest['excluded_non_deployed_source_changes'] != sorted(set(manifest['excluded_non_deployed_source_changes'])) or
            not set(manifest['excluded_non_deployed_source_changes']).issubset(NON_DEPLOYED_PATCHES)):
        raise BundleError('manifest policy or exact fields are invalid')
    base = _base(base_archive)
    tar = _read_file(bundle_path, MAX_TAR_BYTES)
    payload = _tar_entries(tar)
    if (set(payload) != set(PAYLOAD_PATHS) or type(manifest['bundle_bytes']) is not int or manifest['bundle_bytes'] != len(tar) or
            manifest['bundle_sha256'] != sha256(tar) or sum(map(len, payload.values())) > MAX_PAYLOAD_BYTES or tar != _data_tar(payload)):
        raise BundleError('bundle extent, member set or hash mismatch')
    for path, entry in zip(PAYLOAD_PATHS, manifest['files']):
        _payload(path, payload[path])
        if type(entry) is not dict or type(entry.get('bytes')) is not int or entry != _entry(path, payload[path], base):
            raise BundleError('manifest file base/new hash, target or metadata mismatch')
    return {'result': 'passed', 'offline_only': True, 'deployment_authorized': False, 'deployed_base_verified': False,
            'manifest_sha256': expected_manifest_sha256, 'bundle_sha256': sha256(tar), 'members': list(PAYLOAD_PATHS)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'build'):
        command = commands.add_parser(name)
        command.add_argument('--source-root', required=True)
        command.add_argument('--base-archive', required=True)
        command.add_argument('--output-dir', required=True)
    check = commands.add_parser('verify')
    check.add_argument('--manifest', required=True)
    check.add_argument('--bundle', required=True)
    check.add_argument('--base-archive', required=True)
    check.add_argument('--expected-manifest-sha256', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'plan':
            plan = prepare_plan(args.source_root, args.base_archive)
            _write_outputs(args.output_dir, {'deployment-plan.json': _json_bytes(plan)})
            result = {'result': 'passed', 'offline_only': True, 'deployment_authorized': False, 'manifest_sha256': plan['manifest_sha256']}
        elif args.command == 'build':
            result = build_bundle(args.source_root, args.base_archive, args.output_dir)
        else:
            result = verify_bundle(args.manifest, args.bundle, args.base_archive, args.expected_manifest_sha256)
    except (BundleError, OSError, ValueError, TypeError) as error:
        print(json.dumps({'result': 'failed', 'deployment_authorized': False, 'message': str(error)}))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
