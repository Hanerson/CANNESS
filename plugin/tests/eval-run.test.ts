import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runEvaluation, runnerCommand } from '../src/eval-run.ts'
import { emptyState, type PolicyConfig } from '../src/policy.ts'
import { MemoryRemote } from '../src/remote.ts'
import { buildTestPackage, packageHash, repairPackage, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'

const config: PolicyConfig = {
  maxIterations: 10,
  maxCompileRetries: 3,
  negativeStreakLimit: 3,
  convergenceThreshold: 0.05,
}

test('runnerCommand forwards a configured set_env path safely', () => {
  const command = runnerCommand({ runnerPath: '/tmp/runner.py', inbox: '/in', outbox: '/out', generationId: 'gen-1', timeoutSec: 10, setEnv: '/home/developer/Ascend/cann-9.0.0/set env.sh' })
  expect(command).toContain("--set-env '/home/developer/Ascend/cann-9.0.0/set env.sh'")
})

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canness-pkg-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  return dir
}

function attemptPath(root: string, generationId: string, token: string): string {
  return `${root}/${generationId}/attempt-${token}/${generationId}`
}

test('a changed package is rejected before any remote upload', async () => {
  const dir = pack()
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ packageHash: packageHash(dir) }))
  writeFileSync(join(dir, 'main.cpp'), '// modified after package assembly')
  const remote = new MemoryRemote()
  await expect(runEvaluation({
    files: remote, localPackageDir: dir, generationId: 'gen-drift',
    inbox: '/in', outbox: '/out', timeoutMs: 1000, intervalMs: 1000,
    state: emptyState(), config,
  })).rejects.toThrow('package changed after build_test_package')
  expect(remote.files.size).toBe(0)
})

test('runEvaluation accepts a package repaired after build_test_package (CAN-103)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-repair-'))
  const generationId = 'gen-0badf00d'
  const spec = parseSpec({
    operator_name: 'Add', operator_type: 'elementwise',
    input_specs: [{ name: 'x', shape: ['16'], dtype: 'float16' }],
    output_specs: [{ name: 'y', shape: ['16'], dtype: 'float16' }],
    target_platform: { chip: 'Ascend910B2' }, performance_target: { metric: 'kernel_time', target_us: 50 },
  })
  writeOperator(workspace, generationId, {
    kernel: 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) { GET_TILING_DATA(t, tiling); }',
    host: '', api: '', plugin: '',
  })
  const pkg = buildTestPackage(workspace, generationId, spec)
  repairPackage(workspace, generationId, { drop: ['.contract-selfcheck'] })
  const remote = new MemoryRemote()
  remote.execHandler = () => {
    remote.files.set(`${attemptPath('/out', generationId, 'repaired')}/results.json`, Buffer.from(JSON.stringify({
      generationId,
      status: 'pass',
      compile: { ok: true, log: '' },
      correctness: { ok: true, maxRelativeError: 0 },
      performance: { kernelTimeUs: 10, targetUs: 50 },
      summary: 'repaired package accepted',
    })))
    return { code: 0, stdout: '', stderr: '' }
  }
  const { report } = await runEvaluation({
    files: remote,
    localPackageDir: pkg,
    generationId,
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state: { ...emptyState(), generationId },
    config,
    token: () => 'repaired',
  })
  expect(report.status).toBe('pass')
})

test('a same-generation rerun drops files deleted by repair_package (CAN-103 review)', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-reupload-'))
  const generationId = 'gen-0badf00d'
  const spec = parseSpec({
    operator_name: 'Add', operator_type: 'elementwise',
    input_specs: [{ name: 'x', shape: ['16'], dtype: 'float16' }],
    output_specs: [{ name: 'y', shape: ['16'], dtype: 'float16' }],
    target_platform: { chip: 'Ascend910B2' }, performance_target: { metric: 'kernel_time', target_us: 50 },
  })
  writeOperator(workspace, generationId, {
    kernel: 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) { GET_TILING_DATA(t, tiling); }',
    host: '', api: '', plugin: '',
  })
  const pkg = buildTestPackage(workspace, generationId, spec)
  const remote = new MemoryRemote()
  remote.execHandler = command => {
    const outbox = /--outbox '([^']+)'/.exec(command)![1]!
    remote.files.set(`${outbox}/${generationId}/results.json`, Buffer.from(JSON.stringify({
      generationId,
      status: 'pass',
      compile: { ok: true, log: '' },
      correctness: { ok: true, maxRelativeError: 0 },
      performance: { kernelTimeUs: 10, targetUs: 50 },
      summary: 'ok',
    })))
    return { code: 0, stdout: '', stderr: '' }
  }
  const run = (token: string) => runEvaluation({
    files: remote,
    localPackageDir: pkg,
    generationId,
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state: { ...emptyState(), generationId },
    config,
    token: () => token,
  })
  const first = await run('first')
  const selfCheck = '.contract-selfcheck/build.sh'
  expect(remote.files.has(`${attemptPath('/in', generationId, 'first')}/${selfCheck}`)).toBe(true)
  repairPackage(workspace, generationId, { drop: ['.contract-selfcheck'] })
  const second = await run('second')
  const secondUpload = attemptPath('/in', generationId, 'second')
  expect(second.report.status).toBe('pass')
  expect(remote.files.has(`${secondUpload}/${selfCheck}`)).toBe(false)
  expect(remote.files.has(`${secondUpload}/manifest.json`)).toBe(true)
  expect(remote.files.has(first.resultsPath!)).toBe(true)
})

test('compile-only uploads a package whose manifest hash drifted (CAN-104)', async () => {
  const dir = pack()
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ packageHash: 'stale-manifest' }))
  const remote = new MemoryRemote()
  let t = 0
  const { report } = await runEvaluation({
    files: remote,
    localPackageDir: dir,
    generationId: 'gen-drift',
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state: emptyState(),
    config,
    compileOnly: true,
    now: () => t,
    sleep: async (ms) => { t += ms },
  })
  expect(report.status).toBe('timeout')
  expect(remote.files.size).toBeGreaterThan(0)
})

test('overlapping evaluations use separate uploads and results for the same generation', async () => {
  const remote = new MemoryRemote()
  const generationId = 'gen-0123abcd'
  const firstStarted = Promise.withResolvers<void>()
  const allowFirstToFinish = Promise.withResolvers<void>()
  const uploads: string[] = []
  const results: string[] = []
  remote.execHandler = async command => {
    const inbox = /--inbox '([^']+)'/.exec(command)![1]!
    const outbox = /--outbox '([^']+)'/.exec(command)![1]!
    const upload = `${inbox}/${generationId}`
    const result = `${outbox}/${generationId}/results.json`
    const index = uploads.push(upload)
    results.push(result)
    if (index === 1) {
      firstStarted.resolve()
      await allowFirstToFinish.promise
    }
    const source = Buffer.from(remote.files.get(`${upload}/source.txt`)!).toString()
    remote.files.set(result, Buffer.from(JSON.stringify({
      generationId, status: 'pass', compile: { ok: true, log: '' },
      correctness: { ok: true, maxRelativeError: 0 },
      performance: { kernelTimeUs: 10, targetUs: 50 }, summary: source,
    })))
    return { code: 0, stdout: '', stderr: '' }
  }
  const run = (source: string) => {
    const localPackageDir = pack()
    writeFileSync(join(localPackageDir, 'source.txt'), source)
    return runEvaluation({
      files: remote, localPackageDir, generationId, inbox: '/in', outbox: '/out',
      timeoutMs: 1000, intervalMs: 1000, state: emptyState(), config,
    })
  }
  const first = run('first')
  await firstStarted.promise
  const second = await run('second')
  allowFirstToFinish.resolve()
  expect((await first).report.summary).toBe('first')
  expect(second.report.summary).toBe('second')
  expect(new Set(uploads).size).toBe(2)
  expect(new Set(results).size).toBe(2)
})

test('uploads then parses a result that shows up later', async () => {
  const remote = new MemoryRemote()
  const generationId = 'gen-0123abcd'
  remote.appearOnRead(`${attemptPath('/out', generationId, 'delayed')}/results.json`, Buffer.from(JSON.stringify({
    generationId,
    status: 'compile_fail',
    compile: { ok: false, log: 'error: x' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: 150 },
    summary: 'failed compile',
  })), 2)
  const { report, state } = await runEvaluation({
    files: remote,
    localPackageDir: pack(),
    generationId,
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 10_000,
    intervalMs: 1000,
    state: { ...emptyState(), generationId },
    config,
    token: () => 'delayed',
    now: (() => { let t = 0; return () => t })(),
    sleep: async () => {},
  })
  expect(report.status).toBe('compile_fail')
  expect(state.compileRetries).toBe(1)
  expect(remote.files.has(`${attemptPath('/in', generationId, 'delayed')}/manifest.json`)).toBe(true)
})

test('a poll timeout becomes a timeout report and does not throw', async () => {
  let t = 0
  const { report } = await runEvaluation({
    files: new MemoryRemote(),
    localPackageDir: pack(),
    generationId: 'gen-0123abcd',
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state: emptyState(),
    config,
    now: () => t,
    sleep: async (ms) => { t += ms },
  })
  expect(report.status).toBe('timeout')
})

test('refuses to upload when already stopped', async () => {
  const remote = new MemoryRemote()
  const state = { ...emptyState(), timeouts: 2 }
  const { report } = await runEvaluation({
    files: remote,
    localPackageDir: pack(),
    generationId: 'gen-0123abcd',
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state,
    config,
  })
  expect(report.summary).toBe('stopped: timeouts')
  expect(remote.files.size).toBe(0)
  expect(report.status).toBe('error')
})

test('a new attempt ignores and preserves the legacy generation results.json', async () => {
  const remote = new MemoryRemote()
  const generationId = 'gen-0123abcd'
  const resultPath = `/out/${generationId}/results.json`
  remote.files.set(resultPath, Buffer.from(JSON.stringify({
    generationId,
    status: 'compile_fail',
    compile: { ok: false, log: 'old' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: 150 },
    summary: 'old failure',
  })))
  remote.appearOnRead(`${attemptPath('/out', generationId, 'fresh')}/results.json`, Buffer.from(JSON.stringify({
    generationId,
    status: 'accuracy_fail',
    compile: { ok: true, log: '' },
    correctness: { ok: false, maxRelativeError: 0.2 },
    performance: { kernelTimeUs: null, targetUs: 150 },
    summary: 'fresh accuracy',
  })), 2)
  let t = 0
  let slept = 0
  const { report } = await runEvaluation({
    files: remote,
    localPackageDir: pack(),
    generationId,
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 10_000,
    intervalMs: 1000,
    state: { ...emptyState(), generationId },
    config,
    token: () => 'fresh',
    now: () => t,
    sleep: async (ms) => { slept += 1; t += ms },
  })
  expect(report.status).toBe('accuracy_fail')
  expect(report.summary).toBe('fresh accuracy')
  expect(remote.files.has(resultPath)).toBe(true)
  // The immediate post-runner read already sees the fresh file, so no poll sleep is needed.
  expect(slept).toBe(0)
})

test('a runner exit without a result becomes an error carrying the stderr excerpt', async () => {
  const remote = new MemoryRemote()
  remote.execHandler = () => ({ code: 2, stdout: '', stderr: 'line 1\nline 2\nbuild environment missing\n' })
  const { report, state } = await runEvaluation({
    files: remote,
    localPackageDir: pack(),
    generationId: 'gen-0123abcd',
    inbox: '/in',
    outbox: '/out',
    timeoutMs: 1000,
    intervalMs: 1000,
    state: emptyState(),
    config,
  })
  expect(report.status).toBe('error')
  expect(report.summary).toContain('remote runner failed:')
  expect(report.summary).toContain('build environment missing')
  expect(state.lastReport?.summary).toContain('build environment missing')
})
