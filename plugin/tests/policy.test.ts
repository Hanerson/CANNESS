import { expect, test } from 'vitest'
import { malformedReport, parseReport, timeoutReport, type EvalReport } from '../src/report.ts'
import {
  applyReport, condenseCompileLog, emptyState, enhancementBlock, isStalled, shouldSteer, stopReason,
  type PolicyConfig,
} from '../src/policy.ts'

const config: PolicyConfig = {
  maxIterations: 10,
  maxCompileRetries: 3,
  negativeStreakLimit: 3,
  convergenceThreshold: 0.05,
  stallRounds: 2,
  stallGain: 0.03,
  stallGap: 1.5,
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

test('enthancement names the status and does not steer before any report', () => {
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

/** Feed the observed ArgMax series and return the fold. */
function series(values: number[], targetUs: number, status: EvalReport['status'] = 'perf_fail') {
  let state = emptyState()
  for (const us of values) {
    state = applyReport(state, report({ status, performance: { kernelTimeUs: us, targetUs } }))
  }
  return state
}

test('rounds that barely move the number stop as stalled', () => {
  // 0.3% per round against a target 2.9x away: the old policy saw "improved"
  // every time, so the negative streak stayed 0 and nothing could stop it.
  const state = series([350, 349, 348], 120)
  expect(state.negativeStreak).toBe(0)
  expect(isStalled(state, config)).toBe(true)
  expect(stopReason(state, config)).toBe('stalled')
  expect(shouldSteer(state, config)).toBe(false)
})

test('a fast-improving series far from target keeps going', () => {
  // The observed ArgMax run gained ~6% per round; that is real progress, so the
  // stall rule must not fire — the iteration budget is what bounds it.
  const state = series([398, 374, 350], 120)
  expect(isStalled(state, config)).toBe(false)
})

test('an identical repeated result also counts as no progress', () => {
  const state = series([350, 350, 350], 120)
  expect(isStalled(state, config)).toBe(true)
})

test('near-target progress is not mistaken for a stall', () => {
  // Two rounds inside one and a half times the target: another tweak may
  // still land it, so the loop keeps going.
  const state = series([140, 139, 138], 120)
  expect(isStalled(state, config)).toBe(false)
  expect(shouldSteer(state, config)).toBe(true)
})

test('a single bad round is not a stall', () => {
  const state = series([350, 349], 120)
  expect(isStalled(state, config)).toBe(false)
})

test('the injection block reports the gap, the trend, and stops asking for a tweak', () => {
  const state = series([398, 374, 350], 120)
  const block = enhancementBlock(state, config)
  expect(block).toContain('还差')
  expect(block).toContain('倍')
  expect(block).toContain('374.0 → 350.0')
  // At three times the target a small tweak is not the advice any more.
  expect(block).not.toContain('请修改四层代码')
})

test('a relaxed target is called out instead of credited as a pass', () => {
  const state = applyReport({ ...emptyState(), targetRelaxedUs: 120 }, report({
    status: 'perf_fail',
    performance: { kernelTimeUs: 350, targetUs: 400 },
  }))
  expect(enhancementBlock(state, config)).toContain('目标已从 120us 放宽')
})

test('compile log condensation drops warning boilerplate', () => {
  const log = [
    'build.sh: built /tmp/x',
    "main.cpp:224:61: warning: 'cce_global' attribute ignored when parsing type [-Wignored-attributes]",
    '/opt/cann/aarch64-linux/tikcpp/tikcfw/impl/utils/kernel_utils_macros.h:23:17: note: expanded from macro GM_ADDR',
    '#define GM_ADDR __gm__ uint8_t*',
    '                              ^~~~~~~~~~',
    "main.cpp:224:84: warning: 'cce_global' attribute ignored when parsing type [-Wignored-attributes]",
  ].join('\n')
  const condensed = condenseCompileLog(log, true)
  expect(condensed).toContain('built /tmp/x')
  expect(condensed).not.toContain('expanded from macro')
  expect(condensed).not.toContain('#define GM_ADDR')
  expect(condensed.length).toBeLessThan(log.length)
})

test('a failing build keeps its error lines rather than its first 2000 characters', () => {
  const filler = Array.from({ length: 60 }, (_, index) => `noise line ${String(index)}`).join('\n')
  const log = `${filler}\nmain.cpp:9:3: error: use of undeclared identifier 'foo'`
  const condensed = condenseCompileLog(log, false)
  expect(condensed).toContain("error: use of undeclared identifier 'foo'")
})
