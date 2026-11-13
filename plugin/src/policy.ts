import type { EvalReport } from './report.js'
import type { OperatorSpec } from './spec.js'

export interface PolicyConfig {
  maxIterations: number
  maxCompileRetries: number
  negativeStreakLimit: number
  convergenceThreshold: number
  /**
   * Consecutive rounds without real gain that end the loop with a human
   * decision. Optional so an existing profile row keeps working.
   */
  stallRounds?: number
  /** Smallest relative improvement that still counts as progress (0.03 = 3%). */
  stallGain?: number
  /** Gap to target, as `achieved / target`, at which a stall is worth a human. */
  stallGap?: number
  /** Limit automatic prompts produced for one evaluation report. */
  maxSteerPerReport?: number
}

/** How many recent kernel times the stall detector keeps. */
const RECENT_LIMIT = 6

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
  /**
   * Kernel times of the most recent valid iterations, oldest first.
   *
   * The negative streak answers "did it get worse than the best ever", which a
   * monotonically improving kernel never triggers — even while it sits three
   * times above an unreachable target. This window is what makes "stopped
   * improving" observable at all.
   */
  recentKernelTimeUs?: number[]
  /** The target a later spec replaced with a larger one, so a pass got cheaper. */
  targetRelaxedUs?: number | null
  /**
   * The session that owns this task.
   *
   * The loop used to drive every session in the profile: the state file is
   * shared and the listeners are global, so one session's `perf_fail` made a
   * session that never ran the operator report a retry 40 times. Only the
   * session recorded here is driven; a state file without an owner stays quiet
   * until some session claims it by evaluating.
   */
  ownerSessionId?: string | null
  /**
   * One retry is owed for the newest report.
   *
   * Set when an evaluation writes a report and consumed by the loop before it
   * steers. Without it the loop steered at every turn end, including turns that
   * never touched the operator — which is how 232 prompts landed in 36 minutes.
   */
  pendingSteer?: boolean
  /** Automatic prompts issued for the current report, including pre-step notices. */
  steerCount?: number
  /** Unix milliseconds of the last automatic prompt. */
  lastSteerAt?: number
  /** Fingerprint of the package most recently built for this generation. */
  packageHash?: string | null
  /** Fingerprint sent to the runner in the most recent evaluation. */
  lastEvaluatedHash?: string | null
  lastReport: EvalReport | null
}

export type StopReason =
  | 'timeouts' | 'compileRetries' | 'maxIterations' | 'negativeStreak' | 'converged' | 'targetMet' | 'stalled'

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
    recentKernelTimeUs: [],
    targetRelaxedUs: null,
    ownerSessionId: null,
    pendingSteer: false,
    steerCount: 0,
    lastSteerAt: 0,
    packageHash: null,
    lastEvaluatedHash: null,
    lastReport: null,
  }
}

/**
 * Whether this session is the one the task belongs to.
 *
 * A state file written before ownership existed has no owner, and guessing one
 * is what made the loop reach every session; those files stay quiet until a
 * session claims them by running an evaluation.
 * @param state - the stored fold.
 * @param sessionId - the session asking.
 * @returns true only for the recorded owner.
 */
export function ownsSession(state: TaskState, sessionId: string | undefined): boolean {
  const owner = state.ownerSessionId
  return owner != null && owner.length > 0 && owner === sessionId
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
  if (us != null) {
    next.recentKernelTimeUs = [...(state.recentKernelTimeUs ?? []), us].slice(-RECENT_LIMIT)
  }
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

/** The gap to target, as a multiple, from the latest report. */
export function targetGap(state: TaskState): number | null {
  const us = state.lastReport?.performance.kernelTimeUs
  const target = state.lastReport?.performance.targetUs
  if (us == null || target == null || target <= 0) return null
  return us / target
}

/**
 * Whether the last few rounds stopped moving the number.
 *
 * Two conditions must hold together: the recent rounds gained less than the
 * configured fraction, and the result is still far enough from the target that
 * the remaining distance cannot come from another small tweak. Without the
 * second condition a genuinely converging kernel would be stopped early.
 * @param state - the fold after the last report.
 * @param config - policy knobs; the three stall fields default here.
 * @returns true when a human decision should replace another round.
 */
export function isStalled(state: TaskState, config: PolicyConfig): boolean {
  const rounds = config.stallRounds ?? 2
  const gain = config.stallGain ?? 0.03
  const gap = config.stallGap ?? 1.5
  const recent = state.recentKernelTimeUs ?? []
  if (rounds < 1 || recent.length < rounds + 1) return false
  const tail = recent.slice(-(rounds + 1))
  let quiet = 0
  for (let index = 1; index < tail.length; index += 1) {
    const previous = tail[index - 1] as number
    const current = tail[index] as number
    if (previous <= 0) return false
    // A regression is no progress either, so it counts toward the stall.
    if ((previous - current) / previous < gain) quiet += 1
  }
  if (quiet < rounds) return false
  const gapNow = targetGap(state)
  return gapNow !== null && gapNow >= gap
}

export function stopReason(state: TaskState, config: PolicyConfig): StopReason | null {
  if (state.timeouts >= 2) return 'timeouts'
  if (state.compileRetries >= config.maxCompileRetries) return 'compileRetries'
  if (state.validIterations >= config.maxIterations) return 'maxIterations'
  if (state.negativeStreak >= config.negativeStreakLimit) return 'negativeStreak'
  if (isStalled(state, config)) return 'stalled'
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

/** Lines a compiler emits that carry no decision, only context expansion. */
const NOISE = [
  /-Wignored-attributes/u,
  /note: expanded from macro/u,
  /^\s*#define\s/u,
  /^\s*\^~*\s*$/u,
  /^\s*\|/u,
  /^\s*\d+\s*\|\s/u,
]

/** A line worth keeping when the build succeeded: a real diagnostic or a marker. */
function isSignal(line: string): boolean {
  return /error|错误|failed|FAILED|undefined reference|warning:/u.test(line)
}

/**
 * Condense a compiler log for injection into the next turn.
 *
 * A successful build usually prints nothing but expanded warnings, and the
 * previous version pasted the first 2000 characters of exactly that on every
 * round — which both wasted context and, on a failing build, cut off the
 * `error:` lines at the end. Failures keep the tail (where the error is),
 * successes keep only genuinely new information plus a count.
 * @param log - the full compiler output.
 * @param ok - whether the build succeeded.
 * @returns a short digest, at most a few hundred characters.
 */
export function condenseCompileLog(log: string, ok: boolean): string {
  const lines = log.split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line.trim().length > 0)
  if (lines.length === 0) return ok ? '(no output)' : '(empty log)'
  const signal: string[] = []
  let dropped = 0
  for (const line of lines) {
    const boilerplate = NOISE.some(pattern => pattern.test(line))
    // A successful build's remaining lines are diagnostics nobody acts on, so
    // only a failure keeps them; both cases collapse consecutive duplicates.
    if (boilerplate || (ok && !isSignal(line))) {
      dropped += 1
      continue
    }
    if (signal[signal.length - 1] !== line) signal.push(line)
  }
  // When nothing but boilerplate was left, the digest still has to show the
  // last few real lines (the build marker, the tail of the log) rather than the
  // macro expansions that were just filtered out.
  const shown = signal.length === 0
    ? lines.filter(line => !NOISE.some(pattern => pattern.test(line))).slice(-3)
    : signal.slice(-8)
  const body = shown.join('\n').slice(0, 700)
  const note = dropped > 0 ? `\n(${String(lines.length)} lines, ${String(dropped)} boilerplate)` : ''
  return `${body}${note}`
}

export function enhancementBlock(state: TaskState, config: PolicyConfig = {
  maxIterations: 10, maxCompileRetries: 3, negativeStreakLimit: 3, convergenceThreshold: 0.05,
}): string {
  const report = state.lastReport
  if (report == null) return ''
  const gap = targetGap(state)
  const recent = (state.recentKernelTimeUs ?? []).slice(-3)
  const trend = recent.length >= 2
    ? `最近 ${String(recent.length)} 轮 kernel_time_us：${recent.map(value => value.toFixed(1)).join(' → ')}`
    : null
  const far = gap !== null && gap >= 2
  return [
    `上次评测 ${report.status}（${report.generationId}）。`,
    `摘要：${report.summary}`,
    `编译日志：${condenseCompileLog(report.compile.log, report.compile.ok)}`,
    `maxRelativeError：${String(report.correctness.maxRelativeError)}`,
    `kernel_time_us：${String(report.performance.kernelTimeUs)}，目标 ${String(report.performance.targetUs)}`
      + (gap === null ? '' : `（还差 ${gap.toFixed(2)} 倍）`),
    `性能分析：${report.analysis?.summary ?? '无'}`,
    ...(trend === null ? [] : [trend]),
    ...(state.targetRelaxedUs == null ? [] : [`注意：目标已从 ${String(state.targetRelaxedUs)}us 放宽，放宽后的通过不代表达标。`]),
    `有效迭代 ${String(state.validIterations)}（上限 ${String(config.maxIterations)}），编译重试 ${String(state.compileRetries)}，超时 ${String(state.timeouts)}，变差连续 ${String(state.negativeStreak)}。`,
    far
      ? '距离目标超过一倍时，小步调参通常无效：优先考虑换算法或换数据切分；若判断不可达，请停止调参并说明理由（不要通过放宽目标来“通过”）。'
      : '请修改四层代码后再次调用 build_test_package 和 run_evaluation。',
    ...(report.status === 'compile_fail'
      ? [`编译契约：kernel 入口必须是 extern "C" __global__ __aicore__ void canness_kernel(<输入…>, <输出…>, GM_ADDR tiling)，不要带 workspace 参数；签名不对会链接失败。`]
      : []),
    ...((state.steerCount ?? 0) >= (config.maxSteerPerReport ?? 3)
      ? [`本次报告已自动提示 ${String(state.steerCount)} 次，暂停自动续轮。`] : []),
  ].join('\n')
}
