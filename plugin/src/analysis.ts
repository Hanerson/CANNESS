export interface MsprofOp {
  opName: string
  opType: string
  taskType: string
  taskDurationUs: number
  taskWaitTimeUs: number | null
  blockDim: number | null
  blockDimSource?: 'msprof' | 'launch-config' | null
  kernelTaskType?: 'AIV' | 'AIC' | null
  kernelTaskTypeSource?: string | null
  aicoreTimeUs: number | null
  aicMacRatio: number | null
  aicMte2Ratio: number | null
  aicScalarRatio: number | null
  cubeUtilizationPct: number | null
}

interface KernelBlockBudget {
  blockIndex: number
  level2Calls: number
  elements: number
  callElements: number
}

export interface KernelBudget {
  source: 'correctness-stdout'
  elementBasis: string
  blocks: KernelBlockBudget[]
  level2Calls: number
  elements: number
  callElements: number
  perElementCalls: number | null
  averageElementsPerCall: number | null
}

export interface PerformanceAnalysis {
  source: 'msprof'
  bottleneck: 'cube' | 'memory' | 'scalar' | 'unknown'
  summary: string
  op: MsprofOp | null
  achievedBandwidthGBps?: number | null
  rooflineUs?: number | null
  baselineUs?: number | null
  notCollected?: string[]
  /** Directory the profiler CSVs were read from, when the runner reported it. */
  csvDir?: string
  kernelBudget?: KernelBudget
}

/** The profiler metrics come from an actual msprof run. */
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
    blockDimSource: raw.blockDimSource === 'msprof' || raw.blockDimSource === 'launch-config' ? raw.blockDimSource : null,
    kernelTaskType: raw.kernelTaskType === 'AIV' || raw.kernelTaskType === 'AIC' ? raw.kernelTaskType : null,
    kernelTaskTypeSource: typeof raw.kernelTaskTypeSource === 'string' ? raw.kernelTaskTypeSource : null,
    aicoreTimeUs: numOrNull(raw.aicoreTimeUs),
    aicMacRatio: numOrNull(raw.aicMacRatio),
    aicMte2Ratio: numOrNull(raw.aicMte2Ratio),
    aicScalarRatio: numOrNull(raw.aicScalarRatio),
    cubeUtilizationPct: numOrNull(raw.cubeUtilizationPct),
  }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseKernelBudget(raw: unknown): KernelBudget | undefined {
  if (!isRecord(raw) || raw.source !== 'correctness-stdout' || typeof raw.elementBasis !== 'string'
    || raw.elementBasis.trim() === '' || Array.from(raw.elementBasis).length > 96 || /[\u0000-\u001f\u007f]/.test(raw.elementBasis)
    || !Array.isArray(raw.blocks) || raw.blocks.length < 1 || raw.blocks.length > 128) return undefined

  const blocks: KernelBlockBudget[] = []
  let level2Calls = 0
  let elements = 0
  let callElements = 0
  for (const [blockIndex, block] of raw.blocks.entries()) {
    if (!isRecord(block) || block.blockIndex !== blockIndex || !isCount(block.level2Calls)
      || !isCount(block.elements) || !isCount(block.callElements)
      || (block.level2Calls === 0 && block.callElements !== 0)) return undefined
    blocks.push({ blockIndex, level2Calls: block.level2Calls, elements: block.elements, callElements: block.callElements })
    level2Calls += block.level2Calls
    elements += block.elements
    callElements += block.callElements
  }
  if (!isCount(level2Calls) || !isCount(elements) || !isCount(callElements)
    || raw.level2Calls !== level2Calls || raw.elements !== elements || raw.callElements !== callElements) return undefined

  const perElementCalls = elements === 0 ? null : level2Calls / elements
  const averageElementsPerCall = level2Calls === 0 ? null : callElements / level2Calls
  if (raw.perElementCalls !== perElementCalls || raw.averageElementsPerCall !== averageElementsPerCall) return undefined
  return { source: 'correctness-stdout', elementBasis: raw.elementBasis, blocks, level2Calls, elements,
    callElements, perElementCalls, averageElementsPerCall }
}

export function parseAnalysis(raw: unknown): PerformanceAnalysis | null {
  if (!isRecord(raw)) return null
  if (typeof raw.source !== 'string' || !(SOURCES as readonly string[]).includes(raw.source)) return null
  if (typeof raw.bottleneck !== 'string' || !(BOTTLENECKS as readonly string[]).includes(raw.bottleneck)) return null
  const kernelBudget = parseKernelBudget(raw.kernelBudget)
  return {
    source: raw.source as PerformanceAnalysis['source'],
    bottleneck: raw.bottleneck as PerformanceAnalysis['bottleneck'],
    summary: text(raw.summary),
    op: parseOp(raw.op),
    achievedBandwidthGBps: numOrNull(raw.achievedBandwidthGBps),
    rooflineUs: numOrNull(raw.rooflineUs),
    baselineUs: numOrNull(raw.baselineUs),
    ...(Array.isArray(raw.notCollected) ? { notCollected: raw.notCollected.filter((item): item is string => typeof item === 'string') } : {}),
    ...(kernelBudget === undefined ? {} : { kernelBudget }),
    ...(typeof raw.csvDir === 'string' && raw.csvDir.trim() !== '' ? { csvDir: raw.csvDir.trim() } : {}),
  }
}
