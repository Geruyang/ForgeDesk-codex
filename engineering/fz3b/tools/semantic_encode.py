"""Encode fixed real English queries for one research-only FZ3B scene probe.

No socket, SSH, device, board runtime, arbitrary prompts or endpoint surface.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import io
import json
import math
import os
import platform
import sys
from pathlib import Path

from semantic_assets import CONTRACT, OUTPUT, PROJECT, digest, read_contract

MODELS = OUTPUT / 'assets/models'
FIXTURE = OUTPUT / 'fixture-v1'
SCENE = PROJECT / 'output/hardware/2026-10-16/fz3b-semantic-video-search/docs/media/xiaohongshu/03-实时检索实机.png'
SCENE_SHA256 = '29ded4922c40e44cb7defcce8b3e37ac50691841954a0a1f421d379e612393c7'
CROP = (127, 166, 1041, 678)
ITEMS = (
    ('pillow', 'a photo of a pillow'),
    ('cup', 'a photo of a cup'),
    ('mobile-phone', 'a photo of a mobile phone'),
    ('bottle', 'a photo of a bottle'),
)
CONTRACT_ID = '332b521b0fbdc3104c0c4b0fd017df01e090b004276b1f5982c9a04aace7e09e'
TORCH_WHEEL_URL = 'https://files.pythonhosted.org/packages/af/8a/5c87f08e3abd825c7dfecef5a0f1d9aa5df5dd0e3fd1fa2f490a8e512402/torch-2.8.0-cp312-cp312-win_amd64.whl'
TORCH_WHEEL_SHA256 = '2f4ac52f0130275d7517b03a33d2493bab3693c83dcfadf4f81688ea82147d2e'
RULE = {'expected_top1': 'pillow', 'strictly_above_all_distractors': True,
        'threshold': 0.2, 'threshold_hit_reported_separately': True,
        'scope': 'one preselected scene ranking consistency only; not accuracy, probability, recall or FPS'}


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n').encode('utf-8')


def save_once(path, value):
    data = canonical(value) if not isinstance(value, bytes) else value
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError('immutable artifact differs: ' + str(path))
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(data)


def declaration():
    contract = read_contract()
    if contract['contract_id'] != CONTRACT_ID:
        raise ValueError('fixed probe contract differs')
    return {'schema_version': 1, 'fixture_id': 'fz3b-pillow-scene-v1',
            'contract_id': CONTRACT_ID,
            'items': [{'id': key, 'label': key, 'text': text} for key, text in ITEMS],
            'source_image': {'project_relative_path': str(SCENE.relative_to(PROJECT)).replace('\\', '/'),
                             'sha256': SCENE_SHA256, 'size': [1702, 1102], 'crop_xyxy_exclusive': list(CROP),
                             'provenance': 'existing project release 2.1 screenshot, original media 2.0; local manifest hash checked',
                             'label_basis': 'offline visual inspection: person holding a pillow; not independent labeled test set'},
            'jpeg': {'mode': 'RGB', 'quality': 95, 'subsampling': 0, 'optimize': False, 'progressive': False},
            'decision_rule': RULE,
            'no_adaptive_prompts_or_threshold': True,
            'license_scope': 'research-only validation; copied Apple model license applies'}


def prepare_fixture():
    from PIL import Image
    spec = declaration()
    if digest(SCENE) != SCENE_SHA256:
        raise ValueError('reference screenshot SHA-256 differs')
    # Freeze the decision rule before any model inference or score is observed.
    save_once(FIXTURE / 'predeclared.json', spec)
    with Image.open(SCENE) as source:
        if source.size != (1702, 1102):
            raise ValueError('reference screenshot extent differs')
        image = source.convert('RGB').crop(CROP)
        encoded = io.BytesIO()
        image.save(encoded, 'JPEG', quality=95, subsampling=0, optimize=False, progressive=False)
    jpeg = encoded.getvalue()
    save_once(FIXTURE / 'input.jpg', jpeg)
    receipt = {'fixture_id': spec['fixture_id'], 'predeclared_sha256': digest(FIXTURE / 'predeclared.json'),
               'input_sha256': hashlib.sha256(jpeg).hexdigest(), 'input_bytes': len(jpeg),
               'input_width': CROP[2] - CROP[0], 'input_height': CROP[3] - CROP[1],
               'image_is_synthetic': False, 'image_is_derived_screenshot_crop': True,
               'pillow_top1_required': True, 'device_inference_run': False}
    save_once(FIXTURE / 'input-manifest.json', receipt)
    return spec, receipt


def validate_features(values, identity, contract):
    import numpy as np
    if values.shape != (len(ITEMS), 512) or values.dtype != np.dtype('float32'):
        raise ValueError('text embedding shape/dtype differs')
    if not np.isfinite(values).all():
        raise ValueError('text embedding is not finite')
    norms = np.linalg.norm(values.astype(np.float64), axis=1)
    if not np.all(np.abs(norms - 1.0) < 1e-6):
        raise ValueError('text embedding is not L2 normalized')
    for key in ('contract_id', 'weight_sha256', 'source_revision', 'normalization', 'bpe_sha256'):
        if identity.get(key) != contract[key]:
            raise ValueError('actual encoder identity differs: ' + key)
    if identity.get('tokenizer_context') != 77:
        raise ValueError('tokenizer context differs')
    # This is an extra guard against accidentally recycling the earlier e0 probe.
    if np.any(np.count_nonzero(values, axis=1) <= 1):
        raise ValueError('unit-vector fixture is not a real text encoding')
    return np.ascontiguousarray(values, dtype='<f4').tobytes(), norms.tolist()


def judge_scores(ids, scores):
    if list(ids) != [key for key, unused in ITEMS] or len(scores) != len(ITEMS):
        raise ValueError('query ordering differs')
    if not all(isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score) and -1 <= score <= 1 for score in scores):
        raise ValueError('invalid cosine scores')
    ranking = sorted(zip(ids, scores), key=lambda row: row[1], reverse=True)
    target, distractor = scores[0], max(scores[1:])
    return {'ranking': [{'id': key, 'score': score} for key, score in ranking],
            'target_rank': next(i + 1 for i, row in enumerate(ranking) if row[0] == 'pillow'),
            'target_minus_best_distractor': target - distractor,
            'semantic_consistency_pass': target > distractor,
            'target_threshold_hit': target >= RULE['threshold'], 'threshold': RULE['threshold'],
            'scope': RULE['scope']}


def reject_external_activity(event, args):
    if event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'):
        raise RuntimeError('offline encoder forbids external activity: ' + event)


def make_host_fixture(identity, receipt, manifest_sha256, queries_sha256):
    return {'id': 'fz3b-pillow-scene-v1', 'manifestSha256': manifest_sha256,
            'queriesSha256': queries_sha256, 'imageSha256': receipt['input_sha256'],
            'predeclaredSha256': receipt['predeclared_sha256'],
            'encoderIdentity': {'contractId': identity['contract_id'], 'weightSha256': identity['weight_sha256'],
                                'bpeSha256': identity['bpe_sha256'], 'normalization': identity['normalization']},
            'queryCount': len(ITEMS), 'embeddingDimensions': 512, 'queryIds': [key for key, unused in ITEMS],
            'width': receipt['input_width'], 'height': receipt['input_height'], 'expectedLabel': 'pillow'}


def verify_runtime_receipt(report):
    candidates = [item for item in report.get('install', []) if item.get('metadata', {}).get('name', '').lower() == 'torch']
    if len(candidates) != 1:
        raise ValueError('fixed Torch installation receipt missing')
    candidate = candidates[0]
    if (candidate.get('metadata', {}).get('version') != '2.8.0' or
            candidate.get('download_info', {}).get('url') != TORCH_WHEEL_URL or
            candidate.get('download_info', {}).get('archive_info', {}).get('hashes', {}).get('sha256') != TORCH_WHEEL_SHA256):
        raise ValueError('fixed Torch installation source/version/SHA-256 differs')


def encode():
    sys.addaudithook(reject_external_activity)
    os.environ.update({'HF_HOME': str(OUTPUT / 'cache/huggingface'), 'TORCH_HOME': str(OUTPUT / 'cache/torch'),
                       'XDG_CACHE_HOME': str(OUTPUT / 'cache'), 'HF_HUB_OFFLINE': '1',
                       'HF_HUB_DISABLE_TELEMETRY': '1', 'HF_HUB_DISABLE_IMPLICIT_TOKEN': '1'})
    spec, receipt = prepare_fixture()
    verify_runtime_receipt(json.loads((OUTPUT / 'encoder-install.json').read_text(encoding='utf-8')))
    if importlib.metadata.version('torch') != '2.8.0':
        raise ValueError('installed Torch version differs')
    import numpy as np
    from PIL import Image
    host = PROJECT / 'engineering/fz3b/source/HOST'
    sys.path.insert(0, str(host))
    from vision_app.contract import load_contract
    from vision_app.text_encoder import TextEncoder
    contract = load_contract(str(CONTRACT))
    encoder = TextEncoder(contract, str(MODELS))
    if {str(parameter.device) for parameter in encoder.model.parameters()} != {'cpu'}:
        raise ValueError('model parameter device is not CPU')
    values, identity = encoder.encode(spec['items'])
    raw, norms = validate_features(values, identity, contract)
    import open_clip.tokenizer as tokenizer_module
    bpe = Path(tokenizer_module.default_bpe())
    repeated, unused = encoder.encode(spec['items'])
    if not np.array_equal(values, repeated):
        raise ValueError('same-process repeated text encoding differs')
    template = {'op': 'queries', 'items': spec['items'],
                'features_f32_b64': base64.b64encode(raw).decode('ascii'), 'identity': identity}
    save_once(FIXTURE / 'text-features.f32', raw)
    save_once(FIXTURE / 'query-template.json', template)
    # Reference uses the same official reparameterized model, CPU FP32 and the
    # official contract's Resize/CenterCrop/ToTensor; no generic CLIP mean/std.
    import mobileclip
    from torchvision.transforms import Compose, Resize, CenterCrop, ToTensor, InterpolationMode
    if Path(mobileclip.__file__).resolve() != (MODELS / 'official-mobileclip/mobileclip/__init__.py').resolve():
        raise ValueError('reference model source location differs')
    transform = Compose([Resize(256, interpolation=InterpolationMode.BILINEAR, antialias=True), CenterCrop(256), ToTensor()])
    with Image.open(FIXTURE / 'input.jpg') as source:
        tensor = transform(source.convert('RGB')).unsqueeze(0)
    with encoder.torch.inference_mode():
        image_features = encoder.model.encode_image(tensor).detach().cpu().float().numpy()
    from vision_app.state import normalized
    image_features = normalized(image_features)
    scores = np.clip(image_features @ values.T, -1, 1)[0].tolist()
    reference = {'backend': 'official mobileclip_s1 reparameterized CPU FP32; not board A0005',
                 'identity': identity, 'image_sha256': receipt['input_sha256'],
                 'text_features_sha256': hashlib.sha256(raw).hexdigest(),
                 'decision': judge_scores([row['id'] for row in spec['items']], scores),
                 'board_comparison': 'not run; score/ranking only, no arbitrary FP32-vs-quantized error tolerance asserted'}
    save_once(FIXTURE / 'host-reference.json', reference)
    files = [FIXTURE / name for name in ('predeclared.json', 'input.jpg', 'input-manifest.json', 'text-features.f32', 'query-template.json', 'host-reference.json')]
    programs = [Path(__file__), Path(__file__).with_name('semantic_assets.py'), Path(__file__).with_name('semantic_cpu_wheel.py'), Path(__file__).with_name('semantic_requirements.txt'), host / 'vision_app/text_encoder.py', host / 'vision_app/contract.py', host / 'vision_app/state.py', CONTRACT]
    result = {'schema_version': 1, 'fixture_id': spec['fixture_id'], 'scope': RULE['scope'],
              'identity': identity, 'text_shape': list(values.shape), 'text_dtype': '<f4', 'text_bytes': len(raw),
              'text_l2_norms': norms, 'repeat_encode_equal': True,
              'text_nonzero_elements': np.count_nonzero(values, axis=1).tolist(),
              'text_pairwise_cosines': np.clip(values @ values.T, -1, 1).tolist(),
              'text_features_sha256': hashlib.sha256(raw).hexdigest(),
              'actual_bpe': {'path': str(bpe), 'sha256': digest(bpe), 'bytes': bpe.stat().st_size,
                             'tokenizer_module_sha256': digest(Path(tokenizer_module.__file__))},
              'asset_provenance_sha256': digest(OUTPUT / 'asset-provenance.json'),
              'cpu_wheel_provenance_sha256': digest(OUTPUT / 'cpu-wheel-provenance.json') if (OUTPUT / 'cpu-wheel-provenance.json').exists() else None,
              'dependency_install_reports': {path.name: digest(path) for path in (OUTPUT / 'pytorch-install.json', OUTPUT / 'encoder-install.json') if path.exists()},
              'query_template_revision': 'consumer must set to fresh service query_revision + 1; no network done by this tool',
              'query_state_effect': 'accepted queries replaces service snapshot; no prior-vector read/restore protocol',
              'files': {file.name: {'sha256': digest(file), 'bytes': file.stat().st_size} for file in files},
              'programs': {str(file.relative_to(PROJECT)).replace('\\', '/'): digest(file) for file in programs},
              'environment': {'python': platform.python_version(), 'executable': sys.executable,
                              'torch_build': encoder.torch.__version__, 'torch_cuda_build': encoder.torch.version.cuda,
                              'requested_device': 'cpu', 'model_parameter_devices': sorted({str(parameter.device) for parameter in encoder.model.parameters()}),
                              'packages': {distribution.metadata['Name']: distribution.version for distribution in importlib.metadata.distributions()}},
              'host_reference_decision': reference['decision'], 'device_inference_run': False,
              'native_authorization': 'not provided or simulated; root owns any subsequent board execution'}
    save_once(FIXTURE / 'encoding-manifest.json', result)
    host_fixture = make_host_fixture(identity, receipt, digest(FIXTURE / 'encoding-manifest.json'), digest(FIXTURE / 'query-template.json'))
    save_once(FIXTURE / 'host-fixture.json', host_fixture)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--encode', action='store_true', help='run actual verified official S1 text and image reference encoding')
    args = parser.parse_args()
    if args.encode:
        result = encode()
    else:
        unused, result = prepare_fixture()
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
