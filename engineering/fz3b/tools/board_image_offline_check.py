"""Build a stdin-only, in-memory image check; this tool never connects to a board."""
import argparse
import base64
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'engineering' / 'fz3b' / 'source' / 'PS' / 'vision_app'

PAYLOAD = r'''
import ast
import base64
import builtins
import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import time
import types
from unittest import mock

sys.dont_write_bytecode = True

EMBEDDED = json.loads(base64.b64decode(EMBEDDED_BASE64).decode('utf-8'))
blocked = []
replacements = []

def replace(module, name, value):
    replacements.append((module, name, getattr(module, name)))
    setattr(module, name, value)

def restore_guards():
    for module, name, original in reversed(replacements):
        setattr(module, name, original)
    replacements[:] = []

def deny(name):
    def forbidden(*args, **kwargs):
        blocked.append(name)
        raise RuntimeError('offline check forbids ' + name)
    return forbidden

replace(socket, 'socket', deny('socket.socket'))
replace(socket, 'create_connection', deny('socket.create_connection'))
for name in ('Popen', 'run', 'call', 'check_call', 'check_output'):
    if hasattr(subprocess, name):
        replace(subprocess, name, deny('subprocess.' + name))
for name in ('system', 'popen', 'fork', 'forkpty', 'unlink', 'remove', 'mkdir',
             'makedirs', 'rename', 'replace', 'rmdir', 'chmod', 'chown'):
    if hasattr(os, name):
        replace(os, name, deny('os.' + name))
for name in dir(os):
    if name.startswith(('exec', 'spawn')):
        replace(os, name, deny('os.' + name))

original_open = builtins.open
original_io_open = io.open
original_os_open = os.open

def read_open(original):
    def checked(file, mode='r', *args, **kwargs):
        if any(flag in mode for flag in ('w', 'a', 'x', '+')):
            return deny('file-write')(file)
        if isinstance(file, (str, bytes)):
            value = file.decode('utf-8', 'replace') if isinstance(file, bytes) else file
            if value.startswith('/dev/'):
                return deny('device-open')(file)
        return original(file, mode, *args, **kwargs)
    return checked

def read_os_open(file, flags, *args, **kwargs):
    if flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC):
        return deny('os.open-write')(file)
    if isinstance(file, (str, bytes)) and (file.startswith(b'/dev/') if isinstance(file, bytes) else file.startswith('/dev/')):
        return deny('device-open')(file)
    return original_os_open(file, flags, *args, **kwargs)

replace(builtins, 'open', read_open(original_open))
replace(io, 'open', read_open(original_io_open))
replace(os, 'open', read_os_open)

import numpy as np
import PIL
from PIL import Image, ImageFile

checks = []
sources = {}
report = {
    'schemaVersion': 1, 'scope': 'stdin-in-memory-image-upload-compatibility',
    'python': sys.version, 'pillow': getattr(PIL, '__version__', getattr(PIL, 'PILLOW_VERSION', 'unknown')),
    'numpy': np.__version__, 'expectedBoardVersions': {'python': '3.6.9', 'pillow': '5.1.0', 'numpy': '1.13.3'},
    'sourceSha256': {}, 'checks': checks, 'blockedOperations': blocked,
    'deployed': False, 'serviceTouched': False, 'boardAgentImportedOrConstructed': False,
    'boardRuntimeImportedOrConstructed': False, 'largeResizePerformed': False,
    'boardFilesWritten': False, 'networkOperationsPerformed': False,
}

def check(name, action):
    try:
        detail = action()
        checks.append({'name': name, 'passed': True, 'detail': detail})
    except Exception as error:
        checks.append({'name': name, 'passed': False, 'errorType': type(error).__name__, 'error': str(error)[:500]})

def require(value, message):
    if not value:
        raise AssertionError(message)

def must_reject(action):
    try:
        action()
    except ValueError:
        return
    raise AssertionError('invalid input was accepted')

def load_sources():
    for name, item in EMBEDDED['sources'].items():
        raw = base64.b64decode(item['base64'])
        actual = hashlib.sha256(raw).hexdigest()
        require(actual == item['sha256'], 'embedded source digest differs: ' + name)
        sources[name] = raw.decode('utf-8')
        report['sourceSha256'][name] = actual
    return {'sourceCount': len(sources), 'baseline': EMBEDDED['baseline']}

check('embedded-source-identities', load_sources)
package_name = 'fz3b_stdin_image_check'
package = types.ModuleType(package_name)
package.__path__ = []
sys.modules[package_name] = package

def pure_module(name):
    module = types.ModuleType(package_name + '.' + name)
    module.__package__ = package_name
    sys.modules[module.__name__] = module
    exec(compile(sources[name], '<embedded-' + name + '>', 'exec'), module.__dict__)
    return module

boundary = pure_module('image_boundary')
upload = pure_module('upload_source')

def preprocess(name):
    tree = ast.parse(sources[name])
    method = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'preprocess_jpeg')
    namespace = {'io': io, 'time': time, 'np': np, 'Image': Image,
                 'checked_resize_size': boundary.checked_resize_size,
                 'open_checked_jpeg': boundary.open_checked_jpeg}
    module = ast.Module(body=[method])
    if 'type_ignores' in ast.Module._fields:
        module.type_ignores = []
    exec(compile(ast.fix_missing_locations(module), '<embedded-' + name + '-preprocess-only>', 'exec'), namespace)
    return namespace['preprocess_jpeg']

baseline_preprocess = preprocess('baseline_camera')
hardened_preprocess = preprocess('camera')

def encode_jpeg(size, mode='RGB', progressive=False):
    image = Image.new(mode, size)
    if mode == 'RGB':
        image.putdata([(i % 256, (i * 7) % 256, (i * 11) % 256)
                       for i in range(size[0] * size[1])])
    output = io.BytesIO()
    image.save(output, format='JPEG', progressive=progressive)
    image.close()
    return output.getvalue()

def meta(size=(32, 24)):
    return {'frame_id': 0, 'video_time_s': 0, 'width': size[0], 'height': size[1], 'job_id': 'offline-check'}

def compatible_apis():
    require(hasattr(Image, 'DecompressionBombError'), 'Pillow DecompressionBombError missing')
    require(hasattr(Image, 'BILINEAR'), 'Pillow BILINEAR missing')
    require(hasattr(ImageFile, 'LOAD_TRUNCATED_IMAGES'), 'Pillow truncation flag missing')
    require(not ImageFile.LOAD_TRUNCATED_IMAGES, 'Pillow permits truncated decoding')
    require(hasattr(Image.Image, '__enter__') and hasattr(Image.Image, '__exit__'), 'Pillow image context manager missing')
    return {'strictTruncation': True, 'contextManager': True}

def equivalent_preprocess():
    details = []
    for size, mode, progressive in (((64, 48), 'RGB', False), ((73, 121), 'RGB', False),
                                     ((224, 224), 'RGB', False), ((31, 47), 'L', False),
                                     ((32, 24), 'CMYK', False), ((67, 45), 'RGB', True)):
        jpeg = encode_jpeg(size, mode, progressive)
        expected = baseline_preprocess(jpeg)
        actual = hardened_preprocess(jpeg)
        require(np.array_equal(actual, expected), 'preprocessing values changed')
        require(actual.shape == (1, 3, 256, 256), 'unexpected actual upstream tensor shape')
        require(actual.dtype == np.float32 and actual.flags.c_contiguous, 'tensor layout changed')
        details.append({'dimensions': list(size), 'mode': mode, 'progressive': progressive,
                        'exactlyEqual': True, 'jpegBytes': len(jpeg)})
    return details

def reject_extreme_before_decode():
    jpeg = encode_jpeg((1, 8192))
    with mock.patch.object(Image.Image, 'load', side_effect=AssertionError('extreme image decoded')), \
            mock.patch.object(Image.Image, 'resize', side_effect=AssertionError('extreme image resized')):
        must_reject(lambda: hardened_preprocess(jpeg))
    return {'jpegBytes': len(jpeg), 'dimensions': [1, 8192], 'decoded': False, 'resized': False}

def invalid_metadata_no_queue():
    jpeg = encode_jpeg((32, 24))
    cases = [dict(meta(), width=True), dict(meta(), width=float('nan')),
             dict(meta(), width=31), dict(meta(), video_time_s=True),
             dict(meta(), video_time_s=float('nan')), dict(meta(), video_time_s=float('inf')),
             dict(meta(), frame_id=True), dict(meta(), frame_id=2 ** 32),
             dict(meta(), job_id='wrong-job'), dict(meta(), extra=[]), dict(meta(), width=[32])]
    for key in ('frame_id', 'video_time_s', 'width', 'height'):
        value = meta()
        del value[key]
        cases.append(value)
    deep = 0
    for unused in range(32):
        deep = [deep]
    cases.append(dict(meta(), nested=deep))
    for value in cases:
        job = upload.UploadSource('offline-check')
        before = job.status()
        must_reject(lambda: job.put(value, jpeg))
        require(job.status() == before, 'invalid metadata changed queue state')
    for invalid in (b'', jpeg[:-2], b'\xff\xd8invalid\xff\xd9'):
        job = upload.UploadSource('offline-check')
        before = job.status()
        must_reject(lambda: job.put(meta(), invalid))
        require(job.status() == before, 'invalid JPEG changed queue state')
    return {'metadataCases': len(cases), 'invalidJpegCases': 3, 'allQueuesUnchanged': True}

def valid_upload_and_fast_rejection():
    jpeg = encode_jpeg((32, 24))
    job = upload.UploadSource('offline-check', capacity=1)
    frame = job.put(meta(), jpeg)
    require(frame['width'] == 32 and frame['height'] == 24, 'trusted dimensions differ')
    require(job.status()['received'] == 1 and job.status()['queued'] == 1, 'valid frame not queued exactly once')
    following = dict(meta(), frame_id=1, video_time_s=1)
    with mock.patch.object(upload, 'validate_upload_frame', side_effect=AssertionError('full queue decoded image')):
        must_reject(lambda: job.put(following, jpeg))
    queued = job.take(timeout=0)
    require(queued['jpeg'] == jpeg, 'queued bytes differ')
    return {'received': 1, 'fullQueueDecodeAttempted': False, 'jpegPreserved': True}

check('pillow-api-compatibility', compatible_apis)
check('normal-preprocessing-exactly-matches-retrieved-board-source', equivalent_preprocess)
check('extreme-jpeg-refused-before-decode-and-resize', reject_extreme_before_decode)
check('invalid-metadata-and-jpeg-never-enqueued', invalid_metadata_no_queue)
check('valid-upload-and-full-queue-precheck', valid_upload_and_fast_rejection)
report['passed'] = bool(checks) and all(item['passed'] for item in checks) and not blocked
report['checksRun'] = len(checks)
restore_guards()
print(json.dumps(report, sort_keys=True, separators=(',', ':'), allow_nan=False))
if not report['passed']:
    raise SystemExit(1)
'''


def owned_output(value):
    destination = Path(value).resolve()
    try:
        destination.relative_to(ROOT)
    except ValueError:
        raise ValueError('generated outputs must remain inside ForgeDesk-codex')
    destination.parent.mkdir(parents=True, exist_ok=True)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, help='Locally retrieved board vision_app directory')
    parser.add_argument('--payload-output', required=True, help='Project-owned generated stdin payload path')
    parser.add_argument('--run-local', action='store_true', help='Execute generated pure checks in this process, never SSH')
    parser.add_argument('--local-report-output', help='Project-owned local stdout JSON capture')
    args = parser.parse_args()
    baseline = Path(args.baseline).resolve()
    baseline.relative_to(ROOT)
    sources = {}
    files = {'image_boundary': SOURCE / 'image_boundary.py', 'upload_source': SOURCE / 'upload_source.py',
             'camera': SOURCE / 'camera.py', 'baseline_camera': baseline / 'camera.py'}
    for name, path in files.items():
        raw = path.read_bytes()
        sources[name] = {'base64': base64.b64encode(raw).decode('ascii'),
                         'sha256': hashlib.sha256(raw).hexdigest()}
    embedded = {'baseline': str(baseline.relative_to(ROOT)), 'sources': sources}
    encoded = base64.b64encode(json.dumps(embedded, sort_keys=True).encode('utf-8')).decode('ascii')
    payload = 'EMBEDDED_BASE64 = ' + repr(encoded) + '\n' + PAYLOAD
    output = owned_output(args.payload_output)
    output.write_text(payload, encoding='utf-8')
    if args.run_local:
        import contextlib
        import io
        buffer = io.StringIO()
        namespace = {'__name__': '__main__'}
        try:
            with contextlib.redirect_stdout(buffer):
                exec(compile(payload, '<generated-board-image-check>', 'exec'), namespace)
        finally:
            if 'restore_guards' in namespace:
                namespace['restore_guards']()
        text = buffer.getvalue()
        if args.local_report_output:
            owned_output(args.local_report_output).write_text(text, encoding='utf-8')
        print(text, end='')
    else:
        print(json.dumps({'payload': str(output), 'sha256': hashlib.sha256(payload.encode('utf-8')).hexdigest(),
                          'networkCodeIncluded': False, 'remoteExecutionPerformed': False}))


if __name__ == '__main__':
    main()
