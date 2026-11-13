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
  /** Operator attributes are passed through to the golden reference. */
  attrs?: Record<string, number | boolean | string>
  /** Index check accepts any correct argmax tie position. */
  accuracyMode?: 'elementwise' | 'index-check'
  /**
   * Optional launch geometry. The build contract used to hardcode blockDim=16,
   * which caps a kernel at 40% of the AIV cores on a 40-core device (measured
   * 1.96x for a 16 MiB ArgMax), so the spec may now ask for its own value.
   * `workspace_bytes` appends scratch to the tiling buffer (issue 013).
   */
  launch?: { block_dim?: number; workspace_bytes?: number }
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
  let literalElements = 1
  let allLiteral = true
  for (const dimension of shape) {
    if (dimension.trim() === '' ||
        /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(dimension.trim()) && !/^\d+$/.test(dimension.trim())) {
      throw new Error(`${path}.shape must contain positive dimensions or nonempty symbols`)
    }
    if (!/^\d+$/.test(dimension.trim())) { allLiteral = false; continue }
    const size = Number(dimension)
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${path}.shape must contain positive safe dimensions`)
    literalElements *= size
  }
  if (allLiteral && !Number.isSafeInteger(literalElements)) {
    throw new Error(`${path}.shape element count exceeds safe integer range`)
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
  if (raw.attrs !== undefined) {
    if (!isRecord(raw.attrs)) throw new Error('attrs must be an object')
    const attrs: Record<string, number | boolean | string> = {}
    for (const [name, value] of Object.entries(raw.attrs)) {
      if (name.length === 0 || !(
        typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )) throw new Error(`attrs.${name} must be a finite number, boolean or string`)
      attrs[name] = value
    }
    spec.attrs = attrs
  }
  if (raw.accuracyMode !== undefined) {
    if (raw.accuracyMode !== 'elementwise' && raw.accuracyMode !== 'index-check') {
      throw new Error('accuracyMode must be elementwise or index-check')
    }
    spec.accuracyMode = raw.accuracyMode
  }
  // Optional launch geometry: a positive integer block_dim, clamped to the AIV
  // block count the launch API accepts, plus optional scratch bytes.
  const launch = isRecord(raw.launch) ? raw.launch : undefined
  const requestedBlockDim = launch?.block_dim
  const requestedWorkspace = launch?.workspace_bytes
  if (requestedBlockDim !== undefined) {
    if (typeof requestedBlockDim !== 'number' || !Number.isInteger(requestedBlockDim) ||
        requestedBlockDim < 1 || requestedBlockDim > 128) {
      throw new Error('launch.block_dim must be an integer in 1..128')
    }
  }
  if (requestedWorkspace !== undefined) {
    if (typeof requestedWorkspace !== 'number' || !Number.isInteger(requestedWorkspace) ||
        requestedWorkspace < 0 || requestedWorkspace > 1024 * 1024 * 1024) {
      throw new Error('launch.workspace_bytes must be an integer in 0..1 GiB')
    }
  }
  if (requestedBlockDim !== undefined || requestedWorkspace !== undefined) {
    spec.launch = {}
    if (requestedBlockDim !== undefined) spec.launch.block_dim = requestedBlockDim
    if (requestedWorkspace !== undefined) spec.launch.workspace_bytes = requestedWorkspace
  }
  return spec
}
