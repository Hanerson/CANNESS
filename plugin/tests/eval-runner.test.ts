import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** Windows resolves `bash` to WSL's launcher from System32; the fixture needs Git Bash. */
function bashCommand(): string {
  if (process.env.CANNESS_TEST_BASH) return process.env.CANNESS_TEST_BASH
  const gitBash = 'C:/Program Files/Git/usr/bin/bash.exe'
  return process.platform === 'win32' && existsSync(gitBash) ? gitBash : 'bash'
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

function runRunner(root: string, inbox: string, outbox: string, msprof: string) {
  return spawnSync(python!, [
    runner, '--inbox', inbox, '--outbox', outbox,
    '--generation', 'gen-fixture001', '--once',
    '--set-env', '', '--lock', '', '--msprof', msprof, '--runs', '3',
    '--bash', bashCommand(),
  ], { encoding: 'utf8', env: process.env })
}

function results(outbox: string): Record<string, any> {
  return JSON.parse(readFileSync(join(outbox, 'gen-fixture001', 'results.json'), 'utf8'))
}

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
