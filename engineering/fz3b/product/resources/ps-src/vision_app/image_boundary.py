"""Bounded JPEG and upload admission; compatible with Python 3.6."""
import io
import math
import re

from PIL import Image, ImageFile

MAX_JPEG_BYTES = 4 * 1024 * 1024
MAX_IMAGE_DIMENSION = 8192
MAX_SOURCE_PIXELS = 8 * 1024 * 1024
MAX_RESIZE_PIXELS = 1024 * 1024
RESIZE_SHORT_SIDE = 256
MAX_FRAME_ID = 0xffffffff
_JOB_ID = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
_REQUIRED_METADATA = frozenset(('frame_id', 'video_time_s', 'width', 'height'))
_ALLOWED_METADATA = _REQUIRED_METADATA | frozenset(('job_id',))


def checked_resize_size(width, height):
    if (type(width) is not int or type(height) is not int or
            not 0 < width <= MAX_IMAGE_DIMENSION or
            not 0 < height <= MAX_IMAGE_DIMENSION or
            width * height > MAX_SOURCE_PIXELS):
        raise ValueError('image dimensions exceed the fixed pixel budget')
    # Preserve the upstream resize arithmetic and rounding for admitted images.
    long_side = int(RESIZE_SHORT_SIDE * max(width, height) / min(width, height))
    size = ((RESIZE_SHORT_SIDE, long_side) if width <= height else
            (long_side, RESIZE_SHORT_SIDE))
    if size[0] * size[1] > MAX_RESIZE_PIXELS:
        raise ValueError('image aspect ratio exceeds the resize pixel budget')
    return size


def checked_job_id(value):
    if type(value) is not str or _JOB_ID.fullmatch(value) is None:
        raise ValueError('invalid upload job ID')
    return value


def validate_upload_metadata(metadata, job_id=None):
    if (type(metadata) is not dict or not _REQUIRED_METADATA.issubset(metadata) or
            set(metadata) - _ALLOWED_METADATA):
        raise ValueError('upload frame metadata has missing or unsupported fields')
    frame_id = metadata['frame_id']
    if type(frame_id) is not int or not 0 <= frame_id <= MAX_FRAME_ID:
        raise ValueError('upload frame ID must be an unsigned 32-bit integer')
    stamp = metadata['video_time_s']
    try:
        finite = type(stamp) in (int, float) and math.isfinite(stamp)
    except (OverflowError, ValueError):
        finite = False
    if not finite or stamp < 0:
        raise ValueError('upload timestamp must be finite and nonnegative')
    checked_resize_size(metadata['width'], metadata['height'])
    clean = {key: metadata[key] for key in _REQUIRED_METADATA}
    if job_id is not None:
        checked_job_id(job_id)
    if 'job_id' in metadata:
        supplied = checked_job_id(metadata['job_id'])
        if job_id is not None and supplied != job_id:
            raise ValueError('upload frame belongs to another job')
        clean['job_id'] = supplied
    elif job_id is not None:
        clean['job_id'] = job_id
    return clean


def _jpeg_bytes(jpeg):
    if type(jpeg) not in (bytes, bytearray) or not 4 <= len(jpeg) <= MAX_JPEG_BYTES:
        raise ValueError('invalid uploaded JPEG extent or type')
    if not jpeg.startswith(b'\xff\xd8') or not jpeg.endswith(b'\xff\xd9'):
        raise ValueError('JPEG must have complete start and end markers')
    return bytes(jpeg)


def _load_strict(image):
    if ImageFile.LOAD_TRUNCATED_IMAGES:
        raise ValueError('strict JPEG decoding is required')
    try:
        image.load()
    except (OSError, SyntaxError, ValueError) as error:
        raise ValueError('JPEG could not be completely decoded: %s' % error)
    checked_resize_size(*image.size)


def open_checked_jpeg(jpeg, decode=True):
    """Return an owned Pillow image; the caller must close it, also on errors."""
    data = _jpeg_bytes(jpeg)
    image = None
    try:
        image = Image.open(io.BytesIO(data))
        if image.format != 'JPEG':
            raise ValueError('only JPEG input is supported')
        checked_resize_size(*image.size)
        if decode:
            _load_strict(image)
        return image
    except (OSError, SyntaxError, Image.DecompressionBombError) as error:
        if image is not None:
            image.close()
        raise ValueError('invalid JPEG input: %s' % error)
    except BaseException:
        if image is not None:
            image.close()
        raise


def validate_upload_frame(metadata, jpeg, job_id=None):
    clean = validate_upload_metadata(metadata, job_id)
    data = _jpeg_bytes(jpeg)
    image = open_checked_jpeg(data, decode=False)
    try:
        if image.size != (clean['width'], clean['height']):
            raise ValueError('upload dimensions differ from the JPEG image')
        _load_strict(image)
        if image.size != (clean['width'], clean['height']):
            raise ValueError('decoded dimensions differ from the upload metadata')
        clean['width'], clean['height'] = image.size
        return clean, data
    finally:
        image.close()
