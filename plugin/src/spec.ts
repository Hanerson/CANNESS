export interface TensorSpec {
  name: string
  shape: string[]
  dtype: string
  constraints?: Record<string, number | number[]>
}

export interface OperatorSpec {
  operator_name: string
  operator_type: string
  input_specs: TensorSpec[]
  output_specs: TensorSpec[]
  target_platform: { chip: string; soc_version?: string; cann_version?: string }
  performance_target: { metric: 'kernel_time'; target_us: number; reference?: string }
  tiling_hints: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function needString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`missing ${path}`)
  return value
}

function needTensor(value: unknown, path: string): TensorSpec {
  if (!isRecord(value)) throw new Error(`missing ${path}`)
  const shape = value.shape
  if (!Array.isArray(shape) || shape.some(item => typeof item !== 'string')) {
    throw new Error(`missing ${path}.shape`)
  }
  const tensor: TensorSpec = {
    name: needString(value.name, `${path}.name`),
    shape,
    dtype: needString(value.dtype, `${path}.dtype`),
  }
  if (value.constraints !== undefined) {
    if (!isRecord(value.constraints)) throw new Error(`missing ${path}.constraints`)
    tensor.constraints = value.constraints as TensorSpec['constraints']
  }
  return tensor
}

function needTensors(value: unknown, path: string): TensorSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`missing ${path}`)
  return value.map((item, index) => needTensor(item, `${path}.${index}`))
}

export function parseSpec(raw: unknown): OperatorSpec {
  if (!isRecord(raw)) throw new Error('missing operator_name')
  const platform = isRecord(raw.target_platform) ? raw.target_platform : {}
  const perf = isRecord(raw.performance_target) ? raw.performance_target : {}
  if (perf.metric !== 'kernel_time') throw new Error('missing performance_target.metric')
  if (typeof perf.target_us !== 'number' || !Number.isFinite(perf.target_us) || perf.target_us <= 0) {
    throw new Error('missing performance_target.target_us')
  }
  const spec: OperatorSpec = {
    operator_name: needString(raw.operator_name, 'operator_name'),
    operator_type: needString(raw.operator_type, 'operator_type'),
    input_specs: needTensors(raw.input_specs, 'input_specs'),
    output_specs: needTensors(raw.output_specs, 'output_specs'),
    target_platform: { chip: needString(platform.chip, 'target_platform.chip') },
    performance_target: { metric: 'kernel_time', target_us: perf.target_us },
    tiling_hints: raw.tiling_hints == null ? null : needString(raw.tiling_hints, 'tiling_hints'),
  }
  if (typeof platform.soc_version === 'string') spec.target_platform.soc_version = platform.soc_version
  if (typeof platform.cann_version === 'string') spec.target_platform.cann_version = platform.cann_version
  if (typeof perf.reference === 'string') spec.performance_target.reference = perf.reference
  return spec
}
