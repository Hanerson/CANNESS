import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchGeometry, LAYER_FILES, packageHash, renderBuildContract } from './package-files.js'
import { sha256 } from './provenance.js'
import { normalizedDtype, type OperatorSpec } from './spec.js'

const TEMPLATE = fileURLToPath(new URL('../templates/cannbench/', import.meta.url))
const MAX_ARCHIVE_BYTES = 50_000_000
const PYTHON_RESERVED = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '))
const DTYPES: Record<string, string> = {
  float32: 'float32', float: 'float32', fp32: 'float32',
  float16: 'float16', fp16: 'float16', half: 'float16',
  bfloat16: 'bfloat16', bf16: 'bfloat16', int32: 'int32', i32: 'int32', int64: 'int64', i64: 'int64',
}

function publicIdentifier(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(value) && !PYTHON_RESERVED.has(value)
}

function render(name: string, values: Record<string, string>): string {
  return readFileSync(join(TEMPLATE, name), 'utf8').replace(/\r\n/g, '\n')
    .replace(/\{\{([A-Z0-9_]+)\}\}/g, (token, key: string) => {
      const value = values[key]
      if (value === undefined) throw new Error(`unbound CANNBench template token ${token}`)
      return value
    })
}

function cppBytes(value: string): string {
  return '"' + [...Buffer.from(value)].map(byte => '\\' + byte.toString(8).padStart(3, '0')).join('') + '"'
}

function pythonValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0.0'
    const literal = String(value)
    return /^[+-]?\d+$/.test(literal) ? literal + '.0' : literal
  }
  return JSON.stringify(value)
}

function submissionValues(spec: OperatorSpec, callable: string, socVersion: string): Record<string, string> {
  if (!publicIdentifier(callable)) throw new Error('callable must be a public Python identifier')
  const inputNames = spec.input_specs.map(tensor => tensor.name)
  const attrs = Object.entries(spec.attrs ?? {})
  const names = [...inputNames, ...attrs.map(([key]) => key)]
  if (new Set(names).size !== names.length || !names.every(publicIdentifier)) {
    throw new Error('CANNBench input and attribute names must be distinct public Python identifiers')
  }
  // Shape-changing kernels need a task-specific output/geometry adapter.
  const shape = spec.input_specs[0]!.shape
  const tensors = [...spec.input_specs, ...spec.output_specs]
  if (tensors.some(tensor => JSON.stringify(tensor.shape) !== JSON.stringify(shape))) {
    throw new Error('automatic CANNBench export currently supports same-shape inputs and outputs')
  }
  if (!/^[A-Za-z0-9._-]+$/.test(socVersion)) throw new Error('invalid CANNBench SoC')
  const dtype = tensors.map(tensor => {
    const type = DTYPES[normalizedDtype(tensor.dtype)]
    if (type === undefined) throw new Error(`unsupported CANNBench dtype: ${tensor.dtype}`)
    return `_torch.${type}`
  })
  const tensorPtrs = tensors.map((_tensor, index) => `tensor${index}`)
  const geometry = launchGeometry(spec)
  const params: string[] = []
  const rows: string[] = []
  const pyTypes: string[] = []
  const pySetup: string[] = []
  const pyArgs: string[] = []
  const pyParams: string[] = []
  const stringSizes: string[] = []
  let capacity = Math.ceil((24 + geometry.workspaceBytes) / 64) * 64 + 8 + 48 * attrs.length
  for (const [index, [name, value]] of attrs.entries()) {
    const arg = `attr${index}`
    const length = Buffer.byteLength(name)
    const key = cppBytes(name)
    const defaults = spec.interface?.defaults ?? {}
    const defaultValue = Object.hasOwn(defaults, name) ? defaults[name] : undefined
    pyParams.push(defaultValue === undefined ? name : `${name}=${pythonValue(defaultValue)}`)
    capacity += length + 1
    if (typeof value === 'string') {
      params.push(`const char* ${arg}, uint32_t ${arg}Length`)
      rows.push(`{${key}, GoldenAttrType::String, 0.0, false, ${arg}, ${length}, ${arg}Length}`)
      pyTypes.push('_ct.c_char_p', '_ct.c_uint32')
      pySetup.push(`_${arg} = ${name}.encode("utf-8")`)
      pyArgs.push(`_${arg}`, `_builtins.len(_${arg})`)
      stringSizes.push(`_builtins.len(_${arg}) + 1`)
    } else if (typeof value === 'boolean') {
      params.push(`bool ${arg}`)
      rows.push(`{${key}, GoldenAttrType::Boolean, 0.0, ${arg}, nullptr, ${length}}`)
      pyTypes.push('_ct.c_bool')
      pyArgs.push(name)
    } else {
      params.push(`double ${arg}`)
      rows.push(`{${key}, GoldenAttrType::Number, ${arg}, false, nullptr, ${length}}`)
      pyTypes.push('_ct.c_double')
      pyArgs.push(name)
    }
  }
  for (const [name, rule] of Object.entries(spec.attrs_derived ?? {})) {
    const source = attrs.findIndex(([key]) => key === rule.source)
    if (source === -1 || typeof attrs[source]?.[1] !== 'number') throw new Error(`invalid derived attr ${name}`)
    const argument = `attr${source}`
    const length = Buffer.byteLength(name)
    capacity += 48 + length + 1
    rows.push(`{${cppBytes(name)}, GoldenAttrType::Number, ${argument} > 0 ? std::log(${argument}) : 1.0, false, nullptr, ${length}}`)
  }
  const argumentTail = (items: string[]) => items.length ? ', ' + items.join(', ') : ''
  const signature = [...inputNames, ...pyParams].join(', ')
  // Python requires all mandatory positional attributes to precede defaults.
  let optional = false
  for (const [name] of attrs) {
    if (Object.hasOwn(spec.interface?.defaults ?? {}, name)) optional = true
    else if (optional) throw new Error('required interface attributes must precede attributes with defaults')
  }
  return {
    SOC_VERSION: socVersion,
    OPERATOR: callable,
    PY_OPERATOR: JSON.stringify(callable),
    PY_PARAMS: signature,
    PY_INPUTS: inputNames.join(', '),
    PY_DTYPES: dtype.slice(0, inputNames.length).join(', '),
    PY_OUTPUTS: dtype.slice(inputNames.length).map(type =>
      `_torch.empty(_first.shape, dtype=${type}, device=_first.device)`).join(', '),
    PY_RETURN: spec.output_specs.length === 1 ? '_outputs[0]' : '_outputs',
    PY_ARGTYPES: [...tensorPtrs.map(() => '_ct.c_void_p'), '_ct.c_uint32', '_ct.c_void_p',
      '_ct.c_void_p', '_ct.c_uint64', ...pyTypes].join(', '),
    PY_ATTR_SETUP: pySetup.join('\n            '),
    PY_ATTR_BYTES: stringSizes.map(size => ' + ' + size).join(''),
    PY_ATTR_ARGS: argumentTail(pyArgs),
    TILING_CAPACITY: String(capacity),
    TENSOR_PTRS: tensorPtrs.map(ptr => `void* ${ptr}`).join(', '),
    KERNEL_ARGS_DECL: [...tensorPtrs, 'tiling'].map(ptr => `CANNESS_GM_ADDR ${ptr}`).join(', '),
    KERNEL_ARGS_CALL: [...tensorPtrs, 'tilingDevice'].map(ptr => `(CANNESS_GM_ADDR)${ptr}`).join(', '),
    BLOCK_DIM: String(geometry.blockDim),
    TILE_LENGTH: spec.launch?.tile_length === undefined
      ? 'std::min<uint32_t>(total, 1024)' : String(geometry.tileSize),
    WORKSPACE_BYTES: String(geometry.workspaceBytes),
    ATTR_COUNT: String(rows.length),
    ATTR_PARAMS: argumentTail(params),
    ATTR_ROWS: rows.length ? rows.join(',\n        ') : '{}',
  }
}

export function exportSubmission(workspace: string, generationId: string, spec: OperatorSpec, callable?: string) {
  if (!/^gen-[a-f0-9]{8}$/i.test(generationId)) throw new Error('invalid generation ID')
  const pkg = join(workspace, 'packages', generationId)
  const manifestPath = join(pkg, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error('build_test_package first')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const hash = packageHash(pkg)
  if (manifest.packageHash !== hash) throw new Error('package changed after build_test_package; rebuild the package before export')
  const filename = callable ?? spec.operator_name
  const config = JSON.parse(readFileSync(join(pkg, 'config.json'), 'utf8'))
  const values = submissionValues(spec, filename, config.socVersion)
  const tensors = [...spec.input_specs, ...spec.output_specs]
  const dtype = (name: string) => {
    const result = DTYPES[normalizedDtype(name)]
    if (result === undefined) throw new Error(`unsupported CANNBench dtype: ${name}`)
    return result
  }
  const variants = spec.interface?.dtypes?.map(dtype)
  if (variants && (new Set(variants).size !== variants.length
      || !variants.includes(dtype(tensors[0]!.dtype))
      || tensors.some(tensor => dtype(tensor.dtype) !== dtype(tensors[0]!.dtype)))) {
    throw new Error('interface.dtypes requires uniform tensor dtypes, unique variants, and the test dtype')
  }
  const names = variants ?? ['default']
  values.VARIANTS = names.join(' ')
  values.PY_VARIANTS = variants
    ? variants.map(name => `_torch.${name}: "${name}"`).join(', ')
    : `${values.PY_DTYPES?.split(', ')[0]}: "default"`
  if (variants) {
    values.PY_DTYPES = spec.input_specs.map(() => '_first.dtype').join(', ')
    values.PY_OUTPUTS = spec.output_specs.map(() =>
      '_torch.empty(_first.shape, dtype=_first.dtype, device=_first.device)').join(', ')
  }
  const signature = `${filename}(${values.PY_PARAMS})`
  const root = join(workspace, 'submissions')
  mkdirSync(root, { recursive: true })
  const staging = mkdtempSync(join(root, `${generationId}-`))
  try {
    const sourceDir = join(staging, 'source')
    const files: Record<string, Buffer | string> = {
      'build.sh': render('build.sh', values),
      'setup.py': render('setup.py', values),
      'cann_bench/__init__.py': render('operator.py', values),
      'csrc/launch.cpp': render('launch.cpp', values),
    }
    for (const name of [LAYER_FILES.kernel, 'canness_tiling.h', 'canness_tiling_common.h', 'canness_tiling_host.h']) {
      const path = join(pkg, name)
      if (!existsSync(path)) throw new Error(`missing ${name}; rebuild the package before export`)
      files[`csrc/${name}`] = readFileSync(path)
    }
    for (const name of variants ?? []) {
      const variantSpec = { ...spec,
        input_specs: spec.input_specs.map(tensor => ({ ...tensor, dtype: name, input_values: undefined })),
        output_specs: spec.output_specs.map(tensor => ({ ...tensor, dtype: name })),
      }
      files[`csrc/${name}/canness_tiling.h`] = renderBuildContract(variantSpec)['canness_tiling.h']!
    }
    const fileHashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)]))
    files['provenance.json'] = JSON.stringify({
      generationId, packageHash: hash, callable: filename, signature, dtypes: variants ?? tensors.map(tensor => tensor.dtype),
      bindings: 'CANNESS-generated direct launch', files: fileHashes, layers: manifest.provenance ?? null,
    }, null, 2)
    for (const [name, content] of Object.entries(files)) {
      const target = join(sourceDir, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
    // bsdtar is bundled with Windows. Common Unix zip installations use zip(1).
    const archivePath = join(staging, 'cannbench.zip')
    const archive = process.platform === 'win32'
      ? spawnSync('tar.exe', ['-a', '-cf', archivePath, '-C', sourceDir, ...Object.keys(files)], { encoding: 'utf8' })
      : spawnSync('zip', ['-q', archivePath, ...Object.keys(files)], { cwd: sourceDir, encoding: 'utf8' })
    if (archive.status !== 0) throw new Error(`could not create CANNBench zip: ${archive.error?.message ?? archive.stderr.trim()}`)
    if (statSync(archivePath).size > MAX_ARCHIVE_BYTES) throw new Error('CANNBench zip exceeds 50 MB')
    return { sourceDir, archivePath, packageDir: pkg, callable: filename, signature }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
}
