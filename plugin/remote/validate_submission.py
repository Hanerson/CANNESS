#!/usr/bin/env python3
"""Isolated exported-wheel validation. No evaluation policy state is read or written."""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time


MAX_OUTPUT_BYTES = 8 * 1024 * 1024


def read_command_output(output):
    size = os.fstat(output.fileno()).st_size
    if size > MAX_OUTPUT_BYTES:
        raise ValueError('command output exceeds 8 MiB limit')
    output.seek(0)
    markers = []
    for line in output:
        if line.startswith(b'CANNESS_VALIDATION '):
            markers.append(line[len(b'CANNESS_VALIDATION '):].decode(errors='replace').strip())
    output.seek(max(0, size - 16000))
    return output.read(16000).decode(errors='replace'), markers


def verify_public_signature(source, provenance):
    signature = provenance.get('signature')
    callable_name = provenance.get('callable')
    if not isinstance(signature, str) or not isinstance(callable_name, str):
        raise ValueError('missing public signature declaration')
    if hashlib.sha256(signature.encode()).hexdigest() != provenance.get('publicSignatureHash'):
        raise ValueError('public signature hash mismatch')
    try:
        declaration = ast.parse('def ' + signature + ':\n    pass\n')
        if len(declaration.body) != 1 or not isinstance(declaration.body[0], ast.FunctionDef):
            raise ValueError('invalid public signature declaration')
        expected = declaration.body[0]
        module = ast.parse((source / 'cann_bench' / '__init__.py').read_text(encoding='utf-8'))
        functions = [node for node in module.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == callable_name]
        if expected.name != callable_name or len(functions) != 1 or not isinstance(functions[0], ast.FunctionDef):
            raise ValueError('public signature mismatch: expected one synchronous module function')
        if ast.dump(expected.args, include_attributes=False) != ast.dump(functions[0].args, include_attributes=False):
            raise ValueError('public signature mismatch between declaration and wrapper source')
    except SyntaxError as error:
        raise ValueError('invalid wrapper or public signature syntax') from error


def verify_sources(source):
    if source.is_symlink():
        raise ValueError('source directory is a symlink')
    source = source.resolve()
    provenance = json.loads((source / 'provenance.json').read_text())
    declared = provenance['files']
    if not isinstance(declared, dict) or not declared:
        raise ValueError('provenance.files must contain source hashes')
    actual = set()
    for path in source.rglob('*'):
        if path.is_symlink():
            raise ValueError('source symlinks are not allowed')
        if path.is_file() and path.name != 'provenance.json':
            actual.add(path.relative_to(source).as_posix())
        elif not path.is_dir() and not path.is_file():
            raise ValueError('non-regular source file')
    if actual != set(declared):
        raise ValueError('provenance file list mismatch')
    for name, digest in declared.items():
        path = source / name
        if not path.resolve().is_relative_to(source) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('provenance hash mismatch: ' + name)
    verify_public_signature(source, provenance)


def validate(root, timeout_sec, set_env=None, test_script=None):
    source = root / 'source'
    report = {'status': 'failed', 'correctness': 'unverified', 'steps': []}
    deadline = time.monotonic() + timeout_sec
    def run(name, args, cwd, env=None):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('validation time budget exhausted')
        with tempfile.TemporaryFile() as output:
            process = subprocess.Popen(args, cwd=str(cwd), env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                while True:
                    if os.fstat(output.fileno()).st_size > MAX_OUTPUT_BYTES:
                        raise ValueError(name + ' output exceeds 8 MiB limit')
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(name + ' timed out')
                    try:
                        process.wait(timeout=min(remaining, 0.2))
                        break
                    except subprocess.TimeoutExpired:
                        continue
            except (TimeoutError, ValueError):
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
            text, markers = read_command_output(output)
        report['steps'].append({'step': name, 'code': process.returncode, 'output': text[-4000:]})
        if process.returncode != 0:
            raise RuntimeError(name + ' failed')
        return text, markers
    try:
        verify_sources(source)
        report['publicSignature'] = 'source-verified'
        configured = set_env
        if not configured:
            candidates = [os.environ.get('ASCEND_TOOLKIT_HOME', '') + '/set_env.sh', os.environ.get('ASCEND_HOME_PATH', '') + '/set_env.sh', '/home/developer/Ascend/ascend-toolkit/set_env.sh', '/usr/local/Ascend/ascend-toolkit/set_env.sh', '/usr/local/Ascend/ascend-toolkit/latest/set_env.sh', '/opt/Ascend/ascend-toolkit/set_env.sh']
            configured = next((path for path in candidates if path != '/set_env.sh' and Path(path).is_file()), None)
        if not configured or not Path(configured).is_file():
            raise ValueError('CANN set_env.sh not found; provide setEnv explicitly')
        report['setEnv'] = configured
        # Positional arguments preserve literal paths, including whitespace and quotes.
        run('build', ['bash', '-c', 'set -e; source "$1"; exec bash build.sh', 'canness-validation', configured], source)
        wheels = list((source / 'dist').glob('*.whl'))
        if len(wheels) != 1:
            raise ValueError('build must produce exactly one wheel in dist/')
        venv = root / 'venv'
        run('venv', ['python3', '-m', 'venv', '--system-site-packages', str(venv)], root)
        python = venv / 'bin' / 'python'
        run('install', [str(python), '-m', 'pip', 'install', '--no-deps', '--no-index', '--ignore-installed', str(wheels[0])], root)
        report['status'] = 'installed'
        report['wheel'] = wheels[0].name
        if test_script:
            work = root / 'test-work'
            work.mkdir()
            env = dict(os.environ)
            env.pop('PYTHONPATH', None)
            # -I removes script/source paths and PYTHON* overrides from imports.
            text, markers = run('test', ['bash', '-c', 'set -e; source "$1"; exec "$2" -I "$3"', 'canness-validation', configured, str(python), str(root / test_script)], work, env)
            if len(markers) != 1 or json.loads(markers[0]).get('ok') is not True:
                raise ValueError('test must emit exactly one CANNESS_VALIDATION JSON object with ok:true')
            report['correctness'] = 'user-golden-passed'
            report['testResult'] = json.loads(markers[0])
            report['status'] = 'validated'
    except Exception as error:
        report['status'] = 'failed'
        report['reason'] = str(error)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--timeout-sec', type=int, default=600)
    parser.add_argument('--set-env')
    parser.add_argument('--test-script')
    args = parser.parse_args()
    report = validate(Path(args.root).resolve(), max(1, min(3600, args.timeout_sec)), args.set_env, args.test_script)
    print('CANNESS_SUBMISSION_REPORT ' + json.dumps(report))
    return 0 if report['status'] != 'failed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
