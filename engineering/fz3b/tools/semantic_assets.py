"""Prepare fixed research-only S1 assets; no device or service access."""
import argparse
import hashlib
import json
import shutil
import time
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
OUTPUT = PROJECT / 'output/hardware/2026-10-16-next/semantic'
SOURCE = PROJECT / 'output/hardware/2026-10-16/fz3b-semantic-video-search/HOST/model-source'
CONTRACT = PROJECT / 'engineering/fz3b/source/HOST/vision_app/semantic-contract.json'
WEIGHT_URL = 'https://docs-assets.developer.apple.com/ml-research/datasets/mobileclip/mobileclip_s1.pt'
WEIGHT_BYTES = 340784294
WEIGHT_SHA256 = '1270fab6ea23bacbd61cea564bd521a7e875fdb0fcb6d31382bccf4d973b71a6'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def read_contract():
    contract = json.loads(CONTRACT.read_text(encoding='utf-8'))
    body = dict(contract)
    expected = body.pop('contract_id')
    if hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest() != expected:
        raise ValueError('contract digest mismatch')
    if contract['weight_sha256'] != WEIGHT_SHA256 or contract['model'] != 'mobileclip_s1' or contract['dimension'] != 512:
        raise ValueError('unexpected model contract')
    return contract


class AppleOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != 'https' or parsed.hostname != 'docs-assets.developer.apple.com':
            raise ValueError('weight redirect left fixed official host')
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download_weight(target):
    if target.exists():
        if target.stat().st_size != WEIGHT_BYTES or digest(target) != WEIGHT_SHA256:
            raise ValueError('existing weight differs; refusing overwrite')
        return
    partial = target.with_suffix('.pt.partial')
    if partial.exists():
        raise ValueError('partial weight exists; review it before retry')
    deadline = time.monotonic() + 900
    opener = urllib.request.build_opener(AppleOnlyRedirect())
    count = 0
    h = hashlib.sha256()
    with opener.open(WEIGHT_URL, timeout=30) as response, partial.open('xb') as destination:
        if response.status != 200:
            raise ValueError('weight download HTTP status differs')
        for chunk in iter(lambda: response.read1(64 * 1024), b''):
            if time.monotonic() >= deadline:
                raise TimeoutError('weight download total deadline')
            count += len(chunk)
            if count > WEIGHT_BYTES:
                raise ValueError('weight exceeds fixed byte count')
            h.update(chunk)
            destination.write(chunk)
    if count != WEIGHT_BYTES or h.hexdigest() != WEIGHT_SHA256:
        raise ValueError('weight bytes or SHA-256 differ; not usable')
    partial.rename(target)


def prepare(download=False):
    contract = read_contract()
    models = OUTPUT / 'assets/models'
    paths = list(contract['source_files']) + ['official-mobileclip/' + name for name in ('LICENSE', 'LICENSE_MODELS', 'ACKNOWLEDGEMENTS')]
    for relative in paths:
        source = SOURCE / relative
        if relative in contract['source_files'] and digest(source) != contract['source_files'][relative]:
            raise ValueError('source digest mismatch: ' + relative)
    models.mkdir(parents=True, exist_ok=True)
    for relative in paths:
        source, target = SOURCE / relative, models / relative
        if target.exists():
            if digest(target) != digest(source):
                raise ValueError('existing source differs; refusing overwrite')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    if download:
        download_weight(models / 'mobileclip_s1.pt')
    result = {'schema_version': 1, 'scope': 'research-only fixed S1 text/image reference; no device access',
              'contract_id': contract['contract_id'], 'weight_url': WEIGHT_URL,
              'weight_expected_bytes': WEIGHT_BYTES, 'weight_expected_sha256': WEIGHT_SHA256,
              'weight_present': (models / 'mobileclip_s1.pt').exists(),
              'source_files': {p: digest(models / p) for p in paths},
              'license': 'Apple Machine Learning Research Model License Agreement; research only; see copied LICENSE_MODELS'}
    if result['weight_present']:
        result['weight_actual_sha256'] = digest(models / 'mobileclip_s1.pt')
        if result['weight_actual_sha256'] != WEIGHT_SHA256:
            raise ValueError('weight digest mismatch')
    (OUTPUT / 'asset-provenance.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download-weights', action='store_true', help='download only the fixed Apple S1 checkpoint')
    args = parser.parse_args()
    print(json.dumps(prepare(args.download_weights), indent=2))


if __name__ == '__main__':
    main()
