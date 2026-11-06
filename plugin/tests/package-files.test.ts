import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { expect, test } from 'vitest'
import { newGenerationId } from '../src/ids.ts'
import {
  buildContractTemplateDir, buildTestPackage, checkKernelEntry, CONTRACT_FILES, KERNEL_ENTRY, LAYER_FILES,
  maxAbsErrForDtype, renderBuildContract, writeOperator,
} from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
import { emptyState } from '../src/policy.ts'
import { loadState, saveState } from '../src/state-file.ts'

/** A kernel that satisfies build contract v1. */
const VALID_KERNEL = [
  'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR in0, GM_ADDR out0, GM_ADDR tiling)',
  '{',
  '    GET_TILING_DATA(t, tiling);',
  '}',
].join('\n')

function specFor(dtype: string, socVersion = 'Ascend910B4') {
  return parseSpec({
    operator_name: 'Add',
    operator_type: 'elementwise',
    input_specs: [
      { name: 'x', shape: ['8', '4096'], dtype },
      { name: 'y', shape: ['8', '4096'], dtype },
    ],
    output_specs: [{ name: 'z', shape: ['8', '4096'], dtype }],
    target_platform: { chip: 'Ascend910B', soc_version: socVersion },
    performance_target: { metric: 'kernel_time', target_us: 150 },
  })
}

function packageFor(spec = specFor('float16')): { workspace: string, pkg: string, opDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-ws-'))
  const opDir = writeOperator(workspace, 'gen-01234567', {
    kernel: VALID_KERNEL, host: 'H', api: 'A', plugin: 'P',
  })
  return { workspace, pkg: buildTestPackage(workspace, 'gen-01234567', spec), opDir }
}

function diskFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

test('generation ids keep the gen- prefix and 8 hex chars', () => {
  expect(newGenerationId('01234567-89ab-cdef-0123-456789abcdef')).toBe('gen-01234567')
})

test('the contract entry is accepted only with the fixed name and parameter order', () => {
  expect(KERNEL_ENTRY).toBe('canness_kernel')
  expect(checkKernelEntry(VALID_KERNEL)).toEqual({ ok: true })

  // Another name links to nothing: main.cpp calls canness_kernel.
  const renamed = checkKernelEntry('extern "C" __global__ __aicore__ void gelu(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) {}')
  expect(renamed.ok).toBe(false)
  expect(renamed.ok ? '' : renamed.reason).toContain('canness_kernel')
  expect(renamed.ok ? '' : renamed.reason).toContain('found: gelu')

  // The contract passes inputs, outputs and tiling — no workspace buffer.
  const withWorkspace = checkKernelEntry('void canness_kernel(GM_ADDR x, GM_ADDR y, GM_ADDR workspace, GM_ADDR tiling) {}')
  expect(withWorkspace.ok).toBe(false)
  expect(withWorkspace.ok ? '' : withWorkspace.reason).toContain('workspace')

  // The tiling pointer is the last parameter.
  const noTiling = checkKernelEntry('void canness_kernel(GM_ADDR x, GM_ADDR y) {}')
  expect(noTiling.ok).toBe(false)
  expect(noTiling.ok ? '' : noTiling.reason).toContain('tiling')
})

test('buildTestPackage refuses a kernel that does not define the contract entry', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-ws-'))
  writeOperator(workspace, 'gen-01234567', {
    kernel: 'extern "C" __global__ __aicore__ void gelu(GM_ADDR x, GM_ADDR y, GM_ADDR tiling) {}',
    host: 'H', api: 'A', plugin: 'P',
  })
  expect(() => buildTestPackage(workspace, 'gen-01234567', specFor('float16')))
    .toThrow(/must define "void canness_kernel/)
})

test('writeOperator and buildTestPackage lay down the four layers and manifest', () => {
  const { pkg } = packageFor()
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'))
  expect(manifest).toMatchObject({
    generationId: 'gen-01234567',
    operatorName: 'Add',
    performanceTargetUs: 150,
    buildContract: 'v1',
    layers: Object.values(LAYER_FILES),
  })
  expect(readFileSync(join(pkg, 'op_plugin/plugin.py'), 'utf8')).toBe('P')
})

test('the package carries every build contract file, rendered for the spec', () => {
  const { pkg } = packageFor(specFor('float16', 'Ascend910B4'))
  for (const name of CONTRACT_FILES) {
    expect(readFileSync(join(pkg, name), 'utf8').length).toBeGreaterThan(0)
  }

  const build = readFileSync(join(pkg, 'build.sh'), 'utf8')
  expect(build).toContain('SOC_VERSION="Ascend910B4"')
  expect(build).toContain('--cce-soc-version=$SOC_VERSION')
  expect(build).toContain('-lascendcl -lruntime')
  expect(build).toContain('.canness-exe')
  expect(build.trimEnd().endsWith('echo "$HERE/canness_run"')).toBe(true)

  const main = readFileSync(join(pkg, 'main.cpp'), 'utf8')
  expect(main).not.toContain('{{')
  expect(main).toContain('CANNESS_RESULT')
  expect(main).toContain('canness_kernel<<<CANNESS_BLOCK_DIM, nullptr, stream>>>')
  expect(main).toContain('Tensor in0 = make_tensor(DType::F16, 32768, true);')
  expect(main).toContain('Tensor in1 = make_tensor(DType::F16, 32768, true);')
  expect(main).toContain('Tensor out0 = make_tensor(DType::F16, 32768, false);')
  expect(main).toContain('#define CANNESS_MAX_ABS_ERR 0.0009765625')

  const tiling = readFileSync(join(pkg, 'canness_tiling.h'), 'utf8')
  expect(tiling).toContain('struct CannessTilingData')
  expect(tiling).toContain('using DTYPE_X = half;')
  expect(tiling).toContain('#ifndef GET_TILING_DATA')

  const golden = readFileSync(join(pkg, 'golden.h'), 'utf8')
  expect(golden).toContain('CANNESS_GOLDEN_PLACEHOLDER')
})

test('manifest.files equals the files actually on disk', () => {
  const { pkg } = packageFor()
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8'))
  expect(manifest.files).toEqual(diskFiles(pkg))
})

test('config.json derives maxAbsErr from the tensor dtype', () => {
  const cases: Array<[string, number]> = [
    ['float16', 2 ** -10],
    ['bfloat16', 2 ** -7],
    ['float32', 2 ** -13],
  ]
  for (const [dtype, expected] of cases) {
    const { pkg } = packageFor(specFor(dtype))
    const config = JSON.parse(readFileSync(join(pkg, 'config.json'), 'utf8'))
    expect(config.maxAbsErr).toBe(expected)
    expect(config.dtype).toBe(dtype)
    expect(config.params).toMatchObject({ blockDim: 16, tileSize: 1024, blockLength: 2048, totalElements: 32768 })
  }
  expect(maxAbsErrForDtype('float16')).toBe(2 ** -10)
  expect(maxAbsErrForDtype('bf16')).toBe(2 ** -7)
  expect(maxAbsErrForDtype('fp32')).toBe(2 ** -13)
  expect(maxAbsErrForDtype('mystery')).toBe(1e-3)
})

test('a model-owned golden.h overrides the placeholder template', () => {
  const spec = specFor('float16')
  const { workspace, opDir } = packageFor(spec)
  writeFileSync(join(opDir, 'golden.h'), '// custom reference\n')
  const pkg = buildTestPackage(workspace, 'gen-01234567', spec)
  expect(readFileSync(join(pkg, 'golden.h'), 'utf8')).toBe('// custom reference\n')
})

test('build contract templates are present and render', () => {
  const templates = buildContractTemplateDir()
  expect(templates.endsWith(`templates${sep}build-contract${sep}`)).toBe(true)
  for (const name of CONTRACT_FILES) {
    expect(readFileSync(join(templates, name), 'utf8').length).toBeGreaterThan(0)
  }
  const rendered = renderBuildContract(specFor('float16'))
  for (const name of CONTRACT_FILES) expect(rendered[name]).toBeTruthy()
})

test('state file round-trips and a missing file is empty', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-st-'))
  const path = join(workspace, '.canness', 'state.json')
  expect(loadState(path).generationId).toBeNull()
  const state = { ...emptyState(), generationId: 'gen-01234567' }
  saveState(path, state)
  expect(loadState(path).generationId).toBe('gen-01234567')
})
