#!/usr/bin/env python3
"""Real CANNESS evaluation runner (build contract v1).

What it does for one package:

  1. finds ``<inbox>/<generation>/manifest.json`` (or one generation named by
     ``--generation``);
  2. runs the package's own ``build.sh`` (the last stdout line is the
     executable path) — a missing script is a ``compile_fail``, never guessed;
  3. runs the package's own ``run_once.sh`` and reads its
     ``CANNESS_RESULT {...}`` line for maxAbsErr / maxRelErr / badCount;
  4. profiles the executable with the host's real ``msprof`` for ``--runs``
     iterations, pre-creating the output directory and reading the CSV under
     ``mindstudio_profiler_output/``;
  5. writes ``<outbox>/<generation>/results.json`` with
     ``analysis.source = "msprof"`` and a ``runRecord`` trace.

Hard rules:

  * ``kernelTimeUs`` is the average ``Task Duration(us)`` from the msprof CSV.
    The manifest's ``performanceTargetUs`` is never written into it, and a
    missing CSV is an ``error`` — never a ``pass``.
  * The NPU is shared with other jobs: ``run_once.sh`` and ``msprof`` run under
    ``flock`` on the configured lock file (default ``/tmp/canness/davinci7.lock``)
    and with ``ASCEND_VISIBLE_DEVICES`` set (default ``7``).
  * ``set_env.sh`` is sourced, but its library order is left untouched: do not
    prepend CANN's ``lib64`` or ``npu-smi`` breaks with an undefined symbol.

Exit status is 0 when every requested generation produced a results.json,
1 when at least one generation could not even be attempted. A report with
``status: "compile_fail"`` / ``"accuracy_fail"`` / ``"perf_fail"`` / ``"error"``
is still a successfully written report and exits 0.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

DEFAULT_SET_ENV = '/usr/local/Ascend/ascend-toolkit/set_env.sh'
DEFAULT_LOCK = '/tmp/canness/davinci7.lock'
DEFAULT_DEVICE = '7'
DEFAULT_RUNS = 100
DEFAULT_MAX_ABS_ERR = 1e-3
CONTRACT_ERROR = 'package does not implement build contract v1'
LOG_LIMIT = 20000
CSV_DIR = 'mindstudio_profiler_output'


def truncate(text: str, limit: int = LOG_LIMIT) -> str:
    if len(text) <= limit:
        return text
    return text[-limit:]


def first_line(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line
    return ''


def last_nonempty_line(text: str) -> str:
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line:
            return line
    return ''


def load_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise ValueError(f'{path} is not a JSON object')
    return data


def number(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def correctness_threshold(manifest: dict, config: dict) -> float:
    """Read the absolute-error budget from the package, never invent one."""
    for source in (config, manifest):
        for key in ('maxAbsErr', 'max_abs_err', 'maxAbsError'):
            value = number(source.get(key))
            if value is not None:
                return value
        tolerance = source.get('tolerance')
        if isinstance(tolerance, dict):
            for key in ('maxAbsErr', 'max_abs_err', 'maxAbsError'):
                value = number(tolerance.get(key))
                if value is not None:
                    return value
    return DEFAULT_MAX_ABS_ERR


def run_params(manifest: dict, config: dict) -> dict:
    params: dict = {}
    for source in (config.get('params'), manifest.get('params')):
        if isinstance(source, dict):
            params.update(source)
    for key in ('blockDim', 'block_dim', 'tileSize', 'tile_size', 'approximation', 'approxType', 'approx'):
        for source in (config, manifest):
            if key in source and key not in params:
                params[key] = source[key]
    return params


def toolchain_version() -> str:
    home = os.environ.get('ASCEND_TOOLKIT_HOME') or '/usr/local/Ascend/ascend-toolkit/latest'
    version_cfg = Path(home) / 'version.cfg'
    try:
        if version_cfg.is_file():
            for line in version_cfg.read_text(encoding='utf-8', errors='replace').splitlines():
                if '=' in line:
                    name, value = line.split('=', 1)
                    if name.strip().lower() in ('version', 'cann_version'):
                        return f'CANN {value.strip()}'
    except OSError:
        pass
    for exe in ('bisheng', 'ccec'):
        if shutil.which(exe) is None:
            continue
        try:
            done = subprocess.run([exe, '--version'], capture_output=True,
                                  encoding='utf-8', errors='replace', timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            continue
        line = first_line(done.stdout) or first_line(done.stderr)
        if line:
            return line
    return 'CANN (version unknown)'


def bash_path(value) -> str:
    """Forward slashes for bash arguments; Windows dev boxes cannot pass `C:\\`."""
    return str(value).replace('\\', '/') if os.name == 'nt' else str(value)


def local_path(text: str) -> Path:
    """Turn ``/c/Users/...`` from Git Bash back into ``C:/Users/...`` for Python I/O."""
    if os.name == 'nt':
        match = re.match(r'^/([A-Za-z])/(.*)$', text)
        if match:
            return Path(f'{match.group(1).upper()}:/{match.group(2)}')
        if text == '/tmp' or text.startswith('/tmp/'):
            return Path(tempfile.gettempdir()) / text[len('/tmp/'):]
    return Path(text)


def shell_env_prefix(set_env: str, device: str) -> str:
    prefix = ''
    if set_env and Path(set_env).is_file():
        prefix += f'source {shlex.quote(set_env)}; '
    prefix += f'export ASCEND_VISIBLE_DEVICES={shlex.quote(device)}; '
    return prefix


def run_command(
    argv: list[str],
    env_prefix: str,
    timeout: int,
    cwd: Path | None = None,
    lock: str = '',
    bash_exe: str = 'bash',
) -> subprocess.CompletedProcess:
    inner = ' '.join(shlex.quote(part) for part in argv)
    if lock and shutil.which('flock'):
        command = f'{env_prefix}exec flock {shlex.quote(lock)} -c {shlex.quote(inner)}'
    else:
        command = f'{env_prefix}exec {inner}'
    return subprocess.run(
        [bash_exe, '-c', command],
        cwd=str(cwd) if cwd is not None else None,
        capture_output=True,
        encoding='utf-8',
        errors='replace',
        timeout=timeout,
    )


def parse_canness_result(stdout: str) -> dict | None:
    for line in reversed(stdout.splitlines()):
        line = line.strip()
        if not line.startswith('CANNESS_RESULT '):
            continue
        try:
            data = json.loads(line[len('CANNESS_RESULT '):])
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None
    return None


def normalized_header(value: str) -> str:
    return re.sub(r'[^a-z0-9]', '', value.lower())


COLUMNS = {
    'duration': ('taskdurationus', 'taskduration'),
    'wait': ('taskwaittimeus', 'taskwaittime'),
    'blockDim': ('blockdim',),
    'opName': ('opname',),
    'opType': ('optype',),
    'taskType': ('tasktype',),
    'aicore': ('aicoretimeus', 'aicoretime'),
    'mac': ('aicmacratio',),
    'mte2': ('aicmte2ratio',),
    'scalar': ('aicscalarratio',),
    'cube': ('cubeutilization',),
}

# op_statistic has no per-run rows; its aggregate columns are named Avg/Min/Max.
AVG_COLUMNS = (
    'avg',
    'avgtimeus',
    'avgtaskdurationus',
    'averagetimeus',
    'averagetaskdurationus',
    'avgdurationus',
)


def column_map(fieldnames: list[str]) -> dict[str, str]:
    mapping: dict[str, str] = {}
    normalized = {normalized_header(name): name for name in fieldnames if name}
    for target, aliases in COLUMNS.items():
        for alias in aliases:
            if alias in normalized:
                mapping[target] = normalized[alias]
                break
    return mapping


def row_value(row: dict, mapping: dict, key: str):
    column = mapping.get(key)
    return None if column is None else row.get(column)


def row_matches(row: dict, mapping: dict, operator_name: str) -> bool:
    for key in ('opName', 'opType'):
        value = row_value(row, mapping, key)
        if isinstance(value, str) and (value == operator_name or value.startswith(operator_name)):
            return True
    return False


def read_csv_rows(path: Path) -> tuple[list[dict], dict[str, str]]:
    try:
        with path.open('r', encoding='utf-8-sig', newline='') as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                return [], {}
            return list(reader), column_map(list(reader.fieldnames))
    except (OSError, csv.Error, UnicodeDecodeError):
        return [], {}


def summary_durations(paths: list[Path], operator_name: str) -> tuple[list[float], list[dict], dict[str, str]]:
    """Per-run rows: every Task Duration(us) of the operator (or all rows)."""
    parsed: list[tuple[list[dict], dict[str, str], list[dict]]] = []
    for path in paths:
        file_rows, candidate = read_csv_rows(path)
        if 'duration' not in candidate or not file_rows:
            continue
        matched = [row for row in file_rows if row_matches(row, candidate, operator_name)]
        parsed.append((file_rows, candidate, matched))
    # If the operator appears anywhere, never average another operator's rows
    # just because one CSV did not contain a match.
    any_match = any(matched for _rows, _mapping, matched in parsed)
    durations: list[float] = []
    rows: list[dict] = []
    mapping: dict[str, str] = {}
    for file_rows, candidate, matched in parsed:
        use = matched if any_match else file_rows
        for row in use:
            value = number(row_value(row, candidate, 'duration'))
            if value is not None:
                durations.append(value)
                rows.append(row)
        if durations and not mapping:
            mapping = candidate
    return durations, rows, mapping


def statistic_durations(paths: list[Path], operator_name: str) -> tuple[list[float], list[dict], dict[str, str]]:
    """Aggregate rows: only the Avg column, never Min/Max, never summed."""
    parsed: list[tuple[list[dict], dict[str, str], list[dict], str]] = []
    for path in paths:
        file_rows, candidate = read_csv_rows(path)
        if not file_rows:
            continue
        normalized = {normalized_header(name): name for name in file_rows[0] if name}
        average_column = next((normalized[alias] for alias in AVG_COLUMNS if alias in normalized), None)
        column = average_column or candidate.get('duration')
        if column is None:
            continue
        matched = [row for row in file_rows if row_matches(row, candidate, operator_name)]
        parsed.append((file_rows, candidate, matched, column))
    any_match = any(matched for _rows, _mapping, matched, _column in parsed)
    durations: list[float] = []
    rows: list[dict] = []
    mapping: dict[str, str] = {}
    for file_rows, candidate, matched, column in parsed:
        use = matched if any_match else file_rows
        for row in use:
            value = number(row.get(column))
            if value is not None:
                durations.append(value)
                rows.append(row)
        if durations and not mapping:
            mapping = candidate
    return durations, rows, mapping


def build_profile(
    durations: list[float],
    rows: list[dict],
    mapping: dict[str, str],
    operator_name: str,
    source_label: str,
) -> dict:
    mean = sum(durations) / len(durations)
    first = rows[0]

    def average_ratio(key: str) -> float | None:
        """Mean of one aic-metrics column across the rows, ignoring empties."""
        values = [v for v in (number(row_value(row, mapping, key)) for row in rows) if v is not None]
        return sum(values) / len(values) if values else None

    ratios = {
        'mac': average_ratio('mac'),
        'mte2': average_ratio('mte2'),
        'scalar': average_ratio('scalar'),
    }
    # Columns that exist but are filled with 0 mean the metrics were not
    # collected for this run (CANN 9.0.0 only writes them with the matching
    # --aic-metrics level). Treating those zeros as data made every AIV kernel
    # look cube-bound, because max() over three equal zeros picks the first key.
    collected = {key: value for key, value in ratios.items() if value is not None and value > 0}
    if collected:
        bottleneck = max(collected, key=lambda key: collected[key])
        bottleneck = {'mac': 'cube', 'mte2': 'memory', 'scalar': 'scalar'}[bottleneck]
    else:
        bottleneck = 'unknown'
    op = {
        'opName': str(row_value(first, mapping, 'opName') or operator_name),
        'opType': str(row_value(first, mapping, 'opType') or ''),
        'taskType': str(row_value(first, mapping, 'taskType') or ''),
        'taskDurationUs': mean,
        'taskWaitTimeUs': number(row_value(first, mapping, 'wait')),
        'blockDim': number(row_value(first, mapping, 'blockDim')),
        'aicoreTimeUs': number(row_value(first, mapping, 'aicore')),
        'aicMacRatio': ratios['mac'],
        'aicMte2Ratio': ratios['mte2'],
        'aicScalarRatio': ratios['scalar'],
        'cubeUtilizationPct': number(row_value(first, mapping, 'cube')),
    }
    missing = '' if collected else ' aic-metrics were not collected for this run (all aic_* ratios are zero); no bottleneck can be named.'
    summary = (
        f'msprof {source_label}: Task Duration avg {mean:.3f}us over {len(durations)} rows; '
        f'aic_mac_ratio {op["aicMacRatio"]}, aic_mte2_ratio {op["aicMte2Ratio"]}, '
        f'aic_scalar_ratio {op["aicScalarRatio"]}.'
        f'{missing}'
    )
    return {'bottleneck': bottleneck, 'summary': summary, 'op': op}


def profile_from_csv(outdir: Path, operator_name: str) -> tuple[dict | None, str]:
    """Return (profile, error).

    ``kernelTimeUs`` is the arithmetic mean of every ``Task Duration(us)`` row
    in ``op_summary``. Only when no summary rows exist is the ``Avg`` column of
    ``op_statistic`` used; mixing both families would count the same run twice.

    The msprof export layout is version dependent: newer toolchains put
    ``mindstudio_profiler_output/`` directly under ``--output``, while CANN 9.0.0
    nests it under ``PROF_<timestamp>/``. Search the whole ``--output`` tree so
    both layouts resolve instead of reporting "no CSV" for a real profile.
    """
    root = outdir / CSV_DIR
    if root.is_dir():
        paths = sorted(root.rglob('*.csv'))
    else:
        paths = sorted(outdir.rglob('*.csv'))
    if not paths:
        return None, f'no CSV under {outdir} (no {CSV_DIR}/ and no *.csv anywhere below it)'
    summary_paths = [path for path in paths if 'op_summary' in path.name.lower()]
    statistic_paths = [path for path in paths if 'op_statistic' in path.name.lower()]

    durations, rows, mapping = summary_durations(summary_paths, operator_name)
    if durations:
        return build_profile(durations, rows, mapping, operator_name, 'op_summary'), ''

    durations, rows, mapping = statistic_durations(statistic_paths, operator_name)
    if durations:
        return build_profile(durations, rows, mapping, operator_name, 'op_statistic (Avg Time)'), ''

    searched = ', '.join(path.name for path in paths)
    return None, f'no Task Duration rows in {CSV_DIR}/ (searched {root}: {searched})'


def profile_executable(
    executable: Path,
    package: Path,
    args: argparse.Namespace,
    env_prefix: str,
    operator_name: str,
) -> tuple[dict | None, str, str]:
    """Run msprof once over N application iterations and parse its CSV."""
    outdir = package / f'.msprof-{uuid.uuid4().hex}'
    outdir.mkdir(parents=True, exist_ok=True)
    msprof = args.msprof or shutil.which('msprof') or 'msprof'
    argv = [bash_path(msprof), f'--application={bash_path(executable)} {args.runs}', f'--output={bash_path(outdir)}']
    try:
        done = run_command(argv, env_prefix, args.msprof_timeout, cwd=package, lock=args.lock, bash_exe=args.bash)
    except subprocess.TimeoutExpired:
        return None, 'msprof timed out', f'msprof timed out after {args.msprof_timeout}s'
    log = truncate((done.stdout or '') + (done.stderr or ''))
    profile, error = profile_from_csv(outdir, operator_name)
    if profile is None:
        if done.returncode != 0:
            return None, f'msprof exited {done.returncode}: {first_line(done.stderr or done.stdout)}', log
        return None, error, log
    return profile, '', log


def make_report(
    generation: str,
    target: float | None,
    status: str = 'error',
    compile_ok: bool = False,
    compile_log: str = '',
    correctness_ok: bool = False,
    max_relative_error: float | None = None,
    kernel_time_us: float | None = None,
    analysis: dict | None = None,
    summary: str = '',
) -> dict:
    return {
        'generationId': generation,
        'status': status,
        'compile': {'ok': compile_ok, 'log': truncate(compile_log)},
        'correctness': {'ok': correctness_ok, 'maxRelativeError': max_relative_error},
        'performance': {'kernelTimeUs': kernel_time_us, 'targetUs': target},
        'analysis': analysis,
        'summary': summary,
    }


def evaluate(package: Path, generation: str, args: argparse.Namespace) -> dict:
    started = time.time()
    manifest_path = package / 'manifest.json'
    manifest: dict = {}
    config: dict = {}
    try:
        manifest = load_json(manifest_path)
        if (package / 'config.json').is_file():
            config = load_json(package / 'config.json')
    except (OSError, ValueError, json.JSONDecodeError) as error:
        report = make_report(generation, None, summary=f'malformed manifest.json: {error}')
        report['runRecord'] = record(started, {}, args)
        return report

    generation = str(manifest.get('generationId') or generation)
    target = number(manifest.get('performanceTargetUs'))
    operator_name = manifest.get('operatorName') if isinstance(manifest.get('operatorName'), str) else generation
    params = run_params(manifest, config)

    build = package / 'build.sh'
    run_once = package / 'run_once.sh'
    if not build.is_file() or not run_once.is_file():
        report = make_report(generation, target, status='compile_fail', summary=CONTRACT_ERROR)
        report['runRecord'] = record(started, params, args)
        return report

    env_prefix = shell_env_prefix(args.set_env, args.device)
    try:
        built = run_command([args.bash, bash_path(build)], env_prefix, args.build_timeout, cwd=package, bash_exe=args.bash)
    except subprocess.TimeoutExpired:
        report = make_report(generation, target, status='compile_fail',
                             summary=f'build.sh timed out after {args.build_timeout}s')
        report['runRecord'] = record(started, params, args)
        return report
    compile_log = truncate((built.stdout or '') + (built.stderr or ''))
    if built.returncode != 0:
        report = make_report(
            generation, target, status='compile_fail', compile_log=compile_log,
            summary=f'build.sh exited {built.returncode}: {first_line(built.stderr or built.stdout)}',
        )
        report['runRecord'] = record(started, params, args)
        return report
    executable_text = last_nonempty_line(built.stdout or '')
    if executable_text == '':
        report = make_report(generation, target, status='compile_fail', compile_log=compile_log,
                             summary='build.sh did not print the executable path on its last stdout line')
        report['runRecord'] = record(started, params, args)
        return report
    executable = local_path(executable_text)
    if not executable.is_absolute():
        executable = package / executable
    if not executable.exists():
        report = make_report(generation, target, status='compile_fail', compile_log=compile_log,
                             summary=f'build.sh reported a missing executable: {executable}')
        report['runRecord'] = record(started, params, args)
        return report

    try:
        correctness_run = run_command([args.bash, bash_path(run_once)], env_prefix, args.run_timeout,
                                      cwd=package, lock=args.lock, bash_exe=args.bash)
    except subprocess.TimeoutExpired:
        report = make_report(generation, target, status='error', compile_ok=True, compile_log=compile_log,
                             summary=f'run_once.sh timed out after {args.run_timeout}s')
        report['runRecord'] = record(started, params, args)
        return report
    correctness_log = truncate((correctness_run.stdout or '') + (correctness_run.stderr or ''))
    result = parse_canness_result(correctness_run.stdout or '')
    if result is None:
        report = make_report(generation, target, status='error', compile_ok=True,
                             compile_log=f'{compile_log}\n{correctness_log}'.strip(),
                             summary='run_once.sh did not print a CANNESS_RESULT line')
        report['runRecord'] = record(started, params, args)
        return report
    bad_count = number(result.get('badCount'))
    total = number(result.get('total'))
    max_abs_err = number(result.get('maxAbsErr'))
    max_rel_err = number(result.get('maxRelErr'))
    golden = result.get('golden') if isinstance(result.get('golden'), str) else None
    if golden:
        params['golden'] = golden
    if bad_count is None or max_abs_err is None:
        report = make_report(generation, target, status='error', compile_ok=True, compile_log=compile_log,
                             summary='run_once.sh printed CANNESS_RESULT without badCount / maxAbsErr')
        report['runRecord'] = record(started, params, args)
        return report
    threshold = correctness_threshold(manifest, config)
    correctness_ok = int(bad_count) == 0 and max_abs_err <= threshold
    if not correctness_ok:
        placeholder = golden == 'placeholder' or int(bad_count) < 0
        summary = (
            'golden not implemented: fill golden.h in the package, then re-run build_test_package and run_evaluation'
            if placeholder else
            f'correctness failed: badCount {int(bad_count)}/{int(total) if total is not None else "?"}, '
            f'maxAbsErr {max_abs_err:g} > {threshold:g}'
        )
        report = make_report(
            generation, target, status='accuracy_fail', compile_ok=True, compile_log=compile_log,
            max_relative_error=max_rel_err, summary=summary,
        )
        report['runRecord'] = record(started, params, args)
        return report

    profile, perf_error, msprof_log = profile_executable(executable, package, args, env_prefix, str(operator_name))
    if profile is None:
        report = make_report(
            generation, target, status='error', compile_ok=True,
            compile_log=f'{compile_log}\n{correctness_log}\n{msprof_log}'.strip(),
            correctness_ok=True, max_relative_error=max_rel_err,
            summary=perf_error,
        )
        report['runRecord'] = record(started, params, args)
        return report

    kernel_time_us = profile['op']['taskDurationUs']
    analysis = {
        'source': 'msprof',
        'bottleneck': profile['bottleneck'],
        'summary': profile['summary'],
        'op': profile['op'],
    }
    if target is not None and kernel_time_us > target:
        status = 'perf_fail'
        summary = f'kernel {kernel_time_us:.3f}us exceeds target {target:g}us'
    else:
        status = 'pass'
        summary = f'kernel {kernel_time_us:.3f}us' + ('' if target is None else f' <= target {target:g}us')
    report = make_report(
        generation, target, status=status, compile_ok=True, compile_log=compile_log,
        correctness_ok=True, max_relative_error=max_rel_err, kernel_time_us=kernel_time_us,
        analysis=analysis, summary=summary,
    )
    report['runRecord'] = record(started, params, args)
    return report


def record(started: float, params: dict, args: argparse.Namespace) -> dict:
    return {
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'host': socket.gethostname(),
        'params': params,
        'toolchain': toolchain_version(),
        'durationMs': int((time.time() - started) * 1000),
    }


def write_report(outbox: Path, generation: str, report: dict) -> Path:
    destination = outbox / generation / 'results.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f'.results-{uuid.uuid4().hex}.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, destination)
    return destination


def generations_to_run(inbox: Path, outbox: Path, only: str) -> list[tuple[str, Path, Path]]:
    pairs: list[tuple[str, Path, Path]] = []
    if only:
        manifest = inbox / only / 'manifest.json'
        if manifest.is_file():
            pairs.append((only, manifest, outbox / only / 'results.json'))
        return pairs
    if not inbox.is_dir():
        return pairs
    for manifest in sorted(inbox.glob('*/manifest.json')):
        generation = manifest.parent.name
        pairs.append((generation, manifest, outbox / generation / 'results.json'))
    return pairs


def scan(inbox: Path, outbox: Path, only: str, args: argparse.Namespace) -> int:
    failures = 0
    for generation, _manifest, result_path in generations_to_run(inbox, outbox, only):
        if result_path.exists():
            continue
        package = inbox / generation
        try:
            report = evaluate(package, generation, args)
            write_report(outbox, generation, report)
            print(f'[{generation}] {report["status"]}: {report["summary"]}', flush=True)
        except Exception as error:  # one bad package must not kill the sweep
            failures += 1
            report = make_report(generation, None, summary=f'runner error: {error}')
            report['runRecord'] = record(time.time(), {}, args)
            try:
                write_report(outbox, generation, report)
            except OSError:
                pass
            print(f'[{generation}] runner error: {error}', file=sys.stderr, flush=True)
    return 1 if failures else 0


def main() -> int:
    # Remote logs are UTF-8; a Windows dev box must not fail printing them.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, OSError):
            pass
    parser = argparse.ArgumentParser(description='CANNESS remote evaluation runner (build contract v1)')
    parser.add_argument('--inbox', required=True)
    parser.add_argument('--outbox', required=True)
    parser.add_argument('--generation', default='', help='only this generation (default: every pending manifest)')
    parser.add_argument('--once', action='store_true', help='scan once and exit (the default)')
    parser.add_argument('--loop', action='store_true', help='keep scanning until killed')
    parser.add_argument('--interval', type=int, default=2000, help='loop interval in milliseconds')
    parser.add_argument('--runs', type=int, default=DEFAULT_RUNS, help='msprof application iterations')
    parser.add_argument('--device', default=os.environ.get('CANNESS_ASCEND_VISIBLE_DEVICES', DEFAULT_DEVICE))
    parser.add_argument('--lock', default=os.environ.get('CANNESS_DAVINCI_LOCK', DEFAULT_LOCK),
                        help='flock file shared with other NPU jobs; empty disables locking')
    parser.add_argument('--set-env', default=os.environ.get('CANNESS_SET_ENV', DEFAULT_SET_ENV))
    parser.add_argument('--msprof', default=os.environ.get('CANNESS_MSPROF', 'msprof'))
    parser.add_argument('--bash', default=os.environ.get('CANNESS_BASH', 'bash'),
                        help='shell used to run package scripts (default: bash on PATH)')
    parser.add_argument('--build-timeout', type=int, default=1800)
    parser.add_argument('--run-timeout', type=int, default=600)
    parser.add_argument('--msprof-timeout', type=int, default=1800)
    args = parser.parse_args()

    inbox = Path(args.inbox)
    outbox = Path(args.outbox)
    if args.lock:
        try:
            Path(args.lock).parent.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
    interval = max(args.interval, 0) / 1000
    while True:
        status = scan(inbox, outbox, args.generation, args)
        if args.once or not args.loop:
            return status
        time.sleep(interval)


if __name__ == '__main__':
    sys.exit(main())
