import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runEvaluation, runnerCommand } from '../src/eval-run.ts'
import { emptyState, type PolicyConfig } from '../src/policy.ts'
import { MemoryRemote } from '../src/remote.ts'
import { packageHash } from '../src/package-files.ts'

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

test('uploads then parses a result that shows up later', async () => {
  const remote = new MemoryRemote()
  const generationId = 'gen-0123abcd'
  remote.appearOnRead(`/out/${generationId}/results.json`, Buffer.from(JSON.stringify({
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
    now: (() => { let t = 0; return () => t })(),
    sleep: async () => {},
  })
  expect(report.status).toBe('compile_fail')
  expect(state.compileRetries).toBe(1)
  expect(remote.files.has('/in/gen-0123abcd/manifest.json')).toBe(true)
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

test('a later read of the same generation ignores a seeded results.json', async () => {
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
  // onRead 2: the first poll still returns the seeded body unless removeFile ran first.
  remote.appearOnRead(resultPath, Buffer.from(JSON.stringify({
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
    now: () => t,
    sleep: async (ms) => { slept += 1; t += ms },
  })
  expect(report.status).toBe('accuracy_fail')
  expect(report.summary).toBe('fresh accuracy')
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
