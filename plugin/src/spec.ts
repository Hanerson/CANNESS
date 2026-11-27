export type FloatInputValue = number | 'nan' | '+inf' | '-inf'
type AttributeValue = number | boolean | string

export interface OperatorSupport {
  configurations?: { dtype?: string; attrs?: Record<string, AttributeValue> }[]
  min_align_bytes?: number
  /** Additional named parameters of a custom wrapper. */
  wrapper_attrs?: string[]
}

export interface TensorSpec {
  name: string
  shape: string[]
  dtype: string
  constraints?: Record<string, number | number[]>
  /** Replaces the first elements of a floating-point input's default test pattern. */
  input_values?: FloatInputValue[]
}

const NPU_ARCH = { ascend910b: 'dav-2201', ascend910_93: 'dav-2201', ascend950: 'dav-3510' } as const
export type ArchFamily = keyof typeof NPU_ARCH
export const TARGET_OPTIONS = 'ascend910b, ascend910_93 (A3, dav-2201), or ascend950 (dav-3510)'

export type TargetPlatform = {
  chip: string
  soc_version?: string
  cann_version?: string
  arch_family?: ArchFamily
  mode?: 'pinned' | 'portable'
  confirmation?: { confirmed: boolean; detectedSoc: string | null; approvalId?: string }
}

export type ResolvedTarget = {
  soc: string
  archFamily: ArchFamily
  npuArch: typeof NPU_ARCH[ArchFamily]
}

/** Base names such as Ascend910 do not distinguish A3 and 910B. */
export function resolveSoc(value: string | undefined): ResolvedTarget | null {
  if (value === undefined) return null
  const name = value.trim().toLowerCase().replace(/^ascend/, '')
  let archFamily: ArchFamily
  if (/^910b\d*$/.test(name)) archFamily = 'ascend910b'
  else if (/^(?:910_93\d*|a3|910c)$/.test(name)) archFamily = 'ascend910_93'
  else if (/^950(?:pr|dt)?(?:_\d+)?$/.test(name)) archFamily = 'ascend950'
  else return null
  const soc = /^(?:910b\d+|910_93\d+|950(?:pr|dt)?_\d+)$/.test(name) ? `Ascend${name.toUpperCase()}` : archFamily
  return { soc, archFamily, npuArch: NPU_ARCH[archFamily] }
}

export function declaredTarget(platform: TargetPlatform): ResolvedTarget | null {
  const part = resolveSoc(platform.soc_version)
  if (platform.soc_version !== undefined && part === null) return null
  const chip = resolveSoc(platform.chip)
  if (part && chip && part.soc === part.archFamily && chip.archFamily === part.archFamily) return chip
  return part ?? chip ?? resolveSoc(platform.arch_family)
}

function validateTargetDeclaration(platform: TargetPlatform): void {
  const part = resolveSoc(platform.soc_version)
  const family = resolveSoc(platform.arch_family)
  const chip = resolveSoc(platform.chip)
  if (platform.soc_version !== undefined && part === null) {
    throw new Error(`unknown target_platform.soc_version ${platform.soc_version}; expected ${TARGET_OPTIONS} or a full part name`)
  }
  const target = part ?? chip ?? family
  if (target && [part, chip, family].some(item => item && item.archFamily !== target.archFamily)) {
    throw new Error(`target_platform chip, arch_family, and soc_version disagree; expected ${TARGET_OPTIONS}`)
  }
  if (part && chip && part.soc !== part.archFamily && chip.soc !== chip.archFamily && part.soc !== chip.soc) {
    throw new Error('target_platform chip and soc_version name different SoC parts')
  }
}

export function compareTargetPlatform(platform: TargetPlatform, detectedSoc?: string) {
  const declared = declaredTarget(platform)
  const detected = resolveSoc(detectedSoc)
  const ok = detected !== null && (platform.mode === 'portable' || declared?.npuArch === detected.npuArch)
  const requiresConfirmation = (platform.mode === 'portable' || !declared || (detectedSoc !== undefined && (
    !detected || detected.archFamily !== declared.archFamily || (declared.soc !== declared.archFamily && detected.soc !== declared.soc)
  ))) && !(platform.confirmation?.confirmed && platform.confirmation.detectedSoc === (detectedSoc ?? null))
  const hint = `Use ${TARGET_OPTIONS}. Probe results are suggestions until the target is confirmed.`
  return { declared, detected, detectedSoc: detectedSoc ?? null, ok, requiresConfirmation, hint }
}

export interface OperatorSpec {
  operator_name: string
  operator_type: string
  input_specs: TensorSpec[]
  output_specs: TensorSpec[]
  target_platform: TargetPlatform
  performance_target: { metric: 'kernel_time'; target_us: number; reference?: string }
  tiling_hints: string | null
  /** Runtime operator attributes shared by the kernel and golden reference. */
  attrs?: Record<string, number | boolean | string>
  interface?: { attrs?: string[]; defaults?: Record<string, number | boolean | string>; dtypes?: string[] }
  /** Allowed runtime combinations of first-input dtype and operator attributes. */
  support?: OperatorSupport
  /** Numeric host transformations packed alongside the original attributes. */
  attrs_derived?: Record<string, { source: string; transform: 'log_positive_or_one' }>
  /** Index check accepts any correct argmax tie position. */
  accuracyMode?: 'elementwise' | 'index-check'
  /** Optional tolerances for floating-point outputs. Integer checks stay exact. */
  accuracy?: { absThreshold?: number; relThreshold?: number }
  /**
   * Optional launch geometry. The build contract used to hardcode blockDim=16,
   * which caps a kernel at 40% of the AIV cores on a 40-core device (measured
   * 1.96x for a 16 MiB ArgMax), so the spec may now ask for its own value.
   * `tile_length` is measured in elements. `workspace_bytes` appends scratch
   * to the tiling buffer.
   */
  launch?: { block_dim?: number; workspace_bytes?: number; tile_length?: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function needString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`missing ${path}`)
  return value
}

export function normalizedDtype(dtype: string): string {
  return dtype.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function canonicalDtype(dtype: string): string {
  const name = normalizedDtype(dtype)
  switch (name) {
    case 'fp16': case 'half': return 'float16'
    case 'fp32': case 'float': return 'float32'
    case 'bf16': return 'bfloat16'
    case 'i32': return 'int32'
    case 'i64': return 'int64'
    default: return name
  }
}

function parseSupport(value: unknown, spec: OperatorSpec): OperatorSupport {
  if (!isRecord(value) || Object.keys(value).some(key => !['configurations', 'min_align_bytes', 'wrapper_attrs'].includes(key))) {
    throw new Error('support accepts configurations, min_align_bytes, and wrapper_attrs')
  }
  const support: OperatorSupport = {}
  const wrapperAttrs = value.wrapper_attrs
  if (wrapperAttrs !== undefined) {
    if (!Array.isArray(wrapperAttrs) || wrapperAttrs.length < 1 || wrapperAttrs.length > 32
        || !wrapperAttrs.every(name => typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(name))
        || new Set(wrapperAttrs).size !== wrapperAttrs.length
        || wrapperAttrs.some(name => spec.input_specs.some(input => input.name === name))) {
      throw new Error('support.wrapper_attrs must contain up to 32 distinct non-tensor parameter names')
    }
    support.wrapper_attrs = wrapperAttrs
  }
  const alignment = value.min_align_bytes
  if (alignment !== undefined) {
    if (typeof alignment !== 'number' || !Number.isInteger(alignment) || alignment < 1 || alignment > 4096
        || (alignment & (alignment - 1)) !== 0) {
      throw new Error('support.min_align_bytes must be a power of two from 1 to 4096')
    }
    support.min_align_bytes = alignment
  }
  if (value.configurations !== undefined) {
    if (!Array.isArray(value.configurations) || value.configurations.length < 1 || value.configurations.length > 128) {
      throw new Error('support.configurations must contain 1 to 128 rows')
    }
    const availableDtypes = new Set((spec.interface?.dtypes ?? [spec.input_specs[0]!.dtype]).map(canonicalDtype))
    const customAttrs = new Set(support.wrapper_attrs)
    const publicAttrs = new Set([...(spec.interface?.attrs ?? Object.keys(spec.attrs ?? {})), ...customAttrs])
    support.configurations = value.configurations.map((row, index) => {
      const path = `support.configurations.${index}`
      if (!isRecord(row) || Object.keys(row).some(key => key !== 'dtype' && key !== 'attrs')) {
        throw new Error(`${path} must contain dtype and/or attrs`)
      }
      const result: NonNullable<OperatorSupport['configurations']>[number] = {}
      if (row.dtype !== undefined) {
        if (typeof row.dtype !== 'string' || !availableDtypes.has(canonicalDtype(row.dtype))) {
          throw new Error(`${path}.dtype must match an exported input dtype`)
        }
        result.dtype = canonicalDtype(row.dtype)
      }
      if (row.attrs !== undefined) {
        if (!isRecord(row.attrs) || !Object.keys(row.attrs).length) throw new Error(`${path}.attrs must be a nonempty object`)
        result.attrs = Object.fromEntries(Object.entries(row.attrs).map(([name, attr]) => {
          const declared = spec.attrs?.[name]
          if ((declared === undefined ? !customAttrs.has(name) || !['string', 'number', 'boolean'].includes(typeof attr)
            : typeof attr !== typeof declared)
              || (typeof attr === 'number' && !Number.isFinite(attr))) {
            throw new Error(`${path}.attrs.${name} must match a declared attr type`)
          }
          if (!publicAttrs.has(name) && attr !== declared) {
            throw new Error(`${path}.attrs.${name} is fixed by the export interface`)
          }
          return [name, attr as AttributeValue]
        }))
      }
      if (result.dtype === undefined && result.attrs === undefined) throw new Error(`${path} cannot be empty`)
      return result
    })
  }
  if (support.min_align_bytes === undefined && support.configurations === undefined) throw new Error('support cannot be empty')
  return support
}

function floatingSampleLimit(dtype: string): number | undefined {
  switch (normalizedDtype(dtype)) {
    case 'float16': case 'fp16': case 'half': return 65504
    case 'bfloat16': case 'bf16': return (2 - 2 ** -7) * 2 ** 127
    case 'float32': case 'fp32': case 'float': return (2 - 2 ** -23) * 2 ** 127
  }
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
  if (value.input_values !== undefined) {
    const field = `${path}.input_values`
    const limit = floatingSampleLimit(tensor.dtype)
    if (!path.startsWith('input_specs.') || limit === undefined) {
      throw new Error(`${field} requires a floating-point input tensor`)
    }
    if (!Array.isArray(value.input_values)) throw new Error(`${field} must be an array`)
    const values = value.input_values.map((item: unknown, index): FloatInputValue => {
      if (item === 'nan' || item === '+inf' || item === '-inf') return item
      if (typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= limit) return item
      throw new Error(`${field}.${index} must be a finite value within the dtype range, nan, +inf or -inf`)
    })
    if (allLiteral && values.length > literalElements) throw new Error(`${field} exceeds the tensor element count`)
    tensor.input_values = values
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
  if (platform.arch_family !== undefined) {
    if (typeof platform.arch_family !== 'string' || !Object.hasOwn(NPU_ARCH, platform.arch_family)) {
      throw new Error(`target_platform.arch_family must be ${TARGET_OPTIONS}`)
    }
    spec.target_platform.arch_family = platform.arch_family as ArchFamily
  }
  if (platform.mode !== undefined) {
    if (platform.mode !== 'pinned' && platform.mode !== 'portable') throw new Error('target_platform.mode must be pinned or portable')
    spec.target_platform.mode = platform.mode
  }
  if (platform.soc_version !== undefined && typeof platform.soc_version !== 'string') {
    throw new Error('target_platform.soc_version must be a SoC name')
  }
  validateTargetDeclaration(spec.target_platform)
  if (typeof perf.reference === 'string') spec.performance_target.reference = perf.reference
  if (raw.attrs !== undefined) {
    if (!isRecord(raw.attrs)) throw new Error('attrs must be an object')
    const attrs: Array<[string, number | boolean | string]> = []
    for (const [name, value] of Object.entries(raw.attrs)) {
      if (name.length === 0 || !(
        typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )) throw new Error(`attrs.${name} must be a finite number, boolean or string`)
      attrs.push([name, value])
    }
    spec.attrs = Object.fromEntries(attrs)
  }
  if (raw.interface !== undefined) {
    if (!isRecord(raw.interface)) throw new Error('interface must be an object')
    const { defaults, dtypes, attrs } = raw.interface
    spec.interface = {}
    if (attrs !== undefined) {
      if (!Array.isArray(attrs) || !attrs.every(name => typeof name === 'string' && Object.hasOwn(spec.attrs ?? {}, name))
          || new Set(attrs).size !== attrs.length) throw new Error('interface.attrs must be unique declared attribute names')
      spec.interface.attrs = attrs
    }
    if (defaults !== undefined) {
      if (!isRecord(defaults)) throw new Error('interface.defaults must be an object')
      for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(spec.attrs ?? {}, key) || typeof value !== typeof spec.attrs?.[key]
            || (typeof value === 'number' && !Number.isFinite(value))) {
          throw new Error(`interface.defaults.${key} must match a declared attr type`)
        }
      }
      spec.interface.defaults = defaults as NonNullable<OperatorSpec['interface']>['defaults']
    }
    if (dtypes !== undefined) {
      if (!Array.isArray(dtypes) || dtypes.length === 0 || !dtypes.every(dtype => typeof dtype === 'string' && dtype.trim())) {
        throw new Error('interface.dtypes must be a nonempty list of dtypes')
      }
      spec.interface.dtypes = dtypes
    }
  }
  if (raw.support !== undefined) spec.support = parseSupport(raw.support, spec)
  if (raw.attrs_derived !== undefined) {
    if (!isRecord(raw.attrs_derived)) throw new Error('attrs_derived must be an object')
    spec.attrs_derived = Object.fromEntries(Object.entries(raw.attrs_derived).map(([name, rule]) => {
      if (!name || Object.hasOwn(spec.attrs ?? {}, name) || !isRecord(rule)
          || rule.transform !== 'log_positive_or_one' || typeof rule.source !== 'string'
          || !Object.hasOwn(spec.attrs ?? {}, rule.source) || typeof spec.attrs?.[rule.source] !== 'number') {
        throw new Error(`invalid derived attribute ${name}`)
      }
      return [name, { source: rule.source, transform: rule.transform }]
    }))
  }
  if (raw.accuracyMode !== undefined) {
    if (raw.accuracyMode !== 'elementwise' && raw.accuracyMode !== 'index-check') {
      throw new Error('accuracyMode must be elementwise or index-check')
    }
    spec.accuracyMode = raw.accuracyMode
  }
  if (raw.accuracy !== undefined) {
    if (!isRecord(raw.accuracy)) throw new Error('accuracy must be an object')
    spec.accuracy = {}
    for (const key of ['absThreshold', 'relThreshold'] as const) {
      const value = raw.accuracy[key]
      if (value === undefined) continue
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`accuracy.${key} must be finite and nonnegative`)
      }
      spec.accuracy[key] = value
    }
  }
  const launch = isRecord(raw.launch) ? raw.launch : undefined
  const requestedBlockDim = launch?.block_dim
  const requestedWorkspace = launch?.workspace_bytes
  const requestedTileLength = launch?.tile_length
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
  if (requestedTileLength !== undefined) {
    if (typeof requestedTileLength !== 'number' || !Number.isInteger(requestedTileLength) ||
        requestedTileLength < 1 || requestedTileLength > 0xffff_ffff) {
      throw new Error('launch.tile_length must be an integer in 1..4294967295')
    }
  }
  if (requestedBlockDim !== undefined || requestedWorkspace !== undefined || requestedTileLength !== undefined) {
    spec.launch = {}
    if (requestedBlockDim !== undefined) spec.launch.block_dim = requestedBlockDim
    if (requestedWorkspace !== undefined) spec.launch.workspace_bytes = requestedWorkspace
    if (requestedTileLength !== undefined) spec.launch.tile_length = requestedTileLength
  }
  return spec
}
