"""Resume one fixed official CPU wheel by bounded, checked HTTP ranges."""
import argparse
import json
import time
import urllib.request

from semantic_assets import OUTPUT, digest

URL = 'https://download.pytorch.org/whl/cpu/torch-2.8.0%2Bcpu-cp312-cp312-win_amd64.whl'
SIZE = 619352539
SHA256 = '2be20b2c05a0cce10430cc25f32b689259640d273232b2de357c35729132256d'
CHUNK = 8 * 1024 * 1024
INDEX_SOURCE = 'https://download.pytorch.org/whl/cpu/torch/'
TARGET = OUTPUT / 'wheels/torch-2.8.0+cpu-cp312-cp312-win_amd64.whl'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('fixed CPU wheel URL must not redirect')


def read_range(opener, start, end):
    request = urllib.request.Request(URL, headers={'Range': 'bytes={}-{}'.format(start, end)})
    with opener.open(request, timeout=20) as response:
        if response.geturl() != URL or response.status != 206:
            raise ValueError('official wheel response URL/status differs')
        if response.headers.get('Content-Range') != 'bytes {}-{}/{}'.format(start, end, SIZE):
            raise ValueError('official wheel range differs')
        expected = end - start + 1
        deadline = time.monotonic() + 60
        parts, received = [], 0
        while received <= expected:
            if time.monotonic() >= deadline:
                raise TimeoutError('CPU wheel range deadline')
            chunk = response.read1(min(64 * 1024, expected + 1 - received))
            if not chunk:
                break
            received += len(chunk)
            parts.append(chunk)
        data = b''.join(parts)
        if len(data) != expected:
            raise ValueError('official wheel range length differs')
        return data


def download():
    if TARGET.exists():
        if TARGET.stat().st_size != SIZE or digest(TARGET) != SHA256:
            raise ValueError('existing CPU wheel differs; refusing overwrite')
        return {'url': URL, 'bytes': SIZE, 'sha256': SHA256, 'path': str(TARGET)}
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    partial = TARGET.with_suffix('.whl.partial')
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > SIZE or (offset != SIZE and offset % CHUNK != 0):
        raise ValueError('partial does not end at a complete fixed range')
    deadline = time.monotonic() + 1800
    opener = urllib.request.build_opener(NoRedirect())
    while offset < SIZE:
        if time.monotonic() >= deadline:
            raise TimeoutError('CPU wheel total deadline')
        end = min(offset + CHUNK, SIZE) - 1
        data = None
        for attempt in range(3):
            try:
                data = read_range(opener, offset, end)
                break
            except (OSError, ValueError) as error:
                if attempt == 2 or time.monotonic() >= deadline:
                    raise
                print('retry fixed range {}: {}'.format(offset, type(error).__name__), flush=True)
        with partial.open('ab') as stream:
            stream.write(data)
        offset += len(data)
        print('CPU wheel bytes {}/{}'.format(offset, SIZE), flush=True)
    if digest(partial) != SHA256:
        raise ValueError('CPU wheel SHA-256 differs; not installable')
    partial.rename(TARGET)
    result = {'index_source': INDEX_SOURCE, 'url': URL, 'bytes': SIZE, 'sha256': SHA256, 'path': str(TARGET)}
    (OUTPUT / 'cpu-wheel-provenance.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download-cpu-wheel', action='store_true', required=True)
    parser.parse_args()
    print(json.dumps(download(), indent=2))


if __name__ == '__main__':
    main()
