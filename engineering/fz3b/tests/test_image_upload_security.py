"""Pure image/queue tests. No Agent, runtime, device or network construction."""
import ast
import importlib
import importlib.util
import io
import math
from pathlib import Path
import sys
import threading
import unittest
from unittest import mock

import numpy as np
from PIL import Image, ImageFile

PS = Path(__file__).resolve().parents[1] / 'source' / 'PS' / 'vision_app'
PACKAGE = 'fz3b_image_security'
spec = importlib.util.spec_from_file_location(PACKAGE, str(PS / '__init__.py'),
                                             submodule_search_locations=[str(PS)])
package = importlib.util.module_from_spec(spec)
sys.modules[PACKAGE] = package
spec.loader.exec_module(package)
boundary = importlib.import_module(PACKAGE + '.image_boundary')
camera = importlib.import_module(PACKAGE + '.camera')
upload = importlib.import_module(PACKAGE + '.upload_source')


def jpeg_bytes(size=(32, 24), mode='RGB', progressive=False):
    if mode == 'RGB':
        pixels = np.arange(size[0] * size[1] * 3, dtype=np.uint8).reshape(size[1], size[0], 3)
        image = Image.fromarray(pixels, mode)
    else:
        image = Image.new(mode, size)
    with image:
        stream = io.BytesIO()
        image.save(stream, format='JPEG', progressive=progressive)
    return stream.getvalue()


def metadata(frame_id=0, stamp=0, size=(32, 24)):
    return {'frame_id': frame_id, 'video_time_s': stamp,
            'width': size[0], 'height': size[1], 'job_id': 'test-job'}


def upstream_reference(jpeg):
    with Image.open(io.BytesIO(jpeg)) as opened:
        opened.load()
        image = opened if opened.mode == 'RGB' else opened.convert('RGB')
        width, height = image.size
        long_side = int(256 * max(width, height) / min(width, height))
        resized = image.resize((256, long_side) if width <= height else
                               (long_side, 256), Image.BILINEAR)
        left = int(round((resized.size[0] - 256) / 2.0))
        top = int(round((resized.size[1] - 256) / 2.0))
        array = np.asarray(resized.crop((left, top, left + 256, top + 256)),
                           dtype=np.uint8).astype(np.float32)
        array /= np.float32(255)
        return np.ascontiguousarray(array.transpose(2, 0, 1)[None])


class ImageAdmissionTests(unittest.TestCase):
    def test_admitted_images_preserve_upstream_values_exactly(self):
        cases = [((224, 224), 'RGB', False), ((320, 240), 'RGB', False),
                 ((241, 320), 'RGB', False), ((1280, 720), 'RGB', True),
                 ((33, 22), 'L', False), ((24, 35), 'CMYK', False)]
        for size, mode, progressive in cases:
            with self.subTest(size=size, mode=mode, progressive=progressive):
                jpeg = jpeg_bytes(size, mode, progressive)
                expected = upstream_reference(jpeg)
                actual = camera.preprocess_jpeg(jpeg)
                self.assertEqual(actual.shape, (1, 3, 256, 256))
                self.assertEqual(actual.dtype, np.float32)
                self.assertTrue(actual.flags.c_contiguous)
                self.assertTrue(np.array_equal(actual, expected))

    def test_real_narrow_jpeg_rejected_without_pixel_decode_or_resize(self):
        jpeg = jpeg_bytes((1, 8192))
        with mock.patch.object(Image.Image, 'load', side_effect=AssertionError('decode forbidden')), \
                mock.patch.object(Image.Image, 'resize', side_effect=AssertionError('resize forbidden')):
            with self.assertRaises(ValueError):
                camera.preprocess_jpeg(jpeg)

    def test_source_and_intermediate_pixel_budgets(self):
        self.assertEqual(boundary.checked_resize_size(4096, 2048), (512, 256))
        self.assertEqual(boundary.checked_resize_size(1, 16), (256, 4096))
        for size in ((4096, 2049), (8193, 2), (1, 17), (0, 1),
                     (True, 2), (1, math.nan), (1, math.inf)):
            with self.subTest(size=size), self.assertRaises(ValueError):
                boundary.checked_resize_size(*size)

    def test_budget_checked_before_complete_decode_or_convert(self):
        image = mock.Mock(format='JPEG', size=(4096, 2049))
        with mock.patch.object(boundary.Image, 'open', return_value=image):
            with self.assertRaises(ValueError):
                boundary.open_checked_jpeg(b'\xff\xd8small\xff\xd9')
        image.load.assert_not_called()
        image.convert.assert_not_called()
        image.resize.assert_not_called()
        image.close.assert_called_once_with()

    def test_invalid_extent_type_marker_format_and_decode_rejected(self):
        valid = jpeg_bytes()
        for data in (None, 'jpeg', b'', b'not jpeg', valid[:-2],
                     b'\xff\xd8garbage\xff\xd9', b'x' * (boundary.MAX_JPEG_BYTES + 1)):
            with self.subTest(kind=type(data).__name__), self.assertRaises(ValueError):
                boundary.open_checked_jpeg(data)
        image = mock.Mock(format='PNG', size=(32, 24))
        with mock.patch.object(boundary.Image, 'open', return_value=image):
            with self.assertRaises(ValueError):
                boundary.open_checked_jpeg(valid)
        image.load.assert_not_called()
        image = mock.Mock(format='JPEG', size=(32, 24))
        image.load.side_effect = OSError('broken entropy data')
        with mock.patch.object(boundary.Image, 'open', return_value=image):
            with self.assertRaises(ValueError):
                boundary.open_checked_jpeg(valid)
        image.close.assert_called_once_with()

    def test_nonjpeg_real_payload_rejected(self):
        stream = io.BytesIO()
        with Image.new('RGB', (32, 24)) as image:
            image.save(stream, format='PNG')
        with self.assertRaises(ValueError):
            boundary.validate_upload_frame(metadata(), stream.getvalue(), 'test-job')

    def test_permissive_truncated_decode_configuration_rejected(self):
        with mock.patch.object(ImageFile, 'LOAD_TRUNCATED_IMAGES', True):
            with self.assertRaises(ValueError):
                boundary.open_checked_jpeg(jpeg_bytes())

    def test_metadata_dimension_mismatch_fails_before_complete_decode(self):
        with mock.patch.object(boundary, '_load_strict', side_effect=AssertionError('decode forbidden')) as load:
            with self.assertRaises(ValueError):
                boundary.validate_upload_frame(metadata(size=(31, 24)), jpeg_bytes(), 'test-job')
            load.assert_not_called()

    def test_decoded_size_change_is_rejected_instead_of_rewriting_claimed_size(self):
        image = mock.Mock(format='JPEG', size=(32, 24))
        image.load.side_effect = lambda: setattr(image, 'size', (32, 25))
        with mock.patch.object(boundary.Image, 'open', return_value=image):
            with self.assertRaises(ValueError):
                boundary.validate_upload_frame(metadata(), jpeg_bytes(), 'test-job')
        image.close.assert_called_once_with()

    def test_decompression_bomb_error_is_a_validation_error(self):
        with mock.patch.object(boundary.Image, 'open', side_effect=Image.DecompressionBombError('oversized')):
            with self.assertRaises(ValueError):
                boundary.open_checked_jpeg(b'\xff\xd8small\xff\xd9')

    def test_source_is_python36_grammar_compatible(self):
        for filename in ('image_boundary.py', 'camera.py', 'upload_source.py'):
            ast.parse((PS / filename).read_text(encoding='utf-8'), feature_version=(3, 6))


class UploadMetadataTests(unittest.TestCase):
    def test_required_fields_exact_types_finiteness_and_job_binding(self):
        cases = [None, {}, dict(metadata(), width=True), dict(metadata(), height=math.nan),
                 dict(metadata(), video_time_s=True), dict(metadata(), video_time_s=math.inf),
                 dict(metadata(), video_time_s=math.nan), dict(metadata(), video_time_s=-1),
                 dict(metadata(), video_time_s=10 ** 500), dict(metadata(), frame_id=True),
                 dict(metadata(), frame_id=-1), dict(metadata(), frame_id=2 ** 32),
                 dict(metadata(), job_id='another-job'), dict(metadata(), job_id='../path'),
                 dict(metadata(), width=[32]), dict(metadata(), extra='unsupported')]
        for key in ('frame_id', 'video_time_s', 'width', 'height'):
            item = metadata()
            item.pop(key)
            cases.append(item)
        for item in cases:
            with self.subTest(item=str(item)[:120]), self.assertRaises(ValueError):
                boundary.validate_upload_metadata(item, 'test-job')

    def test_deep_metadata_rejected_without_traversing_it(self):
        deep = 0
        for unused in range(2000):
            deep = [deep]
        with self.assertRaises(ValueError):
            boundary.validate_upload_metadata(dict(metadata(), nested=deep), 'test-job')
        with self.assertRaises(ValueError):
            boundary.validate_upload_metadata(dict(metadata(), width=deep), 'test-job')

    def test_host_can_supply_job_id_but_remote_cannot_replace_it(self):
        item = metadata()
        del item['job_id']
        clean, data = boundary.validate_upload_frame(item, jpeg_bytes(), 'test-job')
        self.assertEqual(clean['job_id'], 'test-job')
        self.assertEqual((clean['width'], clean['height']), (32, 24))
        self.assertIsInstance(data, bytes)

    def test_failed_frame_never_changes_queue_or_sequence(self):
        job = upload.UploadSource('test-job')
        before = job.status()
        for item, jpeg in ((dict(metadata(), width=33), jpeg_bytes()),
                           (metadata(), b'invalid'), (dict(metadata(), video_time_s=True), jpeg_bytes())):
            with self.subTest(item=item), self.assertRaises(ValueError):
                job.put(item, jpeg)
            self.assertEqual(job.status(), before)
        accepted = job.put(metadata(), jpeg_bytes())
        self.assertEqual(accepted['frame_id'], 0)
        self.assertEqual(job.status()['received'], 1)

    def test_success_returns_immutable_validated_frame_copy(self):
        job = upload.UploadSource('test-job')
        item = metadata()
        original = jpeg_bytes()
        mutable = bytearray(original)
        accepted = job.put(item, mutable)
        mutable[0] = 0
        item['width'] = 1
        accepted['height'] = 1
        frame = job.take(timeout=0)
        self.assertEqual(frame['jpeg'], original)
        self.assertEqual((frame['width'], frame['height']), (32, 24))

    def test_closed_full_and_wrong_sequence_fail_before_decode(self):
        jobs = []
        closed = upload.UploadSource('test-job')
        closed.cancel()
        jobs.append((closed, metadata()))
        finished = upload.UploadSource('test-job')
        finished.finish(0)
        jobs.append((finished, metadata()))
        full = upload.UploadSource('test-job', capacity=1)
        full.put(metadata(), jpeg_bytes())
        jobs.append((full, metadata(1, 1)))
        jobs.append((upload.UploadSource('test-job'), metadata(1, 1)))
        with mock.patch.object(upload, 'validate_upload_frame', side_effect=AssertionError('decode forbidden')) as validate:
            for job, item in jobs:
                with self.subTest(job=job.status()), self.assertRaises(ValueError):
                    job.put(item, b'not decoded')
            validate.assert_not_called()

    def test_cancel_racing_validation_rechecks_before_enqueue(self):
        job = upload.UploadSource('test-job')
        entered, release = threading.Event(), threading.Event()
        errors = []
        original = upload.validate_upload_frame

        def delayed(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise AssertionError('test validation release timed out')
            return original(*args, **kwargs)

        def put():
            try:
                job.put(metadata(), jpeg_bytes())
            except Exception as error:
                errors.append(error)

        with mock.patch.object(upload, 'validate_upload_frame', side_effect=delayed):
            worker = threading.Thread(target=put)
            worker.start()
            try:
                self.assertTrue(entered.wait(3))
                job.cancel()
            finally:
                release.set()
                worker.join(3)
            self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError)
        self.assertEqual(job.status()['received'], 0)
        self.assertEqual(job.status()['queued'], 0)

    def test_two_concurrent_validations_cannot_queue_the_same_sequence_twice(self):
        job = upload.UploadSource('test-job', capacity=1)
        gate = threading.Barrier(2)
        original = upload.validate_upload_frame
        results, errors = [], []
        jpeg = jpeg_bytes()

        def delayed(*args, **kwargs):
            gate.wait(timeout=3)
            return original(*args, **kwargs)

        def put():
            try:
                results.append(job.put(metadata(), jpeg))
            except Exception as error:
                errors.append(error)

        with mock.patch.object(upload, 'validate_upload_frame', side_effect=delayed):
            workers = [threading.Thread(target=put) for unused in range(2)]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(4)
                self.assertFalse(worker.is_alive())
        self.assertEqual(len(results), 1)
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], ValueError)
        self.assertEqual(job.status()['queued'], 1)
        self.assertEqual(job.status()['received'], 1)

    def test_existing_sequence_timestamp_eof_and_capacity_rules(self):
        for capacity in (0, True, 17):
            with self.assertRaises(ValueError):
                upload.UploadSource('test-job', capacity)
        job = upload.UploadSource('test-job')
        jpeg = jpeg_bytes()
        job.put(metadata(stamp=2), jpeg)
        with self.assertRaises(ValueError):
            job.put(metadata(1, 1), jpeg)
        with self.assertRaises(ValueError):
            job.finish(2)
        job.finish(1)
        with self.assertRaises(ValueError):
            job.put(metadata(1, 3), jpeg)
        self.assertEqual(job.take(timeout=0)['frame_id'], 0)
        self.assertTrue(job.exhausted)


if __name__ == '__main__':
    unittest.main(verbosity=2)
