import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import venv

sys.path.insert(0, str(Path(__file__).parents[1] / 'remote'))
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
                        if '--run-installed' in args:
                            kwargs['stdout'].write(b'CANNESS_INSTALLED_PUBLIC\n')
                            if marker:
                                kwargs['stdout'].write(b'CANNESS_PUBLIC_CALL\n')
                                kwargs['stdout'].write((marker + '\n').encode())
                    def wait(self, **kwargs):
                        return 0
                with patch.object(module.subprocess, 'Popen', Process):
                    report = module.validate(root, 30, str(env), 'test.py' if marker else None, lock='')
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

    def test_official_cases_are_isolated_and_fault_does_not_hide_later_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, env = self.fixture(root)
            provenance = json.loads((source / 'provenance.json').read_text())
            provenance['support'] = {'configurations': [{'dtype': 'float16', 'attrs': {'layout': 0}}]}
            (source / 'provenance.json').write_text(json.dumps(provenance))
            (root / 'cases.csv').write_text(
                'operator,case_id,input_shape,dtype,attrs,value_range,note\n'
                'Scan,1,"[[2,4]]","[""float16""]","{""layout"":0}","[[0,1]]",NaN\n'
                'Scan,2,"[[4,2]]","[""torch.FP16""]","{""layout"":0}","[[0,1]]",zeros\n'
                'Scan,3,"[[2,4]]","[""float32""]","{""layout"":0}","[[0,1]]",ordinary\n'
                'Scan,4,"[[2,4]]","[""float16""]","{""layout"":false}","[[0,1]]",ordinary\n'
            )
            processes = []

            class Process:
                returncode = 0

                def __init__(self, args, **kwargs):
                    if 'build.sh' in ' '.join(args):
                        (source / 'dist').mkdir()
                        (source / 'dist' / 'operator.whl').write_bytes(b'wheel')
                    case_json = (kwargs.get('env') or {}).get('CANNESS_CASE_JSON')
                    if case_json:
                        case = json.loads(case_json)
                        processes.append((case, kwargs['cwd'], args[2]))
                        kwargs['stdout'].write(b'CANNESS_INSTALLED_PUBLIC\n')
                        if case['id'] == '1':
                            self.returncode = 1
                            kwargs['stdout'].write(b'vector core exception\n' + b'noise\n' * 5000)
                        else:
                            kwargs['stdout'].write(b'CANNESS_PUBLIC_CALL\nCANNESS_VALIDATION {"ok":true,"mere":0.0,"mare":0.01}\n')

                def wait(self, **kwargs):
                    return self.returncode

            with patch.object(module.subprocess, 'Popen', Process):
                report = module.validate(root, 30, str(env), 'test.py', cases_file='cases.csv', device='3', lock='')

            self.assertEqual(report['status'], 'blocked')
            self.assertEqual(report['device']['id'], '3')
            self.assertEqual(report['coverage'], '1/4')
            self.assertEqual([case['status'] for case in report['cases']], ['blocked', 'passed', 'unsupported', 'unsupported'])
            self.assertEqual(report['cases'][0]['failureKind'], 'device_fault')
            self.assertEqual(report['cases'][1]['mere'], 0.0)
            self.assertEqual(report['cases'][1]['mare'], 0.01)
            self.assertEqual([step['status'] for step in report['stages'].values()], ['passed', 'passed', 'blocked', 'unverified'])
            self.assertEqual([case[0]['note'] for case in processes], ['NaN', 'zeros'])
            self.assertEqual(processes[0][0]['input_shape'], [[2, 4]])
            self.assertNotEqual(processes[0][1], processes[1][1])
            self.assertIn('ASCEND_VISIBLE_DEVICES=3', processes[1][2])

    @unittest.skipIf(sys.platform == 'win32', 'flock is used on the remote Linux host')
    def test_contended_device_lock_is_bounded_and_does_not_execute_comparator(self):
        import fcntl

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock = root / 'device.lock'
            with lock.open('w') as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(module.DeviceUnavailable, 'lock'):
                    with module.device_lock(str(lock), 0):
                        self.fail('an already locked device must never be entered')

    def test_wheel_callable_evidence_requires_an_actual_public_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = venv.EnvBuilder(with_pip=False).ensure_directories(root / 'venv')
            venv.EnvBuilder(with_pip=False).create(root / 'venv')
            python = Path(env.env_exe)
            site = Path(subprocess.check_output([str(python), '-c', 'import site; print(site.getsitepackages()[-1])'], text=True).strip())
            package = site / 'cann_bench'
            package.mkdir()
            (package / '__init__.py').write_text(
                'class UnsupportedConfiguration(ValueError):\n    pass\n'
                'def scan(input, dim):\n'
                '    if dim == 4: raise UnsupportedConfiguration("alignment is unsupported")\n'
                '    return input + dim\n'
            )
            script = root / 'test.py'
            cmd = [str(python), '-I', module.__file__, '--run-installed', 'scan', str(root / 'venv'), str(script)]
            for call in (False, True):
                script.write_text('from cann_bench import scan\n' + ('assert scan(2, 3) == 5\n' if call else '') + 'print(\'CANNESS_VALIDATION {"ok":true}\')\n')
                completed = subprocess.run(cmd, capture_output=True, text=True)
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn('CANNESS_INSTALLED_PUBLIC', completed.stdout)
                self.assertEqual('CANNESS_PUBLIC_CALL' in completed.stdout, call)
            script.write_text('from cann_bench import scan\nscan(2, 4)\n')
            rejected = subprocess.run(cmd, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('CANNESS_UNSUPPORTED_CALL alignment is unsupported', rejected.stdout)


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
