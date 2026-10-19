"""Offline fixed-input/provenance/decision tests, never device or service I/O."""
import ast
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0, str(TOOLS))
import semantic_assets as assets
import semantic_encode as encode
import semantic_cpu_wheel as wheel


class SemanticTools(unittest.TestCase):
    def test_contract_and_source_are_fixed_real_s1(self):
        contract = assets.read_contract()
        self.assertEqual(contract['contract_id'], encode.CONTRACT_ID)
        self.assertEqual(len(contract['source_files']), 22)
        for relative, expected in contract['source_files'].items():
            self.assertEqual(assets.digest(assets.SOURCE / relative), expected)
        self.assertEqual(assets.WEIGHT_BYTES, 340784294)
        self.assertEqual(assets.WEIGHT_SHA256, contract['weight_sha256'])
        self.assertEqual(assets.WEIGHT_URL, 'https://docs-assets.developer.apple.com/ml-research/datasets/mobileclip/mobileclip_s1.pt')

    def test_four_prompts_ground_truth_and_threshold_predeclared(self):
        declaration = encode.declaration()
        self.assertEqual([item['text'] for item in declaration['items']], [
            'a photo of a pillow', 'a photo of a cup', 'a photo of a mobile phone', 'a photo of a bottle'])
        self.assertEqual(declaration['decision_rule']['expected_top1'], 'pillow')
        self.assertEqual(declaration['decision_rule']['threshold'], 0.2)
        self.assertTrue(declaration['no_adaptive_prompts_or_threshold'])
        self.assertEqual(encode.CROP, (127, 166, 1041, 678))

    def test_input_preparation_is_fixed_hash_bound_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(encode, 'FIXTURE', Path(directory)):
            spec, receipt = encode.prepare_fixture()
            self.assertEqual(receipt['input_width'], 914)
            self.assertEqual(receipt['input_height'], 512)
            self.assertFalse(receipt['device_inference_run'])
            self.assertFalse(receipt['image_is_synthetic'])
            self.assertEqual(encode.prepare_fixture(), (spec, receipt))
            saved = json.loads((Path(directory) / 'predeclared.json').read_text(encoding='utf-8'))
            self.assertEqual(saved, spec)
            self.assertEqual(assets.digest(Path(directory) / 'input.jpg'), receipt['input_sha256'])

    def test_reference_tamper_rejected_before_artifact_write(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(encode, 'FIXTURE', Path(directory)), patch.object(encode, 'SCENE_SHA256', '0' * 64):
            with self.assertRaisesRegex(ValueError, 'screenshot SHA'):
                encode.prepare_fixture()
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_immutable_artifact_refuses_different_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.json'
            encode.save_once(path, {'a': 1})
            original = path.read_bytes()
            encode.save_once(path, {'a': 1})
            with self.assertRaisesRegex(ValueError, 'immutable'):
                encode.save_once(path, {'a': 2})
            self.assertEqual(path.read_bytes(), original)

    def dense_shaped_values(self):
        values = np.arange(1, 2049, dtype=np.float32).reshape(4, 512)
        return (values / np.linalg.norm(values.astype(np.float64), axis=1, keepdims=True)).astype(np.float32)

    def identity(self):
        contract = assets.read_contract()
        return dict({key: contract[key] for key in ('contract_id', 'weight_sha256', 'source_revision', 'normalization', 'bpe_sha256')}, tokenizer_context=77)

    def test_feature_bytes_match_little_endian_float32(self):
        values = self.dense_shaped_values()
        raw, norms = encode.validate_features(values, self.identity(), assets.read_contract())
        self.assertEqual(len(raw), 8192)
        np.testing.assert_array_equal(np.frombuffer(raw, dtype='<f4').reshape(4, 512), values)
        self.assertTrue(all(abs(norm - 1) < 1e-6 for norm in norms))

    def test_nan_zero_e0_wrong_extent_dtype_norm_rejected(self):
        good = self.dense_shaped_values()
        bad = good.copy()
        bad[0, 0] = np.nan
        e0 = np.zeros((4, 512), dtype=np.float32)
        e0[:, 0] = 1
        for values in (bad, good[:1], good.astype(np.float64), np.zeros_like(good), e0, good * 2):
            with self.subTest(shape=values.shape, dtype=values.dtype):
                with self.assertRaises(ValueError):
                    encode.validate_features(values, self.identity(), assets.read_contract())

    def test_each_identity_field_and_context_are_enforced(self):
        for key in self.identity():
            identity = self.identity()
            identity[key] = 'wrong'
            with self.subTest(key=key), self.assertRaises(ValueError):
                encode.validate_features(self.dense_shaped_values(), identity, assets.read_contract())

    def test_runtime_audit_denies_network_and_subprocesses(self):
        for event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'):
            with self.subTest(event=event), self.assertRaisesRegex(RuntimeError, 'offline encoder'):
                encode.reject_external_activity(event, ())
        encode.reject_external_activity('open', ())

    def test_host_fixture_matches_exact_backend_keyset_and_fixed_queries(self):
        receipt = {'input_sha256': 'a' * 64, 'predeclared_sha256': 'b' * 64, 'input_width': 914, 'input_height': 512}
        fixture = encode.make_host_fixture(self.identity(), receipt, 'c' * 64, 'd' * 64)
        self.assertEqual(set(fixture), {'id', 'manifestSha256', 'queriesSha256', 'imageSha256', 'predeclaredSha256', 'width', 'height', 'queryCount', 'embeddingDimensions', 'expectedLabel', 'queryIds', 'encoderIdentity'})
        self.assertEqual(set(fixture['encoderIdentity']), {'contractId', 'weightSha256', 'bpeSha256', 'normalization'})
        self.assertEqual(fixture['queryIds'], ['pillow', 'cup', 'mobile-phone', 'bottle'])
        self.assertEqual((fixture['width'], fixture['height'], fixture['queryCount'], fixture['embeddingDimensions']), (914, 512, 4, 512))
        self.assertEqual(fixture['expectedLabel'], 'pillow')

    def test_torch_receipt_requires_fixed_official_version_url_and_sha(self):
        candidate = {'metadata': {'name': 'torch', 'version': '2.8.0'},
                     'download_info': {'url': encode.TORCH_WHEEL_URL, 'archive_info': {'hashes': {'sha256': encode.TORCH_WHEEL_SHA256}}}}
        encode.verify_runtime_receipt({'install': [candidate]})
        for field, value in (('version', '2.9.0'), ('url', 'https://attacker.invalid/torch.whl'), ('sha256', '0' * 64)):
            bad = json.loads(json.dumps(candidate))
            if field == 'version':
                bad['metadata'][field] = value
            elif field == 'url':
                bad['download_info'][field] = value
            else:
                bad['download_info']['archive_info']['hashes'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                encode.verify_runtime_receipt({'install': [bad]})
        with self.assertRaises(ValueError):
            encode.verify_runtime_receipt({'install': []})

    def test_ranking_and_threshold_are_independent_honest_results(self):
        ids = [row[0] for row in encode.ITEMS]
        low = encode.judge_scores(ids, [0.19, 0.1, 0.08, 0.07])
        self.assertTrue(low['semantic_consistency_pass'])
        self.assertFalse(low['target_threshold_hit'])
        failed = encode.judge_scores(ids, [0.3, 0.4, 0.1, 0.2])
        self.assertFalse(failed['semantic_consistency_pass'])
        self.assertTrue(failed['target_threshold_hit'])
        tied = encode.judge_scores(ids, [0.3, 0.3, 0.1, 0.2])
        self.assertFalse(tied['semantic_consistency_pass'])
        self.assertEqual(tied['threshold'], 0.2)

    def test_bad_ranking_input_cannot_manufacture_success(self):
        ids = [row[0] for row in encode.ITEMS]
        for scores in ([float('nan'), 0, 0, 0], [True, 0, 0, 0], [2, 0, 0, 0], [0]):
            with self.assertRaises(ValueError):
                encode.judge_scores(ids, scores)
        with self.assertRaises(ValueError):
            encode.judge_scores(ids[::-1], [0.4, 0.3, 0.2, 0.1])

    def test_encode_has_no_network_process_device_or_arbitrary_input_api(self):
        tree = ast.parse((TOOLS / 'semantic_encode.py').read_text(encoding='utf-8'))
        modules = [node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
        modules += [name.name for node in ast.walk(tree) if isinstance(node, ast.Import) for name in node.names]
        self.assertFalse(set(modules) & {'socket', 'subprocess', 'paramiko', 'serial', 'vision_app.board_agent', 'vision_app.board_runtime'})
        flags = [node.args[0].value for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == 'add_argument']
        self.assertEqual(flags, ['--encode'])

    def test_weight_redirect_must_remain_official_https(self):
        handler = assets.AppleOnlyRedirect()
        for address in ('http://docs-assets.developer.apple.com/model', 'https://attacker.invalid/model', 'https://docs-assets.developer.apple.com.attacker.invalid/model'):
            with self.subTest(address=address), self.assertRaisesRegex(ValueError, 'official host'):
                handler.redirect_request(None, None, 302, '', {}, address)

    def test_existing_weight_mismatch_does_not_network_or_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'mobileclip_s1.pt'
            target.write_bytes(b'wrong')
            with patch('urllib.request.build_opener') as opener:
                with self.assertRaisesRegex(ValueError, 'refusing overwrite'):
                    assets.download_weight(target)
                opener.assert_not_called()
            self.assertEqual(target.read_bytes(), b'wrong')

    def range_response(self, status=206, content_range='bytes 0-2/3', data=(b'abc', b'')):
        response = MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = wheel.URL
        response.status = status
        response.headers = {'Content-Range': content_range}
        response.read1.side_effect = data
        opener = MagicMock()
        opener.open.return_value = response
        return opener, response

    def test_cpu_wheel_fixed_range_and_length_checked(self):
        opener, response = self.range_response()
        with patch.object(wheel, 'SIZE', 3):
            self.assertEqual(wheel.read_range(opener, 0, 2), b'abc')
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, wheel.URL)
        self.assertEqual(request.get_header('Range'), 'bytes=0-2')
        self.assertEqual(opener.open.call_args.kwargs, {'timeout': 20})

    def test_cpu_wheel_bad_range_status_extent_and_url_rejected(self):
        for status, content_range, data in ((200, 'bytes 0-2/3', (b'abc', b'')), (206, 'bytes 1-3/4', (b'abc', b'')),
                                            (206, 'bytes 0-2/3', (b'ab', b'')), (206, 'bytes 0-2/3', (b'abcd',))):
            opener, unused = self.range_response(status, content_range, data)
            with patch.object(wheel, 'SIZE', 3), self.assertRaises(ValueError):
                wheel.read_range(opener, 0, 2)
        opener, response = self.range_response()
        response.geturl.return_value = 'https://attacker.invalid/wheel'
        with patch.object(wheel, 'SIZE', 3), self.assertRaises(ValueError):
            wheel.read_range(opener, 0, 2)

    def test_cpu_wheel_range_total_deadline_and_redirect_rejected(self):
        opener, response = self.range_response()
        with patch.object(wheel, 'SIZE', 3), patch.object(wheel.time, 'monotonic', side_effect=[0, 61]), self.assertRaises(TimeoutError):
            wheel.read_range(opener, 0, 2)
        response.read1.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'must not redirect'):
            wheel.NoRedirect().redirect_request(None)

    def test_cpu_wheel_resume_only_complete_chunks_and_final_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'test.whl'
            partial = target.with_suffix('.whl.partial')
            partial.write_bytes(b'ab')
            expected = hashlib.sha256(b'abc').hexdigest()
            with patch.object(wheel, 'TARGET', target), patch.object(wheel, 'OUTPUT', root), patch.object(wheel, 'SIZE', 3), patch.object(wheel, 'CHUNK', 2), patch.object(wheel, 'SHA256', expected), patch.object(wheel, 'read_range', return_value=b'c') as read:
                result = wheel.download()
                read.assert_called_once()
                self.assertEqual(read.call_args.args[1:], (2, 2))
                self.assertEqual(result['sha256'], expected)
                self.assertEqual(target.read_bytes(), b'abc')
                self.assertFalse(partial.exists())
            target.unlink()
            partial.write_bytes(b'x')
            with patch.object(wheel, 'TARGET', target), patch.object(wheel, 'SIZE', 3), patch.object(wheel, 'CHUNK', 2), self.assertRaisesRegex(ValueError, 'complete fixed range'):
                wheel.download()

    def test_cpu_wheel_final_digest_failure_keeps_uninstallable_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'test.whl'
            with patch.object(wheel, 'TARGET', target), patch.object(wheel, 'OUTPUT', root), patch.object(wheel, 'SIZE', 3), patch.object(wheel, 'CHUNK', 3), patch.object(wheel, 'SHA256', '0' * 64), patch.object(wheel, 'read_range', return_value=b'abc'), self.assertRaisesRegex(ValueError, 'not installable'):
                wheel.download()
            self.assertFalse(target.exists())
            self.assertEqual(target.with_suffix('.whl.partial').read_bytes(), b'abc')


if __name__ == '__main__':
    unittest.main(verbosity=2)
