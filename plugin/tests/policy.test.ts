import { expect, test } from 'vitest'
import { malformedReport, parseReport, timeoutReport, type EvalReport } from '../src/report.ts'
import { applyReport, emptyState, enhancementBlock, shouldSteer, stopReason, type PolicyConfig } from '../src/policy.ts'

const config: PolicyConfig = {
  maxIterations: 10,
  maxCompileRetries: 3,
  negativeStreakLimit: 3,
  convergenceThreshold: 0.05,
}

function report(over: Partial<EvalReport>): EvalReport {
  return {
    generationId: 'gen-0123abcd',
    status: 'pass',
    compile: { ok: true, log: '' },
    correctness: { ok: true, maxRelativeError: 0 },
    performance: { kernelTimeUs: 100, targetUs: 150 },
    analysis: null,
    summary: 'ok',
    ...over,
  }
}

test('compile failure does not spend a valid iteration', () => {
  const next = applyReport(emptyState(), report({ status: 'compile_fail', summary: 'cmake' }))
  expect(next.validIterations).toBe(0)
  expect(next.compileRetries).toBe(1)
  expect(shouldSteer(next, config)).toBe(true)
})

test('third compile failure stops without steering', () => {
  let state = emptyState()
  for (let i = 0; i < 3; i++) state = applyReport(state, report({ status: 'compile_fail' }))
  expect(stopReason(state, config)).toBe('compileRetries')
  expect(shouldSteer(state, config)).toBe(false)
})

test('two timeouts stop', () => {
  let state = applyReport(emptyState(), timeoutReport('gen-0123abcd', 1800))
  expect(state.validIterations).toBe(0)
  state = applyReport(state, timeoutReport('gen-0123abcd', 1800))
  expect(stopReason(state, config)).toBe('timeouts')
})

test('a passing kernel at or under target stops as targetMet', () => {
  const state = applyReport(emptyState(), report({ status: 'pass' }))
  expect(state.validIterations).toBe(1)
  expect(stopReason(state, config)).toBe('targetMet')
  expect(shouldSteer(state, config)).toBe(false)
})

test('two close passes converge', () => {
  const first = applyReport(emptyState(), report({
    status: 'pass',
    performance: { kernelTimeUs: 200, targetUs: 150 },
  }))
  expect(stopReason(first, config)).toBeNull()
  const second = applyReport(first, report({
    status: 'pass',
    performance: { kernelTimeUs: 198, targetUs: 150 },
  }))
  expect(stopReason(second, config)).toBe('converged')
})

test('worse kernel times build a negative streak', () => {
  let state = emptyState()
  for (const us of [100, 110, 120]) {
    state = applyReport(state, report({
      status: 'perf_fail',
      performance: { kernelTimeUs: us, targetUs: 150 },
    }))
  }
  expect(state.negativeStreak).toBe(2)
  expect(state.bestKernelTimeUs).toBe(100)
})

test('malformed remote json becomes an error report', () => {
  const parsed = parseReport({ status: 'shipped' })
  expect(parsed.status).toBe('error')
  expect(malformedReport('gen-1', 'no').status).toBe('error')
})

test('keeps an msprof-shaped analysis and drops a bad one', () => {
  const parsed = parseReport({
    generationId: 'gen-1',
    status: 'pass',
    analysis: {
      source: 'msprof',
      bottleneck: 'memory',
      summary: 'aic_mte2_ratio 0.71',
      op: {
        opName: 'Add',
        opType: 'Add',
        taskType: 'AI_CORE',
        taskDurationUs: 150,
        taskWaitTimeUs: 2,
        blockDim: 8,
        aicoreTimeUs: 140,
        aicMacRatio: 0.12,
        aicMte2Ratio: 0.71,
        aicScalarRatio: 0.09,
        cubeUtilizationPct: 18.4,
      },
    },
  })
  expect(parsed.analysis?.bottleneck).toBe('memory')
  expect(parsed.analysis?.op?.aicMte2Ratio).toBe(0.71)
  expect(parseReport({ status: 'pass', analysis: { source: 'nope' } }).analysis).toBeNull()
})

test('enhancement names the status and does not steer before any report', () => {
  expect(shouldSteer(emptyState(), config)).toBe(false)
  const state = applyReport(emptyState(), report({ status: 'accuracy_fail', summary: 'err 0.2' }))
  expect(enhancementBlock(state)).toContain('accuracy_fail')
  expect(enhancementBlock(state)).toContain('err 0.2')
  expect(enhancementBlock(state)).toContain('性能分析：无')
  const analyzed = applyReport(emptyState(), report({
    status: 'perf_fail',
    analysis: {
      source: 'msprof',
      bottleneck: 'memory',
      summary: 'aic_mte2_ratio 0.71',
      op: null,
    },
  }))
  expect(enhancementBlock(analyzed)).toContain('aic_mte2_ratio 0.71')
  expect(enhancementBlock(analyzed)).not.toContain('Task Duration')
})
