import { parseAnalysis, type PerformanceAnalysis } from './analysis.js'

export type ResultStatus = 'pass' | 'compile_fail' | 'accuracy_fail' | 'perf_fail' | 'timeout' | 'error'

/** A lossless JSON value, structurally matching the tool schema's `json` node. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Traceability record written by the remote runner (issue i11.12).
 * `params` is the free-form compile/tiling parameter set the package carried.
 */
export interface RunRecord {
  timestamp: string
  host: string
  params: { [key: string]: JsonValue }
  toolchain: string
  durationMs: number
}

export interface EvalReport {
  generationId: string
  status: ResultStatus
  compile: { ok: boolean; log: string }
  correctness: { ok: boolean; maxRelativeError: number | null }
  performance: { kernelTimeUs: number | null; targetUs: number | null }
  analysis: PerformanceAnalysis | null
  /** Present when the remote runner wrote it; older results omit it. */
  runRecord?: RunRecord
  /** Local duplicate guard returned the previous report without using SSH. */
  duplicate?: boolean
  summary: string
}

const STATUSES: readonly ResultStatus[] = ['pass', 'compile_fail', 'accuracy_fail', 'perf_fail', 'timeout', 'error']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function malformedReport(generationId: string, detail: string): EvalReport {
  return {
    generationId,
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `malformed result: ${detail}`,
  }
}

export function stoppedReport(generationId: string, reason: string): EvalReport {
  return {
    generationId,
    status: 'error',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `stopped: ${reason}`,
  }
}

export function timeoutReport(generationId: string, timeoutSec: number): EvalReport {
  return {
    generationId,
    status: 'timeout',
    compile: { ok: false, log: '' },
    correctness: { ok: false, maxRelativeError: null },
    performance: { kernelTimeUs: null, targetUs: null },
    analysis: null,
    summary: `timed out after ${timeoutSec}s`,
  }
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseRunRecord(raw: unknown): RunRecord | undefined {
  if (!isRecord(raw)) return undefined
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : ''
  const host = typeof raw.host === 'string' ? raw.host : ''
  const toolchain = typeof raw.toolchain === 'string' ? raw.toolchain : ''
  const durationMs = numOrNull(raw.durationMs)
  if (timestamp === '' || host === '' || toolchain === '' || durationMs == null) return undefined
  if (!isRecord(raw.params)) return undefined
  return { timestamp, host, params: raw.params as { [key: string]: JsonValue }, toolchain, durationMs }
}

export function parseReport(raw: unknown): EvalReport {
  if (!isRecord(raw)) return malformedReport('unknown', 'not an object')
  const generationId = typeof raw.generationId === 'string' ? raw.generationId : 'unknown'
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as ResultStatus)) {
    return malformedReport(generationId, 'bad status')
  }
  const compile = isRecord(raw.compile) ? raw.compile : {}
  const correctness = isRecord(raw.correctness) ? raw.correctness : {}
  const performance = isRecord(raw.performance) ? raw.performance : {}
  const runRecord = parseRunRecord(raw.runRecord)
  return {
    generationId,
    status: raw.status as ResultStatus,
    compile: { ok: compile.ok === true, log: typeof compile.log === 'string' ? compile.log : '' },
    correctness: { ok: correctness.ok === true, maxRelativeError: numOrNull(correctness.maxRelativeError) },
    performance: { kernelTimeUs: numOrNull(performance.kernelTimeUs), targetUs: numOrNull(performance.targetUs) },
    analysis: parseAnalysis(raw.analysis),
    ...(runRecord === undefined ? {} : { runRecord }),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
  }
}
