import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildTestPackage, packageHash, renderBuildContract, writeOperator } from '../src/package-files.js'
import { parseSpec } from '../src/spec.js'

const kernel = 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR in0, GM_ADDR out0, GM_ADDR tiling) {}'

function spec(outputDtype: string, accuracyMode: 'elementwise' | 'index-check' = 'elementwise') {
  return parseSpec({
    operator_name: 'ArgMax', operator_type: 'reduction', accuracyMode,
    input_specs: [{ name: 'x', shape: ['3', '4096'], dtype: 'float16' }],
    output_specs: [{ name: 'index', shape: ['3'], dtype: outputDtype }],
    attrs: { dim: -1, keepdim: false, note: 'a"b' },
    target_platform: { chip: 'Ascend910B', soc_version: 'Ascend910B2' },
    performance_target: { metric: 'kernel_time', target_us: 1000 },
  })
}

test('the host declaration uses only compiler-provided CCE qualifiers', () => {
  const files = renderBuildContract(spec('int64'))
  expect(files['main.cpp']).toContain('extern "C" __global__ [aicore] void canness_kernel(')
  expect(files['main.cpp']).not.toContain('#include "kernel_operator.h"')
})

test('integer-only golden references do not require a float evaluator', () => {
  const integer = renderBuildContract(spec('int64'))['main.cpp']!
  const floating = renderBuildContract(spec('float32'))['main.cpp']!
  expect(integer).toContain('#define CANNESS_FLOAT_OUTPUT 0')
  expect(floating).toContain('#define CANNESS_FLOAT_OUTPUT 1')
  expect(integer).toMatch(/#if CANNESS_FLOAT_OUTPUT\s+const float actual/)
})

test('integer outputs retain their byte width and exact comparison across reasonable shapes', () => {
  for (const [dtype, declaration] of [['int32', 'DType::I32'], ['I64', 'DType::I64']] as const) {
    const files = renderBuildContract(spec(dtype))
    expect(files['main.cpp']).toContain(`make_tensor(${declaration}, 3, false)`)
    expect(files['main.cpp']).toContain('output_tolerances[] = { {0, 0} }')
    expect(files['main.cpp']).toContain('actual != expected')
    expect(files['main.cpp']).toContain('canness_golden::evaluate_integer')
  }
  expect(() => renderBuildContract(spec('uint8'))).toThrow('unsupported tensor dtype')
})

test('index check receives the actual integer index and shape and attributes', () => {
  const files = renderBuildContract(spec('int64', 'index-check'))
  expect(files['main.cpp']).toContain('#define CANNESS_INDEX_CHECK 1')
  expect(files['main.cpp']).toContain('canness_golden::verify_index')
  expect(files['main.cpp']).toContain('static const int64_t canness_shape[] = { 3, 4096 }')
  expect(files['main.cpp']).toContain('ctx.attr_dim = -1')
  expect(files['main.cpp']).toContain('ctx.attr_keepdim = 0')
  expect(files['main.cpp']).toContain('a\\"b')
  expect(() => renderBuildContract(spec('float32', 'index-check'))).toThrow('requires integer output')
})

test('arbitrary attribute text is emitted as a single valid C++ string literal', () => {
  const input = spec('int64')
  input.attrs = { note: 'line one\n"雪"' }
  const main = renderBuildContract(input)['main.cpp']!
  expect(main).toContain('line one\\012\\"')
  expect(main).not.toContain('line one\n"雪"')
})

test('GoldenCtx convenience attributes reject values they cannot represent', () => {
  const fractionalDim = spec('int64')
  fractionalDim.attrs = { dim: 0.5 }
  expect(() => renderBuildContract(fractionalDim)).toThrow('attrs.dim')
  const invalidKeepdim = spec('int64')
  invalidKeepdim.attrs = { keepdim: 'yes' }
  expect(() => renderBuildContract(invalidKeepdim)).toThrow('attrs.keepdim')
})

test('a package records its contract and detects arbitrary file drift', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-contract-upgrade-'))
  const generationId = 'gen-upgrade'
  writeOperator(workspace, generationId, { kernel, host: '', api: '', plugin: '' })
  const root = buildTestPackage(workspace, generationId, spec('int64', 'index-check'))
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
  expect(manifest.contract).toMatchObject({ schemaVersion: 'v1', pluginVersion: expect.any(String) })
  expect(manifest.contract.libHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  expect(manifest.packageHash).toBe(packageHash(root))
  expect(readFileSync(join(root, '.contract-selfcheck/op_kernel/kernel.cpp'), 'utf8')).toContain('AscendC::DataCopy')
  expect(() => buildTestPackage(workspace, generationId, spec('uint8'))).toThrow('unsupported tensor dtype')
  expect(packageHash(root)).toBe(manifest.packageHash)
  writeFileSync(join(root, 'golden.h'), '// changed after packaging')
  expect(packageHash(root)).not.toBe(manifest.packageHash)
})
