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
