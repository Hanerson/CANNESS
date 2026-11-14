import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildTestPackage, writeOperator } from '../src/package-files.ts'
import { parseSpec } from '../src/spec.ts'
import { exportSubmission } from '../src/submission.ts'

const KERNEL = 'extern "C" __global__ __aicore__ void canness_kernel(GM_ADDR in0, GM_ADDR out0, GM_ADDR tiling) {}'

test('exports a CANNBench source zip with the tested kernel and a generated launch wrapper', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'canness-export-'))
  const generation = 'gen-deadbeef'
  const spec = parseSpec({
    operator_name: 'Exp', operator_type: 'elementwise',
    input_specs: [{ name: 'input', shape: ['16'], dtype: 'float32' }],
    output_specs: [{ name: 'output', shape: ['16'], dtype: 'float32' }],
    attrs: { base: -1, scale: 0.5, shift: 1 },
    interface: { defaults: { base: -1, scale: 1, shift: 0 }, dtypes: ['float16', 'bfloat16', 'float32'] },
    attrs_derived: { logBase: { source: 'base', transform: 'log_positive_or_one' } },
    target_platform: { chip: 'Ascend910B2' },
    performance_target: { metric: 'kernel_time', target_us: 50 },
  })
  writeOperator(workspace, generation, { kernel: KERNEL, host: '', api: '', plugin: '' })
  const pkg = buildTestPackage(workspace, generation, spec)
  const artifact = exportSubmission(workspace, generation, spec, 'exp')
  const body = (file: string) => readFileSync(join(artifact.sourceDir, file), 'utf8')
  expect(body('csrc/op_kernel/kernel.cpp')).toBe(KERNEL)
  expect(body('csrc/launch.cpp')).toContain('canness_kernel<<<')
  expect(body('cann_bench/__init__.py')).toContain('def exp(')
  expect(body('cann_bench/__init__.py')).toContain('scale=1.0')
  expect(body('build.sh')).toContain('dist')
  expect(artifact.signature).toBe('exp(input, base=-1.0, scale=1.0, shift=0.0)')
  expect(body('csrc/launch.cpp')).toContain('std::log(attr0)')
  expect(body('csrc/bfloat16/canness_tiling.h')).toContain('using DTYPE_X = bfloat16_t;')
  expect(body('cann_bench/__init__.py')).toContain('_torch.bfloat16: "bfloat16"')
  expect(JSON.parse(body('provenance.json'))).not.toHaveProperty('verifiedOnNpu')
  expect(existsSync(artifact.archivePath)).toBe(true)
  writeFileSync(join(pkg, 'op_kernel/kernel.cpp'), 'modified kernel')
  expect(() => exportSubmission(workspace, generation, spec, 'exp')).toThrow(/rebuild/)
})
