import type { EvalReport } from './report.ts'
import type { OperatorSpec } from './spec.ts'

export interface PolicyConfig {
  maxIterations: number
  maxCompileRetries: number
  negativeStreakLimit: number
  convergenceThreshold: number
}

export interface TaskState {
  generationId: string | null
  spec: OperatorSpec | null
  validIterations: number
  compileRetries: number
  timeouts: number
  negativeStreak: number
  bestKernelTimeUs: number | null
  previousPassKernelTimeUs: number | null
  lastPassKernelTimeUs: number | null
  lastReport: EvalReport | null
}

export type StopReason = 'timeouts' | 'compileRetries' | 'maxIterations' | 'negativeStreak' | 'converged' | 'targetMet'

export function emptyState(): TaskState {
  return {
    generationId: null,
    spec: null,
    validIterations: 0,
    compileRetries: 0,
    timeouts: 0,
    negativeStreak: 0,
    bestKernelTimeUs: null,
    previousPassKernelTimeUs: null,
    lastPassKernelTimeUs: null,
    lastReport: null,
  }
}

export function applyReport(state: TaskState, report: EvalReport): TaskState {
  const next: TaskState = { ...state, lastReport: report }
  if (report.status === 'compile_fail') {
    next.compileRetries += 1
    return next
  }
  if (report.status === 'timeout') {
    next.timeouts += 1
    return next
  }
  next.validIterations += 1
  const us = report.performance.kernelTimeUs
  if (report.status === 'pass') {
    next.negativeStreak = 0
    if (us != null) {
      next.previousPassKernelTimeUs = next.lastPassKernelTimeUs
      next.lastPassKernelTimeUs = us
      if (next.bestKernelTimeUs == null || us < next.bestKernelTimeUs) next.bestKernelTimeUs = us
    }
    return next
  }
  if (us != null && (next.bestKernelTimeUs == null || us < next.bestKernelTimeUs)) {
    next.bestKernelTimeUs = us
    next.negativeStreak = 0
  } else {
    next.negativeStreak += 1
  }
  return next
}

export function stopReason(state: TaskState, config: PolicyConfig): StopReason | null {
  if (state.timeouts >= 2) return 'timeouts'
  if (state.compileRetries >= config.maxCompileRetries) return 'compileRetries'
  if (state.validIterations >= config.maxIterations) return 'maxIterations'
  if (state.negativeStreak >= config.negativeStreakLimit) return 'negativeStreak'
  const prev = state.previousPassKernelTimeUs
  const last = state.lastPassKernelTimeUs
  if (prev != null && last != null && Math.abs(prev - last) / Math.max(prev, 1) < config.convergenceThreshold) {
    return 'converged'
  }
  const report = state.lastReport
  if (
    report?.status === 'pass'
    && report.performance.kernelTimeUs != null
    && report.performance.targetUs != null
    && report.performance.kernelTimeUs <= report.performance.targetUs
  ) return 'targetMet'
  return null
}

export function shouldSteer(state: TaskState, config: PolicyConfig): boolean {
  return state.lastReport != null && state.lastReport.status !== 'pass' && stopReason(state, config) === null
}

export function enhancementBlock(state: TaskState): string {
  const report = state.lastReport
  if (report == null) return ''
  return [
    `上次评测 ${report.status}（${report.generationId}）。`,
    `摘要：${report.summary}`,
    `编译日志：${report.compile.log.slice(0, 2000)}`,
    `maxRelativeError：${String(report.correctness.maxRelativeError)}`,
    `kernel_time_us：${String(report.performance.kernelTimeUs)}，目标 ${String(report.performance.targetUs)}`,
    `性能分析：${report.analysis?.summary ?? '无'}`,
    `有效迭代 ${state.validIterations}，编译重试 ${state.compileRetries}，超时 ${state.timeouts}，变差连续 ${state.negativeStreak}。`,
    '请修改四层代码后再次调用 build_test_package 和 run_evaluation。',
  ].join('\n')
}
