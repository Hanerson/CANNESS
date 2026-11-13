export interface MsprofOp {
  opName: string
  opType: string
  taskType: string
  taskDurationUs: number
  taskWaitTimeUs: number | null
  blockDim: number | null
  aicoreTimeUs: number | null
  aicMacRatio: number | null
  aicMte2Ratio: number | null
  aicScalarRatio: number | null
  cubeUtilizationPct: number | null
}

export interface PerformanceAnalysis {
  source: 'msprof'
  bottleneck: 'cube' | 'memory' | 'scalar' | 'unknown'
  summary: string
  op: MsprofOp | null
  achievedBandwidthGBps?: number | null
  rooflineUs?: number | null
  baselineUs?: number | null
}

/** The only accepted origin: numbers came from an actual msprof run. */
const SOURCES = ['msprof'] as const
const BOTTLENECKS = ['cube', 'memory', 'scalar', 'unknown'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseOp(raw: unknown): MsprofOp | null {
  if (!isRecord(raw)) return null
  const taskDurationUs = numOrNull(raw.taskDurationUs)
  if (taskDurationUs == null) return null
  return {
    opName: text(raw.opName),
    opType: text(raw.opType),
    taskType: text(raw.taskType),
    taskDurationUs,
    taskWaitTimeUs: numOrNull(raw.taskWaitTimeUs),
    blockDim: numOrNull(raw.blockDim),
    aicoreTimeUs: numOrNull(raw.aicoreTimeUs),
    aicMacRatio: numOrNull(raw.aicMacRatio),
    aicMte2Ratio: numOrNull(raw.aicMte2Ratio),
    aicScalarRatio: numOrNull(raw.aicScalarRatio),
    cubeUtilizationPct: numOrNull(raw.cubeUtilizationPct),
  }
}

export function parseAnalysis(raw: unknown): PerformanceAnalysis | null {
  if (!isRecord(raw)) return null
  if (typeof raw.source !== 'string' || !(SOURCES as readonly string[]).includes(raw.source)) return null
  if (typeof raw.bottleneck !== 'string' || !(BOTTLENECKS as readonly string[]).includes(raw.bottleneck)) return null
  return {
    source: raw.source as PerformanceAnalysis['source'],
    bottleneck: raw.bottleneck as PerformanceAnalysis['bottleneck'],
    summary: text(raw.summary),
    op: parseOp(raw.op),
    achievedBandwidthGBps: numOrNull(raw.achievedBandwidthGBps),
    rooflineUs: numOrNull(raw.rooflineUs),
    baselineUs: numOrNull(raw.baselineUs),
  }
}
