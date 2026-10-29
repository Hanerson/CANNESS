import { parseAnalysis, type PerformanceAnalysis } from './analysis.js'

export type ResultStatus = 'pass' | 'compile_fail' | 'accuracy_fail' | 'perf_fail' | 'timeout' | 'error'

export interface EvalReport {
  generationId: string
  status: ResultStatus
  compile: { ok: boolean; log: string }
  correctness: { ok: boolean; maxRelativeError: number | null }
  performance: { kernelTimeUs: number | null; targetUs: number | null }
  analysis: PerformanceAnalysis | null
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

export function parseReport(raw: unknown): EvalReport {
  if (!isRecord(raw)) return malformedReport('unknown', 'not an object')
  const generationId = typeof raw.generationId === 'string' ? raw.generationId : 'unknown'
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as ResultStatus)) {
    return malformedReport(generationId, 'bad status')
  }
  const compile = isRecord(raw.compile) ? raw.compile : {}
  const correctness = isRecord(raw.correctness) ? raw.correctness : {}
  const performance = isRecord(raw.performance) ? raw.performance : {}
  return {
    generationId,
    status: raw.status as ResultStatus,
    compile: { ok: compile.ok === true, log: typeof compile.log === 'string' ? compile.log : '' },
    correctness: { ok: correctness.ok === true, maxRelativeError: numOrNull(correctness.maxRelativeError) },
    performance: { kernelTimeUs: numOrNull(performance.kernelTimeUs), targetUs: numOrNull(performance.targetUs) },
    analysis: parseAnalysis(raw.analysis),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
  }
}
