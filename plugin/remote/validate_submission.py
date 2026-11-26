#!/usr/bin/env python3
"""Isolated exported-wheel validation. No evaluation policy state is read or written."""
import argparse
import ast
from contextlib import contextmanager
import csv
from functools import wraps
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import re
import runpy
import shlex
import signal
import subprocess
import sys
import tempfile
import time


MAX_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_CASES_BYTES = 1024 * 1024
DEVICE_ERRORS = {
    'device_fault': re.compile(rb'vector core exception|aivec error|aicore exception|GM address accessed by scalar exceeds', re.I),
    'device_unavailable': re.compile(rb'no visible (?:npu )?devices?|\b(?:npu )?device (?:is )?busy\b|no npu devices? (?:found|available)', re.I),
}
DTYPE_ALIASES = {
    'fp16': 'float16', 'half': 'float16', 'fp32': 'float32', 'float': 'float32',
    'bf16': 'bfloat16', 'i32': 'int32', 'i64': 'int64',
}
PUBLIC_DTYPES = {'float16', 'float32', 'bfloat16', 'int32', 'int64'}


class DeviceUnavailable(RuntimeError):
    pass


def read_command_output(output, evidence=None):
    size = os.fstat(output.fileno()).st_size
    if size > MAX_OUTPUT_BYTES:
        raise ValueError('command output exceeds 8 MiB limit')
    output.seek(0)
    markers = []
    for line in output:
        if line.startswith(b'CANNESS_VALIDATION '):
            markers.append(line[len(b'CANNESS_VALIDATION '):].decode(errors='replace').strip())
        if evidence is not None:
            if line.rstrip() == b'CANNESS_INSTALLED_PUBLIC':
                evidence['installed'] = True
            if line.rstrip() == b'CANNESS_PUBLIC_CALL':
                evidence['called'] = True
            if line.startswith(b'CANNESS_UNSUPPORTED_CALL '):
                evidence['unsupported'] = line[len(b'CANNESS_UNSUPPORTED_CALL '):].decode(errors='replace').strip()
            for kind, pattern in DEVICE_ERRORS.items():
                match = pattern.search(line)
                if match:
                    evidence.setdefault(kind, match.group().decode())
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
    return provenance


def load_cases(path):
    if path.stat().st_size > MAX_CASES_BYTES:
        raise ValueError('cases CSV exceeds 1 MiB')
    with path.open(encoding='utf-8-sig', newline='') as file:
        reader = csv.DictReader(file, strict=True)
        columns = reader.fieldnames or []
        if 'case_id' not in columns or len(set(columns)) != len(columns):
            raise ValueError('cases CSV must have unique column names including case_id')
        cases = []
        ids = set()
        for row in reader:
            if None in row or any(value is None for value in row.values()):
                raise ValueError(f'cases CSV row {reader.line_num} has a different field count than the header')
            case_id = row['case_id'].strip()
            if not case_id or case_id in ids:
                raise ValueError(f'cases CSV row {reader.line_num} has a missing or duplicate case_id')
            ids.add(case_id)
            for field in ('input_shape', 'dtype', 'attrs', 'value_range'):
                if row.get(field):
                    try:
                        row[field] = json.loads(row[field], parse_constant=lambda value: value)
                    except json.JSONDecodeError:
                        # Preserve task-specific metadata, such as special-value literals.
                        pass
            cases.append({**row, 'id': case_id})
        if not cases:
            raise ValueError('cases CSV contains no cases')
    return cases


def support_mismatch(case, support):
    rows = support.get('configurations') if isinstance(support, dict) else None
    if not rows:
        return False
    dtype = case.get('dtype')
    if isinstance(dtype, list) and dtype:
        dtype = dtype[0]
    dtype = re.sub(r'[^a-z0-9]', '', dtype.strip().lower().removeprefix('torch.')) if isinstance(dtype, str) else ''
    dtype = DTYPE_ALIASES.get(dtype, dtype)
    attrs = case.get('attrs')

    def may_match(row):
        if dtype in PUBLIC_DTYPES and 'dtype' in row and dtype != row['dtype']:
            return False
        # Missing metadata cannot prove that a case is unsupported.
        return not isinstance(attrs, dict) or all(
            name not in attrs or (attrs[name] == value and isinstance(attrs[name], bool) == isinstance(value, bool))
            for name, value in row.get('attrs', {}).items()
        )

    return not any(may_match(row) for row in rows)


@contextmanager
def device_lock(path, timeout):
    if not path:
        yield
        return
    import fcntl

    deadline = time.monotonic() + timeout
    lock = Path(path)
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a') as file:
        while True:
            try:
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise DeviceUnavailable(f'timed out waiting for shared device lock {path}') from None
                time.sleep(min(remaining, 0.1))
        yield


def run_installed(callable_name, venv, test_script=None):
    package = importlib.import_module('cann_bench')
    if not Path(package.__file__).resolve().is_relative_to(Path(venv).resolve()):
        raise ValueError('cann_bench was not imported from the isolated wheel environment')
    public = getattr(package, callable_name)
    if not callable(public):
        raise TypeError(f'installed cann_bench.{callable_name} is not callable')
    print('CANNESS_INSTALLED_PUBLIC', flush=True)
    if test_script:
        called = False
        unsupported = getattr(package, 'UnsupportedConfiguration', None)

        @wraps(public)
        def record_call(*args, **kwargs):
            nonlocal called
            try:
                result = public(*args, **kwargs)
            except ValueError as error:
                if isinstance(unsupported, type) and isinstance(error, unsupported):
                    print('CANNESS_UNSUPPORTED_CALL ' + ' '.join(str(error).splitlines())[:1000], flush=True)
                raise
            if not called:
                print('CANNESS_PUBLIC_CALL', flush=True)
                called = True
            return result

        setattr(package, callable_name, record_call)
        sys.argv = [test_script]
        runpy.run_path(test_script, run_name='__main__')


def comparator_result(markers):
    if len(markers) != 1:
        return None
    try:
        result = json.loads(markers[0], parse_constant=lambda _: None)
        # json.dumps also rejects finite JSON literals that overflowed to infinity.
        json.dumps(result, allow_nan=False)
    except (ValueError, RecursionError):
        return None
    return result if isinstance(result, dict) and isinstance(result.get('ok'), bool) else None


def case_result(case, status, evidence=None, result=None, reason=None, failure_kind=None):
    outcome = {'id': case['id'], 'status': status, 'pass': status == 'passed', 'mere': None, 'mare': None,
               'call': 'passed' if evidence and evidence.get('called') else 'unverified'}
    for key in ('mere', 'mare'):
        value = (result or {}).get(key)
        if type(value) in (int, float) and 0 <= value <= sys.float_info.max and math.isfinite(value):
            outcome[key] = value
    if reason:
        outcome['reason'] = reason
    if failure_kind:
        outcome['failureKind'] = failure_kind
    return outcome


def validate(root, timeout_sec, set_env=None, test_script=None, *, cases_file=None,
             case_timeout_sec=None, device=None, lock=None):
    from runner import bash_path, discover_set_env, resolve_device_settings, shell_env_prefix

    source = root / 'source'
    stages = {name: {'status': 'unverified'} for name in ('build', 'install', 'call', 'accuracy')}
    report = {'status': 'failed', 'correctness': 'unverified', 'steps': [], 'stages': stages}
    deadline = time.monotonic() + timeout_sec
    phase = 'provenance'

    def run(name, args, cwd, env=None, case_id=None, limit=None):
        step = {'step': name, 'code': None, 'output': ''}
        if case_id is not None:
            step['caseId'] = case_id
        report['steps'].append(step)
        command_deadline = min(deadline, time.monotonic() + limit) if limit is not None else deadline
        if command_deadline <= time.monotonic():
            step['error'] = 'validation time budget exhausted'
            return step, [], {}
        failure = None
        evidence = {}
        with tempfile.TemporaryFile() as output:
            try:
                process = subprocess.Popen(args, cwd=str(cwd), env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            except OSError as error:
                step['error'] = str(error)
                return step, [], {}
            try:
                while True:
                    if os.fstat(output.fileno()).st_size > MAX_OUTPUT_BYTES:
                        raise ValueError(name + ' output exceeds 8 MiB limit')
                    remaining = command_deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(name + ' timed out')
                    try:
                        process.wait(timeout=min(remaining, 0.2))
                        break
                    except subprocess.TimeoutExpired:
                        continue
            except (TimeoutError, ValueError) as error:
                failure = str(error)
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            try:
                tail, markers = read_command_output(output, evidence)
            except ValueError as error:
                tail, markers = '', []
                failure = str(error)
        step.update(code=process.returncode, output=tail[-4000:])
        if failure or process.returncode != 0:
            step['error'] = failure or (name + ' failed')
        if failure and failure.endswith('timed out'):
            step['timedOut'] = True
        return step, markers, evidence

    def run_required(name, argv, cwd):
        step, _, _ = run(name, argv, cwd)
        if step.get('error'):
            raise RuntimeError(step['error'])

    def test_case(case, work, limit=None):
        work.mkdir(parents=True)
        env = {key: value for key, value in os.environ.items() if key not in ('PYTHONPATH', 'CANNESS_CASE_JSON')}
        if cases_file:
            env['CANNESS_CASE_JSON'] = json.dumps(case, ensure_ascii=True)
        args = [bash, '-c', prefix + 'exec "$@"', 'canness-validation', bash_path(python), '-I',
                bash_path(Path(__file__).resolve()), '--run-installed', provenance['callable'], bash_path(venv)]
        if test_script:
            args.append(bash_path(root / test_script))
        step, markers, evidence = run('test' if test_script else 'import', args, work, env, case['id'] if cases_file else None, limit)
        if evidence.get('installed'):
            stages['install']['publicCallable'] = 'verified'
        result = comparator_result(markers)
        if not step.get('error') and evidence.get('installed') and not test_script:
            return case_result(case, 'unverified'), None
        if not step.get('error') and evidence.get('called') and result and result['ok']:
            return case_result(case, 'passed', evidence, result), result
        for kind in DEVICE_ERRORS:
            if evidence.get(kind):
                return case_result(case, 'blocked', evidence, result, evidence[kind], kind), result
        if evidence.get('unsupported') and not evidence.get('called'):
            return case_result(case, 'unsupported', evidence, result, evidence['unsupported']), result
        if not evidence.get('installed'):
            kind = 'install' if step.get('code') and not step.get('timedOut') and not stages['install'].get('publicCallable') else 'call'
            reason = step.get('error', 'installed public callable could not be imported')
        elif not evidence.get('called'):
            kind = 'call'
            reason = step.get('error') or 'comparator did not complete a public callable invocation'
        else:
            kind = 'assert'
            reason = 'comparator reported an accuracy failure' if result and not result['ok'] else (step.get('error') or 'test must emit exactly one CANNESS_VALIDATION JSON object with ok:true')
        return case_result(case, 'failed', evidence, result, reason, kind), result

    try:
        provenance = verify_sources(source)
        report['publicSignature'] = 'source-verified'
        phase = 'input'
        if cases_file and not test_script:
            raise ValueError('cases CSV requires a test script to run the public callable and compare results')
        cases = load_cases(root / cases_file) if cases_file else [{'id': 'single'}]
        if device is not None and not re.fullmatch(r'[0-9]+', device):
            raise ValueError('device ID must be a nonnegative integer')
        device, lock = resolve_device_settings(device, lock)
        report['device'] = {'id': device, 'lockPath': lock or None}
        phase = 'environment'
        explicit_env = set_env or os.environ.get('CANNESS_SET_ENV', '')
        if explicit_env and not Path(explicit_env).expanduser().is_file():
            raise ValueError('configured CANN set_env.sh does not exist: ' + explicit_env)
        configured, searched = discover_set_env(explicit_env)
        if not configured:
            report['searchedEnv'] = searched
            raise ValueError('CANN set_env.sh not found; provide setEnv explicitly')
        report['setEnv'] = configured
        bash = os.environ.get('CANNESS_BASH', 'bash')
        prefix = 'set -e; ' + shell_env_prefix(configured, device)
        prefix += f'export ASCEND_RT_VISIBLE_DEVICES={shlex.quote(device)}; '
        phase = 'build'
        run_required('build', [bash, '-c', prefix + 'exec "$1" build.sh', 'canness-validation', bash], source)
        wheels = list((source / 'dist').glob('*.whl'))
        if len(wheels) != 1:
            raise ValueError('build must produce exactly one wheel in dist/')
        stages['build']['status'] = 'passed'
        report['wheel'] = wheels[0].name
        phase = 'install'
        venv = root / 'venv'
        run_required('venv', [sys.executable, '-m', 'venv', '--system-site-packages', str(venv)], root)
        python = venv / 'bin' / 'python'
        run_required('install', [str(python), '-m', 'pip', 'install', '--no-deps', '--no-index', '--ignore-installed', str(wheels[0])], root)
        stages['install']['status'] = 'passed'
        report['status'] = 'installed'
        phase = 'call'
        results = {case['id']: case_result(case, 'unsupported', reason='outside declared submission support')
                   for case in cases if cases_file and support_mismatch(case, provenance.get('support'))}
        active_cases = [(index, case) for index, case in enumerate(cases) if case['id'] not in results]
        comparison = None
        if active_cases:
            try:
                with device_lock(lock, min(15, max(0, deadline - time.monotonic()))):
                    for index, case in active_cases:
                        work = root / 'test-work'
                        if cases_file:
                            work /= f'case-{index + 1}'
                        limit = (case_timeout_sec or 120) if cases_file else None
                        results[case['id']], comparison = test_case(case, work, limit)
            except DeviceUnavailable as error:
                for _, case in active_cases:
                    results[case['id']] = case_result(case, 'blocked', reason=str(error), failure_kind='device_unavailable')
                report['steps'].append({'step': 'device-lock', 'error': str(error)})
        outcomes = [results[case['id']] for case in cases]
        passed = sum(result['pass'] for result in outcomes)
        unsupported_count = sum(result['status'] == 'unsupported' for result in outcomes)
        if cases_file:
            report['cases'] = outcomes
            report['coverage'] = f'{passed}/{len(outcomes)}'
            report['coverageCounts'] = {'passed': passed, 'total': len(outcomes), 'unsupported': unsupported_count}
        elif comparison is not None:
            report['testResult'] = comparison
        if any(result.get('failureKind') == 'install' for result in outcomes):
            stages['install']['status'] = 'failed'
        failed = next((result for result in outcomes if result['status'] == 'failed'), None)
        blocked = next((result for result in outcomes if result['status'] == 'blocked'), None)
        if any(result.get('failureKind') == 'call' for result in outcomes):
            stages['call']['status'] = 'failed'
        elif blocked:
            stages['call']['status'] = 'blocked'
        elif any(result['call'] == 'passed' for result in outcomes):
            stages['call']['status'] = 'passed'
        if any(result.get('failureKind') == 'assert' for result in outcomes):
            stages['accuracy']['status'] = 'failed'
        if failed or blocked:
            problem = failed or blocked
            report.update(status=problem['status'], failureKind=problem['failureKind'], reason=problem['reason'])
        elif passed:
            if passed == len(outcomes):
                stages['accuracy']['status'] = 'passed'
                report.update(status='validated', correctness='user-golden-passed')
            else:
                stages['accuracy']['status'] = 'partial'
                report.update(status='partial', correctness='user-golden-partial')
        elif unsupported_count:
            stages['call']['status'] = 'unsupported'
            report.update(status='unsupported', reason=outcomes[0]['reason'])
    except Exception as error:
        report['status'] = 'failed'
        report['reason'] = str(error)
        report['failureKind'] = phase
        if phase in stages:
            stages[phase]['status'] = 'failed'
    return report


def main():
    if sys.argv[1:2] == ['--run-installed']:
        run_installed(*sys.argv[2:])
        return 0
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--timeout-sec', type=int, default=600)
    parser.add_argument('--set-env')
    parser.add_argument('--test-script')
    parser.add_argument('--cases-file')
    parser.add_argument('--case-timeout-sec', type=int)
    parser.add_argument('--device-id', '--device')
    parser.add_argument('--lock')
    args = parser.parse_args()
    case_timeout = max(1, min(3600, args.case_timeout_sec)) if args.case_timeout_sec is not None else None
    report = validate(Path(args.root).resolve(), max(1, min(3600, args.timeout_sec)), args.set_env, args.test_script,
                      cases_file=args.cases_file, case_timeout_sec=case_timeout, device=args.device_id, lock=args.lock)
    print('CANNESS_SUBMISSION_REPORT ' + json.dumps(report, allow_nan=False))
    return 0 if report['status'] != 'failed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
