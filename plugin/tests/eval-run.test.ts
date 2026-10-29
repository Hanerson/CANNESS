import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runEvaluation } from '../src/eval-run.ts'
import { emptyState, type PolicyConfig } from '../src/policy.ts'
import { MemoryRemote } from '../src/remote.ts'

const config: PolicyConfig = {
  maxIterations: 10,
  maxCompileRetries: 3,
  negativeStreakLimit: 3,
  convergenceThreshold: 0.05,
}

function pack(): string {
  const dir = mkdtempSync(join(tmpdir(), 'canness-pkg-'))
  writeFileSync(join(dir, 'manifest.json'), '{}')
  return dir
}

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
