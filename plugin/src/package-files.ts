import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OperatorSpec, TensorSpec } from './spec.js'

export const LAYER_FILES = {
  kernel: 'op_kernel/kernel.cpp',
  host: 'op_host/host.cpp',
  api: 'op_api/api.cpp',
  plugin: 'op_plugin/plugin.py',
} as const

export type LayerName = keyof typeof LAYER_FILES

/** Build contract v1 files rendered into every test package. */
export const CONTRACT_FILES = ['build.sh', 'run_once.sh', 'main.cpp', 'golden.h', 'canness_tiling.h'] as const

/**
 * Kernel entry the build-contract `main.cpp` launches. It is fixed because the
 * host driver is operator-independent: it knows how many tensors exist, not
 * what the operator is called.
 */
export const KERNEL_ENTRY = 'canness_kernel'

/** Verdict of {@link checkKernelEntry}. */
export type KernelEntryCheck = { ok: true } | { ok: false; reason: string }

const ENTRY_PATTERN = /\bvoid\s+([A-Za-z_]\w*)\s*\(([^()]*)\)/g

/**
 * Check that `op_kernel/kernel.cpp` defines the entry the contract launches.
 *
 * A kernel written as `void gelu(GM_ADDR x, GM_ADDR y, GM_ADDR workspace,
 * GM_ADDR tiling)` links to nothing — `main.o` calls `canness_kernel`, so the
 * link fails with an undefined symbol that says nothing about the real cause.
 * Catching it here turns that into an actionable message before the package is
 * ever uploaded.
 * @param kernelBody - the `op_kernel/kernel.cpp` text.
 * @returns whether the contract entry is present with the expected shape.
 */
export function checkKernelEntry(kernelBody: string): KernelEntryCheck {
  const definitions: Array<{ name: string; params: string }> = []
  for (const match of kernelBody.matchAll(ENTRY_PATTERN)) {
    definitions.push({ name: match[1] ?? '', params: match[2] ?? '' })
  }
  const entry = definitions.find(item => item.name === KERNEL_ENTRY)
  if (entry === undefined) {
    const names = definitions.map(item => item.name).filter(name => name.length > 0)
    const found = names.length === 0 ? 'none' : names.join(', ')
    return {
      ok: false,
      reason: `op_kernel/kernel.cpp must define "void ${KERNEL_ENTRY}(<inputs>, <outputs>, GM_ADDR tiling)"; `
        + `the build-contract main.cpp launches that exact entry, so another name (found: ${found}) fails to link`,
    }
  }
  const params = entry.params.split(',').map(part => part.trim()).filter(part => part.length > 0)
  if (params.some(part => /\bworkspace\b/.test(part))) {
    return {
      ok: false,
      reason: `void ${KERNEL_ENTRY}(...) must not take a workspace parameter; `
        + 'the build contract passes the inputs, the outputs and the tiling pointer, nothing else',
    }
  }
  const last = params[params.length - 1] ?? ''
  if (!/\btiling\b/.test(last)) {
    return {
      ok: false,
      reason: `void ${KERNEL_ENTRY}(...) must end with the tiling pointer (GM_ADDR tiling), got "${last}" instead`,
    }
  }
  return { ok: true }
}

const TEMPLATE_RELATIVE = 'templates/build-contract'
const DEFAULT_SOC_VERSION = 'Ascend910B2'
const DEFAULT_TOTAL_ELEMENTS = 32768
const DEFAULT_BLOCK_DIM = 16
const DEFAULT_TILE_LENGTH = 1024
const AGNOSTIC_THRESHOLD = 1e-3

function writeRel(root: string, rel: string, body: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body)
}

export function writeOperator(workspace: string, generationId: string, files: Record<LayerName, string>): string {
  const root = join(workspace, 'operators', generationId)
  for (const key of Object.keys(LAYER_FILES) as LayerName[]) writeRel(root, LAYER_FILES[key], files[key])
  return root
}

/** Resolve the template directory from `lib/` first, then the `src/` test layout. */
export function buildContractTemplateDir(): string {
  const fromLib = fileURLToPath(new URL(`../../${TEMPLATE_RELATIVE}/`, import.meta.url))
  if (existsSync(fromLib)) return fromLib
  return fileURLToPath(new URL(`../${TEMPLATE_RELATIVE}/`, import.meta.url))
}

function normalizedDtype(dtype: string): string {
  return dtype.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Absolute-error budget derived from the tensor dtype, not guessed by the
 * runner. fp16 2^-10, bf16 2^-7, fp32 2^-13; unknown dtypes keep the historical
 * 1e-3 fallback.
 */
export function maxAbsErrForDtype(dtype: string): number {
  const name = normalizedDtype(dtype)
  if (name === 'float16' || name === 'fp16' || name === 'half') return 2 ** -10
  if (name === 'bfloat16' || name === 'bf16') return 2 ** -7
  if (name === 'float32' || name === 'fp32' || name === 'float') return 2 ** -13
  return AGNOSTIC_THRESHOLD
}

interface CppDtype {
  cpp: string
  enumerator: string
}

function cppDtype(dtype: string): CppDtype {
  const name = normalizedDtype(dtype)
  if (name === 'float16' || name === 'fp16' || name === 'half') return { cpp: 'half', enumerator: 'DType::F16' }
  if (name === 'bfloat16' || name === 'bf16') return { cpp: 'bfloat16_t', enumerator: 'DType::BF16' }
  return { cpp: 'float', enumerator: 'DType::F32' }
}

/** Numeric element count when every dimension is a literal; null otherwise. */
function numericElementCount(tensor: TensorSpec): number | null {
  let total = 1
  for (const dimension of tensor.shape) {
    if (!/^\d+$/.test(dimension.trim())) return null
    const value = Number(dimension)
    if (!Number.isSafeInteger(value) || value <= 0) return null
    total *= value
    if (!Number.isSafeInteger(total)) return null
  }
  return total
}

/** Symbolic shapes fall back to the Gelu-sized 32768-element buffer. */
function elementCount(tensor: TensorSpec): number {
  return numericElementCount(tensor) ?? DEFAULT_TOTAL_ELEMENTS
}

function safeCommentName(value: string): string {
  return value.replace(/[^\w .-]/g, '_')
}

function socVersion(spec: OperatorSpec): string {
  const value = spec.target_platform.soc_version
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) ? value : DEFAULT_SOC_VERSION
}

function renderTemplate(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    if (!(key in values)) throw new Error(`build contract template uses unknown placeholder ${match}`)
    return values[key]
  })
}

function templateBody(name: string): string {
  return readFileSync(join(buildContractTemplateDir(), name), 'utf8')
}

/** Recursively list regular files, POSIX-style and sorted. */
function listFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stats = statSync(full)
      if (stats.isDirectory()) {
        walk(full)
        continue
      }
      if (stats.isFile()) files.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

/**
 * Render the operator-independent build contract for one spec.
 *
 * `main.cpp` is generated per spec because tensor count and dtype are known
 * here; `build.sh`, `run_once.sh`, `golden.h` and the tiling shim only take
 * scalar substitutions.
 */
export function renderBuildContract(spec: OperatorSpec, goldenOverride?: string): Record<string, string> {
  const inputs = spec.input_specs
  const outputs = spec.output_specs
  const firstInput = inputs[0]!
  const firstOutput = outputs[0]!
  const reference = firstInput ?? firstOutput
  const totalElements = elementCount(reference)
  const blockDim = DEFAULT_BLOCK_DIM
  const blockLength = Math.max(1, Math.ceil(totalElements / blockDim))
  const tileLength = Math.min(DEFAULT_TILE_LENGTH, totalElements)
  const threshold = maxAbsErrForDtype(firstOutput.dtype || firstInput.dtype)
  const operatorName = safeCommentName(spec.operator_name)
  const operatorString = spec.operator_name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

  const tensorSetup = [
    ...inputs.map((tensor, index) => `Tensor in${index} = make_tensor(${cppDtype(tensor.dtype).enumerator}, ${elementCount(tensor)}, true);`),
    ...outputs.map((tensor, index) => `Tensor out${index} = make_tensor(${cppDtype(tensor.dtype).enumerator}, ${elementCount(tensor)}, false);`),
  ].join('\n    ')
  const inputList = `{ ${inputs.map((_tensor, index) => `&in${index}`).join(', ')} }`
  const outputList = `{ ${outputs.map((_tensor, index) => `&out${index}`).join(', ')} }`
  const kernelArgsDecl = [
    ...inputs.map((_tensor, index) => `GM_ADDR in${index}`),
    ...outputs.map((_tensor, index) => `GM_ADDR out${index}`),
    'GM_ADDR tiling',
  ].join(', ')
  const kernelArgsCall = [
    ...inputs.map((_tensor, index) => `static_cast<GM_ADDR>(in${index}.device)`),
    ...outputs.map((_tensor, index) => `static_cast<GM_ADDR>(out${index}.device)`),
    'static_cast<GM_ADDR>(tiling_device)',
  ].join(', ')

  const values: Record<string, string> = {
    SOC_VERSION: socVersion(spec),
    DTYPE_X: cppDtype(firstInput.dtype).cpp,
    DTYPE_Y: cppDtype(firstOutput.dtype).cpp,
    OPERATOR_NAME: operatorName,
    OPERATOR_STRING: operatorString,
    INPUT_COUNT: String(inputs.length),
    OUTPUT_COUNT: String(outputs.length),
    TOTAL_ELEMENTS: String(totalElements),
    BLOCK_DIM: String(blockDim),
    BLOCK_LENGTH: String(blockLength),
    TILE_LENGTH: String(tileLength),
    MAX_ABS_ERR: String(threshold),
    TENSOR_SETUP: tensorSetup,
    INPUT_LIST: inputList,
    OUTPUT_LIST: outputList,
    KERNEL_ARGS_DECL: kernelArgsDecl,
    KERNEL_ARGS_CALL: kernelArgsCall,
  }

  return {
    'build.sh': renderTemplate(templateBody('build.sh'), values),
    'run_once.sh': renderTemplate(templateBody('run_once.sh'), values),
    'main.cpp': renderTemplate(templateBody('main.cpp'), values),
    'golden.h': goldenOverride ?? renderTemplate(templateBody('golden.h'), values),
    'canness_tiling.h': renderTemplate(templateBody('canness_tiling.h'), values),
  }
}

export function buildTestPackage(workspace: string, generationId: string, spec: OperatorSpec): string {
  const src = join(workspace, 'operators', generationId)
  const dest = join(workspace, 'packages', generationId)
  // Check the kernel entry before touching the package: a mismatched name only
  // fails later as an undefined symbol at link time, which reads like a
  // toolchain problem instead of a contract problem.
  const entry = checkKernelEntry(readFileSync(join(src, 'op_kernel/kernel.cpp'), 'utf8'))
  if (!entry.ok) throw new Error(entry.reason)
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(src, dest, { recursive: true })

  // write_package_file('golden.h', ...) writes the operator copy; it is the
  // model's only extension point and wins over the placeholder template.
  const goldenPath = join(src, 'golden.h')
  const goldenOverride = existsSync(goldenPath) ? readFileSync(goldenPath, 'utf8') : undefined
  for (const [name, body] of Object.entries(renderBuildContract(spec, goldenOverride))) {
    writeFileSync(join(dest, name), body)
  }

  const threshold = maxAbsErrForDtype(spec.output_specs[0]?.dtype ?? spec.input_specs[0]!.dtype)
  const totalElements = elementCount(spec.input_specs[0] ?? spec.output_specs[0]!)
  const blockDim = DEFAULT_BLOCK_DIM
  const tileSize = Math.min(DEFAULT_TILE_LENGTH, totalElements)
  const config = {
    maxAbsErr: threshold,
    dtype: spec.output_specs[0]?.dtype ?? spec.input_specs[0]!.dtype,
    socVersion: socVersion(spec),
    blockDim,
    tileSize,
    params: {
      blockDim,
      tileSize,
      blockLength: Math.max(1, Math.ceil(totalElements / blockDim)),
      totalElements,
    },
  }
  writeFileSync(join(dest, 'config.json'), JSON.stringify(config, null, 2))

  const files = [...listFiles(dest), 'manifest.json'].sort()
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify({
    generationId,
    operatorName: spec.operator_name,
    performanceTargetUs: spec.performance_target.target_us,
    buildContract: 'v1',
    layers: Object.values(LAYER_FILES),
    files,
  }, null, 2))
  return dest
}
