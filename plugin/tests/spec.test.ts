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
