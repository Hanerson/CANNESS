import { expect, test } from 'vitest'
import { parseSpec } from '../src/spec.ts'

const valid = {
  operator_name: 'Conv2D',
  operator_type: 'conv',
  input_specs: [{ name: 'input', shape: ['N', 'C', 'H', 'W'], dtype: 'float16' }],
  output_specs: [{ name: 'output', shape: ['N', 'C_out', 'H_out', 'W_out'], dtype: 'float16' }],
  target_platform: { chip: 'Ascend910B' },
  performance_target: { metric: 'kernel_time', target_us: 150 },
}

test('parses the 02 spec and defaults tiling_hints to null', () => {
  expect(parseSpec(valid).tiling_hints).toBeNull()
  expect(parseSpec(valid).performance_target.target_us).toBe(150)
})

test('reports the first missing field', () => {
  expect(() => parseSpec({ ...valid, operator_name: '' })).toThrow('missing operator_name')
  const { target_platform: _drop, ...rest } = valid
  expect(() => parseSpec(rest)).toThrow('missing target_platform.chip')
})

test('rejects a non-positive target', () => {
  expect(() => parseSpec({
    ...valid,
    performance_target: { metric: 'kernel_time', target_us: 0 },
  })).toThrow('missing performance_target.target_us')
})

test('preserves symbolic shapes but rejects invalid or overflowing numeric shapes', () => {
  const withShape = (shape: string[]) => ({
    ...valid, input_specs: [{ name: 'input', shape, dtype: 'float16' }],
  })
  expect(parseSpec(withShape(['B', '4096'])).input_specs[0]?.shape).toEqual(['B', '4096'])
  for (const shape of [['0'], ['-1'], ['3.5'], ['1e3'], [''], ['9007199254740992'], ['100000000', '100000000']]) {
    expect(() => parseSpec(withShape(shape))).toThrow('shape')
  }
})

test('attributes reject nested, nonfinite and unsupported accuracy modes', () => {
  expect(() => parseSpec({ ...valid, attrs: { dim: Number.NaN } })).toThrow('attrs.dim')
  expect(() => parseSpec({ ...valid, attrs: { shape: [1, 2] } })).toThrow('attrs.shape')
  expect(() => parseSpec({ ...valid, accuracyMode: 'always-pass' })).toThrow('accuracyMode')
})

test('launch accepts an explicit tile length representable by a kernel element count', () => {
  expect(parseSpec({ ...valid, launch: { block_dim: 40, tile_length: 8192, workspace_bytes: 7 } }).launch)
    .toEqual({ block_dim: 40, tile_length: 8192, workspace_bytes: 7 })
  for (const tile_length of [null, 0, -1, 1.5, '8192', 2 ** 32]) {
    expect(() => parseSpec({ ...valid, launch: { tile_length } })).toThrow('launch.tile_length')
  }
})

test('attribute names that coincide with object prototype properties survive spec parsing', () => {
  const attrs = JSON.parse('{"__proto__":1,"constructor":false}')
  expect(Object.entries(parseSpec({ ...valid, attrs }).attrs!)).toEqual(Object.entries(attrs))
})

test('validates accuracy overrides and explicit floating-point input samples', () => {
  const inputWith = (values: unknown, dtype = 'float16') => ({
    ...valid, input_specs: [{ ...valid.input_specs[0], dtype, input_values: values }],
  })
  const values = ['nan', '+inf', '-inf', 65504, -65504]
  const spec = parseSpec({ ...inputWith(values), accuracy: { absThreshold: 0, relThreshold: 0.01 } })
  expect(spec.input_specs[0]?.input_values).toEqual(values)
  expect(spec.accuracy).toEqual({ absThreshold: 0, relThreshold: 0.01 })
  expect(() => parseSpec(inputWith(['infinity']))).toThrow('input_values')
  expect(() => parseSpec(inputWith([65505]))).toThrow('input_values')
  expect(() => parseSpec(inputWith(['nan'], 'int64'))).toThrow('input_values')
  expect(() => parseSpec({ ...valid, accuracy: { relThreshold: -1 } })).toThrow('accuracy.relThreshold')
})
