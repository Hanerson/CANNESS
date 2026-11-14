import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

/**
 * End-to-end test of `remote/runner.py` against a contract-v1 fixture package.
 * No NPU and no CANN are involved: a fake `msprof` writes the CSV that the
 * real profiler would write, and the runner must report the CSV number.
 */

const fixture = fileURLToPath(new URL('./fixtures/eval-contract/', import.meta.url))
const runner = fileURLToPath(new URL('../remote/runner.py', import.meta.url))

function pythonCommand(): string | null {
  const candidates = [process.env.CANNESS_TEST_PYTHON, 'python3', 'python']
    .filter((value): value is string => value !== undefined && value !== '')
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (probe.status === 0) return candidate
  }
  return null
}

const python = pythonCommand()

/** Use Git Bash on Windows; the WSL launcher cannot execute native temp paths. */
function bashCommand(): string {
  if (process.env.CANNESS_TEST_BASH) return process.env.CANNESS_TEST_BASH
  if (process.platform !== 'win32') return 'bash'
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value)).map(value => join(value, 'Git'))
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  if (git.status === 0) {
    const execPath = git.stdout.trim()
    if (execPath) roots.unshift(resolve(execPath, '../../..'))
  }
  for (const root of roots) {
    for (const rel of ['usr/bin/bash.exe', 'bin/bash.exe']) {
      const candidate = join(root, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('eval-runner tests on Windows require Git Bash; set CANNESS_TEST_BASH to bash.exe')
}

const CSV = [
  'Op Name,Op Type,Task Type,Task Duration(us),Task Wait Time(us),Block Dim,aic_mac_ratio,aic_mte2_ratio,aic_scalar_ratio,cube_utilization(%)',
  'Gelu_v1,Gelu,AI_CORE,30.9,0.5,16,0.12,0.71,0.09,18.4',
].join('\n')

/** A stand-in for msprof: writes the CSV the real tool would leave behind. */
function fakeMsprof(root: string, csv: string | null, fileName = 'op_summary_0.csv'): string {
  const path = join(root, 'msprof')
  const body = csv === null
    ? '#!/usr/bin/env bash\nexit 0\n'
    : [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'out=""',
        'for arg in "$@"; do case "$arg" in --output=*) out="${arg#--output=}";; esac; done',
        'mkdir -p "$out/mindstudio_profiler_output"',
        `cat > "$out/mindstudio_profiler_output/${fileName}" <<'CSV'`,
        csv,
        'CSV',
        '',
      ].join('\n')
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

function packageAt(options: { build?: boolean, runOnce?: boolean } = {}): { root: string, inbox: string, outbox: string } {
  const root = mkdtempSync(join(tmpdir(), 'canness-runner-'))
  const inbox = join(root, 'inbox')
  const pkg = join(inbox, 'gen-fixture001')
  cpSync(fixture, pkg, { recursive: true })
  if (options.build === false) rmSync(join(pkg, 'build.sh'))
  if (options.runOnce === false) rmSync(join(pkg, 'run_once.sh'))
  return { root, inbox, outbox: join(root, 'outbox') }
}

function runRunner(root: string, inbox: string, outbox: string, msprof: string, runs = 3) {
  const bash = bashCommand()
  const env = { ...process.env }
  if (process.platform === 'win32') {
    const bashDir = dirname(bash)
    // Git for Windows also ships a launcher in bin; its Unix tools live in usr/bin.
    const unixBin = existsSync(join(bashDir, 'cat.exe')) ? bashDir : resolve(bashDir, '../usr/bin')
    if (existsSync(join(unixBin, 'cat.exe'))) env.PATH = [unixBin, env.PATH].filter(Boolean).join(delimiter)
  }
  return spawnSync(python!, [
    runner, '--inbox', inbox, '--outbox', outbox,
    '--generation', 'gen-fixture001', '--once',
    '--set-env', '', '--lock', '', '--msprof', msprof, '--runs', String(runs),
    '--bash', bash,
  ], { encoding: 'utf8', env })
}

function results(outbox: string): Record<string, any> {
  return JSON.parse(readFileSync(join(outbox, 'gen-fixture001', 'results.json'), 'utf8'))
}

test.skipIf(python === null)('preflight sources the selected environment and reports available CANN tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'canness-preflight-'))
  const choose = join(root, 'set_env.sh')
  const home = root.replaceAll('\\', '/')
  writeFileSync(join(root, 'version.cfg'), 'version=9.0.0\n')
  writeFileSync(choose, [
    `export ASCEND_TOOLKIT_HOME="${home}"`,
    'export CANNESS_BISHENG=printf',
    '',
  ].join('\n'))
  const done = spawnSync(python!, [
    runner, '--preflight', '--bash', bashCommand(), '--set-env', choose, '--msprof', 'true',
  ], { encoding: 'utf8' })
  expect(done.status, done.stderr).toBe(0)
  expect(JSON.parse(done.stdout), done.stdout).toMatchObject({
    ready: true, toolchain: 'CANN 9.0.0', setEnv: choose, compiler: 'printf', msprof: 'true',
  })
})

test.skipIf(python === null)('the report uses the msprof CSV number, not the manifest target', () => {
  const { root, inbox, outbox } = packageAt()
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, CSV))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report).toMatchObject({
    generationId: 'gen-fixture001',
    status: 'pass',
    compile: { ok: true },
    correctness: { ok: true, maxRelativeError: 0.00002 },
    performance: { kernelTimeUs: 30.9, targetUs: 40 },
    analysis: {
      source: 'msprof',
      bottleneck: 'memory',
      op: { taskDurationUs: 30.9, aicMte2Ratio: 0.71 },
    },
  })
  // A 40us target must never leak into the measurement.
  expect(report.performance.kernelTimeUs).not.toBe(40)
  expect(report.runRecord).toMatchObject({
    params: { blockDim: 16, tileSize: 1024, approximation: 'tanh' },
  })
  expect(typeof report.runRecord.host).toBe('string')
  expect(report.runRecord.host.length).toBeGreaterThan(0)
  expect(typeof report.runRecord.toolchain).toBe('string')
  expect(report.runRecord.durationMs).toBeGreaterThanOrEqual(0)
  expect(report.analysis.achievedBandwidthGBps).toBeCloseTo(131072 / (30.9 * 1000), 6)
  expect(report.analysis.rooflineUs).toBeNull() // no verified 910B bandwidth source
  expect(report.analysis.baselineUs).toBeNull()
})

test.skipIf(python === null)('a missing msprof CSV is an error, never a pass', () => {
  const { root, inbox, outbox } = packageAt()
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, null))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('error')
  expect(report.performance.kernelTimeUs).toBeNull()
  expect(report.analysis).toBeNull()
  expect(report.summary).toContain('no CSV')
})

test.skipIf(python === null)('nonfinite and nonpositive profile durations cannot pass', () => {
  const header = CSV.split('\n')[0]!
  const row = (duration: string) => `Gelu_v1,Gelu,AI_CORE,${duration},0.5,16,0.12,0.71,0.09,18.4`
  const { root, inbox, outbox } = packageAt()
  const csv = [header, row('NaN'), row('Infinity'), row('-5'), row('0')].join('\n')
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, csv)).status).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('error')
  expect(report.performance.kernelTimeUs).toBeNull()
})

test.skipIf(python === null)('a package without build.sh is compile_fail with the contract message', () => {
  const { root, inbox, outbox } = packageAt({ build: false })
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, CSV))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('compile_fail')
  expect(report.summary).toBe('package does not implement build contract v1')
})

test.skipIf(python === null)('the maxAbsErr budget comes from the package config', () => {
  const { root, inbox, outbox } = packageAt()
  const runOnce = join(inbox, 'gen-fixture001', 'run_once.sh')
  const body = readFileSync(runOnce, 'utf8').replace('0.0009', '0.002')
  writeFileSync(runOnce, body)
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, CSV))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('accuracy_fail')
  expect(report.correctness.ok).toBe(false)
  expect(report.performance.kernelTimeUs).toBeNull()
})

test.skipIf(python === null)('an exact correctness threshold of zero is preserved', () => {
  const { root, inbox, outbox } = packageAt()
  const pkg = join(inbox, 'gen-fixture001')
  writeFileSync(join(pkg, 'config.json'), JSON.stringify({ maxAbsErr: 0 }))
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, CSV)).status).toBe(0)
  expect(results(outbox)).toMatchObject({ status: 'accuracy_fail', summary: expect.stringContaining('> 0') })
})

test.skipIf(python === null)('per-element accuracy can pass with both diagnostic maxima over budget', () => {
  const { root, inbox, outbox } = packageAt()
  const pkg = join(inbox, 'gen-fixture001')
  const inputValues = [{ name: 'x', values: ['nan', '+inf', '-inf'] }]
  writeFileSync(join(pkg, 'config.json'), JSON.stringify({
    maxAbsErr: 2 ** -10,
    accuracyComparison: 'per-element',
    params: { inputValues },
  }))
  const result = { comparison: 'per-element', maxAbsErr: 0.00195, maxRelErr: 1, badCount: 0, total: 8 }
  const runOnce = join(pkg, 'run_once.sh')
  const writeResult = (value: object) => {
    rmSync(join(outbox, 'gen-fixture001', 'results.json'), { force: true })
    writeFileSync(runOnce, `echo 'CANNESS_RESULT ${JSON.stringify(value)}'\n`)
  }
  writeResult(result)
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, CSV)).status).toBe(0)
  expect(results(outbox)).toMatchObject({
    status: 'pass',
    correctness: { ok: true, maxRelativeError: 1 },
    runRecord: { params: { inputValues } },
  })

  writeResult({ ...result, badCount: 1 })
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, CSV)).status).toBe(0)
  expect(results(outbox)).toMatchObject({ status: 'accuracy_fail', summary: expect.stringContaining('badCount 1/8') })

  const { comparison: _legacy, ...unmarked } = result
  writeResult(unmarked)
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, CSV)).status).toBe(0)
  expect(results(outbox)).toMatchObject({ status: 'error', summary: expect.stringContaining('per-element') })
})

test.skipIf(python === null)('a multi-row op_summary is averaged, not first-row sampled', () => {
  const header = CSV.split('\n')[0]!
  const row = (duration: number) => `Gelu_v1,Gelu,AI_CORE,${String(duration)},0.5,16,0.12,0.71,0.09,18.4`
  const multi = [header, row(10), row(20), row(30)].join('\n')
  const { root, inbox, outbox } = packageAt()
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, multi))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('pass')
  expect(report.performance.kernelTimeUs).toBe(20)
  expect(report.analysis.summary).toContain('over 3 rows')
  expect(report.analysis.summary).toContain('op_summary')
})

test.skipIf(python === null)('warmup rows are excluded from the measured average', () => {
  const header = CSV.split('\n')[0]!
  const row = (duration: number) => `Gelu_v1,Gelu,AI_CORE,${duration},0.5,16,0.12,0.71,0.09,18.4`
  const csv = [header, ...Array.from({ length: 4 }, () => row(1000)),
    ...Array.from({ length: 20 }, (_, index) => row(index + 1))].join('\n')
  const { root, inbox, outbox } = packageAt()
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, csv), 20).status).toBe(0)
  const report = results(outbox)
  expect(report.performance.kernelTimeUs).toBe(10.5)
  expect(report.analysis.summary).toContain('over 20 rows')
  expect(report.analysis.summary).toContain('min 1.000us, max 20.000us')
  expect(report.analysis.summary).toContain('Excluded 4 warmup rows')
  expect(report.runRecord.params).toMatchObject({ runs: 20, requestedRuns: 20 })
})

test.skipIf(python === null)('a measured slow launch reduces profiler iterations', () => {
  const { root, inbox, outbox } = packageAt()
  const runOnce = join(inbox, 'gen-fixture001', 'run_once.sh')
  writeFileSync(runOnce, readFileSync(runOnce, 'utf8').replace('"total":32768}', '"total":32768,"sampleUs":10000}'))
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, CSV), 20).status).toBe(0)
  const report = results(outbox)
  expect(report.runRecord.params).toMatchObject({
    runs: 2, requestedRuns: 20, sampleUs: 10000, samplingBasis: 'measured-launch-wall-time',
  })
})

test.skipIf(python === null)('all-zero pipeline metrics leave the bottleneck unknown', () => {
  const csv = [CSV.split('\n')[0]!, 'Gelu_v1,Gelu,AI_CORE,30.9,0.5,16,0,0,0,0'].join('\n')
  const { root, inbox, outbox } = packageAt()
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, csv)).status).toBe(0)
  const analysis = results(outbox).analysis
  expect(analysis.bottleneck).toBe('unknown')
  expect(analysis.summary).toContain('aic-metrics were not collected')
  expect(analysis.summary).toContain('low_sample_count')
})

test.skipIf(python === null)('AIV metrics classify a vector task without using cube counters', () => {
  const csv = [
    'Op Name,Op Type,Task Type,Task Duration(us),aic_mac_ratio,aiv_mte2_ratio,aiv_scalar_ratio',
    'Gelu_v1,Gelu,AI_VECTOR,30.9,0.99,0.71,0.09',
  ].join('\n')
  const { root, inbox, outbox } = packageAt()
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, csv)).status).toBe(0)
  expect(results(outbox).analysis).toMatchObject({ bottleneck: 'memory', op: { aicMacRatio: null, aicMte2Ratio: 0.71 } })
})

test.skipIf(python === null)('AI_CORE rows can carry AIV-only pipe metrics in CANN 9.0', () => {
  const csv = [
    'Op Name,Op Type,Task Type,Task Duration(us),aic_mac_ratio,aic_mte2_ratio,aic_scalar_ratio,aiv_mte2_ratio,aiv_scalar_ratio',
    'Gelu_v1,Gelu,AI_CORE,226.657,0,0,0,0.111,0.943',
  ].join('\n')
  const { root, inbox, outbox } = packageAt()
  expect(runRunner(root, inbox, outbox, fakeMsprof(root, csv)).status).toBe(0)
  expect(results(outbox).analysis).toMatchObject({
    bottleneck: 'scalar', op: { aicMacRatio: null, aicMte2Ratio: 0.111, aicScalarRatio: 0.943 },
  })
})

test.skipIf(python === null)('op_statistic is only used when no op_summary rows exist', () => {
  const statistic = [
    'Op Type,Avg Time(us),Min Time(us),Max Time(us)',
    'Gelu,25,20,30',
  ].join('\n')
  const { root, inbox, outbox } = packageAt()
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, statistic, 'op_statistic_0.csv'))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('pass')
  expect(report.performance.kernelTimeUs).toBe(25)
  expect(report.analysis.summary).toContain('op_statistic')
  expect(report.analysis.summary).toContain('over 1 rows')
})

test.skipIf(python === null)('a placeholder golden is an explicit accuracy_fail, never a pass', () => {
  const { root, inbox, outbox } = packageAt()
  writeFileSync(join(inbox, 'gen-fixture001', 'run_once.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'echo \'CANNESS_RESULT {"maxAbsErr":0.25,"maxRelErr":0.5,"badCount":-1,"total":32768,"golden":"placeholder"}\'',
    '',
  ].join('\n'))
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, CSV))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('accuracy_fail')
  expect(report.correctness.ok).toBe(false)
  expect(report.correctness.maxRelativeError).toBe(0.5)
  expect(report.performance.kernelTimeUs).toBeNull()
  expect(report.summary).toBe(
    'golden not implemented: fill golden.h in the package, then re-run build_test_package and run_evaluation',
  )
  expect(report.runRecord.params.golden).toBe('placeholder')
})

test.skipIf(python === null)('a custom golden records itself in runRecord.params', () => {
  const { root, inbox, outbox } = packageAt()
  writeFileSync(join(inbox, 'gen-fixture001', 'run_once.sh'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'echo \'CANNESS_RESULT {"maxAbsErr":0.0009,"maxRelErr":0.00002,"badCount":0,"total":32768,"golden":"custom"}\'',
    '',
  ].join('\n'))
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, CSV))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  expect(report.status).toBe('pass')
  expect(report.runRecord.params.golden).toBe('custom')
})

test.skipIf(python === null)('set_env discovery prefers an explicit path, then toolkit, then newest CANN', () => {
  const root = mkdtempSync(join(tmpdir(), 'canness-env-'))
  const home = join(root, 'home')
  const toolkit = join(root, 'toolkit')
  const explicit = join(root, 'explicit.sh')
  const version9 = join(home, 'Ascend', 'cann-9.0.0', 'set_env.sh')
  const version8 = join(home, 'Ascend', 'cann-8.0.0', 'set_env.sh')
  const homeToolkit = join(home, 'Ascend', 'ascend-toolkit', 'set_env.sh')
  for (const path of [explicit, join(toolkit, 'set_env.sh'), version9, version8, homeToolkit]) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '# fake CANN environment\n')
  }
  const script = [
    'import json, runpy, sys',
    'module = runpy.run_path(sys.argv[1])',
    'module["discover_set_env"].__globals__["SYSTEM_SET_ENV"] = sys.argv[5]',
    'print(json.dumps(module["discover_set_env"](sys.argv[2], __import__("pathlib").Path(sys.argv[3]), sys.argv[4])))',
  ].join('\n')
  const probe = (path: string, toolkitHome: string) => {
    const done = spawnSync(python!, ['-c', script, runner, path, home, toolkitHome, join(root, 'missing-system.sh')], { encoding: 'utf8' })
    expect(done.status, done.stderr).toBe(0)
    return JSON.parse(done.stdout) as [string | null, string[]]
  }
  expect(probe(explicit, toolkit)[0]).toBe(explicit)
  expect(probe('', toolkit)[0]).toBe(join(toolkit, 'set_env.sh'))
  expect(probe('', '')[0]).toBe(homeToolkit)
  rmSync(homeToolkit)
  expect(probe('', '')[0]).toBe(version9)
  rmSync(version9)
  expect(probe('', '')[0]).toBe(version8)
  rmSync(version8)
  const [chosen, searched] = probe('', '')
  expect(chosen).toBeNull()
  expect(searched).toContain(join(home, 'Ascend', 'cann-*', 'set_env.sh'))
})

test.skipIf(python === null)('a missing CANN environment is visible in compile.log', () => {
  const { root, inbox, outbox } = packageAt()
  const done = runRunner(root, inbox, outbox, fakeMsprof(root, CSV))
  expect(done.status, done.stderr).toBe(0)
  const report = results(outbox)
  if (report.runRecord.params.setEnv === null) {
    expect(report.compile.log).toContain('set_env.sh not found; searched:')
    expect(report.compile.log).toContain('PATH may lack bisheng')
  } else {
    expect(existsSync(report.runRecord.params.setEnv)).toBe(true)
  }
})
