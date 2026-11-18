import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { applyReport, emptyState, canForceEvaluation } from '../src/policy.ts'
import { resolveWorkspace } from '../src/workspace.ts'
import { remoteTargetAllowed } from '../src/eval.ts'
import type { EvalReport } from '../src/report.ts'

const config = { maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05 }
function measured(us: number, runs = 20): EvalReport {
  return { generationId: 'gen-a', status: 'perf_fail', compile: { ok: true, log: '' },
    correctness: { ok: true, maxRelativeError: 0 }, performance: { kernelTimeUs: us, targetUs: 10 },
    analysis: null, summary: 'measured', runRecord: { timestamp: 'now', host: 'npu', toolchain: '9', durationMs: 1,
      params: { runs, samplingBasis: 'fixed', metricBasis: 'msprof' } } }
}
test('same-package remeasurement never accumulates an optimization regression streak', () => {
  const state = { ...emptyState(), packageHash: 'same', lastEvaluatedHash: 'same', bestKernelTimeUs: 100,
    negativeStreak: 2, recentKernelTimeUs: [100, 110], lastReport: measured(110) }
  const next = applyReport(state, measured(120))
  expect(next.negativeStreak).toBe(2)
  expect(next.recentKernelTimeUs).toEqual([100, 110])
  expect(next.validIterations).toBe(1)
})
test('a changed sampling basis starts a fresh comparison window', () => {
  const state = { ...emptyState(), packageHash: 'new', lastEvaluatedHash: 'old', bestKernelTimeUs: 100,
    negativeStreak: 2, recentKernelTimeUs: [100, 110], lastReport: measured(110, 15) }
  const next = applyReport(state, measured(120, 20))
  expect(next.negativeStreak).toBe(0)
  expect(next.recentKernelTimeUs).toEqual([120])
  const improved = applyReport({ ...next, packageHash: 'next', lastEvaluatedHash: 'new' }, measured(115, 20))
  expect(improved.negativeStreak).toBe(0)
})
test('an ablation that improves over the prior candidate is not a consecutive regression', () => {
  let state = emptyState()
  for (const us of [1231, 1277, 1240]) state = applyReport(state, measured(us))
  expect(state.negativeStreak).toBe(0)
  expect(state.bestKernelTimeUs).toBe(1231)
})
test('a manual forced measurement may cross a soft policy stop once, never hard ceilings', () => {
  const state = { ...emptyState(), negativeStreak: 3 }
  expect(canForceEvaluation(state, config)).toBe(true)
  expect(canForceEvaluation({ ...state, forcedRunsAfterStop: 1 }, config)).toBe(false)
  expect(canForceEvaluation({ ...state, timeouts: 2 }, config)).toBe(false)
  expect(canForceEvaluation({ ...state, validIterations: 10 }, config)).toBe(false)
})
test('workspace is the session cwd itself, and an explicit override resolves against it', () => {
  // Platform-neutral absolute paths: the assertions only use path.resolve, so they
  // hold on both the Windows and the POSIX runners.
  const one = resolve('/jobs/one')
  const two = resolve('/jobs/two')
  expect(resolveWorkspace('', { agent: { session: { cwd: one } } })).toBe(one)
  expect(resolveWorkspace('/fixed', { agent: { session: { cwd: one } } })).toBe(resolve('/fixed'))
  expect(resolveWorkspace('artifacts', { agent: { session: { cwd: one } } })).toBe(resolve(one, 'artifacts'))
  expect(resolveWorkspace('', { agent: { session: { cwd: '', header: { cwd: two } } } })).toBe(two)
  // A nested default would put artifacts below the sandbox's writable root without its grant.
  expect(resolveWorkspace('', { agent: { session: { cwd: one } } })).not.toMatch(/canness-workspace$/)
})
test('remote reads admit history only when it is a known local generation and configured roots', () => {
  expect(remoteTargetAllowed('/in/gen-old/log', '/out', '/in', 'gen-now', ['/opt/Ascend'], ['gen-old'])).toBe(true)
  expect(remoteTargetAllowed('/in/gen-stranger/log', '/out', '/in', 'gen-now', [], ['gen-old'])).toBe(false)
  expect(remoteTargetAllowed('/opt/Ascend/include/a.h', '/out', '/in', null, ['/opt/Ascend'])).toBe(true)
  expect(remoteTargetAllowed('/opt/Ascend/../secret', '/out', '/in', null, ['/opt/Ascend'])).toBe(false)
})
