import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('submission_validation', Path(__file__).parents[1] / 'remote' / 'validate_submission.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ValidationTests(unittest.TestCase):
    def fixture(self, root):
        source = root / 'source'
        source.mkdir()
        body = b'echo build'
        (source / 'build.sh').write_bytes(body)
        (source / 'cann_bench').mkdir()
        wrapper = b'def scan(input, dim):\n    return input\n'
        (source / 'cann_bench' / '__init__.py').write_bytes(wrapper)
        signature = 'scan(input, dim)'
        (source / 'provenance.json').write_text(json.dumps({'callable':'scan','signature':signature,'publicSignatureHash':hashlib.sha256(signature.encode()).hexdigest(),'files': {'build.sh': hashlib.sha256(body).hexdigest(),'cann_bench/__init__.py':hashlib.sha256(wrapper).hexdigest()}}))
        env = root / 'set_env.sh'
        env.write_text('true')
        return source, env

    def test_tamper_fails_before_any_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, env = self.fixture(root)
            (source / 'build.sh').write_text('changed')
            with patch.object(module.subprocess, 'Popen') as launch:
                report = module.validate(root, 30, str(env))
            launch.assert_not_called()
            self.assertEqual(report['correctness'], 'unverified')
            self.assertIn('hash mismatch', report['reason'])

    def test_build_install_and_explicit_golden_marker(self):
        for marker, expected in [(None, 'installed'), ('CANNESS_VALIDATION {"ok":true,"cases":4}', 'validated'), ('import succeeded', 'failed'), ('CANNESS_VALIDATION {"ok":true}\n' + 'noise\n' * 5000 + 'CANNESS_VALIDATION {"ok":true}', 'failed'), ('CANNESS_VALIDATION {"ok":true}\n' + 'noise\n' * 5000, 'validated')]:
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source, env = self.fixture(root)
                commands = []
                class Process:
                    returncode = 0
                    def __init__(self, args, **kwargs):
                        commands.append((args, kwargs))
                        if 'build.sh' in ' '.join(args):
                            (source / 'dist').mkdir()
                            (source / 'dist' / 'operator.whl').write_bytes(b'wheel')
                        if '-I' in ' '.join(args):
                            kwargs['stdout'].write((marker + '\n').encode())
                    def wait(self, **kwargs):
                        return 0
                with patch.object(module.subprocess, 'Popen', Process):
                    report = module.validate(root, 30, str(env), 'test.py' if marker else None)
                self.assertEqual(report['status'], expected)
                self.assertIn('--system-site-packages', commands[1][0])
                self.assertIn('--no-deps', commands[2][0])
                self.assertIn('--no-index', commands[2][0])
                if marker:
                    self.assertEqual(commands[3][1]['cwd'], str(root / 'test-work'))
                    self.assertNotEqual(commands[3][1]['cwd'], str(source))
                    self.assertNotIn('PYTHONPATH', commands[3][1]['env'])
                if expected != 'validated':
                    self.assertEqual(report['correctness'], 'unverified')


class ProtocolReviewTests(unittest.TestCase):
    def test_all_markers_are_counted_even_before_display_tail(self):
        with tempfile.TemporaryFile() as output:
            output.write(b'CANNESS_VALIDATION {"ok":true}\n' + b'noise\n' * 5000 + b'CANNESS_VALIDATION {"ok":true}\n')
            text, markers = module.read_command_output(output)
            self.assertLessEqual(len(text), 16000)
            self.assertEqual(len(markers), 2)

    def test_public_signature_must_match_wrapper_ast(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp)
            (source / 'cann_bench').mkdir()
            (source / 'cann_bench' / '__init__.py').write_text('def scan(input, dim, inner):\n    return input\n')
            declaration = {'callable':'scan','signature':'scan(input, dim)', 'publicSignatureHash':hashlib.sha256(b'scan(input, dim)').hexdigest()}
            with self.assertRaisesRegex(ValueError, 'signature mismatch'):
                module.verify_public_signature(source, declaration)

    def test_oversized_output_is_rejected(self):
        with tempfile.TemporaryFile() as output:
            output.truncate(module.MAX_OUTPUT_BYTES + 1)
            with self.assertRaisesRegex(ValueError, 'output exceeds'):
                module.read_command_output(output)

if __name__ == '__main__':
    unittest.main()
